import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { PLAN_PATH, cleanScratch, commitFiles, git, scratch, storyWorld } from "./spec-fixtures";

afterEach(cleanScratch);

const SCRIPTS = resolve(import.meta.dir, "../../scripts");
const HOOK_CLI = join(SCRIPTS, "spec-hook.ts");
const GUARD = join(SCRIPTS, "spec-guard.ts");
const MARKER = "# managed-by: omp-starter spec-hook";

function run(args: string[]) {
	const result = Bun.spawnSync({ cmd: [process.execPath, HOOK_CLI, ...args], stdout: "pipe", stderr: "pipe" });
	return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

/** `git push` in `repo`: its exit code and everything git and the hook printed. */
function push(repo: string, ...args: string[]) {
	const result = Bun.spawnSync({ cmd: ["git", "-C", repo, "push", ...args], stdout: "pipe", stderr: "pipe" });
	return { code: result.exitCode, output: `${result.stdout.toString()}${result.stderr.toString()}` };
}

/** The story fixture (clone on PAC-1, vault with the plan), a local bare remote as `origin` that already has `main`, and the install flags. */
function world() {
	const w = storyWorld();
	const bare = join(scratch(), "remote.git");
	git(scratch(), "init", "-q", "--bare", bare);
	git(w.repo, "remote", "set-url", "origin", bare);
	git(w.repo, "push", "-q", "origin", "main");
	const install = (...extra: string[]) => run(["install", "--repo", w.repo, "--plan", PLAN_PATH, "--vault-git-dir", w.vault.gitDir, ...extra]);
	const hooks = join(w.repo, ".git/hooks");
	const remoteHas = (ref: string) => Bun.spawnSync(["git", "--git-dir", bare, "rev-parse", "--verify", "--quiet", ref]).exitCode === 0;
	return { ...w, bare, install, hooks, hook: join(hooks, "pre-push"), chained: join(hooks, "pre-push.local"), remoteHas };
}

function foreignHook(path: string, body: string): void {
	writeFileSync(path, `#!/bin/sh\n${body}\n`);
	chmodSync(path, 0o755);
}

describe("spec-hook install", () => {
	test("writes a marked, executable pre-push hook and the workflow config, and changes nothing else in the repo", () => {
		const { repo, vault, install, hook } = world();
		const before = git(repo, "config", "--local", "--list");
		const head = git(repo, "rev-parse", "HEAD");
		const result = install();
		expect(result).toMatchObject({ code: 0, stderr: "" });
		expect(result.stdout).toBe(`installed ${hook} (plan ${PLAN_PATH}, base main)\n`);

		const text = readFileSync(hook, "utf8");
		expect(text.startsWith("#!/bin/sh\n")).toBe(true);
		expect(text).toContain(MARKER);
		expect(text).toContain(`'${process.execPath}' '${GUARD}' --strict --repo "$PWD" --range "$range"`);
		expect(text).not.toContain("pre-push.local");
		expect(statSync(hook).mode & 0o111).toBe(0o111);
		expect(JSON.parse(readFileSync(join(repo, ".git/spec-workflow.json"), "utf8"))).toEqual({ plan: PLAN_PATH, base: "main", vaultGitDir: vault.gitDir });

		expect(git(repo, "config", "--local", "--list")).toBe(before);
		expect(git(repo, "status", "--porcelain")).toBe("");
		expect(git(repo, "rev-parse", "HEAD")).toBe(head);
	});

	test("--base and --vault-git-dir are saved; without --vault-git-dir the default is not written", () => {
		const { repo, vault } = world();
		expect(run(["install", "--repo", repo, "--plan", PLAN_PATH, "--base", "PAC-1"]).code).toBe(0);
		expect(JSON.parse(readFileSync(join(repo, ".git/spec-workflow.json"), "utf8"))).toEqual({ plan: PLAN_PATH, base: "PAC-1" });
		expect(run(["install", "--repo", repo, "--plan", PLAN_PATH, "--vault-git-dir", vault.gitDir]).code).toBe(0);
		expect(JSON.parse(readFileSync(join(repo, ".git/spec-workflow.json"), "utf8"))).toEqual({ plan: PLAN_PATH, base: "main", vaultGitDir: vault.gitDir });
	});

	test("installing again rewrites its own hook and config", () => {
		const { repo, install, hook } = world();
		install();
		const first = readFileSync(hook, "utf8");
		expect(run(["install", "--repo", repo, "--plan", "Specs/other/plan.md", "--base", "PAC-1"]).code).toBe(0);
		expect(readFileSync(hook, "utf8")).toBe(first);
		expect(JSON.parse(readFileSync(join(repo, ".git/spec-workflow.json"), "utf8"))).toEqual({ plan: "Specs/other/plan.md", base: "PAC-1" });
	});

	test("a pre-push hook that is not ours is refused, and nothing is touched", () => {
		const { install, hook, hooks, repo } = world();
		foreignHook(hook, "echo mine");
		const result = install();
		expect(result.code).toBe(2);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("already exists and is not managed by spec-hook; run again with --chain");
		expect(readFileSync(hook, "utf8")).toBe("#!/bin/sh\necho mine\n");
		expect(existsSync(join(hooks, "pre-push.local"))).toBe(false);
		expect(existsSync(join(repo, ".git/spec-workflow.json"))).toBe(false);
	});

	test("--chain keeps the existing hook as pre-push.local and runs it first, with git's arguments and input", () => {
		const { repo, install, hook, chained, work } = world();
		const log = join(scratch(), "chained.log");
		foreignHook(hook, `echo "args: $*" > '${log}'; cat >> '${log}'`);
		const result = install("--chain");
		expect(result.code).toBe(0);
		expect(result.stdout).toContain(`the previous hook runs first as ${chained}`);
		expect(readFileSync(chained, "utf8")).toContain("echo \"args: $*\"");
		expect(statSync(chained).mode & 0o111).toBe(0o111);
		expect(readFileSync(hook, "utf8")).toContain(MARKER);
		expect(readFileSync(hook, "utf8")).toContain("# chained-hook: pre-push.local");

		const good = work({ "src/a.ts": "export const a = 2;\n" }, "good");
		expect(push(repo, "origin", "PAC-1").code).toBe(0);
		const lines = readFileSync(log, "utf8").trim().split("\n");
		expect(lines[0]).toMatch(/^args: origin .*remote\.git$/);
		expect(lines[1]).toBe(`refs/heads/PAC-1 ${good} refs/heads/PAC-1 ${"0".repeat(40)}`);
	});

	test("a chained hook that fails blocks the push before the guard runs; reinstalling keeps the chain", () => {
		const { repo, install, hook, remoteHas, work } = world();
		foreignHook(hook, "echo 'chained says no' >&2; exit 1");
		install("--chain");
		work({ "src/a.ts": "export const a = 2;\n" }, "good");
		const blocked = push(repo, "origin", "PAC-1");
		expect(blocked.code).not.toBe(0);
		expect(blocked.output).toContain("chained says no");
		expect(remoteHas("refs/heads/PAC-1")).toBe(false);

		expect(install().code).toBe(0);
		expect(readFileSync(hook, "utf8")).toContain("# chained-hook: pre-push.local");
		expect(push(repo, "origin", "PAC-1").code).not.toBe(0);
	});

	test("--chain refuses to overwrite an existing pre-push.local", () => {
		const { install, hook, chained } = world();
		foreignHook(hook, "echo one");
		foreignHook(chained, "echo two");
		const result = install("--chain");
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("pre-push.local already exists");
		expect(readFileSync(hook, "utf8")).toBe("#!/bin/sh\necho one\n");
		expect(readFileSync(chained, "utf8")).toBe("#!/bin/sh\necho two\n");
	});

	test("--chain with nothing to chain installs a plain hook", () => {
		const { install, hook, chained } = world();
		expect(install("--chain").code).toBe(0);
		expect(readFileSync(hook, "utf8")).not.toContain("pre-push.local");
		expect(existsSync(chained)).toBe(false);
	});

	test("core.hooksPath would hide .git/hooks, so install refuses", () => {
		const { repo, install, hook } = world();
		git(repo, "config", "core.hooksPath", ".husky");
		const result = install();
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("core.hooksPath is set to .husky");
		expect(existsSync(hook)).toBe(false);
		expect(existsSync(join(repo, ".git/spec-workflow.json"))).toBe(false);
	});

	test("exit 2 for usage errors and bad input", () => {
		const { repo } = world();
		const absent = join(scratch(), "absent");
		const cases: Array<[string[], RegExp]> = [
			[[], /missing command/],
			[["reinstall"], /unknown command reinstall/],
			[["install"], /missing --repo/],
			[["install", "--repo", repo], /missing --plan/],
			[["install", "--repo", repo, "--plan", "/abs/plan.md"], /not a file path/],
			[["install", "--repo", repo, "--plan", PLAN_PATH, "--base", "no-such-base"], /base no-such-base is not a commit/],
			[["install", "--repo", absent, "--plan", PLAN_PATH], /git rev-parse failed|not a git/],
			[["install", "--repo", repo, "--plan", PLAN_PATH, "--bogus"], /unknown option --bogus/],
			[["install", "extra", "--repo", repo, "--plan", PLAN_PATH], /unexpected argument extra/],
			[["uninstall"], /missing --repo/],
		];
		for (const [args, message] of cases) {
			const result = run(args);
			expect(result.code).toBe(2);
			expect(result.stdout).toBe("");
			expect(result.stderr).toMatch(message);
		}
		expect(run([]).stderr).toContain("Usage: bun scripts/spec-hook.ts install");
	});
});

describe("spec-hook uninstall", () => {
	test("removes the marked hook and the config", () => {
		const { repo, install, hook } = world();
		install();
		const result = run(["uninstall", "--repo", repo]);
		expect(result).toEqual({ code: 0, stdout: `removed ${hook}\n`, stderr: "" });
		expect(existsSync(hook)).toBe(false);
		expect(existsSync(join(repo, ".git/spec-workflow.json"))).toBe(false);
	});

	test("puts a chained hook back exactly as it was", () => {
		const { repo, install, hook, chained } = world();
		foreignHook(hook, "echo original");
		const original = readFileSync(hook, "utf8");
		install("--chain");
		const result = run(["uninstall", "--repo", repo]);
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("restored the previous pre-push hook");
		expect(readFileSync(hook, "utf8")).toBe(original);
		expect(statSync(hook).mode & 0o111).toBe(0o111);
		expect(existsSync(chained)).toBe(false);
		expect(existsSync(join(repo, ".git/spec-workflow.json"))).toBe(false);
	});

	test("a hook that is not ours is left alone, and so is a stray pre-push.local", () => {
		const { repo, hook, chained, install } = world();
		foreignHook(hook, "echo theirs");
		foreignHook(chained, "echo stray");
		const result = run(["uninstall", "--repo", repo]);
		expect(result.code).toBe(0);
		expect(result.stdout).toBe(`${hook} is not managed by spec-hook; left alone\n`);
		expect(readFileSync(hook, "utf8")).toBe("#!/bin/sh\necho theirs\n");
		expect(readFileSync(chained, "utf8")).toBe("#!/bin/sh\necho stray\n");
		expect(install().code).toBe(2);
	});

	test("an unchained install leaves an unrelated pre-push.local in place", () => {
		const { repo, install, hook, chained } = world();
		install();
		foreignHook(chained, "echo unrelated");
		run(["uninstall", "--repo", repo]);
		expect(existsSync(hook)).toBe(false);
		expect(readFileSync(chained, "utf8")).toBe("#!/bin/sh\necho unrelated\n");
	});

	test("with no hook there is nothing to do", () => {
		const { repo } = world();
		const result = run(["uninstall", "--repo", repo]);
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("nothing to remove");
	});
});

describe("the hook on a push to a local bare remote", () => {
	/** `world()` with the hook installed. */
	function pushWorld() {
		const w = world();
		expect(w.install().code).toBe(0);
		return w;
	}

	test("an out-of-scope commit blocks the push; after the fix the push goes through", () => {
		const { repo, work, remoteHas } = pushWorld();
		work({ "docs/notes.md": "outside T1's scope\n" }, "out of scope");
		const blocked = push(repo, "origin", "PAC-1");
		expect(blocked.code).not.toBe(0);
		expect(blocked.output).toContain("out-of-scope");
		expect(blocked.output).toContain("docs/notes.md");
		expect(blocked.output).toContain("1 violation in 1 of 1 commit");
		expect(remoteHas("refs/heads/PAC-1")).toBe(false);

		git(repo, "reset", "-q", "--hard", "main");
		work({ "src/a.ts": "export const a = 2;\n" }, "in scope");
		const allowed = push(repo, "origin", "PAC-1");
		expect(allowed.code).toBe(0);
		expect(remoteHas("refs/heads/PAC-1")).toBe(true);
	});

	test("an update of an existing remote branch is judged on the new commits only", () => {
		const { repo, work, remoteHas, bare } = pushWorld();
		const first = work({ "src/a.ts": "export const a = 2;\n" }, "first");
		expect(push(repo, "origin", "PAC-1").code).toBe(0);
		work({ "docs/notes.md": "x\n" }, "second, out of scope");
		const blocked = push(repo, "origin", "PAC-1");
		expect(blocked.code).not.toBe(0);
		expect(blocked.output).toContain("1 violation in 1 of 1 commit");
		expect(blocked.output).not.toContain(first.slice(0, 7));
		expect(remoteHas("refs/heads/PAC-1")).toBe(true);
		expect(Bun.spawnSync(["git", "--git-dir", bare, "rev-parse", "PAC-1"]).stdout.toString().trim()).toBe(first);
	});

	test("a commit without Task: blocks the push (strict), and --no-verify is the human way around", () => {
		const { repo, work, remoteHas } = pushWorld();
		work({ "src/a.ts": "export const a = 2;\n" }, "tracked");
		commitFiles(repo, { "src/b.ts": "export const b = 5;\n" }, "plain commit");
		const blocked = push(repo, "origin", "PAC-1");
		expect(blocked.code).not.toBe(0);
		expect(blocked.output).toContain("untracked-commit");
		expect(remoteHas("refs/heads/PAC-1")).toBe(false);
		expect(push(repo, "--no-verify", "origin", "PAC-1").code).toBe(0);
		expect(remoteHas("refs/heads/PAC-1")).toBe(true);
	});

	test("deleting a remote branch is not judged", () => {
		const { repo, work, remoteHas } = pushWorld();
		work({ "src/a.ts": "export const a = 2;\n" }, "tracked");
		expect(push(repo, "origin", "PAC-1").code).toBe(0);
		expect(push(repo, "origin", "--delete", "PAC-1").code).toBe(0);
		expect(remoteHas("refs/heads/PAC-1")).toBe(false);
	});

	test("several refs in one push are each judged; one bad ref blocks the whole push", () => {
		const { repo, work, remoteHas } = pushWorld();
		work({ "src/a.ts": "export const a = 2;\n" }, "good");
		git(repo, "branch", "good-branch");
		work({ "docs/notes.md": "x\n" }, "bad");
		git(repo, "branch", "bad-branch");
		const blocked = push(repo, "origin", "good-branch", "bad-branch");
		expect(blocked.code).not.toBe(0);
		expect(remoteHas("refs/heads/good-branch")).toBe(false);
		expect(remoteHas("refs/heads/bad-branch")).toBe(false);
	});

	test("from a linked worktree, where git exports GIT_DIR to the hook, the guard still reads the right repo", () => {
		const { repo, rev, remoteHas } = pushWorld();
		const tree = join(scratch(), "linked");
		git(repo, "worktree", "add", "-q", "-b", "PAC-2", tree, "main");
		commitFiles(tree, { "docs/notes.md": "x\n" }, "bad", "Task: T1", `Plan-Rev: ${rev}`);
		const blocked = push(tree, "origin", "PAC-2");
		expect(blocked.code).not.toBe(0);
		expect(blocked.output).toContain("out-of-scope");
		git(tree, "reset", "-q", "--hard", "main");
		commitFiles(tree, { "src/a.ts": "export const a = 9;\n" }, "good", "Task: T1", `Plan-Rev: ${rev}`);
		expect(push(tree, "origin", "PAC-2").code).toBe(0);
		expect(remoteHas("refs/heads/PAC-2")).toBe(true);
	});

	test("a hook that cannot read its plan blocks the push with the reason", () => {
		const { repo, work, remoteHas } = pushWorld();
		work({ "src/a.ts": "export const a = 2;\n" }, "good");
		writeFileSync(join(repo, ".git/spec-workflow.json"), JSON.stringify({ plan: PLAN_PATH, base: "main", vaultGitDir: join(scratch(), "absent") }));
		const blocked = push(repo, "origin", "PAC-1");
		expect(blocked.code).not.toBe(0);
		expect(blocked.output).toContain("does not exist; set up the vault spec store first");
		expect(remoteHas("refs/heads/PAC-1")).toBe(false);
	});
});
