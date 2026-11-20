import { beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import leadExtension from "./lead";
import leadGates from "./lead-gates";
import leadPrCheck from "./lead-pr-check";
import { readStoryState, today, updateStoryState, type Verdict } from "./lib/lead/artifacts";
import { lead } from "./lib/lead/registry";
import { BRIEF_TEMPLATE, HARD_GATES_TEMPLATE, PROJECT_NOTE_BLOCK } from "./lib/lead/templates";
import { HOME } from "./lib/state";
import { type FakeExec, fakeContext, fakePi, initGitRepo, resetHome, scriptedUi, seedKb, seedState, type UiScript, writeFiles } from "./test-harness";

beforeEach(resetHome);

const NOTE = `---\nupdated: ${today()}\n---\n\n# shop\n\n${PROJECT_NOTE_BLOCK}\n`;
const TEST_ROW = '{ ac: AC1, repo: shop, test: { run: "sh t.sh", files: [t.sh] } }';
const PR_URL = "https://x/pr/1";

const git = (cwd: string, ...args: string[]): string =>
	execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();

interface Options {
	/** The yaml mapping of `checks.shop` in hard-gates.md; undefined: no entry. */
	checks?: string | null;
	story?: string;
	/** Write the lead's brief (default); false leaves the story folder empty. */
	brief?: boolean;
	acs?: string[];
	proofRows?: string[];
	/** Reply of `gh pr list`. */
	pulls?: string;
}

/**
 * A knowledge base serving ~/work with hard-gates.md, and the repository ~/work/shop (origin ~/remotes/shop.git, so
 * its project-note name is `shop`) with one commit holding `src.txt` = `bug`. Commands run for real, except `gh`.
 */
function setup(options: Options = {}) {
	const { checks = '{ verify: ["true"], test: ["true"] }', story = "S1", brief = true, acs = ["src.txt says fixed"], proofRows = [TEST_ROW], pulls = `[{"url":"${PR_URL}","state":"OPEN"}]` } = options;
	const folder = path.join(HOME, "work");
	const kb = seedKb({ name: "kb", folder });
	seedState({ kb: { status: "done", sources: [kb.source] } });
	const leadDir = path.join(kb.root, "lead");
	const hardGates = checks === null ? HARD_GATES_TEMPLATE : HARD_GATES_TEMPLATE.replace("checks: {}", `checks:\n  shop: ${checks}`);
	writeFiles(leadDir, { "hard-gates.md": hardGates });
	writeFiles(kb.root, { "projects/shop.md": NOTE });
	const storyDir = path.join(leadDir, "stories", story);
	const briefText = BRIEF_TEMPLATE.replace("- I1: …", "- I1: inserts are idempotent on id")
		.replace(/^(## (?!Invariants|Success criteria).+)$/gm, "$1\none line")
		.replace("- AC1: …", acs.map((text, i) => `- AC${i + 1}: ${text}`).join("\n"));
	if (brief) writeFiles(storyDir, { "brief.md": briefText });

	const shop = path.join(folder, "shop");
	const remote = path.join(HOME, "remotes", "shop.git");
	fs.mkdirSync(remote, { recursive: true });
	git(remote, "init", "--bare", "--quiet");
	initGitRepo(shop, remote);
	writeFiles(shop, { "src.txt": "bug\n" });
	git(shop, "add", "-A");
	git(shop, "commit", "-m", "base", "--quiet");

	const exec: FakeExec = (command, args, o) => {
		if (command === "gh") return { stdout: pulls, code: 0 };
		const run = Bun.spawnSync([command, ...args], { cwd: o?.cwd });
		return { stdout: run.stdout.toString(), stderr: run.stderr.toString(), code: run.exitCode ?? -1 };
	};
	const fake = fakePi(exec);
	leadExtension(fake.pi);
	const gates = fakePi(exec);
	leadGates(gates.pi);

	const main = (script: UiScript = {}) => {
		const ui = scriptedUi(script);
		return { ui, ctx: fakeContext({ cwd: shop, ui }) };
	};
	const reviewer = fakeContext({ cwd: shop, hasUI: false, agent: { kind: "sub", name: "code-reviewer" } });
	const input = (text: string, ctx: object) => fake.emit("input", { type: "input", text, source: "interactive" }, ctx) as Promise<{ handled: boolean } | undefined>;
	const writePlan = (rows = proofRows) =>
		writeFiles(storyDir, {
			"plan.md": `---\nrepos:\n  - ${shop}\n---\n\n## Summary\nGoal: src.txt says fixed\nI1: kept\n\n## Proof\n\`\`\`yaml\nproof:\n${rows.map(row => `  - ${row}`).join("\n")}\n\`\`\`\n`,
		});
	const approve = (ctx: object) => fake.callTool("lead", { op: "approve" }, ctx);
	const check = (stage: string, ctx: object) => fake.callTool("lead", { op: "check", stage }, ctx);
	const commit = (files: Record<string, string>, message = "work") => {
		writeFiles(shop, files);
		git(shop, "add", "-A");
		git(shop, "commit", "-m", message, "--quiet");
		return git(shop, "rev-parse", "HEAD");
	};
	const stop = (ctx: object) =>
		fake.emit("session_stop", { type: "session_stop", messages: [], turn_id: 0, session_id: "s", stop_hook_active: false, signal: new AbortController().signal }, ctx) as Promise<
			{ decision?: string; reason?: string } | undefined
		>;
	/** `/story`, the plan, the lead's yes and `/build`: the loop is running. */
	const build = async (ui = main({ confirm: [true] })) => {
		await input(`/story ${story}`, ui.ctx);
		writePlan();
		await approve(ui.ctx);
		await input(`/build ${story}`, ui.ctx);
		return ui;
	};
	const state = () => readStoryState(storyDir);
	const head = () => git(shop, "rev-parse", "HEAD");
	const verdict = (heads: Record<string, string>, blockers: Verdict["blockers"] = [], proven = true) =>
		`Reviewed.\n\`\`\`lead-verdict\n${JSON.stringify({ heads, blockers, acs: [{ ac: "AC1", proven, note: "ok" }] })}\n\`\`\``;
	const reviewEnd = (text: string) => fake.emit("agent_end", { type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text }] }] }, reviewer);
	/** The fix and its test, committed after /build recorded the base. */
	const fix = () => commit({ "src.txt": "fixed\n", "t.sh": "grep -q fixed src.txt\n" }, "fix");
	/** The loop built, checked and reviewed the fix, and the branch is pushed. */
	const ready = async () => {
		const { ctx, ui } = await build();
		const fixed = fix();
		for (const stage of ["verify", "test", "proof"]) expect((await check(stage, ctx)).text).toContain(`${stage}: passed`);
		await reviewEnd(verdict({ shop: fixed }));
		git(shop, "push", "-u", "origin", "HEAD", "--quiet");
		return { ctx, ui, fixed };
	};
	return { fake, gates, shop, remote, storyDir, kbRoot: kb.root, main, input, writePlan, approve, check, commit, fix, stop, build, ready, state, head, verdict, reviewEnd, reviewer };
}

