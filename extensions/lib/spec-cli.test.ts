import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { UsageError, parseArgs, readWorkflowConfig, resolveBun, writeWorkflowConfig } from "./spec-cli";
import { CHECKS, PLAN_PATH, cleanScratch, commit, git, scratch, storyWorld } from "./spec-fixtures";
import { readCheckNote } from "./spec-git";

afterEach(cleanScratch);

const SCRIPTS = resolve(import.meta.dir, "../../scripts");
const GUARD = join(SCRIPTS, "spec-guard.ts");
const CHECK = join(SCRIPTS, "spec-check.ts");
const STATUS = join(SCRIPTS, "spec-status.ts");

function run(script: string, args: string[], env: Record<string, string> = {}) {
	const result = Bun.spawnSync({ cmd: [process.execPath, script, ...args], stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env } });
	return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

/** The story fixture plus the flags that point the CLIs at it. */
function cli(checks?: Record<string, string>) {
	const w = storyWorld(checks);
	const flags = ["--repo", w.repo, "--plan", PLAN_PATH, "--vault-git-dir", w.vault.gitDir, "--base", "main"];
	return { ...w, flags };
}

describe("parseArgs", () => {
	const spec = { bool: ["json"], value: ["repo"], list: ["tag"] };

	test("flags, repeated list flags, positionals and the last value win", () => {
		const args = parseArgs(["abc", "--json", "--repo", "a", "--tag", "x", "--repo", "b", "--tag", "y", "def"], spec);
		expect(args.positional).toEqual(["abc", "def"]);
		expect([args.bool("json"), args.value("repo"), args.list("tag")]).toEqual([true, "b", ["x", "y"]]);
		const none = parseArgs([], spec);
		expect([none.bool("json"), none.value("repo"), none.list("tag")]).toEqual([false, undefined, []]);
	});

	test("an unknown flag and a missing value are usage errors", () => {
		expect(() => parseArgs(["--bogus"], spec)).toThrow(UsageError);
		expect(() => parseArgs(["--repo"], spec)).toThrow("--repo needs a value");
		expect(() => parseArgs(["--tag"], spec)).toThrow("--tag needs a value");
	});
});

describe("resolveBun", () => {
	test("bun itself is used as it is; inside omp (execPath is the omp binary) bun comes from PATH; no bun is a clear error", () => {
		const which = (name: string): string | null => (name === "bun" ? "/opt/bun/bin/bun" : null);
		expect(resolveBun("/usr/local/bin/bun", which)).toBe("/usr/local/bin/bun");
		expect(resolveBun("/tools/Bun.exe", which)).toBe("/tools/Bun.exe");
		expect(resolveBun("/usr/local/bin/omp", which)).toBe("/opt/bun/bin/bun");
		expect(() => resolveBun("/usr/local/bin/omp", () => null)).toThrow(/bun was not found on PATH.*\/usr\/local\/bin\/omp/);
	});
});

describe("workflow config", () => {
	test("is saved in the git dir, read back, and rejected when malformed", () => {
		const { repo } = cli();
		expect(readWorkflowConfig(repo)).toBeUndefined();
		writeWorkflowConfig(repo, { plan: "Specs/a/plan.md", base: "main", vaultGitDir: "/v" });
		expect(readWorkflowConfig(repo)).toEqual({ plan: "Specs/a/plan.md", base: "main", vaultGitDir: "/v" });
		writeWorkflowConfig(repo, { plan: "Specs/a/plan.md", base: "main" });
		expect(readWorkflowConfig(repo)).toEqual({ plan: "Specs/a/plan.md", base: "main" });
		writeFileSync(join(repo, ".git/spec-workflow.json"), "{not json");
		expect(() => readWorkflowConfig(repo)).toThrow(/is not valid JSON/);
		writeFileSync(join(repo, ".git/spec-workflow.json"), JSON.stringify({ plan: 3 }));
		expect(() => readWorkflowConfig(repo)).toThrow(/must hold/);
	});
});

