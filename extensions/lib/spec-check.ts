// Runs a repo's declared checks and the guard on one commit and records the result as the check note `status` reads,
// and runs the "fails before" check for a task's new tests. Check commands are plan text and run through `sh -c` in a
// temporary git worktree, which is removed afterwards even when a command times out or throws.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadGuardInput } from "./spec-diff";
import { type CheckNote, cleanEnv, git, gitOrThrow, readCheckNote, readTaskCommits, writeCheckNote } from "./spec-git";
import { type GuardViolation, guardCommits } from "./spec-guard";
import { assertRepoPath } from "./spec-lock";
import type { RepoChecks } from "./spec-plan";

export type CheckStatus = CheckNote["checks"][string];

export const CHECK_NAMES = ["test", "typecheck", "lint"] as const;
export type CheckName = (typeof CHECK_NAMES)[number];

/** Each check command may run this long. */
export const DEFAULT_TIMEOUT_MS = 15 * 60_000;

/** Output kept from a command: its last bytes, which is where a failure is. */
const OUTPUT_TAIL = 32_768;
/** After a command exits, how long to keep reading a pipe that something it started still holds open. */
const PIPE_GRACE_MS = 2_000;

export interface CheckResult {
	name: CheckName;
	status: CheckStatus;
	/** Why a check failed: `timeout` or `exit <code>`. */
	reason?: string;
	/** The tail of the command's combined stdout and stderr. */
	output: string;
	ms: number;
}

/** Runs `fn` in a temporary detached worktree of `repo` at `rev`. Repo hooks are off for the checkout. The worktree and its metadata are removed afterwards. */
export async function withWorktree<T>(repo: string, rev: string, fn: (dir: string) => Promise<T>): Promise<T> {
	const root = mkdtempSync(join(tmpdir(), "spec-worktree-"));
	const dir = join(root, "tree");
	try {
		gitOrThrow(repo, ["-c", "core.hooksPath=/dev/null", "worktree", "add", "--detach", "--quiet", dir, rev]);
		return await fn(dir);
	} finally {
		git(repo, ["worktree", "remove", "--force", dir]);
		rmSync(root, { recursive: true, force: true });
		git(repo, ["worktree", "prune"]);
	}
}

interface Outcome {
	/** The exit code; null when the command was killed. */
	code: number | null;
	timedOut: boolean;
	output: string;
	ms: number;
}

/**
 * Runs `command` with `sh -c` in `cwd`, stderr folded into stdout, in its own process group so that a timeout kills everything it
 * started. The environment carries no repository-selecting git variables.
 */
async function runCommand(command: string, cwd: string, timeoutMs: number): Promise<Outcome> {
	const started = performance.now();
	const proc = Bun.spawn(["sh", "-c", `exec 2>&1\n${command}`], { cwd, env: cleanEnv(), stdin: "ignore", stdout: "pipe", detached: true });
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		try {
			process.kill(-proc.pid, "SIGKILL");
		} catch {
			// The group has already gone.
		}
	}, timeoutMs);

	const reader = proc.stdout.getReader();
	const decoder = new TextDecoder();
	let output = "";
	const drained = (async () => {
		for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
			output = (output + decoder.decode(chunk.value, { stream: true })).slice(-OUTPUT_TAIL);
		}
	})();

	await proc.exited;
	clearTimeout(timer);
	const { promise: grace, resolve } = Promise.withResolvers<void>();
	const wait = setTimeout(resolve, PIPE_GRACE_MS);
	await Promise.race([drained, grace]);
	clearTimeout(wait);
	await reader.cancel().catch(() => undefined);
	return { code: proc.exitCode, timedOut, output, ms: Math.round(performance.now() - started) };
}

/**
 * Runs `test`, `typecheck` and `lint` from `commands` in a temporary worktree at `sha`, one after another and all of them even
 * when one fails. An empty or missing command is a skip; a non-zero exit is a fail; a command over `timeoutMs` is a fail
 * with reason `timeout`.
 */
