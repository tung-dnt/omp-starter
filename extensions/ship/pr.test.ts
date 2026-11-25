import { beforeAll, describe, expect, test } from "bun:test";
import { checkGh } from "./fence";
import bot from "./fixtures/pr-bot.json";
import commented from "./fixtures/pr-commented.json";
import conflicting from "./fixtures/pr-conflicting.json";
import green from "./fixtures/pr-green.json";
import red from "./fixtures/pr-red.json";
import { parseLink, parseTarget, readHead, readPr } from "./pr";
import type { Gh, PrRef, Snapshot, Trust } from "./types";

// The fixtures are what gh printed for the calls readPr makes, recorded on 2026-11-24 (gh 2.103.3) from throwaway pull
// requests in tung-dnt/omp-ship-sandbox: green and commented are one PR before and after a comment; red is that PR after a
// failing push, with a busy discussion (hidden, quoted, over-long, resolved and minimized comments); conflicting is a PR that
// can't merge; bot is a PR the Actions bot commented on. `permissions` holds the recorded answers of the permission lookups.
// Where a test changes a recording by hand, it says so.

interface Call {
	code: number;
	err: string;
	out: unknown;
}
interface Recording {
	"pr view": Call;
	"pr checks": Call;
	graphql: Call;
	permissions: Record<string, string>;
}

/** A gh that answers from a recording. A login without a permission answer gets the 404 gh prints for one GitHub doesn't know. `running` counts the calls under way, now and at most. */
function replay(rec: Recording, permissions: Record<string, string> = rec.permissions) {
	const calls: string[][] = [];
	const running = { now: 0, most: 0 };
	const gh: Gh = async args => {
		calls.push(args);
		running.most = Math.max(running.most, ++running.now);
		try {
			// A real gh takes a while; yielding once lets calls that were started together overlap, if the reader starts them together.
			await Promise.resolve();
			const call = args[0] === "pr" ? rec[args[1] === "view" ? "pr view" : "pr checks"] : args[1] === "graphql" ? rec.graphql : undefined;
			if (call) return { code: call.code, err: call.err, out: typeof call.out === "string" ? call.out : JSON.stringify(call.out) };
			const role = permissions[/\/collaborators\/([^/]+)\/permission$/.exec(args[1] ?? "")?.[1] ?? ""];
			return role === undefined ? { code: 1, out: "", err: "gh: Not Found (HTTP 404)" } : { code: 0, out: `${role}\n`, err: "" };
		} finally {
			running.now--;
		}
	};
	return { gh, calls, running };
}

const PR: PrRef = { host: "github.com", owner: "tung-dnt", repo: "omp-ship-sandbox", number: 1 };
const ME: Trust = { me: "tung-dnt", bots: [] };
const OTHER: Trust = { me: "someone-else", bots: [] };

async function read(rec: Recording, trust: Trust = ME, permissions?: Record<string, string>): Promise<Snapshot> {
	const snapshot = await readPr(PR, replay(rec, permissions).gh, trust);
	if (typeof snapshot === "string") throw new Error(`unreadable: ${snapshot}`);
	return snapshot;
}

const withView = (rec: Recording, patch: Record<string, unknown>): Recording => ({ ...rec, "pr view": { ...rec["pr view"], out: { ...(rec["pr view"].out as object), ...patch } } });

/** `rec` with `from` replaced by `to` in the GraphQL answer's text. */
function edited(rec: Recording, from: string, to: string): Recording {
	const out = JSON.stringify(rec.graphql.out);
	expect(out).toContain(from);
	return { ...rec, graphql: { ...rec.graphql, out: out.replace(from, to) } };
}

