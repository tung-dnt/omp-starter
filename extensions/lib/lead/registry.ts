// Process-wide state of the lead-driven workflow: the active story, gate decisions outside a story, gates waiting
// for the lead, and running builders. omp evaluates each extension's imports separately and one process serves the
// main session and its subagents, so it lives on `globalThis` (see lib/kb-write-flag).
import type { Invariant, LeadLayout } from "./artifacts";

export interface ActiveStory {
	id: string;
	/** `<layout.stories>/<id>`. */
	dir: string;
	layout: LeadLayout;
	mode: "sync" | "async";
	invariants: Invariant[];
}

export interface PendingGate {
	key: string;
	gateId: string;
	category: string;
	repoName: string;
	rel: string;
	/** Name of the agent that was blocked. */
	agent: string;
}

export interface LeadRegistry {
	story?: ActiveStory;
	sessionId?: string;
	/** Gate decisions made outside a story; they last for the session. */
	sessionApprovals: Map<string, "approved" | "rejected">;
	/** Gates a subagent hit, by gate key, until the lead decides them through the `lead` tool. */
	pending: Map<string, PendingGate>;
	runningBuilders: Set<string>;
	/** Whether the "plan changed after approval" notice was already shown. */
	notifiedPlanChange: boolean;
	/** The machine part of each project note a running write/edit call targets, by note name, as it was before the call. */
	noteBefore: Map<string, string>;
	/** Names of the project notes whose services block an agent changed in this session. */
	editedNotes: Set<string>;
}

const KEY = Symbol.for("omp-starter.lead");
const store = globalThis as typeof globalThis & { [KEY]?: LeadRegistry };

const empty = (sessionId?: string): LeadRegistry => ({
	sessionId,
	sessionApprovals: new Map(),
	pending: new Map(),
	runningBuilders: new Set(),
	notifiedPlanChange: false,
	noteBefore: new Map(),
	editedNotes: new Set(),
});

export function lead(): LeadRegistry {
	return (store[KEY] ??= empty());
}

/** Forgets the story, decisions and pending gates of the previous session. */
export function resetLead(sessionId: string): void {
	store[KEY] = empty(sessionId);
}
