import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	type CheckNote,
	cloneIdentities,
	defaultBase,
	listFiles,
	listFilesByRepo,
	listNotes,
	pruneDeadTempRefs,
	readCheckNote,
	readTaskCommits,
	refExists,
	removeCheckNote,
	repoIdentity,
	setNoteBlobs,
	updateNotes,
	writeCheckNote,
} from "./spec-git";
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

describe("check notes under concurrent writers", () => {
	const GIT_MODULE = resolve(import.meta.dir, "spec-git.ts");
	const CHILD = `import { writeCheckNote } from ${JSON.stringify(GIT_MODULE)};
const [repo, sha, task] = process.argv.slice(1);
writeCheckNote(repo, sha, { v: 1, task, plan_rev: "r", checks: { test: "pass" }, attempts: 1, blocked: false, reason: "", at: "2026-11-05T00:00:00Z" });`;

	test("30 processes writing notes on their own commits in one repo lose none", async () => {
		const repo = initRepo();
		const shas = Array.from({ length: 30 }, (_, i) => commit(repo, `c${i}`));
		const children = shas.map((sha, i) => Bun.spawn({ cmd: [process.execPath, "-e", CHILD, repo, sha, `T${i}`], stdout: "pipe", stderr: "pipe" }));
		const exits = await Promise.all(children.map(async child => ({ code: await child.exited, err: await new Response(child.stderr).text() })));
		expect(exits.filter(exit => exit.code !== 0)).toEqual([]);
		const survivors = shas.filter(sha => readCheckNote(repo, sha) !== undefined);
		expect(survivors).toHaveLength(30);
		expect(git(repo, "for-each-ref", "--format=%(refname)", "refs/notes")).toBe("refs/notes/spec-checks");
	}, 60_000);
});

describe("removeCheckNote", () => {
	test("removes the note of a commit and leaves the others", () => {
		const repo = initRepo();
		const first = git(repo, "rev-parse", "HEAD");
		const second = commit(repo, "next");
		writeCheckNote(repo, first, note({ task: "A" }));
		writeCheckNote(repo, second, note({ task: "B" }));
		removeCheckNote(repo, first);
		expect(readCheckNote(repo, first)).toBeUndefined();
		expect(readCheckNote(repo, second)).toEqual(note({ task: "B" }));
	});

	test("removing an absent note is a no-op, with or without a notes ref", () => {
		const repo = initRepo();
		const sha = git(repo, "rev-parse", "HEAD");
		expect(() => removeCheckNote(repo, sha)).not.toThrow();
		expect(git(repo, "for-each-ref", "--format=%(refname)", "refs/notes")).toBe("");
		writeCheckNote(repo, commit(repo, "other"), note());
		expect(() => removeCheckNote(repo, sha)).not.toThrow();
	});

	test("a failure surfaces as a throw, and leaves no temp notes ref behind", () => {
		const repo = initRepo();
		const sha = git(repo, "rev-parse", "HEAD");
		writeCheckNote(repo, sha, note());
		expect(() => removeCheckNote(repo, "not-a-commit")).toThrow(/git notes failed/);
		expect(() => removeCheckNote(join(repo, "absent"), sha)).toThrow();
		expect(() => writeCheckNote(join(repo, "absent"), sha, note())).toThrow();
		expect(git(repo, "for-each-ref", "--format=%(refname)", "refs/notes")).toBe("refs/notes/spec-checks");
		expect(readCheckNote(repo, sha)).toEqual(note());
	});
});

describe("updateNotes: the new notes commit must sit on the tip it was made from", () => {
	test("a copy deleted while the edit runs (a fresh notes tree) is not swapped in over the existing notes; the edit is redone on the real tip", () => {
		const repo = initRepo();
		const a = git(repo, "rev-parse", "HEAD");
		const b = commit(repo, "b");
		writeCheckNote(repo, a, note({ task: "A" }));
		let sabotaged = false;
		updateNotes(repo, copy => {
			if (!sabotaged) {
				sabotaged = true;
				git(repo, "update-ref", "--no-deref", "-d", `refs/notes/${copy}`);
			}
			git(repo, "notes", `--ref=${copy}`, "add", "-f", "-m", JSON.stringify(note({ task: "B" })), b);
		});
		expect(readCheckNote(repo, a)?.task).toBe("A");
		expect(readCheckNote(repo, b)?.task).toBe("B");
	});

	test("a copy that is always deleted gives up with an error and leaves the notes as they were", () => {
		const repo = initRepo();
		const a = git(repo, "rev-parse", "HEAD");
		writeCheckNote(repo, a, note({ task: "A" }));
		const tip = git(repo, "rev-parse", "refs/notes/spec-checks");
		expect(() =>
			updateNotes(repo, copy => {
				git(repo, "update-ref", "--no-deref", "-d", `refs/notes/${copy}`);
				git(repo, "notes", `--ref=${copy}`, "add", "-f", "-m", "x", a);
			}),
		).toThrow(/not made on the notes tip/);
		expect(git(repo, "rev-parse", "refs/notes/spec-checks")).toBe(tip);
	}, 30_000);
});

