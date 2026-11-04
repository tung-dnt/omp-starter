import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_VAULT_GIT_DIR, type PlanReaderOptions, loadGuardInput, planReader, readCommitDiff, readCommitFacts, readRange } from "./spec-diff";
import { cleanScratch, commit, commitFiles, git, initRepo, initVault, planText, scratch } from "./spec-fixtures";

afterEach(cleanScratch);

const PLAN_PATH = "Specs/S/plan.md";

describe("readCommitFacts", () => {
	test("reads the trailers of from..to, oldest first, and leaves out the base", () => {
		const repo = initRepo();
		git(repo, "checkout", "-q", "-b", "PAC-1");
		const first = commit(repo, "first", "Task: T1", "Plan-Rev: eb6b565");
		const lock = commit(repo, "lock", "Task: T1", "Plan-Rev: eb6b565", "Task-Lock: T1", "Locked: test/a.test.ts", "Locked: test/b, c.test.ts");
		const unlock = commit(repo, "unlock", "Task: T1", "Plan-Rev: eb6b565", "Task-Unlock: T1", "Unlock-Gate: G-7");
		const plain = commit(repo, "no trailers");
		expect(readCommitFacts(repo, "main", "PAC-1")).toEqual([
			{ sha: first, merge: false, tasks: ["T1"], planRev: "eb6b565", locks: [], locked: [], unlocks: [] },
			{ sha: lock, merge: false, tasks: ["T1"], planRev: "eb6b565", locks: ["T1"], locked: ["test/a.test.ts", "test/b, c.test.ts"], unlocks: [] },
			{ sha: unlock, merge: false, tasks: ["T1"], planRev: "eb6b565", locks: [], locked: [], unlocks: ["T1"] },
			{ sha: plain, merge: false, tasks: [], locks: [], locked: [], unlocks: [] },
		]);
	});

	test("repeated Task: trailers are kept apart, a comma list stays one value, Task-Lock does not leak into Task", () => {
		const repo = initRepo();
		git(repo, "checkout", "-q", "-b", "PAC-1");
		const sha = commit(repo, "several", "Task: T1", "Task: T2", "Task-Lock: T2");
		const comma = commit(repo, "comma", "Task: T1, T2");
		const facts = readCommitFacts(repo, "main", "PAC-1");
		expect(facts.map(f => [f.sha, f.tasks, f.locks])).toEqual([[sha, ["T1", "T2"], ["T2"]], [comma, ["T1, T2"], []]]);
	});

	test("a merge commit is flagged, and parents come before children", () => {
		const repo = initRepo();
		git(repo, "checkout", "-q", "-b", "PAC-1");
		const a = commitFiles(repo, { "src/a.ts": "export const a = 2;\n" }, "a", "Task: T1");
		git(repo, "checkout", "-q", "-b", "side", "main");
		const b = commitFiles(repo, { "src/b.ts": "export const b = 2;\n" }, "b", "Task: T2");
		git(repo, "checkout", "-q", "PAC-1");
		git(repo, "merge", "-q", "--no-ff", "side", "-m", "merge side");
		const merge = git(repo, "rev-parse", "HEAD");
		const facts = readCommitFacts(repo, "main", "PAC-1");
		expect(facts.map(f => f.sha).sort()).toEqual([a, b, merge].sort());
		expect(facts.at(-1)).toMatchObject({ sha: merge, merge: true, tasks: [] });
		expect(facts.filter(f => f.merge)).toHaveLength(1);
	});

	test("an empty range reads as no commits, an unknown ref throws", () => {
		const repo = initRepo();
		expect(readCommitFacts(repo, "main", "main")).toEqual([]);
		expect(() => readCommitFacts(repo, "main", "absent")).toThrow(/git log failed/);
	});
});

