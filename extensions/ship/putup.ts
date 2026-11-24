// /ship's put-up (plans/001-ship.md, story 5): turns the branch checked out in a checkout into a draft pull request, or
// says why it won't. Every check that can refuse runs before the first change, so a refusal leaves the checkout, the
// remote and GitHub as they were. A git or gh call that fails after that says what is left (staged files, a local
// commit, a pushed branch), and running /ship again picks up from there. `gh` must be the runner for the account that
// owns the repo (`gh-blinx` for blinxsolutions, plain `gh` otherwise, plan AC1): that account opens the PR, and its
// login decides whose PR is "mine". Runners return git's output untrimmed: `status -z` starts with a status column.
import { spawnSync } from "node:child_process";
import { isProtectedPath } from "./fence";
import type { Gh, Git, PrRef, PutUp } from "./types";

/** The contract's deps, plus how an SSH alias in origin resolves (tests replace it so they need no ssh config) and who else watches a PR. */
export interface PutUpDeps {
	git: Git;
	gh: Gh;
	confirm?: (files: string[]) => Promise<boolean>;
	sshHostname?: (alias: string) => string | null;
	/** Takes this session's claim on the PR the branch already has open, or says why it can't (a live session already watches it). Asked once the PR is found, before anything is pushed. */
	claim?: (pr: PrRef) => string | null;
}

/** What one gh or git call returned. */
interface Outcome {
	code: number;
	out: string;
	err: string;
}
type RunGit = (...args: string[]) => Promise<Outcome>;

interface Repo {
	owner: string;
	repo: string;
}

class Refusal extends Error {}

function no(why: string): never {
	throw new Refusal(why);
}

/** What a failed command said, short enough to read in a refusal; hook and git errors come last. */
function brief(outcome: Outcome): string {
	const text = [outcome.err, outcome.out].map(s => s.trim()).filter(Boolean).join(" ").replace(/\s+/g, " ");
	return text.length > 400 ? `…${text.slice(-400)}` : text || `exit ${outcome.code}`;
}

const listed = (names: string[]): string => (names.length > 5 ? `${names.slice(0, 5).join(", ")} and ${names.length - 5} more` : names.join(", "));

// ---- origin ---------------------------------------------------------------------------------------------------------

const GITHUB_HOSTS = ["github.com", "ssh.github.com"];
/** The schemes git speaks to GitHub; an ssh one may name an alias from ~/.ssh/config, an scp-style `host:path` is ssh too. */
const WEB_SCHEMES = ["https", "http", "git"];
const SSH_SCHEMES = ["ssh", "git+ssh", "ssh+git"];
const URL_FORM = /^([a-z][a-z0-9+.-]*):\/\/(?:[^@/]*@)?([^/:@]+)(?::\d*)?\/(.*)$/i;
const SCP_FORM = /^(?:[^@/:]+@)?([^/:@]+):(?!\/)(.*)$/;
const NAME = /^[\w.-]+$/;

/** The host an alias in ~/.ssh/config connects to, as `ssh -G` reports it; null when ssh can't say. */
function sshConfigHostname(alias: string): string | null {
	if (!/^[A-Za-z0-9][\w.-]*$/.test(alias)) return null;
	const out = spawnSync("ssh", ["-G", alias], { encoding: "utf8", timeout: 5_000 }).stdout ?? "";
	return /^hostname (\S+)$/im.exec(out)?.[1]?.toLowerCase() ?? null;
}

async function originRepo(run: RunGit, sshHostname: (alias: string) => string | null): Promise<Repo> {
	const got = await run("remote", "get-url", "origin");
	const url = got.out.trim();
	if (got.code !== 0 || url === "") no(`this checkout has no origin remote: ${brief(got)}`);
	// A URL may carry user:token@; a refusal must not repeat the token.
	const shown = url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]*@/i, "$1");
	const notGithub = `origin (${shown}) is not a github.com repository`;

	const urlForm = URL_FORM.exec(url);
	const scpForm = urlForm ? null : SCP_FORM.exec(url);
	const scheme = urlForm ? (urlForm[1] as string).toLowerCase() : "ssh";
	const host = urlForm?.[2] ?? scpForm?.[1];
	const path = urlForm?.[3] ?? scpForm?.[2];
	if (host === undefined || path === undefined || !(WEB_SCHEMES.includes(scheme) || SSH_SCHEMES.includes(scheme))) no(notGithub);

	let hostname = host.toLowerCase();
	if (SSH_SCHEMES.includes(scheme) && !GITHUB_HOSTS.includes(hostname)) hostname = (sshHostname(host) ?? hostname).toLowerCase();
	if (!GITHUB_HOSTS.includes(hostname)) no(notGithub);

	const [owner, repo, ...extra] = path.replace(/\/+$/, "").replace(/\.git$/, "").split("/");
	if (!owner || !repo || extra.length > 0 || !NAME.test(owner) || !NAME.test(repo)) no(`can't read an owner and repository from origin (${shown})`);
	return { owner, repo };
}

