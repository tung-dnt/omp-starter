// /ship's find step: a PR link names a repository and a branch, not a folder, so `/ship <link>` has to find the folder to
// watch in. It uses a checkout of the branch that already exists (a clone or linked worktree of the repository), else adds
// a worktree for the branch beside a clone of the repository, else clones the repository first. Whichever it is, the user
// is asked once, naming the folder, before anything is used or made. Every refusal that can be known beforehand comes before
// the first change, so such a refusal, or a "no", leaves every folder as it was; a clone that fails or is stopped is removed
// again. Nothing is installed in a folder made here. Clones are looked for in the folders directly under the projects folder,
// and in the session's own.
import * as fs from "node:fs";
import * as path from "node:path";
import { expandHome, tildify } from "../lib/state";
import { brief, BRANCH_NAME, no, Refusal, unlessStopped } from "./putup";
import type { FindCheckout, FindDeps, Found, PrRef, Want } from "./types";

/** The folder `/ship <link>` searches for clones, and clones into: `OMP_SHIP_PROJECTS`, else ~/projects. */
export function projectsRoot(env: NodeJS.ProcessEnv = process.env): string {
	return path.resolve(expandHome(env.OMP_SHIP_PROJECTS?.trim() || "~/projects"));
}

/** A clone, a fetch or a checkout of a big repository takes longer than the 90 s a read gets, and a stop has to be able to end it. */
const LONG_MS = 10 * 60_000;
/** How many folders are asked about at once: a projects folder can hold hundreds, and each question is a git process. */
const AT_ONCE = 8;

interface Repo {
	owner: string;
	repo: string;
}

/** A checkout of the repository: its main clone, or a linked worktree of it. */
interface Tree {
	dir: string;
	branch: string | null;
}

/** One clone of the repository with every checkout of it that git lists. */
interface Clone {
	/** The folder of the clone itself; null when it is a bare repository, which has none to put a worktree beside. */
	main: string | null;
	trees: Tree[];
	/** The session's own folder is one of its checkouts. */
	session: boolean;
}

/** What is to be done, decided before anything is: the folder the watch will run in is `root`. */
type Plan = { how: "use"; root: string } | { how: "worktree"; root: string; main: string } | { how: "clone"; root: string; clone: string; branched: boolean; url: string | null };

const label = (pr: PrRef): string => `${pr.owner}/${pr.repo}#${pr.number}`;
const same = (a: Repo, b: Repo): boolean => a.owner.toLowerCase() === b.owner.toLowerCase() && a.repo.toLowerCase() === b.repo.toLowerCase();
const outOf = (r: { code: number; out: string }): string | null => (r.code === 0 ? r.out.trim() : null);

function real(dir: string): string {
	try {
		return fs.realpathSync(dir);
	} catch {
		return dir;
	}
}

/** Whether anything is at `file`, a dangling link included. */
function taken(file: string): boolean {
	try {
		fs.lstatSync(file);
		return true;
	} catch {
		return false;
	}
}

/** A folder with nothing in it: what a clone leaves when the session ends before /ship could remove it. git clones into one, so it is free. */
function emptyDir(dir: string): boolean {
	try {
		return fs.lstatSync(dir).isDirectory() && fs.readdirSync(dir).length === 0;
	} catch {
		return false;
	}
}

async function inBatches<T, R>(items: T[], work: (item: T) => Promise<R>): Promise<R[]> {
	const results: R[] = [];
	for (let i = 0; i < items.length; i += AT_ONCE) results.push(...(await Promise.all(items.slice(i, i + AT_ONCE).map(work))));
	return results;
}

/** What `dir`'s origin is and which repository it names (null when /ship can't read it), or null when `dir` has no origin. */
interface Origin {
	url: string;
	repo: Repo | null;
}

async function originOf(dir: string, deps: FindDeps): Promise<Origin | null> {
	const url = outOf(await deps.git(dir, ["remote", "get-url", "origin"]));
	return url === null ? null : { url, repo: deps.repoOf(url) };
}

