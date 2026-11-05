import { describe, expect, test } from "bun:test";
import type { CheckReport, FailsBeforeResult } from "./spec-check";
import { planText } from "./spec-fixtures";
import type { CheckNote, TaskCommit } from "./spec-git";
import { inScope } from "./spec-guard";
import type { GuardViolation } from "./spec-guard";
import { parsePlan } from "./spec-plan";
import type { RunLogEntry } from "./spec-runlog";
import {
	type CheckOps,
	type Gate,
	type GateAnswer,
	type GateRequest,
	type GitOps,
	type PlanSnapshot,
	type RunOptions,
	type RunSummary,
	type Worktree,
	RunLocked,
	runPlan,
	statusFromGit,
} from "./spec-scheduler";
import type { SlotName, SlotResult, SlotRunner, SlotSpec } from "./spec-slots";

// ── The fake world: an in-memory repo whose whole state is plain data, so a crash is a structuredClone ─────────────────────────

interface FCommit {
	sha: string;
	tasks: string[];
	locks: string[];
	unlocks: string[];
	files: string[];
}
interface FWt {
	task: string;
	dir: string;
	startTip: string;
	commits: FCommit[];
	pending: Set<string>;
	moved: string[];
	candidate: FCommit[] | undefined;
}
interface State {
	branchExists: boolean;
	clean: boolean;
	hook: boolean;
	ticket: FCommit[];
	notes: Map<string, CheckNote>;
	taskNotes: Map<string, CheckNote>;
	wts: Map<string, FWt>;
	planText: string;
	planRev: string;
	committed: boolean;
	seq: number;
	attempts: Map<string, number>;
	/** Conflict refs by name: the commits they keep. */
	kept: Map<string, string[]>;
	/** The mutating operations, slot runs and checks in the order they happened. */
	ops: string[];
}

const REPO = "org/backend";
const lower = (id: string): string => id.toLowerCase();

interface TaskSpec {
	id: string;
	deps?: string[];
	size?: "small";
	/** `retries` risk: a code review per task. */
	risky?: boolean;
	/** `sensitive_data` risk and `security_review`. */
	secure?: boolean;
}

/** Edits the first `yaml task` block that carries `id`. */
function patch(text: string, id: string, edits: Array<[string, string]>): string {
	const parts = text.split("```yaml task");
	return parts.map(part => (part.startsWith(`\nid: ${id}\n`) ? edits.reduce((out, [from, to]) => out.replace(from, to), part) : part)).join("```yaml task");
}

function planFor(tasks: TaskSpec[], checks: Record<string, string | string[]> = { test: "true", test_files: "sh {files}", test_paths: ["t/**"] }): string {
	let text = planText({
		tasks: tasks.map(task => ({ id: task.id, depends_on: task.deps ?? [], new_paths: [`src/${lower(task.id)}.ts`, `t/${lower(task.id)}.sh`] })),
		checks: { [REPO]: checks },
	});
	for (const task of tasks) {
		if (task.size) text = patch(text, task.id, [[`id: ${task.id}\n`, `id: ${task.id}\nsize: small\n`]]);
		if (task.risky) {
			text = patch(text, task.id, [
				["retries: {value: no}", 'retries: {value: yes, reason: "r"}'],
				["lld_required: false", "lld_required: true\nlld_skip_reason: mechanical"],
				["required_tests: []", 'required_tests: ["duplicate-request"]'],
			]);
		}
		if (task.secure) {
			text = patch(text, task.id, [
				["sensitive_data: {value: no}", 'sensitive_data: {value: yes, reason: "pii"}'],
				["security_review: false", "security_review: true"],
			]);
		}
	}
	return text;
}

function freshState(text: string): State {
	return {
		branchExists: true, clean: true, hook: true, ticket: [], notes: new Map(), taskNotes: new Map(), wts: new Map(), planText: text, planRev: "rev1", committed: true,
		seq: 0, attempts: new Map(), kept: new Map(), ops: [],
	};
}

type CheckScript = "pass" | "fail" | "ok-with-violation";

class World {
	constructor(public state: State) {}
	/** Called at the start of every recorded operation; the crash tests snapshot the state here. */
	hook: ((op: string) => void) | undefined;
	events: string[] = [];
	integrating = 0;
	maxIntegrating = 0;
	delays: { integrate: number } = { integrate: 0 };
	failing = new Set<string>();
	conflicts = new Set<string>();
	/** Every check run: the task and the commit it ran on. */
	checked: Array<{ task: string; sha: string }> = [];
	/** The next check of a replayed commit fails once. */
	failNextReplayed = false;
	/** The next discards fail this many times (the git dir could not be restored). */
	discardFailures = 0;
	discards = 0;
	/** Repos whose run lock this run holds. */
	held = new Set<string>();
	/** Another run holds the lock: the holder `acquire` reports. */
	heldBy: { pid: number; host: string; startedAt: string } | undefined;
	/** `acquire` took over the lock of a dead process. */
	staleHolder: { pid: number; host: string; startedAt: string } | undefined;
	op(name: string): void {
		this.state.ops.push(name);
		this.hook?.(name);
	}
	sha(prefix: string): string {
		return `${prefix}${String(++this.state.seq).padStart(4, "0")}`;
	}
	tip(): string {
		return this.state.ticket.at(-1)?.sha ?? "base";
	}
	wtOf(dir: string): FWt {
		const found = [...this.state.wts.values()].find(wt => wt.dir === dir);
		if (!found) throw new Error(`no fake worktree at ${dir}`);
		return found;
	}
}