describe("spec-guard CLI", () => {
	test("exit 0 with a summary when the range is clean", () => {
		const { work, flags } = cli();
		work({ "src/a.ts": "export const a = 2;\n" });
		work({ "src/a.ts": "export const a = 3;\n" });
		const result = run(GUARD, flags);
		expect(result).toEqual({ code: 0, stdout: "ok: 2 commits checked, no violations\n", stderr: "" });
		expect(run(GUARD, ["--json", ...flags]).stdout).toBe(`${JSON.stringify({ ok: true, commits: 2, violations: [] }, null, 2)}\n`);
	});

	test("exit 1 with one line per violation and a summary, as text and as JSON", () => {
		const { work, flags } = cli();
		const bad = work({ "src/a.ts": 'it.skip("x", f);\n', "docs/notes.md": "x\n" });
		work({ "src/a.ts": "export const a = 3;\n" });
		const text = run(GUARD, flags);
		expect(text.code).toBe(1);
		expect(text.stdout.trim().split("\n")).toEqual([
			`out-of-scope ${bad.slice(0, 7)} T1 docs/notes.md: docs/notes.md is outside owns and new_paths of T1`,
			expect.stringContaining(`skip-added ${bad.slice(0, 7)} T1 src/a.ts: src/a.ts:1 adds a skipped or focused test`),
			"2 violations in 1 of 2 commits",
		]);
		const json = JSON.parse(run(GUARD, ["--json", ...flags]).stdout);
		expect(json).toMatchObject({ ok: false, commits: 2 });
		expect(json.violations.map((v: { rule: string; sha: string }) => [v.rule, v.sha])).toEqual([["out-of-scope", bad], ["skip-added", bad]]);
	});

	test("--strict rejects a commit without Task:; without it the commit is tolerated", () => {
		const { repo, work, flags } = cli();
		work({ "src/a.ts": "export const a = 2;\n" });
		const stray = commit(repo, "stray");
		expect(run(GUARD, flags).code).toBe(0);
		const strict = run(GUARD, ["--strict", ...flags]);
		expect(strict.code).toBe(1);
		expect(strict.stdout).toContain(`untracked-commit ${stray.slice(0, 7)}: the commit has no Task: trailer`);
	});

	test("--range: an empty side means the base or HEAD, a range can be narrowed, a three-dot range is refused", () => {
		const { repo, work, flags } = cli();
		const first = work({ "docs/a.md": "bad\n" });
		work({ "src/a.ts": "export const a = 2;\n" });
		const withRange = (range: string) => run(GUARD, [...flags, "--range", range]);
		expect(withRange("main..PAC-1").code).toBe(1);
		expect(withRange("..PAC-1").code).toBe(1);
		expect(withRange("main..").code).toBe(1);
		expect(withRange(`${first}..PAC-1`)).toMatchObject({ code: 0, stdout: "ok: 1 commit checked, no violations\n" });
		expect(withRange("main...PAC-1")).toMatchObject({ code: 2 });
		expect(withRange("main").code).toBe(2);
		expect(withRange("main..PAC-1..x").code).toBe(2);
		git(repo, "checkout", "-q", "main");
		expect(run(GUARD, flags).stdout).toBe("ok: 0 commits checked, no violations\n");
	});

	test("an unreadable Plan-Rev is a violation (exit 1), not an IO error", () => {
		const { repo, flags } = cli();
		commit(repo, "who knows", "Task: T1", "Plan-Rev: deadbeef");
		const result = run(GUARD, flags);
		expect(result.code).toBe(1);
		expect(result.stdout).toContain("plan-rev-unreadable");
	});

	test("plan, base and vault dir default to the clone's saved workflow config; flags override it", () => {
		const { repo, work, vault } = cli();
		work({ "docs/a.md": "bad\n" });
		writeWorkflowConfig(repo, { plan: PLAN_PATH, base: "main", vaultGitDir: vault.gitDir });
		const saved = run(GUARD, ["--repo", repo]);
		expect(saved.code).toBe(1);
		expect(saved.stdout).toContain("out-of-scope");
		expect(run(GUARD, ["--repo", repo, "--base", "PAC-1"]).stdout).toBe("ok: 0 commits checked, no violations\n");
		const wrongVault = run(GUARD, ["--repo", repo, "--vault-git-dir", join(scratch(), "absent")]);
		expect(wrongVault.code).toBe(2);
	});

	test("exit 2 for usage errors and IO errors, with the reason on stderr and nothing on stdout", () => {
		const { repo, vault, flags } = cli();
		const absent = join(scratch(), "absent");
		const cases: Array<[string[], RegExp]> = [
			[[], /missing --repo/],
			[["--repo", repo], /missing --plan/],
			[["--repo", repo, "--plan", "/abs/plan.md"], /not a file path/],
			[[...flags, "--bogus"], /unknown option --bogus/],
			[[...flags, "extra"], /unexpected argument extra/],
			[["--repo"], /--repo needs a value/],
			[[...flags.slice(0, 6), "--vault-git-dir", absent], /vault git dir .* does not exist; set up the vault spec store first \(vgit, build step 0\)/],
			[["--repo", repo, "--plan", PLAN_PATH, "--vault-git-dir", vault.gitDir, "--base", "no-such-base"], /base no-such-base is not a commit/],
			[["--repo", absent, "--plan", PLAN_PATH, "--vault-git-dir", vault.gitDir], /git rev-parse failed/],
			[[...flags, "--range", "main..no-such-ref"], /git log failed/],
		];
		for (const [args, message] of cases) {
			const result = run(GUARD, args);
			expect(result.code).toBe(2);
			expect(result.stdout).toBe("");
			expect(result.stderr).toMatch(message);
		}
		expect(run(GUARD, []).stderr).toContain("Usage: bun scripts/spec-guard.ts");
	});
});

