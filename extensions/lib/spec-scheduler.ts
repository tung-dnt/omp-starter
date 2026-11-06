// The scheduler core. `runPlan` takes the plan the vault holds and drives it to the end: code decides the order, the retries, the
// locks, the commits, the integration, the budget and every gate; agents are only called as bounded slots that return a verdict
// the code checks (`spec-slots.ts`). Pure over injected deps, so the tests swap the slot runner, git and checks.
// It keeps no state between runs: each start derives everything from the plan and git, so a crash at any point resumes on the next run.
import * as path from "node:path";
import type { CheckReport, FailsBeforeResult } from "./spec-check";
import type { CheckNote, TaskCommit } from "./spec-git";
import { type GuardViolation, formatViolation } from "./spec-guard";
import { type Plan, type TaskBlock, parsePlan } from "./spec-plan";
import { RISK_FIELDS } from "./spec-risk";
import type { RunLog } from "./spec-runlog";
import {
	SLOTS,
	type Finding,
	type SlotName,
	type SlotResult,
	type SlotRunner,
	type SlotSpec,
	type SlotVerdicts,
	type StopVerdict,
	buildPrompt,
	findingLines,
	parseVerdict,
	reviewsFor,
} from "./spec-slots";
import { type StoryStatus, computeStatus, formatStatusLine } from "./spec-status";
import { isTestPath } from "./spec-testfiles";
import { validatePlan } from "./spec-validate";
import { errorMessage } from "./tooling/runtime";

export const DEFAULTS = {
	concurrency: 2,
	budgetUsd: 100,
	/** What the budget gate's "raise" adds. */
	budgetRaiseUsd: 50,
	maxContextTokens: 300_000,
	slotTimeoutMs: 20 * 60_000,
	/** Slot runs of one stage before the cap gate opens. */
	maxAttempts: 3,
	/** How long a runner gets to return after its signal fired before the scheduler stops waiting for it. */
	abortGraceMs: 10_000,
} as const;

// ── Dependencies ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The plan as the vault holds it. */
export interface PlanSnapshot {
	/** The vault commit that last changed the plan: the `Plan-Rev` of everything this run commits. */
	rev: string;
	/** The working-tree text of `plan.md`. */
	text: string;
	/** The working-tree text equals the text at `rev` (HEAD): nothing is edited and uncommitted. */
	committed: boolean;
	/** Absolute path of the plan file in the vault work tree. */
	file: string;
	/** Absolute path of the vault work tree, which relative `lld` paths of the plan resolve against. */
	root: string;
}

/** Where a slot runs: a task worktree. */
export interface Workdir {
	repo: string;
	dir: string;
}

export interface Worktree extends Workdir {
	task: string;
	/** `spec-wt/<ticket>/<task>`. */
	branch: string;
	/** The ticket tip the worktree was made from. */
	startTip: string;
}

export interface RepoState {
	ticket: string;
	/** The ref the ticket branch is measured from. */
	base: string;
	/** Where the clone is, for messages. */
	clone: string;
	branchExists: boolean;
	/** No uncommitted change to a tracked file and no cherry-pick, merge or rebase in progress. */
	clean: boolean;
	/** What makes it dirty, a few lines. */
	dirty: string[];
	/** `missing` also covers a hook that guards another plan. */
	hook: "installed" | "missing";
}

export interface Committed {
	sha: string;
	/** Files the commit added or changed, which exist after it. */
	files: string[];
	deleted: string[];
}

/** What a slot's run left that it should not have. Created before the slot, asked after it. */
export interface SlotWatch {
	/** Git state moved (HEAD, refs, config, hooks), files outside `writeScope`, locked files changed, and, with `only`, changed files it rejects; empty when the slot kept its place. */
	violations(writeScope: readonly string[], lockedFiles: readonly string[], only?: (path: string) => boolean): string[];
	/** Puts the work directory back as it was before the slot: the branch where it was, no file left over. */
	discard(): void;
}

export type IntegrateResult = { ok: true; from: string; to: string } | { ok: false; conflict: string };

/** One run's hold on a repo's ticket. */
export interface RunLock {
	/** Deletes the lock file; safe to call twice. */
	release(): void;
	/** The holder whose lock was taken over because its process is gone. */
	tookOver?: { pid: number; host: string; startedAt: string };
}

/** Another run holds the lock: `file` names it, `holder` says who. */
export class RunLocked extends Error {
	constructor(
		readonly file: string,
		readonly holder: { pid: number; host: string; startedAt: string },
	) {
		super(`${file} is held by pid ${holder.pid} on ${holder.host} since ${holder.startedAt}`);
	}
}

export interface GitOps {
	/** The plan as the vault holds it. Throws when the vault or the file cannot be read. */
	plan(): PlanSnapshot;
	/** Tracked files of the repo's clone, for the validator. Throws when no clone is mapped to `repo`. */
	files(repo: string): string[];
	inspect(repo: string): RepoState;
	/** Creates the ticket branch from its base. Only after a gate said so: no branch without asking. */
	createBranch(repo: string): void;
	/** Installs the clone-local pre-push hook for this plan; throws when a hook the scheduler did not write is in the way. */
	installHook(repo: string): void;
	/** Removes what an earlier run of this ticket left: worktrees and branches `spec-wt/<ticket>/*`. Returns what it removed. */
	cleanup(repo: string): string[];
	/** The commits of `<base>..<ticket>`, oldest first. */
	commits(repo: string): TaskCommit[];
	note(repo: string, sha: string): CheckNote | undefined;
	/** The blocked note of a task with no commit yet, kept on the task's key object. */
	taskNote(repo: string, task: string): CheckNote | undefined;
	/** Writes the task's blocked note; `undefined` deletes it. */
	setTaskNote(repo: string, task: string, note: CheckNote | undefined): void;
	/** A worktree on the new branch `spec-wt/<ticket>/<name>`, at the ticket tip. */
	addWorktree(repo: string, name: string): Worktree;
	removeWorktree(wt: Worktree): void;
	watch(at: Workdir): SlotWatch;
	/** Stages everything and commits it with `Task` and `Plan-Rev` trailers; undefined when there is nothing to commit. */
	commit(wt: Worktree, commit: { task: string; planRev: string; subject: string }): Committed | undefined;
	/** The empty `Task-Lock` commit over `files`; returns its sha. */
	lock(wt: Worktree, lock: { task: string; planRev: string; files: string[] }): string;
	/** The empty `Task-Unlock` commit a human gate approved; returns its sha. */
	unlock(wt: Worktree, unlock: { task: string; planRev: string; gate: string }): string;
	/** The empty `Security-Accept` commit a human gate accepted a patient-data finding with, trailers `Task`, `Plan-Rev`, `Security-Accept` and `Accept-Gate`; returns its sha. */
	accept(wt: Worktree, accept: { task: string; planRev: string; gate: string }): string;
	/** The change of the work directory since `from`, as a unified diff. */
	diff(at: Workdir, from: string): string;
	/**
	 * Replays the task's commits on the current ticket tip inside the worktree (cherry-pick; a conflict is aborted and reported),
	 * leaving the ticket branch alone. `from` is the ticket tip the commits sit on, `to` the tip of the replayed commits.
	 */
	integrate(wt: Worktree): IntegrateResult | Promise<IntegrateResult>;
	writeNote(repo: string, sha: string, note: CheckNote): void;
	/** Moves the ticket branch from `candidate.from` to `candidate.to`, which descends from it. */
	publish(wt: Worktree, candidate: { from: string; to: string }): void;
	/**
	 * Puts the worktree on its branch at `c.to`, the replayed commits (a replay leaves it detached), and returns it with `startTip = c.from`,
	 * the ticket tip those commits now sit on. The implementer then fixes in place; nothing is lost.
	 */
	adopt(wt: Worktree, c: { from: string; to: string }): Worktree;
	/** Keeps the tip of the task's branch under `refs/spec-conflict/<ticket>/<task>` and returns that ref. Called before the task's branch is deleted. */
	keep(wt: Worktree): string;
	/**
	 * Takes the run lock of the repo's ticket (one run per ticket and clone). Throws `RunLocked` when another run holds it; a lock of a
	 * dead process on this host is taken over (`tookOver` says whose).
	 */
	acquire(repo: string): RunLock;
}