/** Real timers on purpose: the wall timeout, the abort grace and the overlap of parallel slots are what these tests exercise. */
function sleep(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

function fakeGit(world: World): GitOps {
	const s = world.state;
	const handle = (wt: FWt): Worktree => ({ repo: REPO, dir: wt.dir, task: wt.task, branch: `spec-wt/PAC-1/${wt.task}`, startTip: wt.startTip });
	return {
		plan: (): PlanSnapshot => ({ rev: s.planRev, text: s.planText, committed: s.committed, file: "/vault/Specs/S/plan.md", root: "/vault" }),
		files: () => ["src/a.ts", "src/b.ts"],
		inspect: () => ({ ticket: "PAC-1", base: "main", clone: "/clone", branchExists: s.branchExists, clean: s.clean, dirty: s.clean ? [] : [" M src/a.ts"], hook: s.hook ? "installed" : "missing" }),
		createBranch() {
			world.op("createBranch");
			s.branchExists = true;
		},
		installHook() {
			world.op("installHook");
			s.hook = true;
		},
		cleanup() {
			world.op("cleanup");
			const removed = [...s.wts.keys()].map(task => `spec-wt/PAC-1/${task}`);
			s.wts.clear();
			return removed;
		},
		commits: (): TaskCommit[] => s.ticket.map(commit => ({ sha: commit.sha, tasks: commit.tasks, locks: commit.locks })),
		note: (_repo, sha) => s.notes.get(sha),
		taskNote: (_repo, task) => s.taskNotes.get(task),
		setTaskNote(_repo, task, note) {
			world.op(`setTaskNote ${task} ${note ? note.reason : "clear"}`);
			if (note) s.taskNotes.set(task, note);
			else s.taskNotes.delete(task);
		},
		addWorktree(_repo, name) {
			world.op(`addWorktree ${name}`);
			if (s.wts.has(name)) throw new Error(`worktree ${name} already exists`);
			const wt: FWt = { task: name, dir: `/wt/${name}`, startTip: world.tip(), commits: [], pending: new Set(), moved: [], candidate: undefined };
			s.wts.set(name, wt);
			return handle(wt);
		},
		removeWorktree(wt) {
			world.op(`removeWorktree ${wt.task}`);
			s.wts.delete(wt.task);
		},
		watch(at) {
			const wt = world.wtOf(at.dir);
			return {
				violations: (scope, locked, only) => [
					...wt.moved,
					...[...wt.pending].flatMap(file => {
						if (locked.includes(file)) return [`${file} is a locked test`];
						if (!inScope(file, scope)) return [`${file} is outside the write scope`];
						return only !== undefined && !only(file) ? [`${file} is not a test file`] : [];
					}),
				],
				discard() {
					world.discards++;
					if (world.discardFailures > 0) {
						world.discardFailures--;
						throw new Error("could not restore the git dir: hooks/pre-push still differs from the baseline");
					}
					wt.pending.clear();
					wt.moved = [];
				},
			};
		},
		commit(wt, { task, subject }) {
			world.op(`commit ${wt.task} ${subject.split(":")[0]}`);
			const fw = world.wtOf(wt.dir);
			if (fw.pending.size === 0) return undefined;
			const files = [...fw.pending];
			fw.commits.push({ sha: world.sha("c"), tasks: [task], locks: [], unlocks: [], files });
			fw.pending.clear();
			return { sha: fw.commits.at(-1)!.sha, files, deleted: [] };
		},
		lock(wt, { task, files }) {
			world.op(`lock ${wt.task}`);
			const fw = world.wtOf(wt.dir);
			fw.commits.push({ sha: world.sha("l"), tasks: [task], locks: [task], unlocks: [], files });
			return fw.commits.at(-1)!.sha;
		},
		unlock(wt, { task }) {
			world.op(`unlock ${wt.task}`);
			const fw = world.wtOf(wt.dir);
			fw.commits.push({ sha: world.sha("u"), tasks: [task], locks: [], unlocks: [task], files: [] });
			return fw.commits.at(-1)!.sha;
		},
		diff: (at, from) => `diff of ${at.dir} since ${from}`,
		async integrate(wt) {
			world.op(`integrate ${wt.task}`);
			world.integrating++;
			world.maxIntegrating = Math.max(world.maxIntegrating, world.integrating);
			try {
				if (world.delays.integrate > 0) await sleep(world.delays.integrate);
				const fw = world.wtOf(wt.dir);
				if (world.conflicts.has(wt.task)) return { ok: false, conflict: "CONFLICT (content): Merge conflict in src/a.ts" };
				const from = world.tip();
				fw.candidate = from === fw.startTip ? fw.commits : fw.commits.map(commit => ({ ...commit, sha: world.sha("p") }));
				return { ok: true, from, to: fw.candidate.at(-1)!.sha };
			} finally {
				world.integrating--;
			}
		},
		writeNote(_repo, sha, note) {
			world.op(`writeNote ${note.task}`);
			s.notes.set(sha, note);
		},
		publish(wt, { from }) {
			world.op(`publish ${wt.task}`);
			if (world.tip() !== from) throw new Error(`the ticket moved: ${world.tip()} is not ${from}`);
			s.ticket.push(...(world.wtOf(wt.dir).candidate ?? []));
		},
		adopt(wt, { from }) {
			world.op(`adopt ${wt.task}`);
			const fw = world.wtOf(wt.dir);
			fw.commits = fw.candidate ?? fw.commits;
			fw.candidate = undefined;
			fw.startTip = from;
			return handle(fw);
		},
		keep(wt) {
			world.op(`keep ${wt.task}`);
			const ref = `refs/spec-conflict/PAC-1/${wt.task}`;
			s.kept.set(ref, world.wtOf(wt.dir).commits.map(commit => commit.sha));
			return ref;
		},
		acquire(repo) {
			if (world.heldBy !== undefined) throw new RunLocked("/clone/.git/spec-run-PAC-1.lock", world.heldBy);
			world.held.add(repo);
			const tookOver = world.staleHolder;
			return { release: () => void world.held.delete(repo), ...(tookOver === undefined ? {} : { tookOver }) };
		},
	};
}

function fakeChecks(world: World, script: { fails: FailsBeforeResult[]; checks: CheckScript[]; guards: GuardViolation[][] }): CheckOps {
	return {
		async failsBefore(wt, _sha, files) {
			world.op(`failsBefore ${wt.task}`);
			return script.fails.shift() ?? { ok: true, base: "b", files: files.map(file => ({ file, status: "fails", output: "" })) };
		},
		async check(wt, sha): Promise<CheckReport> {
			world.op(`check ${wt.task}`);
			world.checked.push({ task: wt.task, sha });
			const replayedFails = sha.startsWith("p") && world.failNextReplayed;
			if (replayedFails) world.failNextReplayed = false;
			const verdict = world.failing.has(wt.task) || replayedFails ? "fail" : (script.checks.shift() ?? "pass");
			const attempts = (world.state.attempts.get(wt.task) ?? 0) + 1;
			world.state.attempts.set(wt.task, attempts);
			const bad = verdict === "fail";
			const note: CheckNote = {
				v: 1, task: wt.task, plan_rev: world.state.planRev, checks: { test: bad ? "fail" : "pass", typecheck: "pass", lint: "skip", guard: "pass" },
				attempts, blocked: false, reason: "", at: "2026-11-04T05:00:00.000Z",
			};
			world.state.notes.set(sha, note);
			return { sha, task: wt.task, attempts, results: [{ name: "test", status: bad ? "fail" : "pass", ...(bad ? { reason: "exit 1" } : {}), output: bad ? "2 tests failed: expected 2" : "", ms: 1 }], violations: [], note, ok: !bad };
		},
		guard(_repo, from, to) {
			world.op(`guard ${from}..${to}`.replace(/\d+/g, "#"));
			return script.guards.shift() ?? [];
		},
	};
}

// ── Scripted slot runner and gate ───────────────────────────────────────────────────────────────────────────────────────────

interface Reply {
	payload?: unknown;
	cost?: number;
	context?: number;
	aborted?: "context" | "signal";
	/** Files the slot writes into its worktree. */
	touch?: string[];
	/** A git move the watch will see. */
	moved?: string;
	waitMs?: number;
	/** Waits for the signal, then returns aborted. */
	hang?: boolean;
	/** Never returns, whatever the signal says. */
	stuck?: boolean;
	error?: string;
	throws?: string;
}

const AUTHOR = (verdict = "pass") => ({ verdict, tests: ["t/x.sh"], acceptance_map: { works: "t/x.sh" }, notes: verdict === "pass" ? "" : `author says ${verdict}` });
const IMPL = (verdict = "pass") => ({ verdict, notes: verdict === "pass" ? "done" : `implementer says ${verdict}`, checks_run: ["sh t/x.sh"] });
const REVIEW = (verdict = "pass") => ({ verdict, findings: verdict === "pass" ? [] : [{ path: "src/a.ts", line: 1, severity: "high", text: `reviewer says ${verdict}` }] });
const TEST_REVIEW = (verdict = "pass") => ({ verdict, unmapped: verdict === "fix" ? ["criterion 1"] : [], findings: verdict === "pass" ? [] : [`test reviewer says ${verdict}`] });

class FakeRunner implements SlotRunner {
	calls: SlotSpec[] = [];
	active = 0;
	maxActive = 0;
	/** Replies by `<task>:<slot>` or `<slot>`, consumed in order; the default is a passing run. */
	replies = new Map<string, Reply[]>();
	constructor(private world: World) {}
	on(key: string, ...replies: Reply[]): this {
		this.replies.set(key, [...(this.replies.get(key) ?? []), ...replies]);
		return this;
	}
	slots(task?: string): SlotName[] {
		return this.calls.filter(call => task === undefined || call.task.id === task).map(call => call.slot);
	}
	#default(spec: SlotSpec): Reply {
		const id = lower(spec.task.id);
		switch (spec.slot) {
			case "test_author":
				return { payload: AUTHOR(), touch: [`t/${id}.sh`] };
			case "implementer":
				return spec.lockedFiles.length > 0 ? { payload: IMPL(), touch: [`src/${id}.ts`] } : { payload: IMPL(), touch: [`t/${id}.sh`] };
			case "test_review":
				return { payload: TEST_REVIEW() };
			default:
				return { payload: REVIEW() };
		}
	}
	async run(spec: SlotSpec, signal: AbortSignal): Promise<SlotResult> {
		this.world.op(`slot ${spec.slot} ${spec.task.id}`);
		this.calls.push(spec);
		const queue = this.replies.get(`${spec.task.id}:${spec.slot}`) ?? this.replies.get(spec.slot);
		const reply = { ...this.#default(spec), ...queue?.shift() };
		this.active++;
		this.maxActive = Math.max(this.maxActive, this.active);
		try {
			if (reply.waitMs) await sleep(reply.waitMs);
			if (reply.throws) throw new Error(reply.throws);
			if (reply.stuck) await Promise.withResolvers<void>().promise;
			if (reply.hang) {
				const aborted = Promise.withResolvers<void>();
				signal.addEventListener("abort", () => aborted.resolve(), { once: true });
				if (signal.aborted) aborted.resolve();
				await aborted.promise;
				return { payload: undefined, costUsd: reply.cost ?? 0, contextTokens: 0, aborted: "signal" };
			}
			if (spec.cwd.startsWith("/wt/")) {
				const wt = this.world.wtOf(spec.cwd);
				for (const file of reply.touch ?? []) wt.pending.add(file);
				if (reply.moved) wt.moved.push(reply.moved);
			}
			return {
				payload: reply.payload,
				costUsd: reply.cost ?? 0.01,
				contextTokens: reply.context ?? 1000,
				sessionFile: `/sessions/${spec.task.id}-${spec.slot}.jsonl`,
				...(reply.aborted ? { aborted: reply.aborted } : {}),
				...(reply.error ? { error: reply.error } : {}),
			};
		} finally {
			this.active--;
			this.world.events.push(`end ${spec.task.id}:${spec.slot}`);
		}
	}
}

type Answer = GateAnswer | ((request: GateRequest) => GateAnswer);

class FakeGate implements Gate {
	requests: GateRequest[] = [];
	active = 0;
	maxActive = 0;
	answers = new Map<string, Answer[]>();
	constructor(private world: World) {}
	on(cause: string, ...answers: Answer[]): this {
		this.answers.set(cause, [...(this.answers.get(cause) ?? []), ...answers]);
		return this;
	}
	causes(): string[] {
		return this.requests.map(request => request.cause);
	}
	async choose(request: GateRequest): Promise<GateAnswer> {
		this.requests.push(request);
		this.world.events.push(`gate ${request.cause}`);
		this.active++;
		this.maxActive = Math.max(this.maxActive, this.active);
		try {
			await sleep(2);
			const next = this.answers.get(request.cause)?.shift();
			if (next === undefined) throw new Error(`unscripted gate ${request.cause}: ${request.title}`);
			return typeof next === "function" ? next(request) : next;
		} finally {
			this.active--;
		}
	}
}

interface Fixture {
	world: World;
	git: GitOps;
	checks: CheckOps;
	runner: FakeRunner;
	gate: FakeGate;
	script: { fails: FailsBeforeResult[]; checks: CheckScript[]; guards: GuardViolation[][] };
	log: RunLogEntry[];
	run(opts?: RunOptions): Promise<RunSummary>;
	states(): Record<string, string>;
}

function fixture(source: TaskSpec[] | State, opts: { checks?: Record<string, string | string[]> } = {}): Fixture {
	const state = Array.isArray(source) ? freshState(planFor(source, opts.checks)) : source;
	const world = new World(state);
	const git = fakeGit(world);
	const runner = new FakeRunner(world);
	const gate = new FakeGate(world);
	const script = { fails: [] as FailsBeforeResult[], checks: [] as CheckScript[], guards: [] as GuardViolation[][] };
	const log: RunLogEntry[] = [];
	const checks = fakeChecks(world, script);
	let clock = 0;
	return {
		world, git, checks, runner, gate, script, log,
		run: (runOpts = {}) => runPlan({ slots: runner, gate, git, checks, log: { append: entry => void log.push(entry) }, now: () => new Date(Date.UTC(2026, 10, 4, 5, 0, clock++)) }, { abortGraceMs: 30, ...runOpts }),
		states() {
			const parsed = parsePlan(world.state.planText);
			if (!parsed.ok) throw new Error("fixture plan does not parse");
			return Object.fromEntries(statusFromGit(git, parsed.plan, world.state.planRev).tasks.map(task => [task.id, task.state]));
		},
	};
}

const ticketShape = (fx: Fixture, task: string): string[] =>
	fx.world.state.ticket.filter(commit => commit.tasks.includes(task)).map(commit => (commit.locks.length > 0 ? "lock" : commit.unlocks.length > 0 ? "unlock" : "work"));
const gateLog = (fx: Fixture): Array<[string, string]> => fx.log.flatMap(entry => (entry.kind === "gate" ? [[entry.cause, entry.choice] as [string, string]] : []));
const stop: GateAnswer = { choice: "stop" };

// ── Happy paths ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("happy path", () => {
	test("a normal task: test author, fails-before, test review, lock, implementer, checks, integration, then the story review", async () => {
		const fx = fixture([{ id: "T1" }]);
		const summary = await fx.run();
		expect(summary).toMatchObject({ outcome: "complete", reasons: [], slotRuns: 4 });
		expect(fx.runner.calls.map(call => `${call.task.id}:${call.slot}`)).toEqual(["T1:test_author", "T1:test_review", "T1:implementer", "story:code_review"]);
		expect(fx.world.state.ops.filter(op => !op.startsWith("slot"))).toEqual([
			"cleanup", "addWorktree T1", "commit T1 test(T1)", "failsBefore T1", "lock T1", "commit T1 feat(T1)", "check T1", "integrate T1", "guard base..c#", "writeNote T1", "publish T1",
			"removeWorktree T1", "addWorktree _review", "removeWorktree _review",
		]);
		expect(ticketShape(fx, "T1")).toEqual(["work", "lock", "work"]);
		expect(fx.states()).toEqual({ T1: "done" });
		expect(fx.world.state.wts.size).toBe(0);
		expect(summary.costUsd).toBeCloseTo(0.04, 5);
		expect(fx.world.state.notes.get(fx.world.tip())).toMatchObject({ task: "T1", plan_rev: "rev1", checks: { guard: "pass" }, blocked: false });
	});

	test("the prompts carry the plan, the paths, the locked tests of the implementer and the review's diff", async () => {
		const fx = fixture([{ id: "T1" }]);
		await fx.run();
		const [author, review, impl, story] = fx.runner.calls;
		expect(author.prompt).toContain("Plan: /vault/Specs/S/plan.md at revision rev1");
		expect(author.prompt).toContain("Files you may write (owns, then new_paths):\n- src/t1.ts\n- t/t1.sh");
		expect(author.writeScope).toEqual(["src/t1.ts", "t/t1.sh"]);
		expect(author).toMatchObject({ agent: "test-engineer", modelRole: "task", thinkingLevel: "medium", story: "S-1", cwd: "/wt/T1", lockedFiles: [] });
		expect(review).toMatchObject({ agent: "code-reviewer", modelRole: "slow", writeScope: [], lockedFiles: [] });
		expect(review.prompt).toContain("## The task's test files\n- t/t1.sh");
		expect(impl.lockedFiles).toEqual(["t/t1.sh"]);
		expect(impl.prompt).toContain("## Locked tests (frozen; you cannot edit them)\n- t/t1.sh");
		expect(impl.maxContextTokens).toBe(300_000);
		expect(story).toMatchObject({ task: { id: "story", repo: REPO }, writeScope: [] });
		expect(story.prompt).toContain("## Diff (against main)");
	});

	test("a small task: the implementer writes the tests first, no test review, the fails-before check and the lock still run", async () => {
		const fx = fixture([{ id: "T1", size: "small" }]);
		const summary = await fx.run();
		expect(summary.outcome).toBe("complete");
		expect(fx.runner.slots("T1")).toEqual(["implementer", "implementer"]);
		expect(fx.runner.calls[0].prompt).toContain("tests first (a small task)");
		expect(fx.runner.calls[0].lockedFiles).toEqual([]);
		expect(fx.runner.calls[1].lockedFiles).toEqual(["t/t1.sh"]);
		expect(fx.world.state.ops).toContain("failsBefore T1");
		expect(ticketShape(fx, "T1")).toEqual(["work", "lock", "work"]);
	});

	test("a task with a technical risk gets a code review, and a security-flagged one a security review, before the integration", async () => {
		const fx = fixture([{ id: "T1", risky: true }, { id: "T2", secure: true, deps: ["T1"] }]);
		expect((await fx.run()).outcome).toBe("complete");
		expect(fx.runner.slots("T1")).toEqual(["test_author", "test_review", "implementer", "code_review"]);
		expect(fx.runner.slots("T2")).toEqual(["test_author", "test_review", "implementer", "security_review"]);
		expect(fx.runner.calls.find(call => call.slot === "security_review")).toMatchObject({ agent: "security-auditor", modelRole: "slow", thinkingLevel: "high" });
		expect(fx.runner.calls.find(call => call.task.id === "T1" && call.slot === "code_review")!.prompt).toContain("## Diff (against");
		const ops = fx.world.state.ops;
		expect(ops.indexOf("slot code_review T1")).toBeLessThan(ops.indexOf("integrate T1"));
	});

	test("the status line is reported through onStatus and the run log has a line per slot run", async () => {
		const fx = fixture([{ id: "T1" }]);
		const lines: string[] = [];
		await fx.run({ onStatus: line => void lines.push(line) });
		expect(lines[0]).toBe("S-1 ▸ 0/1 done · 1 ready");
		expect(lines.some(line => line.includes("running T1 test_author"))).toBe(true);
		expect(lines.at(-1)).toBe("S-1 ▸ 1/1 done");
		const slotLines = fx.log.filter(entry => entry.kind === "slot");
		expect(slotLines).toHaveLength(4);
		expect(slotLines[0]).toMatchObject({ task: "T1", slot: "test_author", attempt: 1, outcome: "verdict", verdict: "pass", costUsd: 0.01, contextTokens: 1000, sessionFile: "/sessions/T1-test_author.jsonl" });
		expect(fx.log[0]).toMatchObject({ kind: "event", event: "run-start" });
		expect(fx.log.at(-1)).toMatchObject({ kind: "event", event: "run-end" });
	});
});

