// The /ship fence at the shims, with the installed gh against a mock GitHub: what a gh command the fence lets through is
// able to do. gh's host github.localhost speaks plain http to api.github.localhost, so HTTP_PROXY carries every request
// of the real gh to a server in this process, which writes down what it is sent (nothing leaves the machine, and no
// request is the proof that the fence stopped a command). Skipped where there is no gh.
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { privateHome, resetHome } from "../test-harness";
import { MARKER } from "./fence";
import { armFence, disarmFence, FENCE_ENV, installFence, SHIM_DIR } from "./fence-state";

const HOST = "github.localhost";
const BRANCH = "feat/ship-live";
/** The pull request the fence is armed on. */
const WATCH = { host: HOST, owner: "o", repo: "r", number: 5 };
/** What the session's gh and the gh-blinx wrapper authenticate with: neither may reach the transcript. */
const SESSION_TOKEN = "tok_SECRET_session";
const BLINX_TOKEN = "tok_SECRET_blinx";
const marked = `${MARKER}\nFixed the failing test.`;

// ---- a mock GitHub ---------------------------------------------------------------------------------------------------

/** One request gh sent: its method, path with query, the token it carried and its body as text. */
interface Sent {
	method: string;
	path: string;
	token: string | null;
	body: string;
}

/** What gh puts in a request body: a GraphQL document with its variables, or the fields of a REST call. */
interface Payload {
	query?: string;
	variables?: Record<string, unknown> & { input?: { body?: string } };
	body?: string;
}

const payload = (sent: Sent): Payload => JSON.parse(sent.body || "{}");

interface Field {
	key: string;
	name: string;
	sub: Field[] | null;
}

/** The fields a query asks for. An alias keeps its response key, and the fields of a fragment, inline or named, join those of the set that spreads it. */
function selected(query: string): Field[] {
	// The words of the document: the contents of strings dropped, punctuation apart, commas gone.
	const w = query.replace(/"(?:[^"\\]|\\.)*"/g, '""').match(/\.\.\.|[{}():]|[^\s{}():,]+/g) ?? [];
	const named = new Map<string, Field[]>();
	let i = 0;
	const skipArguments = (): void => {
		for (let depth = 0; i < w.length; i++) {
			if (w[i] === "(") depth++;
			else if (w[i] === ")" && --depth === 0) return void i++;
		}
	};
	const set = (): Field[] => {
		i++;
		const fields: Field[] = [];
		while (i < w.length && w[i] !== "}") {
			if (w[i] === "...") {
				i++;
				if (w[i] === "on") {
					i += 2;
					fields.push(...set());
				} else fields.push(...(named.get(w[i++] as string) ?? []));
				continue;
			}
			const key = w[i++] as string;
			let name = key;
			if (w[i] === ":") {
				i++;
				name = w[i++] as string;
			}
			if (w[i] === "(") skipArguments();
			fields.push({ key, name, sub: w[i] === "{" ? set() : null });
		}
		i++;
		return fields;
	};
	let operation: Field[] = [];
	while (i < w.length) {
		if (w[i] === "fragment") {
			const name = w[i + 1] as string;
			i += 4;
			named.set(name, set());
		} else if (w[i] === "{") operation = set();
		else if (w[i] === "(") skipArguments();
		else i++;
	}
	return operation;
}

/** `value` cut to the fields a query selected: gh decodes a response into the shape of its query and refuses a key it didn't ask for. */
function project(value: unknown, fields: Field[]): unknown {
	if (Array.isArray(value)) return value.map(item => project(item, fields));
	if (value === null || typeof value !== "object") return value ?? null;
	const record = value as Record<string, unknown>;
	return Object.fromEntries(fields.map(f => [f.key, f.sub === null ? (record[f.name] ?? null) : project(record[f.name], f.sub)]));
}

/** The pull request each review thread is on, by id: the watched one's, and another repository's. */
const THREADS: Record<string, unknown> = {
	PRRT_watched: { pullRequest: { number: 5, repository: { name: "r", owner: { login: "o" } } } },
	PRRT_other: { pullRequest: { number: 9, repository: { name: "y", owner: { login: "x" } } } },
	PRRT_samenumber: { pullRequest: { number: 5, repository: { name: "y", owner: { login: "x" } } } },
};