describe("spec-check CLI", () => {
	test("guard, check and status in turn: the note spec-check writes is what spec-status reads as done", () => {
		const { repo, work, flags, text } = cli();
		const plan = join(scratch(), "plan.md");
		writeFileSync(plan, text(CHECKS));
		const sha = work({ "src/a.ts": "export const a = 2;\n", "t/a.sh": "exit 0\n" });
		const statusArgs = [plan, "--repo", repo, "--branch", "PAC-1", "--base", "main", "--json"];
		expect(JSON.parse(run(STATUS, statusArgs).stdout).tasks[0]).toEqual({ id: "T1", state: "awaiting-lock", lastSha: sha });

		expect(run(GUARD, ["--strict", ...flags])).toEqual({ code: 0, stdout: "ok: 1 commit checked, no violations\n", stderr: "" });

		const checked = run(CHECK, [sha, ...flags]);
		expect(checked.code).toBe(0);
		expect(checked.stderr).toBe("");
		const lines = checked.stdout.trimEnd().split("\n");
		expect(lines[0]).toBe(`spec-check ${sha.slice(0, 7)} T1 attempt 1`);
		expect(lines[1]).toMatch(/^ {2}test {6}pass {2}\(\d+\.\ds\)$/);
		expect(lines[2]).toMatch(/^ {2}typecheck pass {2}\(\d+\.\ds\)$/);
		expect(lines.slice(3)).toEqual(["  lint      skip", "  guard     pass", `note written on ${sha.slice(0, 7)}: all checks passed`]);
		expect(readCheckNote(repo, sha)).toMatchObject({ task: "T1", attempts: 1, checks: { test: "pass", typecheck: "pass", lint: "skip", guard: "pass" } });

		const status = JSON.parse(run(STATUS, statusArgs).stdout);
		expect(status.tasks[0]).toEqual({ id: "T1", state: "done", lastSha: sha, attempts: 1 });
		expect(status.tasks[1]).toEqual({ id: "T2", state: "ready" });
	});

	test("a failing test: exit 1, the output tail is shown, the note says fail, and the next try counts attempt 2", () => {
		const { repo, work, flags, text } = cli();
		const plan = join(scratch(), "plan.md");
		writeFileSync(plan, text(CHECKS));
		const bad = work({ "t/a.sh": 'echo "expected 2, got 1" >&2\nexit 1\n' });
		const first = run(CHECK, [bad, ...flags]);
		expect(first.code).toBe(1);
		expect(first.stdout).toContain("  test      fail  (exit 1)\n    | expected 2, got 1\n");
		expect(first.stdout).toContain(`note written on ${bad.slice(0, 7)}: failing`);
		const statusArgs = [plan, "--repo", repo, "--branch", "PAC-1", "--base", "main", "--json"];
		expect(JSON.parse(run(STATUS, statusArgs).stdout).tasks[0]).toEqual({ id: "T1", state: "failing", lastSha: bad, attempts: 1, reason: "test" });

		const good = work({ "t/a.sh": "exit 0\n" });
		const second = run(CHECK, [good, ...flags]);
		expect(second.code).toBe(0);
		expect(second.stdout).toContain(`spec-check ${good.slice(0, 7)} T1 attempt 2`);
		expect(JSON.parse(run(STATUS, statusArgs).stdout).tasks[0]).toEqual({ id: "T1", state: "done", lastSha: good, attempts: 2 });
	});

	test("a guard violation fails the check: exit 1, the violation is listed, the other checks still ran", () => {
		const { repo, work, flags } = cli();
		const sha = work({ "docs/notes.md": "x\n" });
		const result = run(CHECK, [sha, ...flags]);
		expect(result.code).toBe(1);
		expect(result.stdout).toContain("  guard     fail\n    out-of-scope");
		expect(readCheckNote(repo, sha)?.checks).toEqual({ test: "pass", typecheck: "pass", lint: "skip", guard: "fail" });
	});

	test("--json prints the note, the results and the violations", () => {
		const { work, flags } = cli();
		const sha = work({ "t/a.sh": "exit 0\n" });
		const json = JSON.parse(run(CHECK, [sha, "--json", ...flags]).stdout);
		expect(json).toMatchObject({ ok: true, sha, task: "T1", attempts: 1, checks: { test: "pass", typecheck: "pass", lint: "skip", guard: "pass" }, violations: [] });
		expect(json.results.map((r: { name: string; status: string }) => [r.name, r.status])).toEqual([["test", "pass"], ["typecheck", "pass"], ["lint", "skip"]]);
		expect(json.note).toMatchObject({ v: 1, task: "T1", blocked: false, reason: "" });
	});

	test("--timeout bounds each command: a slow test fails with reason timeout", () => {
		const { repo, work, flags } = cli({ test: "sleep 30", typecheck: "true" });
		const sha = work({ "src/a.ts": "export const a = 2;\n" });
		const result = run(CHECK, [sha, ...flags, "--timeout", "0.3"]);
		expect(result.code).toBe(1);
		expect(result.stdout).toContain("  test      fail  (timeout)");
		expect(readCheckNote(repo, sha)?.checks.test).toBe("fail");
	});

	test("exit 2 and no note when the checks cannot run", () => {
		const { repo, work, flags } = cli();
		const sha = work({ "src/a.ts": "export const a = 2;\n" });
		const untagged = commit(repo, "no trailers");
		const absent = join(scratch(), "absent");
		const cases: Array<[string[], RegExp, Record<string, string>?]> = [
			[flags, /missing <sha>/],
			[[sha, "extra", ...flags], /unexpected argument extra/],
			[[sha, ...flags, "--timeout", "0"], /--timeout must be a positive number/],
			[[sha, ...flags, "--timeout", "soon"], /--timeout must be a positive number/],
			[[untagged, ...flags], /has no Task: trailer/],
			[["no-such-rev", ...flags], /git rev-parse failed/],
			[[sha, ...flags.slice(0, 2), "--plan", "Specs/none.md", ...flags.slice(4)], /does not exist at that commit of the vault/],
			[[sha, ...flags.slice(0, 4), "--vault-git-dir", absent, "--base", "main"], /vault git dir .* does not exist/],
			[[sha, ...flags], /ENOENT|No such file|mkdtemp/, { TMPDIR: absent }],
		];
		for (const [args, message, env] of cases) {
			const result = run(CHECK, args, env);
			expect(result.code).toBe(2);
			expect(result.stdout).toBe("");
			expect(result.stderr).toMatch(message);
		}
		expect(readCheckNote(repo, sha)).toBeUndefined();
		expect(readCheckNote(repo, untagged)).toBeUndefined();
		expect(run(CHECK, []).stderr).toContain("Usage: bun scripts/spec-check.ts");
		mkdirSync(absent);
	});
});
