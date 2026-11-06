// The scripted-slot seam (`SPEC_SLOT_SCRIPT=<file>`): a `SlotSdk` whose sessions are answered by a YAML script instead of a model.
// The cut is the SDK, not the `SlotRunner`: the real `createSlotRunner` (session options, cost, context ceiling, abort, yield parsing,
// agent ids, guard wiring) and everything after it (watch, discard, scope check, commits, checks, gates, the run log) stay real. Only
// `createAgentSession` is replaced; `discoverAgents` is the real one. A scripted tool step goes through the real worker guard, the one
// the runner passed in `preloadedPreparedExtensions`. What it does not prove: omp's own dispatch of `tool_call` to the guard.
//
// Only the host's launch environment switches it on, and it is never silent: `openSlotScript` refuses a script a repo could ship
// (inside a clone, a worktree or the vault) and a variable a dotenv file defines; the caller writes the `scripted-slots` log entry.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CreateAgentSessionOptions, ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { SlotEvent, SlotSdk, SlotSession } from "./spec-slot-runner";
import { cleanEnv, git } from "./spec-git";
import type { RunLog } from "./spec-runlog";
import { SLOT_NAMES } from "./spec-slots";
import { errorMessage, isRecord } from "./tooling/runtime";

export const SLOT_SCRIPT_ENV = "SPEC_SLOT_SCRIPT";

/** How much of a slot's prompt `scripted-session` logs. */
const PROMPT_LOG_LIMIT = 40_000;

export type ScriptStep =
	/** A tool call the scripted worker makes: judged by the real worker guard, then applied (`write`, `bash`) or only judged (`edit`, others). */
	| { tool: { name: string; input: Record<string, unknown> } }
	/** An assistant message finished with this cost and context: the real runner sums the cost and aborts past the ceiling. */
	| { usage: { costUsd: number; contextTokens: number } }
	/** Waits this many milliseconds, or until the runner aborts the session (wall timeout, `/run-stop`). */
	| { sleep: number }
	/** The worker's `yield` with `data`: an object, or a string the scheduler parses. */
	| { yield: unknown }
	/** The worker yielded an error instead of data. */
	| { yield_error: string }
	/** The session's prompt fails: an environment failure, not a failed attempt. */
	| { throw: string };

export interface ScriptRule {
	match: { task: string; slot: string; attempt: number | "*" };
	steps: ScriptStep[];
}

export interface SlotScript {
	version: 1;
	slots: ScriptRule[];
}

/** The script is not usable. */
export class ScriptError extends Error {}

function readStep(value: unknown, where: string): ScriptStep {
	if (!isRecord(value)) throw new ScriptError(`${where} must be a mapping`);
	const keys = Object.keys(value);
	if (keys.length !== 1) throw new ScriptError(`${where} must have exactly one of tool, usage, sleep, yield, yield_error, throw; got ${keys.join(", ") || "none"}`);
	const [key] = keys;
	const body = value[key];
	switch (key) {
		case "tool": {
			if (!isRecord(body) || typeof body.name !== "string" || (body.input !== undefined && !isRecord(body.input))) throw new ScriptError(`${where}.tool needs a name and an input mapping`);
			return { tool: { name: body.name, input: body.input === undefined ? {} : { ...body.input } } };
		}
		case "usage": {
			if (!isRecord(body) || typeof body.costUsd !== "number" || typeof body.contextTokens !== "number") throw new ScriptError(`${where}.usage needs numeric costUsd and contextTokens`);
			return { usage: { costUsd: body.costUsd, contextTokens: body.contextTokens } };
		}
		case "sleep": {
			if (typeof body !== "number" || !Number.isFinite(body) || body < 0) throw new ScriptError(`${where}.sleep must be a number of milliseconds`);
			return { sleep: body };
		}
		case "yield":
			return { yield: body };
		case "yield_error":
		case "throw":
			if (typeof body !== "string") throw new ScriptError(`${where}.${key} must be a string`);
			return key === "throw" ? { throw: body } : { yield_error: body };
		default:
			throw new ScriptError(`${where} has an unknown step "${key}"`);
	}
}

