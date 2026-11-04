// Git readers for the guard: the commits of a range with their trailers, each commit's changed paths and added lines,
// and the plan a commit was made against, read from the vault git dir at the commit's `Plan-Rev`.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { gitInDir, gitOrThrow, listFiles, repoIdentity } from "./spec-git";
import type { AddedLine, CommitFacts, FileChange, GuardCommit, GuardInput, PlanAtRev } from "./spec-guard";
import { type Plan, parsePlan } from "./spec-plan";
import { validatePlan } from "./spec-validate";

/** The vault spec store: a git dir kept outside the synced vault folder (`vgit` runs git against it). */
export const DEFAULT_VAULT_GIT_DIR = join(homedir(), ".vault-git");

const FIELD_SEP = "\x1f";
const RECORD_SEP = "\x1e";
const FACTS_FORMAT = "%H%x1f%P%x1f%(trailers:only,unfold)%x1e";
const TRAILER = /^([A-Za-z][A-Za-z0-9-]*)[ \t]*:[ \t]*(.*?)[ \t]*$/;
const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
const REV = /^[0-9a-f]{4,64}$/i;

/** Trailer values by lower-cased key, in the order written. */
function parseTrailers(text: string): Map<string, string[]> {
	const out = new Map<string, string[]>();
	for (const line of text.split("\n")) {
		const match = TRAILER.exec(line);
		if (!match || match[2] === "") continue;
		const key = match[1].toLowerCase();
		out.set(key, [...(out.get(key) ?? []), match[2]]);
	}
	return out;
}

/**
 * The commits of `<from>..<to>`, oldest first (parents before children), with the trailers the guard reads:
 * `Task`, `Plan-Rev`, `Task-Lock`, `Locked` and `Task-Unlock`. Each trailer is read as written, so a value is never split on commas.
 * Throws when git fails (for example an unknown ref).
 */
export function readCommitFacts(repo: string, from: string, to: string): CommitFacts[] {
	const out = gitOrThrow(repo, ["log", "--topo-order", "--reverse", `--format=${FACTS_FORMAT}`, `${from}..${to}`]);
	const commits: CommitFacts[] = [];
	for (const record of out.split(RECORD_SEP)) {
		const [sha, parents = "", trailerText = ""] = record.replace(/^\n/, "").split(FIELD_SEP);
		if (!sha) continue;
		const trailers = parseTrailers(trailerText);
		const planRev = trailers.get("plan-rev")?.[0];
		commits.push({
			sha,
			merge: parents.split(" ").filter(Boolean).length > 1,
			tasks: trailers.get("task") ?? [],
			...(planRev === undefined ? {} : { planRev }),
			locks: trailers.get("task-lock") ?? [],
			locked: trailers.get("locked") ?? [],
			unlocks: trailers.get("task-unlock") ?? [],
		});
	}
	return commits;
}

/** `git show` of one commit against its first parent (or the empty tree for a root commit), without external diff drivers or colour. */
const SHOW = ["show", "--diff-merges=first-parent", "--format=", "--no-notes", "-M", "--no-ext-diff", "--no-textconv", "--no-color"];

/** The files of `git show --numstat -z`: `added TAB deleted TAB path NUL`, or for a rename `added TAB deleted TAB NUL old NUL new NUL`. */
function parseNumstat(out: string): FileChange[] {
	const tokens = out.split("\0");
	if (tokens.at(-1) === "") tokens.pop();
	const changes: FileChange[] = [];
	for (let i = 0; i < tokens.length; i++) {
		const path = tokens[i].split("\t").slice(2).join("\t");
		if (path !== "") {
			changes.push({ path });
			continue;
		}
		const from = tokens[i + 1];
		const to = tokens[i + 2];
		if (from === undefined || to === undefined) throw new Error(`unexpected numstat record ${JSON.stringify(tokens[i])}`);
		changes.push({ path: to, from });
		i += 2;
	}
	return changes;
}

/** The lines of each `diff --git` section of a patch. Text before the first section is dropped. */
function patchSections(patch: string): string[][] {
	const sections: string[][] = [];
	for (const line of patch.split("\n")) {
		if (line.startsWith("diff --git ")) sections.push([]);
		else sections.at(-1)?.push(line);
	}
	return sections;
}

/** The `+` lines of one section's hunks. Header lines (before the first `@@`) and binary sections yield nothing. */
function addedLines(path: string, section: readonly string[]): AddedLine[] {
	const added: AddedLine[] = [];
	let line = 0;
	let inHunk = false;
	for (const text of section) {
		const hunk = HUNK.exec(text);
		if (hunk) {
			line = Number(hunk[1]);
			inHunk = true;
		} else if (inHunk && text.startsWith("+")) {
			added.push({ path, line: line++, text: text.slice(1) });
		}
	}
	return added;
}

/**
 * Changed paths and added lines of one commit, against its first parent. The numstat and the patch list the files in the same order,
 * so the Nth patch section belongs to the Nth numstat entry; no path is ever parsed out of a diff header.
 */