// ── Verdicts ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("every verdict value leads to its branch", () => {
	test("test_author: spec_wrong and need_clarification stop with a note and a gate; retry reruns with the human's note; blocked offers a retry", async () => {
		for (const verdict of ["spec_wrong", "need_clarification"] as const) {
			const stopped = fixture([{ id: "T1" }]);
			stopped.runner.on("test_author", { payload: AUTHOR(verdict) });
			stopped.gate.on(verdict, stop);
			expect(await stopped.run()).toMatchObject({ outcome: "incomplete", reasons: [`T1 is blocked: ${verdict}`] });
			expect(stopped.gate.requests[0]).toMatchObject({ cause: verdict, task: "T1", detail: `author says ${verdict}`, fallback: "stop" });
			expect(stopped.gate.requests[0].choices.map(choice => choice.id)).toEqual(["stop", "retry"]);
			expect(stopped.gate.requests[0].choices[1].note).toBe(true);
			expect(stopped.world.state.taskNotes.get("T1")).toMatchObject({ blocked: true, reason: verdict, plan_rev: "rev1" });
			expect(stopped.states()).toEqual({ T1: "blocked" });
			expect(stopped.world.state.wts.size).toBe(0);

			const retried = fixture([{ id: "T1" }]);
			retried.runner.on("test_author", { payload: AUTHOR(verdict) });
			retried.gate.on(verdict, { choice: "retry", note: "use the v2 endpoint" });
			expect((await retried.run()).outcome).toBe("complete");
			expect(retried.runner.calls[1].prompt).toContain("## Notes from the human who owns this task\n- use the v2 endpoint");
			expect(retried.world.state.taskNotes.size).toBe(0);
			expect(retried.world.state.ops).toContain("setTaskNote T1 clear");
		}
		const blocked = fixture([{ id: "T1" }]);
		blocked.runner.on("test_author", { payload: AUTHOR("blocked") });
		blocked.gate.on("blocked", { choice: "retry" });
		expect((await blocked.run()).outcome).toBe("complete");
		expect(blocked.gate.requests[0].choices.map(choice => choice.id)).toEqual(["stop", "retry"]);
	});

	test("test_review: pass locks; fix reruns the author with the findings; a second fix opens a gate; spec_wrong stops", async () => {
		const once = fixture([{ id: "T1" }]);
		once.runner.on("test_review", { payload: TEST_REVIEW("fix") });
		expect((await once.run()).outcome).toBe("complete");
		expect(once.runner.slots("T1")).toEqual(["test_author", "test_review", "test_author", "test_review", "implementer"]);
		expect(once.runner.calls[2].prompt).toContain("## To fix from the previous run");
		expect(once.runner.calls[2].prompt).toContain("- test reviewer says fix\n- not covered by any test: criterion 1");
		expect(ticketShape(once, "T1")).toEqual(["work", "work", "lock", "work"]);

		const twice = fixture([{ id: "T1" }]);
		twice.runner.on("test_review", { payload: TEST_REVIEW("fix") }, { payload: TEST_REVIEW("fix") });
		twice.gate.on("cap", stop);
		expect(await twice.run()).toMatchObject({ outcome: "incomplete", reasons: ["T1 is blocked: cap"] });
		expect(twice.gate.requests[0].title).toContain("the test review asked for fixes twice");
		expect(twice.runner.slots("T1")).toEqual(["test_author", "test_review", "test_author", "test_review"]);
		expect(twice.world.state.ops).not.toContain("lock T1");

		const wrong = fixture([{ id: "T1" }]);
		wrong.runner.on("test_review", { payload: TEST_REVIEW("spec_wrong") });
		wrong.gate.on("spec_wrong", stop);
		expect((await wrong.run()).outcome).toBe("incomplete");
		expect(wrong.gate.requests[0].detail).toBe("test reviewer says spec_wrong");
	});

	test("implementer: need_shared_change, need_clarification and blocked stop; the first has no retry", async () => {
		for (const [verdict, choices] of [["need_shared_change", ["stop"]], ["need_clarification", ["stop", "retry"]], ["blocked", ["stop", "retry"]]] as const) {
			const fx = fixture([{ id: "T1" }]);
			fx.runner.on("implementer", { payload: IMPL(verdict) });
			fx.gate.on(verdict, stop);
			expect(await fx.run()).toMatchObject({ outcome: "incomplete", reasons: [`T1 is blocked: ${verdict}`] });
			expect(fx.gate.requests[0].choices.map(choice => choice.id)).toEqual([...choices]);
			expect(fx.gate.requests[0].detail).toBe(`implementer says ${verdict}`);
			expect(fx.world.state.ops).not.toContain("commit T1 feat(T1)");
		}
	});

	test("implementer test_wrong: approving the unlock rewrites, reviews and relocks the tests; rejecting reruns the implementer; stop blocks", async () => {
		const unlock = fixture([{ id: "T1" }]);
		unlock.runner.on("implementer", { payload: IMPL("test_wrong") });
		unlock.gate.on("test_wrong", { choice: "unlock" });
		expect((await unlock.run()).outcome).toBe("complete");
		expect(unlock.runner.slots("T1")).toEqual(["test_author", "test_review", "implementer", "test_author", "test_review", "implementer"]);
		expect(unlock.runner.calls[3].prompt).toContain("a human approved rewriting them: implementer says test_wrong");
		expect(unlock.runner.calls[3].lockedFiles).toEqual([]);
		expect(unlock.runner.calls[5].lockedFiles).toEqual(["t/t1.sh"]);
		expect(ticketShape(unlock, "T1")).toEqual(["work", "lock", "unlock", "work", "lock", "work"]);
		expect(unlock.gate.requests[0].choices.map(choice => choice.id)).toEqual(["unlock", "reject", "stop"]);

		const reject = fixture([{ id: "T1" }]);
		reject.runner.on("implementer", { payload: IMPL("test_wrong") });
		reject.gate.on("test_wrong", { choice: "reject" });
		expect((await reject.run()).outcome).toBe("complete");
		expect(reject.runner.slots("T1")).toEqual(["test_author", "test_review", "implementer", "implementer"]);
		expect(reject.runner.calls[3].prompt).toContain("rejected it: the locked tests stand");
		expect(ticketShape(reject, "T1")).toEqual(["work", "lock", "work"]);

		const stopped = fixture([{ id: "T1" }]);
		stopped.runner.on("implementer", { payload: IMPL("test_wrong") });
		stopped.gate.on("test_wrong", stop);
		expect(await stopped.run()).toMatchObject({ outcome: "incomplete", reasons: ["T1 is blocked: test_wrong"] });
	});

	test("code_review and security_review: pass goes on, fix reruns the implementer with the findings, spec_wrong stops", async () => {
		for (const [slot, spec] of [["code_review", { id: "T1", risky: true }], ["security_review", { id: "T1", secure: true }]] as const) {
			const fix = fixture([spec]);
			fix.runner.on(slot, { payload: REVIEW("fix") });
			expect((await fix.run()).outcome).toBe("complete");
			expect(fix.runner.slots("T1")).toEqual(["test_author", "test_review", "implementer", slot, "implementer", slot]);
			expect(fix.runner.calls[4].prompt).toContain("- [high] src/a.ts:1: reviewer says fix");
			expect(ticketShape(fix, "T1")).toEqual(["work", "lock", "work", "work"]);

			const wrong = fixture([spec]);
			wrong.runner.on(slot, { payload: REVIEW("spec_wrong") });
			wrong.gate.on("spec_wrong", stop);
			expect((await wrong.run()).outcome).toBe("incomplete");
			expect(wrong.gate.requests[0].detail).toContain("reviewer says spec_wrong");
			expect(wrong.world.state.ops).not.toContain("integrate T1");
		}
	});

	test("the story review: findings open a gate; accepting finishes the story, stopping leaves it incomplete", async () => {
		const accept = fixture([{ id: "T1" }]);
		accept.runner.on("code_review", { payload: REVIEW("fix") });
		accept.gate.on("review", { choice: "accept" });
		expect((await accept.run()).outcome).toBe("complete");
		expect(accept.gate.requests[0].detail).toBe("[high] src/a.ts:1: reviewer says fix");

		const refuse = fixture([{ id: "T1" }]);
		refuse.runner.on("code_review", { payload: REVIEW("spec_wrong") });
		refuse.gate.on("review", stop);
		expect(await refuse.run()).toMatchObject({ outcome: "incomplete", reasons: [`the story review of ${REPO} left findings; fix them by hand and rerun`] });
		expect(refuse.states()).toEqual({ T1: "done" });
		expect(refuse.world.state.wts.size).toBe(0);
	});
});

