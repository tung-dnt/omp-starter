import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakePi } from "../test-harness";
import { cleanScratch, git, initRepo, scratch } from "./spec-fixtures";
import { type WorkerScope, compareSnapshot, gitMutation, scopeCheck, snapshotGit, workerGuard } from "./worker-guard";

afterEach(cleanScratch);

/** The `tool_call` handler of a worker guard for a worktree at /work/tree, called like the host calls it. */
function guard(over: Partial<WorkerScope> = {}) {
	const scope: WorkerScope = { cwd: "/work/tree", writeScope: ["src/**", "t/"], lockedFiles: ["src/locked.test.ts"], ...over };
	const host = fakePi();
	workerGuard(scope)(host.pi);
	return (toolName: string, input: Record<string, unknown>) => host.emit("tool_call", { type: "tool_call", toolCallId: "call-1", toolName, input }, { cwd: scope.cwd });
}

const blocks = (result: unknown): string | undefined =>
	typeof result === "object" && result !== null && "block" in result && result.block === true && "reason" in result ? String(result.reason) : undefined;

describe("workerGuard: git mutations in bash", () => {
	const mutations = [
		"git commit -m x",
		"git commit --amend --no-edit",
		"git push origin main",
		"git push --force",
		"git reset --hard HEAD~1",
		"git checkout main",
		"git checkout -- src/a.ts",
		"git switch -c other",
		"git rebase main",
		"git merge feature",
		"git cherry-pick abc1234",
		"git tag v1",
		"git update-ref refs/heads/main HEAD",
		"git stash",
		"git stash pop",
		"git worktree add ../other",
		"git notes add -m x",
		"git config user.name x",
	];
	for (const command of mutations) {
		test(`blocks ${command}`, () => {
			const reason = blocks(guard()("bash", { command }));
			expect(reason).toContain(`git ${command.split(" ")[1]} is blocked`);
		});
	}

	const wrapped: Array<[string, string]> = [
		['sh -c "git commit -m x"', "commit"],
		["sh -c 'git push origin HEAD'", "push"],
		['bash -c "git reset --hard"', "reset"],
		['bash -lc "cd sub && git checkout -b y"', "checkout"],
		["env GIT_AUTHOR_NAME=x git commit -m x", "commit"],
		["env -i PATH=/usr/bin git rebase main", "rebase"],
		["GIT_DIR=.git git update-ref refs/heads/x HEAD", "update-ref"],
		["/usr/bin/git commit -m x", "commit"],
		["command git push", "push"],
		["git -C other commit -m x", "commit"],
		['git -C "dir with space" commit -m x', "commit"],
		["git -c user.name=x -c user.email=y commit -m x", "commit"],
		["git --git-dir=.git --work-tree=. commit -m x", "commit"],
		["git --git-dir .git commit -m x", "commit"],
		["git --no-pager -P tag v1", "tag"],
		['git "commit" -m x', "commit"],
		["git comm''it -m x", "commit"],
		["git-commit -m x", "commit"],
		["cd repo && git add -A && git commit -m x", "commit"],
		["true; git stash drop", "stash"],
		["echo ok | xargs git push", "push"],
		["x=$(git commit -m x)", "commit"],
		["`git commit -m x`", "commit"],
		['sh -c "env FOO=1 sh -c \\"git commit -m x\\""', "commit"],
		["git\tcommit\n", "commit"],
	];
	for (const [command, subcommand] of wrapped) {
		test(`blocks ${command.trim()}`, () => {
			expect(gitMutation(command)).toBe(subcommand);
			expect(blocks(guard()("bash", { command }))).toContain(`git ${subcommand} is blocked`);
		});
	}

	const allowed = [
		"git status",
		"git diff HEAD",
		"git log --oneline -5",
		"git show HEAD:src/a.ts",
		"git add -A",
		"git blame src/a.ts",
		"git -C sub status",
		"git --no-pager log",
		"ls -la .git",
		"cat .gitignore",
		"echo committing and pushing later",
		"bun test extensions/lib/spec-guard.test.ts",
		"cat git-commit.txt",
		"grep -rn 'commit' src",
		"gitk",
		"digit commit",
	];
	for (const command of allowed) {
		test(`allows ${command}`, () => {
			expect(gitMutation(command)).toBeUndefined();
			expect(guard()("bash", { command })).toBeUndefined();
		});
	}

	test("a git command with no subcommand yet, or an unterminated quote, does not crash the scan", () => {
		expect(gitMutation("git")).toBeUndefined();
		expect(gitMutation("git -C")).toBeUndefined();
		expect(gitMutation('sh -c "git commit')).toBe("commit");
		expect(gitMutation("")).toBeUndefined();
	});

	test("tools other than write, edit and bash are never judged", () => {
		const call = guard();
		expect(call("read", { path: "/etc/passwd" })).toBeUndefined();
		expect(call("grep", { pattern: "git commit" })).toBeUndefined();
		expect(call("lsp", { action: "rename" })).toBeUndefined();
	});
});

