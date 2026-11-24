// Story 2 of /ship (plans/001-ship.md): which pull request an argument names, and one read of that PR as a Snapshot.
// `gh` is injected (types.ts `Gh`), so tests replay recorded output. Every comment the model may see passes the trust
// filter here (AC7), and `hash` covers only what survives it, so an untrusted comment never starts a pass.
import { createHash } from "node:crypto";
import { MARKER } from "./fence";
import type { Gh, Note, ParseTarget, PrRef, ReadPr, Review, Snapshot, Thread, Trust } from "./types";

// ---- which pull request ---------------------------------------------------------------------------------------------

const GITHUB_HOSTS = ["github.com", "ssh.github.com"];
const WEB_SCHEMES = ["https", "http", "git"];
const SSH_SCHEMES = ["ssh", "git+ssh", "ssh+git"];
const URL_ORIGIN = /^(?<scheme>[a-z][a-z0-9+.-]*):\/\/(?:[^@/]*@)?(?<host>[^/:@]+)(?::\d+)?\/(?<path>.+)$/i;
const SCP_ORIGIN = /^(?:[^@/:\s]+@)?(?<host>[^/:@\s]+):(?!\/\/)(?<path>.+)$/;
const PR_NUMBER = /^#?(?<n>\d+)$/;
const PR_URL = /^https?:\/\/github\.com\/(?<owner>[^/]+)\/(?<repo>[^/]+)\/pull\/(?<n>\d+)(?:[/?#].*)?$/i;
const NAME = /^[\w.-]+$/;

const validName = (name: string) => NAME.test(name) && name !== "." && name !== "..";

/** `owner/repo` from the path of a git URL; null unless it is exactly two clean names. */
function repoFromPath(path: string): { owner: string; repo: string } | null {
	const [owner = "", repo = "", ...more] = path.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "").split("/");
	return more.length === 0 && validName(owner) && validName(repo) ? { owner, repo } : null;
}

/** The repo the checkout's origin names, or why it isn't a GitHub one. Messages never echo the URL: it may carry a token. */
function originRepo(origin: string, sshHostname: (alias: string) => string | null): { owner: string; repo: string } | string {
	const url = origin.trim();
	if (url === "") return "this checkout has no origin remote";
	const found = URL_ORIGIN.exec(url) ?? SCP_ORIGIN.exec(url);
	if (!found?.groups) return "origin is not a URL /ship can read";
	const { host = "", path = "" } = found.groups;
	// The scp-like form (git@host:o/r.git) has no scheme and always means ssh.
	const scheme = (found.groups.scheme ?? "ssh").toLowerCase();
	if (!WEB_SCHEMES.includes(scheme) && !SSH_SCHEMES.includes(scheme)) return `origin uses ${scheme}://, which /ship can't read`;
	let hostname = host.toLowerCase();
	// An ssh host may be an alias from ~/.ssh/config (git@blindx.github:o/r.git); only ssh knows where it leads.
	if (!GITHUB_HOSTS.includes(hostname) && SSH_SCHEMES.includes(scheme)) {
		const resolved = sshHostname(host);
		if (resolved === null) return `can't resolve the ssh host ${host} (ssh -G failed)`;
		hostname = resolved.toLowerCase();
	}
	if (!GITHUB_HOSTS.includes(hostname)) return `origin is on ${hostname}, not github.com: /ship works on GitHub only`;
	return repoFromPath(path) ?? "origin has no owner/repo path";
}

/**
 * Names the PR a `/ship` argument points at: `<n>` and `#<n>` in the checkout's repo, a github.com PR URL in its own.
 * No argument gives the repo alone, for the caller to find the current branch's PR. Origin must be on github.com in every
 * case; a PR URL may name another repo than origin (a fork's checkout).
 */
export const parseTarget: ParseTarget = (arg, originUrl, sshHostname) => {
	const origin = originRepo(originUrl, sshHostname);
	const given = (arg ?? "").trim();
	if (typeof origin === "string" || given === "") return origin;
	const notAPr = `"${given.slice(0, 60)}" is not a PR number, #number or github.com pull request URL`;
	const named = PR_NUMBER.exec(given)?.groups ?? PR_URL.exec(given)?.groups;
	if (!named) return notAPr;
	const { owner = origin.owner, repo = origin.repo, n = "" } = named;
	if (!validName(owner) || !validName(repo)) return notAPr;
	const number = Number(n);
	return number >= 1 && Number.isSafeInteger(number) ? { host: "github.com", owner, repo, number } : `${n} is not a PR number`;
};

// ---- reading gh's answers -------------------------------------------------------------------------------------------

/** A read that can't produce a Snapshot; its message is what `readPr` returns. */
class Unreadable extends Error {}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : {});
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const text = (v: unknown): string => (typeof v === "string" ? v : "");
/** The items of a GraphQL connection (`{ nodes: [...] }`), minus the nulls it holds for things the viewer can't see. */
const nodes = (v: unknown): Obj[] => list(obj(v).nodes).filter(n => n !== null).map(obj);

