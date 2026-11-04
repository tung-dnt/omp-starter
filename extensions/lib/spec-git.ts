// The spec modules' only git runner (`git`, `gitOrThrow`, `gitInDir`) and the readers for commit trailers, check notes and repo facts.
// Every call is an argv array through `Bun.spawnSync`; nothing here goes through a shell.
import { errorMessage, isRecord } from "./tooling/runtime";

export interface TaskCommit {
	sha: string;
	/** Values of every `Task:` trailer, in order. */
	tasks: string[];
	/** Values of every `Task-Lock:` trailer, in order. */
	locks: string[];
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

const NOTES_REF = "spec-checks";
const FIELD_SEP = "\x1f";
const RECORD_SEP = "\x1e";
const LOG_FORMAT = [
	"%H",
	"%(trailers:key=Task,valueonly,separator=%x2c)",
	"%(trailers:key=Task-Lock,valueonly,separator=%x2c)",
	"%(trailers:key=Plan-Rev,valueonly)",
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

const splitValues = (field: string): string[] =>
	field
		.split(",")
		.map(value => value.trim())
		.filter(Boolean);

/** Commits of `<base>..<branch>`, oldest first, with their `Task`, `Task-Lock` and `Plan-Rev` trailers. Throws when git fails (for example an unknown ref). */
export function readTaskCommits(repoPath: string, base: string, branch: string): TaskCommit[] {
	const out = gitOrThrow(repoPath, ["log", "--reverse", `--format=${LOG_FORMAT}`, `${base}..${branch}`]);
	const commits: TaskCommit[] = [];
	for (const record of out.split(RECORD_SEP)) {
		const [sha, tasks = "", locks = "", planRev = ""] = record.replace(/^\n/, "").split(FIELD_SEP);
		if (!sha) continue;
		const rev = planRev.split("\n").map(line => line.trim()).find(Boolean);
		commits.push({ sha, tasks: splitValues(tasks), locks: splitValues(locks), ...(rev === undefined ? {} : { planRev: rev }) });
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

/** Writes (or replaces) the check note on `sha` in `refs/notes/spec-checks`. Local only: nothing is pushed. */
export function writeCheckNote(repoPath: string, sha: string, note: CheckNote): void {
	gitOrThrow(repoPath, ["notes", `--ref=${NOTES_REF}`, "add", "-f", "-m", JSON.stringify(note), sha]);
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