/** Reads a script's text (`version: 1`, `slots: [{match, steps}]`). Throws `ScriptError` with the first problem. */
export function parseSlotScript(text: string): SlotScript {
	let data: unknown;
	try {
		data = Bun.YAML.parse(text);
	} catch (error) {
		throw new ScriptError(`not valid YAML: ${errorMessage(error)}`);
	}
	if (!isRecord(data) || data.version !== 1) throw new ScriptError("version must be 1");
	if (!Array.isArray(data.slots)) throw new ScriptError("slots must be a list");
	const slots = data.slots.map((rule, i): ScriptRule => {
		const where = `slots[${i}]`;
		if (!isRecord(rule) || !isRecord(rule.match)) throw new ScriptError(`${where} needs a match mapping`);
		const { task, slot, attempt = "*" } = rule.match;
		if (typeof task !== "string" || task === "") throw new ScriptError(`${where}.match.task must be a task id or "*"`);
		if (typeof slot !== "string" || !(SLOT_NAMES as readonly string[]).includes(slot)) throw new ScriptError(`${where}.match.slot must be one of ${SLOT_NAMES.join(", ")}`);
		if (attempt !== "*" && !(typeof attempt === "number" && Number.isInteger(attempt) && attempt >= 1)) throw new ScriptError(`${where}.match.attempt must be a positive integer or "*"`);
		if (!Array.isArray(rule.steps)) throw new ScriptError(`${where}.steps must be a list`);
		return { match: { task, slot, attempt }, steps: rule.steps.map((step, j) => readStep(step, `${where}.steps[${j}]`)) };
	});
	return { version: 1, slots };
}

// ── Opening a script: placement and dotenv refusals ─────────────────────────────────────────────────────────────────────────

export interface OpenedScript {
	/** The file's realpath. */
	file: string;
	sha256: string;
	script: SlotScript;
}

export interface OpenScriptInput {
	/** The value of the variable. */
	file: string;
	/** The host session's working folder: its `.env*` files are loaded by Bun and by omp. */
	cwd: string;
	/** omp's agent dir, config root and the home folder: each may hold a `.env`. */
	dotenvDirs: readonly string[];
	/** Every folder a repo can ship files in: the clones, the vault work tree and a supplied worktree root. */
	repoRoots: readonly string[];
}

const realpathOrSelf = (file: string): string => {
	try {
		return fs.realpathSync(file);
	} catch {
		return path.resolve(file);
	}
};

