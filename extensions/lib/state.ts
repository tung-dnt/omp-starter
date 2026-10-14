// Persistent answers from the setup wizard, shared by every extension in this plugin.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { VoiceId } from "./voices";

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

export interface SetupState {
	agentSkills?: "done" | "skipped";
	models?: "done" | "skipped";
	kb?: KbState;
	language?: LanguageState;
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
