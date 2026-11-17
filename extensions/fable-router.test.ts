import { expect, test } from "bun:test";
import { join } from "node:path";
import { runExtensionChild } from "./test-harness";

/** Each child gets a real private HOME, git diff, and quota store. */
async function scenario(body: string, risky = false): Promise<unknown> {
	return runExtensionChild({
		extension: join(import.meta.dir, "fable-router.ts"),
		env: { FABLE_ROUTER_DAILY_CAP: "2", ASTRA_ROUTER_DAILY_CAP: "2" },
		repoFiles: risky ? { "migrations/001.sql": "SELECT 1;\n" } : {},
		body: `
			const context = (provider, agent = { id: "main", name: "main" }, id = undefined, ui = undefined) =>
				fakeContext({ cwd, model: { provider, id }, agent: { kind: "main", ...agent }, ...(ui ? { ui } : {}) });
			const spawn = (provider, agent = "deep", patterns = [], id = undefined) => fake.emit("before_subagent_spawn", { agent, patterns }, context(provider, undefined, id));
			const fail = (provider, command = "bun test", agent = "main") => fake.emit(
				"tool_result",
				{ toolName: "bash", isError: true, input: { command } },
				context(provider, { id: agent, name: agent })
			);
			${body}
		`,
	});
}

test("Astra and Fable use independent daily quotas and subscription-local fallback models", async () => {
	const result = await scenario(`
		await spawn("openai-codex");
		const a1 = await spawn("openai-codex", "deep", ["anthropic/claude-opus-5-5:high", "openai-codex/gpt-6-luna:high"]);
		const a2 = await spawn("openai-codex");
		const capped = await spawn("openai-codex");
		const fable = await spawn("anthropic");
		console.log(JSON.stringify({ a1, a2, capped, fable }));
	`) as Record<string, { model: string[]; note: string }>;
	expect(result.a1.model).toEqual(["openai-codex/gpt-6-astra:high", "openai-codex/gpt-6-luna:high", "openai-codex/gpt-6.1-sol:high"]);
	expect(result.a2.note).toContain("2/2 today");
	expect(result.capped.model).toEqual(["openai-codex/gpt-6.1-sol:high"]);
	expect(result.fable.model).toEqual(["anthropic/claude-fable-5-2:high", "anthropic/claude-opus-5-5:high"]);
	expect(result.fable.note).toContain("1/2 today");
});

test("quota resets on a new day and survives a fresh router registration", async () => {
	const result = await scenario(`
		mkdirSync(join(home, ".omp", "agent"), { recursive: true });
		writeFileSync(join(home, ".omp", "agent", "astra-router.json"), JSON.stringify({ day: "2000-01-01", used: 2 }));
		await spawn("openai-codex");
		const fresh = await spawn("openai-codex");
		extension(fake.pi);
		await spawn("openai-codex");
		const next = await spawn("openai-codex");
		const capped = await spawn("openai-codex");
		console.log(JSON.stringify({ fresh, next, capped }));
	`) as Record<string, { model: string[]; note: string }>;
	expect(result.fresh.note).toContain("1/2 today");
	expect(result.next.note).toContain("2/2 today");
	expect(result.capped.model).toEqual(["openai-codex/gpt-6.1-sol:high"]);
});

test("a run's first deep consult goes to Opus at high effort uncounted; later consults and new runs follow the ladder", async () => {
	const result = await scenario(`
		const step1 = await spawn("anthropic");
		const step2 = await spawn("anthropic");
		const step3 = await spawn("anthropic");
		fake.emit("agent_start", {}, context("anthropic"));
		const nextRun = await spawn("anthropic");
		console.log(JSON.stringify({ step1, step2, step3, nextRun }));
	`) as Record<string, { model: string[]; note: string }>;
	expect(result.step1.model).toEqual(["anthropic/claude-opus-5-5:high"]);
	expect(result.step1.note).toContain("uncounted");
	expect(result.step2.model[0]).toBe("anthropic/claude-fable-5-2:high");
	expect(result.step2.note).toContain("1/2 today");
	expect(result.step3.note).toContain("2/2 today");
	expect(result.nextRun.model).toEqual(["anthropic/claude-opus-5-5:high"]);
});