describe("failed attempts", () => {
	test("a schema-invalid payload and a payload that is not JSON each count as a failed attempt and say why in the next prompt", async () => {
		const fx = fixture([{ id: "T1" }]);
		fx.runner.on("test_author", { payload: { verdict: "pass" } }, { payload: "not json at all" });
		expect((await fx.run()).outcome).toBe("complete");
		expect(fx.runner.slots("T1").slice(0, 3)).toEqual(["test_author", "test_author", "test_author"]);
		expect(fx.runner.calls[1].prompt).toContain('Your previous reply was not a valid verdict: "tests" must be an array of strings');
		expect(fx.runner.calls[2].prompt).toContain("not valid JSON");
		const invalid = fx.log.filter(entry => entry.kind === "slot" && entry.outcome === "invalid");
		expect(invalid).toHaveLength(2);
		expect(fx.world.state.ops.filter(op => op.startsWith("commit T1 test"))).toHaveLength(1);
	});

	test("a string payload that holds valid JSON is accepted", async () => {
		const fx = fixture([{ id: "T1" }]);
		fx.runner.on("test_author", { payload: JSON.stringify(AUTHOR()), touch: ["t/t1.sh"] });
		fx.runner.on("implementer", { payload: JSON.stringify(IMPL()), touch: ["src/t1.ts"] });
		expect((await fx.run()).outcome).toBe("complete");
		expect(fx.runner.slots("T1")).toEqual(["test_author", "test_review", "implementer"]);
	});

	test("a slot that yielded nothing is invalid, with the runner's error in the reason", async () => {
		const fx = fixture([{ id: "T1" }]);
		fx.runner.on("test_author", { payload: undefined, error: "the worker yielded an error: no network" });
		await fx.run();
		expect(fx.runner.calls[1].prompt).toContain("the slot yielded no payload (the worker yielded an error: no network)");
	});

	test("a context abort counts as an attempt and the next prompt says so", async () => {
		const fx = fixture([{ id: "T1" }]);
		fx.runner.on("implementer", { aborted: "context", context: 310_000, touch: ["src/t1.ts"] });
		expect((await fx.run({ maxContextTokens: 300_000 })).outcome).toBe("complete");
		expect(fx.runner.slots("T1")).toEqual(["test_author", "test_review", "implementer", "implementer"]);
		expect(fx.runner.calls[3].prompt).toContain("passed the 300000 token context ceiling");
		expect(fx.log.find(entry => entry.kind === "slot" && entry.outcome === "aborted")).toMatchObject({ slot: "implementer", contextTokens: 310_000 });
		expect(fx.world.state.ops.filter(op => op.startsWith("commit T1 feat"))).toHaveLength(1);
	});

	test("the wall timeout aborts the slot through its signal and counts as an attempt; a runner that ignores the signal is left behind", async () => {
		const hang = fixture([{ id: "T1" }]);
		hang.runner.on("test_author", { hang: true });
		expect((await hang.run({ slotTimeoutMs: 20 })).outcome).toBe("complete");
		expect(hang.runner.calls[1].prompt).toContain("wall timeout");

		const stuck = fixture([{ id: "T1" }]);
		stuck.runner.on("test_author", { stuck: true });
		expect((await stuck.run({ slotTimeoutMs: 20, abortGraceMs: 20 })).outcome).toBe("complete");
		expect(stuck.runner.slots("T1")[1]).toBe("test_author");
	});

	test("a slot that writes outside its scope, edits a locked test or moves git is rejected, discarded and retried", async () => {
		const fx = fixture([{ id: "T1" }]);
		fx.runner.on("test_author", { payload: AUTHOR(), touch: ["t/t1.sh", "docs/readme.md"] });
		fx.runner.on("implementer", { touch: ["src/t1.ts", "t/t1.sh"] }, { moved: "HEAD moved from abc1234 to def5678", touch: ["src/t1.ts"] });
		expect((await fx.run()).outcome).toBe("complete");
		expect(fx.runner.calls[1].prompt).toContain("docs/readme.md is outside the write scope");
		const prompts = fx.runner.calls.filter(call => call.slot === "implementer").map(call => call.prompt);
		expect(prompts[1]).toContain("t/t1.sh is a locked test");
		expect(prompts[2]).toContain("HEAD moved from abc1234 to def5678");
		expect(fx.log.filter(entry => entry.kind === "slot" && entry.outcome === "rejected")).toHaveLength(3);
		// The rejected runs never reached a commit: one tests commit, one implementation commit.
		expect(ticketShape(fx, "T1")).toEqual(["work", "lock", "work"]);
	});

	test("a discard that fails opens the environment gate and never goes on silently: retry runs the discard again, stop blocks the task", async () => {
		const retried = fixture([{ id: "T1" }]);
		retried.runner.on("test_author", { payload: AUTHOR(), touch: ["t/t1.sh", "docs/readme.md"] });
		retried.world.discardFailures = 1;
		retried.gate.on("blocked", { choice: "retry" });
		expect((await retried.run()).outcome).toBe("complete");
		expect(retried.gate.requests[0]).toMatchObject({ cause: "blocked", task: "T1" });
		expect(retried.gate.requests[0].title).toContain("restoring the clone after a slot");
		expect(retried.gate.requests[0].detail).toContain("could not restore the git dir");
		expect(retried.world.discards).toBe(2);
		expect(retried.runner.calls[1].prompt).toContain("docs/readme.md is outside the write scope");

		const stopped = fixture([{ id: "T1" }]);
		stopped.runner.on("test_author", { payload: AUTHOR(), touch: ["t/t1.sh", "docs/readme.md"] });
		stopped.world.discardFailures = 5;
		stopped.gate.on("blocked", stop);
		expect(await stopped.run()).toMatchObject({ outcome: "incomplete", reasons: ["T1 is blocked: blocked"] });
		expect(stopped.runner.slots("T1")).toEqual(["test_author"]);
	});

	test("a fails-before result of already-passes reruns the test author with the evidence", async () => {
		const fx = fixture([{ id: "T1" }]);
		fx.script.fails.push({ ok: false, base: "b", files: [{ file: "t/t1.sh", status: "already-passes", output: "ok 1 - nothing is asserted" }] });
		expect((await fx.run()).outcome).toBe("complete");
		expect(fx.runner.slots("T1").slice(0, 3)).toEqual(["test_author", "test_author", "test_review"]);
		expect(fx.runner.calls[1].prompt).toContain("t/t1.sh passes on the base commit");
		expect(fx.runner.calls[1].prompt).toContain("ok 1 - nothing is asserted");
	});

	test("failing checks send the output back to the implementer; three failures reach the cap, a blocked note and a gate; dependants never start", async () => {
		const fx = fixture([{ id: "T1" }, { id: "T2", deps: ["T1"] }, { id: "T3" }]);
		fx.world.failing.add("T1");
		fx.gate.on("cap", stop);
		const summary = await fx.run();
		expect(summary.outcome).toBe("incomplete");
		expect(summary.reasons).toEqual(["T1 is blocked: cap", "T2 was not started: it waits for T1"]);
		expect(fx.runner.slots("T1").filter(slot => slot === "implementer")).toHaveLength(3);
		const prompts = fx.runner.calls.filter(call => call.task.id === "T1" && call.slot === "implementer").map(call => call.prompt);
		expect(prompts[1]).toContain("test failed (exit 1):\n2 tests failed: expected 2");
		expect(prompts[2]).toContain("attempt 3 of 3");
		expect(fx.runner.slots("T2")).toEqual([]);
		expect(fx.states()).toEqual({ T1: "blocked", T2: "waiting", T3: "done" });
		expect(fx.world.state.taskNotes.get("T1")).toMatchObject({ blocked: true, reason: "cap", attempts: 4 });
		expect(fx.gate.requests[0]).toMatchObject({ cause: "cap", task: "T1" });
		expect(ticketShape(fx, "T1")).toEqual([]);
	});

	test("retry once more at the cap gives exactly one more attempt", async () => {
		const fx = fixture([{ id: "T1" }]);
		fx.world.failing.add("T1");
		fx.gate.on("cap", { choice: "retry" }, stop);
		fx.script.checks.push();
		await fx.run();
		expect(fx.runner.slots("T1").filter(slot => slot === "implementer")).toHaveLength(4);
		expect(gateLog(fx)).toEqual([["cap", "retry"], ["cap", "stop"]]);
	});

	test("an operation that fails asks whether to retry it, and the retry replays that operation only", async () => {
		const fx = fixture([{ id: "T1" }]);
		let failures = 1;
		const failsBefore = fx.script.fails;
		const original = fx.git.lock;
		fx.git.lock = (wt, lock) => {
			if (failures-- > 0) throw new Error("index.lock exists");
			return original(wt, lock);
		};
		fx.gate.on("blocked", { choice: "retry" });
		expect((await fx.run()).outcome).toBe("complete");
		expect(failsBefore).toHaveLength(0);
		expect(fx.gate.requests[0]).toMatchObject({ cause: "blocked", detail: "index.lock exists" });
		expect(fx.runner.slots("T1").filter(slot => slot === "test_author")).toHaveLength(1);
		expect(fx.world.state.ops.filter(op => op === "lock T1")).toHaveLength(1);
	});

	test("a runner that throws is an environment failure for the human, not a failed attempt", async () => {
		const fx = fixture([{ id: "T1" }]);
		fx.runner.on("test_author", { throws: "model unavailable" });
		fx.gate.on("blocked", stop);
		expect(await fx.run()).toMatchObject({ outcome: "incomplete", reasons: ["T1 is blocked: blocked"] });
		expect(fx.gate.requests[0].detail).toBe("model unavailable");
	});
});