/** `<main>-<branch with / as ->`, beside the clone: the worktree folder the operator names by hand. */
const besideOf = (main: string, branch: string): string => path.join(path.dirname(main), `${path.basename(main)}-${branch.replaceAll("/", "-")}`);

// ---- what exists ----------------------------------------------------------------------------------------------------

/** `git worktree list --porcelain`: each checkout's folder and branch; the first is the clone itself. A folder that has gone away, or a prunable one, is left out. */
function listedTrees(listing: string): { main: boolean; bare: boolean; tree: Tree }[] {
	return listing
		.split("\n\n")
		.flatMap((block, index) => {
			const lines = block.split("\n");
			const dir = lines.find(line => line.startsWith("worktree "))?.slice("worktree ".length);
			if (dir === undefined || lines.some(line => line.startsWith("prunable")) || !fs.existsSync(dir)) return [];
			const ref = lines.find(line => line.startsWith("branch "))?.slice("branch ".length);
			return [{ main: index === 0, bare: lines.includes("bare"), tree: { dir, branch: ref?.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : null } }];
		});
}

/** A git folder and the origin it has. */
interface Folder {
	dir: string;
	origin: Origin | null;
}

/** Every git folder directly under the projects folder, and the session's own, with the origin each one has. */
async function surveyed(deps: FindDeps): Promise<Folder[]> {
	let names: string[] = [];
	try {
		names = fs.readdirSync(deps.projects).sort();
	} catch {}
	const session = deps.session === null ? null : real(deps.session);
	const folders = names.map(name => path.join(deps.projects, name)).filter(dir => fs.existsSync(path.join(dir, ".git")));
	const candidates = [...new Set([...folders.map(real), ...(session === null ? [] : [session])])];
	return inBatches(candidates, async dir => ({ dir, origin: await originOf(dir, deps) }));
}

/** The clones of the repository among them. */
async function clonesOf(repo: Repo, folders: Folder[], deps: FindDeps): Promise<Clone[]> {
	const session = deps.session === null ? null : real(deps.session);
	const ofRepo = folders.filter(folder => folder.origin?.repo != null && same(folder.origin.repo, repo)).map(folder => folder.dir);
	const clones: Clone[] = [];
	for (const dir of ofRepo) {
		// Two worktrees of one clone are found as two folders but are one clone: the first one's listing holds the other.
		if (clones.some(clone => clone.trees.some(tree => real(tree.dir) === dir))) continue;
		const listing = await deps.git(dir, ["worktree", "list", "--porcelain"]);
		if (listing.code !== 0) continue;
		const listed = listedTrees(listing.out);
		const main = listed.find(entry => entry.main && !entry.bare);
		const trees = listed.filter(entry => !entry.bare).map(entry => entry.tree);
		clones.push({ main: main?.tree.dir ?? null, trees, session: session !== null && trees.some(tree => real(tree.dir) === session) });
	}
	return clones;
}

