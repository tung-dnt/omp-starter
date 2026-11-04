// Scheduler-only helpers: the lock and unlock commits that freeze and reopen a task's tests, and the files a lock covers.
// Both commits are empty, so they never mix with a content change. Only the scheduler calls them, after the test review
// (lock) or after a human gate approved `test_wrong` (unlock).
import { readCommitFacts } from "./spec-diff";
import { git, gitOrThrow } from "./spec-git";
import { LockState } from "./spec-guard";

const CONTROL = /[\u0000-\u001f\u007f]/;

/** A trailer value must stay on one line, or a crafted value could forge another trailer. */
function oneLine(label: string, value: string): string {
	if (value === "" || value !== value.trim() || CONTROL.test(value)) {
		throw new Error(`${label} must be one non-empty line without surrounding spaces: ${JSON.stringify(value)}`);
	}
	return value;
}

/** A repo-relative path for a `Locked:` trailer or a test command: one line, not absolute, no `..` segment, not starting with `-`. */
export function assertRepoPath(label: string, path: string): string {
	oneLine(label, path);
	if (path.startsWith("/") || path.startsWith("-") || path.split("/").includes("..")) {
		throw new Error(`${label} must be a relative path inside the repo, not an option: ${JSON.stringify(path)}`);
	}
	return path;
}

/**
 * Commits an empty commit with `subject` and a trailer paragraph. Staged changes would ride along in it, so they refuse the commit.
 * Repo hooks are skipped (`--no-verify`): the commit is empty and its message is machine-written.
 */
function emptyCommit(repo: string, subject: string, trailers: readonly string[]): string {
	if (!git(repo, ["diff", "--cached", "--quiet"]).ok) throw new Error(`${repo} has staged changes; a lock or unlock commit must be empty`);
	gitOrThrow(repo, ["commit", "--allow-empty", "--no-verify", "--quiet", "-m", subject, "-m", trailers.join("\n")]);
	return gitOrThrow(repo, ["rev-parse", "HEAD"]).trim();
}

export interface LockOptions {
	task: string;
	/** The vault commit the task's plan was pinned to. */
	planRev: string;
	/** The task's test files, relative to the repo root. */
	files: readonly string[];
}

/** Commits `Task: <id>`, `Plan-Rev`, `Task-Lock: <id>` and one `Locked: <path>` per file. Returns the new commit's sha. */
export function lockCommit(repo: string, options: LockOptions): string {
	const task = oneLine("task", options.task);
	const planRev = oneLine("planRev", options.planRev);
	if (options.files.length === 0) throw new Error("a lock needs at least one test file");
	const files = [...new Set(options.files.map(file => assertRepoPath("locked file", file)))];
	return emptyCommit(repo, `chore(spec): lock the tests of ${task}`, [`Task: ${task}`, `Plan-Rev: ${planRev}`, `Task-Lock: ${task}`, ...files.map(file => `Locked: ${file}`)]);
}

export interface UnlockOptions {
	task: string;
	planRev: string;
	/** The id of the human gate that approved the change to the locked tests. */
	gate: string;
}

/** Commits `Task: <id>`, `Plan-Rev`, `Task-Unlock: <id>` and `Unlock-Gate: <gate>`. Returns the new commit's sha. */
export function unlockCommit(repo: string, options: UnlockOptions): string {
	const task = oneLine("task", options.task);
	const planRev = oneLine("planRev", options.planRev);
	const gate = oneLine("gate", options.gate);
	return emptyCommit(repo, `chore(spec): unlock the tests of ${task}`, [`Task: ${task}`, `Plan-Rev: ${planRev}`, `Task-Unlock: ${task}`, `Unlock-Gate: ${gate}`]);
}

/**
 * The files locked at `rev`: those of every `Task-Lock` in `<base>..<rev>` that no later `Task-Unlock` of the same task reopened.
 * With `task`, only that task's files. This is the same lock state the guard applies.
 */
export function lockedFilesAt(repo: string, base: string, rev: string, task?: string): string[] {
	const state = new LockState();
	for (const facts of readCommitFacts(repo, base, rev)) state.apply(facts);
	return [...state.locked()].filter(([, owner]) => task === undefined || owner === task).map(([path]) => path);
}
