import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { HOME } from "./lib/state";
import { fakeContext, fakePi, resetHome, seedKb, seedState, writeFiles, type FakePi, type SeededKb } from "./test-harness";
import unattended, { STOP_BUDGET } from "./unattended";

const STORY = "PAC2-1234";
const API = { repo: "acme/api", branch: "feat/api" };
const WORK = { repo: "blinxsolutions/paco24", branch: "feat/paco" };
const OPEN = ["https://github.com/acme/api/pull/1"];
const REAL_PATH = process.env.PATH;

beforeEach(resetHome);
afterEach(() => {
	delete process.env.OMP_STARTER_UNATTENDED;
	delete process.env.OMP_STARTER_STORY;
	process.env.PATH = REAL_PATH;
});

/** A plan.md the way the planning session writes it: repos in the frontmatter, the rest prose. */
function planText(repos: { repo: string; branch: string }[]): string {
	const entries = repos.map(r => `  - { repo: ${r.repo}, clone: ~/projects/${r.repo.split("/")[1]}, base: main, branch: ${r.branch} }`);
	return ["---", `story: ${STORY}`, "repos:", ...entries, "lanes: [backend, security]   # panel lanes", "---", "## Goal", "Ship it.", "## Decision log", ""].join("\n");
}

/** What `gh pr list` answers for one `<repo>#<branch>`: its open pull request urls, a failure, a missing binary or no JSON list. */
type Answer = string[] | "fails" | "cannot-run" | "not-a-list";

interface Verdict {
	decision?: string;
	reason?: string;
}

interface Refusal {
	block?: boolean;
	reason?: string;
}

interface Session {
	fake: FakePi;
	kb: SeededKb;
	/** `<kb>/projects/<story>` */
	dir: string;
	stuck: string;
	stop(agent?: "main" | "sub"): Promise<Verdict | undefined>;
	tool(toolName: string, agent?: "main" | "sub"): Refusal | undefined;
	start(event: "session_start" | "session_switch", agent: "main" | "sub"): void;
}

interface Build {
	/** Text of plan.md; null writes none. */
	plan?: string | null;
	prs?: Record<string, Answer>;
	story?: string;
}

/** An unattended build of `story` in `~/projects/api`, with a knowledge base serving `~/projects` and `gh` answering from `prs`. */
function session({ plan = planText([API, WORK]), prs = {}, story = STORY }: Build = {}): Session {
	const kb = seedKb({ name: "kb", folder: path.join(HOME, "projects") });
	seedState({ kb: { status: "done", sources: [kb.source] } });
	const dir = path.join(kb.root, "projects", story);
	if (plan !== null) writeFiles(dir, { "plan.md": plan });
	process.env.OMP_STARTER_UNATTENDED = "1";
	process.env.OMP_STARTER_STORY = story;
	const fake = fakePi((_command, args) => {
		const answer = prs[`${args[args.indexOf("-R") + 1]}#${args[args.indexOf("--head") + 1]}`] ?? [];
		if (answer === "cannot-run") throw new Error('Executable not found in $PATH: "gh"');
		if (answer === "fails") return { stderr: "HTTP 404: Not Found\n", code: 1 };
		if (answer === "not-a-list") return { stdout: "{}", code: 0 };
		return { stdout: JSON.stringify(answer.map(url => ({ url }))), code: 0 };
	});
	unattended(fake.pi);
	const context = (agent: "main" | "sub") => fakeContext({ cwd: path.join(HOME, "projects", "api"), agent: { kind: agent, name: agent === "main" ? "main" : "task" } });
	return {
		fake,
		kb,
		dir,
		stuck: path.join(dir, "stuck.md"),
		stop: async (agent = "main") => (await fake.emit("session_stop", {}, context(agent))) as Verdict | undefined,
		tool: (toolName, agent = "main") => fake.emit("tool_call", { toolName, input: {} }, context(agent)) as Refusal | undefined,
		start: (event, agent) => void fake.emit(event, {}, context(agent)),
	};
}

describe("which sessions it applies to", () => {
	test("registers nothing unless OMP_STARTER_UNATTENDED is exactly 1 and a story is named", () => {
		const registered = (env: Record<string, string>): string[] => {
			delete process.env.OMP_STARTER_UNATTENDED;
			delete process.env.OMP_STARTER_STORY;
			Object.assign(process.env, env);
			const fake = fakePi();
			unattended(fake.pi);
			return [...fake.handlers.keys()].sort();
		};
		expect(registered({})).toEqual([]);
		expect(registered({ OMP_STARTER_STORY: STORY })).toEqual([]);
		expect(registered({ OMP_STARTER_UNATTENDED: "1" })).toEqual([]);
		expect(registered({ OMP_STARTER_UNATTENDED: "1", OMP_STARTER_STORY: "  " })).toEqual([]);
		expect(registered({ OMP_STARTER_UNATTENDED: "true", OMP_STARTER_STORY: STORY })).toEqual([]);
		expect(registered({ OMP_STARTER_UNATTENDED: "1", OMP_STARTER_STORY: STORY })).toEqual(["session_start", "session_stop", "session_switch", "tool_call"]);
	});
});