export interface CheckOps {
	/** The deterministic part of the test review: the task's test files must fail where the work has not been done. */
	failsBefore(wt: Worktree, sha: string, files: readonly string[], command: string): Promise<FailsBeforeResult>;
	/** Runs the repo's checks and the guard on `sha` and writes the check note on it. */
	check(wt: Worktree, sha: string): Promise<CheckReport>;
	/** The guard, strict, over `<from>..<to>`. */
	guard(repo: string, from: string, to: string): GuardViolation[] | Promise<GuardViolation[]>;
}

export type GateCause =
	| StopVerdict
	| "cap"
	| "budget"
	| "conflict"
	| "guard"
	| "missing-branch"
	| "missing-hook"
	| "plan-changed"
	| "review"
	| "patient_data";

export interface GateChoice {
	id: string;
	label: string;
	/** The answer also carries a note the human types. */
	note?: boolean;
}

/** A decision for the human. Code builds the choices; the human picks one. */
export interface GateRequest {
	id: string;
	cause: GateCause;
	task?: string;
	title: string;
	/** The evidence: a verdict's notes, findings, failing output. */
	detail: string;
	choices: GateChoice[];
	/** The choice taken when nobody answers (dialog dismissed, no UI). Always one that stops. */
	fallback: string;
}

export interface GateAnswer {
	choice: string;
	note?: string;
}

export interface Gate {
	choose(request: GateRequest, signal?: AbortSignal): Promise<GateAnswer>;
}

export interface SchedulerDeps {
	slots: SlotRunner;
	gate: Gate;
	git: GitOps;
	checks: CheckOps;
	log: RunLog;
	now(): Date;
}

export interface RunOptions {
	/** `/run-story` runs a story plan and `/run-task` a task plan; absent: either. */
	kind?: "story" | "task";
	concurrency?: number;
	budgetUsd?: number;
	maxContextTokens?: number;
	slotTimeoutMs?: number;
	maxAttempts?: number;
	abortGraceMs?: number;
	/** Stops the run (`/run-stop`): in-flight slots are aborted, the worktrees go, no blocked note is written. */
	signal?: AbortSignal;
	/** The status line for the TUI: the story status and what is running. */
	onStatus?(line: string): void;
}

export interface RunSummary {
	/** `complete`: every task is done and the story review has run. `incomplete`: a task is blocked, stuck or was not started. `stopped`: `/run-stop`, a budget or plan gate. `refused`: a precondition failed and nothing ran. */
	outcome: "complete" | "incomplete" | "stopped" | "refused";
	/** One line each: why the run ended early or never started, and which tasks did not finish. */
	reasons: string[];
	/** The story status when the run ended; absent when the run was refused before the plan was usable. */
	status?: StoryStatus;
	costUsd: number;
	/** Slot runs by the run, rejected and aborted ones included. */
	slotRuns: number;
}

/** The status of the story from git alone: what the scheduler decides on at every start. */
export function statusFromGit(git: Pick<GitOps, "commits" | "note" | "taskNote">, plan: Plan, planRev: string): StoryStatus {
	const repos = [...new Set(plan.tasks.map(task => task.repo))];
	const commitsByRepo = new Map(repos.map((repo): [string, TaskCommit[]] => [repo, git.commits(repo)]));
	return computeStatus(plan, commitsByRepo, (repo, sha) => git.note(repo, sha), undefined, { planRev, taskNote: (repo, id) => git.taskNote(repo, id) });
}

// ── Internals ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The run was stopped: `/run-stop`, or a gate answered "stop the run". Unwinds every task without writing a blocked note. */
class RunStopped extends Error {}

/** A task ended in a blocked state; the note is already written. */
class TaskBlocked extends Error {
	constructor(readonly cause: string) {
		super(`task blocked: ${cause}`);
	}
}

/** Runs one function at a time, in call order. */
class Mutex {
	#tail: Promise<unknown> = Promise.resolve();

	run<T>(fn: () => T | Promise<T>): Promise<T> {
		const result = this.#tail.then(fn);
		this.#tail = result.catch(() => undefined);
		return result;
	}
}

const OUTPUT_TAIL = 4_000;
const tail = (text: string): string => (text.length > OUTPUT_TAIL ? `…${text.slice(-OUTPUT_TAIL)}` : text);

const STORY_WORKTREE = "_review";
const STOP: GateChoice = { id: "stop", label: "Stop this task" };
const RETRY_ONCE: GateChoice = { id: "retry", label: "Retry once more" };

/** A plan has no task for the story-end review; this stands in with nothing to write. */
const storyTask = (repo: string): TaskBlock => ({
	id: "story",
	repo,
	depends_on: [],
	foundation: false,
	owns: [],
	new_paths: [],
	reads: [],
	risk: Object.fromEntries(RISK_FIELDS.map(field => [field, { value: "no" }])) as TaskBlock["risk"],
	lld_required: false,
	security_review: false,
	required_tests: [],
	acceptance: [],
	size: "normal",
});

interface TaskRun {
	task: TaskBlock;
	/** False for the story-end review: it has no blocked note to write. */
	durable: boolean;
	wt?: Worktree;
	/** Test files committed so far that still exist at the worktree's tip. */
	testFiles: Set<string>;
	lockedFiles: string[];
	/** What the previous run of the current stage left to fix. */
	findings: string[];
	/** What a human typed at a gate; it stays with the task. */
	notes: string[];
	runs: { tests: number; build: number };
	caps: { tests: number; build: number };
	slotRuns: Partial<Record<SlotName, number>>;
	/** The last check report that passed. */
	report?: CheckReport;
}

type SlotOutcome<S extends SlotName> = { kind: "verdict"; value: SlotVerdicts[S] } | { kind: "retry"; reason: string };

interface SlotExtra {
	wd: Workdir;
	phase?: "tests" | "implement";
	findings?: readonly string[];
	lockedFiles?: readonly string[];
	diff?: { text: string; from: string };
	attempt?: { n: number; of: number };
	scope?: "story";
	tasks?: readonly TaskBlock[];
}

type Integration =
	| { kind: "published" }
	| { kind: "conflict"; detail: string }
	| { kind: "guard"; violations: GuardViolation[] }
	/** The replayed tip fails its checks; `picked` is what `adopt` needs. */
	| { kind: "checks"; lines: string[]; picked: { from: string; to: string } }
	| { kind: "error"; message: string };

type Answered = GateAnswer & { id: string };

function failureLines(report: CheckReport): string[] {
	const lines = report.results.filter(result => result.status === "fail").map(result => `${result.name} failed (${result.reason ?? "failed"}):\n${tail(result.output)}`);
	for (const violation of report.violations) lines.push(`guard: ${formatViolation(violation)}`);
	return lines;
}

class Run {
	readonly #deps: SchedulerDeps;
	readonly #opts: RunOptions;
	readonly #concurrency: number;
	readonly #maxAttempts: number;
	readonly #stop = new AbortController();
	#stopReason: string | undefined;
	readonly #gates = new Mutex();
	readonly #integrations = new Mutex();

