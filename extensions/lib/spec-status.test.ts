import { describe, expect, test } from "bun:test";
import type { CheckNote, TaskCommit } from "./spec-git";
import type { Plan, RiskEntry, RiskField, TaskBlock } from "./spec-plan";
import { RISK_FIELDS } from "./spec-risk";
import { type StoryStatus, type TaskState, computeStatus, formatStatusLine } from "./spec-status";

const REPO = "org/backend";

function task(id: string, depends_on: string[] = [], repo = REPO): TaskBlock {
	const risk = {} as Record<RiskField, RiskEntry>;
	for (const field of RISK_FIELDS) risk[field] = { value: "no" };
	return {
		id, repo, depends_on, foundation: false, owns: [], new_paths: [], reads: [], risk, lld_required: false,
		security_review: false, size: "normal", required_tests: [], acceptance: ["it works"],
	};
}

const plan = (tasks: TaskBlock[]): Plan => ({ id: "S-1", kind: "story", shared_paths: [], checks: {}, tasks });

const commit = (sha: string, tasks: string[], locks: string[] = []): TaskCommit => ({ sha, tasks, locks });

const PASSING = { tests: "pass", typecheck: "pass", lint: "skip", guard: "pass" } as const;

function note(over: Partial<CheckNote> = {}): CheckNote {
	return { v: 1, task: "T1", plan_rev: "abc", checks: { ...PASSING }, attempts: 1, blocked: false, reason: "", at: "2026-11-04T05:00:00Z", ...over };
}

/** Status of `plan` with the given commits (all in REPO, oldest first) and notes by sha. */
function statusOf(tasks: TaskBlock[], commits: TaskCommit[], notes: Record<string, CheckNote> = {}, prs?: Map<string, boolean>): StoryStatus {
	return computeStatus(plan(tasks), new Map([[REPO, commits]]), (_repo, sha) => notes[sha], prs);
}

const states = (status: StoryStatus): TaskState[] => status.tasks.map(t => t.state);

