// Persistent answers from the setup wizard, shared by every extension in this plugin.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { VoiceId } from "./voices";
import { LANGUAGE_IDS, type LanguageId, type ToolResult, type ToolStatus } from "./tooling/types";

export interface KbState {
	status: "done" | "skipped";
	/** Absolute vault root (the space-free link when one was made). Absent in older state. */
	vault?: string;
	/** Space-free path the agent uses, e.g. `~/.omp-kb/KnowledgeBase`. */
	kbRef?: string;
	/** Absolute paths that identify a KB write (symlink form and resolved form). */
	kbPaths?: string[];
	contextFile?: string;
	/** Commit gate applies to `git commit` run at or below this directory; absent = gate off. */
	gateDir?: string;
}

export interface LanguageState {
	status: "done" | "skipped";
	/** Display language for /trans, any language name (e.g. "Vietnamese"); absent means English. */
	name?: string;
	/** Preset code written before 0.11 (e.g. "vi"); read only when `name` is absent. */
	code?: string;
	/** agy model slug verified at setup; "" uses agy's default model. */
	model?: string;
	/** How text translated into the display language addresses the user; absent means neutral. */
	voice?: VoiceId;
}

/** Outcome of one language group: the language server and the debugger are judged independently. */
export interface LanguageToolingResult {
	lsp: ToolResult;
	dap: ToolResult;
}

/** Guided language tooling (`/starter tools`). `done` only when both integrations are ready for every selected group. */
export interface ToolingState {
	status: "done" | "skipped" | "incomplete";
	selected: LanguageId[];
	results: Partial<Record<LanguageId, LanguageToolingResult>>;
}

export interface SetupState {
	agentSkills?: "done" | "skipped";
	models?: "done" | "skipped";
	kb?: KbState;
	language?: LanguageState;
	tooling?: ToolingState;
}

export const HOME = os.homedir();
export const STATE_FILE = path.join(HOME, ".omp", "agent", "omp-starter.json");

export function expandHome(p: string): string {
	return p === "~" ? HOME : p.startsWith("~/") ? path.join(HOME, p.slice(2)) : p;
}

export function tildify(p: string): string {
	return p === HOME ? "~" : p.startsWith(HOME + path.sep) ? `~/${p.slice(HOME.length + 1)}` : p;
}

export function readState(file = STATE_FILE): SetupState {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8")) as SetupState;
	} catch {
		return {};
	}
}

export function writeState(next: SetupState, file = STATE_FILE): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
}

export function updateState(patch: Partial<SetupState>, file = STATE_FILE): SetupState {
	const next = { ...readState(file), ...patch };
	writeState(next, file);
	return next;
}

// ── Guided language tooling persistence ──────────────────────────────────────
// `readState`/`updateState` treat an unreadable file as empty, which is wrong for a field whose
// results record real installs: a corrupt file must stop the run, never be rewritten as `{}`.

const TOOL_STATUSES: readonly ToolStatus[] = ["ready", "unverified", "missing", "needs-sdk", "unsupported", "failed", "skipped"];
const TOOLING_STATUSES: readonly ToolingState["status"][] = ["done", "skipped", "incomplete"];
const DETAIL_LIMIT = 600;

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeResult(value: unknown): ToolResult | undefined {
	if (!isObject(value) || typeof value.status !== "string" || !TOOL_STATUSES.includes(value.status as ToolStatus)) return undefined;
	if (typeof value.detail !== "string") return undefined;
	const result: ToolResult = { status: value.status as ToolStatus, detail: value.detail.slice(0, DETAIL_LIMIT) };
	if (value.command !== undefined) {
		const command = value.command;
		if (!isObject(command) || typeof command.command !== "string" || !Array.isArray(command.args) || !command.args.every(arg => typeof arg === "string")) return undefined;
		result.command = { command: command.command, args: [...(command.args as string[])] };
	}
	return result;
}

/**
 * Validates stored tooling data. Anything malformed is dropped and reported, never repaired into a
 * better-looking state: a dropped record can only ever mean "not verified yet".
 */
export function normalizeTooling(value: unknown): { tooling: ToolingState | undefined; problems: string[] } {
	if (value === undefined) return { tooling: undefined, problems: [] };
	if (!isObject(value) || !TOOLING_STATUSES.includes(value.status as ToolingState["status"])) {
		return { tooling: undefined, problems: ["the saved language tooling state is not valid and was ignored"] };
	}
	const problems: string[] = [];
	const selected = Array.isArray(value.selected)
		? [...new Set(value.selected.filter((id): id is LanguageId => LANGUAGE_IDS.includes(id as LanguageId)))]
		: [];
	if (!Array.isArray(value.selected) || selected.length !== value.selected.length) problems.push("some saved language selections were not valid and were ignored");
	const results: ToolingState["results"] = {};
	for (const [id, record] of Object.entries(isObject(value.results) ? value.results : {})) {
		const lsp = isObject(record) ? normalizeResult(record.lsp) : undefined;
		const dap = isObject(record) ? normalizeResult(record.dap) : undefined;
		if (!LANGUAGE_IDS.includes(id as LanguageId) || lsp === undefined || dap === undefined) {
			problems.push(`the saved result for "${id}" is not valid and was ignored`);
			continue;
		}
		results[id as LanguageId] = { lsp, dap };
	}
	return { tooling: { status: value.status as ToolingState["status"], selected, results }, problems };
}

/** The state file as a plain object. A missing file is empty; invalid JSON or a non-object is an error. */
function readStateObject(file: string): Record<string, unknown> {
	let text: string;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw new Error(`Cannot read ${file}: ${String(error)}. Fix or remove it, then run /starter tools again.`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new Error(`${file} is not valid JSON (${String(error)}). Nothing was changed; repair or remove it, then run /starter tools again.`);
	}
	if (!isObject(parsed)) throw new Error(`${file} does not hold a JSON object. Nothing was changed; repair or remove it, then run /starter tools again.`);
	return parsed;
}

export function readTooling(file = STATE_FILE): { tooling: ToolingState | undefined; problems: string[] } {
	return normalizeTooling(readStateObject(file).tooling);
}

/** Replaces only the `tooling` field of the current state file (atomic rename), keeping every other key as it is. */
export function saveTooling(tooling: ToolingState, file = STATE_FILE): void {
	const current = readStateObject(file);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
	try {
		fs.writeFileSync(temporary, `${JSON.stringify({ ...current, tooling }, null, 2)}\n`, { flag: "wx" });
		fs.renameSync(temporary, file);
	} catch (error) {
		fs.rmSync(temporary, { force: true });
		throw error;
	}
}