// ── Budget, concurrency, serialization ─────────────────────────────────────────────────────────────────────────────────────

describe("budget", () => {
	test("past the budget nothing new starts: the budget gate asks, stop ends the run without blocked notes", async () => {
		const fx = fixture([{ id: "T1" }]);
		fx.runner.on("test_author", { cost: 60 });
		fx.runner.on("test_review", { cost: 60 });
		fx.gate.on("budget", stop);
		const summary = await fx.run({ budgetUsd: 100 });
		expect(summary).toMatchObject({ outcome: "stopped", costUsd: 120 });
		expect(summary.reasons[0]).toContain("budget");
		expect(fx.runner.slots("T1")).toEqual(["test_author", "test_review"]);
		expect(fx.gate.requests[0].title).toContain("$120.00 of $100");
		expect(fx.gate.requests[0].choices.map(choice => choice.label)).toEqual(["Stop the run", "Raise the limit by $50"]);
		expect(fx.world.state.taskNotes.size).toBe(0);
		expect(fx.world.state.wts.size).toBe(0);
		expect(fx.states()).toEqual({ T1: "ready" });
	});

	test("raising the limit by $50 lets the run go on until the next limit", async () => {
		const fx = fixture([{ id: "T1" }]);
		for (const slot of ["test_author", "test_review", "implementer", "code_review"]) fx.runner.on(slot, { cost: 60 });
		fx.gate.on("budget", { choice: "raise" }, { choice: "raise" });
		const summary = await fx.run({ budgetUsd: 100 });
		expect(summary).toMatchObject({ outcome: "complete", costUsd: 240 });
		expect(fx.gate.causes()).toEqual(["budget", "budget"]);
		expect(fx.gate.requests[1].title).toContain("of $150");
	});

	test("in-flight slots finish before the budget gate opens", async () => {
		const fx = fixture([{ id: "T1" }, { id: "T2" }]);
		fx.runner.on("T1:test_author", { cost: 120 });
		fx.runner.on("T2:test_author", { waitMs: 40, cost: 1 });
		fx.gate.on("budget", stop);
		await fx.run({ budgetUsd: 100, concurrency: 2 });
		const events = fx.world.events;
		expect(events.indexOf("end T2:test_author")).toBeGreaterThanOrEqual(0);
		expect(events.indexOf("gate budget")).toBeGreaterThan(events.indexOf("end T2:test_author"));
		expect(fx.gate.requests).toHaveLength(1);
	});
});