describe("readPr", () => {
	test("a green PR reads as open, mergeable, every check passing and nothing said", async () => {
		const s = await read(green);
		expect(s).toMatchObject({ pr: PR, state: "OPEN", isDraft: false, author: "tung-dnt", headRef: "s2-read", baseRef: "main", mergeable: "MERGEABLE", mergeState: "CLEAN", reviewDecision: null, untrusted: 0, threads: [], comments: [], reviews: [] });
		expect(s.url).toBe("https://github.com/tung-dnt/omp-ship-sandbox/pull/1");
		expect(s.headSha).toBe("88a331f0abefc4ff292065b068a925c07cf5fb97");
		expect(s.checks.map(c => `${c.name}:${c.bucket}`).sort()).toEqual(["GitGuardian Security Checks:pass", "test:pass", "test:pass"]);
		expect(s.checks.find(c => c.name === "GitGuardian Security Checks")?.link).toBe("https://dashboard.gitguardian.com");
		expect(s.hash).toMatch(/^[0-9a-f]{64}$/);
	});

	test("a red PR reports its failing checks", async () => {
		const s = await read(red);
		expect(s.checks.filter(c => c.bucket === "fail").map(c => c.name)).toEqual(["test", "test"]);
		expect(s).toMatchObject({ mergeable: "MERGEABLE", mergeState: "UNSTABLE", headSha: "4355ed29141d49429f86b11125536a16f579ac31" });
	});

	test("a PR that can't merge reads as conflicting, against its own base", async () => {
		expect(await read(conflicting)).toMatchObject({ mergeable: "CONFLICTING", mergeState: "DIRTY", baseRef: "s2-base", headRef: "s2-conflict", state: "OPEN" });
	});

	test("a PR nothing reports on has no checks: gh says so with a failure, not an empty list", async () => {
		// gh's own message (cli/cli, populateStatusChecks). Not recorded: the sandbox can't make it, GitGuardian reports on every PR there.
		const none = { ...green, "pr checks": { code: 1, out: "", err: "no checks reported on the 's2-read' branch\n" } };
		expect((await read(none)).checks).toEqual([]);
	});

	test("a merged or closed PR is still read in full, so the watch can see it end", async () => {
		for (const state of ["MERGED", "CLOSED"] as const) {
			const s = await read(withView(green, { state }));
			expect([s.state, s.checks.length]).toEqual([state, 3]);
		}
	});

	test("says why when gh can't answer", async () => {
		const why = (rec: unknown) => readPr(PR, replay(rec as Recording).gh, ME);
		const notFound = { code: 1, out: "", err: "GraphQL: Could not resolve to a PullRequest with the number of 999. (repository.pullRequest)\n" };
		expect(await why({ ...green, "pr view": notFound })).toBe("gh pr view failed: GraphQL: Could not resolve to a PullRequest with the number of 999. (repository.pullRequest)");
		expect(await why({ ...green, "pr checks": { code: 1, out: "", err: "HTTP 502: Bad Gateway\n" } })).toBe("gh pr checks failed: HTTP 502: Bad Gateway");
		const noRepo = { code: 1, out: '{"data":{"repository":null},"errors":[{"type":"NOT_FOUND"}]}', err: "gh: Could not resolve to a Repository with the name 'tung-dnt/gone'.\n" };
		expect(await why({ ...green, graphql: noRepo })).toBe("gh api graphql failed: gh: Could not resolve to a Repository with the name 'tung-dnt/gone'.");
		expect(await why({ ...green, graphql: { code: 0, err: "", out: { data: { repository: { pullRequest: null } } } } })).toContain("is not readable");
		expect(await why({ ...green, "pr view": { code: 0, err: "", out: "<html>" } })).toBe("gh pr view did not return JSON");
		expect(await why({ ...green, "pr view": { code: 1, out: "", err: "" } })).toBe("gh pr view failed: exit 1");
		expect(await why(withView(green, { mergeable: "MAYBE" }))).toContain('the PR\'s mergeable state was "MAYBE"');
		expect(await why(withView(green, { headRefOid: "" }))).toBe("gh pr view returned no head commit");
		expect(await why({ ...green, "pr checks": { code: 0, err: "", out: [{ name: "t", bucket: "weird", link: "" }] } })).toContain("a check's bucket");
	});

	test("every gh call it makes is one the fence lets through", async () => {
		const { gh, calls } = replay(red);
		await readPr(PR, gh, OTHER);
		expect(calls.length).toBeGreaterThanOrEqual(4);
		for (const args of calls) expect(checkGh(args, PR)).toBeNull();
	});
});