/** An origin URL that carries a user name or a password, which a message or a process list would show: any http(s) one with a user in it (a token is often written as the user name), and any other scheme's with a password. `git@` over ssh is no secret. */
const SECRET_URL = /^(?:https?:\/\/[^/]*@|[\w+.-]+:\/\/[^/@]*:[^/@]*@)/i;
/** The user (and password) part of a URL that has one, to be taken out of anything printed. */
const USERINFO = /\b(https?:\/\/|[\w+.-]+:\/\/(?=[^/@\s]*:))[^/@\s'"]*@/gi;

/** `text` with the credentials of any URL in it taken out: git words its failures with the URL it was given. */
const redacted = (text: string): string => text.replace(USERINFO, "$1");
/** The tail of an origin URL: what comes before the repository's owner, the owner, the repository, and what follows it. */
const URL_TAIL = /^(.+[/:])([^/:]+)\/([^/]+?)((?:\.git)?\/?)$/;

/**
 * The URL of the PR's repository written as the owner's other clones' origins are: the same scheme, user and host (or
 * ssh alias), which is the one that reaches the owner's repositories as the account that has them, where `gh repo clone`
 * uses the default identity. Null when no clone of another repository of the owner is there to copy it from.
 */
function cloneUrlFor(pr: PrRef, folders: Folder[]): string | null {
	for (const { origin } of folders) {
		if (origin?.repo == null || origin.repo.owner.toLowerCase() !== pr.owner.toLowerCase() || SECRET_URL.test(origin.url)) continue;
		const tail = URL_TAIL.exec(origin.url);
		if (tail === null || tail[3]?.toLowerCase() !== origin.repo.repo.toLowerCase()) continue;
		return `${tail[1]}${tail[2]}/${pr.repo}${tail[4]}`;
	}
	return null;
}

/** Best first: a clone that already owns linked worktrees (the way the operator works), then the session's own, then by name. */
function ranked(clones: Clone[]): Clone[] {
	const owns = (clone: Clone): number => (clone.trees.length > 1 ? 0 : 1);
	return clones.toSorted((a, b) => owns(a) - owns(b) || Number(!a.session) - Number(!b.session) || (a.main ?? "").localeCompare(b.main ?? ""));
}

/** Whether the session's own folder is the checkout: on the branch, in the PR's repository (or, for a fork's PR, in any GitHub clone, as /ship has always taken it). */
async function inSession(want: Want, deps: FindDeps): Promise<boolean> {
	if (deps.session === null) return false;
	if (outOf(await deps.git(deps.session, ["symbolic-ref", "--short", "-q", "HEAD"])) !== want.branch) return false;
	const repo = (await originOf(deps.session, deps))?.repo ?? null;
	return repo !== null && (want.fork || same(repo, want.pr));
}

// ---- the plan -------------------------------------------------------------------------------------------------------

async function defaultBranchOf(pr: PrRef, deps: FindDeps): Promise<string> {
	const name = `${pr.owner}/${pr.repo}`;
	const got = await deps.gh(["repo", "view", name, "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"]);
	const branch = got.out.trim();
	return got.code === 0 && BRANCH_NAME.test(branch) ? branch : no(`can't read ${name}'s default branch: ${brief(got)}`);
}

/** Where the watch will run and what that takes, from what is on disk. Reads only; every refusal that needs nothing made is here. */
async function planFor(want: Want, deps: FindDeps): Promise<Plan> {
	const folders = await surveyed(deps);
	const clones = ranked(await clonesOf(want.pr, folders, deps));
	const holder = clones.flatMap(clone => clone.trees).find(tree => tree.branch === want.branch);
	if (holder !== undefined) return { how: "use", root: holder.dir };

	const main = clones.find(clone => clone.main !== null)?.main;
	if (main !== undefined && main !== null) {
		const root = besideOf(main, want.branch);
		if (taken(root)) no(`${tildify(root)} already exists, and it is not a checkout of ${want.branch}: move it away, or check ${want.branch} out there, then run /ship again`);
		// Another branch of that name would be overwritten, or attached to without knowing what it holds: git is asked, and /ship leaves it to the user.
		const local = await deps.git(main, ["rev-parse", "--verify", "-q", `refs/heads/${want.branch}`]);
		if (local.code === 0) no(`the local branch ${want.branch} already exists in ${tildify(main)}, but no folder has it checked out: check it out in a worktree yourself (git worktree add), or delete it (git branch -D ${want.branch}; run git worktree prune first if a worktree folder was deleted by hand), then run /ship again`);
		return { how: "worktree", root, main };
	}

	const clone = path.join(deps.projects, want.pr.repo);
	if (taken(clone) && !emptyDir(clone)) no(`${tildify(clone)} already exists, and it is not a clone of ${want.pr.owner}/${want.pr.repo}: move it away, or clone the repository somewhere else under ${tildify(deps.projects)}, then run /ship again`);
	const branched = (await defaultBranchOf(want.pr, deps)) === want.branch;
	const root = branched ? clone : besideOf(clone, want.branch);
	if (!branched && taken(root)) no(`${tildify(root)} already exists, and it is not a checkout of ${want.branch}: move it away, or check ${want.branch} out there, then run /ship again`);
	return { how: "clone", root, clone, branched, url: cloneUrlFor(want.pr, folders) };
}

/** What the user is asked, and how the plan reads in a refusal: the folder is named in both. */
function words(plan: Plan, want: Want, deps: FindDeps): { title: string; message: string; what: string } {
	const dir = tildify(plan.root);
	const pr = label(want.pr);
	const projects = tildify(deps.projects);
	switch (plan.how) {
		case "use":
			return {
				title: `Watch ${pr} in ${dir}?`,
				message: `${want.branch} is checked out in ${dir}, not in this session's folder. /ship will watch ${pr} from there: it reads the PR, makes its fixes in that checkout and pushes to ${want.branch}.`,
				what: `branch ${want.branch} is checked out in ${dir}`,
			};
		case "worktree":
			return {
				title: `Watch ${pr} in a new worktree, ${dir}?`,
				message: `No folder has ${want.branch} checked out. /ship will fetch it in ${tildify(plan.main)}, add the worktree ${dir} for it (tracking origin/${want.branch}) and watch ${pr} there. Nothing is installed in a new worktree.`,
				what: `branch ${want.branch} is checked out nowhere, and /ship would add the worktree ${dir} to ${tildify(plan.main)}`,
			};
		case "clone": {
			const clone = tildify(plan.clone);
			const then = plan.branched ? `(it is on ${want.branch}, the default branch)` : `and add the worktree ${dir} for ${want.branch}`;
			return {
				title: plan.branched ? `Watch ${pr} in a new clone, ${dir}?` : `Watch ${pr} in a new worktree, ${dir}?`,
				message: `${want.pr.owner}/${want.pr.repo} is not cloned under ${projects}. /ship will clone it${plan.url === null ? "" : ` from ${plan.url}`} into ${clone} ${then}, then watch ${pr} there. Nothing is installed in a new clone or worktree.`,
				what: `${want.pr.owner}/${want.pr.repo} is not cloned under ${projects}, and /ship would clone it${plan.url === null ? "" : ` from ${plan.url}`} into ${clone} ${then}`,
			};
		}
	}
}

// ---- making it ------------------------------------------------------------------------------------------------------

/** What a clone made without `--single-branch` fetches: every branch of origin. */
const ALL_BRANCHES = "+refs/heads/*:refs/remotes/origin/*";

/**
 * Fetches the branch into `main` and adds the worktree for it, tracking origin's. A single-branch clone maps only the
 * branch it was made for, and git won't track a ref its fetch refspec doesn't name, so the branch is added to what the
 * clone fetches (`git remote set-branches --add`, which is what the user would do by hand); a clone that fetches every
 * branch is left as it is.
 */
async function addWorktree(main: string, root: string, branch: string, deps: FindDeps): Promise<void> {
	const limits = { timeoutMs: LONG_MS, signal: deps.signal };
	unlessStopped(deps.signal);
	const spec = `+refs/heads/${branch}:refs/remotes/origin/${branch}`;
	const mapped = (await deps.git(main, ["config", "--get-all", "remote.origin.fetch"])).out.split("\n").map(line => line.trim());
	const mapping = !mapped.includes(ALL_BRANCHES) && !mapped.includes(spec);
	if (mapping) {
		const set = await deps.git(main, ["remote", "set-branches", "--add", "origin", branch]);
		if (set.code !== 0) no(`git remote set-branches --add origin ${branch} failed in ${tildify(main)}: ${brief(set)}`);
	}
	const fetched = await deps.git(main, ["fetch", "origin", spec], limits);
	if (fetched.code !== 0) {
		// A fetch that failed or was stopped brought nothing the refspec was for: the clone fetches what it did before. These run without the stopped signal, which would end them at once.
		if (mapping) await deps.git(main, ["config", "--fixed-value", "--unset", "remote.origin.fetch", spec]);
		no(`git fetch origin ${branch} failed in ${tildify(main)}: ${brief(fetched)}`);
	}
	unlessStopped(deps.signal);
	const from = (await deps.git(main, ["rev-parse", "--verify", "-q", `refs/remotes/origin/${branch}`])).out.trim();
	const added = await deps.git(main, ["worktree", "add", "--track", "-b", branch, root, `origin/${branch}`], limits);
	if (added.code !== 0) {
		// `worktree add -b` makes the branch first, and a later failure or a stop leaves it, which would refuse every later /ship for this PR. planFor proved there was none, so the branch is /ship's own while it still is the commit it was made from (a branch the user made meanwhile is not touched); git won't delete one a worktree still has checked out.
		const now = (await deps.git(main, ["rev-parse", "--verify", "-q", `refs/heads/${branch}`])).out.trim();
		if (from !== "" && now === from) await deps.git(main, ["branch", "-D", branch]);
		no(`git worktree add ${tildify(root)} failed: ${brief(added)}`);
	}
}

/** Clones into a folder this call makes (or finds empty), so that whatever a failed or stopped clone leaves is known to be this call's own to remove. `url` is where git clones from; null leaves it to `gh repo clone`. */
async function cloneInto(clone: string, pr: PrRef, url: string | null, deps: FindDeps): Promise<void> {
	unlessStopped(deps.signal);
	try {
		fs.mkdirSync(path.dirname(clone), { recursive: true });
		fs.mkdirSync(clone);
	} catch (error) {
		if (!((error as NodeJS.ErrnoException).code === "EEXIST" && emptyDir(clone))) {
			const why = error instanceof Error ? error.message : String(error);
			no((error as NodeJS.ErrnoException).code === "EEXIST" ? `${tildify(clone)} appeared while /ship waited, so nothing was cloned into it` : `can't make ${tildify(clone)}: ${why}`);
		}
	}
	const limits = { timeoutMs: LONG_MS, signal: deps.signal };
	const cloned = url === null ? await deps.gh(["repo", "clone", `${pr.owner}/${pr.repo}`, clone], limits) : await deps.git(path.dirname(clone), ["clone", "--", url, clone], limits);
	if (cloned.code === 0) return;
	fs.rmSync(clone, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
	unlessStopped(deps.signal);
	no(`${url === null ? `gh repo clone ${pr.owner}/${pr.repo}` : `git clone ${url}`} failed: ${brief(cloned)}`);
}

async function make(plan: Plan, want: Want, deps: FindDeps): Promise<Found> {
	switch (plan.how) {
		case "use":
			return { root: plan.root, kind: "existing" };
		case "worktree":
			await addWorktree(plan.main, plan.root, want.branch, deps);
			return { root: plan.root, kind: "worktree" };
		case "clone":
			await cloneInto(plan.clone, want.pr, plan.url, deps);
			if (plan.branched) return { root: plan.clone, kind: "clone" };
			await addWorktree(plan.clone, plan.root, want.branch, deps);
			return { root: plan.root, kind: "worktree" };
	}
}

// ---- the step -------------------------------------------------------------------------------------------------------

async function find(want: Want, deps: FindDeps): Promise<Found> {
	// This session's own folder is the checkout: the watch starts there as it always has, with nothing asked or searched.
	if (deps.session !== null && (await inSession(want, deps))) return { root: deps.session, kind: "session" };
	if (!BRANCH_NAME.test(want.branch)) no(`${JSON.stringify(want.branch.slice(0, 60))} is not a branch name /ship will pass to git`);
	if (want.fork) no(`${label(want.pr)} comes from a fork, so no clone of ${want.pr.owner}/${want.pr.repo} holds its branch: /ship can't find or make a checkout for it. Run /ship <link> (the PR's link) from the checkout of the fork that is on ${want.branch}`);
	const plan = await planFor(want, deps);
	const { title, message, what } = words(plan, want, deps);
	if (deps.confirm === undefined) {
		const instead = plan.how === "use" ? `run /ship in ${tildify(plan.root)}, or in a session you can answer` : "run /ship in a session you can answer, or make the checkout yourself and run /ship there";
		no(`${label(want.pr)}: ${what}, but nobody can confirm that in this session (an unattended one, or one with no UI, never asks): ${instead}`);
	}
	if (!(await deps.confirm(title, redacted(message)))) no(`not started in ${tildify(plan.root)}: it was not confirmed`);
	return make(plan, want, deps);
}

export const findCheckout: FindCheckout = async (want, deps) => {
	try {
		return await find(want, deps);
	} catch (error) {
		if (error instanceof Refusal) return redacted(error.message);
		throw error;
	}
};