describe("concurrency and serialization", () => {
	test("at most `concurrency` tasks run at once, and the limit is reached", async () => {
		for (const concurrency of [1, 2]) {
			const fx = fixture([{ id: "T1" }, { id: "T2" }, { id: "T3" }, { id: "T4" }]);
			for (const id of ["T1", "T2", "T3", "T4"]) fx.runner.on(`${id}:implementer`, { waitMs: 15, touch: [`src/${lower(id)}.ts`] });
			expect((await fx.run({ concurrency })).outcome).toBe("complete");
			expect(fx.runner.maxActive).toBe(concurrency);
		}
		const defaulted = fixture([{ id: "T1" }, { id: "T2" }, { id: "T3" }]);
		for (const id of ["T1", "T2", "T3"]) defaulted.runner.on(`${id}:implementer`, { waitMs: 15, touch: [`src/${lower(id)}.ts`] });
		await defaulted.run();
		expect(defaulted.runner.maxActive).toBe(2);
	});

	test("a dependant starts only once its dependency is done, and the ticket history holds each task's commits together", async () => {
		const fx = fixture([{ id: "T1" }, { id: "T2", deps: ["T1"] }]);
		expect((await fx.run({ concurrency: 2 })).outcome).toBe("complete");
		const ops = fx.world.state.ops;
		expect(ops.indexOf("publish T1")).toBeLessThan(ops.indexOf("addWorktree T2"));
		expect(fx.world.state.ticket.map(commit => commit.tasks[0])).toEqual(["T1", "T1", "T1", "T2", "T2", "T2"]);
	});

	test("cherry-picks are serialized: two tasks that finish together integrate one after the other, and the later one is replayed on the new tip", async () => {
		const fx = fixture([{ id: "T1" }, { id: "T2" }]);
		fx.world.delays.integrate = 20;
		expect((await fx.run({ concurrency: 2 })).outcome).toBe("complete");
		expect(fx.world.maxIntegrating).toBe(1);
		const ops = fx.world.state.ops.filter(op => /^(integrate|publish) /.test(op));
		expect(ops[0].split(" ")[1]).toBe(ops[1].split(" ")[1]);
		expect(ops).toHaveLength(4);
		expect(fx.world.state.ticket.some(commit => commit.sha.startsWith("p"))).toBe(true);
		expect(fx.states()).toEqual({ T1: "done", T2: "done" });
	});

	test("gates are asked one at a time even when two tasks stop together", async () => {
		const fx = fixture([{ id: "T1" }, { id: "T2" }]);
		fx.runner.on("test_author", { payload: AUTHOR("spec_wrong") }, { payload: AUTHOR("spec_wrong") });
		fx.gate.on("spec_wrong", stop, stop);
		const summary = await fx.run({ concurrency: 2 });
		expect(summary.reasons).toEqual(["T1 is blocked: spec_wrong", "T2 is blocked: spec_wrong"]);
		expect(fx.gate.requests).toHaveLength(2);
		expect(fx.gate.maxActive).toBe(1);
	});

	test("an independent task still completes when another is blocked", async () => {
		const fx = fixture([{ id: "T1" }, { id: "T2" }]);
		fx.runner.on("T1:test_author", { payload: AUTHOR("spec_wrong") });
		fx.gate.on("spec_wrong", stop);
		expect((await fx.run({ concurrency: 2 })).outcome).toBe("incomplete");
		expect(fx.states()).toEqual({ T1: "blocked", T2: "done" });
	});
});

// ── Plan changes, stop, preconditions ──────────────────────────────────────────────────────────────────────────────────────

describe("plan changes and /run-stop", () => {
	const afterFirstTask = (fx: Fixture): void => {
		fx.world.hook = op => {
			if (op === "publish T1") fx.world.state.planRev = "rev2";
		};
	};

	test("a plan revision committed mid-run stops new starts and opens a gate; stop ends the run", async () => {
		const fx = fixture([{ id: "T1" }, { id: "T2", deps: ["T1"] }]);
		afterFirstTask(fx);
		fx.gate.on("plan-changed", stop);
		const summary = await fx.run();
		expect(summary).toMatchObject({ outcome: "stopped" });
		expect(summary.reasons[0]).toContain("the plan changed in the vault");
		expect(fx.runner.slots("T2")).toEqual([]);
		expect(fx.gate.requests[0].detail).toContain("a newer plan revision was committed (rev2");
		expect(fx.states()).toEqual({ T1: "done", T2: "ready" });
	});

	test("an uncommitted edit counts as a change too, and continue keeps the run's own plan revision", async () => {
		const fx = fixture([{ id: "T1" }, { id: "T2", deps: ["T1"] }]);
		fx.world.hook = op => {
			if (op === "publish T1") {
				fx.world.state.committed = false;
				fx.world.state.planText += "\nedited";
			}
		};
		fx.gate.on("plan-changed", { choice: "continue" });
		expect((await fx.run()).outcome).toBe("complete");
		expect(fx.gate.requests).toHaveLength(1);
		expect(fx.gate.requests[0].detail).toContain("uncommitted edits");
		expect(fx.runner.calls.find(call => call.task.id === "T2")!.prompt).toContain("at revision rev1");
	});

	test("/run-stop aborts the in-flight slot, writes no blocked note and removes the worktrees", async () => {
		const fx = fixture([{ id: "T1" }, { id: "T2" }]);
		const controller = new AbortController();
		fx.runner.on("T1:test_author", { hang: true });
		fx.runner.on("T2:test_author", { hang: true });
		setTimeout(() => controller.abort(), 20);
		const summary = await fx.run({ concurrency: 2, signal: controller.signal });
		expect(summary).toMatchObject({ outcome: "stopped", reasons: ["stopped with /run-stop"] });
		expect(fx.world.state.wts.size).toBe(0);
		expect(fx.world.state.taskNotes.size).toBe(0);
		expect(fx.world.state.ticket).toEqual([]);
		expect(fx.states()).toEqual({ T1: "ready", T2: "ready" });
		expect(fx.log.filter(entry => entry.kind === "event" && entry.event === "task-stopped")).toHaveLength(2);
	});

	test("a run signal that is already aborted starts nothing", async () => {
		const fx = fixture([{ id: "T1" }]);
		const controller = new AbortController();
		controller.abort();
		const summary = await fx.run({ signal: controller.signal });
		expect(summary.outcome).toBe("stopped");
		expect(fx.runner.calls).toEqual([]);
	});
});

