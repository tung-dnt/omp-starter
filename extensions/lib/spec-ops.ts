// The scheduler's real `GitOps` and `CheckOps`: thin adapters over the step 3-4 functions (`spec-git`, `spec-lock`, `spec-check`,
// `spec-diff`, `spec-cli`, `worker-guard` and `scripts/spec-hook.ts`). Everything is an argv array; nothing goes through a shell.
// The one thing added here is the task-key object: the blocked note of a task that has no commit yet hangs on the blob of
// `spec-task:<story>:<task>` in `refs/notes/spec-checks`, so `spec-status` can read it like any other note.
//
// What keeps a slot from undoing the scheduler's work, and what puts things back (see the README, "What a slot cannot reach"):
//  - every scheduler git call that touches a worktree or a ref runs with hooks and fsmonitor off (`hookless`, `NO_HOOKS`);
//  - a per-clone ledger stamps every ref value and note blob the scheduler writes with a sequence number. A slot takes the number when
//    it starts; at its end a ref (or note) of the scheduler's namespace may hold only the LAST value recorded after that number, or, when
//    nothing was recorded, the value it had at the start. Anything else, an older recorded value included, is a violation, and `discard`
//    puts it to that value by compare-and-swap. Notes are judged per entry, on this run's commits and task keys only; a notes ref that
//    does not descend from its start value is put back whole and the scheduler's notes since are written again;
//  - HEAD, every ref and its symref target, the local config, `hooks/` and `info/` are compared with the state before the slot, hooks
//    and config against a baseline of the whole run, and restored from it before anything else runs;
//  - before every slot the worktree is cleaned of ignored files, and `.omp` / `.claude` folders above the worktree (up to the
//    worktree root) are deleted, because omp finds project config by searching upward from the working directory.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { checkCommit, failsBefore } from "./spec-check";
import { MARKER, gitCommonDir, readWorkflowConfig, resolveBun } from "./spec-cli";
import { loadGuardInput, planRevision } from "./spec-diff";
import {
	type GitResult,
	NOTES_REF,
	NO_HOOKS,
	cleanEnv,
	defaultBase,
	git,
	gitInDir,
	gitOrThrow,
	isOwnTempRef,
	listFiles,
	listNotes,
	noteBlob,
	pidAlive,
	pruneDeadTempRefs,
	setNoteBlobs,
	readCheckNote,
	readTaskCommits,
	refExists,
	removeCheckNote,
	taskKey,
	tempRefPid,
	writeCheckNote,
} from "./spec-git";
import { guardCommits } from "./spec-guard";
import { acceptCommit, lockCommit, unlockCommit } from "./spec-lock";
import { type CheckOps, type Committed, type GitOps, type IntegrateResult, type PlanSnapshot, type RepoState, type RunLock, RunLocked, type SlotWatch, type Workdir, type Worktree } from "./spec-scheduler";
import { isRecord } from "./tooling/runtime";
import { type GitSnapshot, type GuardedFile, NOT_A_TEST_FILE, compareSnapshot, readGuarded, restoreGuarded, scopeCheck, snapshotGit } from "./worker-guard";

export interface OpsConfig {
	/** Clone paths by the plan's `org/name`. */
	clones: ReadonlyMap<string, string>;
	/** The plan id: the namespace of the task-key objects. */
	story: string;
	/** The ticket branch, the same in every repo. */
	ticket: string;
	/** The ref the ticket branch is measured from; absent: each clone's `origin/HEAD`, else `main`. */
	base?: string;
	/** The vault spec store (a git dir) and its work tree. */
	vaultGitDir: string;
	vaultRoot: string;
	/** The plan's path inside the vault repo. */
	planPath: string;
	/** Parent folder of the task worktrees; a fresh temp folder per run by default. */
	worktreeRoot?: string;
	/** Per check command. */
	timeoutMs?: number;
}

const HOOK_SCRIPT = path.resolve(import.meta.dir, "../../scripts/spec-hook.ts");

/** Ignored files a slot leaves behind are removed before the next slot, except dependency folders, which a reinstall per slot would rebuild. */
const CLEAN_KEEP = ["node_modules", ".venv", "target"];
/** Folders omp reads project config from. */
const PROJECT_CONFIG_DIRS = [".omp", ".claude"];

/** The work tree of a vault git dir: `core.worktree` when set, else the folder that holds a `.git` dir. */
export function vaultRootOf(vaultGitDir: string): string {
	const configured = gitInDir(vaultGitDir, ["config", "--get", "core.worktree"]);
	return configured.ok && configured.stdout.trim() !== "" ? path.resolve(vaultGitDir, configured.stdout.trim()) : path.dirname(vaultGitDir);
}