describe("plan approval", () => {
	test("is refused while an AC has no proof row", async () => {
		const s = setup({ acs: ["src.txt says fixed", "the audit log lists it"] });
		const { ctx } = s.main({ confirm: [true] });
		await s.input("/story S1", ctx);
		s.writePlan();
		await expect(s.approve(ctx)).rejects.toThrow("lead: AC2 has no proof row");
	});

	test("is refused while hard-gates.md has no checks entry for a plan repository", async () => {
		const s = setup({ checks: null });
		const { ctx } = s.main({ confirm: [true] });
		await s.input("/story S1", ctx);
		s.writePlan();
		await expect(s.approve(ctx)).rejects.toThrow("no checks entry for shop");
	});

	test("shows the lead which ACs are unprovable and why", async () => {
		const s = setup({ acs: ["src.txt says fixed", "the audit log lists it"], proofRows: [TEST_ROW, '{ ac: AC2, unprovable: "needs EMIS sandbox" }'] });
		const { ui, ctx } = s.main({ confirm: [true] });
		await s.input("/story S1", ctx);
		s.writePlan();
		await s.approve(ctx);
		expect(ui.prompts[0].detail).toContain("- AC1: src.txt says fixed → test in shop");
		expect(ui.prompts[0].detail).toContain("- AC2: the audit log lists it → UNPROVABLE: needs EMIS sandbox");
	});
});