describe("workerGuard: write and edit scope", () => {
	test("write inside the scope is allowed; outside it, on a locked file, or above the worktree it is blocked", () => {
		const call = guard();
		expect(call("write", { path: "src/a.ts", content: "x" })).toBeUndefined();
		expect(call("write", { path: "/work/tree/src/deep/b.ts", content: "x" })).toBeUndefined();
		expect(call("write", { path: "t/new/case.sh", content: "x" })).toBeUndefined();
		expect(call("write", { path: "./src/a.ts", content: "x" })).toBeUndefined();

		expect(blocks(call("write", { path: "docs/readme.md", content: "x" }))).toContain("docs/readme.md is outside this task's write scope");
		expect(blocks(call("write", { path: "src/locked.test.ts", content: "x" }))).toContain("src/locked.test.ts is a locked test");
		expect(blocks(call("write", { path: "../other/x.ts", content: "x" }))).toContain("outside the worktree");
		expect(blocks(call("write", { path: "src/../../x.ts", content: "x" }))).toContain("outside the worktree");
		expect(blocks(call("write", { path: "/etc/cron.d/x", content: "x" }))).toContain("outside the worktree");
		expect(blocks(call("write", { path: "~/.bashrc", content: "x" }))).toContain("outside the worktree");
		expect(blocks(call("write", { path: "/work/tree", content: "x" }))).toContain("outside the worktree");
		expect(blocks(call("write", { path: ".git/hooks/pre-commit", content: "x" }))).toContain("outside this task's write scope");
	});

	test("a path that only looks like the scope is outside it", () => {
		const call = guard();
		expect(blocks(call("write", { path: "srcx/a.ts", content: "x" }))).toBeDefined();
		expect(blocks(call("write", { path: "tt/a.sh", content: "x" }))).toBeDefined();
		expect(blocks(call("write", { path: "..src/a.ts", content: "x" }))).toBeDefined();
	});

	test("an empty write scope blocks every write", () => {
		expect(blocks(guard({ writeScope: [] })("write", { path: "src/a.ts", content: "x" }))).toContain("(empty)");
	});

	test("an edit is judged by every path it names: path, paths, hashline headers, MV targets and patch headers", () => {
		const call = guard();
		expect(call("edit", { path: "src/a.ts", input: "[src/a.ts#ABCD]\nPUT 1.=1:\n+x" })).toBeUndefined();
		expect(call("edit", { paths: ["src/a.ts", "src/b.ts"], input: "[src/a.ts#ABCD]\nPUT 1.=1:\n+x\n[src/b.ts#1234]\nPUT 1.=1:\n+y" })).toBeUndefined();

		expect(blocks(call("edit", { path: "docs/x.md" }))).toContain("docs/x.md");
		expect(blocks(call("edit", { paths: ["src/a.ts", "docs/x.md"] }))).toContain("docs/x.md");
		expect(blocks(call("edit", { path: "src/a.ts", input: "[docs/x.md#ABCD]\nPUT 1.=1:\n+x" }))).toContain("docs/x.md");
		expect(blocks(call("edit", { input: "[src/a.ts#ABCD]\nPUT 1.=1:\n+x\n[../escape.ts#1234]\nREM" }))).toContain("outside the worktree");
		expect(blocks(call("edit", { input: "[src/a.ts#ABCD]\nMV docs/moved.ts" }))).toContain("docs/moved.ts");
		expect(blocks(call("edit", { input: '[src/a.ts#ABCD]\nMV "docs/with space.ts"' }))).toContain("docs/with space.ts");
		expect(blocks(call("edit", { input: "¶docs/legacy.ts#ABCD\nPUT 1.=1:\n+x" }))).toContain("docs/legacy.ts");
		expect(blocks(call("edit", { _input: "[docs/x.md#ABCD]\nREM" }))).toContain("docs/x.md");
		expect(blocks(call("edit", { _path: "docs/x.md" }))).toContain("docs/x.md");
		expect(blocks(call("edit", { input: "*** Begin Patch\n*** Update File: docs/x.md\n@@\n-a\n+b\n*** End Patch" }))).toContain("docs/x.md");
		expect(blocks(call("edit", { input: "*** Add File: docs/new.md\n+x\n*** Delete File: src/a.ts" }))).toContain("docs/new.md");
		expect(blocks(call("edit", { input: "*** Update File: src/a.ts\n*** Move to: docs/moved.ts" }))).toContain("docs/moved.ts");
	});

	test("an edit of a locked test is blocked however it names it", () => {
		const call = guard();
		expect(blocks(call("edit", { input: "[src/locked.test.ts#ABCD]\nPUT 1.=1:\n+x" }))).toContain("locked test");
		expect(blocks(call("edit", { path: "src/locked.test.ts" }))).toContain("locked test");
		expect(blocks(call("edit", { input: "[src/a.ts#ABCD]\nMV src/locked.test.ts" }))).toContain("locked test");
		expect(blocks(guard({ lockedFiles: ["./src/locked.test.ts"] })("write", { path: "src/locked.test.ts", content: "x" }))).toContain("locked test");
	});

	test("lines of an edit body that only look like headers are not read as paths", () => {
		const call = guard();
		expect(call("edit", { input: "[src/a.ts#ABCD]\nPUT 1.=1:\n+[docs/x.md#ABCD]\n+MV docs/y.md" })).toBeUndefined();
	});

	test("tool devices and other URLs are not repo files", () => {
		const call = guard();
		expect(call("write", { path: "xd://lsp", content: "{}" })).toBeUndefined();
		expect(call("write", { path: "local://handoff.md", content: "x" })).toBeUndefined();
		expect(blocks(call("write", { path: "file:///etc/passwd", content: "x" }))).toContain("outside the worktree");
		expect(call("write", { path: "file:///work/tree/src/a.ts", content: "x" })).toBeUndefined();
	});

	test("a call without a usable input is not blocked", () => {
		const call = guard();
		expect(call("write", {})).toBeUndefined();
		expect(call("edit", {})).toBeUndefined();
		expect(call("bash", {})).toBeUndefined();
	});
});