export function readCommitDiff(repo: string, sha: string): { changes: FileChange[]; added: AddedLine[] } {
	const changes = parseNumstat(gitOrThrow(repo, [...SHOW, "--numstat", "-z", sha]));
	const sections = patchSections(gitOrThrow(repo, [...SHOW, "-U0", sha]));
	if (sections.length !== changes.length) {
		throw new Error(`git listed ${changes.length} changed files but ${sections.length} diff sections for ${sha} in ${repo}`);
	}
	return { changes, added: changes.flatMap((change, i) => addedLines(change.path, sections[i])) };
}

/** The commits of `<from>..<to>` with their diffs, oldest first. */
export function readRange(repo: string, from: string, to: string): GuardCommit[] {
	return readCommitFacts(repo, from, to).map(facts => ({ ...facts, ...readCommitDiff(repo, facts.sha) }));
}

function assertVault(vaultGitDir: string): void {
	if (!existsSync(vaultGitDir)) {
		throw new Error(`vault git dir ${vaultGitDir} does not exist; set up the vault spec store first (vgit, build step 0) or pass --vault-git-dir`);
	}
	if (!gitInDir(vaultGitDir, ["rev-parse", "--git-dir"]).ok) throw new Error(`${vaultGitDir} is not a git dir`);
}

/** The plan text at a vault commit, or why it cannot be read. `rev` must be a hex sha: a branch or tag name would not pin the plan. */
function showPlan(vaultGitDir: string, planPath: string, rev: string): { text: string } | { unreadable: string } {
	if (!REV.test(rev)) return { unreadable: "is not a vault commit sha" };
	const resolved = gitInDir(vaultGitDir, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`]);
	const full = resolved.stdout.trim();
	if (!resolved.ok || !full.startsWith(rev.toLowerCase())) return { unreadable: "is not a commit in the vault git dir" };
	const shown = gitInDir(vaultGitDir, ["show", `${full}:${planPath}`]);
	return shown.ok ? { text: shown.stdout } : { unreadable: `${planPath} does not exist at that commit of the vault` };
}

/** The plan's repo that `repo` serves: its origin's `org/name`, else the plan's only repo. */
function servedRepo(identity: string | undefined, repo: string, plan: Plan): string {
	if (identity !== undefined) return identity;
	const repos = new Set(plan.tasks.map(task => task.repo));
	if (repos.size > 1) throw new Error(`${repo} has no org/name origin URL, so it cannot serve a plan with ${repos.size} repos`);
	return [...repos][0] ?? "";
}

export interface PlanReaderOptions {
	vaultGitDir: string;
	/** The plan's path inside the vault repo, as `git show <rev>:<path>` takes it. */
	planPath: string;
	/** The clone whose tasks the guard judges. */
	repo: string;
	/** The commit whose tracked files the plan is validated against: the start of the range, the repo as the plan found it. */
	filesAt: string;
}

/**
 * Reads the plan a `Plan-Rev` names, once per rev, never from the vault work tree. A plan that parses is validated against the
 * files of `repo` at `filesAt`; only the findings about plan-wide matters and about the tasks of this repo are kept, because the
 * other repos' tasks are judged by their own clones. Throws when the vault git dir is missing, or when the clone cannot be
 * matched to a repo of the plan.
 */
export function planReader(options: PlanReaderOptions): (rev: string) => PlanAtRev {
	assertVault(options.vaultGitDir);
	const identity = repoIdentity(options.repo);
	const cache = new Map<string, PlanAtRev>();
	let files: string[] | undefined;

	const read = (rev: string): PlanAtRev => {
		const shown = showPlan(options.vaultGitDir, options.planPath, rev);
		if ("unreadable" in shown) return { unreadable: shown.unreadable, violations: [] };
		const parsed = parsePlan(shown.text);
		if (!parsed.ok) return { violations: parsed.errors };
		const { plan } = parsed;
		const served = servedRepo(identity, options.repo, plan);
		files ??= listFiles(options.repo, options.filesAt);
		const own = new Set(plan.tasks.filter(task => task.repo === served).map(task => task.id));
		const violations = validatePlan(plan, new Map([[served, files]])).filter(v => v.task === undefined || own.has(v.task));
		return { plan, violations };
	};
	return rev => {
		let at = cache.get(rev);
		if (at === undefined) {
			at = read(rev);
			cache.set(rev, at);
		}
		return at;
	};
}

export interface GuardSource {
	repo: string;
	from: string;
	to: string;
	vaultGitDir: string;
	planPath: string;
}

/** Everything `guardCommits` needs for `<from>..<to>`: the commits with their diffs and the plan of every `Plan-Rev` a task commit names. */
export function loadGuardInput(source: GuardSource, strict: boolean): GuardInput {
	const readPlan = planReader({ vaultGitDir: source.vaultGitDir, planPath: source.planPath, repo: source.repo, filesAt: source.from });
	const commits = readRange(source.repo, source.from, source.to);
	const plans = new Map<string, PlanAtRev>();
	for (const commit of commits) {
		if (commit.tasks.length > 0 && commit.planRev !== undefined && !plans.has(commit.planRev)) plans.set(commit.planRev, readPlan(commit.planRev));
	}
	return { commits, plans, strict };
}