describe("readCommitDiff", () => {
	test("paths and added lines with their line numbers, across several hunks", () => {
		const repo = initRepo();
		const body = (extra: string[]) => `${Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n")}\n${extra.join("\n")}${extra.length > 0 ? "\n" : ""}`;
		commitFiles(repo, { "src/long.ts": body([]) }, "long");
		const text = body([]).split("\n");
		text.splice(4, 0, "added at 5");
		text.splice(20, 1, "changed 20", "added 21");
		const sha = commitFiles(repo, { "src/long.ts": text.join("\n"), "src/new.ts": "one\ntwo\n" }, "edit");
		const diff = readCommitDiff(repo, sha);
		expect(diff.changes).toEqual([{ path: "src/long.ts" }, { path: "src/new.ts" }]);
		expect(diff.added).toEqual([
			{ path: "src/long.ts", line: 5, text: "added at 5" },
			{ path: "src/long.ts", line: 21, text: "changed 20" },
			{ path: "src/long.ts", line: 22, text: "added 21" },
			{ path: "src/new.ts", line: 1, text: "one" },
			{ path: "src/new.ts", line: 2, text: "two" },
		]);
	});

	test("a rename names both sides, with or without edits, and the added lines belong to the new path", () => {
		const repo = initRepo();
		const base = Array.from({ length: 12 }, (_, i) => `row ${i}`).join("\n") + "\n";
		commitFiles(repo, { "src/old.ts": base, "src/plain.ts": "export const p = 1;\n" }, "files");
		git(repo, "mv", "src/old.ts", "src/new.ts");
		git(repo, "mv", "src/plain.ts", "src/plain2.ts");
		const sha = commitFiles(repo, { "src/new.ts": `${base}it.skip("x");\n` }, "move");
		const diff = readCommitDiff(repo, sha);
		expect(diff.changes).toEqual([{ path: "src/new.ts", from: "src/old.ts" }, { path: "src/plain2.ts", from: "src/plain.ts" }]);
		expect(diff.added).toEqual([{ path: "src/new.ts", line: 13, text: 'it.skip("x");' }]);
	});

	test("a path with spaces, tabs and non-ASCII characters is read from the numstat, not from a diff header", () => {
		const repo = initRepo();
		const odd = ["dir with space/a file.ts", "tab\there.ts", "naïve/é.ts"];
		const sha = commitFiles(repo, Object.fromEntries(odd.map(path => [path, "line\n"])), "odd names");
		const diff = readCommitDiff(repo, sha);
		expect(diff.changes.map(c => c.path).sort()).toEqual([...odd].sort());
		expect(diff.added.map(l => l.path).sort()).toEqual([...odd].sort());
	});

	test("binary files, mode changes and deletions are changes without added lines", () => {
		const repo = initRepo();
		commitFiles(repo, { "src/tool.sh": "#!/bin/sh\n", "src/gone.ts": "x\n" }, "setup");
		writeFileSync(join(repo, "logo.bin"), Buffer.from([0, 1, 2, 0, 255]));
		chmodSync(join(repo, "src/tool.sh"), 0o755);
		const sha = commitFiles(repo, { "src/gone.ts": null }, "mixed");
		const diff = readCommitDiff(repo, sha);
		expect(diff.changes).toEqual([{ path: "logo.bin" }, { path: "src/gone.ts" }, { path: "src/tool.sh" }]);
		expect(diff.added).toEqual([]);
	});

	test("an added line that starts with ++ or -- is content, not a header", () => {
		const repo = initRepo();
		const sha = commitFiles(repo, { "notes.md": "++ plus\n-- minus\n+++ three\n" }, "markers");
		expect(readCommitDiff(repo, sha).added.map(l => l.text)).toEqual(["++ plus", "-- minus", "+++ three"]);
	});

	test("an empty commit has no changes; a root commit lists every file", () => {
		const repo = initRepo();
		expect(readCommitDiff(repo, commit(repo, "empty"))).toEqual({ changes: [], added: [] });
		const root = git(repo, "rev-list", "--max-parents=0", "HEAD");
		expect(readCommitDiff(repo, root).changes).toEqual([{ path: "src/a.ts" }, { path: "src/b.ts" }]);
	});

	test("a merge commit is read against its first parent", () => {
		const repo = initRepo();
		git(repo, "checkout", "-q", "-b", "PAC-1");
		commitFiles(repo, { "src/a.ts": "export const a = 2;\n" }, "on branch");
		git(repo, "checkout", "-q", "main");
		commitFiles(repo, { "src/b.ts": "export const b = 3;\n" }, "on main");
		git(repo, "checkout", "-q", "PAC-1");
		git(repo, "merge", "-q", "--no-ff", "main", "-m", "merge main");
		const diff = readCommitDiff(repo, "HEAD");
		expect(diff.changes).toEqual([{ path: "src/b.ts" }]);
		expect(diff.added).toEqual([{ path: "src/b.ts", line: 1, text: "export const b = 3;" }]);
	});

	test("readRange joins facts and diffs", () => {
		const repo = initRepo();
		git(repo, "checkout", "-q", "-b", "PAC-1");
		const sha = commitFiles(repo, { "src/a.ts": "export const a = 2;\n" }, "work", "Task: T1", "Plan-Rev: abcdef1");
		expect(readRange(repo, "main", "PAC-1")).toEqual([
			{
				sha, merge: false, tasks: ["T1"], planRev: "abcdef1", locks: [], locked: [], unlocks: [],
				changes: [{ path: "src/a.ts" }], added: [{ path: "src/a.ts", line: 1, text: "export const a = 2;" }],
			},
		]);
	});

	test("an unknown commit throws", () => {
		expect(() => readCommitDiff(initRepo(), "0".repeat(40))).toThrow(/git show failed/);
	});
});