export async function runChecks(repo: string, sha: string, commands: RepoChecks, options: { timeoutMs?: number } = {}): Promise<CheckResult[]> {
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	return withWorktree(repo, sha, async dir => {
		const results: CheckResult[] = [];
		for (const name of CHECK_NAMES) {
			const command = commands[name]?.trim();
			if (!command) {
				results.push({ name, status: "skip", output: "", ms: 0 });
				continue;
			}
			const outcome = await runCommand(command, dir, timeoutMs);
			const failure = outcome.timedOut ? "timeout" : outcome.code === 0 ? undefined : `exit ${outcome.code}`;
			results.push({ name, status: failure === undefined ? "pass" : "fail", ...(failure === undefined ? {} : { reason: failure }), output: outcome.output, ms: outcome.ms });
		}
		return results;
	});
}

export interface CheckOptions {
	/** The plan's path inside the vault repo. */
	planPath: string;
	vaultGitDir: string;
	/** The range start: the ticket branch's base. The guard reads `<base>..<sha>`. */
	base: string;
	timeoutMs?: number;
}

export interface CheckReport {
	/** The full sha that was checked. */
	sha: string;
	task: string;
	attempts: number;
	results: CheckResult[];
	/** Guard findings about this task's commits. */
	violations: GuardViolation[];
	/** The note written on `sha`. */
	note: CheckNote;
	/** Every check passed or was skipped and the guard found nothing. */
	ok: boolean;
}

/**
 * Checks one commit: reads its `Task:` and `Plan-Rev:`, takes the task's repo `checks` from the plan at that `Plan-Rev`, runs them
 * in a temporary worktree at `rev`, runs the guard over the task's commits in `<base>..<rev>`, and writes the check note (`attempts`
 * is the nearest earlier note of the task plus one, so a rerun on the same commit does not count twice). Throws, and writes no note,
 * when the checks cannot be run: unknown commit or base, no or several `Task:` trailers, no `Plan-Rev:`, an unreadable or unparseable
 * plan, a task the plan lacks, no `checks.test` for its repo, no vault, or no worktree.
 */
export async function checkCommit(repo: string, rev: string, options: CheckOptions): Promise<CheckReport> {
	const sha = gitOrThrow(repo, ["rev-parse", "--verify", `${rev}^{commit}`]).trim();
	const input = loadGuardInput({ repo, from: options.base, to: sha, vaultGitDir: options.vaultGitDir, planPath: options.planPath }, false);
	const own = input.commits.find(commit => commit.sha === sha);
	if (!own) throw new Error(`${sha} is not in ${options.base}..${sha}; it is already part of the base`);
	if (own.tasks.length !== 1) {
		throw new Error(own.tasks.length === 0 ? `${sha} has no Task: trailer` : `${sha} serves several tasks (${own.tasks.join(", ")}); spec-check handles one task per commit`);
	}
	const task = own.tasks[0];
	if (own.planRev === undefined) throw new Error(`${sha} has no Plan-Rev trailer, so the plan's checks cannot be read`);
	const at = input.plans.get(own.planRev) ?? { unreadable: "was not loaded", violations: [] };
	if (at.unreadable !== undefined) throw new Error(`Plan-Rev ${own.planRev} of ${sha}: ${at.unreadable}`);
	if (!at.plan) throw new Error(`the plan at Plan-Rev ${own.planRev} does not parse: ${at.violations.map(v => v.detail).join("; ")}`);
	const block = at.plan.tasks.find(candidate => candidate.id === task);
	if (!block) throw new Error(`Task: ${task} of ${sha} is not in the plan at Plan-Rev ${own.planRev}`);
	const commands = at.plan.checks[block.repo];
	if (!commands?.test?.trim()) throw new Error(`the plan at Plan-Rev ${own.planRev} declares no checks.test for ${block.repo} (rule checks-missing)`);

	const results = await runChecks(repo, sha, commands, options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs });

	const taskShas = new Set(input.commits.filter(commit => commit.tasks.includes(task)).map(commit => commit.sha));
	const violations = guardCommits(input).filter(violation => taskShas.has(violation.sha));

	const earlier = readTaskCommits(repo, options.base, sha).filter(commit => commit.sha !== sha && commit.tasks.includes(task));
	let previous = 0;
	for (let i = earlier.length - 1; i >= 0; i--) {
		const prior = readCheckNote(repo, earlier[i].sha);
		if (prior) {
			previous = prior.attempts;
			break;
		}
	}

	const checks: CheckNote["checks"] = {};
	for (const result of results) checks[result.name] = result.status;
	checks.guard = violations.length === 0 ? "pass" : "fail";
	const note: CheckNote = { v: 1, task, plan_rev: own.planRev, checks, attempts: previous + 1, blocked: false, reason: "", at: new Date().toISOString() };
	writeCheckNote(repo, sha, note);
	return { sha, task, attempts: note.attempts, results, violations, note, ok: Object.values(checks).every(status => status !== "fail") };
}