describe("the hash", () => {
	let quiet = "";
	beforeAll(async () => {
		quiet = (await read(green)).hash;
	});

	test("is the same for the same PR", async () => {
		expect((await read(green)).hash).toBe(quiet);
		expect((await read(red)).hash).toBe((await read(red)).hash);
	});

	test("moves when the head, the mergeable state or a check's bucket does", async () => {
		expect((await read(withView(green, { headRefOid: "f".repeat(40) }))).hash).not.toBe(quiet);
		expect((await read(withView(green, { mergeable: "CONFLICTING" }))).hash).not.toBe(quiet);
		expect((await read({ ...green, "pr checks": red["pr checks"] })).hash).not.toBe(quiet);
	});

	test("holds when a check is re-run to the same result, whatever its order or link", async () => {
		const rerun = [...green["pr checks"].out].reverse().map(c => ({ ...c, link: "https://example.test/rerun" }));
		expect((await read({ ...green, "pr checks": { ...green["pr checks"], out: rerun } })).hash).toBe(quiet);
	});

	test("moves when a trusted comment lands, and not when an untrusted one does", async () => {
		const landed = await read(commented);
		expect(landed.comments.map(c => c.body)).toEqual(["Looks good. Could you also add a test for the empty case?"]);
		expect(landed.hash).not.toBe(quiet);

		// Same recording, but the author now has only read access to a repo that isn't theirs.
		const stranger = await read(commented, OTHER, { "tung-dnt": "read" });
		expect(stranger).toMatchObject({ comments: [], untrusted: 1 });
		expect(stranger.hash).toBe((await read(green, OTHER)).hash);
	});

	test("ignores resolved threads, and follows unresolved ones and a thread's resolution", async () => {
		const base = (await read(red)).hash;
		expect((await read(edited(red, "Nit: use single quotes here.", "Nit: use double quotes here."))).hash).toBe(base);
		expect((await read(edited(red, "Should this echo go through", "Should this call go through"))).hash).not.toBe(base);
		expect((await read(edited(red, '"isResolved":true', '"isResolved":false'))).hash).not.toBe(base);
	});
});

describe("the trust filter", () => {
	test("people with admin, maintain or write access are trusted; read, triage, none and unknown logins are not", async () => {
		for (const role of ["admin", "maintain", "write"]) expect(await read(commented, OTHER, { "tung-dnt": role })).toMatchObject({ untrusted: 0, comments: [{ author: "tung-dnt", bot: false, yours: false }] });
		for (const role of ["read", "triage", "none", ""]) expect(await read(commented, OTHER, { "tung-dnt": role })).toMatchObject({ untrusted: 1, comments: [] });
		expect(await read(commented, OTHER, {})).toMatchObject({ untrusted: 1, comments: [] });
	});

	test("the user needs no lookup, and everyone else is looked up once per read however much they wrote", async () => {
		const lookups = async (rec: Recording, trust: Trust) => {
			const { gh, calls } = replay(rec);
			await readPr(PR, gh, trust);
			return calls.filter(args => args[0] === "api" && args[1] !== "graphql").map(args => args[1]);
		};
		expect(await lookups(red, ME)).toEqual([]);
		expect(await lookups(red, OTHER)).toEqual(["repos/tung-dnt/omp-ship-sandbox/collaborators/tung-dnt/permission"]);
	});

	test("each gh call finishes before the next starts, so a PR with a crowd of commenters never starts a crowd of gh processes", async () => {
		const strangers = ["alice", "bob", "carol", "dave"];
		const note = (login: string) => ({ id: login, body: `from ${login}`, createdAt: "2026-11-24T09:00:00Z", url: "https://example.test", isMinimized: false, author: { login, __typename: "User" } });
		const pull = { reviewThreads: { nodes: [] }, reviews: { nodes: [] }, comments: { nodes: strangers.map(note) } };
		const crowd = { ...green, graphql: { ...green.graphql, out: { data: { repository: { pullRequest: pull } } } } };
		const { gh, calls, running } = replay(crowd, Object.fromEntries(strangers.map(login => [login, "write"])));
		const snapshot = (await readPr(PR, gh, OTHER)) as Snapshot;
		expect(snapshot.comments.map(c => c.author)).toEqual(strangers);
		expect(calls.filter(args => args[1]?.includes("/collaborators/"))).toHaveLength(strangers.length);
		expect(running.most).toBe(1);
	});

	test("a login that isn't one is never put in a URL", async () => {
		const odd = edited(commented, '"login":"tung-dnt"', '"login":"x/../../admin"');
		const { gh, calls } = replay(odd, { "x/../../admin": "admin" });
		expect(await readPr(PR, gh, OTHER)).toMatchObject({ comments: [], untrusted: 1 });
		expect(calls.some(args => args[1]?.includes("/collaborators/"))).toBe(false);
	});

	test("bots are trusted by name, with or without [bot] and whatever the case, and never looked up", async () => {
		const text = "Build report: 1 job finished. Details are on the checks tab.";
		const unnamed = await read(bot, ME);
		expect(unnamed).toMatchObject({ comments: [], untrusted: 1 });
		for (const name of ["github-actions", "github-actions[bot]", "GitHub-Actions"]) {
			const { gh, calls } = replay(bot);
			const named = (await readPr(PR, gh, { me: "tung-dnt", bots: [name] })) as Snapshot;
			expect(named).toMatchObject({ untrusted: 0, comments: [{ author: "github-actions", bot: true, yours: false, body: text }] });
			expect(named.hash).not.toBe(unnamed.hash);
			expect(calls.some(args => args[1]?.includes("/collaborators/"))).toBe(false);
		}
	});

	test("a person who shares a named bot's login is not that bot", async () => {
		const person = edited(bot, '"__typename":"Bot"', '"__typename":"User"');
		expect(await read(person, { me: "tung-dnt", bots: ["github-actions"] })).toMatchObject({ comments: [], untrusted: 1 });
	});
});

