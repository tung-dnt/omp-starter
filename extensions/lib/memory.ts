// Memory step (`/starter memory`): picks omp's `memory.backend` and the commit-gate folders, and holds what the
// generated AGENTS.md and the commit gate say about each backend. omp owns the backend settings (`/settings` →
// Memory, `/memory`); this plugin only adds the agent rules and the gate.
import * as fs from "node:fs";
import * as path from "node:path";
import type { Exec, WizardUi } from "../setup";
import { applySettings, readSetting } from "./routing";
import { HOME, expandHome, tildify, type MemoryBackend, type MemoryState, type SetupState } from "./state";

/** The AGENTS.md omp loads in every session: the memory rules and the commit gate live here. */
export const EVERY_SESSION_FILE = path.join(HOME, ".omp", "agent", "AGENTS.md");

/** `raw` as an absolute, existing folder (`~` expands), or undefined after telling the user why not. */
export function existingFolder(ui: WizardUi, raw: string): string | undefined {
	const dir = expandHome(raw);
	if (!path.isAbsolute(dir) || !fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
		ui.notify(`${tildify(dir)} is not an existing absolute folder. Use a path like ~/projects.`, "error");
		return undefined;
	}
	return path.resolve(dir);
}

const within = (p: string, dir: string): boolean => p === dir || p.startsWith(dir + path.sep);

/** Existing path as written plus its symlink-resolved form, so either spelling matches. */
function forms(p: string): string[] {
	try {
		const real = fs.realpathSync(p);
		return real === p ? [p] : [p, real];
	} catch {
		return [p];
	}
}

/** Whether `p` is `dir` or below it, comparing as-written and symlink-resolved forms of both. */
export const inside = (p: string, dir: string): boolean => forms(p).some(a => forms(dir).some(d => within(a, d)));

interface BackendInfo {
	label: string;
	/** Agent tools whose successful call writes memory. Which of them exist also depends on `autolearn`. */
	writeTools: string[];
}

/** Every `memory.backend` value, in the order the step offers them. `omp config get` does not list them. */
export const MEMORY_BACKENDS: Record<MemoryBackend, BackendInfo> = {
	off: { label: "No memory subsystem", writeTools: [] },
	local: { label: "Local session summaries (memory_summary.md)", writeTools: ["learn"] },
	hindsight: { label: "Hindsight remote memory service", writeTools: ["retain", "learn"] },
	mnemopi: { label: "Local SQLite recall/retain", writeTools: ["retain", "learn", "memory_edit"] },
	sharpshooter: { label: "Project decision files, consolidated in background", writeTools: [] },
};

/** Tools whose successful result the commit gate counts as a saved memory, whatever the backend. */
export const MEMORY_WRITE_TOOLS: readonly string[] = ["retain", "learn", "memory_edit"];

const isBackend = (value: unknown): value is MemoryBackend => typeof value === "string" && value in MEMORY_BACKENDS;