	#plan!: Plan;
	#snapshot!: PlanSnapshot;
	#planChangeAccepted = false;
	#repoStates = new Map<string, RepoState>();
	readonly #runId: string;
	#gateSeq = 0;

	#budget: number;
	#spent = 0;
	#slotRuns = 0;
	#inFlight = 0;
	#idleWaiters: Array<() => void> = [];
	#budgetDecision: Promise<void> | undefined;

	readonly #begun = new Set<string>();
	readonly #outcomes = new Map<string, { state: "done" | "blocked" | "stopped" | "error"; detail: string }>();
	readonly #activity = new Map<string, string>();
	#lastStatus: StoryStatus | undefined;
	#reviewOpen: string[] = [];
	/** Run locks taken so far; `execute` releases them. */
	#locks: RunLock[] = [];

	constructor(deps: SchedulerDeps, opts: RunOptions) {
		this.#deps = deps;
		this.#opts = opts;
		this.#concurrency = Math.max(1, opts.concurrency ?? DEFAULTS.concurrency);
		this.#maxAttempts = Math.max(1, opts.maxAttempts ?? DEFAULTS.maxAttempts);
		this.#budget = opts.budgetUsd ?? DEFAULTS.budgetUsd;
		this.#runId = deps.now().toISOString().replace(/[-:.]/g, "");
		const stop = (): void => this.#requestStop("stopped with /run-stop");
		if (opts.signal?.aborted) stop();
		else opts.signal?.addEventListener("abort", stop, { once: true });
	}

