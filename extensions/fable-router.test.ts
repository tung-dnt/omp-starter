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
			const context = (provider, agent = { id: "main", name: "main" }) => fakeContext({ cwd, model: { provider }, agent: { kind: "main", ...agent } });
			const spawn = (provider, agent = "deep", patterns = []) => fake.emit("before_subagent_spawn", { agent, patterns }, context(provider));
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
		const a1 = spawn("openai-codex", "deep", ["anthropic/claude-opus-5-5:high", "openai-codex/gpt-6-luna:high"]);
		const a2 = spawn("openai-codex");
		const capped = spawn("openai-codex");
		const fable = spawn("anthropic");
		console.log(JSON.stringify({ a1, a2, capped, fable }));
	`) as Record<string, { model: string[]; note: string }>;
	expect(result.a1.model).toEqual(["openai-codex/gpt-6-astra:high", "openai-codex/gpt-6-luna:high", "openai-codex/gpt-6.1-sol:high"]);
	expect(result.a2.note).toContain("2/2 today");
	expect(result.capped.model).toEqual(["openai-codex/gpt-6.1-sol:high"]);
	expect(result.fable.model).toEqual(["anthropic/claude-fable-5-1:high", "anthropic/claude-opus-5-5:high"]);
	expect(result.fable.note).toContain("1/2 today");
});

test("quota resets on a new day and survives a fresh router registration", async () => {
	const result = await scenario(`
		mkdirSync(join(home, ".omp", "agent"), { recursive: true });
		writeFileSync(join(home, ".omp", "agent", "astra-router.json"), JSON.stringify({ day: "2000-01-01", used: 2 }));
		const fresh = spawn("openai-codex");
		extension(fake.pi);
		const next = spawn("openai-codex");
		const capped = spawn("openai-codex");
		console.log(JSON.stringify({ fresh, next, capped }));
	`) as Record<string, { model: string[]; note: string }>;
	expect(result.fresh.note).toContain("1/2 today");
	expect(result.next.note).toContain("2/2 today");
	expect(result.capped.model).toEqual(["openai-codex/gpt-6.1-sol:high"]);
});

test("only risky reviews escalate; coding and security agents retain their assigned roles", async () => {
	const result = await scenario(`
		console.log(JSON.stringify({
			review: spawn("openai-codex", "code-reviewer"),
			coding: spawn("openai-codex", "task"),
			security: spawn("openai-codex", "security-reviewer"),
			other: spawn("openai", "deep")
		}));
	`, true) as Record<string, { model: string[] }>;
	expect(result.review.model[0]).toBe("openai-codex/gpt-6-astra:high");
	expect(result).not.toHaveProperty("coding");
	expect(result).not.toHaveProperty("security");
	expect(result).not.toHaveProperty("other");
	expect(await scenario('console.log(JSON.stringify(spawn("openai-codex", "reviewer") ?? null));')).toBeNull();
});

test("stuck notices ignore probes and deep recursion, reset per run, and stop at the cap", async () => {
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
		spawn("openai-codex"); spawn("openai-codex");
		fake.emit("agent_start", {}, context("openai-codex"));
		fail("openai-codex");
		const capped = fail("openai-codex");
		console.log(JSON.stringify({ probe1, probe2, deep, first, notice, duplicate, resetFirst, resetNotice, capped }));
	`) as Record<string, { additionalContext: string }>;
	expect(Object.keys(result).sort()).toEqual(["notice", "resetNotice"]);
	expect(result.notice.additionalContext).toContain("[astra-router]");
	expect(result.notice.additionalContext).toContain("expected");
	expect(result.resetNotice.additionalContext).toContain("2 times");
});