describe("preconditions", () => {
	test("an uncommitted plan, a plan that does not parse, the wrong kind, a missing test_files command and a dirty clone each refuse the run", async () => {
		const dirty = fixture([{ id: "T1" }]);
		dirty.world.state.committed = false;
		expect(await dirty.run()).toMatchObject({ outcome: "refused", costUsd: 0 });
		expect((await dirty.run()).reasons[0]).toContain("uncommitted changes in the vault");

		const broken = fixture([{ id: "T1" }]);
		broken.world.state.planText = "no blocks\n";
		expect((await broken.run()).reasons[0]).toContain("the plan does not parse");

		const kind = fixture([{ id: "T1" }]);
		expect((await kind.run({ kind: "task" })).reasons).toEqual(["this command runs a task plan, but S-1 is kind: story"]);

		const noFiles = fixture([{ id: "T1" }], { checks: { test: "true" } });
		expect((await noFiles.run()).reasons).toEqual([`the plan declares no checks.test_files for ${REPO}, which the fails-before check needs`]);

		const unclean = fixture([{ id: "T1" }]);
		unclean.world.state.clean = false;
		expect((await unclean.run()).reasons[0]).toContain("is not clean ( M src/a.ts)");

		for (const fx of [dirty, broken, kind, noFiles, unclean]) {
			expect(fx.runner.calls).toEqual([]);
			expect(fx.world.state.ops).toEqual([]);
		}
	});

	test("an invalid plan is refused with the validator's findings", async () => {
		const fx = fixture([{ id: "T1" }, { id: "T2", deps: ["T9"] }]);
		const summary = await fx.run();
		expect(summary.outcome).toBe("refused");
		expect(summary.reasons[0]).toContain("missing-dep [T2]");
	});

	test("a missing ticket branch opens a gate: create makes it, stop refuses; nothing is created without asking", async () => {
		const create = fixture([{ id: "T1" }]);
		create.world.state.branchExists = false;
		create.gate.on("missing-branch", { choice: "create" });
		expect((await create.run()).outcome).toBe("complete");
		expect(create.gate.requests[0].choices.map(choice => choice.label)).toEqual(["Create PAC-1 from main", "Stop"]);
		expect(create.world.state.ops[0]).toBe("createBranch");

		const refuse = fixture([{ id: "T1" }]);
		refuse.world.state.branchExists = false;
		refuse.gate.on("missing-branch", stop);
		expect(await refuse.run()).toMatchObject({ outcome: "refused", reasons: [`${REPO}: the ticket branch PAC-1 does not exist`] });
		expect(refuse.world.state.ops).toEqual([]);
	});

	test("a missing pre-push hook opens a gate: install puts it in place, stop refuses", async () => {
		const install = fixture([{ id: "T1" }]);
		install.world.state.hook = false;
		install.gate.on("missing-hook", { choice: "install" });
		expect((await install.run()).outcome).toBe("complete");
		expect(install.world.state.hook).toBe(true);

		const refuse = fixture([{ id: "T1" }]);
		refuse.world.state.hook = false;
		refuse.gate.on("missing-hook", stop);
		expect((await refuse.run()).reasons).toEqual([`${REPO}: the pre-push hook is not installed`]);
	});

	test("an answer that is not one of the choices falls back to the stopping choice", async () => {
		const fx = fixture([{ id: "T1" }]);
		fx.runner.on("test_author", { payload: AUTHOR("spec_wrong") });
		fx.gate.on("spec_wrong", { choice: "delete everything" });
		expect((await fx.run()).outcome).toBe("incomplete");
		expect(gateLog(fx)).toEqual([["spec_wrong", "stop"]]);
	});

	test("every gate answer goes to the run log, with the note", async () => {
		const fx = fixture([{ id: "T1" }]);
		fx.runner.on("test_author", { payload: AUTHOR("spec_wrong") });
		fx.gate.on("spec_wrong", { choice: "retry", note: "try again" });
		await fx.run();
		expect(fx.log.find(entry => entry.kind === "gate")).toMatchObject({ cause: "spec_wrong", task: "T1", choice: "retry", note: "try again" });
	});
});

// ── A blocked note, a plan fix, and conflicts ─────────────────────────────────────────────────────────────────────────────

describe("blocked state and integration", () => {
	test("a blocked note before any commit is shown, and a plan fix (a new revision) makes the task ready again; the rerun finishes it", async () => {
		const fx = fixture([{ id: "T1" }]);
		fx.runner.on("test_author", { payload: AUTHOR("spec_wrong") });
		fx.gate.on("spec_wrong", stop);
		await fx.run();
		expect(fx.states()).toEqual({ T1: "blocked" });
		// The same plan revision keeps it blocked: a rerun starts nothing.
		const again = fixture(fx.world.state);
		expect((await again.run()).reasons).toEqual(["T1 is blocked: spec_wrong"]);
		expect(again.runner.calls).toEqual([]);
		// A committed plan fix is a new revision: the old note is stale.
		fx.world.state.planRev = "rev2";
		expect(fx.states()).toEqual({ T1: "ready" });
		const fixedRun = fixture(fx.world.state);
		expect((await fixedRun.run()).outcome).toBe("complete");
		expect(fixedRun.world.state.notes.get(fixedRun.world.tip())).toMatchObject({ plan_rev: "rev2" });
		expect(fixedRun.world.state.taskNotes.size).toBe(0);
	});

	test("a cherry-pick conflict blocks the task with reason conflict, stops its dependants and leaves the ticket branch alone", async () => {
		const fx = fixture([{ id: "T1" }, { id: "T2", deps: ["T1"] }]);
		fx.world.conflicts.add("T1");
		fx.gate.on("conflict", stop);
		const summary = await fx.run();
		expect(summary.reasons).toEqual(["T1 is blocked: conflict", "T2 was not started: it waits for T1"]);
		expect(fx.gate.requests[0]).toMatchObject({ cause: "conflict" });
		expect(fx.gate.requests[0].detail).toContain("CONFLICT (content): Merge conflict in src/a.ts");
		expect(fx.gate.requests[0].choices.map(choice => choice.id)).toEqual(["stop"]);
		expect(fx.world.state.ticket).toEqual([]);
		expect(fx.world.state.wts.size).toBe(0);
	});

	test("a guard violation on the integrated range blocks the task before the ticket branch moves", async () => {
		const fx = fixture([{ id: "T1" }]);
		fx.script.guards.push([{ rule: "skip-added", sha: "abc1234", task: "T1", path: "t/t1.sh", detail: "adds a skipped or focused test" }]);
		fx.gate.on("guard", stop);
		expect((await fx.run()).reasons).toEqual(["T1 is blocked: guard"]);
		expect(fx.gate.requests[0].detail).toContain("skip-added abc1234 T1 t/t1.sh");
		expect(fx.world.state.ticket).toEqual([]);
		expect(fx.world.state.ops).not.toContain("publish T1");
	});

	test("an integration error asks whether to retry; the retry replays the whole integration", async () => {
		const fx = fixture([{ id: "T1" }]);
		let failures = 1;
		const original = fx.git.publish;
		fx.git.publish = (wt, candidate) => {
			if (failures-- > 0) throw new Error("fatal: not a fast-forward");
			original(wt, candidate);
		};
		fx.gate.on("blocked", { choice: "retry" });
		expect((await fx.run()).outcome).toBe("complete");
		expect(fx.world.state.ops.filter(op => op === "integrate T1")).toHaveLength(2);
		expect(ticketShape(fx, "T1")).toEqual(["work", "lock", "work"]);
	});

	test("tasks left in a state the scheduler did not make are reported, not started", async () => {
		const fx = fixture([{ id: "T1" }]);
		fx.world.state.ticket.push({ sha: "h0001", tasks: ["T1"], locks: [], unlocks: [], files: ["src/t1.ts"] });
		const summary = await fx.run();
		expect(summary.outcome).toBe("incomplete");
		expect(summary.reasons).toEqual(["T1 has unfinished commits on the ticket branch (awaiting-lock); finish it by hand"]);
		expect(fx.runner.calls).toEqual([]);
	});
});

// ── Resume after a crash ───────────────────────────────────────────────────────────────────────────────────────────────────

describe("resume after a crash", () => {
	const story: TaskSpec[] = [{ id: "T1" }, { id: "T2", deps: ["T1"] }];

	for (const concurrency of [1, 2]) {
		test(`a run killed before any operation of a two-task story is finished by the next run (concurrency ${concurrency})`, async () => {
			const probe = fixture(story);
			await probe.run({ concurrency });
			const total = probe.world.state.ops.length;
			expect(total).toBeGreaterThan(30);

			const crashedAt = new Set<string>();
			for (let at = 0; at < total; at++) {
				const first = fixture(story);
				const killer = new AbortController();
				let snapshot: State | undefined;
				let op = "";
				first.world.hook = name => {
					if (first.world.state.ops.length - 1 !== at || snapshot !== undefined) return;
					snapshot = structuredClone(first.world.state);
					snapshot.ops.pop();
					op = name;
					killer.abort();
				};
				await first.run({ concurrency, signal: killer.signal });
				expect(snapshot).toBeDefined();
				crashedAt.add(op.split(" ")[0]);

				const second = fixture(snapshot!);
				const summary = await second.run({ concurrency });
				expect({ at, op, outcome: summary.outcome, reasons: summary.reasons }).toEqual({ at, op, outcome: "complete", reasons: [] });
				expect(second.states()).toEqual({ T1: "done", T2: "done" });
				expect(second.world.state.wts.size).toBe(0);
				expect(second.world.state.taskNotes.size).toBe(0);
				for (const task of ["T1", "T2"]) expect({ at, task, shape: ticketShape(second, task) }).toEqual({ at, task, shape: ["work", "lock", "work"] });
			}
			// The crash points cover every kind of pipeline step.
			for (const step of ["slot", "addWorktree", "commit", "failsBefore", "lock", "check", "integrate", "guard", "writeNote", "publish", "removeWorktree"]) {
				expect(crashedAt.has(step)).toBe(true);
			}
		});
	}

	test("leftover worktrees of a killed run are removed before the task starts again", async () => {
		const fx = fixture([{ id: "T1" }]);
		fx.world.state.wts.set("T1", { task: "T1", dir: "/wt/T1", startTip: "base", commits: [], pending: new Set(), moved: [], candidate: undefined });
		expect((await fx.run()).outcome).toBe("complete");
		expect(fx.log.find(entry => entry.kind === "event" && entry.event === "cleanup")).toMatchObject({ detail: `${REPO}: removed spec-wt/PAC-1/T1` });
	});
});

