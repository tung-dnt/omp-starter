// Shared harness for tests of extension entry points. Two ways to run an extension:
//
//  - In process (`fakePi`, `fakeContext`, `scriptedUi`, `seedKb`, `resetHome`): the extension runs inside the
//    test process, so `bun test --coverage` sees it. Safe only because bunfig.toml preloads
//    extensions/test-preload.ts, which swaps HOME for a private directory before lib/state.ts caches it;
//    `privateHome()` throws when that did not happen.
//  - In a `bun -e` child (`runExtensionChild`): a fresh HOME per scenario, for extensions whose state lives
//    in module scope or on disk across registrations.
//
// Nothing in here touches the real ~/.omp, ~/.obsidian-personal or ~/.config.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as zod from "@oh-my-pi/omptype/zod";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { EVERY_SESSION_DIR } from "./lib/kb-sources";
import { resetKbWritten } from "./lib/kb-write-flag";
import { memorySnapshots } from "./lib/kb-store";
import { HOME, tildify, writeState, type KbSource, type SetupState } from "./lib/state";

// ── Private HOME ─────────────────────────────────────────────────────────────

/** The private home the preload installed; throws when lib/state resolved any other directory. */
export function privateHome(): string {
	const expected = process.env.OMP_STARTER_TEST_HOME;
	if (!expected || HOME !== expected || os.homedir() !== expected || !path.basename(expected).startsWith("omp-starter-test-home-")) {
		throw new Error(
			`test-harness: HOME is ${HOME}, not the private test home (${expected ?? "unset"}). ` +
				"Run tests through `bun test` from the repo root so bunfig.toml preloads extensions/test-preload.ts.",
		);
	}
	return expected;
}

/**
 * Empties the private home and the process-wide registries extensions keep on globalThis, so every test
 * starts from "never set up". Call from `beforeEach(resetHome)` in each test file.
 */
export function resetHome(): void {
	const home = privateHome();
	for (const entry of fs.readdirSync(home)) fs.rmSync(path.join(home, entry), { recursive: true, force: true });
	resetKbWritten();
	memorySnapshots.clear();
}

/** Writes `files` (paths relative to `root`, parents created). */
export function writeFiles(root: string, files: Record<string, string>): void {
	for (const [rel, content] of Object.entries(files)) {
		const file = path.join(root, rel);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, content);
	}
}

/** A git repo at `dir`, optionally with an `origin` remote whose URL decides the repo name extensions see. */
export function initGitRepo(dir: string, origin?: string): void {
	fs.mkdirSync(dir, { recursive: true });
	execFileSync("git", ["init", "--quiet"], { cwd: dir });
	if (origin) execFileSync("git", ["remote", "add", "origin", origin], { cwd: dir });
}

export function seedState(state: SetupState): void {
	privateHome();
	writeState(state);
}

// ── Knowledge bases ──────────────────────────────────────────────────────────

/** A memory note file the way kb_remember writes it. */
export function memoryNote(slug: string, description: string, body: string, type = "project"): string {
	return `---\nname: ${slug}\ndescription: ${description}\nmetadata:\n  node_type: memory\n  type: ${type}\n  modified: 2026-01-01T00:00:00.000Z\n---\n\n${body}\n`;
}

export interface KbSpec {
	/** Folder name under the private home holding the vault root; also the vault's name. */
	name: string;
	/** Session folder the knowledge base serves; omit for a knowledge base serving every session. */
	folder?: string;
	/** Turns the commit gate on for `folder` (every-session sources gate the whole home). */
	gate?: boolean;
	/** Text of `_memory/MEMORY.md`; omitted = no index file. */
	index?: string;
	/** Note files under `_memory/`, by file name. */
	notes?: Record<string, string>;
}

export interface SeededKb {
	source: KbSource;
	/** Absolute knowledge-base root (the folder `kbRef` points at). */
	root: string;
	memoryDir: string;
	indexPath: string;
	/** Session folder served; created. */
	folder: string;
}

/** Creates one vault on disk and returns the `kb.sources` entry that wires it in. Pass entries to `seedState`. */
export function seedKb(spec: KbSpec): SeededKb {
	const home = privateHome();
	const root = path.join(home, spec.name);
	const memoryDir = path.join(root, "_memory");
	const folder = spec.folder ?? EVERY_SESSION_DIR;
	fs.mkdirSync(memoryDir, { recursive: true });
	fs.mkdirSync(folder, { recursive: true });
	if (spec.index !== undefined) fs.writeFileSync(path.join(memoryDir, "MEMORY.md"), spec.index);
	writeFiles(memoryDir, spec.notes ?? {});
	const source: KbSource = {
		kbRef: tildify(root),
		kbPaths: [root],
		contextFile: path.join(folder, "AGENTS.md"),
		...(spec.gate ? { gateDir: spec.folder ?? home } : {}),
	};
	return { source, root, memoryDir, indexPath: path.join(memoryDir, "MEMORY.md"), folder };
}

