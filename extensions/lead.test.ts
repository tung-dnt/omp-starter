import { beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import leadExtension from "./lead";
import { readStoryState, today } from "./lib/lead/artifacts";
import { lead } from "./lib/lead/registry";
import { BRIEF_TEMPLATE, HARD_GATES_TEMPLATE, PR_FORMAT, PROJECT_NOTE_BLOCK } from "./lib/lead/templates";
import { HOME } from "./lib/state";
import { type FakeExec, type FakePi, fakeContext, fakePi, initGitRepo, resetHome, scriptedUi, seedKb, seedState, type UiScript, writeFiles } from "./test-harness";

beforeEach(resetHome);

const BRIEF = BRIEF_TEMPLATE.replace("mode: async", "mode: sync")
	.replace("- I1: …", "- I1: inserts are idempotent on id")
	.replace(/^(## (?!Invariants).+)$/gm, "$1\none line");

/** hard-gates.md with the check commands of shop, the repository the tests plan for. */
const GATES = HARD_GATES_TEMPLATE.replace("checks: {}", 'checks:\n  shop: { verify: ["true"], test: ["true"] }');

/** The plan's proof of AC1 of BRIEF. */
const PROOF = '\n## Proof\n```yaml\nproof:\n  - { ac: AC1, repo: shop, test: { run: "sh t.sh", files: [t.sh] } }\n```\n';

interface Verdict {
	block: boolean;
	reason: string;
}

/** The knowledge base's `lead` setting that reuses folders shared with other notes. */
const SHARED = { stories: "projects", policy: "company", templates: "_templates" };

/** The project note of the shop repository: updated today, with the services block the plugin shows as its example. */
const NOTE = `---\nupdated: ${today()}\n---\n\n# shop\n\n${PROJECT_NOTE_BLOCK}\n`;

/**
 * A knowledge base serving ~/work with `files` under its lead folder (null: no lead folder) and the project note of
 * shop, and repos ~/work/shop and ~/work/other.
 * With `shared`, the knowledge base has the SHARED setting and `files` are relative to the knowledge base.
 */
function setup(files: Record<string, string> | null = { "hard-gates.md": GATES, "stories/S1/brief.md": BRIEF }, exec?: FakeExec, shared = false) {
	const folder = path.join(HOME, "work");
	const kb = seedKb({ name: "kb", folder });
	seedState({ kb: { status: "done", sources: [shared ? { ...kb.source, lead: SHARED } : kb.source] } });
	const leadDir = shared ? kb.root : path.join(kb.root, "lead");
	if (files) writeFiles(leadDir, files);
	const note = path.join(kb.root, "projects", "shop.md");
	writeFiles(kb.root, { "projects/shop.md": NOTE });
	const storyDir = shared ? path.join(kb.root, "projects", "S1") : path.join(leadDir, "stories", "S1");
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
	const input = (text: string, ctx: object) => fake.emit("input", { type: "input", text, source: "interactive" }, ctx) as Promise<{ handled: boolean } | undefined>;
	const call = (toolName: string, toolInput: Record<string, unknown>, ctx: object) => fake.emit("tool_call", { toolName, input: toolInput }, ctx) as Verdict | undefined;
	const writePlan = (summary = "Goal: add orders\nI1: unique index on id", tasks = "- T1: add the table") =>
		writeFiles(storyDir, { "plan.md": `---\nrepos:\n  - ${shop}\n---\n\n## Summary\n${summary}\n\n## Tasks\n${tasks}\n${PROOF}` });
	/** An edit of `file` as the host runs it: the call, `change` standing in for what the tool does, then the result. */
	const edit = (file: string, ctx: object, change: () => void, isError = false) => {
		const toolInput = { input: `[${file}#AB12]\nPUT 1.=1:\n+x` };
		call("edit", toolInput, ctx);
		change();
		return fake.emit("tool_result", { type: "tool_result", toolName: "edit", isError, input: toolInput }, ctx) as Promise<{ additionalContext: string } | undefined>;
	};
	return { fake, kbRoot: kb.root, leadDir, storyDir, note, shop, other, main, sub, input, call, edit, writePlan };
}

/** `/story S1`, a plan, and the lead's yes. */
async function approvedStory(exec?: FakeExec) {
	const s = setup(undefined, exec);
	await s.input("/story S1", s.main().ctx);
	s.writePlan();
	await s.fake.callTool("lead", { op: "approve" }, s.main({ confirm: [true] }).ctx);
	return s;
}

describe("/story", () => {
	test("is refused without a brief, naming the template; nothing is checked before /starter lead", async () => {
		const s = setup({ "hard-gates.md": GATES });
		const { ui, ctx } = s.main();
		expect(await s.input("/story S1", ctx)).toEqual({ handled: true });
		expect(ui.notifications).toEqual([
			{
				type: "error",
				message: "lead: no lead brief at ~/kb/lead/stories/S1/brief.md. Copy ~/kb/lead/brief-template.md there and fill it in; planning does not start without it.",
			},
		]);
		expect(lead().story).toBeUndefined();

		resetHome();
		const bare = setup(null);
		expect(await bare.input("/story S1", bare.main().ctx)).toBeUndefined();
	});

	test("is refused without an id or with an incomplete brief", async () => {
		const s = setup({ "hard-gates.md": GATES, "stories/S1/brief.md": BRIEF_TEMPLATE });
		const { ui, ctx } = s.main();
		expect(await s.input("/story", ctx)).toEqual({ handled: true });
		expect(await s.input("/story S1", ctx)).toEqual({ handled: true });
		expect(ui.notifications.map(n => n.message)).toEqual([
			"lead: usage: /story <id>, where ~/kb/lead/stories/<id>/brief.md is your brief",
			expect.stringContaining('brief: missing or empty section "## Goal"; brief: missing or empty section "## Boundaries"'),
		]);
	});

	test("with a brief makes the story active, also when invoked through the plugin namespace", async () => {
		const s = setup();
		expect(await s.input("/story S1", s.main().ctx)).toBeUndefined();
		expect(lead().story).toMatchObject({ id: "S1", mode: "sync", invariants: [{ id: "I1", text: "inserts are idempotent on id" }] });

		lead().story = undefined;
		expect(await s.input("/agent-skills:story S1", s.main().ctx)).toBeUndefined();
		expect(lead().story?.id).toBe("S1");
	});

	test("other commands and subagent input are left alone", async () => {
		const s = setup({});
		expect(await s.input("/storybook S1", s.main().ctx)).toBeUndefined();
		expect(await s.input("fix the /story command", s.main().ctx)).toBeUndefined();
		expect(await s.input("/story", s.sub("task"))).toBeUndefined();
	});
});

describe("context injection", () => {
	const start = (fake: FakePi, ctx: object, systemPrompt = ["base"]) =>
		fake.emit("before_agent_start", { type: "before_agent_start", reason: "prompt", prompt: "", systemPrompt }, ctx) as { systemPrompt: string[] } | undefined;

	test("the main session and building subagents get the story block; scouts do not; it is added once", async () => {
		const s = setup();
		expect(start(s.fake, s.main().ctx)).toBeUndefined();
		await s.input("/story S1", s.main().ctx);

		const block = start(s.fake, s.main().ctx)!.systemPrompt[1];
		expect(block).toStartWith("# Lead story S1 (sync mode)\n\nPlan: NOT approved: repository edits are blocked");
		expect(block).toContain(`Plan file: ${s.storyDir}/plan.md\nRepos in plan: none yet\nPR body format: ${s.leadDir}/pr-format.md`);
		expect(block).toContain("- I1: inserts are idempotent on id");
		expect(block).toContain(`Each repository in the plan needs ${s.kbRoot}/projects/<repo>.md with a`);
		expect(block).not.toContain("name: example-api");
		expect(block).toContain("migrations · schema · **/migrations/**, **/*.sql\n");
		expect(block).toContain("patient-data · patient-data · (no paths)");

		s.writePlan();
		const planned = start(s.fake, s.main().ctx)!.systemPrompt[1];
		expect(planned).toContain(`### shop (${s.note})\nservices:\n  - { name: example-api, path: ""`);
		expect(planned).toContain(`## Note freshness (the lead sees these lines when approving)\nshop: updated ${today()} (0 days ago), 0 unverified\n`);

		expect(start(s.fake, s.sub("task-builder"))!.systemPrompt[1]).toStartWith("# Lead story S1");
		expect(start(s.fake, s.sub("scout"))).toBeUndefined();
		expect(start(s.fake, s.main().ctx, ["base", block])).toBeUndefined();
	});
});

describe("the single plan approval", () => {
	test("before it, repository edits and /build are refused; the plan file can be written", async () => {
		const s = setup();
		const { ui, ctx } = s.main();
		await s.input("/story S1", ctx);
		expect(s.call("write", { path: "src/a.ts" }, ctx)).toEqual({
			block: true,
			reason: `lead: the plan for S1 is not approved yet; write ${s.storyDir}/plan.md and call the lead tool with op "approve".`,
		});
		expect(s.call("read", { path: "src/a.ts" }, ctx)).toBeUndefined();
		expect(s.call("write", { path: path.join(s.storyDir, "plan.md") }, ctx)).toBeUndefined();
		expect(await s.input("/build S1", ctx)).toEqual({ handled: true });
		expect(ui.notifications.at(-1)?.message).toBe("lead: the plan for S1 is not approved; run /story S1.");
	});

	test("shows the summary and repos to the lead; a yes unblocks edits and /build, and fences other repositories", async () => {
		const s = setup();
		await s.input("/story S1", s.main().ctx);
		s.writePlan();
		const { ui, ctx } = s.main({ confirm: [true] });
		expect((await s.fake.callTool("lead", { op: "approve" }, ctx)).text).toBe("plan approved; building may start (/build S1)");
		expect(ui.prompts).toEqual([
			{
				kind: "confirm",
				title: "Approve brief and plan for S1?",
				detail:
					"Goal: add orders\nI1: unique index on id\n\nAcceptance criteria and proof:\n- AC1: … → test in shop\n\n" +
					`Invariants:\n- I1: inserts are idempotent on id\n\nBoundaries:\none line\n\nRepos: ${s.shop}\n\nNotes:\n- shop: updated ${today()} (0 days ago), 0 unverified`,
			},
		]);
		expect(readStoryState(s.storyDir).plan?.digest).toMatch(/^[0-9a-f]{64}$/);

		expect(s.call("write", { path: "src/a.ts" }, ctx)).toBeUndefined();
		expect(await s.input("/build", ctx)).toBeUndefined();
		expect(s.call("read", { path: path.join(s.other, "src/b.ts") }, ctx)).toEqual({
			block: true,
			reason: "lead fence: other is not in the plan's repos (shop). If the work needs it, stop and report the gap to the lead.",
		});
		expect(s.call("bash", { command: `rg -n foo ${s.other}/src` }, s.sub("task-builder"))?.reason).toContain("lead fence: other");
		expect(s.call("read", { path: path.join(s.other, "node_modules/x/index.js") }, ctx)).toBeUndefined();
		expect(s.call("read", { path: path.join(HOME, "notes.md") }, ctx)).toBeUndefined();
	});

	test("is refused until every repository in the plan has a project note with a services block; /build is refused once one is gone", async () => {
		const s = setup();
		fs.rmSync(s.note);
		await s.input("/story S1", s.main().ctx);
		s.writePlan();
		const { ui, ctx } = s.main({ confirm: [true] });
		const approve = () => s.fake.callTool("lead", { op: "approve" }, ctx);
		await expect(approve()).rejects.toThrow(
			`lead: every repository in the plan needs a project note with a services block (project note missing: ~/kb/projects/shop.md). Add this to each note, one entry per service, and set the note's \`updated:\` date:\n${PROJECT_NOTE_BLOCK}`,
		);
		fs.writeFileSync(s.note, "# shop\n\n```yaml\nstages: [dev]\n```\n");
		await expect(approve()).rejects.toThrow("project note ~/kb/projects/shop.md: no ```yaml block with services:");
		expect(ui.prompts).toEqual([]);

		fs.writeFileSync(s.note, NOTE);
		expect((await approve()).text).toBe("plan approved; building may start (/build S1)");
		fs.rmSync(s.note);
		expect(await s.input("/build", ctx)).toEqual({ handled: true });
		expect(ui.notifications.at(-1)?.message).toBe("lead: /build needs a project note with a services block for every repository in the plan: project note missing: ~/kb/projects/shop.md.");
	});

	test("a no records nothing", async () => {
		const s = setup();
		await s.input("/story S1", s.main().ctx);
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

		writeFiles(s.storyDir, { "plan.md": `---\nrepos:\n  - ${s.shop}\n  - ${s.other}\n---\n\n## Summary\nGoal: add orders\nI1: unique index on id\n${PROOF}` });
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
		await s.input("/story S1", ctx);
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
		expect(await s.input("/build", ctx)).toEqual({ handled: true });
		expect(await s.input("/build S9", ctx)).toEqual({ handled: true });
		expect(ui.notifications.map(n => n.message)).toEqual([
			"lead: /build needs a story id",
			"lead: no story S9; write its brief and run /story S9, or use /task for a small change.",
		]);
		expect(await s.input("/build S1", ctx)).toBeUndefined();
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

	test("returning to an approved story with /build refreshes status.md and keeps the story active, even when merged", async () => {
		const s = await approvedStory(github('[{"url":"u","state":"MERGED"}]'));
		expect(fs.existsSync(path.join(s.storyDir, "status.md"))).toBe(false);
		expect(await s.input("/build S1", s.main().ctx)).toBeUndefined();
		expect(fs.readFileSync(path.join(s.storyDir, "status.md"), "utf8")).toStartWith("---\nstatus: done\n");
		expect(lead().story?.id).toBe("S1");
	});

	test("a failing gh does not hold /build back", async () => {
		const s = await approvedStory(github("", 1, "gh: not logged in"));
		expect(await s.input("/build S1", s.main().ctx)).toBeUndefined();
		expect(fs.existsSync(path.join(s.storyDir, "status.md"))).toBe(false);
	});
});

describe("builders", () => {
	const spawn = (fake: FakePi, agent: string, ctx: object) =>
		fake.emit("before_subagent_spawn", { type: "before_subagent_spawn", agent, invocationKind: "task", patterns: [] }, ctx) as Verdict | undefined;

	test("are capped at limits.builders while a story is active; scouts are not counted or capped", async () => {
		const s = setup({ "hard-gates.md": GATES.replace("builders: 2", "builders: 1"), "stories/S1/brief.md": BRIEF });
		const { ctx } = s.main();
		const builder = fakeContext({ cwd: s.shop, hasUI: false, agent: { kind: "sub", id: "a1", name: "task-builder" } });
		s.fake.emit("agent_start", { type: "agent_start" }, builder);
		expect(spawn(s.fake, "task-builder", ctx)).toBeUndefined();

		await s.input("/story S1", ctx);
		expect(spawn(s.fake, "task-builder", ctx)).toEqual({ block: true, reason: "lead: 1 builders already running (limits.builders = 1 in hard-gates.md); wait for one to finish." });
		expect(spawn(s.fake, "scout", ctx)).toBeUndefined();

		s.fake.emit("agent_end", { type: "agent_end", messages: [] }, builder);
		expect(spawn(s.fake, "task-builder", ctx)).toBeUndefined();
	});
});

describe("async mode", () => {
	test("tells the lead when the main session stops, not when a subagent or a continuing turn ends", async () => {
		const s = setup({ "hard-gates.md": GATES, "stories/S1/brief.md": BRIEF.replace("mode: sync", "mode: async") });
		const { ui, ctx } = s.main();
		await s.input("/story S1", ctx);
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

describe("project notes", () => {
	const withCalls = (calls: string) => NOTE.replace("calls: []", `calls: [${calls}]`);

	test("a change to a note's services is announced to the lead, recorded on the story and marked in the approval dialog; prose edits are not", async () => {
		const s = setup();
		const { ui, ctx } = s.main({ confirm: [true] });
		await s.input("/story S1", ctx);
		await s.edit(s.note, ctx, () => fs.appendFileSync(s.note, "\n## Gotchas\n- prose only\n"));
		await s.edit(path.join(s.storyDir, "plan.md"), ctx, () => s.writePlan());
		await s.edit(s.note, ctx, () => {}, true);
		expect(readStoryState(s.storyDir).mapEditedAt).toBeNull();
		expect(ui.notifications).toEqual([]);

		expect(await s.edit(s.note, s.sub("task-builder"), () => fs.writeFileSync(s.note, withCalls("worker")))).toBeUndefined();
		expect(readStoryState(s.storyDir).mapEditedAt).not.toBeNull();
		await s.edit(s.note, ctx, () => fs.writeFileSync(s.note, withCalls("worker, billing")));
		expect(ui.notifications).toEqual([{ type: "warning", message: "omp lead · S1 · services block of shop.md changed by main" }]);

		await s.fake.callTool("lead", { op: "approve" }, ctx);
		expect(ui.prompts[0].detail).toEndWith(`Notes:\n- shop: updated ${today()} (0 days ago), 0 unverified · services block changed in this session`);
	});

	test("a change that breaks the block is reported back to the agent at once; a note left with an old date gets a reminder", async () => {
		const s = setup();
		const { ctx } = s.main();
		const broken = await s.edit(s.note, ctx, () => fs.writeFileSync(s.note, "```yaml\nservices: nope\n```\n"));
		expect(broken?.additionalContext).toBe("[lead] project note ~/kb/projects/shop.md: services: expected a list. Fix it now: plan approval and the structural gate read it.");
		const dated = await s.edit(s.note, ctx, () => fs.writeFileSync(s.note, NOTE.replace(`updated: ${today()}`, "updated: 2026-01-01")));
		expect(dated?.additionalContext).toBe(`[lead] Set \`updated: ${today()}\` in the frontmatter of ~/kb/projects/shop.md: the lead approves plans against this note and sees its date.`);
	});

	test("nothing is announced or asked of the agent before /starter lead", async () => {
		const s = setup(null);
		const { ui, ctx } = s.main();
		expect(await s.edit(s.note, ctx, () => fs.writeFileSync(s.note, withCalls("worker").replace(today(), "2026-01-01")))).toBeUndefined();
		expect(ui.notifications).toEqual([]);
	});
});

describe("session start", () => {
	test("rewrites a pr-format.md that lags the plugin; a brief template that differs is reported once and left alone", () => {
		const s = setup({ "hard-gates.md": "the lead's gates\n", "pr-format.md": "an older format\n", "brief-template.md": "the lead's own template\n" });
		const start = () => {
			const { ui, ctx } = s.main();
			s.fake.emit("session_start", { type: "session_start" }, ctx);
			return ui.notifications.map(n => n.message);
		};
		expect(start()).toEqual(["lead: ~/kb/lead/brief-template.md differs from the template this plugin version ships; delete it and run /starter lead to take the new one, or keep yours."]);
		expect(fs.readFileSync(path.join(s.leadDir, "pr-format.md"), "utf8")).toBe(PR_FORMAT);
		expect(fs.readFileSync(path.join(s.leadDir, "brief-template.md"), "utf8")).toBe("the lead's own template\n");
		expect(fs.readFileSync(path.join(s.leadDir, "hard-gates.md"), "utf8")).toBe("the lead's gates\n");
		expect(start()).toEqual([]);
	});

	test("does nothing before /starter lead, and resets the story of the previous session", async () => {
		const s = setup();
		await s.input("/story S1", s.main().ctx);
		s.fake.emit("session_start", { type: "session_start" }, s.main().ctx);
		expect(lead().story).toBeUndefined();

		resetHome();
		const bare = setup(null);
		bare.fake.emit("session_start", { type: "session_start" }, bare.main().ctx);
		expect(fs.existsSync(bare.leadDir)).toBe(false);
	});
});

describe("a knowledge base whose lead setting reuses its own folders", () => {
	const files = { "company/hard-gates.md": GATES, "projects/S1/brief.md": BRIEF };

	test("briefs, the template and the policy files are found in those folders, and the story block names them", async () => {
		const s = setup(files, undefined, true);
		const { ui, ctx } = s.main();
		expect(await s.input("/story S2", ctx)).toEqual({ handled: true });
		expect(ui.notifications.map(n => n.message)).toEqual([
			"lead: no lead brief at ~/kb/projects/S2/brief.md. Copy ~/kb/_templates/brief-template.md there and fill it in; planning does not start without it.",
		]);
		expect(await s.input("/story S1", ctx)).toBeUndefined();
		// The fake emitter returns the handler's result untyped; this is the shape lead.ts returns for before_agent_start.
		const started = s.fake.emit("before_agent_start", { type: "before_agent_start", reason: "prompt", prompt: "", systemPrompt: ["base"] }, ctx) as { systemPrompt: string[] } | undefined;
		const block = started!.systemPrompt[1];
		expect(block).toContain(`Plan file: ${s.kbRoot}/projects/S1/plan.md\nRepos in plan: none yet\nPR body format: ${s.kbRoot}/company/pr-format.md`);
		expect(block).toContain(`Each repository in the plan needs ${s.kbRoot}/projects/<repo>.md with a`);
		expect(block).toContain("migrations · schema · **/migrations/**, **/*.sql\n");
	});

	test("in a vault that is a git repository, the fence leaves the story's and the policy folders alone before and after approval", async () => {
		const s = setup(files, undefined, true);
		initGitRepo(s.kbRoot);
		const { ctx } = s.main({ confirm: [true] });
		await s.input("/story S1", ctx);
		expect(s.call("write", { path: path.join(s.storyDir, "plan.md") }, ctx)).toBeUndefined();
		expect(s.call("write", { path: path.join(s.kbRoot, "_memory", "note.md") }, ctx)?.reason).toStartWith("lead: the plan for S1 is not approved yet");

		s.writePlan();
		await s.fake.callTool("lead", { op: "approve" }, ctx);
		expect(readStoryState(s.storyDir).plan).not.toBeNull();
		expect(s.call("read", { path: path.join(s.kbRoot, "company", "hard-gates.md") }, ctx)).toBeUndefined();
		expect(s.call("write", { path: path.join(s.storyDir, "plan.md") }, ctx)).toBeUndefined();
		expect(s.call("read", { path: path.join(s.kbRoot, "_memory", "note.md") }, ctx)?.reason).toStartWith("lead fence: kb is not in the plan's repos");
	});

	test("session start writes nothing into the policy folder before /starter lead", () => {
		const s = setup({ "company/security-policy.md": "policy\n" }, undefined, true);
		s.fake.emit("session_start", { type: "session_start" }, s.main().ctx);
		expect(fs.readdirSync(path.join(s.kbRoot, "company"))).toEqual(["security-policy.md"]);
	});
});
