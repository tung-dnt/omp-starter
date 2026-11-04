// The guard's rules, pure: commits (trailers, changed paths, added lines) and the plan each commit names go in, violations come out.
// Nothing here runs git or reads a file; `spec-diff.ts` reads the inputs and `scripts/spec-guard.ts` prints the result.
import type { Plan, TaskBlock } from "./spec-plan";
import type { Violation } from "./spec-validate";

export type GuardRule =
	| "plan-rev-missing"
	| "plan-rev-unreadable"
	| "plan-invalid"
	| "unknown-task"
	| "out-of-scope"
	| "locked-test-changed"
	| "skip-added"
	| "ignore-added"
	| "config-changed"
	| "untracked-commit";

export interface GuardViolation {
	rule: GuardRule;
	/** Full sha of the commit the finding is about. */
	sha: string;
	task?: string;
	path?: string;
	detail: string;
}

/** One changed path of a commit. For a rename, `path` is the new path and `from` the old one. */
export interface FileChange {
	path: string;
	from?: string;
}

/** One added line (a `+` line of a zero-context diff) and its line number in the new file. */
export interface AddedLine {
	path: string;
	line: number;
	text: string;
}

/** What a commit's trailers say. Values are the repeated trailers, in order. */
export interface CommitFacts {
	sha: string;
	/** The commit has more than one parent. */
	merge: boolean;
	/** `Task:` ids. */
	tasks: string[];
	/** The first `Plan-Rev:` value. */
	planRev?: string;
	/** `Task-Lock:` ids and the `Locked:` paths of the same commit. */
	locks: string[];
	locked: string[];
	/** `Task-Unlock:` ids. */
	unlocks: string[];
}

/** A commit with its diff against its first parent (a merge is read the same way). Binary files have changes but no added lines. */
export interface GuardCommit extends CommitFacts {
	changes: FileChange[];
	added: AddedLine[];
}

/** The plan a `Plan-Rev` names, as the reader found it. */
export interface PlanAtRev {
	/** Why the plan could not be read from the vault; nothing else is known then. */
	unreadable?: string;
	/** The parsed plan; absent when it could not be read or parsed. */
	plan?: Plan;
	/** Parse errors and validation findings; empty when the plan is valid. */
	violations: Violation[];
}

export interface GuardInput {
	/** Oldest first. */
	commits: readonly GuardCommit[];
	/** Keyed by the `Plan-Rev` text as written in the trailer. */
	plans: ReadonlyMap<string, PlanAtRev>;
	/** Also reject non-merge commits without a `Task:`. */
	strict: boolean;
}