describe("computeStatus: per-task state machine", () => {
	test("ready: no commits and no dependencies", () => {
		expect(statusOf([task("T1")], []).tasks).toEqual([{ id: "T1", state: "ready" }]);
	});

	test("waiting vs ready through a dependency chain", () => {
		const chain = [task("T1"), task("T2", ["T1"]), task("T3", ["T2"])];
		expect(states(statusOf(chain, []))).toEqual(["ready", "waiting", "waiting"]);
		// T1 started but not done: T2 still waits.
		expect(states(statusOf(chain, [commit("a1", ["T1"])]))).toEqual(["awaiting-lock", "waiting", "waiting"]);
		const t1Done = { a1: note() };
		expect(states(statusOf(chain, [commit("a1", ["T1"], ["T1"])], t1Done))).toEqual(["done", "ready", "waiting"]);
		const t2Done = { a1: note(), b1: note({ task: "T2" }) };
		expect(states(statusOf(chain, [commit("a1", ["T1"], ["T1"]), commit("b1", ["T2"], ["T2"])], t2Done))).toEqual(["done", "done", "ready"]);
	});

	test("waiting while any one of several dependencies is not done", () => {
		const tasks = [task("T1"), task("T2"), task("T3", ["T1", "T2"])];
		const commits = [commit("a1", ["T1"], ["T1"])];
		expect(states(statusOf(tasks, commits, { a1: note() }))).toEqual(["done", "ready", "waiting"]);
	});

	test("a dependency listed later in the plan still gates its dependent", () => {
		expect(states(statusOf([task("T1", ["T2"]), task("T2")], []))).toEqual(["waiting", "ready"]);
	});

	test("awaiting-lock: commits but no Task-Lock commit", () => {
		const status = statusOf([task("T1")], [commit("a1", ["T1"])]);
		expect(status.tasks).toEqual([{ id: "T1", state: "awaiting-lock", lastSha: "a1" }]);
	});

	test("checking: a lock commit and a last commit without a note", () => {
		const status = statusOf([task("T1")], [commit("a1", ["T1"], ["T1"])]);
		expect(status.tasks).toEqual([{ id: "T1", state: "checking", lastSha: "a1" }]);
	});

	test("failing: the last commit's note has a fail, reason names the checks", () => {
		const failing = note({ checks: { tests: "fail", typecheck: "pass", lint: "fail", guard: "pass" }, attempts: 2 });
		const status = statusOf([task("T1")], [commit("a1", ["T1"], ["T1"])], { a1: failing });
		expect(status.tasks).toEqual([{ id: "T1", state: "failing", lastSha: "a1", reason: "tests, lint", attempts: 2 }]);
	});

	test("done: every check pass or skip and guard pass", () => {
		const status = statusOf([task("T1")], [commit("a1", ["T1"], ["T1"])], { a1: note({ attempts: 3 }) });
		expect(status.tasks).toEqual([{ id: "T1", state: "done", lastSha: "a1", attempts: 3 }]);
	});

	test("not done without a passing guard", () => {
		const commits = [commit("a1", ["T1"], ["T1"])];
		const skipped = note({ checks: { tests: "pass", guard: "skip" } });
		expect(states(statusOf([task("T1")], commits, { a1: skipped }))).toEqual(["checking"]);
		const missing = note({ checks: { tests: "pass" } });
		expect(states(statusOf([task("T1")], commits, { a1: missing }))).toEqual(["checking"]);
	});

	test("blocked: the latest note has blocked: true, with its reason", () => {
		const blocked = note({ blocked: true, reason: "test_wrong", checks: { tests: "fail", guard: "pass" }, attempts: 4 });
		const status = statusOf([task("T1")], [commit("a1", ["T1"], ["T1"])], { a1: blocked });
		expect(status.tasks).toEqual([{ id: "T1", state: "blocked", lastSha: "a1", reason: "test_wrong", attempts: 4 }]);
	});

	test("blocked wins over a note whose checks all pass (blocked > done)", () => {
		const blocked = note({ blocked: true, reason: "need_clarification" });
		expect(states(statusOf([task("T1")], [commit("a1", ["T1"], ["T1"])], { a1: blocked }))).toEqual(["blocked"]);
	});

	test("blocked wins over failing and over a missing lock (blocked > failing, awaiting-lock)", () => {
		const blocked = note({ blocked: true, reason: "spec_wrong", checks: { tests: "fail", guard: "fail" } });
		expect(states(statusOf([task("T1")], [commit("a1", ["T1"], ["T1"])], { a1: blocked }))).toEqual(["blocked"]);
		expect(states(statusOf([task("T1")], [commit("a1", ["T1"])], { a1: blocked }))).toEqual(["blocked"]);
	});

	test("blocked on an earlier commit holds until a later note replaces it", () => {
		const commits = [commit("a1", ["T1"], ["T1"]), commit("a2", ["T1"])];
		const blocked = note({ blocked: true, reason: "blocked" });
		expect(states(statusOf([task("T1")], commits, { a1: blocked }))).toEqual(["blocked"]);
		expect(states(statusOf([task("T1")], commits, { a1: blocked, a2: note() }))).toEqual(["done"]);
	});

	test("failing wins over checking and awaiting-lock (failing > checking > awaiting-lock)", () => {
		const failing = note({ checks: { tests: "fail", guard: "pass" } });
		expect(states(statusOf([task("T1")], [commit("a1", ["T1"], ["T1"])], { a1: failing }))).toEqual(["failing"]);
		expect(states(statusOf([task("T1")], [commit("a1", ["T1"])], { a1: failing }))).toEqual(["failing"]);
		expect(states(statusOf([task("T1")], [commit("a1", ["T1"], ["T1"])]))).toEqual(["checking"]);
		expect(states(statusOf([task("T1")], [commit("a1", ["T1"])]))).toEqual(["awaiting-lock"]);
	});

	test("done wins when the lock commit is missing but the last commit passed (done > awaiting-lock)", () => {
		expect(states(statusOf([task("T1")], [commit("a1", ["T1"])], { a1: note() }))).toEqual(["done"]);
	});

	test("a note on an older commit never makes the task done", () => {
		const commits = [commit("a1", ["T1"], ["T1"]), commit("a2", ["T1"])];
		const status = statusOf([task("T1")], commits, { a1: note() });
		expect(status.tasks).toEqual([{ id: "T1", state: "checking", lastSha: "a2", attempts: 1 }]);
		// An older failing note does not fail the task once a newer commit exists either.
		const olderFailing = note({ checks: { tests: "fail", guard: "pass" } });
		expect(states(statusOf([task("T1")], commits, { a1: olderFailing }))).toEqual(["checking"]);
	});

	test("lock commit earlier in the task's commits still counts after later commits", () => {
		const commits = [commit("a1", ["T1"], ["T1"]), commit("a2", ["T1"])];
		expect(states(statusOf([task("T1")], commits))).toEqual(["checking"]);
	});

	test("a commit with several Task values counts for each of them", () => {
		const commits = [commit("a1", ["T1", "T2"], ["T1", "T2"])];
		const status = statusOf([task("T1"), task("T2")], commits, { a1: note() });
		expect(states(status)).toEqual(["done", "done"]);
		expect(status.tasks.map(t => t.lastSha)).toEqual(["a1", "a1"]);
	});

	test("commits of other tasks and unknown ids are ignored; commits are matched per repo", () => {
		const tasks = [task("T1"), task("T2", [], "org/frontend")];
		const status = computeStatus(
			plan(tasks),
			new Map([
				[REPO, [commit("a1", ["T9"]), commit("a2", ["T2"], ["T2"])]],
				["org/frontend", [commit("b1", ["T1"], ["T1"])]],
			]),
			() => note(),
		);
		expect(states(status)).toEqual(["ready", "ready"]);
	});

	test("a repo without commits yields ready tasks", () => {
		const status = computeStatus(plan([task("T1")]), new Map(), () => undefined);
		expect(states(status)).toEqual(["ready"]);
	});

	test("output follows plan task order and notes are read once per commit", () => {
		const reads: string[] = [];
		const commits = [commit("a1", ["T2"], ["T2"]), commit("a2", ["T1"], ["T1"]), commit("a3", ["T1"])];
		const status = computeStatus(plan([task("T1"), task("T2")]), new Map([[REPO, commits]]), (repo, sha) => {
			reads.push(`${repo}:${sha}`);
			return undefined;
		});
		expect(status.tasks.map(t => t.id)).toEqual(["T1", "T2"]);
		expect(new Set(reads).size).toBe(reads.length);
	});
});

