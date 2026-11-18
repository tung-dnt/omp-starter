import { beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import leadExtension from "./lead";
import { readStoryState } from "./lib/lead/artifacts";
import { lead } from "./lib/lead/registry";
import { BRIEF_TEMPLATE, HARD_GATES_TEMPLATE, SYSTEM_MAP_TEMPLATE } from "./lib/lead/templates";
import { HOME } from "./lib/state";
import { type FakeExec, type FakePi, fakeContext, fakePi, initGitRepo, resetHome, scriptedUi, seedKb, seedState, type UiScript, writeFiles } from "./test-harness";

beforeEach(resetHome);

const BRIEF = BRIEF_TEMPLATE.replace("- I1: …", "- I1: inserts are idempotent on id").replace(/^(## (?!Invariants).+)$/gm, "$1\none line");

interface Verdict {
	block: boolean;
	reason: string;
}

/** A knowledge base serving ~/work with `files` under its lead folder (null: no lead folder), and repos ~/work/shop and ~/work/other. */
function setup(files: Record<string, string> | null = { "hard-gates.md": HARD_GATES_TEMPLATE, "system-map.md": SYSTEM_MAP_TEMPLATE, "stories/S1/brief.md": BRIEF }, exec?: FakeExec) {
	const folder = path.join(HOME, "work");
	const kb = seedKb({ name: "kb", folder });
	seedState({ kb: { status: "done", sources: [kb.source] } });
	const leadDir = path.join(kb.root, "lead");
	if (files) writeFiles(leadDir, files);
	const storyDir = path.join(leadDir, "stories", "S1");
	const shop = path.join(folder, "shop");
	const other = path.join(folder, "other");
	initGitRepo(shop);
	initGitRepo(other);
	const fake = fakePi(exec);
	leadExtension(fake.pi);
	const main = (script: UiScript = {}) => {
		const ui = scriptedUi(script);
		return { ui, ctx: fakeContext({ cwd: shop, ui }) };
	};
	const sub = (name: string) => fakeContext({ cwd: shop, hasUI: false, agent: { kind: "sub", name } });
	const input = (text: string, ctx: object) => fake.emit("input", { type: "input", text, source: "interactive" }, ctx) as { handled: boolean } | undefined;
	const call = (toolName: string, toolInput: Record<string, unknown>, ctx: object) => fake.emit("tool_call", { toolName, input: toolInput }, ctx) as Verdict | undefined;
	const writePlan = (summary = "Goal: add orders\nI1: unique index on id", tasks = "- T1: add the table") =>
		writeFiles(storyDir, { "plan.md": `---\nrepos:\n  - ${shop}\n---\n\n## Summary\n${summary}\n\n## Tasks\n${tasks}\n` });
	return { fake, leadDir, storyDir, shop, other, main, sub, input, call, writePlan };
}

/** `/story S1`, a plan, and the lead's yes. */
async function approvedStory(exec?: FakeExec) {
	const s = setup(undefined, exec);
	s.input("/story S1", s.main().ctx);
	s.writePlan();
	await s.fake.callTool("lead", { op: "approve" }, s.main({ confirm: [true] }).ctx);
	return s;
}

describe("/story", () => {
	test("is refused without a brief, naming the template; nothing is checked before /starter lead", () => {
		const s = setup({ "system-map.md": SYSTEM_MAP_TEMPLATE });
		const { ui, ctx } = s.main();
		expect(s.input("/story S1", ctx)).toEqual({ handled: true });
		expect(ui.notifications).toEqual([
			{
				type: "error",
				message: "lead: no lead brief at ~/kb/lead/stories/S1/brief.md. Copy ~/kb/lead/brief-template.md there and fill it in; planning does not start without it.",
			},
		]);
		expect(lead().story).toBeUndefined();

		resetHome();
		const bare = setup(null);
		expect(bare.input("/story S1", bare.main().ctx)).toBeUndefined();
	});

	test("is refused without an id, with an incomplete brief, or without a system map", () => {
		const s = setup({ "stories/S1/brief.md": BRIEF_TEMPLATE, "stories/S2/brief.md": BRIEF });
		const { ui, ctx } = s.main();
		expect(s.input("/story", ctx)).toEqual({ handled: true });
		expect(s.input("/story S1", ctx)).toEqual({ handled: true });
		expect(s.input("/story S2", ctx)).toEqual({ handled: true });
		expect(ui.notifications.map(n => n.message)).toEqual([
			"lead: usage: /story <id>, where lead/stories/<id>/brief.md is your brief",
			expect.stringContaining('brief: missing or empty section "## Goal"; brief: missing or empty section "## Success criteria"'),
			"lead: system map missing: ~/kb/lead/system-map.md (run /starter lead). The system map comes before any repo work; fill it in and rerun /story S2.",
		]);
	});

	test("with a brief and a map makes the story active, also when invoked through the plugin namespace", () => {
		const s = setup();
		expect(s.input("/story S1", s.main().ctx)).toBeUndefined();
		expect(lead().story).toMatchObject({ id: "S1", mode: "sync", invariants: [{ id: "I1", text: "inserts are idempotent on id" }] });

		lead().story = undefined;
		expect(s.input("/agent-skills:story S1", s.main().ctx)).toBeUndefined();
		expect(lead().story?.id).toBe("S1");
	});

	test("other commands and subagent input are left alone", () => {
		const s = setup({});
		expect(s.input("/storybook S1", s.main().ctx)).toBeUndefined();
		expect(s.input("fix the /story command", s.main().ctx)).toBeUndefined();
		expect(s.input("/story", s.sub("task"))).toBeUndefined();
	});
});

describe("context injection", () => {
	const start = (fake: FakePi, ctx: object, systemPrompt = ["base"]) =>
		fake.emit("before_agent_start", { type: "before_agent_start", reason: "prompt", prompt: "", systemPrompt }, ctx) as { systemPrompt: string[] } | undefined;

	test("the main session and building subagents get the story block; scouts do not; it is added once", () => {
		const s = setup();
		expect(start(s.fake, s.main().ctx)).toBeUndefined();
		s.input("/story S1", s.main().ctx);

		const block = start(s.fake, s.main().ctx)!.systemPrompt[1];
		expect(block).toStartWith("# Lead story S1 (sync mode)\n\nPlan: NOT approved: repository edits are blocked");
		expect(block).toContain(`Plan file: ${s.storyDir}/plan.md\nRepos in plan: none yet\nPR body format: ${s.leadDir}/pr-format.md`);
		expect(block).toContain("- I1: inserts are idempotent on id");
		expect(block).toContain("name: example-api");
		expect(block).toContain("migrations · schema · **/migrations/**, **/*.sql\n");
		expect(block).toContain("patient-data · patient-data · (no paths)");

		expect(start(s.fake, s.sub("task-builder"))!.systemPrompt[1]).toStartWith("# Lead story S1");
		expect(start(s.fake, s.sub("scout"))).toBeUndefined();
		expect(start(s.fake, s.main().ctx, ["base", block])).toBeUndefined();
	});
});

describe("the single plan approval", () => {
	test("before it, repository edits and /build are refused; the plan file can be written", () => {
		const s = setup();
		const { ui, ctx } = s.main();
		s.input("/story S1", ctx);
		expect(s.call("write", { path: "src/a.ts" }, ctx)).toEqual({
			block: true,
			reason: `lead: the plan for S1 is not approved yet; write ${s.storyDir}/plan.md and call the lead tool with op "approve".`,
		});
		expect(s.call("read", { path: "src/a.ts" }, ctx)).toBeUndefined();
		expect(s.call("write", { path: path.join(s.storyDir, "plan.md") }, ctx)).toBeUndefined();
		expect(s.input("/build S1", ctx)).toEqual({ handled: true });
		expect(ui.notifications.at(-1)?.message).toBe("lead: the plan for S1 is not approved; run /story S1.");
	});

	test("shows the summary and repos to the lead; a yes unblocks edits and /build, and fences other repositories", async () => {
		const s = setup();
		s.input("/story S1", s.main().ctx);
		s.writePlan();
		const { ui, ctx } = s.main({ confirm: [true] });
		expect((await s.fake.callTool("lead", { op: "approve" }, ctx)).text).toBe("plan approved; building may start (/build S1)");
		expect(ui.prompts).toEqual([{ kind: "confirm", title: "Approve plan for S1?", detail: `Goal: add orders\nI1: unique index on id\n\nRepos: ${s.shop}` }]);
		expect(readStoryState(s.storyDir).plan?.digest).toMatch(/^[0-9a-f]{64}$/);

		expect(s.call("write", { path: "src/a.ts" }, ctx)).toBeUndefined();
		expect(s.input("/build", ctx)).toBeUndefined();
		expect(s.call("read", { path: path.join(s.other, "src/b.ts") }, ctx)).toEqual({
			block: true,
			reason: "lead fence: other is not in the plan's repos (shop). If the work needs it, stop and report the gap to the lead.",
		});
		expect(s.call("bash", { command: `rg -n foo ${s.other}/src` }, s.sub("task-builder"))?.reason).toContain("lead fence: other");
		expect(s.call("read", { path: path.join(s.other, "node_modules/x/index.js") }, ctx)).toBeUndefined();
		expect(s.call("read", { path: path.join(HOME, "notes.md") }, ctx)).toBeUndefined();
	});

	test("a no records nothing", async () => {
		const s = setup();
		s.input("/story S1", s.main().ctx);
		s.writePlan();
		expect((await s.fake.callTool("lead", { op: "approve" }, s.main({ confirm: [false] }).ctx)).text).toBe("plan NOT approved; revise it with the lead and call approve again");
		expect(readStoryState(s.storyDir).plan).toBeNull();
	});

	test("the agent may replace the plan's summary and tasks; a new repo or a changed brief invariant needs approval again, told once", async () => {
		const s = await approvedStory();
		const { ui, ctx } = s.main();
		s.writePlan("Goal: add orders and refunds\nI1: a row lock instead of the index", "- T1: add the table\n- T2: backfill");
		expect(s.call("write", { path: "src/a.ts" }, ctx)).toBeUndefined();
		expect(ui.notifications).toEqual([]);

		writeFiles(s.storyDir, { "plan.md": `---\nrepos:\n  - ${s.shop}\n  - ${s.other}\n---\n\n## Summary\nGoal: add orders\nI1: unique index on id\n` });
		const changed = 'lead: the plan\'s repos, or the brief\'s invariants or boundaries, changed since the lead approved S1; call the lead tool with op "approve" again.';
		expect(s.call("write", { path: "src/a.ts" }, ctx)).toEqual({ block: true, reason: changed });
		expect(s.call("write", { path: "src/a.ts" }, ctx)?.block).toBe(true);
		expect(ui.notifications).toEqual([{ type: "warning", message: "lead: the plan's repos or the brief's invariants or boundaries changed after approval; edits are blocked until the lead approves again." }]);

		s.writePlan();
		expect(s.call("write", { path: "src/a.ts" }, ctx)).toBeUndefined();
		writeFiles(s.storyDir, { "brief.md": BRIEF.replace("inserts are idempotent on id", "inserts are idempotent on id and tenant") });
		expect(s.call("write", { path: "src/a.ts" }, ctx)).toEqual({ block: true, reason: changed });
	});

	test("an approved plan that becomes unreadable blocks edits and says what is wrong", async () => {
		const s = await approvedStory();
		s.writePlan(Array.from({ length: 16 }, (_, i) => `line ${i + 1}`).join("\n"));
		expect(s.call("write", { path: "src/a.ts" }, s.main().ctx)?.reason).toEndWith('call the lead tool with op "approve". Problems: Summary: 16 lines; keep it to 15.');
	});

	test("is refused for a plan that drops an invariant, for a subagent, and without an active story", async () => {
		const s = setup();
		const { ctx } = s.main();
		await expect(s.fake.callTool("lead", { op: "approve" }, ctx)).rejects.toThrow("lead: no active story; the lead starts one with /story <id>");
		s.input("/story S1", ctx);
		s.writePlan("Goal: add orders");
		await expect(s.fake.callTool("lead", { op: "approve" }, ctx)).rejects.toThrow("lead: plan does not mention invariant(s) I1");
		await expect(s.fake.callTool("lead", { op: "approve" }, s.sub("task-builder"))).rejects.toThrow("only the main session");
	});
});

describe("/build", () => {
	test("needs a story, and can start one by id in a new session once its plan is approved", async () => {
		const s = await approvedStory();
		lead().story = undefined;
		const { ui, ctx } = s.main();
		expect(s.input("/build", ctx)).toEqual({ handled: true });
		expect(s.input("/build S9", ctx)).toEqual({ handled: true });
		expect(ui.notifications.map(n => n.message)).toEqual([
			"lead: /build needs a story id",
			"lead: no story S9; write its brief and run /story S9, or use /task for a small change.",
		]);
		expect(s.input("/build S1", ctx)).toBeUndefined();
		expect(lead().story?.id).toBe("S1");
	});
});

describe("status", () => {
	const github =
		(prs: string, code = 0, stderr = ""): FakeExec =>
		(command, args) =>
			command === "git" && args.includes("rev-parse") ? { stdout: "feat/x\n" } : command === "gh" ? { stdout: prs, stderr, code } : undefined!;

	test("every plan repo merged: writes status.md as done and ends the story", async () => {
		const s = await approvedStory(github('[{"url":"https://github.com/acme/shop/pull/7","state":"MERGED"}]'));
		const { text } = await s.fake.callTool("lead", { op: "status" }, s.main().ctx);
		expect(text).toBe("status: done\nhttps://github.com/acme/shop/pull/7");
		expect(fs.readFileSync(path.join(s.storyDir, "status.md"), "utf8")).toBe(
			"---\nstatus: done\nprs:\n  - https://github.com/acme/shop/pull/7\n---\n\n# S1 status\n\n- shop (feat/x): MERGED https://github.com/acme/shop/pull/7\n",
		);
		expect(readStoryState(s.storyDir).status?.value).toBe("done");
		expect(lead().story).toBeUndefined();
		expect(s.fake.execCalls.at(-1)).toEqual({ command: "gh", args: ["pr", "list", "--head", "feat/x", "--state", "all", "--json", "url,state", "--limit", "1"] });
	});

	test("an open pull request is in review; none is in progress", async () => {
		const open = await approvedStory(github('[{"url":"u","state":"OPEN"}]'));
		expect((await open.fake.callTool("lead", { op: "status" }, open.main().ctx)).text).toBe("status: in-review\nu");
		expect(lead().story?.id).toBe("S1");

		resetHome();
		const none = await approvedStory(github("[]"));
		expect((await none.fake.callTool("lead", { op: "status" }, none.main().ctx)).text).toBe("status: in-progress");
	});

	test("a failing gh reports its first error line and writes nothing", async () => {
		const s = await approvedStory(github("", 1, "gh: not logged in\nrun gh auth login"));
		await expect(s.fake.callTool("lead", { op: "status" }, s.main().ctx)).rejects.toThrow("lead: gh failed: gh: not logged in");
		expect(fs.existsSync(path.join(s.storyDir, "status.md"))).toBe(false);
		expect(readStoryState(s.storyDir).status).toBeNull();
	});
});

describe("builders", () => {
	const spawn = (fake: FakePi, agent: string, ctx: object) =>
		fake.emit("before_subagent_spawn", { type: "before_subagent_spawn", agent, invocationKind: "task", patterns: [] }, ctx) as Verdict | undefined;

	test("are capped at limits.builders while a story is active; scouts are not counted or capped", () => {
		const s = setup({ "hard-gates.md": HARD_GATES_TEMPLATE.replace("builders: 2", "builders: 1"), "system-map.md": SYSTEM_MAP_TEMPLATE, "stories/S1/brief.md": BRIEF });
		const { ctx } = s.main();
		const builder = fakeContext({ cwd: s.shop, hasUI: false, agent: { kind: "sub", id: "a1", name: "task-builder" } });
		s.fake.emit("agent_start", { type: "agent_start" }, builder);
		expect(spawn(s.fake, "task-builder", ctx)).toBeUndefined();

		s.input("/story S1", ctx);
		expect(spawn(s.fake, "task-builder", ctx)).toEqual({ block: true, reason: "lead: 1 builders already running (limits.builders = 1 in hard-gates.md); wait for one to finish." });
		expect(spawn(s.fake, "scout", ctx)).toBeUndefined();

		s.fake.emit("agent_end", { type: "agent_end", messages: [] }, builder);
		expect(spawn(s.fake, "task-builder", ctx)).toBeUndefined();
	});
});

describe("async mode", () => {
	test("tells the lead when the main session stops, not when a subagent or a continuing turn ends", () => {
		const s = setup({ "system-map.md": SYSTEM_MAP_TEMPLATE, "stories/S1/brief.md": BRIEF.replace("mode: sync", "mode: async") });
		const { ui, ctx } = s.main();
		s.input("/story S1", ctx);
		s.fake.emit("agent_end", { type: "agent_end", messages: [] }, s.sub("task-builder"));
		s.fake.emit("agent_end", { type: "agent_end", messages: [], willContinue: true }, ctx);
		expect(ui.notifications).toEqual([]);
		s.fake.emit("agent_end", { type: "agent_end", messages: [] }, ctx);
		expect(ui.notifications).toEqual([{ type: "warning", message: "omp lead · S1 · agent stopped: review or approve" }]);
	});
});

describe("retro", () => {
	const RETRO = { op: "retro", story: "S1", summary: "duplicate orders on retry", artifact: "lead/stories/S1/brief.md" };

	test("appends one line with the cause the lead picked, creating the log on first use", async () => {
		const s = setup();
		const log = path.join(s.leadDir, "retro-log.md");
		const today = new Date().toLocaleDateString("en-CA");
		const { ui, ctx } = s.main({ select: ["missing invariant", "missing test"] });
		const line = `- ${today} · missing invariant · S1 · duplicate orders on retry · fixed: lead/stories/S1/brief.md`;
		expect((await s.fake.callTool("lead", RETRO, ctx)).text).toBe(line);
		expect(ui.prompts[0].title).toBe("Escaped bug in S1: duplicate orders on retry. Cause?");
		expect(fs.readFileSync(log, "utf8")).toBe(`# Retro log\n\n${line}\n`);

		await s.fake.callTool("lead", { ...RETRO, story: "PR 12" }, ctx);
		expect(fs.readFileSync(log, "utf8")).toBe(`# Retro log\n\n${line}\n- ${today} · missing test · PR 12 · duplicate orders on retry · fixed: lead/stories/S1/brief.md\n`);
	});

	test("a dismissed dialog records nothing; a blank field is refused before asking", async () => {
		const s = setup();
		const { ui, ctx } = s.main({ select: [undefined] });
		expect((await s.fake.callTool("lead", RETRO, ctx)).text).toBe("retro not recorded");
		expect(fs.existsSync(path.join(s.leadDir, "retro-log.md"))).toBe(false);
		await expect(s.fake.callTool("lead", { ...RETRO, summary: "  " }, ctx)).rejects.toThrow("lead: retro needs story, summary and artifact");
		expect(ui.prompts).toHaveLength(1);
	});
});