describe("what the model sees of a comment", () => {
	let s: Snapshot;
	beforeAll(async () => {
		s = await read(red);
	});

	test("quoted lines and hidden HTML comments are dropped, and a note left empty is dropped with them", () => {
		expect(s.comments).toHaveLength(4);
		expect(s.comments.slice(0, 3).map(c => c.body)).toEqual([
			"Looks good. Could you also add a test for the empty case?",
			"<!-- omp-ship -->\nAdded the empty-case test in 88a331f.",
			"Sounds good, will do.",
		]);
		expect(s.comments[3]?.body.startsWith("Long review note.")).toBe(true);
	});

	test("a minimized comment is dropped without being counted", () => {
		expect(s.untrusted).toBe(0);
		expect(JSON.stringify(s)).not.toContain("cheap watches");
	});

	test("a body is cut at 4,000 characters and says so", () => {
		const long = s.comments[3];
		expect(long).toMatchObject({ cut: true });
		expect(long?.body).toHaveLength(4000);
		expect(s.comments.filter(c => c.cut)).toHaveLength(1);
	});

	test("the user's comment that starts with the marker is /ship's own, and keeps its marker", () => {
		expect(s.comments.map(c => c.yours)).toEqual([false, true, false, false]);
		expect(s.comments[1]?.body).toBe("<!-- omp-ship -->\nAdded the empty-case test in 88a331f.");
	});

	test("the same comment from someone else is not /ship's, and shows no marker", async () => {
		const theirs = await read(red, OTHER, { "tung-dnt": "write" });
		expect(theirs.comments.map(c => c.yours)).toEqual([false, false, false, false]);
		expect(theirs.comments[1]?.body).toBe("Added the empty-case test in 88a331f.");
	});

	test("review threads keep their path, line, order and resolved state; a review with no words is dropped", () => {
		expect(s.threads.map(t => [t.isResolved, t.path, t.line, t.notes.map(n => n.body)])).toEqual([
			[false, "app.sh", 2, ["Should this echo go through a variable so the test can stub it?", "Good point. I will pull it into a variable."]],
			[true, "app.sh", 1, ["Nit: use single quotes here."]],
		]);
		expect(s.reviews).toEqual([{ author: "tung-dnt", state: "COMMENTED", at: "2026-11-24T10:57:05Z", body: "Overall fine, one nit inline.", commit: "88a331f0abefc4ff292065b068a925c07cf5fb97" }]);
	});

	test("a thread whose notes are all untrusted is left out, and its notes counted", async () => {
		const theirs = await read(red, OTHER, { "tung-dnt": "read" });
		expect(theirs).toMatchObject({ threads: [], comments: [], reviews: [], untrusted: 9 });
	});
});

