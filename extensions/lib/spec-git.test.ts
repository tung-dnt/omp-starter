import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type CheckNote, defaultBase, listFiles, readCheckNote, readTaskCommits, refExists, repoIdentity, writeCheckNote } from "./spec-git";
import { RISK_FIELDS } from "./spec-risk";

const SCRIPT = resolve(import.meta.dir, "../../scripts/spec-status.ts");
const FENCE = "`".repeat(3);

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A scratch directory under the private test HOME (see extensions/test-preload.ts). */
function scratch(): string {
	const home = process.env.OMP_STARTER_TEST_HOME;
	if (!home) throw new Error("OMP_STARTER_TEST_HOME is not set; the test preload did not run");
	const dir = mkdtempSync(join(home, "spec-git-"));
	dirs.push(dir);
	return dir;
}

function git(repo: string, ...args: string[]): string {
	const result = Bun.spawnSync({
		cmd: ["git", "-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args],
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
	return result.stdout.toString().trim();
}

/** A repo on `main` with two tracked files and, when given, an `origin` URL. */
function initRepo(origin?: string): string {
	const repo = join(scratch(), "repo");
	mkdirSync(join(repo, "src"), { recursive: true });
	git(repo, "init", "-q", "-b", "main");
	git(repo, "config", "user.name", "Test");
	git(repo, "config", "user.email", "test@example.com");
	writeFileSync(join(repo, "src", "a.ts"), "export {};\n");
	writeFileSync(join(repo, "src", "b.ts"), "export {};\n");
	git(repo, "add", "-A");
	git(repo, "commit", "-q", "-m", "base");
	if (origin !== undefined) git(repo, "remote", "add", "origin", origin);
	return repo;
}

/** An empty commit whose last paragraph holds the given trailer lines; returns its SHA. */
function commit(repo: string, subject: string, ...trailers: string[]): string {
	git(repo, "commit", "-q", "--allow-empty", "-m", subject, ...(trailers.length > 0 ? ["-m", trailers.join("\n")] : []));
	return git(repo, "rev-parse", "HEAD");
}

function note(over: Partial<CheckNote> = {}): CheckNote {
	return {
		v: 1, task: "T1", plan_rev: "eb6b565", checks: { tests: "pass", typecheck: "pass", lint: "skip", guard: "pass" },
		attempts: 2, blocked: false, reason: "", at: "2026-11-04T05:00:00Z", ...over,
	};
}

describe("readTaskCommits", () => {
	test("reads trailers of base..branch, oldest first, excluding base commits", () => {
		const repo = initRepo();
		git(repo, "checkout", "-q", "-b", "PAC-1");
		const first = commit(repo, "first", "Task: T1", "Plan-Rev: eb6b565");
		const lock = commit(repo, "lock", "Task: T1", "Task-Lock: T1", "Plan-Rev: eb6b565");
		const plain = commit(repo, "no trailers");
		expect(readTaskCommits(repo, "main", "PAC-1")).toEqual([
			{ sha: first, tasks: ["T1"], locks: [], planRev: "eb6b565" },
			{ sha: lock, tasks: ["T1"], locks: ["T1"], planRev: "eb6b565" },
			{ sha: plain, tasks: [], locks: [] },
		]);
	});

	test("keeps every value of a repeated Task trailer, and Task-Lock does not leak into Task", () => {
		const repo = initRepo();
		git(repo, "checkout", "-q", "-b", "PAC-1");
		const sha = commit(repo, "two tasks", "Task: T1", "Task: T2", "Task-Lock: T2", "Task-Lock: T3");
		expect(readTaskCommits(repo, "main", "PAC-1")).toEqual([{ sha, tasks: ["T1", "T2"], locks: ["T2", "T3"] }]);
	});

	test("an empty range reads as no commits, an unknown ref throws", () => {
		const repo = initRepo();
		git(repo, "branch", "PAC-1");
		expect(readTaskCommits(repo, "main", "PAC-1")).toEqual([]);
		expect(() => readTaskCommits(repo, "main", "absent")).toThrow(/git log failed/);
	});
});

describe("check notes", () => {
	test("a written note reads back, and a rewrite replaces it", () => {
		const repo = initRepo();
		const sha = git(repo, "rev-parse", "HEAD");
		expect(readCheckNote(repo, sha)).toBeUndefined();
		writeCheckNote(repo, sha, note());
		expect(readCheckNote(repo, sha)).toEqual(note());
		writeCheckNote(repo, sha, note({ attempts: 3, blocked: true, reason: "test_wrong" }));
		expect(readCheckNote(repo, sha)).toEqual(note({ attempts: 3, blocked: true, reason: "test_wrong" }));
		expect(git(repo, "notes", "--ref=spec-checks", "list")).toContain(sha);
		expect(git(repo, "for-each-ref", "--format=%(refname)", "refs/notes")).toBe("refs/notes/spec-checks");
	});

	test("a note stays on its own commit", () => {
		const repo = initRepo();
		const older = git(repo, "rev-parse", "HEAD");
		const newer = commit(repo, "next");
		writeCheckNote(repo, older, note());
		expect(readCheckNote(repo, newer)).toBeUndefined();
	});

	test("invalid JSON or a wrong shape reads as no note, with a warning", () => {
		const repo = initRepo();
		const sha = git(repo, "rev-parse", "HEAD");
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		try {
			git(repo, "notes", "--ref=spec-checks", "add", "-f", "-m", "{not json", sha);
			expect(readCheckNote(repo, sha)).toBeUndefined();
			expect(warn).toHaveBeenCalledTimes(1);
			expect(String(warn.mock.calls[0][0])).toContain("not valid JSON");

			const bad: unknown[] = [
				{ ...note(), v: 2 },
				{ ...note(), checks: { tests: "maybe" } },
				{ ...note(), attempts: "2" },
				{ ...note(), blocked: "no" },
				["not", "an", "object"],
			];
			for (const value of bad) {
				git(repo, "notes", "--ref=spec-checks", "add", "-f", "-m", JSON.stringify(value), sha);
				expect(readCheckNote(repo, sha)).toBeUndefined();
			}
			expect(warn).toHaveBeenCalledTimes(1 + bad.length);
			expect(String(warn.mock.calls[1][0])).toContain("unsupported v 2");
		} finally {
			warn.mockRestore();
		}
	});
});

describe("repoIdentity", () => {
	const cases: Array<[string, string]> = [
		["git@github.com:org/backend.git", "org/backend"],
		["git@github.com:org/backend", "org/backend"],
		["ssh://git@github.com/org/backend.git", "org/backend"],
		["ssh://git@github.com:2222/org/backend.git", "org/backend"],
		["https://github.com/org/backend.git", "org/backend"],
		["https://github.com/org/backend", "org/backend"],
		["https://user:token@github.com/org/backend.git/", "org/backend"],
	];
	for (const [url, identity] of cases) {
		test(`${url} is ${identity}`, () => {
			expect(repoIdentity(initRepo(url))).toBe(identity);
		});
	}

	test("no origin, or an origin without an org/name path, is undefined", () => {
		expect(repoIdentity(initRepo())).toBeUndefined();
		expect(repoIdentity(initRepo("/srv/git/backend.git"))).toBeUndefined();
		expect(repoIdentity(initRepo("https://example.com/backend"))).toBeUndefined();
		expect(repoIdentity(join(scratch(), "absent"))).toBeUndefined();
	});
});

describe("repo facts", () => {
	test("refExists, defaultBase and listFiles", () => {
		const repo = initRepo();
		expect(refExists(repo, "main")).toBe(true);
		expect(refExists(repo, "absent")).toBe(false);
		expect(defaultBase(repo)).toBe("main");
		git(repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk");
		expect(defaultBase(repo)).toBe("origin/trunk");
		expect(listFiles(repo).sort()).toEqual(["src/a.ts", "src/b.ts"]);
		expect(() => listFiles(scratch())).toThrow(/not a git work tree/);
	});
});

describe("spec-status CLI", () => {
	const PLAN = (acceptance = '["works"]') => {
		const task = (id: string, owns: string, deps: string, accept: string) => [
			`${FENCE}yaml task`,
			`id: ${id}`,
			"repo: org/backend",
			`depends_on: ${deps}`,
			"foundation: false",
			`owns: [${owns}]`,
			"new_paths: []",
			"reads: []",
			"risk:",
			...RISK_FIELDS.map(field => `  ${field}: {value: no}`),
			"lld_required: false",
			"security_review: false",
			"required_tests: []",
			`acceptance: ${accept}`,
			FENCE,
			"",
		];
		return [`${FENCE}yaml plan`, "id: S-1", "kind: story", "shared_paths: []", FENCE, "", ...task("T1", "src/a.ts", "[]", acceptance), ...task("T2", "src/b.ts", "[T1]", '["works"]')].join("\n");
	};

	/** A clone of org/backend on branch PAC-1 (checked out), a plan file for it, and a PATH with git (and optionally a fake gh). */
	function world(gh?: string) {
		const repo = initRepo("git@github.com:org/backend.git");
		git(repo, "checkout", "-q", "-b", "PAC-1");
		const root = scratch();
		const plan = join(root, "plan.md");
		writeFileSync(plan, PLAN());
		const bin = join(root, "bin");
		mkdirSync(bin);
		const gitPath = Bun.which("git");
		if (!gitPath) throw new Error("git not found");
		symlinkSync(gitPath, join(bin, "git"));
		const ghLog = join(root, "gh.log");
		if (gh !== undefined) {
			writeFileSync(join(bin, "gh"), `#!/bin/sh\nprintf '%s\\n' "$@" > '${ghLog}'\n${gh}\n`);
			chmodSync(join(bin, "gh"), 0o755);
		}
		const run = (...args: string[]) => {
			const result = Bun.spawnSync({ cmd: [process.execPath, SCRIPT, ...args], stdout: "pipe", stderr: "pipe", env: { ...process.env, PATH: bin } });
			return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
		};
		return { repo, plan, root, ghLog, run };
	}

	test("exit 0 with text and --json on a two-task repo: T1 done, T2 ready", () => {
		const { repo, plan, run } = world();
		const sha = commit(repo, "T1 work", "Task: T1", "Task-Lock: T1", "Plan-Rev: eb6b565");
		writeCheckNote(repo, sha, note());

		const text = run(plan, "--repo", repo, "--branch", "PAC-1");
		expect(text.code).toBe(0);
		expect(text.stdout).toContain("S-1 ▸ 1/2 done · 1 ready");
		expect(text.stdout).toMatch(new RegExp(`T1\\s+done\\s+${sha.slice(0, 7)}\\s+attempts 2`));
		expect(text.stdout).toMatch(/T2\s+ready/);
		expect(text.stdout).toContain("story: in-progress");
		expect(text.stderr).toBe("");

		const json = run(plan, "--repo", repo, "--branch", "PAC-1", "--base", "main", "--json");
		expect(json.code).toBe(0);
		expect(JSON.parse(json.stdout)).toEqual({
			id: "S-1",
			state: "in-progress",
			tasks: [
				{ id: "T1", state: "done", lastSha: sha, attempts: 2 },
				{ id: "T2", state: "ready" },
			],
		});
	});

	test("exit 0 for tasks-done, and for states that are all unfinished", () => {
		const { repo, plan, run } = world();
		const a = commit(repo, "T1", "Task: T1", "Task-Lock: T1");
		const b = commit(repo, "T2", "Task: T2", "Task-Lock: T2");
		writeCheckNote(repo, a, note());
		writeCheckNote(repo, b, note({ task: "T2" }));
		const done = run(plan, "--repo", repo, "--branch", "PAC-1", "--json");
		expect(done.code).toBe(0);
		expect(JSON.parse(done.stdout).state).toBe("tasks-done");

		git(repo, "checkout", "-q", "main");
		git(repo, "branch", "-D", "PAC-1");
		const none = run(plan, "--repo", repo, "--branch", "PAC-1", "--json");
		expect(none.code).toBe(0);
		expect(none.stderr).toContain("branch PAC-1 does not exist in org/backend");
		expect(JSON.parse(none.stdout).tasks.map((t: { state: string }) => t.state)).toEqual(["ready", "waiting"]);
	});

	test("warns about a Task id outside the plan and about an invalid note, and carries on", () => {
		const { repo, plan, run } = world();
		const stray = commit(repo, "stray", "Task: T9");
		const sha = commit(repo, "T1", "Task: T1", "Task-Lock: T1");
		git(repo, "notes", "--ref=spec-checks", "add", "-m", "{broken", sha);
		const result = run(plan, "--repo", repo, "--branch", "PAC-1", "--json");
		expect(result.code).toBe(0);
		expect(result.stderr).toContain(`commit ${stray}`);
		expect(result.stderr).toContain("T9");
		expect(result.stderr).toContain("not valid JSON");
		expect(JSON.parse(result.stdout).tasks[0]).toEqual({ id: "T1", state: "checking", lastSha: sha });
	});

	test("--pr: merged PRs finish the story; gh is asked per repo for the branch", () => {
		const { repo, plan, ghLog, run } = world(`echo '[{"number":7}]'`);
		const a = commit(repo, "T1", "Task: T1", "Task-Lock: T1");
		const b = commit(repo, "T2", "Task: T2", "Task-Lock: T2");
		writeCheckNote(repo, a, note());
		writeCheckNote(repo, b, note({ task: "T2" }));
		expect(JSON.parse(run(plan, "--repo", repo, "--branch", "PAC-1", "--json").stdout).state).toBe("tasks-done");
		expect(existsSync(ghLog)).toBe(false);
		const merged = run(plan, "--repo", repo, "--branch", "PAC-1", "--pr", "--json");
		expect(merged.code).toBe(0);
		expect(JSON.parse(merged.stdout).state).toBe("done");
		expect(readFileSync(ghLog, "utf8").trim().split("\n")).toEqual(["pr", "list", "--head", "PAC-1", "--state", "merged", "--json", "number"]);
	});

	test("--pr: no merged PR, a failing gh and a missing gh keep tasks-done with a warning and exit 0", () => {
		const cases: Array<[string | undefined, string]> = [
			["echo '[]'", ""],
			["echo 'not authenticated' >&2; exit 1", "gh pr list failed for org/backend"],
			[undefined, "could not check PRs for org/backend"],
			["echo 'oops'", "could not check PRs for org/backend"],
		];
		for (const [gh, warning] of cases) {
			const { repo, plan, run } = world(gh);
			const a = commit(repo, "T1", "Task: T1", "Task-Lock: T1");
			const b = commit(repo, "T2", "Task: T2", "Task-Lock: T2");
			writeCheckNote(repo, a, note());
			writeCheckNote(repo, b, note({ task: "T2" }));
			const result = run(plan, "--repo", repo, "--branch", "PAC-1", "--pr", "--json");
			expect(result.code).toBe(0);
			expect(JSON.parse(result.stdout).state).toBe("tasks-done");
			expect(result.stderr).toContain(warning);
		}
	});

	test("exit 2 on usage errors", () => {
		const { repo, plan, run } = world();
		expect(run().code).toBe(2);
		expect(run().stdout).toBe("");
		expect(run().stderr).toContain("Usage:");
		expect(run("--repo", repo, "--branch", "PAC-1").code).toBe(2);
		expect(run(plan, "--branch", "PAC-1").code).toBe(2);
		expect(run(plan, "--repo", repo).code).toBe(2);
		expect(run(plan, "--repo", repo, "--branch").code).toBe(2);
		expect(run(plan, "--repo", repo, "--branch", "PAC-1", "--bogus").code).toBe(2);
		expect(run(plan, "extra", "--repo", repo, "--branch", "PAC-1").code).toBe(2);
	});

	test("exit 2 on IO errors: missing plan, bad repo, unmatched task repo, unknown base", () => {
		const { repo, plan, root, run } = world();
		expect(run(join(root, "absent.md"), "--repo", repo, "--branch", "PAC-1").code).toBe(2);

		const plain = join(root, "plain");
		mkdirSync(plain);
		const notClone = run(plan, "--repo", plain, "--branch", "PAC-1");
		expect(notClone.code).toBe(2);
		expect(notClone.stderr).toContain("not a git clone with an org/name origin URL");

		const other = initRepo("https://github.com/org/other.git");
		const unmatched = run(plan, "--repo", other, "--branch", "PAC-1");
		expect(unmatched.code).toBe(2);
		expect(unmatched.stderr).toContain("no --repo clone has origin org/backend");

		const base = run(plan, "--repo", repo, "--branch", "PAC-1", "--base", "absent");
		expect(base.code).toBe(2);
		expect(base.stdout).toBe("");
	});

	test("exit 2 for an invalid plan, listing its violations and computing no status", () => {
		const { repo, root, run } = world();
		const file = join(root, "bad.md");
		writeFileSync(file, PLAN("[]"));
		const result = run(file, "--repo", repo, "--branch", "PAC-1", "--json");
		expect(result.code).toBe(2);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("acceptance-empty [T1]");
		writeFileSync(file, "no blocks here");
		expect(run(file, "--repo", repo, "--branch", "PAC-1").stderr).toContain("parse");
	});
});