describe("ask", () => {
	test("is refused: the agent decides, records it in the plan's Decision log, or writes stuck.md", () => {
		const s = session();
		const refusal = s.tool("ask");
		expect(refusal?.block).toBe(true);
		expect(refusal?.reason).toContain("## Decision log");
		expect(refusal?.reason).toContain(path.join(s.dir, "plan.md"));
		expect(refusal?.reason).toContain(path.join(s.dir, "stuck.md"));
		expect(s.tool("ask", "sub")?.block).toBe(true);
	});

	test("is still refused when no knowledge base holds the plan", () => {
		const s = session();
		seedState({});
		const refusal = s.tool("ask");
		expect(refusal?.block).toBe(true);
		expect(refusal?.reason).toContain("## Decision log");
	});

	test("every other tool is left alone", () => {
		const s = session();
		for (const toolName of ["bash", "read", "write", "edit", "todo", "task", "kb_remember"]) expect(s.tool(toolName)).toBeUndefined();
	});
});

describe("the stop rule", () => {
	test("refuses the stop while a repository has no open pull request, naming it and both ways out", async () => {
		const s = session({ prs: { "acme/api#feat/api": OPEN } });
		const verdict = await s.stop();
		expect(verdict?.decision).toBe("block");
		expect(verdict?.reason).toContain("blinxsolutions/paco24 (branch feat/paco): no open pull request");
		expect(verdict?.reason).toContain("pr create --draft -R blinxsolutions/paco24 --head feat/paco");
		expect(verdict?.reason).toContain(`write why to ${s.stuck}`);
		expect(verdict?.reason).toContain(`stop 1 of ${STOP_BUDGET}`);
		expect(verdict?.reason).not.toContain("acme/api");
		expect(fs.existsSync(s.stuck)).toBe(false);
	});

	test("lets the stop through once every repository has an open pull request on its branch", async () => {
		const s = session({ prs: { "acme/api#feat/api": OPEN, "blinxsolutions/paco24#feat/paco": ["https://github.com/blinxsolutions/paco24/pull/7"] } });
		expect(await s.stop()).toBeUndefined();
		expect(fs.existsSync(s.stuck)).toBe(false);
	});

	test("asks GitHub for the open pull requests of each plan branch, one call per repository", async () => {
		const web = { repo: "acme/web", branch: "feat/web" };
		const s = session({ plan: planText([API, web]), prs: { "acme/api#feat/api": OPEN, "acme/web#feat/web": ["https://github.com/acme/web/pull/2"] } });
		expect(await s.stop()).toBeUndefined();
		expect(s.fake.execCalls).toEqual([
			{ command: "gh", args: ["pr", "list", "-R", "acme/api", "--head", "feat/api", "--state", "open", "--json", "url"] },
			{ command: "gh", args: ["pr", "list", "-R", "acme/web", "--head", "feat/web", "--state", "open", "--json", "url"] },
		]);
	});

	test("the work organisation's repositories use gh-blinx when it is on PATH, and plain gh when it is not", async () => {
		const bin = path.join(HOME, "bin");
		writeFiles(bin, { "gh-blinx": "#!/bin/sh\nexit 0\n" });
		fs.chmodSync(path.join(bin, "gh-blinx"), 0o755);
		const commands = async (): Promise<string[]> => {
			const s = session({ plan: planText([WORK, API]) });
			await s.stop();
			return s.fake.execCalls.map(call => call.command);
		};

		process.env.PATH = bin;
		expect(await commands()).toEqual(["gh-blinx", "gh"]);
		process.env.PATH = path.join(HOME, "no-such-bin");
		expect(await commands()).toEqual(["gh", "gh"]);
	});

	test("stuck.md lets the stop through without asking GitHub", async () => {
		const s = session();
		fs.writeFileSync(s.stuck, "cannot reach the staging database\n");
		expect(await s.stop()).toBeUndefined();
		expect(s.fake.execCalls).toEqual([]);
		expect(fs.readFileSync(s.stuck, "utf8")).toBe("cannot reach the staging database\n");
	});

	test("a gh that fails, cannot run or prints no list is never a clean result: the repository is named with the reason", async () => {
		const reasonFor = async (answer: Answer): Promise<string | undefined> => (await session({ prs: { "acme/api#feat/api": OPEN, "blinxsolutions/paco24#feat/paco": answer } }).stop())?.reason;

		const fails = await reasonFor("fails");
		expect(fails).toContain("blinxsolutions/paco24 (branch feat/paco): could not check for a pull request");
		expect(fails).toContain("exited 1: HTTP 404: Not Found");
		expect(await reasonFor("cannot-run")).toContain("Executable not found");
		expect(await reasonFor("not-a-list")).toContain("did not print a JSON list");
	});

	test(`after ${STOP_BUDGET} refused stops the next one goes through and stuck.md says the budget is spent`, async () => {
		const s = session({ prs: { "blinxsolutions/paco24#feat/paco": OPEN } });
		for (let n = 1; n <= STOP_BUDGET; n++) {
			const verdict = await s.stop();
			expect(verdict?.decision).toBe("block");
			expect(verdict?.reason).toContain(`stop ${n} of ${STOP_BUDGET}`);
		}
		expect(fs.existsSync(s.stuck)).toBe(false);

		expect(await s.stop()).toBeUndefined();
		const text = fs.readFileSync(s.stuck, "utf8");
		expect(text).toMatch(/^stop budget spent/);
		expect(text).toContain("acme/api (feat/api)");
		expect(text).not.toContain("blinxsolutions/paco24");

		// stuck.md now answers the rule: GitHub is not asked again.
		const asked = s.fake.execCalls.length;
		expect(await s.stop()).toBeUndefined();
		expect(s.fake.execCalls.length).toBe(asked);
		expect(fs.readFileSync(s.stuck, "utf8")).toBe(text);
	});

	test("the budget line says why a repository could not be confirmed", async () => {
		const s = session({ prs: { "acme/api#feat/api": "fails", "blinxsolutions/paco24#feat/paco": OPEN } });
		for (let n = 0; n < STOP_BUDGET; n++) await s.stop();
		expect(await s.stop()).toBeUndefined();
		expect(fs.readFileSync(s.stuck, "utf8")).toMatch(/^stop budget spent: .* acme\/api \(feat\/api\) \[.*HTTP 404: Not Found\]\.\n$/);
	});

	test("a new main session or a session switch starts the count over; a subagent starting does not", async () => {
		for (const event of ["session_start", "session_switch"] as const) {
			resetHome();
			const s = session();
			for (let n = 0; n < STOP_BUDGET; n++) await s.stop();

			s.start(event, "sub");
			expect(await s.stop()).toBeUndefined();
			fs.rmSync(s.stuck);

			s.start(event, "main");
			const verdict = await s.stop();
			expect(verdict?.decision).toBe("block");
			expect(verdict?.reason).toContain(`stop 1 of ${STOP_BUDGET}`);
		}
	});

	test("a subagent's stop is never refused", async () => {
		const s = session();
		expect(await s.stop("sub")).toBeUndefined();
		expect(s.fake.execCalls).toEqual([]);
	});

	test("finds the plan, and the stuck.md beside it, in another knowledge base when the one serving the folder does not hold it", async () => {
		const s = session({ plan: null });
		const other = seedKb({ name: "other-kb", folder: path.join(HOME, "personal") });
		seedState({ kb: { status: "done", sources: [s.kb.source, other.source] } });
		const otherDir = path.join(other.root, "projects", STORY);
		writeFiles(otherDir, { "plan.md": planText([API]) });

		const verdict = await s.stop();
		expect(verdict?.decision).toBe("block");
		expect(verdict?.reason).toContain(path.join(otherDir, "stuck.md"));
		expect(s.fake.execCalls.map(call => call.args[3])).toEqual(["acme/api"]);
		expect(fs.existsSync(s.dir)).toBe(false);
	});

	test("without a knowledge base, or for a story id that is not a plain folder name, there is nothing to check", async () => {
		const bare = session();
		seedState({});
		expect(await bare.stop()).toBeUndefined();
		expect(bare.fake.execCalls).toEqual([]);

		const escaping = session({ story: "../elsewhere", plan: null });
		expect(await escaping.stop()).toBeUndefined();
		expect(escaping.fake.execCalls).toEqual([]);
		expect(fs.existsSync(path.join(escaping.kb.root, "elsewhere"))).toBe(false);
	});
});

describe("a plan that cannot be read", () => {
	const cases: [string, string | null][] = [
		["is missing", null],
		["has no frontmatter", "## Goal\nShip it.\n"],
		["has frontmatter that is not YAML", "---\nrepos: [a\n---\n## Goal\n"],
		["lists no repos", `---\nstory: ${STORY}\nlanes: [backend]\n---\n## Goal\n`],
		["lists a repo without a branch", "---\nrepos:\n  - { repo: acme/api }\n---\n"],
		["names a repo that is not owner/name", "---\nrepos:\n  - { repo: api, branch: feat/api }\n---\n"],
	];
	for (const [name, plan] of cases) {
		test(`a plan that ${name} lets the stop through and stuck.md says so`, async () => {
			const s = session({ plan });
			expect(await s.stop()).toBeUndefined();
			expect(fs.readFileSync(s.stuck, "utf8")).toMatch(/^plan unreadable: .*\n$/);
			expect(s.fake.execCalls).toEqual([]);
		});
	}
});
