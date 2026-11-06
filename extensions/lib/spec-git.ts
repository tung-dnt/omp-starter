// The spec modules' only git runner (`git`, `gitOrThrow`, `gitInDir`) and the readers for commit trailers, check notes and repo facts.
// Every call is an argv array through `Bun.spawnSync`; nothing here goes through a shell.
import { errorMessage, isRecord } from "./tooling/runtime";

export interface TaskCommit {
	sha: string;
	/** Values of every `Task:` trailer, in order. */
	tasks: string[];
	/** Values of every `Task-Lock:` trailer, in order. */
	locks: string[];
	/** Values of every `Accept-Gate:` trailer, in order: the gates where a human accepted a patient-data finding for the task. */
	accepts?: string[];
	planRev?: string;
}

export interface CheckNote {
	v: 1;
	task: string;
	plan_rev: string;
	checks: Record<string, "pass" | "fail" | "skip">;
	attempts: number;
	blocked: boolean;
	reason: string;
	at: string;
}

export const NOTES_REF = "spec-checks";
const FIELD_SEP = "\x1f";
const RECORD_SEP = "\x1e";
const LOG_FORMAT = [
	"%H",
	"%(trailers:key=Task,valueonly,separator=%x2c)",
	"%(trailers:key=Task-Lock,valueonly,separator=%x2c)",
	"%(trailers:key=Plan-Rev,valueonly)",
	"%(trailers:key=Accept-Gate,valueonly,separator=%x2c)",
].join("%x1f") + "%x1e";

export interface GitResult {
	ok: boolean;
	stdout: string;
	stderr: string;
}

/** Variables git reads to find a repository (`git rev-parse --local-env-vars`). */
const REPO_ENV: readonly string[] = [
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	"GIT_CONFIG",
	"GIT_CONFIG_PARAMETERS",
	"GIT_CONFIG_COUNT",
	"GIT_OBJECT_DIRECTORY",
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_IMPLICIT_WORK_TREE",
	"GIT_GRAFT_FILE",
	"GIT_INDEX_FILE",
	"GIT_NO_REPLACE_OBJECTS",
	"GIT_REPLACE_REF_BASE",
	"GIT_PREFIX",
	"GIT_SHALLOW_FILE",
	"GIT_COMMON_DIR",
];

/**
 * The caller's environment without the variables that name a repository, for every git run and every check command.
 * Git exports `GIT_DIR` to the hooks of a linked worktree; left in place it would send `git -C <repo>` to another repository.
 */
export function cleanEnv(): Record<string, string | undefined> {
	const env: Record<string, string | undefined> = { ...process.env };
	for (const name of REPO_ENV) delete env[name];
	return env;
}

/**
 * The argv prefix of every scheduler and check git call that touches a work tree or a ref: no repo hook runs (`core.hooksPath=/dev/null`,
 * which also stops `reference-transaction`) and no `core.fsmonitor` command runs (git runs it on status, add, checkout and more, even with
 * hooks off). A slot can write both settings, so the scheduler never lets git read them.
 */
export const NO_HOOKS: readonly string[] = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"];

function run(argv: readonly string[]): GitResult {
	const result = Bun.spawnSync({ cmd: ["git", ...argv], stdout: "pipe", stderr: "pipe", env: cleanEnv() });
	return { ok: result.exitCode === 0, stdout: result.stdout.toString(), stderr: result.stderr.toString().trim() };
}

/** `git -C <repoPath> <args>`. */
export function git(repoPath: string, args: readonly string[]): GitResult {
	return run(["-C", repoPath, ...args]);
}

/** `git --git-dir=<gitDir> <args>`: reads a git dir that has no work tree to stand in, such as the vault store. */
export function gitInDir(gitDir: string, args: readonly string[]): GitResult {
	return run([`--git-dir=${gitDir}`, ...args]);
}

/** Stdout of `git -C <repoPath> <args>`. Throws with git's message on a non-zero exit. */
export function gitOrThrow(repoPath: string, args: readonly string[]): string {
	const result = git(repoPath, args);
	if (!result.ok) {
		const verb = args.find(arg => !arg.startsWith("-") && !arg.includes("=")) ?? args[0];
		throw new Error(`git ${verb} failed in ${repoPath}: ${result.stderr || "non-zero exit"}`);
	}
	return result.stdout;
}

/** The values of a trailer field: one value per comma-separated item, trimmed, empty items dropped. `readTaskCommits` and the guard read `Task:` this way. */
export const splitValues = (field: string): string[] =>
	field
		.split(",")
		.map(value => value.trim())
		.filter(Boolean);