describe("parseTarget", () => {
	const aliases: Record<string, string> = { "blindx.github": "github.com", "gl.work": "gitlab.com", over443: "ssh.github.com" };
	const sshHostname = (alias: string) => aliases[alias] ?? null;
	const pr = (owner: string, repo: string, number: number): PrRef => ({ host: "github.com", owner, repo, number });
	const origin = "git@github.com:o/r.git";

	test("a number or #number names the PR in the checkout's repo; no argument names the repo alone", () => {
		expect(parseTarget("12", origin, sshHostname)).toEqual(pr("o", "r", 12));
		expect(parseTarget("#12", origin, sshHostname)).toEqual(pr("o", "r", 12));
		expect(parseTarget(" 12\n", origin, sshHostname)).toEqual(pr("o", "r", 12));
		expect(parseTarget(null, origin, sshHostname)).toEqual({ owner: "o", repo: "r" });
		expect(parseTarget("  ", origin, sshHostname)).toEqual({ owner: "o", repo: "r" });
	});

	test("origin may be https, ssh or scp-like, with or without .git, a login or an ssh alias", () => {
		for (const url of [
			"https://github.com/o/r.git", "https://github.com/o/r", "https://github.com/o/r/", "https://x-access-token:abc@github.com/o/r.git", "http://github.com/o/r",
			"git://github.com/o/r.git", "ssh://git@github.com/o/r.git", "ssh://git@github.com:22/o/r.git", "ssh://git@ssh.github.com:443/o/r.git",
			"git@github.com:o/r.git", "git@GitHub.com:o/r", "github.com:o/r.git", "git@github.com:/o/r.git", "  git@github.com:o/r.git\n",
			"git@blindx.github:o/r.git", "ssh://git@blindx.github/o/r.git", "git@over443:o/r.git",
		]) {
			expect(parseTarget("5", url, sshHostname)).toEqual(pr("o", "r", 5));
		}
		expect(parseTarget(null, "git@blindx.github:blinxsolutions/x.git", sshHostname)).toEqual({ owner: "blinxsolutions", repo: "x" });
	});

	test("only an ssh host that isn't github.com is resolved", () => {
		const asked: string[] = [];
		const lookup = (alias: string) => {
			asked.push(alias);
			return aliases[alias] ?? null;
		};
		parseTarget("5", "git@github.com:o/r.git", lookup);
		parseTarget("5", "https://github.com/o/r.git", lookup);
		expect(asked).toEqual([]);
		parseTarget("5", "git@blindx.github:o/r.git", lookup);
		expect(asked).toEqual(["blindx.github"]);
	});

	test("refuses an origin that isn't a GitHub repo, and says why", () => {
		const refused: [string, string][] = [
			["", "no origin remote"],
			["/home/me/repo", "not a URL"],
			["ftp://example.com/o/r.git", "ftp://"],
			["https://gitlab.com/o/r.git", "gitlab.com, not github.com"],
			["https://github.example.com/o/r.git", "github.example.com, not github.com"],
			["https://alias-that-ssh-knows/o/r.git", "not github.com"],
			["git@gl.work:o/r.git", "gitlab.com, not github.com"],
			["git@nowhere:o/r.git", "can't resolve the ssh host nowhere"],
			["https://github.com/o", "owner/repo"],
			["https://github.com/o/r/extra.git", "owner/repo"],
			["https://github.com/../r.git", "owner/repo"],
		];
		for (const [url, why] of refused) expect(parseTarget("5", url, sshHostname)).toContain(why);
		expect(parseTarget(null, "https://gitlab.com/o/r.git", sshHostname)).toContain("not github.com");
	});

	test("a refusal never repeats the credentials in origin", () => {
		const why = parseTarget("5", "https://user:s3cret@gitlab.com/o/r.git", sshHostname);
		expect(why).toContain("gitlab.com");
		expect(String(why)).not.toContain("s3cret");
	});

	test("refuses an argument that isn't a PR of github.com", () => {
		for (const arg of ["abc", "0", "-3", "12x", "stop", "#", "99999999999999999999", "https://gitlab.com/o/r/-/merge_requests/3", "https://github.com/o/r/issues/3", "https://github.com/o/r", "https://github.com/../r/pull/3"]) {
			expect(parseTarget(arg, origin, sshHostname)).toMatch(/not a PR|PR number/);
		}
	});
});