// ---- the branch -----------------------------------------------------------------------------------------------------

async function currentBranch(run: RunGit): Promise<string> {
	const head = await run("symbolic-ref", "--short", "-q", "HEAD");
	if (head.code === 1 && head.out.trim() === "") no("HEAD is detached; check out a branch first");
	if (head.code !== 0 || head.out.trim() === "") no(`can't read the current branch: ${brief(head)}`);
	return head.out.trim();
}

async function defaultBranch(run: RunGit): Promise<string> {
	const head = await run("symbolic-ref", "-q", "refs/remotes/origin/HEAD");
	const name = head.code === 0 ? head.out.trim().replace(/^refs\/remotes\/origin\//, "") : "";
	return name || no("the default branch is unknown because origin/HEAD is not set here; run `git remote set-head origin --auto` and try again");
}

const COMMIT_TYPES = ["feat", "fix", "docs", "style", "refactor", "perf", "test", "build", "ci", "chore", "revert"];
/** A Jira issue key such as PAC2-8005: upper case as Jira writes it, set off from other letters and digits. */
const JIRA_KEY = /(?<![A-Za-z0-9])[A-Z][A-Z0-9]+-\d+(?![A-Za-z0-9])/;

/** The commit message for uncommitted work and the PR title, both read off the branch name. A Jira key leads the title. */
function wording(branch: string): { commit: string; title: string } {
	const key = JIRA_KEY.exec(branch)?.[0] ?? null;
	const [first = "", ...tail] = branch.split("/");
	const type = tail.length > 0 && COMMIT_TYPES.includes(first) ? first : null;
	const rest = type ? tail.join("/") : branch;
	const subject = (key ? rest.replace(key, " ") : rest).split(/[\s/_-]+/).filter(Boolean).join(" ");
	const commit = type && subject ? `${type}: ${subject}` : `chore: work on ${branch}`;
	return { commit, title: key ? `${key}: ${subject || "work in progress"}` : commit };
}

// ---- what would be published ----------------------------------------------------------------------------------------

const KEY_FILE = /(?:^|\/)(?:id_(?:rsa|dsa|ecdsa|ed25519)(?!\.pub$)[^/]*|[^/]*\.(?:pem|key))$/i;
const ENV_FILE = /(?:^|\/)\.env[^/]*$/i;

/** Refuses when a path holds a secret by name. `.env*` follows the fence's own rule, so `.env.example` stays allowed. */
function rejectSecrets(paths: string[], where: string): void {
	const secrets = [...new Set(paths.filter(p => KEY_FILE.test(p) || (ENV_FILE.test(p) && isProtectedPath(p))))];
	if (secrets.length > 0) no(`secret-looking files ${where}: ${listed(secrets)}. Take them out first, then run /ship again`);
}

/** Files the branch's own commits add or change, deletions aside: a secret removed again still sits in the pushed history. */
async function committedFiles(run: RunGit, branch: string, base: string): Promise<string[]> {
	const log = await run("log", "-z", "--name-only", "--format=", "--diff-filter=d", `refs/remotes/origin/${base}..HEAD`);
	if (log.code !== 0) no(`can't compare ${branch} with origin/${base} (git fetch origin may help): ${brief(log)}`);
	return log.out.split("\0").filter(Boolean);
}

/** `<short sha> <subject>` of each commit on the branch beyond the base, oldest first. */
async function commitsAhead(run: RunGit, base: string): Promise<string[]> {
	const log = await run("log", "--reverse", "--format=%h %s", `refs/remotes/origin/${base}..HEAD`);
	if (log.code !== 0) no(`can't list the commits beyond origin/${base}: ${brief(log)}`);
	return log.out.split("\n").filter(Boolean);
}

// ---- uncommitted work -----------------------------------------------------------------------------------------------

interface Tree {
	/** Every changed path, in git's order. A deleted file counts: committing it records the deletion. */
	files: string[];
	/** The paths `git add -A` would leave in the commit: the changed files that still exist. */
	present: string[];
	conflicts: string[];
}

async function readTree(run: RunGit): Promise<Tree> {
	const status = await run("status", "--porcelain", "-z", "--untracked-files=all");
	if (status.code !== 0) no(`can't read the working tree: ${brief(status)}`);
	const tree: Tree = { files: [], present: [], conflicts: [] };
	const records = status.out.split("\0");
	for (let i = 0; i < records.length; i++) {
		const record = records[i] as string;
		if (record === "") continue;
		const entry = /^([ MTADRCU?!])([ MTADRCU?!]) (.+)$/s.exec(record);
		if (!entry) no(`git status printed a line this can't read: ${JSON.stringify(record.slice(0, 60))}`);
		const [x, y, file] = [entry[1], entry[2], entry[3]] as [string, string, string];
		// A rename or copy is followed by the path it came from.
		if (x === "R" || x === "C" || y === "R" || y === "C") i++;
		tree.files.push(file);
		if (x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D")) tree.conflicts.push(file);
		else if (y !== "D" && !(x === "D" && y === " ")) tree.present.push(file);
	}
	return tree;
}

function rejectUnsafe(tree: Tree): void {
	if (tree.conflicts.length > 0) no(`unresolved merge conflicts in ${listed(tree.conflicts)}; resolve them first`);
	rejectSecrets(tree.present, "would be committed");
}

/** Commits all uncommitted work once the user has seen the files; true when it did. */
async function commitWork(run: RunGit, message: string, confirm: PutUpDeps["confirm"]): Promise<boolean> {
	const tree = await readTree(run);
	if (tree.files.length === 0) return false;
	rejectUnsafe(tree);
	if (!confirm) no(`uncommitted work in ${tree.files.length} ${tree.files.length === 1 ? "file" : "files"} and nobody to confirm committing it; an unattended session never commits for you. Commit it yourself, then run /ship again`);
	if (!(await confirm([...tree.files]))) no("the uncommitted files were not confirmed");
	// What was confirmed is what gets committed.
	const now = await readTree(run);
	if (now.files.join("\0") !== tree.files.join("\0")) no("the working tree changed while waiting for the confirm; run /ship again");
	rejectUnsafe(now);
	const add = await run("add", "-A");
	if (add.code !== 0) no(`git add failed: ${brief(add)}`);
	const commit = await run("commit", "-m", message);
	if (commit.code !== 0) no(`git commit failed (hooks stay on, and the files stay staged): ${brief(commit)}`);
	return true;
}

// ---- GitHub ---------------------------------------------------------------------------------------------------------

const PR_URL = /https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/;

function prRef(text: string): PrRef | null {
	const found = PR_URL.exec(text);
	return found ? { host: "github.com", owner: found[1] as string, repo: found[2] as string, number: Number(found[3]) } : null;
}

interface Open {
	ref: PrRef;
	url: string;
	author: string;
}

/** The fields put-up reads from a `gh pr list --json` row; each is checked before it is trusted. */
interface Listed {
	url?: unknown;
	isCrossRepository?: unknown;
	author?: { login?: unknown } | null;
}

/** The branch's open PR in this repo, or null. A PR from a fork that reuses the branch name is not it. */
async function openPr(gh: Gh, repo: Repo, branch: string): Promise<Open | null> {
	const got = await gh(["pr", "list", "--repo", `${repo.owner}/${repo.repo}`, "--head", branch, "--state", "open", "--json", "number,url,author,isCrossRepository"]);
	if (got.code !== 0) no(`can't list the open pull requests for ${branch}: ${brief(got)}`);
	let rows: unknown;
	try {
		rows = JSON.parse(got.out);
	} catch {
		no(`gh pr list answered with something other than JSON: ${brief(got)}`);
	}
	if (!Array.isArray(rows)) no(`gh pr list answered with something other than a list: ${brief(got)}`);
	const open: Open[] = [];
	for (const row of rows as (Listed | null)[]) {
		// A row this can't read is refused, not skipped: it might be someone else's PR.
		if (typeof row?.url !== "string") no(`gh pr list returned a row this can't read: ${brief(got)}`);
		if (row.isCrossRepository === true) continue;
		const ref = prRef(row.url) ?? no(`gh pr list returned a pull request URL this can't read: ${row.url}`);
		open.push({ ref, url: row.url, author: typeof row.author?.login === "string" ? row.author.login : "an account that no longer exists" });
	}
	if (open.length > 1) no(`${open.length} open pull requests use ${branch} (${open.map(p => `#${p.ref.number}`).join(", ")}); name one: /ship <number>`);
	return open[0] ?? null;
}

/** The login gh acts as. */
async function account(gh: Gh): Promise<string> {
	const got = await gh(["api", "user", "--jq", ".login"]);
	if (got.code !== 0 || got.out.trim() === "") no(`can't tell which GitHub account gh acts as: ${brief(got)}`);
	return got.out.trim();
}

const MAX_LISTED = 20;

function prBody(branch: string, commits: string[]): string {
	const rows = commits.slice(0, MAX_LISTED).map(line => {
		const [sha, ...subject] = line.split(" ");
		// Code spans keep an @name or #12 in a commit subject from pinging anyone.
		return `- \`${subject.join(" ").replaceAll("`", "'")}\` (${sha})`;
	});
	if (commits.length > MAX_LISTED) rows.push(`- and ${commits.length - MAX_LISTED} more`);
	return [`Opened as a draft by /ship from \`${branch.replaceAll("`", "'")}\`.`, "", "Commits:", ...rows].join("\n");
}

// ---- put-up ---------------------------------------------------------------------------------------------------------

async function put(root: string, deps: PutUpDeps): Promise<PrRef> {
	const { gh, confirm } = deps;
	const run: RunGit = (...args) => deps.git(root, args);

	const repo = await originRepo(run, deps.sshHostname ?? sshConfigHostname);
	const branch = await currentBranch(run);
	const base = await defaultBranch(run);
	if (branch === base) no(`${branch} is the default branch; put the work on its own branch first`);

	const existing = await openPr(gh, repo, branch);
	if (existing) {
		const me = await account(gh);
		if (existing.author.toLowerCase() !== me.toLowerCase()) no(`${existing.url} is already open for ${branch}, but ${existing.author} opened it and gh acts as ${me}`);
		// Claimed before the push below, not just checked: a PR another live session watches is refused with nothing pushed (AC11), and of two sessions starting at once only the first to claim pushes.
		const held = deps.claim?.(existing.ref);
		if (held) no(held);
	}

	rejectSecrets(await committedFiles(run, branch, base), `are already committed on ${branch}`);
	const { commit, title } = wording(branch);
	// With a PR already open the tree is not put-up's to commit: /ship commits only the files it changed itself (AC8).
	const committed = existing ? false : await commitWork(run, commit, confirm);
	const commits = existing ? [] : await commitsAhead(run, base);
	if (!existing && commits.length === 0) no(`${branch} has no commits beyond ${base}, so there is nothing to put up`);

	const push = await run("push", "origin", branch);
	if (push.code !== 0) no(`git push origin ${branch} failed${committed ? " (the work is committed locally)" : ""}: ${brief(push)}`);
	if (existing) return existing.ref;

	const created = await gh(["pr", "create", "--repo", `${repo.owner}/${repo.repo}`, "--draft", "--head", branch, "--title", title, "--body", prBody(branch, commits)]);
	if (created.code !== 0) no(`gh pr create failed (${branch} is pushed): ${brief(created)}`);
	return prRef(created.out) ?? prRef(created.err) ?? no(`gh pr create printed no pull request URL: ${brief(created)}`);
}

export async function putUp(root: string, deps: PutUpDeps): Promise<PrRef | string> {
	try {
		return await put(root, deps);
	} catch (error) {
		if (error instanceof Refusal) return `put-up refused: ${error.message}`;
		throw error;
	}
}

// Fails to compile if this signature and the contract in types.ts drift apart.
putUp satisfies PutUp;