/** omp's current `memory.backend`, or undefined when omp cannot be read or reports an unknown value. */
export async function readBackend(exec: Exec): Promise<MemoryBackend | undefined> {
	try {
		const value = await readSetting(exec, "memory.backend");
		return isBackend(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

const DATA_RULE = "Never retain database query results, tool output that holds patient data, or secrets.";
const FACTS = "(decision, gotcha, convention, user preference, resolved failure)";
const RECALL_FIRST = "Before working a repo, `recall` its system map, conventions and invariants.";

/** The memory rules for AGENTS.md, or undefined when the backend gives the agent nothing to follow. */
export function memorySection(backend: MemoryBackend | undefined): string | undefined {
	let body: string;
	switch (backend) {
		case "hindsight":
			body = `Memory lives in omp's Hindsight backend; relevant memories are recalled when a session starts. ${RECALL_FIRST} When you learn a durable fact ${FACTS}, save it with \`retain\` (or \`learn\`). Search past memories with \`recall\`; use \`reflect\` to synthesize an answer from many. Update a stale memory instead of adding a contradicting one.`;
			break;
		case "mnemopi":
			body = `Memory lives in omp's local mnemopi store. ${RECALL_FIRST} When you learn a durable fact ${FACTS}, save it with \`retain\` (or \`learn\`). Search past memories with \`recall\`; use \`reflect\` to synthesize an answer from many. Edit or forget a memory with \`memory_edit\`. Update a stale memory instead of adding a contradicting one.`;
			break;
		case "local":
			body = `omp summarises sessions into memory automatically. When you learn a durable fact ${FACTS}, save it with \`learn\` if that tool is available.`;
			break;
		case "sharpshooter":
			body = "Decisions are kept as project decision files that omp consolidates in the background. Follow them unless the user overrides one.";
			break;
		default:
			return undefined;
	}
	return `# Memory\n\n${body}\n\n${DATA_RULE}\n`;
}

const list = (items: string[], joiner: "or" | "and" = "or"): string =>
	items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} ${joiner} ${items.at(-1)}`;

/**
 * What satisfies the commit gate: a successful memory write with the backend's tools (a generic phrase while the backend
 * is unknown). Undefined when the backend has no write tool, so the gate has no use.
 */
export function gateRequirement(backend: MemoryBackend | undefined): string | undefined {
	if (!backend) return "a successful memory tool call such as `retain` or `learn`";
	const tools = MEMORY_BACKENDS[backend].writeTools;
	return tools.length ? `a successful ${list(tools.map(t => `\`${t}\``))}` : undefined;
}

/** The commit-gate rules for AGENTS.md, or undefined without gate folders or anything that could satisfy the gate. */
export function gateSection(memory: MemoryState | undefined): string | undefined {
	const dirs = memory?.status === "done" ? memory.gateDirs ?? [] : [];
	const requirement = gateRequirement(memory?.backend);
	if (!dirs.length || !requirement) return undefined;
	return `# Commit gate\n\n\`git commit\` under ${list(dirs.map(tildify))} is blocked until this session has saved something: ${requirement}. Save the relevant facts first; for commits with no new facts (typos, formatting) put \`[skip-mem]\` in the commit message.\n`;
}

const GATE_DEFAULT = "~/projects";

/**
 * Memory step: select omp's memory backend (the setting is changed only when the choice differs), then the folders under
 * which the commit gate applies. Cancelling the backend choice returns the current state unchanged.
 */
export async function setupMemory(ui: WizardUi, exec: Exec, current: SetupState): Promise<MemoryState> {
	const unchanged: MemoryState = current.memory ?? { status: "skipped" };
	const live = await readBackend(exec);
	const mark = (backend: MemoryBackend) => `${backend}: ${MEMORY_BACKENDS[backend].label}${backend === live ? " (current)" : ""}`;
	const options = (Object.keys(MEMORY_BACKENDS) as MemoryBackend[]).map(mark);
	const picked = await ui.select(`Memory backend (current: ${live ?? "unknown"})`, options);
	const backend = (Object.keys(MEMORY_BACKENDS) as MemoryBackend[]).find(b => mark(b) === picked);
	if (!backend) return unchanged;
	if (backend !== live) {
		try {
			await applySettings(exec, [{ key: "memory.backend", value: backend }]);
		} catch (error) {
			ui.notify(`Could not set memory.backend: ${error instanceof Error ? error.message : String(error)}`, "error");
			return unchanged;
		}
	}
	ui.notify(
		backend === "hindsight"
			? "memory.backend is hindsight. Next: set the server URL and token in /settings → Memory, or export HINDSIGHT_API_URL and HINDSIGHT_API_TOKEN. Takes effect in new sessions."
			: `memory.backend is ${backend}. Takes effect in new sessions. Tune it in /settings → Memory; /memory inspects it.`,
		"info",
	);

	const previous = current.memory?.gateDirs ?? [];
	const gateDirs = gateRequirement(backend) ? await askGateDirs(ui, previous) : [];
	return { status: "done", backend, ...(gateDirs.length ? { gateDirs } : {}) };
}

/** Folders for the commit gate; none when the user declines or names a folder that does not exist. */
async function askGateDirs(ui: WizardUi, previous: string[]): Promise<string[]> {
	const fallback = previous.length ? previous.map(tildify).join(", ") : GATE_DEFAULT;
	const on = await ui.confirm(
		"Commit gate",
		`Block agent \`git commit\` under ${fallback} until a memory was saved in the session ([skip-mem] bypasses)?`,
	);
	if (!on) return [];
	const raw = (await ui.input("Folders for the commit gate (comma-separated)", fallback))?.trim() || fallback;
	const dirs = raw.split(",").map(s => existingFolder(ui, s.trim()));
	return dirs.every(Boolean) ? [...new Set(dirs as string[])] : [];
}