describe("brief drafting", () => {
	test("a Jira story starts without a brief, the agent may write it until the plan is approved, then it is the lead's", async () => {
		const s = setup({ story: "PAC2-1234", brief: false });
		const { ctx } = s.main({ confirm: [true] });
		expect(await s.input("/story PAC2-1234", ctx)).toBeUndefined();
		expect(lead().story?.id).toBe("PAC2-1234");

		const briefFile = path.join(s.storyDir, "brief.md");
		const write = () => s.gates.emit("tool_call", { toolName: "write", input: { path: briefFile } }, ctx) as Promise<{ block: boolean; reason: string } | undefined>;
		expect(await write()).toBeUndefined();

		// What the agent writes from the ticket, then its plan; the lead approves both in one dialog.
		fs.mkdirSync(s.storyDir, { recursive: true });
		fs.writeFileSync(briefFile, BRIEF_TEMPLATE.replace("- I1: …", "- I1: inserts are idempotent on id").replace(/^(## (?!Invariants|Success criteria).+)$/gm, "$1\none line"));
		s.writePlan();
		await s.approve(ctx);
		expect((await write())?.reason).toContain("owned by the lead");
	});

	test("a story whose id is not a Jira key still needs its brief", async () => {
		const s = setup({ story: "S1", brief: false });
		const { ctx } = s.main();
		expect(await s.input("/story S1", ctx)).toEqual({ handled: true });
	});
});

describe("the loop", () => {
	test("starts with verify, and with a commit when the work is not committed", async () => {
		const s = setup();
		const { ctx } = await s.build();
		expect((await s.stop(ctx))?.reason).toContain('call the lead tool with op "check", stage "verify"');
		expect(lead().building).toBe(true);

		fs.writeFileSync(path.join(s.shop, "new.txt"), "x");
		expect(await s.stop(ctx)).toMatchObject({ decision: "block", reason: expect.stringContaining("Uncommitted changes in shop") });
	});

	test("does not run for subagents, outside /build, or when the lead switches it off", async () => {
		const s = setup();
		const { ctx } = s.main({ confirm: [true] });
		await s.input("/story S1", ctx);
		s.writePlan();
		await s.approve(ctx);
		expect(await s.stop(ctx)).toBeUndefined();
		await s.input("/build S1", ctx);
		expect(await s.stop(fakeContext({ cwd: s.shop, hasUI: false, agent: { kind: "sub", name: "task" } }))).toBeUndefined();
		process.env.OMP_STARTER_LEAD_LOOP = "off";
		try {
			expect(await s.stop(ctx)).toBeUndefined();
		} finally {
			delete process.env.OMP_STARTER_LEAD_LOOP;
		}
	});

	test("three failed runs of a stage stop the loop: the deep agent is asked once, then the lead is told", async () => {
		const s = setup({ checks: '{ verify: ["true"], test: ["exit 1"] }' });
		const { ui, ctx } = await s.build();
		expect((await s.check("verify", ctx)).text).toContain("verify: passed");
		expect(s.state().loop.receipts.shop.verify?.passed).toBe(true);
		for (let run = 1; run <= 3; run++) expect((await s.check("test", ctx)).text).toContain(`test: FAILED (${run} of 3)`);
		expect(s.state().loop.stuck?.stage).toBe("test");

		expect((await s.stop(ctx))?.reason).toContain("Spawn the deep agent");
		expect(await s.stop(ctx)).toBeUndefined();
		expect(ui.notifications.at(-1)?.message).toBe(`omp lead · S1 · stuck at test: ${s.storyDir}/stuck.md`);
		const before = ui.notifications.length;
		expect(await s.stop(ctx)).toBeUndefined();
		expect(ui.notifications).toHaveLength(before);
	});

	test("a queued hard gate hands the turn to the lead", async () => {
		const s = setup();
		const { ui, ctx } = await s.build();
		lead().pending.set("k", { key: "k", gateId: "auth", category: "auth", repoName: "shop", rel: "a.ts", agent: "task" });
		expect(await s.stop(ctx)).toBeUndefined();
		expect(ui.notifications.at(-1)?.message).toBe("omp lead · S1 · 1 gate queued");
	});

	test("a check needs committed work, a stage and an approved plan", async () => {
		const s = setup();
		const { ctx } = s.main({ confirm: [true] });
		await s.input("/story S1", ctx);
		await expect(s.check("verify", ctx)).rejects.toThrow("lead: the plan is not approved");
		s.writePlan();
		await s.approve(ctx);
		await expect(s.fake.callTool("lead", { op: "check" }, ctx)).rejects.toThrow("lead: check needs a stage");
		fs.writeFileSync(path.join(s.shop, "new.txt"), "x");
		expect((await s.check("verify", ctx)).text).toBe("lead check: commit the changes in shop first; receipts are keyed by HEAD.");
	});
});

describe("proof", () => {
	test("a test that fails on the base commit and passes on HEAD proves its AC; no worktree is left behind", async () => {
		const s = setup();
		const { ctx } = await s.build();
		s.fix();
		const { text } = await s.check("proof", ctx);
		expect(text).toContain("proof: passed");
		const [row] = s.state().loop.receipts.shop.proof!.proof!;
		expect(row.base.code).not.toBe(0);
		expect(row.head.code).toBe(0);
		expect(row.passed).toBe(true);
		expect(git(s.shop, "worktree", "list").split("\n")).toHaveLength(1);
		expect(fs.readdirSync(path.join(HOME, ".omp", "agent", "lead-logs", "S1")).length).toBeGreaterThanOrEqual(2);
	});

	test("a test that also passes on the base commit proves nothing", async () => {
		const s = setup();
		const { ctx } = await s.build();
		s.fix();
		s.writePlan(['{ ac: AC1, repo: shop, test: { run: "true", files: [t.sh] } }']);
		const { text } = await s.check("proof", ctx);
		expect(text).toContain("proof: FAILED (1 of 3)");
		expect(text).toContain("passes on the base commit: the test does not prove AC1");
		expect(s.state().loop.receipts.shop.proof?.passed).toBe(false);
		expect(git(s.shop, "worktree", "list").split("\n")).toHaveLength(1);
	});

	test("a proof test file that does not exist at HEAD fails the row instead of passing on the base", async () => {
		const s = setup();
		const { ctx } = await s.build();
		s.fix();
		s.writePlan(['{ ac: AC1, repo: shop, test: { run: "sh gone.sh", files: [gone.sh] } }']);
		const { text } = await s.check("proof", ctx);
		expect(text).toContain("proof: FAILED");
		expect(s.state().loop.receipts.shop.proof?.proof?.[0].passed).toBe(false);
	});
});

describe("acceptance", () => {
	test("runs against the pushed branch, after deploy_wait, with the configured env and the story's coordinates", async () => {
		const s = setup({
			checks: '{ verify: ["true"], test: ["true"], acceptance: { deploy_wait: "true", env: { STACK: "x-{branch}" } } }',
			proofRows: ['{ ac: AC1, repo: shop, acceptance: { run: "sh acc.sh" } }'],
		});
		const { ctx } = await s.build();
		s.commit({ "acc.sh": 'test "$STACK" = "x-$BRANCH" && test "$SHA" = "$(git rev-parse HEAD)" && test -d "$STORY_DIR"\n' });
		expect((await s.check("acceptance", ctx)).text).toBe("lead check: push shop first (the feature stack deploys from the pushed branch)");
		git(s.shop, "push", "-u", "origin", "HEAD", "--quiet");
		const { text } = await s.check("acceptance", ctx);
		expect(text).toContain("acceptance: passed");
		expect(s.state().loop.receipts.shop.acceptance?.results).toHaveLength(2);
	});
});

describe("review", () => {
	test("a verdict for the current HEAD is recorded; one for an older HEAD is ignored", async () => {
		const s = setup();
		await s.build();
		const old = s.head();
		await s.reviewEnd(s.verdict({ shop: old }));
		expect(s.state().loop.review).toMatchObject({ clean: true, heads: { shop: old } });

		s.commit({ "more.txt": "x" });
		const at = s.state().loop.review?.at;
		await s.reviewEnd(s.verdict({ shop: old }, [{ severity: "Required", where: "a.ts:1", finding: "wrong" }]));
		expect(s.state().loop.review?.at).toBe(at);
		expect(s.state().loop.reviewRounds).toBe(0);
	});

	test("blockers or an AC the reviewer found unproven make it unclean, count a round, and come back to the agent", async () => {
		const s = setup();
		const { ctx } = await s.build();
		s.fix();
		for (const stage of ["verify", "test", "proof"]) await s.check(stage, ctx);
		await s.reviewEnd(s.verdict({ shop: s.head() }, [{ severity: "Required", where: "a.ts:1", finding: "wrong" }]));
		expect(s.state().loop.review?.clean).toBe(false);
		expect(s.state().loop.reviewRounds).toBe(1);
		expect((await s.stop(ctx))?.reason).toContain("Required a.ts:1: wrong");

		await s.reviewEnd(s.verdict({ shop: s.head() }, [], false));
		expect(s.state().loop.review?.clean).toBe(false);
		expect(s.state().loop.reviewRounds).toBe(2);
	});

	test("the reviewer runs on the slow role and gets the proof and receipts in its prompt; the main session's ask is blocked", async () => {
		const s = setup();
		const { ctx } = await s.build();
		expect(s.fake.emit("before_subagent_spawn", { type: "before_subagent_spawn", agent: "code-reviewer", invocationKind: "task", patterns: [] }, ctx)).toMatchObject({ model: "@slow" });
		const started = s.fake.emit("before_agent_start", { type: "before_agent_start", reason: "prompt", prompt: "", systemPrompt: ["base"] }, s.reviewer) as { systemPrompt: string[] };
		const review = started.systemPrompt.find(block => block.startsWith("# Lead review S1"))!;
		expect(review).toContain("- AC1: src.txt says fixed — test in shop: `sh t.sh` (files: t.sh)");
		expect(review).toContain(`\`git -C ${s.shop} diff ${s.head()}..HEAD\``);
		expect(review).toContain("```lead-verdict");

		const ask = (c: object) => s.fake.emit("tool_call", { toolName: "ask", input: {} }, c) as { block: boolean; reason: string } | undefined;
		expect(ask(ctx)?.reason).toStartWith("lead loop:");
		expect(ask(s.reviewer)).toBeUndefined();
	});
});

describe("ready to merge", () => {
	test("the loop pushes when review is clean, asks for the PR when there is none, and rests with the URL once there is", async () => {
		const s = setup({ pulls: "[]" });
		const { ctx } = await s.build();
		const fixed = s.fix();
		for (const stage of ["verify", "test", "proof"]) await s.check(stage, ctx);
		expect((await s.stop(ctx))?.reason).toContain("Spawn one code-reviewer subagent");
		await s.reviewEnd(s.verdict({ shop: fixed }));
		expect((await s.stop(ctx))?.reason).toMatch(/Push shop with git push -u origin \w+/);
		git(s.shop, "push", "-u", "origin", "HEAD", "--quiet");
		expect((await s.stop(ctx))?.reason).toContain("Open the PR for shop");
	});

	test("with everything recorded at HEAD and a pull request open, the session rests and the lead hears once", async () => {
		const s = setup();
		const { ctx, ui } = await s.ready();
		expect(await s.stop(ctx)).toBeUndefined();
		expect(await s.stop(ctx)).toBeUndefined();
		expect(ui.notifications.map(n => n.message)).toEqual([`omp lead · S1 · ready to merge: ${PR_URL}`]);
		expect(s.state().loop.readyNotified).toBe(s.head());
	});

	test("the PR check wants the receipts and a clean review at HEAD, and an evidence line per proven AC", async () => {
		const s = setup();
		const { ctx } = await s.build();
		const prCheck = fakePi();
		leadPrCheck(prCheck.pi);
		const fixed = s.fix();
		const body = (evidence: boolean) =>
			`## Decision log\n- one fix — rejected: two (no gain)\n\n## Invariant checklist\n- I1: inserts are idempotent on id — test: t.sh::fixed\n\n## Risk summary\n- slow — src.txt:1\n${
				evidence ? "\n## Evidence\n- AC1: t.sh::fixed fails on base, passes on HEAD\n" : ""
			}`;
		const bodyFile = path.join(HOME, "body.md");
		const open = () => prCheck.emit("tool_call", { toolName: "bash", input: { command: `gh pr create --title x --body-file ${bodyFile}` } }, ctx) as { block: boolean; reason: string } | undefined;

		fs.writeFileSync(bodyFile, body(true));
		expect(open()?.reason).toContain("verify check has not passed at HEAD");
		expect(open()?.reason).toContain("review verdict is not clean at HEAD");

		for (const stage of ["verify", "test", "proof"]) await s.check(stage, ctx);
		await s.reviewEnd(s.verdict({ shop: fixed }));
		expect(open()).toBeUndefined();

		fs.writeFileSync(bodyFile, body(false));
		expect(open()?.reason).toContain("Missing section: ## Evidence");

		await updateStoryState(s.storyDir, state => {
			state.loop.review = null;
		});
		fs.writeFileSync(bodyFile, body(true));
		expect(open()?.reason).toContain("review verdict is not clean at HEAD");
	});
});
