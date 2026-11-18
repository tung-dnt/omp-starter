import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import leadExtension from "./lead";
import leadGates from "./lead-gates";
import { lead } from "./lib/lead/registry";
import { HARD_GATES_TEMPLATE } from "./lib/lead/templates";
import { collectEdges, renderFiles } from "../scripts/arch-graph";
import { HOME } from "./lib/state";
import { fakeContext, fakePi, initGitRepo, resetHome, runExtensionChild, scriptedUi, seedKb, seedState, type UiScript, writeFiles } from "./test-harness";

beforeEach(resetHome);

const NOTIFY_CMD = process.env.OMP_STARTER_NOTIFY_CMD;
afterEach(() => {
	process.env.OMP_STARTER_NOTIFY_CMD = NOTIFY_CMD;
});

const GATES = HARD_GATES_TEMPLATE.replace("category: patient-data, paths: []", 'category: patient-data, paths: ["**/models/patient*.ts"]');

interface Verdict {
	block: boolean;
	reason: string;
}

/** A knowledge base serving ~/work with `gatesText` as its hard-gates.md (null: no file) and a repo at ~/work/shop. */
function setup(gatesText: string | null = GATES) {
	const folder = path.join(HOME, "work");
	const kb = seedKb({ name: "kb", folder });
	seedState({ kb: { status: "done", sources: [kb.source] } });
	const leadDir = path.join(kb.root, "lead");
	fs.mkdirSync(leadDir, { recursive: true });
	if (gatesText !== null) fs.writeFileSync(path.join(leadDir, "hard-gates.md"), gatesText);
	const repo = path.join(folder, "shop");
	initGitRepo(repo);
	const gates = fakePi();
	leadGates(gates.pi);
	const tool = fakePi();
	leadExtension(tool.pi);
	const main = (script: UiScript = {}) => {
		const ui = scriptedUi(script);
		return { ui, ctx: fakeContext({ cwd: repo, ui }) };
	};
	const sub = fakeContext({ cwd: repo, hasUI: false, agent: { kind: "sub", name: "task-builder" } });
	const call = (toolName: string, input: Record<string, unknown>, ctx: object) => gates.emit("tool_call", { toolName, input }, ctx) as Promise<Verdict | undefined>;
	return { leadDir, repo, tool, main, sub, call };
}

const MIGRATION = "db/migrations/002.sql";

describe("a write to a gated path in the main session", () => {
	test("asks the lead once; an approval lasts for the session", async () => {
		const s = setup();
		const { ui, ctx } = s.main({ select: ["Approve for this session"] });
		expect(await s.call("write", { path: MIGRATION }, ctx)).toBeUndefined();
		expect(ui.prompts).toEqual([{ kind: "select", title: "HARD GATE · schema · shop/db/migrations/002.sql (gate migrations)", detail: ["Approve for this session", "Reject"] }]);
		expect(await s.call("edit", { input: `[${MIGRATION}#AB12]\nPUT 1.=1:\n+SELECT 2` }, ctx)).toBeUndefined();
		expect(ui.prompts).toHaveLength(1);
	});

	test("a rejection blocks, and keeps blocking without asking again", async () => {
		const s = setup();
		const { ui, ctx } = s.main({ select: ["Reject"] });
		const reason = "HARD GATE migrations (schema): shop/db/migrations/002.sql was rejected by the lead.";
		expect(await s.call("write", { path: MIGRATION }, ctx)).toEqual({ block: true, reason });
		expect(await s.call("write", { path: MIGRATION }, ctx)).toEqual({ block: true, reason });
		expect(ui.prompts).toHaveLength(1);
	});

	test("a dismissed dialog blocks and decides nothing", async () => {
		const s = setup();
		const { ui, ctx } = s.main({ select: [undefined, "Approve for this session"] });
		expect((await s.call("write", { path: MIGRATION }, ctx))?.reason).toBe("HARD GATE migrations: not approved (dialog dismissed); retry to ask again.");
		expect(lead().sessionApprovals.size).toBe(0);
		expect(await s.call("write", { path: MIGRATION }, ctx)).toBeUndefined();
		expect(ui.prompts).toHaveLength(2);
	});

	test("ungated paths and gates scoped to another repository pass without a prompt", async () => {
		const s = setup(GATES.replace("{ id: migrations, category: schema,", "{ id: migrations, category: schema, repos: [other],"));
		const { ui, ctx } = s.main();
		expect(await s.call("write", { path: "src/index.ts" }, ctx)).toBeUndefined();
		expect(await s.call("write", { path: "db/migrations/003.ts" }, ctx)).toBeUndefined();
		expect(ui.prompts).toEqual([]);
	});
});