describe("notes temp refs (N3, N10) and the CAS error", () => {
	const notes = (repo: string): string => git(repo, "for-each-ref", "--format=%(refname) %(symref)", "refs/notes");

	test("a temp ref planted as a symref to spec-checks under the old predictable name does not wipe the notes", () => {
		const repo = initRepo();
		const shas = [git(repo, "rev-parse", "HEAD"), commit(repo, "b"), commit(repo, "c")];
		writeCheckNote(repo, shas[0], note({ task: "A" }));
		writeCheckNote(repo, shas[1], note({ task: "B" }));
		git(repo, "symbolic-ref", `refs/notes/spec-tmp-${process.pid}`, "refs/notes/spec-checks");
		writeCheckNote(repo, shas[2], note({ task: "C" }));
		expect(shas.map(sha => readCheckNote(repo, sha)?.task)).toEqual(["A", "B", "C"]);
		// The planted symref is left alone: it is not the scheduler's.
		expect(notes(repo)).toContain(`refs/notes/spec-tmp-${process.pid} refs/notes/spec-checks`);
	});

	test("the temp ref has an unpredictable name and is gone after the write, a failed write included", () => {
		const repo = initRepo();
		const sha = git(repo, "rev-parse", "HEAD");
		writeCheckNote(repo, sha, note());
		expect(notes(repo).split("\n")).toEqual(["refs/notes/spec-checks"]);
		expect(() => removeCheckNote(repo, "not-a-commit")).toThrow();
		expect(notes(repo).split("\n")).toEqual(["refs/notes/spec-checks"]);
	});

	test("when the CAS keeps failing for another reason, the error carries git's last message", () => {
		const repo = initRepo();
		const sha = git(repo, "rev-parse", "HEAD");
		writeCheckNote(repo, sha, note());
		writeFileSync(join(repo, ".git/refs/notes/spec-checks.lock"), "");
		expect(() => writeCheckNote(repo, sha, note({ attempts: 9 }))).toThrow(/spec-checks\.lock/);
	}, 60_000);

	test("pruneDeadTempRefs removes the temp refs of dead processes (a symref too, without touching its target) and keeps a live one's", () => {
		const repo = initRepo();
		const sha = git(repo, "rev-parse", "HEAD");
		writeCheckNote(repo, sha, note());
		const dead = Bun.spawnSync({ cmd: ["true"] }).pid;
		const tip = git(repo, "rev-parse", "refs/notes/spec-checks");
		git(repo, "update-ref", `refs/notes/spec-tmp-${dead}-aaaa`, tip);
		git(repo, "symbolic-ref", `refs/notes/spec-tmp-${dead}-bbbb`, "refs/notes/spec-checks");
		git(repo, "update-ref", `refs/notes/spec-tmp-${process.pid}-cccc`, tip);
		git(repo, "update-ref", "refs/notes/spec-tmp-notapid", tip);
		expect(pruneDeadTempRefs(repo).sort()).toEqual([`refs/notes/spec-tmp-${dead}-aaaa`, `refs/notes/spec-tmp-${dead}-bbbb`]);
		expect(notes(repo).split("\n").map(line => line.split(" ")[0]).sort()).toEqual(["refs/notes/spec-checks", `refs/notes/spec-tmp-${process.pid}-cccc`, "refs/notes/spec-tmp-notapid"]);
		expect(readCheckNote(repo, sha)).toEqual(note());
	});
});

describe("listNotes and setNoteBlobs", () => {
	test("lists target to blob, and puts entries back by blob or removes them, in one CAS update", () => {
		const repo = initRepo();
		const a = git(repo, "rev-parse", "HEAD");
		const b = commit(repo, "b");
		expect(listNotes(repo).size).toBe(0);
		writeCheckNote(repo, a, note({ task: "A" }));
		const before = listNotes(repo);
		writeCheckNote(repo, a, note({ task: "A2" }));
		writeCheckNote(repo, b, note({ task: "B" }));
		setNoteBlobs(repo, new Map([[a, before.get(a) ?? ""], [b, ""]]));
		expect(readCheckNote(repo, a)?.task).toBe("A");
		expect(readCheckNote(repo, b)).toBeUndefined();
		expect([...listNotes(repo).keys()]).toEqual([a]);
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

	test("cloneIdentities and listFilesByRepo key clones by origin org/name", () => {
		const backend = initRepo("git@github.com:org/backend.git");
		const frontend = initRepo("https://github.com/org/frontend.git");
		writeFileSync(join(frontend, "web.ts"), "export {};\n");
		git(frontend, "add", "-A");
		const clones = cloneIdentities([backend, frontend]);
		expect([...clones]).toEqual([["org/backend", backend], ["org/frontend", frontend]]);
		const files = listFilesByRepo(clones);
		expect(files.get("org/backend")?.sort()).toEqual(["src/a.ts", "src/b.ts"]);
		expect(files.get("org/frontend")?.sort()).toEqual(["src/a.ts", "src/b.ts", "web.ts"]);
		expect(() => cloneIdentities([initRepo()])).toThrow(/not a git clone with an org\/name origin URL/);
		expect(() => cloneIdentities([backend, initRepo("https://github.com/org/backend")])).toThrow(/both clones of org\/backend/);
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
		const header = [`${FENCE}yaml plan`, "id: S-1", "kind: story", "shared_paths: []", "checks:", '  org/backend: {test: "true"}', FENCE, ""];
		return [...header, ...task("T1", "src/a.ts", "[]", acceptance), ...task("T2", "src/b.ts", "[T1]", '["works"]')].join("\n");
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
		expect(unmatched.stderr).toContain('no files supplied for repo "org/backend"');

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
