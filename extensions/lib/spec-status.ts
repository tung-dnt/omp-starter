// Task and story status derived from git alone: the plan, commit trailers and check notes.
// Pure: no I/O (the note readers are injected), and the output follows plan task order.
import type { Plan } from "./spec-plan";
import type { CheckNote, TaskCommit } from "./spec-git";

export type TaskState = "blocked" | "done" | "failing" | "checking" | "awaiting-lock" | "ready" | "waiting";

export interface TaskStatus {
	id: string;
	state: TaskState;
	lastSha?: string;
	reason?: string;
	attempts?: number;
}

export interface StoryStatus {
	id: string;
	state: "in-progress" | "tasks-done" | "done";
	tasks: TaskStatus[];
}

/** What changes how a status reads its notes. */
export interface StatusOptions {
	/**
	 * The plan revision the status is for (the scheduler's `Plan-Rev`). A blocked note written under another revision is ignored, so
	 * committing a plan fix unblocks the task with no extra state. Without it every blocked note counts.
	 */
	planRev?: string;
	/**
	 * The blocked note a task earned before it had a commit on the ticket branch, by repo and task id. It sits on a stable task-key
	 * object (the blob of `spec-task:<story>:<task>`), because there is no commit to attach it to. Asked once per task.
	 */
	taskNote?: (repo: string, task: string) => CheckNote | undefined;
}

/** Display order of the non-done states in the status line; `blocked` is listed last, with its reasons. */
const LINE_ORDER: readonly TaskState[] = ["checking", "failing", "awaiting-lock", "ready", "waiting"];

/**
 * Computes every task's state, first matching row wins:
 * blocked, done, failing, checking, awaiting-lock, ready, waiting (see the step-3 design).
 *
 * `commitsByRepo` and `prsMerged` are keyed by the plan's `org/name`; `commitsByRepo` holds the
 * commits of `<base>..<ticket branch>` oldest first. `notes` is asked at most once per commit.
 * Without `prsMerged` the story stops at `tasks-done`. `blocked` also comes from a task-key note and,
 * with `options.planRev`, only from a note written under that plan revision.
 */
export function computeStatus(
	plan: Plan,
	commitsByRepo: Map<string, TaskCommit[]>,
	notes: (repo: string, sha: string) => CheckNote | undefined,
	prsMerged?: Map<string, boolean>,
	options: StatusOptions = {},
): StoryStatus {
	const noteCache = new Map<string, CheckNote | undefined>();
	const noteOf = (repo: string, sha: string): CheckNote | undefined => {
		const key = `${repo}\0${sha}`;
		if (!noteCache.has(key)) noteCache.set(key, notes(repo, sha));
		return noteCache.get(key);
	};

	const isBlocking = (note: CheckNote | undefined): note is CheckNote =>
		note?.blocked === true && (options.planRev === undefined || note.plan_rev === options.planRev);

	const settled = new Map<string, TaskStatus>();
	for (const task of plan.tasks) {
		const commits = (commitsByRepo.get(task.repo) ?? []).filter(commit => commit.tasks.includes(task.id));
		const keyNote = options.taskNote?.(task.repo, task.id);
		if (isBlocking(keyNote)) {
			const lastSha = commits.at(-1)?.sha;
			settled.set(task.id, {
				id: task.id,
				state: "blocked",
				...(lastSha === undefined ? {} : { lastSha }),
				...(keyNote.reason ? { reason: keyNote.reason } : {}),
				attempts: keyNote.attempts,
			});
			continue;
		}
		if (commits.length === 0) continue;
		const last = commits[commits.length - 1];
		const lastNote = noteOf(task.repo, last.sha);
		const hasLock = commits.some(commit => commit.locks.includes(task.id));

		let latest: CheckNote | undefined;
		for (let i = commits.length - 1; i >= 0 && !latest; i--) latest = noteOf(task.repo, commits[i].sha);

		const checks = lastNote ? Object.entries(lastNote.checks) : [];
		const failed = checks.filter(([, value]) => value === "fail").map(([name]) => name);
		const attempts = lastNote?.attempts ?? latest?.attempts;
		const base = { id: task.id, lastSha: last.sha, ...(attempts === undefined ? {} : { attempts }) };

		if (isBlocking(latest)) {
			settled.set(task.id, { ...base, state: "blocked", ...(latest.reason ? { reason: latest.reason } : {}) });
		} else if (lastNote && failed.length === 0 && lastNote.checks.guard === "pass") {
			settled.set(task.id, { ...base, state: "done" });
		} else if (failed.length > 0) {
			settled.set(task.id, { ...base, state: "failing", reason: failed.join(", ") });
		} else {
			settled.set(task.id, { ...base, state: hasLock ? "checking" : "awaiting-lock" });
		}
	}

	const isDone = (id: string): boolean => settled.get(id)?.state === "done";
	const tasks = plan.tasks.map(
		(task): TaskStatus =>
			settled.get(task.id) ?? { id: task.id, state: task.depends_on.every(isDone) ? "ready" : "waiting" },
	);

	const allDone = tasks.every(task => task.state === "done");
	const repos = new Set(plan.tasks.map(task => task.repo));
	const merged = prsMerged !== undefined && [...repos].every(repo => prsMerged.get(repo) === true);
	return { id: plan.id, state: !allDone ? "in-progress" : merged ? "done" : "tasks-done", tasks };
}

/** One line for the TUI status bar, for example `PAC2-1234 ▸ 3/5 done · 1 checking · 1 blocked (T04: test_wrong)`. */
export function formatStatusLine(status: StoryStatus): string {
	const prefix = `${status.id}-`;
	const short = (id: string): string => (id.startsWith(prefix) ? id.slice(prefix.length) : id);
	const done = status.tasks.filter(task => task.state === "done").length;
	const parts = [`${done}/${status.tasks.length} done`];
	for (const state of LINE_ORDER) {
		const count = status.tasks.filter(task => task.state === state).length;
		if (count > 0) parts.push(`${count} ${state.replace("-", " ")}`);
	}
	const blocked = status.tasks.filter(task => task.state === "blocked");
	if (blocked.length > 0) {
		const detail = blocked.map(task => (task.reason ? `${short(task.id)}: ${task.reason}` : short(task.id))).join(", ");
		parts.push(`${blocked.length} blocked (${detail})`);
	}
	if (status.state === "done") parts.push("merged");
	return `${status.id} ▸ ${parts.join(" · ")}`;
}

/** The status as the status CLI and the `spec_status` tool print it: the status line, one row per task (state, short sha, attempts, reason) and the story state. */
export function renderStatus(status: StoryStatus): string {
	const width = Math.max(...status.tasks.map(task => task.id.length), 0);
	const stateWidth = Math.max(...status.tasks.map(task => task.state.length), 0);
	const rows = status.tasks.map(task => {
		const detail = [task.lastSha?.slice(0, 7), task.attempts === undefined ? undefined : `attempts ${task.attempts}`, task.reason]
			.filter(part => part !== undefined)
			.join("  ");
		return `  ${task.id.padEnd(width)}  ${task.state.padEnd(stateWidth)}${detail ? `  ${detail}` : ""}`.trimEnd();
	});
	return [formatStatusLine(status), ...rows, `story: ${status.state}`].join("\n");
}