/** What `make` returns for each item, the nulls left out. One item at a time: each new commenter costs a permission lookup, and a PR with a hundred strangers must not start a hundred `gh` processes at once. */
async function keep<T, R>(items: T[], make: (item: T) => Promise<R | null>): Promise<R[]> {
	const kept: R[] = [];
	for (const item of items) {
		const made = await make(item);
		if (made !== null) kept.push(made);
	}
	return kept;
}

function pick<T extends string>(v: unknown, allowed: readonly T[], what: string): T {
	const found = allowed.find(a => a === v);
	if (found !== undefined) return found;
	throw new Unreadable(`${what} was ${JSON.stringify(v) ?? "missing"}, not one of ${allowed.join(", ")}`);
}

function need(v: unknown, what: string): string {
	if (typeof v === "string" && v !== "") return v;
	throw new Unreadable(`gh pr view returned no ${what}`);
}

/** gh's answer to `args`, parsed. A failure whose message holds `emptyWhen` is gh's way of saying "nothing there": null. */
async function run(gh: Gh, args: string[], emptyWhen?: string): Promise<unknown> {
	const r = await gh(args);
	const what = `gh ${args.slice(0, 2).join(" ")}`;
	if (r.code !== 0) {
		if (emptyWhen !== undefined && r.err.includes(emptyWhen)) return null;
		throw new Unreadable(`${what} failed: ${(r.err || r.out).trim().split("\n")[0] || `exit ${r.code}`}`);
	}
	try {
		return JSON.parse(r.out);
	} catch {
		throw new Unreadable(`${what} did not return JSON`);
	}
}

const STATES = ["OPEN", "MERGED", "CLOSED"] as const;
const MERGEABLE = ["MERGEABLE", "CONFLICTING", "UNKNOWN"] as const;
const BUCKETS = ["pass", "fail", "pending", "skipping", "cancel"] as const;
const REVIEW_STATES = ["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED", "PENDING"] as const;
const VIEW_FIELDS = "state,isDraft,author,headRefName,headRefOid,baseRefName,mergeable,mergeStateStatus,reviewDecision,url";
// The PR comes in as variables, never spliced into this text. The word that starts a write stays out of it: the fence refuses it.
const DISCUSSION = `query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){
reviewThreads(last:100){nodes{id isResolved path line comments(last:30){nodes{id body createdAt url isMinimized author{login __typename}}}}}
reviews(last:100){nodes{id state body submittedAt createdAt commit{oid} author{login __typename}}}
comments(last:100){nodes{id body createdAt url isMinimized author{login __typename}}}}}}`;

// ---- the trust filter (AC7) -----------------------------------------------------------------------------------------

const NOTE_LIMIT = 4000;
const WRITE_ROLES = ["admin", "maintain", "write"];

/** Logins compare without case and without the `[bot]` suffix REST adds (GraphQL leaves it off). */
const bare = (login: string) => login.replace(/\[bot\]$/i, "").toLowerCase();

/** What the model gets of a body: quoted lines and HTML comments gone (quotes could carry a stranger's text), cut at NOTE_LIMIT. */
function clean(raw: string, yours: boolean): { body: string; cut: boolean } {
	let body = raw.replace(/\r\n?/g, "\n");
	if (yours) body = body.trimStart().slice(MARKER.length);
	body = body
		.replace(/<!--[\s\S]*?(?:-->|$)/g, "")
		.split("\n")
		.filter(line => !line.trimStart().startsWith(">"))
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	// Only /ship's own comments keep the marker; on anyone else's it is just another hidden comment.
	if (yours) body = body === "" ? MARKER : `${MARKER}\n${body}`;
	if (body.length <= NOTE_LIMIT) return { body, cut: false };
	return { body: body.slice(0, NOTE_LIMIT).replace(/[\ud800-\udbff]$/, ""), cut: true };
}