// A reminder for readers: the slot names the scheduler may start are exactly the table's.
test("only table slots are ever started", async () => {
	const fx = fixture([{ id: "T1", risky: true, secure: true }]);
	await fx.run();
	const known: SlotName[] = ["test_author", "test_review", "implementer", "code_review", "security_review"];
	for (const slot of fx.runner.slots()) expect(known).toContain(slot);
});

// ── Amendment 1 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("H2: the integrated tip is checked on its own tree", () => {
	test("checks.check runs on the replayed sha when the ticket moved, under the integration order replay, check, guard, note, publish; an unreplayed tip is not checked again", async () => {
		const fx = fixture([{ id: "T1" }, { id: "T2" }]);
		fx.world.delays.integrate = 20;
		expect((await fx.run({ concurrency: 2 })).outcome).toBe("complete");
		const picked = fx.world.state.ticket.filter(commit => commit.sha.startsWith("p")).at(-1)?.sha ?? "";
		expect(picked).not.toBe("");
		expect(fx.world.checked.filter(entry => entry.sha === picked)).toHaveLength(1);
		expect(fx.world.checked).toHaveLength(3);
		const second = fx.world.checked.find(entry => entry.sha === picked)?.task ?? "";
		const ops = fx.world.state.ops;
		expect(ops.slice(ops.lastIndexOf(`integrate ${second}`)).filter(op => !op.startsWith("removeWorktree")).slice(0, 5)).toEqual([`integrate ${second}`, `check ${second}`, expect.stringMatching(/^guard /), `writeNote ${second}`, `publish ${second}`]);
		expect(fx.world.state.notes.get(picked)).toMatchObject({ checks: { guard: "pass" } });

		const solo = fixture([{ id: "T1" }]);
		await solo.run();
		expect(solo.world.checked).toHaveLength(1);
	});

	test("a replayed tip that fails its check goes back to the implementer on the adopted worktree, and the failure counts as a build attempt", async () => {
		const fx = fixture([{ id: "T1" }, { id: "T2" }]);
		fx.world.delays.integrate = 20;
		fx.world.failNextReplayed = true;
		expect((await fx.run({ concurrency: 2 })).outcome).toBe("complete");
		const adopted = fx.world.state.ops.find(op => op.startsWith("adopt "));
		expect(adopted).toBeDefined();
		const task = (adopted ?? "").split(" ")[1];
		const implementers = fx.runner.calls.filter(call => call.task.id === task && call.slot === "implementer");
		expect(implementers).toHaveLength(2);
		expect(implementers[1].prompt).toContain("test failed (exit 1)");
		expect(implementers[1].prompt).toContain("attempt 3 of 3");
		expect(fx.states()).toEqual({ T1: "done", T2: "done" });
		expect(fx.world.state.ops.filter(op => op === `publish ${task}`)).toHaveLength(1);
	});
});

describe("M1: a conflict keeps the task's commits", () => {
	test("the branch tip is kept under refs/spec-conflict/<ticket>/<task> before the task is blocked, and the gate names the ref and how to resolve", async () => {
		const fx = fixture([{ id: "T1" }]);
		fx.world.conflicts.add("T1");
		fx.gate.on("conflict", stop);
		await fx.run();
		const ref = "refs/spec-conflict/PAC-1/T1";
		expect(fx.world.state.kept.get(ref)).toHaveLength(3);
		const request = fx.gate.requests[0];
		expect(request.detail).toContain(ref);
		expect(request.detail).toContain(`git cherry-pick base..${ref}`);
		expect(request.choices[0].label).toContain(ref);
		const ops = fx.world.state.ops;
		expect(ops.indexOf("keep T1")).toBeGreaterThan(ops.indexOf("integrate T1"));
		expect(ops.indexOf("keep T1")).toBeLessThan(ops.indexOf("setTaskNote T1 conflict"));
	});
});

describe("M2: only test files are written, locked and run", () => {
	test("the tests phase is tests-only and says which paths count; a stub next to the test rejects the run; the implementer phase is not restricted", async () => {
		const fx = fixture([{ id: "T1" }]);
		fx.runner.on("test_author", { payload: AUTHOR(), touch: ["t/t1.sh", "src/t1.ts"] });
		expect((await fx.run()).outcome).toBe("complete");
		expect(fx.runner.calls[0]).toMatchObject({ slot: "test_author", testsOnly: true, testPaths: ["t/**"] });
		expect(fx.runner.calls[1].slot).toBe("test_author");
		expect(fx.runner.calls[1].prompt).toContain("src/t1.ts is not a test file");
		expect(fx.runner.calls.find(call => call.slot === "implementer")?.testsOnly).toBeFalsy();
		expect(fx.runner.calls.find(call => call.slot === "test_review")?.testsOnly).toBeFalsy();

		const small = fixture([{ id: "T1", size: "small" }]);
		await small.run();
		expect(small.runner.calls.slice(0, 2).map(call => call.testsOnly === true)).toEqual([true, false]);
	});

	test("whatever reaches the commit, failsBefore and the lock receive test files only", async () => {
		const fx = fixture([{ id: "T1" }]);
		const watch = fx.git.watch;
		// A watch that does not know the rule: the scheduler's own filter is what is tested.
		fx.git.watch = at => {
			const inner = watch(at);
			return { ...inner, violations: (scope, locked) => inner.violations(scope, locked) };
		};
		const fails: string[][] = [];
		const locked: string[][] = [];
		const failsBefore = fx.checks.failsBefore;
		fx.checks.failsBefore = (wt, sha, files, command) => (fails.push([...files]), failsBefore(wt, sha, files, command));
		const lock = fx.git.lock;
		fx.git.lock = (wt, request) => (locked.push([...request.files]), lock(wt, request));
		fx.runner.on("test_author", { payload: AUTHOR(), touch: ["t/t1.sh", "src/t1.ts"] });
		expect((await fx.run()).outcome).toBe("complete");
		expect(fails).toEqual([["t/t1.sh"]]);
		expect(locked).toEqual([["t/t1.sh"]]);
		expect(fx.runner.calls.find(call => call.slot === "implementer")?.lockedFiles).toEqual(["t/t1.sh"]);
	});

	test("without checks.test_paths the built-in patterns decide", async () => {
		const fx = fixture([{ id: "T1" }], { checks: { test: "true", test_files: "sh {files}" } });
		fx.runner.on("test_author", { payload: AUTHOR(), touch: ["t/t1.sh"] });
		fx.gate.on("cap", stop);
		const summary = await fx.run();
		expect(summary.outcome).toBe("incomplete");
		expect(fx.runner.calls[0].testPaths).toBeUndefined();
		expect(fx.runner.calls[1].prompt).toContain("t/t1.sh is not a test file");
	});
});

describe("M3: one run per ticket and clone", () => {
	test("the run lock is held from the start of the run to its end, and released after a refusal too", async () => {
		const fx = fixture([{ id: "T1" }]);
		const during: number[] = [];
		fx.world.hook = op => {
			if (op === "addWorktree T1") during.push(fx.world.held.size);
		};
		await fx.run();
		expect(during).toEqual([1]);
		expect(fx.world.held.size).toBe(0);

		const dirty = fixture([{ id: "T1" }]);
		dirty.world.state.clean = false;
		expect((await dirty.run()).outcome).toBe("refused");
		expect(dirty.world.held.size).toBe(0);
	});

	test("a lock another run holds refuses the run before any gate or cleanup, naming the file, the pid and the start time", async () => {
		const fx = fixture([{ id: "T1" }]);
		fx.world.heldBy = { pid: 4242, host: "other-host", startedAt: "2026-11-05T00:00:00.000Z" };
		const summary = await fx.run();
		expect(summary.outcome).toBe("refused");
		expect(summary.reasons).toHaveLength(1);
		for (const part of ["/clone/.git/spec-run-PAC-1.lock", "pid 4242", "other-host", "2026-11-05T00:00:00.000Z"]) expect(summary.reasons[0]).toContain(part);
		expect(fx.world.state.ops).toEqual([]);
		expect(fx.gate.requests).toEqual([]);
		expect(fx.runner.calls).toEqual([]);
	});

	test("taking over the lock of a dead process is logged", async () => {
		const fx = fixture([{ id: "T1" }]);
		fx.world.staleHolder = { pid: 31337, host: "this-host", startedAt: "2026-11-05T00:00:00.000Z" };
		expect((await fx.run()).outcome).toBe("complete");
		const takeover = fx.log.find(entry => entry.kind === "event" && entry.event === "lock-takeover");
		expect(takeover).toMatchObject({ detail: expect.stringContaining("pid 31337") });
	});
});