function answer(query: string, vars: Record<string, unknown>): unknown {
	const repository = {
		id: "R_1", databaseId: 1, name: "r", nameWithOwner: "o/r", owner: { id: "U_1", login: "o" }, viewerPermission: "ADMIN", hasIssuesEnabled: true, defaultBranchRef: { name: "main" }, visibility: "PUBLIC", viewerCanPush: true,
	};
	const number = Number(vars.number ?? vars.pr_number ?? 5);
	const pull = { id: `PR_${number}`, number, title: "t", state: "OPEN", isDraft: true, url: `http://${HOST}/o/r/pull/${number}`, headRefName: BRANCH, baseRefName: "main", author: { login: "o" }, repository };
	const root = {
		node: Object.hasOwn(THREADS, String(vars.id)) ? THREADS[String(vars.id)] : null,
		viewer: { login: "o" },
		repository: { ...repository, pullRequest: pull, issueOrPullRequest: { __typename: "PullRequest", ...pull }, pullRequests: { nodes: [], totalCount: 0 } },
		createPullRequest: { pullRequest: { id: "PR_9", number: 9, url: `http://${HOST}/o/r/pull/9` } },
		updatePullRequest: { pullRequest: pull },
		addComment: { commentEdge: { node: { url: `http://${HOST}/o/r/pull/${number}#c1` } } },
		resolveReviewThread: { thread: { isResolved: true } },
	};
	return { data: project(root, selected(query)) };
}

function startGithub(): { sent: Sent[]; port: number; stop: () => void } {
	const sent: Sent[] = [];
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(req) {
			const url = new URL(req.url);
			const call: Sent = { method: req.method, path: url.pathname + url.search, token: req.headers.get("authorization"), body: new TextDecoder().decode(await req.arrayBuffer()) };
			sent.push(call);
			const reply = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "x-oauth-scopes": "repo, read:org" } });
			if (url.pathname !== "/graphql") return reply({});
			const request = payload(call);
			if (request.variables?.id === "PRRT_unreachable") return reply({ message: "Bad Gateway" }, 502);
			// gh asks which fields the server has before it builds some queries.
			if (request.query?.includes("__type(")) return reply({ data: { PullRequest: { fields: [{ name: "id" }] }, StatusCheckRollupContextConnection: { fields: [] }, WorkflowRun: { fields: [] } } });
			return reply(answer(request.query ?? "", request.variables ?? {}));
		},
	});
	return { sent, port: server.port as number, stop: () => void server.stop(true) };
}

// ---- running gh and the wrapper through the shims --------------------------------------------------------------------

/** The installed gh, found past the shims. */
const realGh = Bun.which("gh", { PATH: (process.env.PATH ?? "").split(path.delimiter).filter(entry => !entry.endsWith(`${path.sep}ship-fence`)).join(path.delimiter) });

interface Ran {
	code: number;
	out: string;
	err: string;
}

/** The wrapper's text: what ~/.local/bin/gh-blinx does (it is hermes-agent-tasks/bin/gh-blinx), which reads its token with a `gh auth token` of its own. */
const GH_BLINX = `#!/bin/sh
token="$(env -u GITHUB_TOKEN -u GH_TOKEN gh auth token -u blindx-tony-do)" || exit 1
GH_TOKEN="$token" exec gh "$@"
`;