describe("scopeCheck", () => {
	const scope = ["src/a.ts", "t/"];

	const sh = (cwd: string, script: string, env: Record<string, string> = {}) => {
		const result = Bun.spawnSync({ cmd: ["sh", "-c", script], cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
		if (result.exitCode !== 0) throw new Error(`${script}: ${result.stderr.toString()}`);
	};

	test("a clean worktree and changes inside the scope report nothing", () => {
		const repo = initRepo();
		expect(scopeCheck(repo, scope, [])).toEqual([]);
		writeFileSync(join(repo, "src/a.ts"), "export const a = 2;\n");
		mkdirSync(join(repo, "t/deep"), { recursive: true });
		writeFileSync(join(repo, "t/deep/new.sh"), "exit 0\n");
		expect(scopeCheck(repo, scope, [])).toEqual([]);
	});

	test("a file written by a bash redirect outside the scope is caught", () => {
		const repo = initRepo();
		sh(repo, "echo hacked > notes.txt");
		sh(repo, "echo more >> src/b.ts");
		// `git status` lists tracked changes first, then untracked files.
		expect(scopeCheck(repo, scope, [])).toEqual([
			{ path: "src/b.ts", reason: "outside-scope" },
			{ path: "notes.txt", reason: "outside-scope" },
		]);
	});

	test("every untracked file is listed on its own, so a new directory cannot hide one", () => {
		const repo = initRepo();
		sh(repo, "mkdir -p u/v && echo x > u/v/one.txt && echo y > u/two.txt");
		expect(scopeCheck(repo, scope, []).map(f => f.path)).toEqual(["u/two.txt", "u/v/one.txt"]);
	});

	test("deletions, staged changes and a locked file are caught", () => {
		const repo = initRepo();
		rmSync(join(repo, "src/b.ts"));
		writeFileSync(join(repo, "src/a.ts"), "export const a = 3;\n");
		git(repo, "add", "-A");
		const found = scopeCheck(repo, scope, ["src/a.ts"]);
		expect(found).toEqual([
			{ path: "src/a.ts", reason: "locked" },
			{ path: "src/b.ts", reason: "outside-scope" },
		]);
	});

	test("a path with spaces and non-ASCII characters is reported as written", () => {
		const repo = initRepo();
		sh(repo, "mkdir -p 'my dir' && echo x > 'my dir/é file.txt'");
		expect(scopeCheck(repo, scope, [])).toEqual([{ path: "my dir/é file.txt", reason: "outside-scope" }]);
	});

	test("a commit made behind the guard's back leaves a clean worktree, which is why the snapshot exists", () => {
		const repo = initRepo();
		const elsewhere = scratch();
		sh(elsewhere, "git commit --allow-empty -m sneaky", { GIT_DIR: join(repo, ".git"), GIT_WORK_TREE: repo });
		expect(scopeCheck(repo, scope, [])).toEqual([]);
	});

	test("it throws outside a git work tree", () => {
		expect(() => scopeCheck(scratch(), scope, [])).toThrow(/git status failed/);
	});
});

describe("snapshotGit and compareSnapshot", () => {
	const sh = (cwd: string, script: string, env: Record<string, string> = {}) => {
		const result = Bun.spawnSync({ cmd: ["sh", "-c", script], cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
		if (result.exitCode !== 0) throw new Error(`${script}: ${result.stderr.toString()}`);
	};

	test("records HEAD, its branch, every ref and the local config; an untouched repo compares equal", () => {
		const repo = initRepo("git@github.com:org/backend.git");
		git(repo, "tag", "v0");
		git(repo, "branch", "side");
		const snap = snapshotGit(repo);
		const head = git(repo, "rev-parse", "HEAD");
		expect(snap.head).toBe(head);
		expect(snap.headRef).toBe("refs/heads/main");
		expect(snap.refs).toEqual({ "refs/heads/main": head, "refs/heads/side": head, "refs/tags/v0": head });
		expect(snap.config).toContain("remote.origin.url=git@github.com:org/backend.git");
		expect(compareSnapshot(snap, snapshotGit(repo))).toEqual([]);
		// Working tree edits and the index are not part of the snapshot.
		writeFileSync(join(repo, "src/a.ts"), "changed\n");
		git(repo, "add", "-A");
		expect(compareSnapshot(snap, snapshotGit(repo))).toEqual([]);
	});

	test("a ref moved by a commit made with GIT_DIR tricks from another folder is caught", () => {
		const repo = initRepo();
		const before = snapshotGit(repo);
		sh(scratch(), "git commit --allow-empty -m sneaky", { GIT_DIR: join(repo, ".git"), GIT_WORK_TREE: repo });
		const changes = compareSnapshot(before, snapshotGit(repo));
		expect(changes).toHaveLength(2);
		expect(changes[0]).toMatch(/^HEAD moved from [0-9a-f]{7} to [0-9a-f]{7}$/);
		expect(changes[1]).toMatch(/^ref refs\/heads\/main moved from [0-9a-f]{7} to [0-9a-f]{7}$/);
	});

	test("the snapshot reads the repo it is given, whatever GIT_DIR the caller's environment names", () => {
		const repo = initRepo();
		const other = initRepo();
		git(other, "commit", "-q", "--allow-empty", "-m", "other repo is ahead");
		const saved = process.env.GIT_DIR;
		process.env.GIT_DIR = join(other, ".git");
		try {
			expect(snapshotGit(repo).head).toBe(git(repo, "rev-parse", "HEAD"));
		} finally {
			if (saved === undefined) delete process.env.GIT_DIR;
			else process.env.GIT_DIR = saved;
		}
	});

	test("created, moved and deleted refs, a detached HEAD and tags are each listed", () => {
		const repo = initRepo();
		git(repo, "branch", "gone");
		git(repo, "branch", "moves");
		const before = snapshotGit(repo);
		const first = git(repo, "rev-parse", "HEAD");
		git(repo, "branch", "-D", "gone");
		git(repo, "commit", "-q", "--allow-empty", "-m", "next");
		const next = git(repo, "rev-parse", "HEAD");
		git(repo, "update-ref", "refs/heads/moves", next);
		git(repo, "tag", "v1");
		git(repo, "update-ref", "refs/notes/spec-checks", next);
		git(repo, "update-ref", "refs/remotes/origin/main", next);
		git(repo, "checkout", "-q", "--detach");
		const changes = compareSnapshot(before, snapshotGit(repo));
		const short = (sha: string) => sha.slice(0, 7);
		expect(changes).toEqual([
			`HEAD moved from ${short(first)} to ${short(next)}`,
			"HEAD now names a detached commit (was refs/heads/main)",
			`ref refs/heads/gone deleted (was ${short(first)})`,
			`ref refs/heads/main moved from ${short(first)} to ${short(next)}`,
			`ref refs/heads/moves moved from ${short(first)} to ${short(next)}`,
			`ref refs/notes/spec-checks created at ${short(next)}`,
			`ref refs/remotes/origin/main created at ${short(next)}`,
			`ref refs/tags/v1 created at ${short(next)}`,
		]);
	});

	test("config changes are listed, and credentials in URLs are hidden", () => {
		const repo = initRepo("https://user:hunter2@example.com/org/backend.git");
		const before = snapshotGit(repo);
		git(repo, "config", "alias.ci", "commit");
		git(repo, "config", "core.hooksPath", "/tmp/hooks");
		git(repo, "remote", "set-url", "origin", "https://user:swordfish@example.com/org/backend.git");
		const changes = compareSnapshot(before, snapshotGit(repo));
		expect(changes).toContain("config added: alias.ci=commit");
		expect(changes).toContain("config added: core.hookspath=/tmp/hooks");
		expect(changes).toContain("config removed: remote.origin.url=https://***@example.com/org/backend.git");
		expect(changes).toContain("config added: remote.origin.url=https://***@example.com/org/backend.git");
		expect(changes.join("\n")).not.toContain("hunter2");
		expect(changes.join("\n")).not.toContain("swordfish");
	});

	test("an unborn branch can be snapshotted, and its first commit is a change", () => {
		const repo = join(scratch(), "empty");
		mkdirSync(repo);
		git(repo, "init", "-q", "-b", "main");
		const before = snapshotGit(repo);
		expect(before).toMatchObject({ head: "", headRef: "refs/heads/main", refs: {} });
		git(repo, "commit", "-q", "--allow-empty", "-m", "first");
		const changes = compareSnapshot(before, snapshotGit(repo));
		expect(changes[0]).toMatch(/^HEAD moved from none to [0-9a-f]{7}$/);
		expect(changes[1]).toMatch(/^ref refs\/heads\/main created at [0-9a-f]{7}$/);
	});

	test("it throws outside a git repo", () => {
		expect(() => snapshotGit(scratch())).toThrow(/git for-each-ref failed/);
	});
});