describe("parseLink", () => {
	const pr = (owner: string, repo: string, number: number): PrRef => ({ host: "github.com", owner, repo, number });

	test("a github.com pull request URL names its PR, whatever follows the number", () => {
		expect(parseLink("https://github.com/x/y/pull/7")).toEqual(pr("x", "y", 7));
		expect(parseLink("https://github.com/x/y/pull/7/files?w=1#diff-a")).toEqual(pr("x", "y", 7));
		expect(parseLink("http://github.com/blinxsolutions/paco24/pull/9689")).toEqual(pr("blinxsolutions", "paco24", 9689));
		expect(parseLink("  https://github.com/x/y/pull/7\n")).toEqual(pr("x", "y", 7));
		expect(parseLink("https://GitHub.com/X/Y/pull/7")).toEqual(pr("X", "Y", 7));
	});

	test("anything else is not a link, for parseTarget to read", () => {
		for (const arg of [null, "", "  ", "12", "#12", "stop", "abc", "https://gitlab.com/o/r/-/merge_requests/3", "https://github.com/o/r/issues/3", "https://github.com/o/r", "github.com/o/r/pull/3", "https://github.example.com/o/r/pull/3"]) {
			expect(parseLink(arg)).toBeNull();
		}
	});

	test("a URL that looks like a PR's but isn't says so", () => {
		expect(parseLink("https://github.com/../r/pull/3")).toMatch(/not a PR/);
		expect(parseLink("https://github.com/o/r/pull/0")).toBe("0 is not a PR number");
		expect(parseLink("https://github.com/o/r/pull/99999999999999999999")).toBe("99999999999999999999 is not a PR number");
	});
});

describe("readHead", () => {
	const view = (out: unknown, over: { code?: number; err?: string } = {}): { gh: Gh; calls: string[][] } => {
		const calls: string[][] = [];
		const gh: Gh = async args => {
			calls.push(args);
			return { code: over.code ?? 0, err: over.err ?? "", out: typeof out === "string" ? out : JSON.stringify(out) };
		};
		return { gh, calls };
	};
	const open = { state: "OPEN", author: { login: "tung-dnt" }, headRefName: "feat/x", isCrossRepository: false };
	const read = (out: unknown, over?: { code?: number; err?: string }) => readHead({ ...PR, number: 12 }, view(out, over).gh);

	test("says whether the PR is open, whose it is and where its branch is, from one gh pr view", async () => {
		const { gh, calls } = view(open);
		expect(await readHead({ ...PR, number: 12 }, gh)).toEqual({ state: "OPEN", author: "tung-dnt", branch: "feat/x", fork: false });
		expect(calls).toEqual([["pr", "view", "12", "-R", "tung-dnt/omp-ship-sandbox", "--json", "state,author,headRefName,isCrossRepository"]]);
	});

	test("a branch in a fork is a fork's", async () => {
		expect(await read({ ...open, isCrossRepository: true })).toMatchObject({ fork: true });
	});

	test("a merged or closed PR is read as such, so the caller can refuse it", async () => {
		expect(await read({ ...open, state: "MERGED" })).toMatchObject({ state: "MERGED" });
		expect(await read({ ...open, state: "CLOSED" })).toMatchObject({ state: "CLOSED" });
	});

	test("a PR whose author GitHub no longer has is ghost's", async () => {
		expect(await read({ ...open, author: null })).toMatchObject({ author: "ghost" });
	});

	test("says why when gh can't answer", async () => {
		expect(await read("", { code: 1, err: "GraphQL: Could not resolve to a PullRequest with the number of 999. (repository.pullRequest)\n" })).toBe("gh pr view failed: GraphQL: Could not resolve to a PullRequest with the number of 999. (repository.pullRequest)");
		expect(await read("<html>")).toBe("gh pr view did not return JSON");
		expect(await read({ ...open, headRefName: "" })).toBe("gh pr view returned no head branch");
		expect(await read({ ...open, state: "WEIRD" })).toContain("the PR's state");
	});
});