describe("a subagent hitting a gate", () => {
	test("is blocked with a report line, and passes after the lead approves through the lead tool", async () => {
		const s = setup();
		const blocked = await s.call("write", { path: MIGRATION }, s.sub);
		expect(blocked?.block).toBe(true);
		expect(blocked?.reason).toContain('report "blocked: hard gate migrations shop/db/migrations/002.sql"');
		expect(lead().pending.size).toBe(1);

		const { ui, ctx } = s.main({ select: ["Approve"] });
		const { text } = await s.tool.callTool("lead", { op: "gate" }, ctx);
		expect(text).toBe("migrations shop/db/migrations/002.sql: approved");
		expect(ui.prompts[0].title).toBe("HARD GATE · schema · shop/db/migrations/002.sql (gate migrations, blocked task-builder)");
		expect(lead().pending.size).toBe(0);
		expect(await s.call("write", { path: MIGRATION }, s.sub)).toBeUndefined();
	});

	test("in an async story the main session is not asked either: the write is queued, the lead told once, and decided later in one sitting", async () => {
		const s = setup();
		lead().story = { id: "S1", dir: path.join(s.leadDir, "stories", "S1"), leadDir: s.leadDir, mode: "async", invariants: [] };
		const { ui, ctx } = s.main({ select: ["Approve"] });
		const queued = await s.call("write", { path: MIGRATION }, ctx);
		expect(queued?.reason).toStartWith("HARD GATE migrations (schema): shop/db/migrations/002.sql needs the lead's approval and is queued. Leave this path");
		await s.call("write", { path: MIGRATION }, ctx);
		expect(ui.prompts).toEqual([]);
		expect(ui.notifications).toEqual([{ type: "warning", message: "omp lead · S1 · gate migrations (schema) · shop/db/migrations/002.sql" }]);
		expect((await s.call("write", { path: MIGRATION }, s.sub))?.reason).toEndWith("The gate is queued for the lead, who is away.");

		expect((await s.tool.callTool("lead", { op: "gate" }, ctx)).text).toBe("migrations shop/db/migrations/002.sql: approved");
		expect(await s.call("write", { path: MIGRATION }, ctx)).toBeUndefined();
	});

	test("`Decide later` leaves the gate pending and the subagent blocked", async () => {
		const s = setup();
		await s.call("write", { path: MIGRATION }, s.sub);
		const { text } = await s.tool.callTool("lead", { op: "gate" }, s.main({ select: ["Decide later"] }).ctx);
		expect(text).toEndWith("pending");
		expect((await s.call("write", { path: MIGRATION }, s.sub))?.block).toBe(true);
	});

	test("notifies the lead outside the session with metadata only", async () => {
		const s = setup();
		const out = path.join(HOME, "n.txt");
		process.env.OMP_STARTER_NOTIFY_CMD = `printf "%s" "$OMP_STARTER_NOTIFY_TEXT" > ${out}`;
		await s.call("write", { path: MIGRATION, content: "SECRET" }, s.sub);
		// The notification is a detached shell command with no handle to await; poll for its file for up to 10 s (a loaded full-suite run needs more than 2 s).
		for (let i = 0; i < 200 && !(fs.existsSync(out) && fs.statSync(out).size); i++) await Bun.sleep(50);
		expect(fs.readFileSync(out, "utf8")).toBe("omp lead · session · gate migrations (schema) · shop/db/migrations/002.sql");
	});

	test("the lead tool refuses subagents, and has nothing to ask when no gate is pending", async () => {
		const s = setup();
		await expect(s.tool.callTool("lead", { op: "gate" }, s.sub)).rejects.toThrow("only the main session");
		expect((await s.tool.callTool("lead", { op: "gate" }, s.main().ctx)).text).toBe("no pending gates");
	});
});

describe("commit, push and PR", () => {
	test("a commit carrying a gated file asks for that gate", async () => {
		const s = setup();
		writeFiles(s.repo, { "package.json": "{}", "src/a.ts": "" });
		execFileSync("git", ["add", "package.json"], { cwd: s.repo });
		const { ui, ctx } = s.main({ select: ["Reject"] });
		expect((await s.call("bash", { command: "git commit -m x" }, ctx))?.reason).toContain("HARD GATE dependencies (dependency): shop/package.json");
		expect(ui.prompts[0].title).toBe("HARD GATE · dependency · shop/package.json (gate dependencies)");
	});

	test("a commit of ungated files and a non-publishing command pass", async () => {
		const s = setup();
		writeFiles(s.repo, { "package.json": "{}", "src/a.ts": "" });
		execFileSync("git", ["add", "src/a.ts"], { cwd: s.repo });
		const { ui, ctx } = s.main();
		expect(await s.call("bash", { command: "git commit -m x" }, ctx)).toBeUndefined();
		expect(await s.call("bash", { command: "cat package.json" }, ctx)).toBeUndefined();
		expect(ui.prompts).toEqual([]);
	});

	test("a push checks every changed file of the branch, from the folder `git -C` names", async () => {
		const s = setup();
		writeFiles(s.repo, { "services/auth/login.ts": "" });
		const { ui, ctx } = s.main({ select: ["Reject"] });
		const verdict = await s.call("bash", { command: `git -C ${s.repo} push origin HEAD`, cwd: HOME }, ctx);
		expect(verdict?.reason).toContain("HARD GATE auth (auth): shop/services/auth/login.ts");
		expect(ui.prompts).toHaveLength(1);
	});
});