	get #signal(): AbortSignal {
		return this.#stop.signal;
	}

	#now(): string {
		return this.#deps.now().toISOString();
	}

	#event(event: string, task?: string, detail?: string): void {
		this.#deps.log.append({ kind: "event", at: this.#now(), event, ...(task === undefined ? {} : { task }), ...(detail === undefined ? {} : { detail }) });
	}

	#requestStop(reason: string): void {
		this.#stopReason ??= reason;
		this.#stop.abort();
	}

	#throwIfStopped(): void {
		if (this.#signal.aborted) throw new RunStopped(this.#stopReason ?? "stopped");
	}

	// ── Whole run ─────────────────────────────────────────────────────────────────────────────────────────────────────────

	/** The run lock of every repo is held from the top of the preflight to here, a refusal included. */
	async execute(): Promise<RunSummary> {
		try {
			return await this.#execute();
		} finally {
			for (const lock of this.#locks.splice(0)) {
				try {
					lock.release();
				} catch (error) {
					this.#event("lock-release-failed", undefined, errorMessage(error));
				}
			}
		}
	}

	async #execute(): Promise<RunSummary> {
		let refusal: string[];
		try {
			refusal = await this.#preflight();
		} catch (error) {
			if (!(error instanceof RunStopped)) throw error;
			refusal = [error.message];
		}
		if (refusal.length > 0) {
			this.#event("refused", undefined, refusal.join(" | "));
			return { outcome: this.#signal.aborted ? "stopped" : "refused", reasons: refusal, costUsd: 0, slotRuns: 0 };
		}
		this.#event("run-start", undefined, `plan ${this.#snapshot.rev}, concurrency ${this.#concurrency}, budget $${this.#budget}`);
		for (const repo of this.#repos()) {
			const removed = this.#deps.git.cleanup(repo);
			if (removed.length > 0) this.#event("cleanup", undefined, `${repo}: removed ${removed.join(", ")}`);
		}
		try {
			await this.#loop();
		} catch (error) {
			if (!(error instanceof RunStopped)) throw error;
		}

		let status = this.#status();
		if (status.tasks.every(task => task.state === "done") && !this.#signal.aborted) {
			try {
				await this.#storyReview();
			} catch (error) {
				if (!(error instanceof RunStopped)) throw error;
			}
			status = this.#status();
		}
		this.#publish(status);
		const summary = this.#summarise(status);
		this.#event("run-end", undefined, `${summary.outcome}, $${summary.costUsd.toFixed(4)}, ${summary.slotRuns} slot runs`);
		return summary;
	}

	#repos(): string[] {
		return [...new Set(this.#plan.tasks.map(task => task.repo))];
	}

	#status(): StoryStatus {
		const status = statusFromGit(this.#deps.git, this.#plan, this.#snapshot.rev);
		this.#lastStatus = status;
		return status;
	}

	#publish(status: StoryStatus | undefined = this.#lastStatus): void {
		if (status === undefined || this.#opts.onStatus === undefined) return;
		const running = [...this.#activity].map(([task, what]) => `${task} ${what}`);
		this.#opts.onStatus(running.length > 0 ? `${formatStatusLine(status)} · running ${running.join(", ")}` : formatStatusLine(status));
	}

	#summarise(status: StoryStatus): RunSummary {
		const reasons: string[] = [];
		if (this.#signal.aborted) reasons.push(this.#stopReason ?? "stopped");
		const byId = new Map(status.tasks.map(task => [task.id, task]));
		for (const task of status.tasks) {
			const outcome = this.#outcomes.get(task.id);
			if (task.state === "blocked") reasons.push(`${task.id} is blocked${task.reason ? `: ${task.reason}` : ""}`);
			else if (outcome?.state === "error") reasons.push(`${task.id} stopped on an unexpected error: ${outcome.detail}`);
			else if (task.state === "failing" || task.state === "checking" || task.state === "awaiting-lock") {
				reasons.push(`${task.id} has unfinished commits on the ticket branch (${task.state}); finish it by hand`);
			} else if (task.state === "waiting") {
				const upstream = this.#plan.tasks.find(candidate => candidate.id === task.id)?.depends_on.filter(id => byId.get(id)?.state !== "done") ?? [];
				if (!this.#signal.aborted) reasons.push(`${task.id} was not started: ${task.reason ?? `it waits for ${upstream.join(", ")}`}`);
			} else if (task.state === "ready" && !this.#signal.aborted) reasons.push(`${task.id} was not started`);
		}
		for (const repo of this.#reviewOpen) reasons.push(`the story review of ${repo} left findings; fix them by hand and rerun`);
		const allDone = status.tasks.every(task => task.state === "done");
		const outcome = this.#signal.aborted ? "stopped" : allDone && this.#reviewOpen.length === 0 ? "complete" : "incomplete";
		return { outcome, reasons, status, costUsd: this.#spent, slotRuns: this.#slotRuns };
	}

	// ── Preconditions ─────────────────────────────────────────────────────────────────────────────────────────────────────

	/**
	 * One run per ticket and clone: takes every repo's run lock, in sorted order, before any gate or cleanup (the cleanup would remove
	 * another run's live worktrees). A lock of a dead process is taken over and logged. The locks go to `execute`, which releases them.
	 */
	#acquireLocks(): string[] {
		for (const repo of this.#repos().sort()) {
			let lock: RunLock;
			try {
				lock = this.#deps.git.acquire(repo);
			} catch (error) {
				if (error instanceof RunLocked) {
					const { pid, host, startedAt } = error.holder;
					return [`${repo}: another run holds ${error.file} (pid ${pid} on ${host}, started ${startedAt}); wait for it, or delete the file if that run is gone`];
				}
				return [`${repo}: the run lock could not be taken: ${errorMessage(error)}`];
			}
			this.#locks.push(lock);
			if (lock.tookOver !== undefined) {
				const { pid, host, startedAt } = lock.tookOver;
				this.#event("lock-takeover", undefined, `${repo}: took over the lock of pid ${pid} on ${host} (started ${startedAt}), which is no longer running`);
			}
		}
		return [];
	}

	/** The reasons the run cannot start, or none. A missing branch or hook opens a gate instead of failing. */
	async #preflight(): Promise<string[]> {
		const git = this.#deps.git;
		let snapshot: PlanSnapshot;
		try {
			snapshot = git.plan();
		} catch (error) {
			return [`cannot read the plan from the vault: ${errorMessage(error)}`];
		}
		if (!snapshot.committed) return [`the plan ${snapshot.file} has uncommitted changes in the vault: commit it first, because every commit pins the plan revision`];
		const parsed = parsePlan(snapshot.text);
		if (!parsed.ok) return parsed.errors.map(violation => `the plan does not parse: ${violation.rule}: ${violation.detail}`);
		const plan = parsed.plan;
		if (this.#opts.kind !== undefined && plan.kind !== this.#opts.kind) {
			return [`this command runs a ${this.#opts.kind} plan, but ${plan.id} is kind: ${plan.kind}`];
		}
		this.#plan = plan;
		this.#snapshot = snapshot;
		const refused = this.#acquireLocks();
		if (refused.length > 0) return refused;

		const reasons: string[] = [];
		const files = new Map<string, string[]>();
		for (const repo of this.#repos()) {
			try {
				this.#repoStates.set(repo, git.inspect(repo));
				files.set(repo, git.files(repo));
			} catch (error) {
				reasons.push(`${repo}: ${errorMessage(error)}`);
			}
		}
		if (reasons.length > 0) return reasons;
		for (const violation of validatePlan(plan, files)) reasons.push(`the plan is invalid: ${violation.rule}${violation.task === undefined ? "" : ` [${violation.task}]`}: ${violation.detail}`);
		for (const [repo, state] of this.#repoStates) {
			if (!plan.checks[repo]?.test_files?.trim()) reasons.push(`the plan declares no checks.test_files for ${repo}, which the fails-before check needs`);
			if (!state.clean) reasons.push(`${repo}: ${state.clone} is not clean (${state.dirty.join("; ")}); commit or stash first`);
		}
		if (reasons.length > 0) return reasons;

		for (const [repo, state] of this.#repoStates) {
			if (!state.branchExists) {
				const answer = await this.#ask({
					cause: "missing-branch",
					title: `${repo}: branch ${state.ticket} does not exist`,
					detail: `The ticket branch ${state.ticket} is missing in ${state.clone}. No branch is created without asking.`,
					choices: [{ id: "create", label: `Create ${state.ticket} from ${state.base}` }, { id: "stop", label: "Stop" }],
					fallback: "stop",
				});
				if (answer.choice !== "create") return [`${repo}: the ticket branch ${state.ticket} does not exist`];
				git.createBranch(repo);
			}
			if (state.hook === "missing") {
				const answer = await this.#ask({
					cause: "missing-hook",
					title: `${repo}: the pre-push hook is not installed`,
					detail: `${state.clone} has no spec-guard pre-push hook for this plan. It runs the guard on every push, even one made outside the scheduler.`,
					choices: [{ id: "install", label: "Install the pre-push hook" }, { id: "stop", label: "Stop" }],
					fallback: "stop",
				});
				if (answer.choice !== "install") return [`${repo}: the pre-push hook is not installed`];
				try {
					git.installHook(repo);
				} catch (error) {
					return [`${repo}: the pre-push hook could not be installed: ${errorMessage(error)}`];
				}
			}
		}
		return [];
	}

	// ── Gates ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

	/** One gate at a time: two tasks asking together queue up. The answer is checked against the choices and logged. */
	#ask(request: Omit<GateRequest, "id">): Promise<Answered> {
		return this.#gates.run(async () => {
			this.#throwIfStopped();
			const id = `${this.#runId}-G${++this.#gateSeq}`;
			let answer: GateAnswer;
			try {
				answer = await this.#deps.gate.choose({ ...request, id }, this.#signal);
			} catch (error) {
				this.#throwIfStopped();
				throw error;
			}
			const chosen = request.choices.some(choice => choice.id === answer.choice) ? answer : { choice: request.fallback };
			this.#deps.log.append({
				kind: "gate",
				at: this.#now(),
				id,
				cause: request.cause,
				...(request.task === undefined ? {} : { task: request.task }),
				choice: chosen.choice,
				...(chosen.note ? { note: chosen.note } : {}),
			});
			this.#throwIfStopped();
			return { ...chosen, id };
		});
	}

	#block(tr: TaskRun, reason: string): void {
		if (!tr.durable) return;
		const attempts = tr.runs.tests + tr.runs.build;
		this.#deps.git.setTaskNote(tr.task.repo, tr.task.id, { v: 1, task: tr.task.id, plan_rev: this.#snapshot.rev, checks: {}, attempts, blocked: true, reason, at: this.#now() });
	}

	#unblock(tr: TaskRun): void {
		if (tr.durable) this.#deps.git.setTaskNote(tr.task.repo, tr.task.id, undefined);
	}

	/** A task cannot go on without a human. The blocked note is written first, so a restart during the gate sees it; a retry deletes it. */
	async #stopOrRetry(tr: TaskRun, cause: GateCause, reason: string, title: string, detail: string, choices: GateChoice[]): Promise<Answered> {
		this.#block(tr, reason);
		const answer = await this.#ask({ cause, task: tr.task.id, title: `${tr.task.id}: ${title}`, detail, choices, fallback: "stop" });
		if (answer.choice === "stop") throw new TaskBlocked(reason);
		this.#unblock(tr);
		if (answer.note) tr.notes.push(answer.note);
		return answer;
	}

	/** A stop verdict. Returns when the human chose to retry (with an optional note); throws `TaskBlocked` when they stopped the task. */
	async #stopVerdict(tr: TaskRun, verdict: StopVerdict, evidence: string): Promise<void> {
		const text = evidence.trim() === "" ? "(the slot gave no explanation)" : evidence;
		const retry: GateChoice = { id: "retry", label: "Retry now with a note", note: true };
		switch (verdict) {
			case "spec_wrong":
			case "need_clarification":
				await this.#stopOrRetry(tr, verdict, verdict, `${verdict}`, text, [{ ...STOP, label: "Stop this task (edit the plan, then rerun)" }, retry]);
				return;
			case "need_shared_change":
				await this.#stopOrRetry(tr, verdict, verdict, "needs a shared change", text, [{ ...STOP, label: "Stop this task (add a foundation task to the plan)" }]);
				return;
			case "blocked":
				await this.#stopOrRetry(tr, "blocked", "blocked", "blocked by tooling or the environment", text, [STOP, RETRY_ONCE]);
				return;
			case "test_wrong":
				throw new Error("test_wrong is handled by #testWrong");
		}
	}

	/** The implementer says a locked test is wrong. Only a human decision allows a new lock. */
	async #testWrong(tr: TaskRun, notes: string): Promise<{ unlock: boolean; gate: string }> {
		this.#block(tr, "test_wrong");
		const answer = await this.#ask({
			cause: "test_wrong",
			task: tr.task.id,
			title: `${tr.task.id}: the implementer says a locked test is wrong`,
			detail: notes.trim() === "" ? "(the slot gave no explanation)" : notes,
			choices: [
				{ id: "unlock", label: "Approve the unlock: rewrite the tests, review and lock them again" },
				{ id: "reject", label: "Reject: the tests stand, run the implementer again" },
				STOP,
			],
			fallback: "stop",
		});
		if (answer.choice === "stop") throw new TaskBlocked("test_wrong");
		this.#unblock(tr);
		return { unlock: answer.choice === "unlock", gate: answer.id };
	}

	/** An environment failure inside an operation. Returns when the human chose to retry it. */
	async #environment(tr: TaskRun, label: string, message: string): Promise<void> {
		await this.#stopOrRetry(tr, "blocked", "blocked", `${label} failed`, message, [STOP, RETRY_ONCE]);
	}

	/** The retry cap of a stage was reached. Returns when the human chose one more try. */
	async #cap(tr: TaskRun, what: string, detail: string): Promise<void> {
		await this.#stopOrRetry(tr, "cap", "cap", what, detail, [STOP, RETRY_ONCE]);
	}

	/** Runs an operation of the task's pipeline; a failure asks the human whether to retry it. */
	async #op<T>(tr: TaskRun, label: string, fn: () => T | Promise<T>): Promise<T> {
		for (;;) {
			this.#throwIfStopped();
			try {
				return await fn();
			} catch (error) {
				if (error instanceof RunStopped || error instanceof TaskBlocked) throw error;
				this.#throwIfStopped();
				await this.#environment(tr, label, errorMessage(error));
			}
		}
	}

	// ── Budget ────────────────────────────────────────────────────────────────────────────────────────────────────────────

	/** Before every slot: past the budget, the run finishes its in-flight slots, then asks. */
	async #checkpoint(): Promise<void> {
		this.#throwIfStopped();
		while (this.#spent >= this.#budget) {
			this.#budgetDecision ??= this.#decideBudget().finally(() => {
				this.#budgetDecision = undefined;
			});
			await this.#budgetDecision;
			this.#throwIfStopped();
		}
	}

	async #decideBudget(): Promise<void> {
		await this.#slotsIdle();
		if (this.#spent < this.#budget) return;
		this.#event("budget", undefined, `$${this.#spent.toFixed(4)} of $${this.#budget}`);
		const raise = DEFAULTS.budgetRaiseUsd;
		const answer = await this.#ask({
			cause: "budget",
			title: `The story budget is reached: $${this.#spent.toFixed(2)} of $${this.#budget}`,
			detail: "Every slot of the run costs money. In-flight slots have finished; nothing new starts until you decide.",
			choices: [{ id: "stop", label: "Stop the run" }, { id: "raise", label: `Raise the limit by $${raise}` }],
			fallback: "stop",
		});
		if (answer.choice === "raise") this.#budget += raise;
		else this.#requestStop("the story budget was reached");
	}

	#slotsIdle(): Promise<void> {
		if (this.#inFlight === 0) return Promise.resolve();
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#idleWaiters.push(resolve);
		return promise;
	}

	// ── Scheduling ────────────────────────────────────────────────────────────────────────────────────────────────────────

	async #loop(): Promise<void> {
		const running = new Map<string, Promise<void>>();
		for (;;) {
			if (!this.#signal.aborted) {
				const status = this.#status();
				this.#publish(status);
				const ready = status.tasks.filter(task => task.state === "ready" && !this.#begun.has(task.id));
				for (const { id } of ready) {
					if (running.size >= this.#concurrency || this.#signal.aborted) break;
					let proceed = false;
					try {
						proceed = await this.#planUnchanged();
					} catch (error) {
						if (!(error instanceof RunStopped)) throw error;
					}
					if (!proceed) break;
					const task = this.#plan.tasks.find(candidate => candidate.id === id);
					if (task === undefined || this.#begun.has(id) || this.#signal.aborted) continue;
					this.#begun.add(id);
					running.set(id, this.#runTask(task).finally(() => running.delete(id)));
				}
			}
			if (running.size === 0) return;
			await Promise.race(running.values());
		}
	}

	/** Checked before every task start: a plan edited or committed in the vault since the run began stops new starts and asks. */
	async #planUnchanged(): Promise<boolean> {
		if (this.#planChangeAccepted) return true;
		let why: string | undefined;
		try {
			const now = this.#deps.git.plan();
			if (now.rev !== this.#snapshot.rev) why = `a newer plan revision was committed (${now.rev.slice(0, 7)}, this run started on ${this.#snapshot.rev.slice(0, 7)})`;
			else if (!now.committed || now.text !== this.#snapshot.text) why = "plan.md has uncommitted edits in the vault";
		} catch (error) {
			why = `the plan can no longer be read: ${errorMessage(error)}`;
		}
		if (why === undefined) return true;
		this.#event("plan-changed", undefined, why);
		const answer = await this.#ask({
			cause: "plan-changed",
			title: "The plan changed in the vault while the run was going",
			detail: `${why}. Tasks already running keep the revision they started with. No new task starts until you decide.`,
			choices: [
				{ id: "stop", label: "Stop the run (rerun to use the new plan)" },
				{ id: "continue", label: "Keep running with the plan this run started with" },
			],
			fallback: "stop",
		});
		if (answer.choice === "continue") {
			this.#planChangeAccepted = true;
			return true;
		}
		this.#requestStop("the plan changed in the vault");
		return false;
	}

	// ── One task ──────────────────────────────────────────────────────────────────────────────────────────────────────────

	#newTaskRun(task: TaskBlock, durable = true): TaskRun {
		return {
			task,
			durable,
			testFiles: new Set(),
			lockedFiles: [],
			findings: [],
			notes: [],
			runs: { tests: 0, build: 0 },
			caps: { tests: this.#maxAttempts, build: this.#maxAttempts },
			slotRuns: {},
		};
	}

	async #runTask(task: TaskBlock): Promise<void> {
		const tr = this.#newTaskRun(task);
		this.#event("task-start", task.id);
		this.#activity.set(task.id, "starting");
		try {
			// The status said ready, so a task-key note can only be from another plan revision.
			if (this.#deps.git.taskNote(task.repo, task.id) !== undefined) this.#deps.git.setTaskNote(task.repo, task.id, undefined);
			tr.wt = await this.#op(tr, "creating the worktree", () => this.#deps.git.addWorktree(task.repo, task.id));
			await this.#testStage(tr, []);
			let seed: string[] = [];
			for (;;) {
				await this.#buildStage(tr, seed);
				const fix = await this.#integrate(tr);
				if (fix === undefined) break;
				seed = fix;
			}
			this.#outcomes.set(task.id, { state: "done", detail: "" });
			this.#event("task-done", task.id);
		} catch (error) {
			if (error instanceof RunStopped) {
				this.#outcomes.set(task.id, { state: "stopped", detail: error.message });
				this.#event("task-stopped", task.id, error.message);
			} else if (error instanceof TaskBlocked) {
				this.#outcomes.set(task.id, { state: "blocked", detail: error.cause });
				this.#event("task-blocked", task.id, error.cause);
			} else {
				this.#outcomes.set(task.id, { state: "error", detail: errorMessage(error) });
				this.#event("task-error", task.id, errorMessage(error));
			}
		} finally {
			this.#activity.delete(task.id);
			this.#publish();
			if (tr.wt) this.#removeWorktree(tr.wt);
		}
	}

	#removeWorktree(wt: Worktree): void {
		try {
			this.#deps.git.removeWorktree(wt);
		} catch (error) {
			this.#event("cleanup-failed", wt.task, errorMessage(error));
		}
	}

	/** Steps 2 to 4: tests first, the fails-before check, the test review, the lock. */
	async #testStage(tr: TaskRun, seed: string[]): Promise<void> {
		const { task } = tr;
		const wt = this.#worktree(tr);
		const slot = task.size === "small" ? "implementer" : "test_author";
		const command = this.#plan.checks[task.repo]?.test_files ?? "";
		let reviewFixes = 0;
		tr.findings = seed;
		for (;;) {
			if (tr.runs.tests >= tr.caps.tests) {
				await this.#cap(tr, "the tests did not pass their checks", `${slot} ran ${tr.runs.tests} times without tests that fail before the work and pass the review.\n${tr.findings.join("\n")}`);
				tr.caps.tests++;
			}
			const out = await this.#runSlot(tr, slot, { wd: wt, phase: "tests", findings: tr.findings, attempt: { n: tr.runs.tests + 1, of: tr.caps.tests } });
			tr.runs.tests++;
			if (out.kind === "retry") {
				tr.findings = [out.reason];
				continue;
			}
			const { value } = out;
			if (value.verdict === "test_wrong") {
				tr.findings = ["`test_wrong` is for locked tests, and none are locked while the tests are written. Report spec_wrong or need_clarification when the criteria are the problem."];
				continue;
			}
			if (value.verdict !== "pass") {
				await this.#stopVerdict(tr, value.verdict, value.notes);
				tr.runs.tests--;
				continue;
			}

			const committed = await this.#op(tr, "committing the tests", () =>
				this.#deps.git.commit(wt, { task: task.id, planRev: this.#snapshot.rev, subject: `test(${task.id}): tests for ${task.id}` }),
			);
			if (committed === undefined) {
				tr.findings = ["You reported `pass` but wrote no file. Write the tests."];
				continue;
			}
			for (const file of committed.files) if (isTestPath(file, this.#plan.checks[task.repo])) tr.testFiles.add(file);
			for (const file of committed.deleted) tr.testFiles.delete(file);
			const files = [...tr.testFiles];
			if (files.length === 0) {
				tr.findings = ["The tests commit left no test file. Write the tests."];
				continue;
			}

			const before = await this.#op(tr, "the fails-before check", () => this.#deps.checks.failsBefore(wt, committed.sha, files, command));
			this.#event("fails-before", task.id, before.files.map(file => `${file.file}: ${file.status}`).join(", "));
			if (!before.ok) {
				tr.findings = before.files
					.filter(file => file.status === "already-passes")
					.map(file => `${file.file} passes on the base commit, before the work is done, so it proves nothing. Make it fail without the feature.\n${tail(file.output)}`);
				continue;
			}

			if (task.size === "normal") {
				const review = await this.#review(tr, "test_review", { wd: wt, tasks: [task] });
				if (review.verdict === "spec_wrong") {
					await this.#stopVerdict(tr, "spec_wrong", review.findings.join("\n"));
					tr.findings = review.findings;
					continue;
				}
				if (review.verdict === "fix") {
					tr.findings = [...review.findings, ...review.unmapped.map(criterion => `not covered by any test: ${criterion}`)];
					if (++reviewFixes >= 2) {
						await this.#cap(tr, "the test review asked for fixes twice", tr.findings.join("\n"));
						reviewFixes = 1;
					}
					continue;
				}
			}
			await this.#op(tr, "the lock commit", () => this.#deps.git.lock(wt, { task: task.id, planRev: this.#snapshot.rev, files }));
			tr.lockedFiles = files;
			tr.findings = [];
			return;
		}
	}

	/** Steps 5 to 7: the implementer, the code checks, the reviews. */
	async #buildStage(tr: TaskRun, seed: string[]): Promise<void> {
		const { task } = tr;
		const wt = this.#worktree(tr);
		tr.findings = seed;
		for (;;) {
			if (tr.runs.build >= tr.caps.build) {
				await this.#cap(tr, "the implementation did not pass", `implementer ran ${tr.runs.build} times.\n${tr.findings.join("\n")}`);
				tr.caps.build++;
			}
			const out = await this.#runSlot(tr, "implementer", {
				wd: wt,
				phase: "implement",
				findings: tr.findings,
				lockedFiles: tr.lockedFiles,
				attempt: { n: tr.runs.build + 1, of: tr.caps.build },
			});
			tr.runs.build++;
			if (out.kind === "retry") {
				tr.findings = [out.reason];
				continue;
			}
			const { value } = out;
			if (value.verdict === "test_wrong") {
				const decision = await this.#testWrong(tr, value.notes);
				tr.runs.build--;
				if (!decision.unlock) {
					tr.findings = ["A human reviewed your test_wrong report and rejected it: the locked tests stand. Implement to satisfy them as written."];
					continue;
				}
				await this.#op(tr, "the unlock commit", () => this.#deps.git.unlock(wt, { task: task.id, planRev: this.#snapshot.rev, gate: decision.gate }));
				tr.lockedFiles = [];
				tr.runs.tests = 0;
				tr.caps.tests = this.#maxAttempts;
				await this.#testStage(tr, [`The implementer reported that the locked tests are wrong, and a human approved rewriting them: ${value.notes}`]);
				tr.runs.build = 0;
				tr.caps.build = this.#maxAttempts;
				tr.findings = [];
				continue;
			}
			if (value.verdict !== "pass") {
				await this.#stopVerdict(tr, value.verdict, value.notes);
				tr.runs.build--;
				continue;
			}

			const committed = await this.#op(tr, "committing the implementation", () =>
				this.#deps.git.commit(wt, { task: task.id, planRev: this.#snapshot.rev, subject: `feat(${task.id}): implement ${task.id} (attempt ${tr.runs.build})` }),
			);
			if (committed === undefined) {
				tr.findings = ["You reported `pass` but changed no file."];
				continue;
			}
			const report = await this.#op(tr, "the checks", () => this.#deps.checks.check(wt, committed.sha));
			this.#event("check", task.id, `${report.ok ? "pass" : "fail"}: ${Object.entries(report.note.checks).map(([name, status]) => `${name} ${status}`).join(", ")}`);
			if (!report.ok) {
				tr.findings = failureLines(report);
				continue;
			}
			tr.report = report;

			// A review that did not pass never lets the task land. After a human retried a `spec_wrong`, the implementer and the review run
			// again, whether or not the reviewer listed anything.
			let rerun: string[] | undefined;
			for (const slot of reviewsFor(task)) {
				const review = await this.#review(tr, slot, { wd: wt, tasks: [task], diff: this.#diff(wt, wt.startTip) });
				// A patient-data finding is a human decision before anything else: no implementer rerun, no integration. A `spec_wrong`
				// verdict keeps its own gate, which lists the findings.
				if (slot === "security_review" && review.verdict !== "spec_wrong" && review.findings.some(finding => finding.category === "patient_data")) {
					const fix = await this.#patientData(tr, wt, review.findings);
					if (fix === undefined) continue;
					rerun = fix;
					break;
				}
				if (review.verdict === "pass") continue;
				const lines = findingLines(review.findings);
				if (review.verdict === "spec_wrong") await this.#stopVerdict(tr, "spec_wrong", lines.join("\n"));
				rerun = lines.length > 0 ? lines : [`The ${slot} ended with ${review.verdict}, but the reviewer gave no findings. Address the human's note, then the review runs again.`];
				break;
			}
			if (rerun !== undefined) {
				tr.findings = rerun;
				continue;
			}
			return;
		}
	}

	/**
	 * A security review found patient data. Code never fixes or accepts it: the task is held and a human chooses. `fix` hands every finding
	 * to the implementer (counts toward the cap) and the review runs again; `accept`, offered only when every finding is `patient_data`,
	 * records the decision in an empty accept commit and checks it; `stop` (also a dismissed dialog) keeps the task's commits under
	 * `refs/spec-conflict/<ticket>/<task>` and blocks it. Returns what the implementer must fix, or undefined once accepted and checked.
	 */
	async #patientData(tr: TaskRun, wt: Worktree, findings: readonly Finding[]): Promise<string[] | undefined> {
		const { task } = tr;
		const lines = findingLines(findings);
		const ref = await this.#op(tr, "keeping the commits", () => this.#deps.git.keep(wt));
		this.#block(tr, "patient_data");
		const choices: GateChoice[] = [{ id: "fix", label: "Fix: the implementer gets every finding, then the review runs again", note: true }];
		if (findings.every(finding => finding.category === "patient_data")) choices.push({ id: "accept", label: "Accept: keep it, and record the decision on the branch" });
		choices.push({ id: "stop", label: `Stop this task (its commits are kept as ${ref})` });
		const answer = await this.#ask({
			cause: "patient_data",
			task: task.id,
			title: `${task.id}: the security review found patient data`,
			detail: `${lines.join("\n")}\n\nThe task's commits so far are kept as ${ref}. Nothing is integrated until you decide.`,
			choices,
			fallback: "stop",
		});
		if (answer.choice === "stop") throw new TaskBlocked("patient_data");
		this.#unblock(tr);
		if (answer.note) tr.notes.push(answer.note);
		if (answer.choice === "fix") return lines;

		const sha = await this.#op(tr, "the accept commit", () => this.#deps.git.accept(wt, { task: task.id, planRev: this.#snapshot.rev, gate: answer.id }));
		this.#event("accept", task.id, `${answer.id} ${sha.slice(0, 7)}`);
		const report = await this.#op(tr, "the checks", () => this.#deps.checks.check(wt, sha));
		this.#event("check", task.id, `${report.ok ? "pass" : "fail"} on the accept commit`);
		if (!report.ok) return failureLines(report);
		tr.report = report;
		return undefined;
	}

	#worktree(tr: TaskRun): Worktree {
		if (tr.wt === undefined) throw new Error(`task ${tr.task.id} has no worktree`);
		return tr.wt;
	}

	#diff(at: Workdir, from: string): { text: string; from: string } {
		return { text: this.#deps.git.diff(at, from), from };
	}

	/** Runs a read-only slot until it yields a valid verdict; failed runs are retried up to the cap, then the human decides. */
	async #review<S extends "test_review" | "code_review" | "security_review">(tr: TaskRun, slot: S, extra: SlotExtra): Promise<SlotVerdicts[S]> {
		let failures = 0;
		let findings: string[] = [];
		for (;;) {
			const out = await this.#runSlot(tr, slot, { ...extra, findings });
			if (out.kind === "verdict") return out.value;
			findings = [out.reason];
			if (++failures >= this.#maxAttempts) {
				await this.#cap(tr, `the ${slot} slot failed ${failures} times`, out.reason);
				failures = this.#maxAttempts - 1;
			}
		}
	}

	/**
	 * Step 8: replay the task's commits on the ticket tip, check the replayed tree, guard the new range, note it, move the ticket branch. One
	 * task at a time. Returns what the implementer must fix when the replayed tip fails its checks (the worktree is then adopted at the
	 * replayed commits, and the failure counts as a build attempt), or undefined once the task has landed.
	 */
	async #integrate(tr: TaskRun): Promise<string[] | undefined> {
		const { task } = tr;
		this.#activity.set(task.id, "integrating");
		for (;;) {
			this.#throwIfStopped();
			const wt = this.#worktree(tr);
			const result = await this.#integrations.run((): Promise<Integration> => this.#tryIntegrate(tr, wt));
			switch (result.kind) {
				case "published":
					return undefined;
				case "error":
					await this.#environment(tr, "integration", result.message);
					continue;
				case "checks":
					tr.wt = await this.#op(tr, "adopting the replayed commits", () => this.#deps.git.adopt(wt, result.picked));
					tr.report = undefined;
					tr.runs.build++;
					return [`The checks fail on the ticket branch after your commits were replayed on its current tip (${result.picked.from.slice(0, 7)}): another task landed first and the two do not work together. Your worktree now holds the replayed commits; fix it.`, ...result.lines];
				case "conflict": {
					const ref = await this.#op(tr, "keeping the conflicting commits", () => this.#deps.git.keep(wt));
					this.#block(tr, "conflict");
					await this.#ask({
						cause: "conflict",
						task: task.id,
						title: `${task.id}: its commits conflict with the ticket branch`,
						detail: `${result.detail}\n\nThe task's commits are kept as ${ref} (made on ${wt.startTip}). Resolve by hand: git cherry-pick ${wt.startTip}..${ref}\nDelete the ref when you are done with it.`,
						choices: [{ ...STOP, label: `Stop this task (resolve by hand from ${ref})` }],
						fallback: "stop",
					});
					throw new TaskBlocked("conflict");
				}
				case "guard":
					this.#block(tr, "guard");
					await this.#ask({
						cause: "guard",
						task: task.id,
						title: `${task.id}: the guard rejects its commits on the ticket branch`,
						detail: result.violations.map(formatViolation).join("\n"),
						choices: [STOP],
						fallback: "stop",
					});
					throw new TaskBlocked("guard");
			}
		}
	}

	async #tryIntegrate(tr: TaskRun, wt: Worktree): Promise<Integration> {
		try {
			const report = tr.report;
			if (report === undefined) throw new Error(`task ${tr.task.id} reached the integration without a passing check`);
			const picked = await this.#deps.git.integrate(wt);
			if (!picked.ok) {
				this.#event("conflict", tr.task.id, picked.conflict);
				return { kind: "conflict", detail: picked.conflict };
			}
			// The commits sit on a ticket tip they were not checked on: the replayed tip is its own tree, so it gets its own check run,
			// inside this mutex so that nothing lands between the check and the publish.
			let note = report.note;
			if (picked.from !== wt.startTip) {
				const replayed = await this.#deps.checks.check(wt, picked.to);
				this.#event("check", tr.task.id, `replayed on ${picked.from.slice(0, 7)}, ${replayed.ok ? "pass" : "fail"}: ${Object.entries(replayed.note.checks).map(([name, status]) => `${name} ${status}`).join(", ")}`);
				if (!replayed.ok) return { kind: "checks", lines: failureLines(replayed), picked };
				note = replayed.note;
			}
			const violations = await this.#deps.checks.guard(tr.task.repo, picked.from, picked.to);
			if (violations.length > 0) return { kind: "guard", violations };
			this.#deps.git.writeNote(tr.task.repo, picked.to, { ...note, checks: { ...note.checks, guard: "pass" }, at: this.#now() });
			this.#deps.git.publish(wt, picked);
			this.#event("integrated", tr.task.id, `${picked.from.slice(0, 7)}..${picked.to.slice(0, 7)}`);
			return { kind: "published" };
		} catch (error) {
			return { kind: "error", message: errorMessage(error) };
		}
	}

	// ── Story end ─────────────────────────────────────────────────────────────────────────────────────────────────────────

	/** One code review per repo over the whole ticket diff, with a gate on its findings. Nothing is pushed. */
	async #storyReview(): Promise<void> {
		for (const repo of this.#repos()) {
			const tr = this.#newTaskRun(storyTask(repo), false);
			const tasks = this.#plan.tasks.filter(task => task.repo === repo);
			this.#activity.set("story", "reviewing");
			try {
				tr.wt = await this.#op(tr, "creating the review worktree", () => this.#deps.git.addWorktree(repo, STORY_WORKTREE));
				const base = this.#repoStates.get(repo)?.base ?? "HEAD";
				const review = await this.#review(tr, "code_review", { wd: tr.wt, tasks, scope: "story", diff: this.#diff(tr.wt, base) });
				if (review.verdict === "pass") continue;
				const answer = await this.#ask({
					cause: "review",
					title: `${repo}: the story review found problems`,
					detail: findingLines(review.findings).join("\n"),
					choices: [
						{ id: "accept", label: "Accept: leave the findings for the pull request review" },
						{ id: "stop", label: "Stop: fix them by hand, then rerun" },
					],
					fallback: "stop",
				});
				if (answer.choice !== "accept") this.#reviewOpen.push(repo);
			} catch (error) {
				if (error instanceof TaskBlocked) this.#reviewOpen.push(repo);
				else throw error;
			} finally {
				this.#activity.delete("story");
				if (tr.wt) this.#removeWorktree(tr.wt);
			}
		}
	}

	// ── One slot run ──────────────────────────────────────────────────────────────────────────────────────────────────────

	/**
	 * One slot run: budget checkpoint, prompt, the runner under the wall timeout and the run's stop signal, the cost added up, and the
	 * result judged. A run that was aborted, rejected by the watch (git moved, a file outside the scope or a locked one changed) or
	 * invalid against its schema is a failed attempt (`retry`); anything but a `pass` verdict leaves the worktree as it was.
	 */
	async #runSlot<S extends SlotName>(tr: TaskRun, slot: S, extra: SlotExtra): Promise<SlotOutcome<S>> {
		await this.#checkpoint();
		const def = SLOTS[slot];
		const task = tr.task;
		const tasks = extra.tasks ?? [task];
		const attempt = (tr.slotRuns[slot] = (tr.slotRuns[slot] ?? 0) + 1);
		const lld = tasks.length === 1 ? tasks[0].lld?.trim() : undefined;
		const repoChecks = this.#plan.checks[task.repo];
		const spec: SlotSpec = {
			slot,
			task: { id: task.id, repo: task.repo },
			story: this.#plan.id,
			cwd: extra.wd.dir,
			prompt: buildPrompt({
				slot,
				story: this.#plan.id,
				tasks,
				...(extra.scope === undefined ? {} : { scope: extra.scope }),
				planFile: this.#snapshot.file,
				planRev: this.#snapshot.rev,
				cwd: extra.wd.dir,
				...(extra.phase === undefined ? {} : { phase: extra.phase }),
				lockedFiles: extra.lockedFiles ?? [],
				testFiles: [...tr.testFiles],
				...(extra.attempt === undefined ? {} : { attempt: extra.attempt }),
				findings: extra.findings ?? [],
				notes: tr.notes,
				...(extra.diff === undefined ? {} : { diff: extra.diff }),
				...(this.#plan.checks[task.repo] === undefined ? {} : { checks: this.#plan.checks[task.repo] }),
				...(lld === undefined || lld === "" ? {} : { lldFile: path.isAbsolute(lld) ? lld : path.join(this.#snapshot.root, lld) }),
			}),
			writeScope: def.writes === "scope" ? [...task.owns, ...task.new_paths] : [],
			lockedFiles: [...(extra.lockedFiles ?? [])],
			...(extra.phase === "tests" ? { testsOnly: true, ...(repoChecks?.test_paths === undefined ? {} : { testPaths: [...repoChecks.test_paths] }) } : {}),
			schema: def.schema,
			modelRole: def.modelRole,
			thinkingLevel: def.thinkingLevel,
			agent: def.agent,
			maxContextTokens: this.#opts.maxContextTokens ?? DEFAULTS.maxContextTokens,
		};

		const watch = this.#deps.git.watch(extra.wd);
		const started = this.#deps.now().getTime();
		this.#activity.set(task.id, `${slot}${attempt > 1 ? ` (run ${attempt})` : ""}`);
		this.#publish();
		const timeout = AbortSignal.timeout(this.#opts.slotTimeoutMs ?? DEFAULTS.slotTimeoutMs);
		const result = await this.#op(tr, `the ${slot} slot`, () => this.#callRunner(spec, timeout));
		this.#spent += result.costUsd;
		this.#slotRuns++;

		const log = (outcome: "verdict" | "invalid" | "aborted" | "rejected", detail?: string, verdict?: string): void => {
			this.#deps.log.append({
				kind: "slot",
				at: this.#now(),
				task: task.id,
				slot,
				attempt,
				outcome,
				...(verdict === undefined ? {} : { verdict }),
				costUsd: result.costUsd,
				contextTokens: result.contextTokens,
				durationMs: this.#deps.now().getTime() - started,
				...(result.sessionFile === undefined ? {} : { sessionFile: result.sessionFile }),
				...(result.agentId === undefined ? {} : { agentId: result.agentId }),
				...(detail === undefined ? {} : { detail }),
			});
		};

		if (this.#signal.aborted) {
			log("aborted", "the run was stopped");
			throw new RunStopped(this.#stopReason ?? "stopped");
		}
		// A discard that fails (a hook or the config could not be put back) is an environment failure for the human: the run never goes on
		// over a clone it could not restore.
		const discard = (): Promise<void> => this.#op(tr, "restoring the clone after a slot", () => watch.discard());
		if (result.aborted !== undefined) {
			const timeoutMs = this.#opts.slotTimeoutMs ?? DEFAULTS.slotTimeoutMs;
			const limit = timeoutMs >= 60_000 ? `${Math.round(timeoutMs / 60_000)} minute` : `${Number((timeoutMs / 1000).toFixed(2))} second`;
			const why =
				result.aborted === "context"
					? `The slot passed the ${spec.maxContextTokens} token context ceiling and was stopped. Work in smaller steps and read less.`
					: `The slot ran past the ${limit} wall timeout and was stopped.`;
			await discard();
			log("aborted", why);
			return { kind: "retry", reason: why };
		}
		const only = spec.testsOnly ? (file: string): boolean => isTestPath(file, repoChecks) : undefined;
		const violations = watch.violations(spec.writeScope, spec.lockedFiles, only);
		if (violations.length > 0) {
			await discard();
			log("rejected", violations.join("; "));
			return { kind: "retry", reason: `Your previous run was rejected and its changes were discarded: ${violations.join("; ")}` };
		}
		const parsed = parseVerdict(slot, result.payload);
		if (!parsed.ok) {
			await discard();
			const why = result.error === undefined ? parsed.error : `${parsed.error} (${result.error})`;
			log("invalid", why);
			return { kind: "retry", reason: `Your previous reply was not a valid verdict: ${why}. Finish by calling yield with the verdict shape from the prompt.` };
		}
		if (parsed.value.verdict !== "pass") await discard();
		log("verdict", undefined, parsed.value.verdict);
		return { kind: "verdict", value: parsed.value };
	}

	/** Calls the runner under the stop signal and the wall timeout. A runner that ignores both is left behind after a grace period. */
	async #callRunner(spec: SlotSpec, timeout: AbortSignal): Promise<SlotResult> {
		const signal = AbortSignal.any([this.#signal, timeout]);
		this.#inFlight++;
		const running = this.#deps.slots.run(spec, signal);
		running.catch(() => undefined);
		const { promise: abandoned, resolve } = Promise.withResolvers<SlotResult>();
		let timer: Timer | undefined;
		const onAbort = (): void => {
			timer = setTimeout(() => resolve({ payload: undefined, costUsd: 0, contextTokens: 0, aborted: "signal", error: "the runner did not stop after its signal fired" }), this.#opts.abortGraceMs ?? DEFAULTS.abortGraceMs);
		};
		if (signal.aborted) onAbort();
		else signal.addEventListener("abort", onAbort, { once: true });
		try {
			return await Promise.race([running, abandoned]);
		} finally {
			clearTimeout(timer);
			signal.removeEventListener("abort", onAbort);
			if (--this.#inFlight === 0) for (const wake of this.#idleWaiters.splice(0)) wake();
		}
	}
}

/**
 * Runs the plan the vault holds to the end, or as far as it can go. Each start recomputes every task's state from git (the plan, the
 * `Task:` trailers, the check notes and the blocked notes), so the run can be stopped and started again at any time; leftovers of an
 * earlier run (`spec-wt/<ticket>/*`) are removed first. A task starts when its state is `ready`, with at most `concurrency` at once;
 * a blocked task stops its dependants. Never pushes, never writes to the vault.
 */
export function runPlan(deps: SchedulerDeps, opts: RunOptions = {}): Promise<RunSummary> {
	return new Run(deps, opts).execute();
}