// ── Fake host ────────────────────────────────────────────────────────────────

type Handler = (event: never, ctx: never) => unknown;
type Json = Record<string, unknown>;

export interface FakeTool {
	name: string;
	description?: string;
	parameters: unknown;
	execute(id: string, params: Json, signal: unknown, onUpdate: unknown, ctx: unknown): Promise<{ content: { type: string; text: string }[]; details?: unknown }>;
}

export interface FakeCommand {
	description?: string;
	handler(args: string, ctx: unknown): Promise<void> | void;
}

export interface FakePi {
	pi: ExtensionAPI;
	handlers: Map<string, Handler>;
	tools: Map<string, FakeTool>;
	commands: Map<string, FakeCommand>;
	/** Every `pi.exec` call, in order. */
	execCalls: { command: string; args: string[] }[];
	/** Calls the handler registered for `event` (one handler per event: extensions register each once) and returns its result. */
	emit(event: string, payload: object, ctx: object): unknown;
	/** Runs a registered tool the way the host does and returns its text. */
	callTool(name: string, params: Json, ctx: object): Promise<{ text: string; details: unknown }>;
	runCommand(name: string, args: string, ctx: object): Promise<void>;
}

export type FakeExec = (command: string, args: string[], options?: { timeout?: number }) => { stdout?: string; stderr?: string; code?: number } | Promise<{ stdout?: string; stderr?: string; code?: number }>;

/** A fake `pi` that captures `on`, `registerTool` and `registerCommand`; `exec` answers from `exec` (default: success, no output). */
export function fakePi(exec?: FakeExec): FakePi {
	const handlers = new Map<string, Handler>();
	const tools = new Map<string, FakeTool>();
	const commands = new Map<string, FakeCommand>();
	const execCalls: { command: string; args: string[] }[] = [];
	const host = {
		zod,
		on: (event: string, handler: Handler) => void handlers.set(event, handler),
		// A second registration of a name replaces the first in the real host's table silently; the fake refuses, so a test that registers an
		// extension proves each tool and command is registered exactly once.
		registerTool: (tool: FakeTool) => {
			if (tools.has(tool.name)) throw new Error(`tool "${tool.name}" is registered twice`);
			tools.set(tool.name, tool);
		},
		registerCommand: (name: string, command: FakeCommand) => {
			if (commands.has(name)) throw new Error(`command "${name}" is registered twice`);
			commands.set(name, command);
		},
		exec: async (command: string, args: string[], options?: { timeout?: number }) => {
			execCalls.push({ command, args });
			return (await exec?.(command, args, options)) ?? { stdout: "", stderr: "", code: 0 };
		},
	};
	return {
		pi: host as unknown as ExtensionAPI,
		handlers,
		tools,
		commands,
		execCalls,
		emit(event, payload, ctx) {
			const handler = handlers.get(event);
			if (!handler) throw new Error(`no handler registered for "${event}"`);
			return (handler as (e: object, c: object) => unknown)(payload, ctx);
		},
		async callTool(name, params, ctx) {
			const tool = tools.get(name);
			if (!tool) throw new Error(`tool "${name}" is not registered`);
			const result = await tool.execute("call-1", params, undefined, undefined, ctx);
			return { text: result.content.map(c => c.text).join("\n"), details: result.details };
		},
		async runCommand(name, args, ctx) {
			const command = commands.get(name);
			if (!command) throw new Error(`command "${name}" is not registered`);
			await command.handler(args, ctx);
		},
	};
}

export interface Notification {
	message: string;
	type: string | undefined;
}

export interface Prompt {
	kind: "confirm" | "select" | "input";
	title: string;
	/** `confirm`: the message; `select`: the options; `input`: the placeholder. */
	detail: string | string[] | undefined;
}

type Answer<T> = T | ((prompt: Prompt) => T);

export interface UiScript {
	confirm?: Answer<boolean>[];
	select?: Answer<string | undefined>[];
	input?: Answer<string | undefined>[];
}

export interface ScriptedUi {
	notifications: Notification[];
	prompts: Prompt[];
	notify(message: string, type?: "info" | "warning" | "error"): void;
	confirm(title: string, message: string): Promise<boolean>;
	select(title: string, options: string[]): Promise<string | undefined>;
	input(title: string, placeholder?: string): Promise<string | undefined>;
}

/**
 * A wizard UI answering from queues, one entry per prompt of that kind, in order. A prompt with no queued
 * answer throws, so a flow that asks more than the test expects fails instead of hanging or defaulting.
 */