const inside = (file: string, root: string): boolean => {
	const relative = path.relative(realpathOrSelf(root), file);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

/** The value a dotenv line gives `name`, as Bun and omp read it (`export` optional, one pair of quotes removed), or undefined. */
function dotenvValue(text: string, name: string): string | undefined {
	let found: string | undefined;
	for (const raw of text.split(/\r?\n/)) {
		const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(raw);
		if (match === null || match[1] !== name) continue;
		let value = match[2];
		const quote = value[0];
		if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length >= 2) value = value.slice(1, -1);
		else value = value.replace(/\s+#.*$/, "");
		found = value;
	}
	return found;
}

/** The dotenv files that define `SPEC_SLOT_SCRIPT` as `value`: an environment a repo file could have set. */
function dotenvDefinitions(input: OpenScriptInput, value: string): string[] {
	const candidates: string[] = [];
	try {
		for (const entry of fs.readdirSync(input.cwd)) if (entry === ".env" || entry.startsWith(".env.")) candidates.push(path.join(input.cwd, entry));
	} catch {
		// An unreadable cwd has no dotenv files to read.
	}
	for (const dir of input.dotenvDirs) candidates.push(path.join(dir, ".env"));
	return candidates.filter(candidate => {
		try {
			return dotenvValue(fs.readFileSync(candidate, "utf8"), SLOT_SCRIPT_ENV) === value;
		} catch {
			return false;
		}
	});
}

/**
 * Reads the script the launch environment names. Throws `ScriptError` (the run must not start) when the path is relative or unreadable, the
 * text is not a valid script, the file sits inside a folder a repo can ship (a clone, the vault, a worktree), or a dotenv file defines the
 * variable with the same value: only the launch environment counts, never a repo file.
 */
export function openSlotScript(input: OpenScriptInput): OpenedScript {
	if (!path.isAbsolute(input.file)) throw new ScriptError(`${SLOT_SCRIPT_ENV} must be an absolute path, got ${JSON.stringify(input.file)}`);
	let file: string;
	let bytes: Buffer;
	try {
		file = fs.realpathSync(input.file);
		bytes = fs.readFileSync(file);
	} catch (error) {
		throw new ScriptError(`${SLOT_SCRIPT_ENV} ${input.file} cannot be read: ${errorMessage(error)}`);
	}
	const roots = [...input.repoRoots];
	const tmp = realpathOrSelf(os.tmpdir());
	const inWorktreeRoot = path.relative(tmp, file).split(path.sep)[0]?.startsWith("spec-wt-") === true;
	for (const clone of input.repoRoots) {
		const listed = git(clone, ["worktree", "list", "--porcelain"]);
		if (listed.ok) for (const line of listed.stdout.split("\n")) if (line.startsWith("worktree ")) roots.push(line.slice("worktree ".length));
	}
	const root = roots.find(candidate => inside(file, candidate));
	if (root !== undefined || inWorktreeRoot) throw new ScriptError(`${SLOT_SCRIPT_ENV} ${file} lies inside ${root ?? "a spec worktree folder"}: a repo could ship that file, so the script must live outside every clone, worktree and the vault`);
	const defined = dotenvDefinitions(input, input.file);
	if (defined.length > 0) throw new ScriptError(`${SLOT_SCRIPT_ENV} is also defined in ${defined.join(", ")}: a repo file must not switch scripted slots on; set it in the launch environment only`);
	let script: SlotScript;
	try {
		script = parseSlotScript(bytes.toString("utf8"));
	} catch (error) {
		throw new ScriptError(`${SLOT_SCRIPT_ENV} ${file} is not a valid slot script: ${errorMessage(error)}`);
	}
	return { file, sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"), script };
}

// ── The scripted SDK ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** What a scripted tool step did, for tests: the real guard's reason when it blocked the call. */
export interface ScriptTrace {
	task: string;
	slot: string;
	attempt: number;
	tool: string;
	blocked?: string;
}

export interface ScriptedSlots {
	sdk: SlotSdk;
	trace: ScriptTrace[];
	/** Rules no session consumed, by position in the file. */
	unused(): number[];
	/** At the end of the run: logs `scripted-slots-unused` when rules are left. */
	finish(): void;
}

type ToolCall = (event: { type: "tool_call"; toolName: string; toolCallId: string; input: Record<string, unknown> }, ctx: unknown) => unknown;

/** The `tool_call` handlers the real guard registers, by running its factory against a pi that only records them. */
function guardHandlers(options: CreateAgentSessionOptions): ToolCall[] {
	const handlers: ToolCall[] = [];
	const pi = { on: (name: string, handler: ToolCall): void => void (name === "tool_call" && handlers.push(handler)) } as unknown as ExtensionAPI;
	for (const prepared of options.preloadedPreparedExtensions ?? []) prepared.factory?.(pi);
	return handlers;
}

/** `spec:<story>:<task>:<slot>` → task and slot (a task id may hold `:` itself; the slot is the last part, the story the first). */
function fromTitle(title: string | undefined): { task: string; slot: string } | undefined {
	const parts = title?.split(":");
	if (parts === undefined || parts.length < 4 || parts[0] !== "spec") return undefined;
	return { task: parts.slice(2, -1).join(":"), slot: parts[parts.length - 1] };
}

export function scriptedSdk(opened: OpenedScript, real: SlotSdk, log: RunLog, now: () => Date = () => new Date()): ScriptedSlots {
	const consumed = new Set<number>();
	const attempts = new Map<string, number>();
	const trace: ScriptTrace[] = [];
	const tag = opened.sha256.slice(0, 12);
	const event = (name: string, task: string | undefined, detail: string): void =>
		log.append({ kind: "event", at: now().toISOString(), event: name, ...(task === undefined ? {} : { task }), detail });

	const session = (options: CreateAgentSessionOptions): SlotSession => {
		const listeners = new Set<(event: SlotEvent) => void>();
		const emit = (e: SlotEvent): void => {
			for (const listener of [...listeners]) listener(e);
		};
		const aborted = Promise.withResolvers<void>();
		let stopped = false;
		let title: string | undefined;
		let sessionFile: string | undefined;
		const stop = (): void => {
			stopped = true;
			aborted.resolve();
		};

		const sleep = async (ms: number): Promise<void> => {
			const { promise, resolve } = Promise.withResolvers<void>();
			const timer = setTimeout(resolve, ms);
			await Promise.race([promise, aborted.promise]);
			clearTimeout(timer);
		};

		const runTool = async (who: { task: string; slot: string; attempt: number }, name: string, input: Record<string, unknown>, handlers: ToolCall[]): Promise<void> => {
			const call = { type: "tool_call" as const, toolName: name, toolCallId: `scripted-${trace.length + 1}`, input };
			for (const handler of handlers) {
				const verdict = (await handler(call, {})) as { block?: boolean; reason?: string } | undefined;
				if (verdict?.block === true) {
					trace.push({ ...who, tool: name, blocked: verdict.reason ?? "blocked" });
					return;
				}
			}
			trace.push({ ...who, tool: name });
			const cwd = options.cwd ?? process.cwd();
			if (name === "write") {
				if (typeof input.path !== "string" || typeof input.content !== "string") throw new Error("a scripted write step needs a string path and content");
				const target = path.resolve(cwd, input.path);
				fs.mkdirSync(path.dirname(target), { recursive: true });
				fs.writeFileSync(target, input.content);
			} else if (name === "bash") {
				if (typeof input.command !== "string") throw new Error("a scripted bash step needs a string command");
				const child = Bun.spawn({ cmd: ["sh", "-c", input.command], cwd, env: cleanEnv(), stdin: "ignore", stdout: "ignore", stderr: "ignore" });
				await child.exited;
			}
		};

		const prompt = async (text: string): Promise<void> => {
			const found = fromTitle(title);
			if (found === undefined) throw new Error(`a scripted session needs the title spec:<story>:<task>:<slot> before its prompt, got ${JSON.stringify(title)}`);
			const key = `${found.task}\0${found.slot}`;
			const attempt = (attempts.get(key) ?? 0) + 1;
			attempts.set(key, attempt);
			const index = opened.script.slots.findIndex((rule, i) => !consumed.has(i) && (rule.match.task === "*" || rule.match.task === found.task) && rule.match.slot === found.slot && (rule.match.attempt === "*" || rule.match.attempt === attempt));
			if (index < 0) throw new Error(`no scripted slot for ${found.task} ${found.slot} #${attempt}`);
			consumed.add(index);
			sessionFile = `scripted:${tag}#${index}`;
			const handlers = guardHandlers(options);
			event(
				"scripted-session",
				found.task,
				JSON.stringify({
					slot: found.slot,
					attempt,
					rule: index,
					toolNames: options.toolNames,
					thinkingLevel: options.thinkingLevel,
					outputSchemaMode: options.outputSchemaMode,
					agentId: options.agentId,
					title,
					restrictToolNames: options.restrictToolNames,
					requireYieldTool: options.requireYieldTool,
					bindProcessState: options.bindProcessState,
					hasUI: options.hasUI,
					enableMCP: options.enableMCP,
					guardHandlers: handlers.length,
					extensions: "extensions" in options,
					prompt: text.length > PROMPT_LOG_LIMIT ? `${text.slice(0, PROMPT_LOG_LIMIT)}…` : text,
				}),
			);

			const who = { ...found, attempt };
			for (const step of opened.script.slots[index].steps) {
				if (stopped) return;
				if ("tool" in step) await runTool(who, step.tool.name, step.tool.input, handlers);
				else if ("usage" in step) emit({ type: "usage", costUsd: step.usage.costUsd, contextTokens: step.usage.contextTokens });
				else if ("sleep" in step) await sleep(step.sleep);
				else if ("yield" in step) emit({ type: "yield", payload: step.yield });
				else if ("yield_error" in step) emit({ type: "yield-error", message: step.yield_error });
				else throw new Error(step.throw);
			}
			if (!stopped) emit({ type: "end" });
		};

		return {
			get sessionFile() {
				return sessionFile;
			},
			subscribe(listener) {
				listeners.add(listener);
				return () => void listeners.delete(listener);
			},
			prompt,
			async abort() {
				stop();
			},
			async dispose() {
				stop();
			},
			async setTitle(value) {
				title = value;
			},
		};
	};

	const unused = (): number[] => opened.script.slots.flatMap((_, i) => (consumed.has(i) ? [] : [i]));
	return {
		sdk: { discoverAgents: cwd => real.discoverAgents(cwd), createAgentSession: async options => session(options) },
		trace,
		unused,
		finish() {
			const left = unused();
			if (left.length > 0) event("scripted-slots-unused", undefined, left.map(i => `#${i} ${JSON.stringify(opened.script.slots[i].match)}`).join(", "));
		},
	};
}