/** Lets through the user, people with write access (one permission lookup each per read) and the named bots; counts the rest it turns away. */
function trustFilter(gh: Gh, repo: string, trust: Trust) {
	const me = bare(trust.me);
	const bots = new Set(trust.bots.map(bare));
	const writers = new Map<string, boolean>();
	let untrusted = 0;

	const canWrite = async (login: string): Promise<boolean> => {
		if (!/^[\w-]+$/.test(login)) return false;
		const r = await gh(["api", `repos/${repo}/collaborators/${login}/permission`, "--jq", ".permission"]);
		// A lookup that fails (no push access to the repo, a network error) leaves the person untrusted: fail closed.
		return r.code === 0 && WRITE_ROLES.includes(r.out.trim());
	};
	/** The author when trusted. A Bot is trusted by name alone, never by permission, and a User never by a bot's name. */
	const allowed = async (author: unknown): Promise<{ login: string; type: "User" | "Bot" } | null> => {
		const { login, __typename: type } = obj(author);
		if (typeof login !== "string" || (type !== "User" && type !== "Bot")) return null;
		const who = bare(login);
		if (who === "") return null;
		if (type === "Bot") return bots.has(who) ? { login, type } : null;
		if (who === me) return { login, type };
		let can = writers.get(who);
		if (can === undefined) {
			can = await canWrite(login);
			writers.set(who, can);
		}
		return can ? { login, type } : null;
	};

	return {
		get untrusted() {
			return untrusted;
		},
		async note(c: Obj): Promise<Note | null> {
			if (c.isMinimized === true) return null;
			const who = await allowed(c.author);
			if (!who) {
				untrusted++;
				return null;
			}
			const yours = who.type === "User" && bare(who.login) === me && text(c.body).trimStart().startsWith(MARKER);
			const shown = clean(text(c.body), yours);
			if (shown.body === "") return null;
			return { id: text(c.id), author: who.login, bot: who.type === "Bot", yours, at: text(c.createdAt), url: text(c.url), ...shown };
		},
		async review(r: Obj): Promise<Review | null> {
			const who = await allowed(r.author);
			if (!who) {
				if (text(r.body).trim() !== "") untrusted++;
				return null;
			}
			const state = pick(r.state, REVIEW_STATES, "a review's state");
			const body = clean(text(r.body), false).body;
			// A review that says nothing only carries inline comments, which the threads hold.
			if (body === "" && (state === "COMMENTED" || state === "PENDING")) return null;
			return { author: who.login, state, at: text(r.submittedAt) || text(r.createdAt), body, commit: text(obj(r.commit).oid) || null };
		},
	};
}

// ---- the snapshot ---------------------------------------------------------------------------------------------------

/** sha256 over what a pass may act on: head, mergeable state, check buckets, and the trusted unresolved thread notes, comments and reviews. */
function digest(s: Omit<Snapshot, "hash">): string {
	const rows = (items: string[][]) => items.map(row => JSON.stringify(row)).sort();
	const notes = (items: Note[]) => items.map(n => [n.id, n.at, n.body]);
	const parts = [
		s.headSha,
		s.mergeable,
		rows(s.checks.map(c => [c.name, c.bucket])),
		rows(s.threads.filter(t => !t.isResolved).flatMap(t => notes(t.notes))),
		rows(notes(s.comments)),
		rows(s.reviews.map(r => [r.author, r.state, r.at, r.body])),
	];
	return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

async function read(pr: PrRef, gh: Gh, trust: Trust): Promise<Snapshot> {
	const repo = `${pr.owner}/${pr.repo}`;
	const view = obj(await run(gh, ["pr", "view", String(pr.number), "-R", repo, "--json", VIEW_FIELDS]));
	// gh has no empty answer for checks: a PR nothing reports on exits 1 with "no checks reported" instead of printing [].
	const checks = list(await run(gh, ["pr", "checks", String(pr.number), "-R", repo, "--json", "name,bucket,link"], "no checks reported")).map(c => ({
		name: text(obj(c).name),
		bucket: pick(obj(c).bucket, BUCKETS, "a check's bucket"),
		link: text(obj(c).link) || null,
	}));
	const discussion = await run(gh, ["api", "graphql", "-f", `query=${DISCUSSION}`, "-f", `owner=${pr.owner}`, "-f", `repo=${pr.repo}`, "-F", `number=${pr.number}`]);
	const pull = obj(obj(obj(discussion).data).repository).pullRequest;
	if (pull === null || pull === undefined) throw new Unreadable(`${repo}#${pr.number} is not readable with this account`);

	const filter = trustFilter(gh, repo, trust);
	const threads: Thread[] = [];
	for (const t of nodes(obj(pull).reviewThreads)) {
		const notes = await keep(nodes(t.comments), c => filter.note(c));
		const line = typeof t.line === "number" ? t.line : null;
		if (notes.length > 0) threads.push({ id: text(t.id), isResolved: t.isResolved === true, path: text(t.path) || null, line, notes });
	}
	const comments = await keep(nodes(obj(pull).comments), c => filter.note(c));
	const reviews = await keep(nodes(obj(pull).reviews), r => filter.review(r));

	const snapshot: Omit<Snapshot, "hash"> = {
		pr,
		url: need(view.url, "url"),
		state: pick(view.state, STATES, "the PR's state"),
		isDraft: view.isDraft === true,
		author: text(obj(view.author).login) || "ghost",
		headRef: need(view.headRefName, "head branch"),
		headSha: need(view.headRefOid, "head commit"),
		baseRef: need(view.baseRefName, "base branch"),
		mergeable: pick(view.mergeable, MERGEABLE, "the PR's mergeable state"),
		mergeState: text(view.mergeStateStatus),
		reviewDecision: text(view.reviewDecision) || null,
		checks,
		threads,
		comments,
		reviews,
		untrusted: filter.untrusted,
	};
	return { ...snapshot, hash: digest(snapshot) };
}

/** One read of the PR, or why it couldn't be read: `gh pr view`, `gh pr checks` and one GraphQL query, plus a permission lookup per commenter. */
export const readPr: ReadPr = async (pr, gh, trust) => {
	try {
		return await read(pr, gh, trust);
	} catch (error) {
		if (error instanceof Unreadable) return error.message;
		throw error;
	}
};