function cloneOf(config: OpsConfig, repo: string): string {
	const clone = config.clones.get(repo);
	if (clone === undefined) throw new Error(`no clone is mapped to ${repo}`);
	return clone;
}

const baseOf = (config: OpsConfig, repo: string): string => config.base ?? defaultBase(cloneOf(config, repo));

/** A value that ends up in a commit trailer must stay on one line, or it could forge another trailer. */
function trailerValue(label: string, value: string): string {
	if (value === "" || value !== value.trim() || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`${label} is not a safe trailer value: ${JSON.stringify(value)}`);
	return value;
}

const safeName = (name: string): string => name.replace(/[^A-Za-z0-9._-]/g, "_");

/** Every scheduler git call that mutates a worktree goes through here: a slot can write `<git dir>/hooks`, so no repo hook runs on the scheduler's authority. */
const hookless = (dir: string, args: readonly string[]): GitResult => git(dir, [...NO_HOOKS, ...args]);
const hooklessOrThrow = (dir: string, args: readonly string[]): string => gitOrThrow(dir, [...NO_HOOKS, ...args]);

// ── The ledger of what the scheduler wrote ─────────────────────────────────────────────────────────────────────────────────

/**
 * What one run has written into one clone, stamped with a sequence number. A slot takes the number when it starts and accepts, among the
 * refs and notes of the scheduler's namespace, only a value the scheduler recorded after that: a value recorded earlier is a rollback.
 */
interface CloneRun {
	seq: number;
	/** Values written into a ref ("" is "absent"), by ref. */
	refs: Map<string, Array<{ value: string; seq: number }>>;
	/** Note blobs written (or "" for a removal) by target object. */
	notes: Array<{ target: string; blob: string; seq: number }>;
	/** `hooks/`, `info/` and `config` as they were when the first slot started, after the hook install. */
	baseline?: ReadonlyMap<string, GuardedFile>;
}

/** Shared by the git ops and the check ops of one config: `spec-check` writes notes too, and the ledger must see them. */
const cloneRuns = new WeakMap<OpsConfig, Map<string, CloneRun>>();

function cloneRun(config: OpsConfig, clone: string): CloneRun {
	let byClone = cloneRuns.get(config);
	if (byClone === undefined) cloneRuns.set(config, (byClone = new Map()));
	let run = byClone.get(clone);
	if (run === undefined) byClone.set(clone, (run = { seq: 0, refs: new Map(), notes: [] }));
	return run;
}

const NOTES_FULL_REF = `refs/notes/${NOTES_REF}`;

/** The refs the scheduler moves while workers run in parallel and records in its ledger: the ticket branch, the task branches and the kept conflict refs of this ticket. */
const isOwnedRef = (ticket: string, ref: string): boolean =>
	ref === `refs/heads/${ticket}` || ref.startsWith(`refs/heads/spec-wt/${ticket}/`) || ref.startsWith(`refs/spec-conflict/${ticket}/`);

/** Task branches and kept conflict refs of another ticket: another run's, which this run neither reports nor touches. */
const isOtherRunRef = (ticket: string, ref: string): boolean => (ref.startsWith("refs/heads/spec-wt/") || ref.startsWith("refs/spec-conflict/")) && !isOwnedRef(ticket, ref);

/** A branch a human works on: a fast-forward of it that nobody recorded is their commit, not a slot's rollback. */
const isHumanBranch = (ref: string): boolean => ref.startsWith("refs/heads/") && !ref.startsWith("refs/heads/spec-wt/");

/** Records the current value of `ref` (read from git) as one the scheduler wrote now. */
function record(run: CloneRun, clone: string, ref: string): void {
	const value = git(clone, ["rev-parse", "--verify", "--quiet", ref]).stdout.trim();
	const entries = run.refs.get(ref) ?? [];
	entries.push({ value, seq: ++run.seq });
	run.refs.set(ref, entries);
}

/** Records the note on `target` as the scheduler wrote it now: its blob, or "" when the note was removed. */
function recordNote(run: CloneRun, clone: string, target: string): void {
	run.notes.push({ target, blob: noteBlob(clone, target), seq: ++run.seq });
}

/** The last value the scheduler recorded into `ref` after sequence number `seq`, or undefined when it recorded none since. */
const lastRecorded = (run: CloneRun, ref: string, seq: number): string | undefined => run.refs.get(ref)?.filter(entry => entry.seq > seq).at(-1)?.value;