/** Commits of `<base>..<branch>`, oldest first, with their `Task`, `Task-Lock`, `Plan-Rev` and `Accept-Gate` trailers. Throws when git fails (for example an unknown ref). */
export function readTaskCommits(repoPath: string, base: string, branch: string): TaskCommit[] {
	const out = gitOrThrow(repoPath, ["log", "--reverse", `--format=${LOG_FORMAT}`, `${base}..${branch}`]);
	const commits: TaskCommit[] = [];
	for (const record of out.split(RECORD_SEP)) {
		const [sha, tasks = "", locks = "", planRev = "", accepts = ""] = record.replace(/^\n/, "").split(FIELD_SEP);
		if (!sha) continue;
		const rev = planRev.split("\n").map(line => line.trim()).find(Boolean);
		commits.push({ sha, tasks: splitValues(tasks), locks: splitValues(locks), ...(splitValues(accepts).length > 0 ? { accepts: splitValues(accepts) } : {}), ...(rev === undefined ? {} : { planRev: rev }) });
	}
	return commits;
}

const CHECK_VALUES: readonly unknown[] = ["pass", "fail", "skip"];

/** Why `value` is not a version-1 check note, or undefined when it is one. */
function noteProblem(value: unknown): string | undefined {
	if (!isRecord(value)) return "not a JSON object";
	if (value.v !== 1) return `unsupported v ${JSON.stringify(value.v)}`;
	for (const key of ["task", "plan_rev", "reason", "at"]) if (typeof value[key] !== "string") return `"${key}" must be a string`;
	if (typeof value.attempts !== "number") return '"attempts" must be a number';
	if (typeof value.blocked !== "boolean") return '"blocked" must be a boolean';
	if (!isRecord(value.checks) || !Object.values(value.checks).every(check => CHECK_VALUES.includes(check))) {
		return '"checks" must map names to pass, fail or skip';
	}
	return undefined;
}

const isCheckNote = (value: unknown): value is CheckNote => noteProblem(value) === undefined;

/** The check note on `sha`, or undefined when there is none. An unreadable or invalid note is reported on stderr and read as absent. */
export function readCheckNote(repoPath: string, sha: string): CheckNote | undefined {
	const result = git(repoPath, ["notes", `--ref=${NOTES_REF}`, "show", sha]);
	if (!result.ok) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(result.stdout);
	} catch (error) {
		console.warn(`warning: check note on ${sha} in ${repoPath} is not valid JSON (${errorMessage(error)}); ignoring it`);
		return undefined;
	}
	if (isCheckNote(parsed)) return parsed;
	console.warn(`warning: check note on ${sha} in ${repoPath} is invalid (${noteProblem(parsed)}); ignoring it`);
	return undefined;
}

const NOTES_FULL_REF = `refs/notes/${NOTES_REF}`;
const NOTES_CAS_TRIES = 30;

/** The temp refs this process has in use: the only temp refs the scheduler's snapshot may ignore. */
const ownTempRefs = new Set<string>();

/** True for a temp notes ref that this process is using right now. */
export const isOwnTempRef = (ref: string): boolean => ownTempRefs.has(ref);

/** The notes tip, or "" when the notes ref does not exist. */
const notesTip = (repoPath: string, ref: string): string => git(repoPath, ["rev-parse", "--verify", "--quiet", ref]).stdout.trim();

/**
 * Edits `refs/notes/spec-checks` so that no concurrent writer, in this process or another, loses its update. `git notes add` and
 * `remove` move their ref with no compare-and-swap, so the edit runs on a private copy and the result replaces the real ref only if it
 * still holds the value the copy was made from (`update-ref --no-deref <ref> <new> <old>`). The copy is `refs/notes/spec-tmp-<pid>-<random>`:
 * the name cannot be guessed, and every create, update and delete of it uses `--no-deref`, so a slot that plants a symref there cannot make
 * the cleanup delete the real notes. No hook and no fsmonitor command runs. On a lost race the edit is redone on the new tip, up to 30
 * times, then this throws with git's last message. The copy is deleted last. Returns the notes tip after the update.
 */
