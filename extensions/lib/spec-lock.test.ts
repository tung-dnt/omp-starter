import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadGuardInput, readCommitDiff, readCommitFacts } from "./spec-diff";
import { cleanScratch, commit, commitFiles, git, initRepo, initVault, planText } from "./spec-fixtures";
import { guardCommits } from "./spec-guard";
import { type LockOptions, assertRepoPath, lockCommit, lockedFilesAt, unlockCommit } from "./spec-lock";

afterEach(cleanScratch);

const REV = "eb6b565";

/** A repo on branch PAC-1 with a test file for T1 and one for T2, both committed. */
function world() {
	const repo = initRepo();
	git(repo, "checkout", "-q", "-b", "PAC-1");
	commitFiles(repo, { "test/a.test.ts": "a\n", "test/b.test.ts": "b\n", "test/c.test.ts": "c\n" }, "tests", "Task: T1", `Plan-Rev: ${REV}`);
	return repo;
}

describe("lockCommit", () => {
	test("writes an empty commit with the Task, Plan-Rev, Task-Lock and Locked trailers", () => {
		const repo = world();
		const sha = lockCommit(repo, { task: "T1", planRev: REV, files: ["test/a.test.ts", "test/b.test.ts"] });
		expect(sha).toBe(git(repo, "rev-parse", "HEAD"));
		expect(git(repo, "log", "-1", "--format=%B", sha)).toBe(
			["chore(spec): lock the tests of T1", "", "Task: T1", `Plan-Rev: ${REV}`, "Task-Lock: T1", "Locked: test/a.test.ts", "Locked: test/b.test.ts"].join("\n"),
		);
		expect(readCommitDiff(repo, sha)).toEqual({ changes: [], added: [] });
		expect(readCommitFacts(repo, "main", "PAC-1").at(-1)).toEqual({
			sha, merge: false, tasks: ["T1"], planRev: REV, locks: ["T1"], locked: ["test/a.test.ts", "test/b.test.ts"], unlocks: [],
		});
	});

	test("a repeated file is locked once", () => {
		const repo = world();
		const sha = lockCommit(repo, { task: "T1", planRev: REV, files: ["test/a.test.ts", "test/a.test.ts"] });
		expect(readCommitFacts(repo, "main", sha).at(-1)?.locked).toEqual(["test/a.test.ts"]);
	});

	test("refuses nothing to lock, unsafe paths, and values that could forge another trailer", () => {
		const repo = world();
		const before = git(repo, "rev-parse", "HEAD");
		const good = { task: "T1", planRev: REV, files: ["test/a.test.ts"] };
		const bad: Array<[LockOptions, RegExp]> = [
			[{ ...good, files: [] }, /at least one test file/],
			[{ ...good, files: ["/etc/passwd"] }, /relative path/],
			[{ ...good, files: ["../outside.test.ts"] }, /relative path/],
			[{ ...good, files: ["test/../../x"] }, /relative path/],
			[{ ...good, files: ["--force"] }, /relative path/],
			[{ ...good, files: ["test/a.test.ts\nTask-Unlock: T1"] }, /one non-empty line/],
			[{ ...good, files: [" test/a.test.ts"] }, /one non-empty line/],
			[{ ...good, files: [""] }, /one non-empty line/],
			[{ ...good, task: "T1\nTask-Unlock: T1" }, /task must be one non-empty line/],
			[{ ...good, planRev: "abc\r\nTask-Unlock: T1" }, /planRev must be one non-empty line/],
		];
		for (const [options, message] of bad) expect(() => lockCommit(repo, options)).toThrow(message);
		expect(git(repo, "rev-parse", "HEAD")).toBe(before);
	});

	test("staged changes would ride along, so they refuse the commit", () => {
		const repo = world();
		const before = git(repo, "rev-parse", "HEAD");
		writeFileSync(join(repo, "src/a.ts"), "export const a = 99;\n");
		git(repo, "add", "src/a.ts");
		expect(() => lockCommit(repo, { task: "T1", planRev: REV, files: ["test/a.test.ts"] })).toThrow(/staged changes/);
		expect(git(repo, "rev-parse", "HEAD")).toBe(before);
	});

	test("unstaged edits are not committed, and repo hooks do not block the empty commit", () => {
		const repo = world();
		writeFileSync(join(repo, "src/a.ts"), "export const a = 99;\n");
		const hook = join(repo, ".git/hooks/commit-msg");
		writeFileSync(hook, "#!/bin/sh\nexit 1\n");
		chmodSync(hook, 0o755);
		const sha = lockCommit(repo, { task: "T1", planRev: REV, files: ["test/a.test.ts"] });
		expect(readCommitDiff(repo, sha).changes).toEqual([]);
		expect(git(repo, "status", "--porcelain")).toBe("M src/a.ts");
	});
});