test("a Fable-led session skips the Opus step and is warned once that the cap does not count it", async () => {
	const result = await scenario(`
		const ui = scriptedUi();
		const lead = context("anthropic", undefined, "anthropic/claude-fable-5-2", ui);
		fake.emit("session_start", {}, lead);
		fake.emit("agent_start", {}, lead);
		fake.emit("agent_start", {}, lead);
		fake.emit("agent_start", {}, context("anthropic", undefined, "anthropic/claude-opus-5-5", ui));
		const consult = await fake.emit("before_subagent_spawn", { agent: "deep", patterns: [] }, lead);
		console.log(JSON.stringify({ consult, notifications: ui.notifications }));
	`) as { consult: { model: string[]; note: string }; notifications: { message: string; type: string }[] };
	expect(result.consult.model[0]).toBe("anthropic/claude-fable-5-2:high");
	expect(result.consult.note).toContain("1/2 today");
	expect(result.notifications).toHaveLength(1);
	expect(result.notifications[0].type).toBe("warning");
	expect(result.notifications[0].message).toContain("does not count it");
});

test("only risky reviews escalate; coding and security agents retain their assigned roles", async () => {
	const result = await scenario(`
		console.log(JSON.stringify({
			review: await spawn("openai-codex", "code-reviewer"),
			coding: await spawn("openai-codex", "task"),
			security: await spawn("openai-codex", "security-reviewer"),
			other: await spawn("openai", "deep")
		}));
	`, true) as Record<string, { model: string[] }>;
	expect(result.review.model[0]).toBe("openai-codex/gpt-6-astra:high");
	expect(result).not.toHaveProperty("coding");
	expect(result).not.toHaveProperty("security");
	expect(result).not.toHaveProperty("other");
	expect(await scenario('console.log(JSON.stringify((await spawn("openai-codex", "reviewer")) ?? null));')).toBeNull();
});

test("stuck notices ignore probes and deep recursion, reset per run, and stop at the cap once the Opus step is used", async () => {
	const result = await scenario(`
		const probe1 = fail("openai-codex", "rg missing");
		const probe2 = fail("openai-codex", "rg missing");
		fail("openai-codex", "bun test", "deep");
		const deep = fail("openai-codex", "bun test", "deep");
		const first = fail("openai-codex");
		const notice = fail("openai-codex");
		const duplicate = fail("openai-codex");
		fake.emit("agent_start", {}, context("openai-codex"));
		const resetFirst = fail("openai-codex");
		const resetNotice = fail("openai-codex");
		await spawn("openai-codex"); await spawn("openai-codex"); await spawn("openai-codex");
		fake.emit("agent_start", {}, context("openai-codex"));
		fail("openai-codex");
		const cappedLadder = fail("openai-codex");
		fake.emit("agent_start", {}, context("openai-codex"));
		await spawn("openai-codex");
		fail("openai-codex");
		const capped = fail("openai-codex");
		console.log(JSON.stringify({ probe1, probe2, deep, first, notice, duplicate, resetFirst, resetNotice, cappedLadder, capped }));
	`) as Record<string, { additionalContext: string }>;
	expect(Object.keys(result).sort()).toEqual(["cappedLadder", "notice", "resetNotice"]);
	expect(result.notice.additionalContext).toContain("[astra-router]");
	expect(result.notice.additionalContext).toContain("expected");
	expect(result.notice.additionalContext).toContain("what done looks like");
	expect(result.notice.additionalContext).toContain("first deep consult uses sol");
	expect(result.resetNotice.additionalContext).toContain("2 times");
	expect(result.cappedLadder.additionalContext).toContain("escalations left today: 0");
});

test("a failing search after a leading cd is a probe, not a stuck command", async () => {
	const result = await scenario(`
		fail("anthropic", "cd /x && rg missing");
		const second = fail("anthropic", "cd /x && rg missing");
		console.log(JSON.stringify(second ?? null));
	`);
	expect(result).toBeNull();
});

test("a review spawned outside any repo escalates on the risky diff of a repo edited in this session", async () => {
	const result = await scenario(`
		const outside = join(home, "outside");
		mkdirSync(outside);
		const at = dir => fakeContext({ cwd: dir, model: { provider: "anthropic" }, agent: { kind: "main", id: "main", name: "main" } });
		const review = () => fake.emit("before_subagent_spawn", { agent: "code-reviewer", patterns: [] }, at(outside));
		const before = (await review()) ?? null;
		fake.emit("tool_result", { toolName: "write", isError: false, input: { path: join(cwd, "src", "x.ts") } }, at(outside));
		const after = await review();
		console.log(JSON.stringify({ before, after }));
	`, true) as { before: unknown; after: { model: string[]; note: string } };
	expect(result.before).toBeNull();
	expect(result.after.model[0]).toBe("anthropic/claude-fable-5-2:high");
	expect(result.after.note).toContain("migrations/001.sql");
});
