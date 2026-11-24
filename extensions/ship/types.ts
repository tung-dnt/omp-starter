// The shapes /ship's parts share (plans/001-ship.md). Story 2 (pr.ts) produces a Snapshot, story 3 (watch.ts) turns
// a Snapshot and a Watch into a Step, story 5 (putup.ts) opens a PR, and story 4 (extensions/ship.ts) wires them to
// the session. Each part implements the function type named here, so the parts can be built apart and joined later.

/** The one pull request a watch follows. GitHub only (plan D7). */
export interface PrRef {
	host: "github.com";
	owner: string;
	repo: string;
	number: number;
}

/** Runs `gh` (or `gh-blinx` for blinxsolutions repos, AC1) with these args. Injected, so tests replay recorded output. */
export type Gh = (args: string[]) => { code: number; out: string; err: string };
/** Runs `git -C <dir>` with these args. */
export type Git = (dir: string, args: string[]) => { code: number; out: string; err: string };

export type CheckBucket = "pass" | "fail" | "pending" | "skipping" | "cancel";

export interface Check {
	name: string;
	bucket: CheckBucket;
	link: string | null;
}

/** A comment the trust filter let through (AC7): from the user, someone with write access, or a named bot. */
export interface Note {
	id: string;
	author: string;
	bot: boolean;
	/** Written by /ship itself: starts with the `<!-- omp-ship -->` marker and is by the user's account. */
	yours: boolean;
	at: string;
	url: string;
	/** Quoted lines and hidden HTML comments removed, cut at 4,000 characters. */
	body: string;
	cut: boolean;
}

export interface Thread {
	id: string;
	isResolved: boolean;
	path: string | null;
	line: number | null;
	notes: Note[];
}

export interface Review {
	author: string;
	state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING";
	at: string;
	body: string;
	commit: string | null;
}

/** What one read of the PR found. Everything a pass may act on is in `hash`; nothing outside it starts a pass. */
export interface Snapshot {
	pr: PrRef;
	url: string;
	state: "OPEN" | "MERGED" | "CLOSED";
	isDraft: boolean;
	author: string;
	headRef: string;
	headSha: string;
	baseRef: string;
	mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
	mergeState: string;
	reviewDecision: string | null;
	checks: Check[];
	threads: Thread[];
	comments: Note[];
	reviews: Review[];
	/** Comments the trust filter kept from the model (AC7: counted, the user told once). */
	untrusted: number;
	/** Stable over the head SHA, mergeable state, check buckets, and the trusted threads, comments and reviews. */
	hash: string;
}

/** Who may speak to the watch: the account /ship acts as, and the bots named with `+bot`. */
export interface Trust {
	me: string;
	bots: string[];
}

export type EndReason = "merged" | "closed" | "retargeted" | "time_limit" | "spend_cap" | "stopped" | "taken_over";

/** What the timer does next: run a model pass, wait, or end the watch. */
export type Step = { kind: "pass"; why: string } | { kind: "wait"; until: number } | { kind: "end"; reason: EndReason };

/** The watch's own facts, the ones GitHub can't hold (plan D4), in `~/.omp/agent/ship/watches/<owner>-<repo>-<n>.json`. */
export interface Watch {
	pr: PrRef;
	/** The base and head when the watch started; a different base on GitHub ends it as `retargeted`. */
	baseRef: string;
	headRef: string;
	startedAt: number;
	lastPassAt: number | null;
	lastPushAt: number | null;
	/** The Snapshot hash the last pass saw. */
	lastHash: string | null;
	/** The check the last pass asked for (AC4: 2 min after a push, 30 min while checks run, 1 h when quiet). */
	nextAt: number | null;
	/** Start times of passes, for the 24-per-24-hours cap (AC14). */
	passes: number[];
	/** Pushes per cause, at most 3 each (AC5). */
	pushesPerCause: Record<string, number>;
	/** Keys of things the user was already told once. */
	told: string[];
	/** The live session that runs this watch (AC11); stale after `SHIP.staleOwnerMs` without a heartbeat. */
	owner: { session: string; pid: number; heartbeat: number };
}

export const SHIP = {
	tickMs: 120_000,
	floorMs: 600_000,
	afterPushMs: 120_000,
	checksRunningMs: 1_800_000,
	quietMs: 3_600_000,
	lifetimeMs: 7 * 24 * 3_600_000,
	passCap: 24,
	capWindowMs: 24 * 3_600_000,
	staleOwnerMs: 600_000,
	maxPushesPerCause: 3,
} as const;

// ---- what each story exports ---------------------------------------------------------------------------------------

/** Story 2, `pr.ts` `parseTarget`: a `/ship` argument (`<n>`, `#<n>`, a PR URL) plus the checkout's origin URL, or why not. SSH aliases resolve through `sshHostname`. */
export type ParseTarget = (arg: string | null, originUrl: string, sshHostname: (alias: string) => string | null) => PrRef | { owner: string; repo: string } | string;
/** Story 2, `pr.ts` `readPr`: one read of the PR, or why it couldn't be read. */
export type ReadPr = (pr: PrRef, gh: Gh, trust: Trust) => Snapshot | string;

/** Story 3, `watch.ts` `nextStep`: pure. */
export type NextStep = (snapshot: Snapshot, watch: Watch, now: number) => Step;
/** Story 3, `watch.ts` `claimWatch`: the watch this session may run, a stale one taken over, or why another live session holds it. */
export type ClaimWatch = (pr: PrRef, start: { baseRef: string; headRef: string; session: string; pid: number; now: number }) => Watch | string;
/** Story 3, `watch.ts` `saveWatch`: written to a temp file and renamed into place. */
export type SaveWatch = (watch: Watch) => void;

/** Story 5, `putup.ts` `putUp`: commit, push and open a draft PR for the branch in `root`; or why it refused. `confirm` is absent in unattended sessions. */
export type PutUp = (root: string, deps: { git: Git; gh: Gh; confirm?: (files: string[]) => Promise<boolean> }) => Promise<PrRef | string>;
