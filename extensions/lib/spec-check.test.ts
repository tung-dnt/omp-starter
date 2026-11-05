import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CHECK_NAMES, checkCommit, failsBefore, runChecks, withWorktree } from "./spec-check";
import { loadGuardInput } from "./spec-diff";
import { PLAN_PATH, cleanScratch, commit, git, initRepo, planText, scratch, storyWorld as world } from "./spec-fixtures";
import { guardCommits } from "./spec-guard";
import { readCheckNote, readTaskCommits } from "./spec-git";
import { lockCommit } from "./spec-lock";
import { computeStatus } from "./spec-status";
import { parsePlan } from "./spec-plan";

afterEach(cleanScratch);

const worktrees = (repo: string): number => git(repo, "worktree", "list", "--porcelain").split("\n").filter(line => line.startsWith("worktree ")).length;

describe("withWorktree", () => {
	test("gives a detached checkout of the rev and removes it with its metadata afterwards", async () => {
		const { repo, work } = world();
		const sha = work({ "src/a.ts": "export const a = 2;\n" });
		writeFileSync(join(repo, "src/a.ts"), "uncommitted\n");
		let seen = "";
		let where = "";
		await withWorktree(repo, sha, async dir => {
			where = dir;
			seen = readFileSync(join(dir, "src/a.ts"), "utf8");
			expect(worktrees(repo)).toBe(2);
		});
		expect(seen).toBe("export const a = 2;\n");
		expect(existsSync(where)).toBe(false);
		expect(worktrees(repo)).toBe(1);
		expect(readFileSync(join(repo, "src/a.ts"), "utf8")).toBe("uncommitted\n");
	});

	test("cleans up when the callback throws, and does not run the repo's post-checkout hook", async () => {
		const repo = initRepo();
		const marker = join(scratch(), "hook-ran");
		const hook = join(repo, ".git/hooks/post-checkout");
		writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\n`);
		chmodSync(hook, 0o755);
		let where = "";
		await expect(
			withWorktree(repo, "main", async dir => {
				where = dir;
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		expect(existsSync(where)).toBe(false);
		expect(worktrees(repo)).toBe(1);
		expect(existsSync(marker)).toBe(false);
	});

	test("an unknown rev throws and leaves nothing behind", async () => {
		const repo = initRepo();
		await expect(withWorktree(repo, "no-such-rev", async () => undefined)).rejects.toThrow(/git worktree failed/);
		expect(worktrees(repo)).toBe(1);
	});
});

describe("runChecks", () => {
	test("pass, fail and skip per check; every check runs even after a failure", async () => {
		const { repo, work } = world();
		const sha = work({ "src/a.ts": "export const a = 2;\n" });
		const results = await runChecks(repo, sha, { test: "exit 3", typecheck: "echo typed", lint: "   " });
		expect(results.map(r => [r.name, r.status])).toEqual([["test", "fail"], ["typecheck", "pass"], ["lint", "skip"]]);
		expect(results[0].reason).toBe("exit 3");
		expect(results[1]).toMatchObject({ output: "typed\n" });
		expect(results[2]).toMatchObject({ output: "", ms: 0 });
		expect(results.map(r => r.name)).toEqual([...CHECK_NAMES]);
	});

	test("a missing or empty command is a skip", async () => {
		const { repo, work } = world();
		const sha = work({ "src/a.ts": "export const a = 2;\n" });
		const results = await runChecks(repo, sha, { test: "true" });
		expect(results.map(r => r.status)).toEqual(["pass", "skip", "skip"]);
	});

	test("commands run in the worktree at that commit, with stderr folded into the output", async () => {
		const { repo, work } = world();
		const sha = work({ "src/a.ts": "export const a = 2;\n" });
		writeFileSync(join(repo, "src/a.ts"), "uncommitted\n");
		const [test] = await runChecks(repo, sha, { test: "pwd; cat src/a.ts; echo oops >&2; exit 1" });
		const [dir, line, err] = test.output.trim().split("\n");
		expect(dir).not.toBe(repo);
		expect(existsSync(dir)).toBe(false);
		expect(line).toBe("export const a = 2;");
		expect(err).toBe("oops");
		expect(worktrees(repo)).toBe(1);
	});

	test("a command that outlives its timeout fails with reason timeout, its whole process group dies with it, and the worktree goes", async () => {
		const { repo, work } = world();
		const sha = work({ "src/a.ts": "export const a = 2;\n" });
		const started = Date.now();
		// The background sleep holds the output pipe: had only the shell been killed, the run would wait out the 2 s pipe grace.
		const results = await runChecks(repo, sha, { test: "sleep 31.7 & sleep 31.8; echo never", typecheck: "true" }, { timeoutMs: 100 });
		expect(Date.now() - started).toBeLessThan(1_900);
		expect(results[0]).toMatchObject({ name: "test", status: "fail", reason: "timeout" });
		expect(results[0].output).not.toContain("never");
		expect(results[1].status).toBe("pass");
		expect(worktrees(repo)).toBe(1);
	});

	test("the environment carries no variable that names a repository", async () => {
		const { repo, work } = world();
		const sha = work({ "src/a.ts": "export const a = 2;\n" });
		const saved = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE };
		process.env.GIT_DIR = join(scratch(), "elsewhere");
		process.env.GIT_WORK_TREE = scratch();
		try {
			const [test] = await runChecks(repo, sha, { test: 'test -z "$GIT_DIR" && test -z "$GIT_WORK_TREE" && git rev-parse --show-toplevel' });
			expect(test.status).toBe("pass");
		} finally {
			for (const [key, value] of Object.entries(saved)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	});

	test("an output longer than the tail keeps its end", async () => {
		const { repo, work } = world();
		const sha = work({ "src/a.ts": "export const a = 2;\n" });
		const [test] = await runChecks(repo, sha, { test: "i=0; while [ $i -lt 20000 ]; do echo line-$i; i=$((i+1)); done; exit 1" });
		expect(test.output.length).toBeLessThanOrEqual(32_768);
		expect(test.output.trimEnd().endsWith("line-19999")).toBe(true);
	});
});

describe("checkCommit", () => {
	test("a passing commit gets a note with every check and the guard, and status reads it as done", async () => {
		const { repo, work, rev, options } = world();
		const sha = work({ "src/a.ts": "export const a = 2;\n", "t/a.sh": "exit 0\n" });
		const report = await checkCommit(repo, sha, options);
		expect(report).toMatchObject({ sha, task: "T1", attempts: 1, ok: true, violations: [] });
		const note = readCheckNote(repo, sha);
		if (!note) throw new Error("no note was written");
		expect(note).toMatchObject({ v: 1, task: "T1", plan_rev: rev, checks: { test: "pass", typecheck: "pass", lint: "skip", guard: "pass" }, attempts: 1, blocked: false, reason: "" });
		expect(new Date(note.at).toISOString()).toBe(note.at);
		expect(report.note).toEqual(note);

		const parsed = parsePlan(planText({ tasks: [{ id: "T1", owns: ["src/**"], new_paths: ["t/"] }, { id: "T2", depends_on: ["T1"], owns: ["src/b.ts"] }] }));
		if (!parsed.ok) throw new Error("fixture plan does not parse");
		const status = computeStatus(parsed.plan, new Map([["org/backend", readTaskCommits(repo, "main", "PAC-1")]]), (_repo, at) => readCheckNote(repo, at));
		expect(status.tasks.map(t => `${t.id}:${t.state}`)).toEqual(["T1:done", "T2:ready"]);
		expect(worktrees(repo)).toBe(1);
	});

	test("onNoteWritten runs at the moment of the write, before checkCommit returns, with the sha and the notes tip (N8)", async () => {
		const { repo, work, options } = world();
		const sha = work({ "src/a.ts": "export const a = 2;\n", "t/a.sh": "exit 0\n" });
		const calls: Array<{ sha: string; tip: string; noteThere: boolean; tipNow: string }> = [];
		const report = await checkCommit(repo, sha, {
			...options,
			onNoteWritten: (written, tip) => void calls.push({ sha: written, tip, noteThere: readCheckNote(repo, written) !== undefined, tipNow: git(repo, "rev-parse", "refs/notes/spec-checks") }),
		});
		expect(report.ok).toBe(true);
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({ sha, noteThere: true });
		expect(calls[0].tip).toBe(calls[0].tipNow);
		expect(calls[0].tip).toBe(git(repo, "rev-parse", "refs/notes/spec-checks"));
	});

	test("a failing test gives a note with test: fail, and attempts count up over the task's commits", async () => {
		const { repo, work, options } = world();
		const bad = work({ "t/a.sh": "exit 1\n" }, "first try");
		const first = await checkCommit(repo, bad, options);
		expect(first).toMatchObject({ ok: false, attempts: 1 });
		expect(first.note.checks).toEqual({ test: "fail", typecheck: "pass", lint: "skip", guard: "pass" });
		expect(first.results[0]).toMatchObject({ status: "fail", reason: "exit 1" });

		const again = work({ "t/a.sh": "exit 1\n", "src/a.ts": "export const a = 5;\n" }, "second try");
		expect((await checkCommit(repo, again, options)).attempts).toBe(2);

		const fixed = work({ "t/a.sh": "exit 0\n" }, "third try");
		const third = await checkCommit(repo, fixed, options);
		expect(third).toMatchObject({ ok: true, attempts: 3 });
		expect(readCheckNote(repo, bad)?.attempts).toBe(1);
		expect(readCheckNote(repo, again)?.attempts).toBe(2);
		expect(readCheckNote(repo, fixed)?.attempts).toBe(3);
	});

	test("status reads the failing note as failing, then the next passing commit as done", async () => {
		const { repo, work, options } = world();
		const parsed = parsePlan(planText({ tasks: [{ id: "T1", owns: ["src/**"], new_paths: ["t/"] }, { id: "T2", depends_on: ["T1"], owns: ["src/b.ts"] }] }));
		if (!parsed.ok) throw new Error("fixture plan does not parse");
		const states = () =>
			computeStatus(parsed.plan, new Map([["org/backend", readTaskCommits(repo, "main", "PAC-1")]]), (_repo, at) => readCheckNote(repo, at)).tasks.map(t => `${t.id}:${t.state}:${t.attempts ?? ""}:${t.reason ?? ""}`);
		const bad = work({ "t/a.sh": "exit 1\n" });
		await checkCommit(repo, bad, options);
		expect(states()).toEqual(["T1:failing:1:test", "T2:waiting::"]);
		const good = work({ "t/a.sh": "exit 0\n" });
		await checkCommit(repo, good, options);
		expect(states()).toEqual(["T1:done:2:", "T2:ready::"]);
	});

	test("a rerun on the same commit replaces its note without counting a new attempt", async () => {
		const { repo, work, options } = world();
		const first = work({ "t/a.sh": "exit 1\n" });
		await checkCommit(repo, first, options);
		const second = work({ "t/a.sh": "exit 0\n" });
		expect((await checkCommit(repo, second, options)).attempts).toBe(2);
		expect((await checkCommit(repo, second, options)).attempts).toBe(2);
		expect(readCheckNote(repo, second)?.attempts).toBe(2);
	});

	test("the guard runs over the task's commits: a violation fails guard but the checks still run", async () => {
		const { repo, work, options } = world();
		const bad = work({ "src/a.ts": 'it.skip("x", f);\n', "docs/notes.md": "outside owns\n" });
		const report = await checkCommit(repo, bad, options);
		expect(report.ok).toBe(false);
		expect(report.note.checks).toEqual({ test: "pass", typecheck: "pass", lint: "skip", guard: "fail" });
		expect(report.violations.map(v => v.rule)).toEqual(["out-of-scope", "skip-added"]);
		expect(report.violations.every(v => v.sha === bad)).toBe(true);
	});

	test("another task's commits are not held against this task", async () => {
		const { repo, work, options } = world();
		work({ "docs/stray.md": "T1 wandered off\n" }, "T1 work", "T1");
		const t2 = work({ "src/b.ts": "export const b = 2;\n" }, "T2 work", "T2");
		const report = await checkCommit(repo, t2, options);
		expect(report.violations).toEqual([]);
		expect(report.note.checks.guard).toBe("pass");
		expect(report.attempts).toBe(1);
	});

	test("a locked test that changes fails the guard of the commit that changed it", async () => {
		const { repo, work, rev, options } = world();
		work({ "t/a.sh": "exit 1\n" });
		lockCommit(repo, { task: "T1", planRev: rev, files: ["t/a.sh"] });
		const tamper = work({ "t/a.sh": "exit 0\n" });
		const report = await checkCommit(repo, tamper, options);
		expect(report.violations.map(v => v.rule)).toEqual(["locked-test-changed"]);
		expect(report.note.checks.guard).toBe("fail");
	});

	test("Plan-Rev pinning: the checks and the scope come from the plan the commit names, not the latest one", async () => {
		const { repo, vault, work, text, rev: v1, options } = world({ test: "true" });
		const v2 = vault.commitPlan(PLAN_PATH, text({ test: "false" }, ["src/b.ts"]));
		expect(v2).not.toBe(v1);
		const old = work({ "src/a.ts": "export const a = 2;\n" }, "against v1", "T1", v1);
		const oldReport = await checkCommit(repo, old, options);
		expect(oldReport.ok).toBe(true);
		expect(oldReport.note.plan_rev).toBe(v1);
		const recent = work({ "src/a.ts": "export const a = 3;\n" }, "against v2", "T1", v2);
		const recentReport = await checkCommit(repo, recent, options);
		expect(recentReport.results[0].status).toBe("fail");
		expect(recentReport.violations.map(v => v.rule)).toEqual(["out-of-scope"]);
		expect(recentReport.note.plan_rev).toBe(v2);
		// The older commit still passes the guard, judged on its own pinned plan.
		const all = guardCommits(loadGuardInput({ repo, from: "main", to: "PAC-1", vaultGitDir: vault.gitDir, planPath: PLAN_PATH }, true));
		expect(all.map(v => v.sha)).toEqual([recent]);
	});

	test("it cannot run, and writes no note, when the commit or the plan do not say what to check", async () => {
		const { repo, vault, text, rev, options } = world();
		const noTask = commit(repo, "no trailers");
		const noRev = commit(repo, "no rev", "Task: T1");
		const several = commit(repo, "several", "Task: T1", "Task: T2", `Plan-Rev: ${rev}`);
		const unreadable = commit(repo, "bad rev", "Task: T1", "Plan-Rev: deadbeef");
		const unknownTask = commit(repo, "who", "Task: T9", `Plan-Rev: ${rev}`);
		const noChecks = vault.commitPlan(PLAN_PATH, text({ lint: "true" }));
		const missing = commit(repo, "no checks", "Task: T1", `Plan-Rev: ${noChecks}`);
		const unparsable = vault.commitPlan(PLAN_PATH, "no blocks\n");
		const broken = commit(repo, "broken plan", "Task: T1", `Plan-Rev: ${unparsable}`);
		const cases: Array<[string, RegExp]> = [
			[noTask, /has no Task: trailer/],
			[noRev, /has no Plan-Rev trailer/],
			[several, /serves several tasks \(T1, T2\)/],
			[unreadable, /Plan-Rev deadbeef of .*not a commit in the vault git dir/],
			[unknownTask, /Task: T9 .* is not in the plan/],
			[missing, /declares no checks\.test for org\/backend/],
			[broken, /does not parse/],
		];
		for (const [sha, message] of cases) {
			await expect(checkCommit(repo, sha, options)).rejects.toThrow(message);
			expect(readCheckNote(repo, sha)).toBeUndefined();
		}
		await expect(checkCommit(repo, "main", options)).rejects.toThrow(/is not in main\.\.|already part of the base/);
		await expect(checkCommit(repo, "no-such-rev", options)).rejects.toThrow(/git rev-parse failed/);
		await expect(checkCommit(repo, unknownTask, { ...options, base: "no-such-base" })).rejects.toThrow(/git log failed/);
		await expect(checkCommit(repo, unknownTask, { ...options, vaultGitDir: join(scratch(), "absent") })).rejects.toThrow(/vault git dir .* does not exist/);
		expect(worktrees(repo)).toBe(1);
	});
});

describe("failsBefore", () => {
	/** T2's work lands first; T1 adds its tests, then its implementation. Returns the shas of the three. */
	function story() {
		const w = world();
		const earlier = w.work({ "src/b.ts": "export const b = 2;\n" }, "T2 work", "T2");
		const tests = w.work({ "t/a.sh": "grep -q feature src/impl.txt\n", "t/b.sh": "exit 0\n", "t/other.sh": "exit 1\n" }, "T1 tests", "T1");
		const impl = w.work({ "src/impl.txt": "feature\n" }, "T1 implementation", "T1");
		return { ...w, earlier, tests, impl };
	}

	test("accepts a new test that fails on the task base, refuses one that already passes, and reports each file", async () => {
		const { repo, impl, tests, earlier } = story();
		const ok = await failsBefore(repo, impl, ["t/a.sh"], "sh {files}", { base: "main" });
		expect(ok).toMatchObject({ ok: true, base: earlier });
		expect(ok.files).toEqual([{ file: "t/a.sh", status: "fails", reason: "exit 2", output: "grep: src/impl.txt: No such file or directory\n" }]);

		const mixed = await failsBefore(repo, impl, ["t/a.sh", "t/b.sh"], "sh {files}", { base: "main" });
		expect(mixed.ok).toBe(false);
		expect(mixed.files.map(f => `${f.file}:${f.status}`)).toEqual(["t/a.sh:fails", "t/b.sh:already-passes"]);
		expect(mixed.files[1].reason).toBeUndefined();
		// The parent of the task's first commit is the base, whichever commit holds the tests.
		expect((await failsBefore(repo, tests, ["t/a.sh"], "sh {files}", { base: "main" })).base).toBe(earlier);
		expect(worktrees(repo)).toBe(1);
	});

	test("the base is the parent of the task's first commit, so work the task already had in place is not counted", async () => {
		const w = world();
		w.work({ "src/impl.txt": "feature\n", "t/a.sh": "grep -q feature src/impl.txt\n" }, "T1 does it all at once", "T1");
		const tip = w.work({ "src/c.ts": "export const c = 1;\n" }, "T1 more", "T1");
		// On the task's own commits the test passes; on the base (before T1) there is no impl.txt.
		const result = await failsBefore(w.repo, tip, ["t/a.sh"], "sh {files}", { base: "main" });
		expect(result.ok).toBe(true);
		expect(result.base).toBe(git(w.repo, "rev-parse", "main"));
	});

	test("only the locked files are copied onto the base", async () => {
		const { repo, impl } = story();
		const result = await failsBefore(repo, impl, ["t/a.sh"], "ls t; exit 1", { base: "main" });
		expect(result.files[0].output.trim()).toBe("a.sh");
	});

	test("{packages} is the file's directory, files that share a command run once, and a command without a placeholder runs once for all", async () => {
		const { repo, impl } = story();
		const perPackage = await failsBefore(repo, impl, ["t/a.sh", "t/b.sh"], "echo run >> runs.log; cat runs.log; echo pkg={packages}; exit 1", { base: "main" });
		expect(perPackage.files.map(f => f.output)).toEqual(["run\npkg=./t\n", "run\npkg=./t\n"]);
		const perFile = await failsBefore(repo, impl, ["t/a.sh", "t/b.sh"], "echo run >> runs.log; cat runs.log; echo f={files}; exit 1", { base: "main" });
		// Every file's run happens in the same worktree one after the other, so the log keeps growing.
		expect(perFile.files.map(f => f.output)).toEqual(["run\nf=t/a.sh\n", "run\nrun\nf=t/b.sh\n"]);
		const suite = await failsBefore(repo, impl, ["t/a.sh", "t/b.sh"], "echo run >> runs.log; cat runs.log; exit 1", { base: "main" });
		expect(suite.files.map(f => f.output)).toEqual(["run\n", "run\n"]);
		expect(suite.ok).toBe(true);
		const passing = await failsBefore(repo, impl, ["t/a.sh", "t/b.sh"], "true", { base: "main" });
		expect(passing.files.map(f => f.status)).toEqual(["already-passes", "already-passes"]);
		// A file at the repo root has the package `.`.
		const w = world();
		const rootTest = w.work({ "root.sh": "exit 1\n" }, "root test", "T1");
		const root = await failsBefore(w.repo, rootTest, ["root.sh"], "echo pkg={packages}; exit 1", { base: "main" });
		expect(root.files[0].output).toBe("pkg=.\n");
	});

	test("paths with spaces, quotes and shell characters are passed as one quoted word", async () => {
		const w = world();
		const odd = "t/it's $(touch pwned) a test.sh";
		const sha = w.work({ [odd]: "exit 1\n" }, "odd name", "T1");
		const result = await failsBefore(w.repo, sha, [odd], "sh {files}", { base: "main" });
		expect(result).toMatchObject({ ok: true });
		expect(result.files[0]).toMatchObject({ file: odd, status: "fails", reason: "exit 1" });
	});

	test("a run that times out counts as failing before", async () => {
		const { repo, impl } = story();
		const result = await failsBefore(repo, impl, ["t/a.sh"], "sleep 30", { base: "main", timeoutMs: 300 });
		expect(result.ok).toBe(true);
		expect(result.files[0]).toMatchObject({ status: "fails", reason: "timeout" });
	});

	test("it refuses bad input and leaves no worktree behind", async () => {
		const { repo, impl } = story();
		const several = commit(repo, "serves two", "Task: T1", "Task: T2");
		const fail = (promise: Promise<unknown>, message: RegExp) => expect(promise).rejects.toThrow(message);
		await fail(failsBefore(repo, impl, [], "sh {files}", { base: "main" }), /at least one locked test file/);
		await fail(failsBefore(repo, impl, ["t/a.sh"], "  ", { base: "main" }), /needs a command/);
		await fail(failsBefore(repo, impl, ["../outside.sh"], "sh {files}", { base: "main" }), /relative path/);
		await fail(failsBefore(repo, impl, ["/etc/passwd"], "sh {files}", { base: "main" }), /relative path/);
		await fail(failsBefore(repo, impl, ["-rf"], "sh {files}", { base: "main" }), /relative path/);
		await fail(failsBefore(repo, impl, ["t/missing.sh"], "sh {files}", { base: "main" }), /git checkout failed/);
		await fail(failsBefore(repo, impl, ["t/a.sh"], "sh {files}", { base: "main", task: "T9" }), /no commit of T9/);
		await fail(failsBefore(repo, several, ["t/a.sh"], "sh {files}", { base: "main" }), /exactly one Task: trailer \(found 2\)/);
		await fail(failsBefore(repo, "no-such-rev", ["t/a.sh"], "sh {files}", { base: "main" }), /git rev-parse failed/);
		expect((await failsBefore(repo, several, ["t/a.sh"], "sh {files}", { base: "main", task: "T1" })).ok).toBe(true);
		expect(worktrees(repo)).toBe(1);
	});
});