export const SKIP_PATTERNS: readonly RegExp[] = [
	/\.(?:skip|only|todo)\(/,
	/\bx(?:it|describe|test)\(/,
	/\bt\.Skip\(/,
	/@pytest\.mark\.(?:skip|xfail)/,
	/@Disabled/,
];

export const IGNORE_PATTERNS: readonly RegExp[] = [
	/@ts-ignore/,
	/@ts-expect-error/,
	/eslint-disable/,
	/biome-ignore/,
	/\/\/\s*nolint/,
	/#\s*type:\s*ignore/,
	/#\s*noqa/,
	/istanbul\s+ignore/,
	/c8\s+ignore/,
];

/** Lint, type, test-runner and CI configuration. A pattern without a slash matches that name at any depth. */
const PROTECTED_CONFIG: readonly Bun.Glob[] = [
	"**/tsconfig*.json",
	"**/eslint.config.*",
	"**/.eslintrc*",
	"**/biome.json*",
	"**/.golangci*",
	".github/workflows/**",
	"**/bunfig.toml",
	"**/jest.config.*",
	"**/vitest.config.*",
	"**/pytest.ini",
	"**/pyproject.toml",
	"**/setup.cfg",
].map(pattern => new Bun.Glob(pattern));

const EXCERPT = 100;
const SUMMARISED = 3;

/** `./src/` reads as `src`. */
const normalize = (pattern: string): string => pattern.replace(/^(?:\.\/)+/, "").replace(/\/+$/, "");

/**
 * True when `path` is one of `patterns`, matches one as a glob, or lies below one as a directory.
 * Used for a task's `owns` and `new_paths` and for a worker's write scope.
 */
export function inScope(path: string, patterns: readonly string[]): boolean {
	return patterns.some(raw => {
		const pattern = normalize(raw);
		return pattern !== "" && (pattern === path || new Bun.Glob(pattern).match(path) || new Bun.Glob(`${pattern}/**`).match(path));
	});
}

/** Which files each task's lock covers as commits are applied, oldest first. */
export class LockState {
	readonly #byTask = new Map<string, { paths: readonly string[]; unlocked: boolean }>();

	/**
	 * Applies a commit's trailers: `Task-Unlock` opens a task's files until its next `Task-Lock`, which locks exactly the commit's
	 * `Locked:` paths. Within one commit the unlock is applied first, so a lock written with it wins.
	 */
	apply(commit: Pick<CommitFacts, "locks" | "locked" | "unlocks">): void {
		for (const task of commit.unlocks) {
			const entry = this.#byTask.get(task);
			if (entry) entry.unlocked = true;
		}
		for (const task of commit.locks) this.#byTask.set(task, { paths: [...commit.locked], unlocked: false });
	}

	/** Locked path → the task that locked it, for every lock in force. */
	locked(): Map<string, string> {
		const out = new Map<string, string>();
		for (const [task, entry] of this.#byTask) {
			if (entry.unlocked) continue;
			for (const path of entry.paths) out.set(path, task);
		}
		return out;
	}
}

function excerpt(text: string): string {
	const trimmed = text.trim();
	return trimmed.length > EXCERPT ? `${trimmed.slice(0, EXCERPT)}…` : trimmed;
}

function summarise(violations: readonly Violation[]): string {
	const shown = violations.slice(0, SUMMARISED).map(v => `${v.rule}${v.task === undefined ? "" : ` [${v.task}]`}: ${v.detail}`);
	const more = violations.length - shown.length;
	return more > 0 ? `${shown.join("; ")} (+${more} more)` : shown.join("; ");
}

/** The paths a change touches: the new path and, for a rename, the old one. */
const sides = (change: FileChange): string[] => (change.from === undefined ? [change.path] : [change.path, change.from]);

/**
 * Checks commits against the plan each names. Findings come in commit order (the order given) and, within a commit, in the
 * order of the rules: plan-rev-missing, plan-rev-unreadable, plan-invalid, unknown-task, out-of-scope, locked-test-changed,
 * skip-added, ignore-added, config-changed, untracked-commit. A commit with `Task:` is judged against its plan; the lock, line and
 * config rules apply to every commit. A commit serving several tasks may touch the union of their scopes.
 */
export function guardCommits({ commits, plans, strict }: GuardInput): GuardViolation[] {
	const found: GuardViolation[] = [];
	const locks = new LockState();

	for (const commit of commits) {
		const report = (rule: GuardRule, detail: string, where: { task?: string; path?: string } = {}): void => {
			found.push({ rule, sha: commit.sha, ...where, detail });
		};
		const lead = commit.tasks[0];
		const known: TaskBlock[] = [];

		if (lead !== undefined) {
			if (commit.planRev === undefined) {
				report("plan-rev-missing", `the commit has Task: ${commit.tasks.join(", ")} but no Plan-Rev trailer`, { task: lead });
			} else {
				const at = plans.get(commit.planRev);
				if (at === undefined) {
					report("plan-rev-unreadable", `Plan-Rev ${commit.planRev} was not loaded`, { task: lead });
				} else if (at.unreadable !== undefined) {
					report("plan-rev-unreadable", `Plan-Rev ${commit.planRev}: ${at.unreadable}`, { task: lead });
				} else {
					if (at.violations.length > 0) {
						report("plan-invalid", `the plan at ${commit.planRev} fails validation: ${summarise(at.violations)}`, { task: lead });
					}
					const plan = at.plan;
					if (plan) {
						for (const id of commit.tasks) {
							const task = plan.tasks.find(candidate => candidate.id === id);
							if (task) known.push(task);
							else report("unknown-task", `Task: ${id} is not in the plan at ${commit.planRev}`, { task: id });
						}
					}
				}
			}
		}

		if (known.length > 0) {
			const scope = known.flatMap(task => [...task.owns, ...task.new_paths]);
			for (const change of commit.changes) {
				for (const path of sides(change)) {
					if (!inScope(path, scope)) {
						report("out-of-scope", `${path} is outside owns and new_paths of ${known.map(task => task.id).join(", ")}`, { task: known[0].id, path });
					}
				}
			}
		}

		const locked = locks.locked();
		for (const change of commit.changes) {
			for (const path of sides(change)) {
				const owner = locked.get(path);
				if (owner !== undefined) {
					report("locked-test-changed", `${path} is locked by the Task-Lock of ${owner}; changing it needs a Task-Unlock and a new Task-Lock`, { task: owner, path });
				}
			}
		}

		for (const [rule, patterns] of [["skip-added", SKIP_PATTERNS], ["ignore-added", IGNORE_PATTERNS]] as const) {
			for (const added of commit.added) {
				const hit = patterns.find(pattern => pattern.test(added.text));
				if (hit) {
					const what = rule === "skip-added" ? "adds a skipped or focused test" : "adds a suppression";
					report(rule, `${added.path}:${added.line} ${what}: ${excerpt(added.text)}`, { ...(lead === undefined ? {} : { task: lead }), path: added.path });
				}
			}
		}

		const listed = new Set(known.flatMap(task => [...task.owns, ...task.new_paths].map(normalize)));
		for (const change of commit.changes) {
			for (const path of sides(change)) {
				if (PROTECTED_CONFIG.some(glob => glob.match(path)) && !listed.has(path)) {
					report("config-changed", `${path} is a protected config; the task must list this exact path in owns (or new_paths for a new file)`, {
						...(lead === undefined ? {} : { task: lead }),
						path,
					});
				}
			}
		}

		if (strict && !commit.merge && lead === undefined) report("untracked-commit", "the commit has no Task: trailer");

		locks.apply(commit);
	}
	return found;
}

/** One line per violation: `rule sha task path: detail`. */
export function formatViolation(v: GuardViolation): string {
	return `${v.rule} ${v.sha.slice(0, 7)}${v.task === undefined ? "" : ` ${v.task}`}${v.path === undefined ? "" : ` ${v.path}`}: ${v.detail}`;
}