describe("planReader", () => {
	/** A repo whose origin is org/backend, a vault holding two plan revisions, and the shas of both. */
	function world() {
		const repo = initRepo("git@github.com:org/backend.git");
		const vault = initVault();
		const v1 = vault.commitPlan(PLAN_PATH, planText({ tasks: [{ id: "T1", owns: ["src/a.ts"] }] }));
		const v2 = vault.commitPlan(PLAN_PATH, planText({ tasks: [{ id: "T1", owns: ["src/b.ts"] }] }));
		const reader = (over: Partial<PlanReaderOptions> = {}) =>
			planReader({ vaultGitDir: vault.gitDir, planPath: PLAN_PATH, repo, filesAt: "main", ...over });
		return { repo, vault, v1, v2, reader };
	}

	test("each Plan-Rev reads its own revision of the plan, abbreviated or full", () => {
		const { v1, v2, reader } = world();
		const read = reader();
		expect(read(v1).plan?.tasks[0].owns).toEqual(["src/a.ts"]);
		expect(read(v2).plan?.tasks[0].owns).toEqual(["src/b.ts"]);
		expect(read(v1.slice(0, 7)).plan?.tasks[0].owns).toEqual(["src/a.ts"]);
		expect(read(v1).violations).toEqual([]);
		expect(read(v1)).toBe(read(v1));
	});

	test("a rev that is not a vault commit, or a path the vault lacks at that commit, is unreadable", () => {
		const { vault, v1, reader } = world();
		const read = reader();
		expect(read("main")).toEqual({ unreadable: "is not a vault commit sha", violations: [] });
		expect(read("HEAD~0")).toMatchObject({ unreadable: "is not a vault commit sha" });
		expect(read("deadbeef")).toMatchObject({ unreadable: "is not a commit in the vault git dir" });
		expect(reader({ planPath: "Specs/other/plan.md" })(v1)).toMatchObject({ unreadable: expect.stringContaining("Specs/other/plan.md does not exist") });
		// A branch named like a sha must not stand in for that commit.
		git(vault.root, "branch", "abcd1234", v1);
		expect(read("abcd1234")).toMatchObject({ unreadable: "is not a commit in the vault git dir" });
	});

	test("the plan comes from the vault's commits, never from its work tree", () => {
		const { vault, v1, reader } = world();
		writeFileSync(join(vault.root, PLAN_PATH), planText({ tasks: [{ id: "T9", owns: ["src/a.ts"] }] }));
		expect(reader()(v1).plan?.tasks.map(t => t.id)).toEqual(["T1"]);
	});

	test("a plan that does not parse comes back with its parse errors and no plan", () => {
		const { vault, reader } = world();
		const broken = vault.commitPlan(PLAN_PATH, "no blocks here\n");
		const at = reader()(broken);
		expect(at.plan).toBeUndefined();
		expect(at.violations.map(v => v.rule)).toEqual(["parse"]);
	});

	test("a plan that parses is validated against the repo files at filesAt", () => {
		const { repo, vault, reader } = world();
		const later = vault.commitPlan(PLAN_PATH, planText({ tasks: [{ id: "T1", owns: ["src/later.ts"] }] }));
		git(repo, "checkout", "-q", "-b", "PAC-1");
		commitFiles(repo, { "src/later.ts": "export {};\n" }, "adds the file");
		expect(reader({ filesAt: "main" })(later).violations.map(v => `${v.rule}:${v.task}`)).toEqual(["field:T1"]);
		expect(reader({ filesAt: "PAC-1" })(later).violations).toEqual([]);
	});

	test("only plan-wide findings and those of this repo's tasks are kept", () => {
		const { vault, reader } = world();
		// T2 belongs to the frontend: its missing checks.test and its files are judged by the frontend's own clone.
		const text = planText({
			checks: { "org/backend": { test: "true" } },
			tasks: [{ id: "T1", owns: ["src/a.ts"] }, { id: "T2", repo: "org/frontend", owns: ["web/**"] }],
		});
		const at = reader()(vault.commitPlan(PLAN_PATH, text));
		expect(at.violations).toEqual([]);
		expect(at.plan?.tasks.map(t => t.id)).toEqual(["T1", "T2"]);
		const backendBroken = vault.commitPlan(PLAN_PATH, planText({ checks: {}, tasks: [{ id: "T1", owns: ["src/a.ts"] }] }));
		expect(reader()(backendBroken).violations.map(v => `${v.rule}:${v.task}`)).toEqual(["checks-missing:T1"]);
	});

	test("a clone without an origin serves the plan's single repo but not a multi-repo plan", () => {
		const repo = initRepo();
		const vault = initVault();
		const single = vault.commitPlan(PLAN_PATH, planText({ tasks: [{ id: "T1", owns: ["src/a.ts"] }] }));
		const read = planReader({ vaultGitDir: vault.gitDir, planPath: PLAN_PATH, repo, filesAt: "main" });
		expect(read(single).violations).toEqual([]);
		const multi = vault.commitPlan(
			PLAN_PATH,
			planText({ checks: { "org/backend": { test: "true" }, "org/frontend": { test: "true" } }, tasks: [{ id: "T1", owns: ["src/a.ts"] }, { id: "T2", repo: "org/frontend", owns: ["src/b.ts"] }] }),
		);
		expect(() => read(multi)).toThrow(/cannot serve a plan with 2 repos/);
	});

	test("a missing vault git dir stops with a hint, and so does a folder that is not a git dir", () => {
		const repo = initRepo();
		const options = { planPath: PLAN_PATH, repo, filesAt: "main" };
		expect(() => planReader({ ...options, vaultGitDir: join(scratch(), "absent") })).toThrow(/does not exist; set up the vault spec store first \(vgit, build step 0\)/);
		const plain = join(scratch(), "plain");
		mkdirSync(plain);
		expect(() => planReader({ ...options, vaultGitDir: plain })).toThrow(/is not a git dir/);
	});

	test("the default vault git dir lives under the home directory", () => {
		expect(DEFAULT_VAULT_GIT_DIR).toBe(join(process.env.OMP_STARTER_TEST_HOME ?? "", ".vault-git"));
	});
});

