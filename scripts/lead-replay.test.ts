import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { initGitRepo } from "../extensions/test-harness";

const SCRIPT = path.join(import.meta.dir, "lead-replay.ts");

function fixture(base: string | ((head: string) => string)) {
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), "lead-replay-test-"));
	initGitRepo(repo);
	execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-qm", "init"], { cwd: repo });
	const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
	const tasks = path.join(repo, "..", `${path.basename(repo)}-tasks.yml`);
	const sha = typeof base === "string" ? base : base(head);
	fs.writeFileSync(tasks, `tasks:\n  - { id: noop, repo: ${repo}, base: \"${sha}\", prompt: "noop", check: "true" }\n  - { id: second, repo: ${repo}, base: \"${sha}\", prompt: "noop", check: "true" }\n`);
	return { repo, tasks };
}

const replay = (...args: string[]) => {
	const run = Bun.spawnSync(["bun", SCRIPT, ...args]);
	return { code: run.exitCode, out: run.stdout.toString(), err: run.stderr.toString() };
};

describe("lead-replay", () => {
	test("without --yes it prints the run count, spends nothing and leaves no worktree behind", () => {
		const { repo, tasks } = fixture(head => head);
		expect(replay(tasks, "--runs", "2")).toEqual({
			code: 0,
			out: "lead-replay: 2 tasks × 2 variants × 2 runs = 8 omp runs (each spends model quota). Rerun with --yes.\n",
			err: "",
		});
		expect(execFileSync("git", ["worktree", "list"], { cwd: repo, encoding: "utf8" }).trim().split("\n")).toHaveLength(1);
	});

	test("a base that is not a commit of the repo exits 2 naming the task", () => {
		const { tasks } = fixture("0000000000000000000000000000000000000000");
		const run = replay(tasks, "--yes");
		expect(run.code).toBe(2);
		expect(run.err).toContain("tasks[0] (noop): base 0000000000000000000000000000000000000000 is not a commit");
		expect(run.out).toBe("");
	});

	test("a missing file or task list exits 2", () => {
		expect(replay("/nonexistent/tasks.yml").code).toBe(2);
		expect(replay().code).toBe(2);
	});
});

test("an unquoted all-digit base is refused with a hint instead of being read as a number", () => {
	const { repo, tasks } = fixture("1234567");
	fs.writeFileSync(tasks, `tasks:\n  - { id: noop, repo: ${repo}, base: 1234567, prompt: "noop", check: "true" }\n`);
	expect(replay(tasks, "--yes").err).toContain("tasks[0] (noop): base is required as a quoted string (YAML read it as a number)");
});
