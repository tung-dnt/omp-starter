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

/** What a call asks for when it may outlive the usual 90 s, or when the user may stop it: a longer time allowance, and a signal that kills it. */
export interface RunLimits {
	timeoutMs?: number;
	signal?: AbortSignal;
}

/** Runs `gh` (or `gh-blinx` for blinxsolutions repos, AC1) with these args, without blocking the session. Output is untrimmed. Injected, so tests replay recorded output. */
export type Gh = (args: string[], limits?: RunLimits) => Promise<{ code: number; out: string; err: string }>;
/** Runs `git -C <dir>` with these args, without blocking the session. Output is untrimmed. */
export type Git = (dir: string, args: string[], limits?: RunLimits) => Promise<{ code: number; out: string; err: string }>;

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

/** Story 2, `pr.ts` `parseTarget`: a `/ship` argument (`<n>`, `#<n>`, or none) plus the checkout's origin URL, or why not. SSH aliases resolve through `sshHostname`. */
export type ParseTarget = (arg: string | null, originUrl: string, sshHostname: (alias: string) => string | null) => PrRef | { owner: string; repo: string } | string;
/** `pr.ts` `parseLink`: the PR a github.com pull request URL names, which needs no checkout. null when the argument is no such URL (`parseTarget` reads numbers, and none), or why a URL that looks like one isn't a PR's. */
export type ParseLink = (arg: string | null) => PrRef | string | null;
/** Story 2, `pr.ts` `readPr`: one read of the PR, or why it couldn't be read. Waits on `gh`, so the session keeps running meanwhile. */
export type ReadPr = (pr: PrRef, gh: Gh, trust: Trust) => Promise<Snapshot | string>;

/** What a PR link needs to know before it can name a folder: whether the PR is still open, whose it is, and where its branch is. */
export interface Head {
	state: Snapshot["state"];
	author: string;
	/** The head branch's name. */
	branch: string;
	/** The branch lives in a fork, not in the PR's own repository. */
	fork: boolean;
}
/** `pr.ts` `readHead`: one `gh pr view` of the PR, or why it couldn't be read. */
export type ReadHead = (pr: PrRef, gh: Gh) => Promise<Head | string>;

/** Story 3, `watch.ts` `nextStep`: pure. */
export type NextStep = (snapshot: Snapshot, watch: Watch, now: number) => Step;
/** Story 3, `watch.ts` `claimWatch`: the watch this session may run, a stale one taken over, or why another live session holds it. */
export type ClaimWatch = (pr: PrRef, start: { baseRef: string; headRef: string; session: string; pid: number; now: number }) => Watch | string;
/** Story 3, `watch.ts` `saveWatch`: written to a temp file and renamed into place. */
export type SaveWatch = (watch: Watch) => void;

/** Story 5, `putup.ts` `putUp`: commit, push and open a draft PR for the branch in `root`; or why it refused. `confirm` is absent in unattended sessions; `signal` aborts when the start is stopped, and put-up then gives up before its next add, commit, push or PR create. */
export type PutUp = (root: string, deps: { git: Git; gh: Gh; confirm?: (files: string[]) => Promise<boolean>; signal?: AbortSignal }) => Promise<PrRef | string>;

/** What a PR link asks the find step for: the checkout of this PR's branch. */
export interface Want {
	pr: PrRef;
	/** The PR's head branch. */
	branch: string;
	/** The branch lives in a fork, so no clone of the PR's repository can hold it. */
	fork: boolean;
}

/** What the find step needs from the session: git and gh, how an origin URL names a repository, where to look, and the user. */
export interface FindDeps {
	git: Git;
	/** As the account that owns the PR's repository: it clones. */
	gh: Gh;
	/** The repository an origin URL names, or null when it isn't one /ship can read (no GitHub URL, an ssh alias ssh can't resolve). */
	repoOf(originUrl: string): { owner: string; repo: string } | null;
	/** The folder whose direct children are searched for clones of the repository, and where a new clone goes. */
	projects: string;
	/** The checkout this session is in, or null when it is in none. */
	session: string | null;
	/** Asks the user once before anything is made or used; absent when nobody can answer (an unattended session, or none with a UI), which refuses instead. */
	confirm?: (title: string, message: string) => Promise<boolean>;
	/** Aborts when the user stops the /ship that called this. Checked before each step that changes something; a clone or fetch under way is killed. */
	signal: AbortSignal;
}

/** Where the watch runs: this session's own folder, an existing checkout of the branch, or a worktree or clone made for it. */
export interface Found {
	root: string;
	kind: "session" | "existing" | "worktree" | "clone";
}

/** Find step, `find.ts` `findCheckout`: the folder to watch `want` in, or why there is none. Nothing is made until the user has said yes, and every refusal that can be known beforehand comes first, so such a refusal or a no leaves every folder as it was; a clone that fails or is stopped is removed again. */
export type FindCheckout = (want: Want, deps: FindDeps) => Promise<Found | string>;