describe("computeStatus: story state", () => {
	const doneAll = [commit("a1", ["T1"], ["T1"]), commit("b1", ["T2"], ["T2"])];
	const notes: Record<string, CheckNote> = { a1: note(), b1: note({ task: "T2" }) };

	test("in-progress while any task is not done", () => {
		const status = statusOf([task("T1"), task("T2")], [doneAll[0]], notes);
		expect(status.state).toBe("in-progress");
		expect(status.id).toBe("S-1");
	});

	test("tasks-done when every task is done and PRs are not checked", () => {
		expect(statusOf([task("T1"), task("T2")], doneAll, notes).state).toBe("tasks-done");
	});

	test("done only when every repo's PR is merged", () => {
		const tasks = [task("T1"), task("T2", [], "org/frontend")];
		const status = (prs: Map<string, boolean>) =>
			computeStatus(
				plan(tasks),
				new Map([[REPO, [doneAll[0]]], ["org/frontend", [doneAll[1]]]]),
				(_repo, sha) => notes[sha],
				prs,
			);
		expect(status(new Map([[REPO, true], ["org/frontend", true]])).state).toBe("done");
		expect(status(new Map([[REPO, true], ["org/frontend", false]])).state).toBe("tasks-done");
		expect(status(new Map([[REPO, true]])).state).toBe("tasks-done");
	});

	test("a merged PR does not finish a story with unfinished tasks", () => {
		expect(statusOf([task("T1"), task("T2")], [doneAll[0]], notes, new Map([[REPO, true]])).state).toBe("in-progress");
	});
});

describe("formatStatusLine", () => {
	const status = (tasks: StoryStatus["tasks"], state: StoryStatus["state"] = "in-progress"): StoryStatus => ({ id: "PAC2-1234", state, tasks });

	test("counts done and groups the other states, listing blocked reasons", () => {
		const line = formatStatusLine(
			status([
				{ id: "PAC2-1234-T01", state: "done" },
				{ id: "PAC2-1234-T02", state: "done" },
				{ id: "PAC2-1234-T03", state: "done" },
				{ id: "PAC2-1234-T04", state: "blocked", reason: "test_wrong" },
				{ id: "PAC2-1234-T05", state: "checking" },
			]),
		);
		expect(line).toBe("PAC2-1234 ▸ 3/5 done · 1 checking · 1 blocked (T04: test_wrong)");
	});

	test("lists every non-done state and several blocked tasks", () => {
		const line = formatStatusLine(
			status([
				{ id: "T1", state: "failing" },
				{ id: "T2", state: "awaiting-lock" },
				{ id: "T3", state: "ready" },
				{ id: "T4", state: "waiting" },
				{ id: "T5", state: "blocked" },
				{ id: "T6", state: "blocked", reason: "spec_wrong" },
			]),
		);
		expect(line).toBe("PAC2-1234 ▸ 0/6 done · 1 failing · 1 awaiting lock · 1 ready · 1 waiting · 2 blocked (T5, T6: spec_wrong)");
	});

	test("a finished story reads as done, and as merged once PRs are merged", () => {
		const tasks: StoryStatus["tasks"] = [{ id: "T1", state: "done" }];
		expect(formatStatusLine(status(tasks, "tasks-done"))).toBe("PAC2-1234 ▸ 1/1 done");
		expect(formatStatusLine(status(tasks, "done"))).toBe("PAC2-1234 ▸ 1/1 done · merged");
	});
});