export function updateNotes(repoPath: string, edit: (ref: string) => void): string {
	const copy = `spec-tmp-${process.pid}-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
	const copyRef = `refs/notes/${copy}`;
	const update = (args: readonly string[]) => git(repoPath, [...NO_HOOKS, "update-ref", "--no-deref", ...args]);
	ownTempRefs.add(copyRef);
	let lastError = "";
	try {
		for (let attempt = 1; attempt <= NOTES_CAS_TRIES; attempt++) {
			const old = notesTip(repoPath, NOTES_FULL_REF);
			// `--no-deref` overwrites whatever stands at the copy's name; only an absent notes ref needs the copy deleted.
			if (old === "") update(["-d", copyRef]);
			else {
				const made = update([copyRef, old]);
				if (!made.ok) throw new Error(`git update-ref failed in ${repoPath}: ${made.stderr || "non-zero exit"}`);
			}
			edit(copy);
			const next = notesTip(repoPath, copyRef);
			if (next === old) return old;
			// A copy deleted while the edit ran (a slot polling the refs, a prune) leaves `git notes` to start a fresh tree: swapping that in
			// would wipe every note. The new tip must descend from the tip the copy was cut from (an edit of several notes makes several
			// commits, so not only its direct parent), else the edit is redone.
			if (old !== "" && !git(repoPath, ["merge-base", "--is-ancestor", old, next]).ok) {
				lastError = `the new notes commit was not made on the notes tip (${next.slice(0, 7)} does not descend from ${old.slice(0, 7)})`;
			} else {
				const swapped = update([NOTES_FULL_REF, next, old]);
				if (swapped.ok) return next;
				lastError = swapped.stderr;
			}
			if (attempt < NOTES_CAS_TRIES) Bun.sleepSync(Math.random() * Math.min(5 * attempt, 20));
		}
		throw new Error(`could not update ${NOTES_FULL_REF} in ${repoPath} (${NOTES_CAS_TRIES} tries; it kept changing under concurrent writers, or git refused): ${lastError || "no message from git"}`);
	} finally {
		update(["-d", copyRef]);
		ownTempRefs.delete(copyRef);
	}
}

/** Writes (or replaces) the check note on `sha` in `refs/notes/spec-checks`, safe against concurrent writers. Local only: nothing is pushed. Throws when it fails. Returns the notes tip after the write. */
export function writeCheckNote(repoPath: string, sha: string, note: CheckNote): string {
	return updateNotes(repoPath, ref => gitOrThrow(repoPath, [...NO_HOOKS, "notes", `--ref=${ref}`, "add", "-f", "-m", JSON.stringify(note), sha]));
}

/** Removes the check note on `sha`; a commit without a note is not an error. Safe against concurrent writers. Throws when it fails. */
export function removeCheckNote(repoPath: string, sha: string): void {
	updateNotes(repoPath, ref => gitOrThrow(repoPath, [...NO_HOOKS, "notes", `--ref=${ref}`, "remove", "--ignore-missing", sha]));
}

/** The blob of the note on `target`, or "" when it has none. */
export function noteBlob(repoPath: string, target: string): string {
	return git(repoPath, [...NO_HOOKS, "notes", `--ref=${NOTES_FULL_REF}`, "list", target]).stdout.trim();
}

/** The notes of `refs/notes/spec-checks` as target object → note blob. An absent notes ref lists nothing. */
export function listNotes(repoPath: string): Map<string, string> {
	const out = new Map<string, string>();
	const listed = git(repoPath, [...NO_HOOKS, "notes", `--ref=${NOTES_FULL_REF}`, "list"]);
	if (!listed.ok) return out;
	for (const line of listed.stdout.split("\n")) {
		const [blob, target] = line.split(" ");
		if (blob && target) out.set(target, blob);
	}
	return out;
}

/** Puts the notes back to the given blobs ("" removes the note), all in one CAS update of the notes ref. */
export function setNoteBlobs(repoPath: string, changes: ReadonlyMap<string, string>): void {
	updateNotes(repoPath, ref => {
		for (const [target, blob] of changes) {
			if (blob === "") gitOrThrow(repoPath, [...NO_HOOKS, "notes", `--ref=${ref}`, "remove", "--ignore-missing", target]);
			else gitOrThrow(repoPath, [...NO_HOOKS, "notes", `--ref=${ref}`, "add", "-f", "-C", blob, target]);
		}
	});
}

const TEMP_REF = /^refs\/notes\/spec-tmp-(\d+)-/;

/** The pid whose `updateNotes` made this temp ref, or undefined for any other ref. */
export function tempRefPid(ref: string): number | undefined {
	const match = TEMP_REF.exec(ref);
	return match === null ? undefined : Number(match[1]);
}

/**
 * Deletes the temp notes refs of dead processes: a kill inside `updateNotes` leaves its copy behind. A pid that is alive, or a name that
 * is not `spec-tmp-<pid>-<id>`, stays. Deletes with `--no-deref`, so a symref is removed and never its target. Returns what it removed.
 */
export function pruneDeadTempRefs(repoPath: string): string[] {
	const removed: string[] = [];
	for (const ref of gitOrThrow(repoPath, ["for-each-ref", "--format=%(refname)", "refs/notes/"]).split("\n")) {
		const pid = tempRefPid(ref);
		if (pid === undefined || pidAlive(pid)) continue;
		if (git(repoPath, [...NO_HOOKS, "update-ref", "--no-deref", "-d", ref]).ok) removed.push(ref);
	}
	return removed;
}

/** True when a process with this pid exists on this host (one owned by another user counts as alive). */
export function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return !(isRecord(error) && error.code === "ESRCH");
	}
}

/** The object id of a task's key blob, computed by git itself so it follows the repo's hash algorithm. `write` stores the blob, which a note needs as its target. */
export function taskKey(repoPath: string, story: string, task: string, write: boolean): string {
	const result = Bun.spawnSync({
		cmd: ["git", "-C", repoPath, "hash-object", ...(write ? ["-w"] : []), "--stdin"],
		stdin: Buffer.from(`spec-task:${story}:${task}`),
		stdout: "pipe",
		stderr: "pipe",
		env: cleanEnv(),
	});
	if (result.exitCode !== 0) throw new Error(`git hash-object failed in ${repoPath}: ${result.stderr.toString().trim()}`);
	return result.stdout.toString().trim();
}

/** The blocked note of a task that has no commit yet: the check note on the task's key object. Read-only. */
export function readTaskNote(repoPath: string, story: string, task: string): CheckNote | undefined {
	return readCheckNote(repoPath, taskKey(repoPath, story, task, false));
}

/** `org/name` from the `origin` URL (SSH, scp-style or HTTPS), or undefined without an origin or when the URL has no two-segment path. */
export function repoIdentity(repoPath: string): string | undefined {
	const result = git(repoPath, ["remote", "get-url", "origin"]);
	if (!result.ok) return undefined;
	const url = result.stdout.trim();
	let path: string;
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
		try {
			path = new URL(url).pathname;
		} catch {
			return undefined;
		}
	} else if (url.includes(":")) {
		path = url.slice(url.indexOf(":") + 1);
	} else {
		return undefined;
	}
	const segments = path.split("/").filter(Boolean);
	if (segments.length < 2) return undefined;
	const name = segments[segments.length - 1].replace(/\.git$/, "");
	return name ? `${segments[segments.length - 2]}/${name}` : undefined;
}

/** True when `ref` names a commit in the repo. */
export function refExists(repoPath: string, ref: string): boolean {
	return git(repoPath, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).ok;
}

/** The remote default branch (`origin/HEAD`), else `main`. */
export function defaultBase(repoPath: string): string {
	const result = git(repoPath, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
	return result.ok && result.stdout.trim() ? result.stdout.trim() : "main";
}

/**
 * Tracked files of the work tree at `repoPath`, relative to its root; with `rev`, the files of that commit's tree instead.
 * Throws when it is not a git work tree (or `rev` is unknown).
 */
export function listFiles(repoPath: string, rev?: string): string[] {
	const result = rev === undefined ? git(repoPath, ["ls-files", "-z"]) : git(repoPath, ["ls-tree", "-r", "-z", "--name-only", rev]);
	if (!result.ok) {
		throw new Error(rev === undefined ? `${repoPath} is not a git work tree: ${result.stderr || "git failed"}` : `cannot list the files of ${rev} in ${repoPath}: ${result.stderr || "git failed"}`);
	}
	return result.stdout.split("\0").filter(Boolean);
}

/** Clone paths keyed by the `org/name` of each clone's `origin`. Throws on a clone without such an origin and on two clones of one repo. */
export function cloneIdentities(paths: readonly string[]): Map<string, string> {
	const byIdentity = new Map<string, string>();
	for (const path of paths) {
		const identity = repoIdentity(path);
		if (identity === undefined) throw new Error(`--repo ${path}: not a git clone with an org/name origin URL`);
		const earlier = byIdentity.get(identity);
		if (earlier !== undefined) throw new Error(`--repo ${path} and ${earlier} are both clones of ${identity}`);
		byIdentity.set(identity, path);
	}
	return byIdentity;
}

/** Tracked files of each clone, keyed like `clones` (`org/name`). */
export function listFilesByRepo(clones: ReadonlyMap<string, string>): Map<string, string[]> {
	return new Map([...clones].map(([repo, path]) => [repo, listFiles(path)]));
}
