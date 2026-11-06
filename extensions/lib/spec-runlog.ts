// The scheduler's run log: append-only JSONL, one line per slot run, gate answer or notable event, outside the vault at
// `~/.omp/agent/spec-runs/<story>/<iso-ts>.jsonl`. It is for audit and the step-8 metrics; the scheduler never reads it back as state.
import * as fs from "node:fs";
import * as path from "node:path";
import type { SlotName } from "./spec-slots";
import { HOME } from "./state";

export interface SlotLogEntry {
	kind: "slot";
	at: string;
	task: string;
	slot: SlotName;
	/** The run of this stage of the task, counting from 1. */
	attempt: number;
	/** `verdict`: a valid verdict came back. `invalid`: the payload failed its schema. `aborted`: the context ceiling or the wall timeout. `rejected`: the slot changed what it must not. `error`: the runner failed. */
	outcome: "verdict" | "invalid" | "aborted" | "rejected" | "error";
	verdict?: string;
	costUsd: number;
	contextTokens: number;
	durationMs: number;
	sessionFile?: string;
	/** The agent id of the slot's session (never `Main`). */
	agentId?: string;
	/** Why, for an outcome other than `verdict`. */
	detail?: string;
}

export interface GateLogEntry {
	kind: "gate";
	at: string;
	id: string;
	cause: string;
	task?: string;
	choice: string;
	/** What the human typed with the choice. */
	note?: string;
}

/** Anything else worth auditing: a rejected slot's reasons, the fails-before and check results, an integration, a task's end. */
export interface EventLogEntry {
	kind: "event";
	at: string;
	event: string;
	task?: string;
	detail?: string;
}

export type RunLogEntry = SlotLogEntry | GateLogEntry | EventLogEntry;

export interface RunLog {
	append(entry: RunLogEntry): void;
}

export const RUNS_DIR = path.join(HOME, ".omp", "agent", "spec-runs");

export interface FileRunLog extends RunLog {
	/** The JSONL file; it and its folder appear with the first entry. */
	readonly file: string;
}

/** A log file for one run of `story`, named after the run's start time. */
export function fileRunLog(story: string, startedAt: Date, root: string = RUNS_DIR): FileRunLog {
	// Anything outside a plain file name becomes `_`; an empty name or one made only of dots (`..`) would climb out of the root.
	const folder = story.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.*$/, "_");
	const file = path.join(root, folder, `${startedAt.toISOString().replace(/[:.]/g, "-")}.jsonl`);
	return {
		file,
		append(entry) {
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
		},
	};
}