/** Records every ref of the scheduler's namespace as it stands. */
function seed(config: OpsConfig, run: CloneRun, clone: string): void {
	for (const ref of gitOrThrow(clone, ["for-each-ref", "--format=%(refname)"]).split("\n").filter(Boolean)) {
		if (isOwnedRef(config.ticket, ref)) record(run, clone, ref);
	}
}

// ── The run lock ──────────────────────────────────────────────────────────────────────────────────────────────────────────

interface LockHolder {
	pid: number;
	host: string;
	startedAt: string;
}

/** The `code` of a system error (`EEXIST`, `ESRCH`, ...). */
const errnoCode = (error: unknown): string | undefined => (isRecord(error) && typeof error.code === "string" ? error.code : undefined);

function readHolder(file: string): LockHolder | undefined {
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
		if (!isRecord(parsed)) return undefined;
		const { pid, host, startedAt } = parsed;
		return typeof pid === "number" && typeof host === "string" && typeof startedAt === "string" ? { pid, host, startedAt } : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Creates `file` exclusively with this process as the holder. A lock of a dead process on this host is taken over; a live process,
 * another host or a file that cannot be read refuses (`RunLocked`), and the message names the file so the user can delete it.
 */
function takeLock(file: string): RunLock {
	const mine: LockHolder = { pid: process.pid, host: os.hostname(), startedAt: new Date().toISOString() };
	let tookOver: LockHolder | undefined;
	for (let attempt = 0; ; attempt++) {
		try {
			fs.writeFileSync(file, JSON.stringify(mine), { flag: "wx" });
			break;
		} catch (error) {
			if (errnoCode(error) !== "EEXIST") throw error;
			const holder = readHolder(file) ?? { pid: 0, host: "unknown (the lock file cannot be read)", startedAt: "unknown" };
			const stale = holder.pid > 0 && holder.host === mine.host && !pidAlive(holder.pid);
			if (!stale || attempt >= 3) throw new RunLocked(file, holder);
			// Take over only the lock just read: another run that took it over first has a new holder.
			if (readHolder(file)?.startedAt === holder.startedAt) fs.rmSync(file, { force: true });
			tookOver = holder;
		}
	}
	let released = false;
	return {
		release() {
			if (released) return;
			released = true;
			const holder = readHolder(file);
			if (holder?.pid === mine.pid && holder.startedAt === mine.startedAt) fs.rmSync(file, { force: true });
		},
		...(tookOver === undefined ? {} : { tookOver }),
	};
}

// ── Folders above the worktree ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The `.omp` and `.claude` folders in every directory from the worktree's parent up to the worktree root, inclusive: omp searches
 * upward from the working directory for project config, and a slot can write there outside git. The home folder is never listed.
 */
function configDirsAbove(dir: string, root: string | undefined): string[] {
	if (root === undefined) return [];
	const stop = path.resolve(root);
	const home = path.resolve(os.homedir());
	const out: string[] = [];
	for (let current = path.dirname(path.resolve(dir)); ; current = path.dirname(current)) {
		const relative = path.relative(stop, current);
		if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) break;
		if (current !== home) out.push(...PROJECT_CONFIG_DIRS.map(name => path.join(current, name)));
		if (current === stop || path.dirname(current) === current) break;
	}
	return out;
}

const removeDirs = (dirs: readonly string[]): void => {
	for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
};