describe("loadGuardInput", () => {
	test("loads the commits and one plan per Plan-Rev named by a task commit", () => {
		const repo = initRepo("git@github.com:org/backend.git");
		const vault = initVault();
		const v1 = vault.commitPlan(PLAN_PATH, planText({ tasks: [{ id: "T1", owns: ["src/a.ts"] }] }));
		git(repo, "checkout", "-q", "-b", "PAC-1");
		const one = commitFiles(repo, { "src/a.ts": "export const a = 2;\n" }, "one", "Task: T1", `Plan-Rev: ${v1}`);
		const two = commitFiles(repo, { "src/a.ts": "export const a = 3;\n" }, "two", "Task: T1", `Plan-Rev: ${v1}`);
		const stray = commitFiles(repo, { "src/b.ts": "export const b = 2;\n" }, "stray", `Plan-Rev: ${v1.slice(0, 7)}`);
		const input = loadGuardInput({ repo, from: "main", to: "PAC-1", vaultGitDir: vault.gitDir, planPath: PLAN_PATH }, true);
		expect(input.commits.map(c => c.sha)).toEqual([one, two, stray]);
		expect(input.strict).toBe(true);
		expect([...input.plans.keys()]).toEqual([v1]);
		expect(input.plans.get(v1)?.plan?.id).toBe("S-1");
	});
});