describe.skipIf(realGh === null)("the shims, with the installed gh and a mock GitHub", () => {
	const github = startGithub();
	let savedPath: string | undefined;
	let repo: string;
	let xdg: string;
	let blinxBin: string;
	let secretPng: string;
	let bodyFile: string;

	afterAll(() => github.stop());

	beforeEach(() => {
		resetHome();
		savedPath = process.env.PATH;
		delete process.env[FENCE_ENV];
		const home = privateHome();
		repo = path.join(home, "projects", "app");
		fs.mkdirSync(repo, { recursive: true });
		const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo, env: { ...process.env, PATH: savedPath } });
		git("init", "--quiet", "-b", "main");
		fs.writeFileSync(path.join(repo, "a.ts"), "export const a = 1;\n");
		git("add", "-A");
		git("commit", "--quiet", "-m", "init");
		git("switch", "--quiet", "-c", BRANCH);
		// gh's own config (XDG_CONFIG_HOME, since GH_CONFIG_DIR is refused): the wrapper's account, whose token the wrapper reads out of it.
		xdg = path.join(home, "xdg");
		fs.mkdirSync(path.join(xdg, "gh"), { recursive: true });
		fs.writeFileSync(path.join(xdg, "gh", "hosts.yml"), `${HOST}:\n    users:\n        blindx-tony-do:\n            oauth_token: ${BLINX_TOKEN}\n    oauth_token: ${BLINX_TOKEN}\n    user: blindx-tony-do\n    git_protocol: https\n`);
		blinxBin = path.join(home, "blinx-bin");
		fs.mkdirSync(blinxBin);
		fs.writeFileSync(path.join(blinxBin, "gh-blinx"), GH_BLINX, { mode: 0o755 });
		// Files a command must not send: gh checks an attachment's extension alone, so a secret named .png goes up.
		secretPng = path.join(home, "secret.png");
		fs.writeFileSync(secretPng, "AWS_SECRET_ACCESS_KEY=hunter2\n");
		bodyFile = path.join(home, "body.md");
		fs.writeFileSync(bodyFile, "BODY FROM A LOCAL FILE\n");
		installFence();
		process.env.PATH = [SHIM_DIR, blinxBin, ...(process.env.PATH ?? "").split(path.delimiter).filter(entry => entry !== SHIM_DIR)].join(path.delimiter);
		armFence({ pushBranch: BRANCH, root: repo, pr: WATCH });
		github.sent.length = 0;
	});
	afterEach(() => {
		delete process.env[FENCE_ENV];
		process.env.PATH = savedPath;
	});

	/** `program` as a session's shell runs it: by name, first on PATH, in the armed repository. */
	async function run(program: string, args: string[], extra: Record<string, string | undefined> = {}): Promise<Ran> {
		const proxy = `http://127.0.0.1:${github.port}`;
		const env: Record<string, string | undefined> = { ...process.env, GH_HOST: HOST, GH_TOKEN: SESSION_TOKEN, HTTP_PROXY: proxy, http_proxy: proxy, HTTPS_PROXY: "http://127.0.0.1:1", https_proxy: "http://127.0.0.1:1", GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1", XDG_CONFIG_HOME: xdg };
		for (const name of ["NO_PROXY", "no_proxy", "ALL_PROXY", "GITHUB_TOKEN", "GH_REPO", "GH_CONFIG_DIR"]) delete env[name];
		Object.assign(env, extra);
		const child = Bun.spawn([Bun.which(program, { PATH: env.PATH }) as string, ...args], { cwd: repo, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
		const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
		return { code, out, err };
	}

	/** Every command in `calls` is refused by the fence, and none of them sent GitHub anything. */
	async function refuses(calls: string[][], extra: Record<string, string | undefined> = {}, program = "gh"): Promise<void> {
		const ran = await Promise.all(calls.map(args => run(program, args, extra)));
		for (const [i, r] of ran.entries()) {
			const what = `${program} ${(calls[i] as string[]).join(" ")}: exit ${r.code}, ${(r.err || r.out).trim().split("\n")[0]}`;
			expect(r.err, what).toContain("ship fence");
			expect(r.code, what).toBe(1);
			for (const secret of [SESSION_TOKEN, BLINX_TOKEN]) expect(r.out + r.err, what).not.toContain(secret);
		}
		expect(github.sent).toEqual([]);
	}

	/** The fence lets `args` run: gh got as far as asking GitHub something, and the fence said nothing. */
	async function passes(args: string[], extra: Record<string, string | undefined> = {}, program = "gh"): Promise<Ran> {
		github.sent.length = 0;
		const r = await run(program, args, extra);
		expect(r.err, `${program} ${args.join(" ")}`).not.toContain("ship fence");
		expect(github.sent.length, `${program} ${args.join(" ")}: ${r.err.trim()}`).toBeGreaterThan(0);
		return r;
	}

	/** A draft PR as put-up opens one, with the owner:branch form of --head, which keeps gh from looking at the checkout's branches. */
	const create = (...more: string[]) => ["pr", "create", "-R", "o/r", "--draft", "--title", "t", "--head", "o:feat", "--base", "main", ...more];
	/** Resolving a review thread: the id comes in a variable, or in the query itself. */
	const resolve = (id: string, ...more: string[]) => ["api", "graphql", "-f", "query=mutation($t:ID!){resolveReviewThread(input:{threadId:$t}){thread{isResolved}}}", "-f", `t=${id}`, ...more];
	const resolveLiteral = (id: string) => ["api", "graphql", "-f", `query=mutation{resolveReviewThread(input:{threadId:${id}}){thread{isResolved}}}`];
	const resolved = () => github.sent.some(s => payload(s).query?.includes("resolveReviewThread"));

	test("the mock sees what an allowed gh sends: a refusal below is the fence's, not the harness's", async () => {
		await passes(["pr", "comment", "5", "-R", "o/r", "--body", marked]);
		const comment = github.sent.map(payload).find(p => p.query?.includes("addComment"));
		expect(comment?.variables?.input?.body).toBe(marked);
		expect(github.sent.every(s => s.token === `token ${SESSION_TOKEN}`)).toBe(true);
	}, 30_000);

	test("every gh command the skills tell the model to run is one the armed fence lets through", async () => {
		const skills = ["ship", "build"].map(name => fs.readFileSync(path.join(import.meta.dir, "..", "..", "skills", name, "SKILL.md"), "utf8"));
		// The examples: a gh command in a code span that holds a placeholder or a flag. `gh pr edit` named alone is no example.
		const commands = skills.flatMap(text => [...text.matchAll(/`(gh(?:-blinx)? [^`]*(?:<|--)[^`]*)`/g)].map(m => m[1] as string));
		expect(commands.length).toBeGreaterThanOrEqual(5);
		for (const command of commands) {
			const filled = command.replaceAll("<file outside the repo>", bodyFile).replaceAll("<owner>", "o").replaceAll("<repo>", "r").replaceAll("<url>", `http://${HOST}/o/r/pull/5`).replaceAll("<n>", "5").replaceAll("<id>", "9").replaceAll("<thread id>", "PRRT_watched");
			expect(filled.replaceAll("<!--", "").replaceAll("-->", ""), `${command}: a placeholder the test doesn't fill`).not.toMatch(/<[^>]*>/);
			expect((await run("bash", ["-c", filled])).err, filled).not.toContain("ship fence");
		}
	}, 60_000);

	test("--attach is refused on every command that takes it: gh uploads the file, and an extension is all it checks", async () => {
		const png = secretPng;
		await refuses([
			["pr", "comment", "5", "-R", "o/r", "--attach", png, "--body", marked],
			["pr", "comment", "5", "-R", "o/r", `--attach=${png}`, "--body", marked],
			["pr", "comment", "5", "-R", "o/r", "--body", marked, "--attach", `${png}#alt text`],
			["issue", "comment", "5", "-R", "o/r", "--attach", png, "--body", marked],
			["issue", "comment", "5", "-R", "o/r", `--attach=${png}`, "--body", marked],
			create("--body", "b", "--attach", png),
			create("--body", "b", `--attach=${png}`),
			["pr", "edit", "5", "-R", "o/r", "--attach", png],
			["pr", "edit", "5", "-R", "o/r", `--attach=${png}`, "--title", "t"],
		]);
		expect(github.sent.some(s => s.body.includes("AWS_SECRET_ACCESS_KEY"))).toBe(false);
	}, 60_000);

	test("auth status prints no token, under any spelling of --show-token; gh auth token is not run in the session", async () => {
		await refuses([
			["auth", "status", "--show-token"],
			["auth", "status", "-t"],
			["auth", "status", "-at"],
			["auth", "status", "-ta"],
			["auth", "status", "--show-token=true"],
			["auth", "status", "-t=true"],
			["auth", "status", "--json", "hosts", "--show-token"],
			["auth", "status", "-h", HOST, "-t"],
			["auth", "status", "--hostname", HOST, "--show-token"],
			["auth", "token"],
			["auth", "token", "-u", "blindx-tony-do"],
			["auth", "token", "--hostname", HOST, "--user", "blindx-tony-do"],
		]);
		// The command itself stays: it prints the token masked.
		const status = await passes(["auth", "status", "-h", HOST]);
		expect(status.out + status.err).not.toContain(SESSION_TOKEN);
		expect(status.out + status.err).toContain("Token: *");
	}, 60_000);

	test("--body-file and -F are refused on pr create and pr edit, as they are on a comment: gh sends the file's text", async () => {
		await refuses([
			["pr", "edit", "5", "-R", "o/r", "--body-file", bodyFile],
			["pr", "edit", "5", "-R", "o/r", `--body-file=${bodyFile}`],
			["pr", "edit", "5", "-R", "o/r", "-F", bodyFile],
			["pr", "edit", "5", "-R", "o/r", `-F${bodyFile}`],
			["pr", "edit", "5", "-R", "o/r", "-F", "-"],
			create("--body-file", bodyFile),
			create("-F", bodyFile),
			["pr", "create", "-R", "o/r", "-dF", bodyFile, "--title", "t", "--head", "o:feat"],
			["pr", "comment", "5", "-R", "o/r", "--body-file", bodyFile],
		]);
		expect(github.sent.some(s => s.body.includes("BODY FROM A LOCAL FILE"))).toBe(false);
	}, 60_000);

	test("a pr edit and a pr create assign nobody, Copilot included", async () => {
		await refuses([
			["pr", "edit", "5", "-R", "o/r", "--add-assignee", "@copilot"],
			["pr", "edit", "5", "-R", "o/r", "--add-assignee=@me"],
			["pr", "edit", "5", "-R", "o/r", "--remove-assignee", "@copilot"],
			["pr", "edit", "5", "-R", "o/r", "--remove-assignee=someone", "--title", "t"],
			create("--body", "b", "-a", "@copilot"),
			create("--body", "b", "--assignee=@copilot"),
		]);
	}, 60_000);

	describe("every write names the pull request /ship watches and its repository", () => {
		test("another pull request, another repository, another host, or no repository named at all: refused, nothing sent", async () => {
			const watched = `http://${HOST}/o/r/pull/5`;
			await refuses([
				// pr comment
				["pr", "comment", "6", "-R", "o/r", "--body", marked],
				["pr", "comment", "5", "-R", "x/y", "--body", marked],
				["pr", "comment", "5", "-R", `${HOST}/x/y`, "--body", marked],
				["pr", "comment", "5", "-R", "o/r", "-R", "x/y", "--body", marked],
				["pr", "comment", "5", "--body", marked],
				["pr", "comment", "--body", marked, "-R", "o/r"],
				["pr", "comment", "feat/other", "-R", "o/r", "--body", marked],
				["pr", "comment", `http://${HOST}/x/y/pull/5`, "--body", marked],
				["pr", "comment", `http://${HOST}/o/r/pull/6`, "--body", marked],
				["pr", "comment", "5", "-R", "o/r", "--body", marked, "extra"],
				// pr edit
				["pr", "edit", "6", "-R", "o/r", "--title", "t"],
				["pr", "edit", "5", "-R", "x/y", "--title", "t"],
				["pr", "edit", "--title", "t", "-R", "o/r"],
				["pr", "edit", "5", "--title", "t"],
				["pr", "edit", "feat/other", "-R", "o/r", "--title", "t"],
				["pr", "edit", `http://${HOST}/x/y/pull/5`, "--title", "t"],
				["pr", "edit", watched, "-R", "x/y", "--title", "t"],
				// issue comment
				["issue", "comment", "6", "-R", "o/r", "--body", marked],
				["issue", "comment", "5", "-R", "x/y", "--body", marked],
				["issue", "comment", "5", "--body", marked],
				["issue", "comment", `http://${HOST}/x/y/issues/5`, "--body", marked],
				// run rerun
				["run", "rerun", "123", "-R", "x/y"],
				["run", "rerun", "123", "-R", "x/y", "--failed"],
				["run", "rerun", "123"],
				["run", "rerun", "-R", "o/r"],
				["run", "rerun", "--job", "77", "-R", "x/y"],
				// pr create
				["pr", "create", "-R", "x/y", "--draft", "--title", "t", "--head", "o:feat", "--base", "main", "--body", "b"],
				["pr", "create", "--draft", "--title", "t", "--head", "o:feat", "--base", "main", "--body", "b"],
				// gh api
				["api", "repos/x/y/issues/5/comments", "-f", `body=${marked}`],
				["api", "repos/o/r/issues/6/comments", "-f", `body=${marked}`],
				["api", "repos/o/r/pulls/6/comments", "-f", `body=${marked}`],
				["api", "repos/o/r/pulls/6/comments/9/replies", "-f", `body=${marked}`],
				["api", "repos/x/y/pulls/5/comments/9/replies", "-f", `body=${marked}`],
				["api", "-X", "POST", "repos/o/r/pulls/6/requested_reviewers", "-f", "reviewers[]=someone"],
				["api", "-X", "POST", "repos/x/y/pulls/5/requested_reviewers", "-f", "reviewers[]=someone"],
				["api", "repos/{owner}/{repo}/issues/5/comments", "-f", `body=${marked}`],
				["api", "--hostname", "other.example.com", "repos/o/r/issues/5/comments", "-f", `body=${marked}`],
			]);
		}, 90_000);

		test("another host: GH_HOST, which a repository without a host is read against, and --hostname", async () => {
			const away = { GH_HOST: "other.example.com" };
			await refuses([["pr", "comment", "5", "-R", "o/r", "--body", marked], ["pr", "edit", "5", "-R", "o/r", "--title", "t"], ["issue", "comment", "5", "-R", "o/r", "--body", marked], ["run", "rerun", "123", "-R", "o/r"], ["api", "repos/o/r/issues/5/comments", "-f", `body=${marked}`]], away);
			// A repository that names its host, and a URL, don't depend on it.
			await passes(["pr", "comment", "5", "-R", `${HOST}/o/r`, "--body", marked], away);
			await passes(["pr", "comment", `http://${HOST}/o/r/pull/5`, "--body", marked], away);
		}, 60_000);

		test("the watched pull request and repository are written to, however gh is given them", async () => {
			const watched = `http://${HOST}/o/r/pull/5`;
			const sends = async (args: string[], match: (s: Sent) => boolean) => {
				const r = await passes(args);
				expect(github.sent.some(match), `${args.join(" ")}: ${JSON.stringify(github.sent.map(s => s.path))} ${r.err.trim()}`).toBe(true);
			};
			await sends(["pr", "comment", "5", "-R", "o/r", "--body", marked], s => s.body.includes("addComment"));
			await sends(["pr", "comment", "#5", "-R", "O/R", "--body", marked], s => s.body.includes("addComment"));
			await sends(["pr", "comment", "05", "--repo", `${HOST}/o/r`, "--body", marked], s => s.body.includes("addComment"));
			await sends(["-R", "o/r", "pr", "comment", "5", "--body", marked], s => s.body.includes("addComment"));
			await sends(["pr", "comment", watched, "--body", marked], s => s.body.includes("addComment"));
			await sends(["pr", "comment", `${watched}/files`, "--body", marked], s => s.body.includes("addComment"));
			await sends(["pr", "comment", watched, "-R", "o/r", "--body", marked], s => s.body.includes("addComment"));
			await sends(["pr", "edit", "5", "-R", "o/r", "--title", "new title", "--body", "new body"], s => s.body.includes("new title") && s.body.includes("new body"));
			await sends(["pr", "edit", watched, "--title", "new title"], s => s.body.includes("new title"));
			await sends(["issue", "comment", "5", "-R", "o/r", "--body", marked], s => s.body.includes("addComment"));
			await sends(["issue", "comment", `http://${HOST}/o/r/issues/5`, "--body", marked], s => s.body.includes("addComment"));
			await sends(["run", "rerun", "123", "-R", "o/r"], s => s.method === "POST" && s.path.endsWith("/rerun"));
			await sends(["run", "rerun", "123", "-R", "o/r", "--failed"], s => s.method === "POST" && s.path.endsWith("/rerun-failed-jobs"));
			await sends(["run", "rerun", "--job", "77", "-R", "o/r"], s => s.method === "POST" && s.path.endsWith("/rerun"));
			await sends(create("--body", "b"), s => s.body.includes("createPullRequest") && s.body.includes('"draft":true'));
			await sends(["pr", "create", "--repo", "o/r", "--draft", "--head", "o:feat", "--title", "t", "--body", "b"], s => s.body.includes("createPullRequest") && s.body.includes('"draft":true'));
			// gh api: the comment, a reply in a review thread, a request for another review, a thread resolved.
			await sends(["api", "repos/o/r/issues/5/comments", "-f", `body=${marked}`], s => s.method === "POST" && s.path === "/repos/o/r/issues/5/comments" && payload(s).body === marked);
			await sends(["api", "-X", "POST", "/repos/O/R/pulls/5/comments", "-f", `body=${marked}`, "-f", "commit_id=abc", "-f", "path=a.ts"], s => s.method === "POST" && s.path === "/repos/O/R/pulls/5/comments");
			await sends(["api", "repos/o/r/pulls/5/comments/9/replies", "-f", `body=${marked}`], s => s.method === "POST" && s.path === "/repos/o/r/pulls/5/comments/9/replies");
			await sends(["api", "--method", "POST", "repos/o/r/pulls/5/requested_reviewers", "-f", "reviewers[]=someone"], s => s.method === "POST" && s.path === "/repos/o/r/pulls/5/requested_reviewers");
			await sends(["api", "--hostname", HOST, "repos/o/r/issues/5/comments", "-f", `body=${marked}`], s => s.method === "POST" && s.path === "/repos/o/r/issues/5/comments");
			await sends(["api", "graphql", "-f", "query=mutation($t:ID!){resolveReviewThread(input:{threadId:$t}){thread{isResolved}}}", "-f", "t=PRRT_watched"], s => s.body.includes("resolveReviewThread"));
		}, 120_000);

		test("a review thread is resolved only when GitHub says it is on the watched pull request: its id names no repository, so the fence asks", async () => {
			await passes(resolve("PRRT_watched"));
			expect(resolved()).toBe(true);
			await passes(resolveLiteral("PRRT_watched"));
			expect(resolved()).toBe(true);
			const refusals: [string[], string][] = [
				[resolve("PRRT_other"), "x/y#9"], [resolve("PRRT_samenumber"), "x/y#5"], [resolve("PRRT_nowhere"), "not a review thread"], [resolveLiteral("PRRT_other"), "x/y#9"], [resolve("PRRT_unreachable"), "can't tell which pull request"],
			];
			for (const [args, why] of refusals) {
				github.sent.length = 0;
				const r = await run("gh", args);
				expect(r.err, args.join(" ")).toContain("ship fence");
				expect(r.err, args.join(" ")).toContain(why);
				expect(resolved(), args.join(" ")).toBe(false);
			}
			// What names the thread in a way the fence can't read is refused without asking.
			github.sent.length = 0;
			await refuses([["api", "graphql", "-f", "query=mutation($t:ID!){resolveReviewThread(input:{threadId:$t}){thread{isResolved}}}", "-F", "t=@thread.txt"], resolve("PRRT_watched", "-f", "t=PRRT_other"), resolve("PRRT_watched", "-f", "query=mutation{resolveReviewThread(input:{threadId:PRRT_other}){thread{isResolved}}}")]);
		}, 120_000);

		test("no gh api call reads a file, whatever its method or endpoint: a field from @file and --input are refused, nothing sent", async () => {
			const reviewers = path.join(privateHome(), "reviewers.json");
			fs.writeFileSync(reviewers, '{"reviewers":["someone"]}');
			const leak = `k=@${secretPng}`;
			await refuses([
				// The writes of a watch.
				["api", "repos/o/r/issues/5/comments", "-f", `body=${marked}`, "-F", `note=@${secretPng}`],
				["api", "-X", "POST", "repos/o/r/pulls/5/requested_reviewers", "-F", `reviewers[]=@${secretPng}`],
				["api", "repos/o/r/pulls/5/comments", "-f", `body=${marked}`, "--field", `path=@${secretPng}`],
				["api", "-X", "POST", "repos/o/r/pulls/5/requested_reviewers", "--input", reviewers],
				["api", "-X", "POST", "repos/o/r/pulls/5/requested_reviewers", `--input=${reviewers}`],
				// A read: -X GET turns the fields into query parameters, and --input is the request's body.
				["api", "-X", "GET", "user", "-F", leak],
				["api", "-XGET", "user", `-Fk=@${secretPng}`],
				["api", "--method", "GET", "user", `--field=k=@${secretPng}`],
				["api", "--method=GET", "user", "--field", leak],
				["api", "-X", "GET", "user", "--input", secretPng],
				["api", "user", "--input", secretPng],
				["api", "repos/o/r/pulls/5", "-X", "GET", "-F", leak],
				// Any other path, and GraphQL that is no mutation.
				["api", "-X", "POST", "repos/o/r/issues", "-F", leak],
				["api", "-X", "DELETE", "repos/o/r/issues/5", "--input", secretPng],
				["api", "graphql", "-f", "query={viewer{login}}", "-F", leak],
				["api", "graphql", "-f", "query={viewer{login}}", "--input", secretPng],
			]);
			expect(github.sent.some(s => s.body.includes("AWS_SECRET_ACCESS_KEY") || s.path.includes("AWS_SECRET_ACCESS_KEY"))).toBe(false);
			// A value on the command line, and a field that merely starts like a path, still go.
			await passes(["api", "-X", "POST", "repos/o/r/pulls/5/requested_reviewers", "-f", "reviewers[]=someone"]);
			await passes(["api", "-X", "GET", "repos/o/r/pulls/5", "-f", "per_page=1"]);
		}, 90_000);

		test("a gh config directory from the call's environment is refused: its config.yml can send the session's token to a local socket", async () => {
			const dir = fs.mkdtempSync(path.join("/tmp", "gc-"));
			const socket = path.join(dir, "s");
			const dialed: unknown[] = [];
			const listener = Bun.listen({ unix: socket, socket: { open: s => void dialed.push(s.remoteAddress), data() {}, close() {} } });
			try {
				fs.writeFileSync(path.join(dir, "config.yml"), `http_unix_socket: ${socket}\n`);
				const extra = { GH_CONFIG_DIR: dir };
				await refuses([["pr", "view", "5", "-R", "o/r", "--json", "state"], ["api", "user"], ["auth", "status"], ["pr", "comment", "5", "-R", "o/r", "--body", marked], ["api", "graphql", "-f", "query={viewer{login}}"]], extra);
				await refuses([["pr", "view", "5", "-R", "o/r", "--json", "state"]], extra, "gh-blinx");
				expect((await run("gh", ["api", "user"], extra)).err).toContain("GH_CONFIG_DIR");
				expect(dialed).toEqual([]);
				// Unset or empty, gh looks where it always did.
				await passes(["pr", "view", "5", "-R", "o/r", "--json", "state"], { GH_CONFIG_DIR: "" });
			} finally {
				listener.stop(true);
				fs.rmSync(dir, { recursive: true, force: true });
			}
		}, 60_000);

		test("a fence an older /ship armed, with no pull request recorded, refuses every write, and reads still run", async () => {
			const file = process.env[FENCE_ENV] as string;
			const older = JSON.parse(fs.readFileSync(file, "utf8"));
			delete older.pr;
			fs.writeFileSync(file, JSON.stringify(older));
			const calls = [["pr", "comment", "5", "-R", "o/r", "--body", marked], ["pr", "edit", "5", "-R", "o/r", "--title", "t"], ["issue", "comment", "5", "-R", "o/r", "--body", marked], ["run", "rerun", "123", "-R", "o/r"], ["api", "repos/o/r/issues/5/comments", "-f", `body=${marked}`], create("--body", "b")];
			await refuses(calls);
			expect((await run("gh", calls[0] as string[])).err).toContain("restart omp, then run /ship");
			await passes(["pr", "view", "5", "-R", "o/r", "--json", "state"]);
		}, 60_000);

		test("reads are not pinned", async () => {
			for (const args of [["pr", "view", "5", "-R", "o/r", "--json", "state"], ["pr", "view", "9", "-R", "x/y", "--json", "state"], ["pr", "checks", "5", "-R", "o/r"], ["pr", "diff", "5", "-R", "o/r"], ["pr", "list", "-R", "x/y"], ["run", "view", "123", "-R", "o/r"], ["run", "view", "9", "-R", "x/y"], ["issue", "view", "6", "-R", "x/y"], ["api", "repos/x/y/pulls/5"], ["api", "user"]]) {
				await passes(args);
			}
		}, 90_000);
	});

	describe("gh-blinx", () => {
		test("a pr view runs through the armed shims, with the token the wrapper read; the token itself is never printed", async () => {
			const view = await passes(["pr", "view", "5", "-R", "o/r", "--json", "state"], {}, "gh-blinx");
			expect(view.code).toBe(0);
			expect(view.out + view.err).not.toContain(BLINX_TOKEN);
			expect(github.sent.every(s => s.token === `token ${BLINX_TOKEN}`)).toBe(true);
			await passes(["pr", "comment", "5", "-R", "o/r", "--body", marked], {}, "gh-blinx");
			await passes(["pr", "edit", `http://${HOST}/o/r/pull/5`, "--title", "t"], {}, "gh-blinx");
		}, 60_000);

		test("it resolves a review thread too, and its account is the one that asks GitHub which pull request holds it", async () => {
			await passes(resolve("PRRT_watched"), {}, "gh-blinx");
			expect(github.sent.filter(s => s.body.includes("PullRequestReviewThread") || s.body.includes("resolveReviewThread"))).toHaveLength(2);
			expect(github.sent.every(s => s.token === `token ${BLINX_TOKEN}`)).toBe(true);
			github.sent.length = 0;
			const other = await run("gh-blinx", resolve("PRRT_other"));
			expect(other.err).toContain("x/y#9");
			expect(github.sent.every(s => s.token === `token ${BLINX_TOKEN}`)).toBe(true);
			expect(resolved()).toBe(false);
		}, 60_000);

		test("it is judged as gh is: a merge, a token, another PR, a file: refused, nothing sent", async () => {
			await refuses([["pr", "merge", "5", "-R", "o/r"], ["auth", "token"], ["auth", "status", "--show-token"], ["pr", "comment", "6", "-R", "o/r", "--body", marked], ["pr", "edit", "5", "-R", "o/r", "--body-file", bodyFile]], {}, "gh-blinx");
		}, 60_000);

		test("the real wrapper, run past its shim by its path, gets no token: the session's gh refuses the gh auth token it reads with, so it fails closed", async () => {
			const r = await run(path.join(blinxBin, "gh-blinx"), ["pr", "view", "5", "-R", "o/r", "--json", "state"]);
			expect(r.code).toBe(1);
			expect(r.err).toContain("ship fence");
			expect(r.out + r.err).not.toContain(BLINX_TOKEN);
			expect(github.sent).toEqual([]);
		}, 30_000);

		test("unarmed, the shims run everything as they did, a token read included", async () => {
			disarmFence();
			const token = await run("gh", ["auth", "token", "-u", "blindx-tony-do"]);
			expect(token.out.trim()).toBe(BLINX_TOKEN);
			await passes(["pr", "view", "5", "-R", "o/r", "--json", "state"], {}, "gh-blinx");
			expect(github.sent.every(s => s.token === `token ${BLINX_TOKEN}`)).toBe(true);
			await passes(["pr", "comment", "6", "-R", "x/y", "--body", marked]);
		}, 60_000);
	});
});