describe("unlockCommit", () => {
	test("writes an empty commit with the Task, Plan-Rev, Task-Unlock and Unlock-Gate trailers", () => {
		const repo = world();
		const sha = unlockCommit(repo, { task: "T1", planRev: REV, gate: "G-7" });
		expect(git(repo, "log", "-1", "--format=%B", sha)).toBe(["chore(spec): unlock the tests of T1", "", "Task: T1", `Plan-Rev: ${REV}`, "Task-Unlock: T1", "Unlock-Gate: G-7"].join("\n"));
		expect(readCommitDiff(repo, sha).changes).toEqual([]);
		expect(readCommitFacts(repo, "main", "PAC-1").at(-1)).toMatchObject({ sha, tasks: ["T1"], unlocks: ["T1"], locks: [], locked: [] });
	});

	test("refuses a gate or task that could forge a trailer, and staged changes", () => {
		const repo = world();
		expect(() => unlockCommit(repo, { task: "T1", planRev: REV, gate: "G-7\nTask-Lock: T1" })).toThrow(/gate must be one non-empty line/);
		expect(() => unlockCommit(repo, { task: "", planRev: REV, gate: "G-7" })).toThrow(/task must be/);
		writeFileSync(join(repo, "x.txt"), "x\n");
		git(repo, "add", "x.txt");
		expect(() => unlockCommit(repo, { task: "T1", planRev: REV, gate: "G-7" })).toThrow(/staged changes/);
	});
});

describe("lockedFilesAt", () => {
	test("follows lock, unlock and relock in commit order, for all tasks or one", () => {
		const repo = world();
		expect(lockedFilesAt(repo, "main", "HEAD")).toEqual([]);
		lockCommit(repo, { task: "T1", planRev: REV, files: ["test/a.test.ts", "test/b.test.ts"] });
		const t1Only = git(repo, "rev-parse", "HEAD");
		lockCommit(repo, { task: "T2", planRev: REV, files: ["test/c.test.ts"] });
		expect(lockedFilesAt(repo, "main", "HEAD")).toEqual(["test/a.test.ts", "test/b.test.ts", "test/c.test.ts"]);
		expect(lockedFilesAt(repo, "main", "HEAD", "T2")).toEqual(["test/c.test.ts"]);
		expect(lockedFilesAt(repo, "main", t1Only)).toEqual(["test/a.test.ts", "test/b.test.ts"]);

		unlockCommit(repo, { task: "T1", planRev: REV, gate: "G-1" });
		expect(lockedFilesAt(repo, "main", "HEAD")).toEqual(["test/c.test.ts"]);
		expect(lockedFilesAt(repo, "main", "HEAD", "T1")).toEqual([]);

		lockCommit(repo, { task: "T1", planRev: REV, files: ["test/b.test.ts"] });
		expect(lockedFilesAt(repo, "main", "HEAD")).toEqual(["test/b.test.ts", "test/c.test.ts"]);
	});

	test("only commits after the base count", () => {
		const repo = world();
		const lock = lockCommit(repo, { task: "T1", planRev: REV, files: ["test/a.test.ts"] });
		commit(repo, "later", "Task: T1", `Plan-Rev: ${REV}`);
		expect(lockedFilesAt(repo, lock, "HEAD")).toEqual([]);
		expect(lockedFilesAt(repo, "main", "HEAD")).toEqual(["test/a.test.ts"]);
	});
});

describe("assertRepoPath", () => {
	test("accepts a plain relative path and returns it", () => {
		expect(assertRepoPath("file", "pkg/a_test.go")).toBe("pkg/a_test.go");
		expect(assertRepoPath("file", "web/[id]/page.test.tsx")).toBe("web/[id]/page.test.tsx");
	});
});

describe("lock, unlock and the guard on real commits", () => {
	/** A vault holding T1's plan, a repo on PAC-1 with T1's tests, and the guard's verdict for PAC-1. */
	function guarded() {
		const repo = initRepo("git@github.com:org/backend.git");
		const vault = initVault();
		const planPath = "Specs/S/plan.md";
		const rev = vault.commitPlan(planPath, planText({ tasks: [{ id: "T1", owns: ["src/**"], new_paths: ["test/"] }] }));
		git(repo, "checkout", "-q", "-b", "PAC-1");
		commitFiles(repo, { "test/a.test.ts": "expect(1)\n" }, "tests", "Task: T1", `Plan-Rev: ${rev}`);
		const verdict = () => guardCommits(loadGuardInput({ repo, from: "main", to: "PAC-1", vaultGitDir: vault.gitDir, planPath }, true)).map(v => `${v.rule}:${v.path ?? ""}`);
		return { repo, rev, verdict };
	}

	test("a locked test cannot change until an unlock commit opens it, and a new lock closes it again", () => {
		const { repo, rev, verdict } = guarded();
		expect(verdict()).toEqual([]);
		lockCommit(repo, { task: "T1", planRev: rev, files: ["test/a.test.ts"] });
		commitFiles(repo, { "src/a.ts": "export const a = 2;\n" }, "implement", "Task: T1", `Plan-Rev: ${rev}`);
		expect(verdict()).toEqual([]);

		commitFiles(repo, { "test/a.test.ts": "expect(2)\n" }, "weaken", "Task: T1", `Plan-Rev: ${rev}`);
		expect(verdict()).toEqual(["locked-test-changed:test/a.test.ts"]);

		unlockCommit(repo, { task: "T1", planRev: rev, gate: "G-1" });
		commitFiles(repo, { "test/a.test.ts": "expect(3)\n" }, "fix the test", "Task: T1", `Plan-Rev: ${rev}`);
		expect(verdict()).toEqual(["locked-test-changed:test/a.test.ts"]);

		lockCommit(repo, { task: "T1", planRev: rev, files: ["test/a.test.ts"] });
		commitFiles(repo, { "test/a.test.ts": "expect(4)\n" }, "tamper again", "Task: T1", `Plan-Rev: ${rev}`);
		expect(verdict()).toEqual(["locked-test-changed:test/a.test.ts", "locked-test-changed:test/a.test.ts"]);
	});
});
