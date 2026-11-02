import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const homes: string[] = [];
afterEach(() => {
	for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

/** Each child gets a real private HOME, git diff, and quota store. */
async function scenario(body: string, risky = false): Promise<unknown> {
	const home = mkdtempSync(join(tmpdir(), "omp-escalation-"));
	homes.push(home);
	const cwd = join(home, "repo");
	mkdirSync(cwd);
	execFileSync("git", ["init", "--quiet"], { cwd });
	if (risky) {
		mkdirSync(join(cwd, "migrations"));
		writeFileSync(join(cwd, "migrations", "001.sql"), "SELECT 1;\n");
	}
	const source = `
		import router from ${JSON.stringify(join(import.meta.dir, "fable-router.ts"))};
		import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
		import { join } from "node:path";
		const handlers = new Map();
		router({ on: (event, handler) => handlers.set(event, handler) });
		const context = provider => ({ model: { provider }, cwd: ${JSON.stringify(cwd)}, agent: { id: "main", name: "main" } });
		const spawn = (provider, agent = "deep", patterns = []) => handlers.get("before_subagent_spawn")({ agent, patterns }, context(provider));
		const fail = (provider, command = "bun test", agent = "main") => handlers.get("tool_result")(
			{ toolName: "bash", isError: true, input: { command } },
			{ ...context(provider), agent: { id: agent, name: agent } }
		);
		${body}
	`;
	const child = Bun.spawn(["bun", "-e", source], {
		cwd, env: { ...process.env, HOME: home, FABLE_ROUTER_DAILY_CAP: "2", ASTRA_ROUTER_DAILY_CAP: "2" },
		stdout: "pipe", stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
	]);
	if (code !== 0) throw new Error(stderr);
	return JSON.parse(stdout);
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
		mkdirSync(join(process.env.HOME, ".omp", "agent"), { recursive: true });
		writeFileSync(join(process.env.HOME, ".omp", "agent", "astra-router.json"), JSON.stringify({ day: "2000-01-01", used: 2 }));
		const fresh = spawn("openai-codex");
		router({ on: (event, handler) => handlers.set(event, handler) });
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
		handlers.get("agent_start")({}, context("openai-codex"));
		const resetFirst = fail("openai-codex");
		const resetNotice = fail("openai-codex");
		spawn("openai-codex"); spawn("openai-codex");
		handlers.get("agent_start")({}, context("openai-codex"));
		fail("openai-codex");
		const capped = fail("openai-codex");
		console.log(JSON.stringify({ probe1, probe2, deep, first, notice, duplicate, resetFirst, resetNotice, capped }));
	`) as Record<string, { additionalContext: string }>;
	expect(Object.keys(result).sort()).toEqual(["notice", "resetNotice"]);
	expect(result.notice.additionalContext).toContain("[astra-router]");
	expect(result.notice.additionalContext).toContain("expected");
	expect(result.resetNotice.additionalContext).toContain("2 times");
});