export function scriptedUi(script: UiScript = {}): ScriptedUi {
	const queues = { confirm: [...(script.confirm ?? [])], select: [...(script.select ?? [])], input: [...(script.input ?? [])] };
	const notifications: Notification[] = [];
	const prompts: Prompt[] = [];
	function ask<T>(kind: Prompt["kind"], title: string, detail: Prompt["detail"]): T {
		const prompt: Prompt = { kind, title, detail };
		prompts.push(prompt);
		const queue = queues[kind] as unknown[];
		if (!queue.length) throw new Error(`unscripted ui.${kind}("${title}")`);
		const next = queue.shift();
		return (typeof next === "function" ? (next as (p: Prompt) => T)(prompt) : next) as T;
	}
	return {
		notifications,
		prompts,
		notify: (message, type) => void notifications.push({ message, type }),
		confirm: async (title, message) => ask<boolean>("confirm", title, message),
		select: async (title, options) => ask<string | undefined>("select", title, options),
		input: async (title, placeholder) => ask<string | undefined>("input", title, placeholder),
	};
}

export interface FakeContext {
	cwd: string;
	mode: string;
	hasUI: boolean;
	agent?: { kind: "main" | "sub"; id?: string; name: string };
	model?: { provider: string };
	ui: ScriptedUi;
	sessionManager: { getSessionId(): string };
	setInterval(callback: () => void, ms: number): number;
	clearTimer(timer: number): void;
	/** Intervals still registered through `setInterval`. */
	timers: Map<number, () => void>;
	/** Runs every registered interval callback once. */
	tick(): void;
}

export interface ContextOptions {
	cwd: string;
	agent?: FakeContext["agent"];
	model?: FakeContext["model"];
	sessionId?: string;
	mode?: string;
	hasUI?: boolean;
	ui?: ScriptedUi;
}

export function fakeContext(options: ContextOptions): FakeContext {
	const timers = new Map<number, () => void>();
	let nextTimer = 1;
	return {
		cwd: options.cwd,
		mode: options.mode ?? "tui",
		hasUI: options.hasUI ?? true,
		...(options.agent ? { agent: options.agent } : {}),
		...(options.model ? { model: options.model } : {}),
		ui: options.ui ?? scriptedUi(),
		sessionManager: { getSessionId: () => options.sessionId ?? "session-1" },
		setInterval(callback) {
			const id = nextTimer++;
			timers.set(id, callback);
			return id;
		},
		clearTimer: timer => void timers.delete(timer),
		timers,
		tick: () => [...timers.values()].forEach(callback => callback()),
	};
}

// ── Child process ────────────────────────────────────────────────────────────

export interface ChildScenario {
	/** Extension module, absolute path. It is the default import named `extension` in `body`. */
	extension: string;
	/**
	 * Script run after the extension is registered on `fake` (a `fakePi()`), with `cwd`, `home` and the
	 * harness exports in scope. It prints one JSON document with `console.log`.
	 */
	body: string;
	env?: Record<string, string>;
	/** Files created under the repo before the run (paths relative to the repo). */
	repoFiles?: Record<string, string>;
	/** Files created under the home before the run (paths relative to the home). */
	homeFiles?: Record<string, string>;
}

/**
 * Runs `body` in a `bun -e` child whose HOME, XDG dirs and working directory (a git repo at `$HOME/repo`) are
 * private to this call and removed afterwards. Returns the JSON the child printed; a non-zero exit throws stderr.
 */
export async function runExtensionChild(scenario: ChildScenario): Promise<unknown> {
	const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "omp-starter-child-home-")));
	try {
		const repo = path.join(home, "repo");
		initGitRepo(repo);
		writeFiles(repo, scenario.repoFiles ?? {});
		writeFiles(home, scenario.homeFiles ?? {});
		const source = `
			import extension from ${JSON.stringify(scenario.extension)};
			import { fakePi, fakeContext, scriptedUi } from ${JSON.stringify(import.meta.path)};
			import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
			import { join } from "node:path";
			const cwd = process.cwd();
			const home = process.env.HOME;
			const fake = fakePi();
			extension(fake.pi);
			${scenario.body}
		`;
		const child = Bun.spawn(["bun", "-e", source], {
			cwd: repo,
			env: {
				...process.env,
				HOME: home,
				XDG_CONFIG_HOME: path.join(home, ".config"),
				XDG_DATA_HOME: path.join(home, ".local", "share"),
				XDG_CACHE_HOME: path.join(home, ".cache"),
				XDG_STATE_HOME: path.join(home, ".local", "state"),
				OMP_STARTER_TEST_HOME: home,
				...scenario.env,
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		if (code !== 0) throw new Error(stderr);
		return JSON.parse(stdout);
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
}