// ── GitOps ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export function realGitOps(config: OpsConfig): GitOps {
	const keys = new Map<string, string>();
	let worktreeRoot = config.worktreeRoot;
	/** The worktree root was made here (not supplied), so it is removed again when the run ends. */
	let ownsRoot = false;
	const keyOf = (clone: string, task: string): string => {
		let key = keys.get(`${clone}\0${task}`);
		if (key === undefined) {
			key = taskKey(clone, config.story, task, false);
			keys.set(`${clone}\0${task}`, key);
		}
		return key;
	};
	const runOf = (repo: string): { clone: string; run: CloneRun } => {
		const clone = cloneOf(config, repo);
		return { clone, run: cloneRun(config, clone) };
	};
	/** The hook counts as installed only when it is the one `spec-hook install` wrote: a replaced file reads as missing. */
	const hookState = (clone: string): RepoState["hook"] => {
		const saved = readWorkflowConfig(clone);
		if (saved?.plan !== config.planPath) return "missing";
		try {
			return fs.readFileSync(path.join(gitCommonDir(clone), "hooks", "pre-push"), "utf8").includes(MARKER) ? "installed" : "missing";
		} catch {
			return "missing";
		}
	};
	/** The task's branch tip moved by the scheduler. */
	const recordBranch = (repo: string, branch: string): void => {
		const { clone, run } = runOf(repo);
		record(run, clone, `refs/heads/${branch}`);
	};
	const clean = (dir: string): void => void hookless(dir, ["clean", "-ffdxq", ...CLEAN_KEEP.flatMap(name => ["-e", name])]);

	return {
		plan(): PlanSnapshot {
			if (!gitInDir(config.vaultGitDir, ["rev-parse", "--git-dir"]).ok) throw new Error(`${config.vaultGitDir} is not a git dir`);
			const file = path.join(config.vaultRoot, config.planPath);
			const text = fs.readFileSync(file, "utf8");
			const rev = planRevision(config.vaultGitDir, config.planPath);
			const head = gitInDir(config.vaultGitDir, ["show", `HEAD:${config.planPath}`]);
			return { rev, text, committed: rev !== "" && head.ok && head.stdout === text, file, root: config.vaultRoot };
		},

		files: repo => listFiles(cloneOf(config, repo)),

		inspect(repo): RepoState {
			const { clone, run } = runOf(repo);
			const dirty = hookless(clone, ["status", "--porcelain=v1", "--untracked-files=no"]).stdout.split("\n").filter(Boolean).slice(0, 5);
			for (const marker of ["CHERRY_PICK_HEAD", "MERGE_HEAD", "REBASE_HEAD", "rebase-merge", "rebase-apply"]) {
				const where = path.resolve(clone, git(clone, ["rev-parse", "--git-path", marker]).stdout.trim());
				if (fs.existsSync(where)) dirty.push(`${marker} is in progress`);
			}
			seed(config, run, clone);
			return {
				ticket: config.ticket,
				base: baseOf(config, repo),
				clone,
				branchExists: refExists(clone, `refs/heads/${config.ticket}`),
				clean: dirty.length === 0,
				dirty,
				hook: hookState(clone),
			};
		},

		createBranch(repo) {
			gitOrThrow(cloneOf(config, repo), ["branch", config.ticket, baseOf(config, repo)]);
			recordBranch(repo, config.ticket);
		},

		installHook(repo) {
			const clone = cloneOf(config, repo);
			const argv = [resolveBun(), HOOK_SCRIPT, "install", "--repo", clone, "--plan", config.planPath, "--base", baseOf(config, repo), "--vault-git-dir", config.vaultGitDir];
			const result = Bun.spawnSync({ cmd: argv, stdout: "pipe", stderr: "pipe", env: cleanEnv() });
			if (result.exitCode !== 0) throw new Error((result.stderr.toString() || result.stdout.toString()).trim() || `spec-hook exited with ${result.exitCode}`);
		},

		cleanup(repo) {
			const { clone, run } = runOf(repo);
			const prefix = `refs/heads/spec-wt/${config.ticket}/`;
			const removed = new Set<string>();
			hookless(clone, ["worktree", "prune"]);
			let dir: string | undefined;
			for (const line of gitOrThrow(clone, ["worktree", "list", "--porcelain"]).split("\n")) {
				if (line.startsWith("worktree ")) dir = line.slice("worktree ".length);
				else if (line.startsWith(`branch ${prefix}`) && dir !== undefined) {
					hookless(clone, ["worktree", "remove", "--force", dir]);
					removed.add(line.slice("branch refs/heads/".length));
				}
			}
			hookless(clone, ["worktree", "prune"]);
			for (const ref of gitOrThrow(clone, ["for-each-ref", "--format=%(refname)", prefix]).split("\n").filter(Boolean)) {
				hookless(clone, ["update-ref", "--no-deref", "-d", ref]);
				removed.add(ref.slice("refs/heads/".length));
			}
			for (const name of removed) record(run, clone, `refs/heads/${name}`);
			return [...removed];
		},

		commits: repo => readTaskCommits(cloneOf(config, repo), baseOf(config, repo), config.ticket),
		note: (repo, sha) => readCheckNote(cloneOf(config, repo), sha),
		taskNote: (repo, task) => readCheckNote(cloneOf(config, repo), keyOf(cloneOf(config, repo), task)),

		setTaskNote(repo, task, note) {
			const { clone, run } = runOf(repo);
			const key = note !== undefined ? taskKey(clone, config.story, task, true) : keyOf(clone, task);
			if (note !== undefined) writeCheckNote(clone, key, note);
			else removeCheckNote(clone, key);
			recordNote(run, clone, key);
		},

		addWorktree(repo, name) {
			const clone = cloneOf(config, repo);
			if (worktreeRoot === undefined) {
				worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "spec-wt-"));
				ownsRoot = true;
			}
			const dir = path.join(worktreeRoot, `${safeName(repo)}-${safeName(name)}`);
			const branch = `spec-wt/${config.ticket}/${safeName(name)}`;
			const startTip = gitOrThrow(clone, ["rev-parse", `refs/heads/${config.ticket}`]).trim();
			hooklessOrThrow(clone, ["worktree", "add", "--quiet", "-b", branch, dir, startTip]);
			recordBranch(repo, branch);
			return { repo, dir, task: name, branch, startTip };
		},

		removeWorktree(wt) {
			const clone = cloneOf(config, wt.repo);
			hookless(clone, ["worktree", "remove", "--force", wt.dir]);
			hookless(clone, ["branch", "-D", wt.branch]);
			hookless(clone, ["worktree", "prune"]);
			recordBranch(wt.repo, wt.branch);
		},

		watch(at: Workdir): SlotWatch {
			const { clone, run } = runOf(at.repo);
			const outside = configDirsAbove(at.dir, worktreeRoot);
			removeDirs(outside);
			// The first slot of the run fixes what the hooks, `info/` and the config must stay: later slots are measured against it, not against the slot before.
			run.baseline ??= readGuarded(clone);
			const baseline = run.baseline;
			clean(at.dir);
			const startSeq = run.seq;
			const before = snapshotGit(at.dir);
			const startNotes = listNotes(clone);
			const guarded = Object.fromEntries([...baseline].map(([file, { digest }]) => [file, digest]));
			const short = (sha: string): string => sha.slice(0, 7);

			/**
			 * The two snapshots with everything that is not a violation taken out, and the refs that still differ. Out: the temp refs this
			 * process is using, plain temp refs of other live processes, refs of other runs, notes (judged per entry), and a ref of this
			 * run's namespace that is exactly what it must be (see `lastRecorded`).
			 */
			const settle = (now: GitSnapshot): { before: GitSnapshot; now: GitSnapshot; open: string[] } => {
				const b: GitSnapshot = { ...before, guarded, refs: { ...before.refs }, symrefs: { ...before.symrefs } };
				const n: GitSnapshot = { ...now, refs: { ...now.refs }, symrefs: { ...now.symrefs } };
				const open: string[] = [];
				for (const ref of new Set([...Object.keys(b.refs), ...Object.keys(n.refs)])) {
					const drop = (): void => {
						delete b.refs[ref];
						delete n.refs[ref];
						delete b.symrefs[ref];
						delete n.symrefs[ref];
					};
					const pid = tempRefPid(ref);
					const plain = b.symrefs[ref] === undefined && n.symrefs[ref] === undefined;
					if (isOwnTempRef(ref) || (pid !== undefined && pid !== process.pid && pidAlive(pid) && plain) || isOtherRunRef(config.ticket, ref)) {
						drop();
						continue;
					}
					if (ref === NOTES_FULL_REF) {
						b.refs[ref] = "notes";
						n.refs[ref] = "notes";
					} else if (isOwnedRef(config.ticket, ref)) {
						const was = before.refs[ref] ?? "";
						const is = now.refs[ref] ?? "";
						// The only value it may have now: the last one the scheduler recorded since the slot started, or, when it recorded none, the start value.
						const recorded = lastRecorded(run, ref, startSeq);
						const accepted = recorded !== undefined ? is === recorded && n.symrefs[ref] === undefined : is === was && b.symrefs[ref] === n.symrefs[ref];
						if (accepted) {
							drop();
							continue;
						}
						if (recorded !== undefined) {
							// Judged against what the scheduler left, not against what the slot started with.
							if (recorded === "") delete b.refs[ref];
							else b.refs[ref] = recorded;
							delete b.symrefs[ref];
						}
					}
					if (b.refs[ref] !== n.refs[ref] || b.symrefs[ref] !== n.symrefs[ref]) open.push(ref);
				}
				return { before: b, now: n, open };
			};

			/**
			 * Notes that are not what they must be and belong to this run (its task commits and task keys, and any target the scheduler wrote
			 * since the slot started). What a note must be: the last blob the scheduler recorded for it since the slot started, else the blob
			 * it had at the start. Notes of others are never listed.
			 */
			const noteChanges = (now: GitSnapshot): Array<{ target: string; expected: string; cur: string }> => {
				const since = new Map<string, string>();
				for (const entry of run.notes) if (entry.seq > startSeq) since.set(entry.target, entry.blob);
				if (since.size === 0 && (before.refs[NOTES_FULL_REF] ?? "") === (now.refs[NOTES_FULL_REF] ?? "")) return [];
				const current = listNotes(clone);
				const tips = new Set<string>();
				for (const snapshot of [before, now]) for (const [ref, value] of Object.entries(snapshot.refs)) if (isOwnedRef(config.ticket, ref) && value !== "") tips.add(value);
				const commits = new Set<string>();
				if (tips.size > 0) {
					const listed = hookless(clone, ["rev-list", ...tips, "--not", baseOf(config, at.repo)]);
					if (listed.ok) for (const sha of listed.stdout.split("\n")) if (sha) commits.add(sha);
				}
				const keyPrefix = `spec-task:${config.story}:`;
				const isOurs = (target: string): boolean =>
					since.has(target) || commits.has(target) || (git(clone, ["cat-file", "-t", target]).stdout.trim() === "blob" && git(clone, ["cat-file", "blob", target]).stdout.startsWith(keyPrefix));
				const changes: Array<{ target: string; expected: string; cur: string }> = [];
				for (const target of new Set([...startNotes.keys(), ...current.keys(), ...since.keys()])) {
					const expected = since.get(target) ?? startNotes.get(target) ?? "";
					const cur = current.get(target) ?? "";
					if (expected !== cur && isOurs(target)) changes.push({ target, expected, cur });
				}
				return changes;
			};

			return {
				violations(writeScope, lockedFiles, only) {
					const now = snapshotGit(at.dir);
					const settled = settle(now);
					const moved = compareSnapshot(settled.before, settled.now);
					const notes = noteChanges(now).map(
						change => `${NOTES_FULL_REF}: the note on ${short(change.target)} was ${change.cur === "" ? "removed" : change.expected === "" ? "added" : "changed"}`,
					);
					const files = scopeCheck(at.dir, writeScope, lockedFiles, only).map(finding =>
						finding.reason === "locked" ? `${finding.path} is a locked test` : finding.reason === "not-test" ? `${finding.path} ${NOT_A_TEST_FILE}` : `${finding.path} is outside the write scope`,
					);
					const appeared = outside.filter(dir => fs.existsSync(dir)).map(dir => `${dir} appeared outside the worktree; only the worktree may be written`);
					return [...moved, ...notes, ...files, ...appeared];
				},

				/**
				 * Puts back what the slot changed and nothing else. Hooks, `info/` and the config first (a planted `reference-transaction` hook or
				 * `core.fsmonitor` would otherwise run during the rest), then the work tree, then each changed ref by compare-and-swap on the
				 * value seen (a lost CAS is an error, never forced), then the notes entry by entry. Every step runs; the first error is thrown.
				 */
				discard() {
					const errors: unknown[] = [];
					const step = (fn: () => void): void => {
						try {
							fn();
						} catch (error) {
							errors.push(error);
						}
					};
					step(() => restoreGuarded(clone, baseline));
					step(() => {
						const after = snapshotGit(at.dir);
						if (before.headRef !== "" && after.headRef !== before.headRef) hookless(at.dir, ["checkout", "--force", "--quiet", before.headRef.replace("refs/heads/", "")]);
						hookless(at.dir, ["reset", "--hard", "--quiet", before.head]);
						clean(at.dir);
					});
					step(() => {
						const now = snapshotGit(at.dir);
						for (const ref of settle(now).open) {
							if (ref === NOTES_FULL_REF && before.symrefs[ref] === now.symrefs[ref]) continue;
							const owned = isOwnedRef(config.ticket, ref);
							// What the ref must be: the last value the scheduler recorded since the slot started, else the value it had at the start.
							const recorded = owned ? lastRecorded(run, ref, startSeq) : undefined;
							const startValue = recorded ?? before.refs[ref] ?? "";
							const curValue = now.refs[ref] ?? "";
							const startLink = recorded === undefined ? before.symrefs[ref] : undefined;
							const curLink = now.symrefs[ref];
							try {
								if (startLink !== curLink) {
									// A symref cannot be compare-and-swapped: drop it without following it, then make the ref what it was.
									hookless(clone, ["update-ref", "--no-deref", "-d", ref]);
									if (startLink !== undefined) hooklessOrThrow(clone, ["symbolic-ref", ref, startLink]);
									else if (startValue !== "") hooklessOrThrow(clone, ["update-ref", "--no-deref", ref, startValue]);
								} else if (isHumanBranch(ref) && startValue !== "" && curValue !== "" && hookless(clone, ["merge-base", "--is-ancestor", startValue, curValue]).ok) {
									// Moved forward, not back: someone's own commit on a branch they work on. It stays.
									continue;
								} else {
									const args = curValue === "" ? [ref, startValue, ""] : startValue === "" ? ["-d", ref, curValue] : [ref, startValue, curValue];
									const result = hookless(clone, ["update-ref", "--no-deref", ...args]);
									if (!result.ok) throw new Error(`could not put ${ref} back (it changed again, or git refused): ${result.stderr || "non-zero exit"}`);
								}
								record(run, clone, ref);
							} catch (error) {
								errors.push(error);
							}
						}
					});
					step(() => {
						const now = snapshotGit(at.dir);
						const start = before.refs[NOTES_FULL_REF] ?? "";
						const tip = now.refs[NOTES_FULL_REF] ?? "";
						// Every legitimate writer builds on the current tip, so a legitimate tip descends from the start tip. One that does not (the ref
						// deleted, rolled back, rewritten, or pointed at something that is no notes commit at all) cannot be repaired entry by entry
						// without losing the notes of others: go back to the start value by CAS, then write again what the scheduler wrote since.
						const rolledBack = start !== "" && (tip === "" || !hookless(clone, ["merge-base", "--is-ancestor", start, tip]).ok);
						const names = tip !== "" && tip !== start && !rolledBack ? hookless(clone, ["ls-tree", "-r", "--name-only", tip]) : undefined;
						const junk = names !== undefined && (!names.ok || names.stdout.split("\n").some(name => name !== "" && !/^[0-9a-f]+(\/[0-9a-f]+)*$/.test(name)));
						if (rolledBack || junk) {
							const args = tip === "" ? [NOTES_FULL_REF, start, ""] : start === "" ? ["-d", NOTES_FULL_REF, tip] : [NOTES_FULL_REF, start, tip];
							const result = hookless(clone, ["update-ref", "--no-deref", ...args]);
							if (!result.ok) throw new Error(`could not put ${NOTES_FULL_REF} back (it changed again, or git refused): ${result.stderr || "non-zero exit"}`);
							const since = new Map<string, string>();
							for (const entry of run.notes) if (entry.seq > startSeq) since.set(entry.target, entry.blob);
							if (since.size > 0) setNoteBlobs(clone, since);
							for (const target of since.keys()) recordNote(run, clone, target);
							return;
						}
						const changes = noteChanges(now);
						if (changes.length === 0) return;
						setNoteBlobs(clone, new Map(changes.map(change => [change.target, change.expected])));
						for (const change of changes) recordNote(run, clone, change.target);
					});
					step(() => removeDirs(outside));
					if (errors.length > 0) throw errors[0];
				},
			};
		},

		commit(wt, { task, planRev, subject }): Committed | undefined {
			const trailers = `Task: ${trailerValue("task", task)}\nPlan-Rev: ${trailerValue("planRev", planRev)}`;
			hooklessOrThrow(wt.dir, ["add", "-A"]);
			if (hookless(wt.dir, ["diff", "--cached", "--quiet"]).ok) return undefined;
			const files: string[] = [];
			const deleted: string[] = [];
			const entries = hooklessOrThrow(wt.dir, ["diff", "--cached", "--name-status", "-z", "--no-renames"]).split("\0").filter(Boolean);
			for (let i = 0; i + 1 < entries.length; i += 2) (entries[i] === "D" ? deleted : files).push(entries[i + 1]);
			hooklessOrThrow(wt.dir, ["commit", "--quiet", "--no-verify", "-m", subject, "-m", trailers]);
			recordBranch(wt.repo, wt.branch);
			return { sha: gitOrThrow(wt.dir, ["rev-parse", "HEAD"]).trim(), files, deleted };
		},

		lock(wt, lock) {
			const sha = lockCommit(wt.dir, lock);
			recordBranch(wt.repo, wt.branch);
			return sha;
		},
		unlock(wt, unlock) {
			const sha = unlockCommit(wt.dir, unlock);
			recordBranch(wt.repo, wt.branch);
			return sha;
		},
		accept(wt, accept) {
			const sha = acceptCommit(wt.dir, accept);
			recordBranch(wt.repo, wt.branch);
			return sha;
		},
		diff: (at, from) => hooklessOrThrow(at.dir, ["diff", "--no-color", "--no-ext-diff", "--no-textconv", `${from}..HEAD`]),

		integrate(wt: Worktree): IntegrateResult {
			const clone = cloneOf(config, wt.repo);
			const tip = gitOrThrow(clone, ["rev-parse", `refs/heads/${config.ticket}`]).trim();
			const head = gitOrThrow(clone, ["rev-parse", `refs/heads/${wt.branch}`]).trim();
			// Nothing landed since the worktree was made: the task's commits go on as they are, and their notes stay valid.
			if (tip === wt.startTip) return { ok: true, from: tip, to: head };
			hooklessOrThrow(wt.dir, ["checkout", "--detach", "--force", "--quiet", tip]);
			const pick = hookless(wt.dir, ["cherry-pick", "--keep-redundant-commits", `${wt.startTip}..${head}`]);
			if (!pick.ok) {
				const files = hookless(wt.dir, ["diff", "--name-only", "--diff-filter=U"]).stdout.trim().split("\n").filter(Boolean);
				hookless(wt.dir, ["cherry-pick", "--abort"]);
				const detail = [pick.stdout.trim(), pick.stderr.trim()].filter(Boolean).join("\n");
				return { ok: false, conflict: files.length > 0 ? `${detail}\nconflicted files: ${files.join(", ")}` : detail };
			}
			return { ok: true, from: tip, to: gitOrThrow(wt.dir, ["rev-parse", "HEAD"]).trim() };
		},

		writeNote(repo, sha, note) {
			const { clone, run } = runOf(repo);
			writeCheckNote(clone, sha, note);
			recordNote(run, clone, sha);
		},

		publish(wt, { from, to }) {
			const clone = cloneOf(config, wt.repo);
			if (git(clone, ["symbolic-ref", "--quiet", "HEAD"]).stdout.trim() === `refs/heads/${config.ticket}`) {
				hooklessOrThrow(clone, ["merge", "--ff-only", "--quiet", to]);
			} else {
				hooklessOrThrow(clone, ["update-ref", "--no-deref", `refs/heads/${config.ticket}`, to, from]);
			}
			recordBranch(wt.repo, config.ticket);
		},

		adopt(wt, { from, to }): Worktree {
			hooklessOrThrow(wt.dir, ["checkout", "-B", wt.branch, to, "--quiet"]);
			recordBranch(wt.repo, wt.branch);
			return { ...wt, startTip: from };
		},

		keep(wt) {
			const { clone, run } = runOf(wt.repo);
			const ref = `refs/spec-conflict/${config.ticket}/${safeName(wt.task)}`;
			hooklessOrThrow(clone, ["update-ref", "--no-deref", ref, gitOrThrow(clone, ["rev-parse", `refs/heads/${wt.branch}`]).trim()]);
			record(run, clone, ref);
			return ref;
		},

		acquire(repo) {
			const clone = cloneOf(config, repo);
			const lock = takeLock(path.join(gitCommonDir(clone), `spec-run-${safeName(config.ticket)}.lock`));
			// A new run starts from nothing: what an earlier run of this process recorded says nothing about this one.
			cloneRuns.get(config)?.delete(clone);
			// The lock is ours, so a temp notes ref of a process that is gone is nobody's: a kill inside `updateNotes` left it.
			pruneDeadTempRefs(clone);
			return {
				...lock,
				release() {
					lock.release();
					// The folder the worktrees were made in is this run's own temp folder: gone with the run once it is empty.
					if (ownsRoot && worktreeRoot !== undefined) {
						try {
							fs.rmdirSync(worktreeRoot);
							worktreeRoot = undefined;
							ownsRoot = false;
						} catch {
							// Not empty or already gone: leave it.
						}
					}
				},
			};
		},
	};
}

export function realCheckOps(config: OpsConfig): CheckOps {
	const timeout = config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs };
	return {
		failsBefore: (wt, sha, files, command) => failsBefore(cloneOf(config, wt.repo), sha, files, command, { base: baseOf(config, wt.repo), task: wt.task, ...timeout }),
		async check(wt, sha) {
			const clone = cloneOf(config, wt.repo);
			// `checkCommit` writes the note itself and reports it at the write, so the ledger knows it before any slot can look at it.
			return checkCommit(clone, sha, {
				planPath: config.planPath,
				vaultGitDir: config.vaultGitDir,
				base: baseOf(config, wt.repo),
				...timeout,
				onNoteWritten: target => recordNote(cloneRun(config, clone), clone, target),
			});
		},
		guard: (repo, from, to) =>
			guardCommits(loadGuardInput({ repo: cloneOf(config, repo), from, to, vaultGitDir: config.vaultGitDir, planPath: config.planPath }, true)),
	};
}