export interface FailsBeforeFile {
	file: string;
	/** `fails`: the run exited non-zero on the base. `already-passes`: it exited zero, so the test proves nothing about the new work. */
	status: "fails" | "already-passes";
	/** `timeout` or `exit <code>` for a run that failed. */
	reason?: string;
	output: string;
}

export interface FailsBeforeResult {
	/** True when every file failed on the base; false refuses the lock. */
	ok: boolean;
	/** The commit the tests ran on: the parent of the task's first commit. */
	base: string;
	files: FailsBeforeFile[];
}

export interface FailsBeforeOptions {
	/** The range start of the ticket branch; the task's first commit is looked up in `<base>..<testCommitSha>`. */
	base: string;
	/** The task; by default the single `Task:` of `testCommitSha`. */
	task?: string;
	timeoutMs?: number;
}

const quote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

/** `{files}` becomes the file and `{packages}` its directory (`./dir`, or `.`), both single-quoted for the shell. */
function render(template: string, file: string): string {
	const dir = dirname(file);
	return template.replaceAll("{files}", () => quote(file)).replaceAll("{packages}", () => quote(dir === "." ? "." : `./${dir}`));
}

/**
 * The deterministic part of the test review: new tests must fail where the work has not been done. Creates a temporary worktree at the
 * task's base (the parent of the task's first commit), copies only `lockedFiles` over from `testCommitSha`, and runs `command` once
 * per file with `{files}` and `{packages}` filled in; a file whose run exits zero is `already-passes` and the lock must be refused.
 * Granularity is the file, not the test case. A `command` without a placeholder runs once for all files, and its outcome is every
 * file's outcome. Files that render to the same command (several files of one package) run once. A timeout counts as a failure.
 */
export async function failsBefore(
	repo: string,
	testCommitSha: string,
	lockedFiles: readonly string[],
	command: string,
	options: FailsBeforeOptions,
): Promise<FailsBeforeResult> {
	if (lockedFiles.length === 0) throw new Error("the fails-before check needs at least one locked test file");
	if (command.trim() === "") throw new Error("the fails-before check needs a command");
	const files = [...new Set(lockedFiles.map(file => assertRepoPath("locked file", file)))];
	const sha = gitOrThrow(repo, ["rev-parse", "--verify", `${testCommitSha}^{commit}`]).trim();
	const commits = readTaskCommits(repo, options.base, sha);
	const tasks = commits.find(commit => commit.sha === sha)?.tasks ?? [];
	if (options.task === undefined && tasks.length !== 1) throw new Error(`${sha} must carry exactly one Task: trailer (found ${tasks.length}); pass options.task`);
	const task = options.task ?? tasks[0];
	const first = commits.find(commit => commit.tasks.includes(task));
	if (!first) throw new Error(`no commit of ${task} in ${options.base}..${sha}`);
	const base = gitOrThrow(repo, ["rev-parse", "--verify", `${first.sha}^`]).trim();

	return withWorktree(repo, base, async dir => {
		gitOrThrow(dir, ["--literal-pathspecs", "checkout", sha, "--", ...files]);
		const outcomes = new Map<string, Outcome>();
		const results: FailsBeforeFile[] = [];
		for (const file of files) {
			const rendered = render(command, file);
			let outcome = outcomes.get(rendered);
			if (outcome === undefined) {
				outcome = await runCommand(rendered, dir, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
				outcomes.set(rendered, outcome);
			}
			results.push(
				outcome.code === 0
					? { file, status: "already-passes", output: outcome.output }
					: { file, status: "fails", reason: outcome.timedOut ? "timeout" : `exit ${outcome.code}`, output: outcome.output },
			);
		}
		return { ok: results.every(result => result.status === "fails"), base, files: results };
	});
}