describe("the lead's own files", () => {
	test("cannot be written by an agent, even before hard-gates.md exists; the plan can", async () => {
		const s = setup(null);
		const { ctx } = s.main();
		const verdict = await s.call("write", { path: path.join(s.leadDir, "hard-gates.md") }, ctx);
		expect(verdict).toEqual({ block: true, reason: "lead: ~/kb/lead/hard-gates.md is owned by the lead; propose the change in chat or in the PR body instead." });
		expect((await s.call("edit", { input: `[${path.join(s.leadDir, "stories/S1/brief.md")}#AB12]\nPUT 1.=1:\n+x` }, ctx))?.block).toBe(true);
		expect(await s.call("write", { path: path.join(s.leadDir, "stories/S1/plan.md") }, ctx)).toBeUndefined();
	});
});

describe("an unreadable hard-gates.md", () => {
	test("with no earlier good copy fails closed for repository writes and publishing, not for reads", async () => {
		const s = setup("```yaml\ngates: nope\n```\n");
		const { ctx } = s.main();
		expect((await s.call("write", { path: "src/a.ts" }, ctx))?.reason).toContain("gates fail closed");
		expect((await s.call("bash", { command: "git push" }, ctx))?.reason).toContain("gates fail closed");
		expect(await s.call("bash", { command: "ls" }, ctx)).toBeUndefined();
	});

	test("with an earlier good copy keeps the old gates and tells the lead once", async () => {
		const s = setup();
		const { ui, ctx } = s.main({ select: ["Reject"] });
		await s.call("write", { path: "src/a.ts" }, ctx);
		fs.writeFileSync(path.join(s.leadDir, "hard-gates.md"), "```yaml\ngates: nope\n```\n");
		expect((await s.call("write", { path: MIGRATION }, ctx))?.reason).toContain("was rejected by the lead");
		await s.call("write", { path: "src/a.ts" }, ctx);
		expect(ui.notifications.filter(n => n.message.includes("using last good copy"))).toHaveLength(1);
	});
});

describe("OMP_STARTER_LEAD=off", () => {
	test("registers nothing", async () => {
		for (const file of ["lead-gates.ts", "lead.ts"]) {
			const registered = await runExtensionChild({
				extension: path.join(import.meta.dir, file),
				env: { OMP_STARTER_LEAD: "off" },
				body: "console.log(JSON.stringify({ handlers: fake.handlers.size, tools: fake.tools.size }));",
			});
			expect(registered).toEqual({ handlers: 0, tools: 0 });
		}
	});
});

describe("docs/arch at commit time", () => {
	// Real dependency-cruiser run (installed on first use, needs the network once).
	const OWNER = { name: "api", path: "", calls: [], ownsTables: ["orders"] };

	async function archRepo(source: string, fresh: boolean) {
		const s = setup();
		writeFiles(s.leadDir, { "system-map.md": "```yaml\nservices:\n  - { name: api, repo: shop, path: \"\", owns_tables: [orders] }\n```\n" });
		writeFiles(s.repo, { "src/a.ts": source, "docs/arch/services.json": `${JSON.stringify([OWNER])}\n` });
		if (fresh) {
			const edges = await collectEdges(s.repo, [OWNER]);
			for (const [name, content] of Object.entries(renderFiles(edges, [OWNER]))) writeFiles(path.join(s.repo, "docs/arch"), { [name]: content });
		}
		execFileSync("git", ["add", "src/a.ts"], { cwd: s.repo });
		return s;
	}

	test("a stale docs/arch blocks the commit with the command that regenerates it", async () => {
		const s = await archRepo("export const a = 1;\ndb.insertInto('orders');\n", false);
		const verdict = await s.call("bash", { command: "git commit -m x" }, s.main().ctx);
		expect(verdict?.reason).toStartWith("lead: docs/arch is stale; run bun ");
		expect(verdict?.reason).toContain("arch-graph.ts generate");
	}, 120_000);

	test("a fresh docs/arch passes; a write to a table the service does not own goes to the lead as gate `structure`", async () => {
		const ok = await archRepo("export const a = 1;\ndb.insertInto('orders');\n", true);
		expect(await ok.call("bash", { command: "git commit -m x" }, ok.main().ctx)).toBeUndefined();

		resetHome();
		const bad = await archRepo("export const a = 1;\ndb.insertInto('payments');\n", true);
		const { ui, ctx } = bad.main({ select: ["Reject"] });
		const verdict = await bad.call("bash", { command: "git commit -m x" }, ctx);
		expect(verdict?.reason).toContain("HARD GATE structure (structure): shop/api writes table payments it does not own was rejected by the lead.");
		expect(ui.prompts[0].title).toBe("HARD GATE · structure · shop/api writes table payments it does not own (gate structure)");
	}, 120_000);
});
