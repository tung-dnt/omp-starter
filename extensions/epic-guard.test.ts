import { beforeEach, expect, test } from "bun:test";
import * as path from "node:path";
import epicGuard from "./epic-guard";
import storyPlan from "./story-plan";
import { fakeContext, fakePi, initGitRepo, privateHome, resetHome } from "./test-harness";

beforeEach(() => {
	resetHome();
	delete (globalThis as Record<symbol, unknown>)[Symbol.for("omp-starter.epic-guard")];
});

interface Held {
	block?: boolean;
	reason?: string;
}

/** A session whose appended entries replay on the next session_start, like a resumed or restarted session. */
function session(entries: { type: string; customType: string; data: unknown }[] = []) {
	const repo = path.join(privateHome(), "projects", "api");
	initGitRepo(repo);
	const fake = fakePi();
	(fake.pi as unknown as { appendEntry(customType: string, data: unknown): void }).appendEntry = (customType, data) => void entries.push({ type: "custom", customType, data });
	epicGuard(fake.pi);
	const main = { ...fakeContext({ cwd: repo, agent: { kind: "main", name: "main" } }), sessionManager: { getSessionId: () => "s1", getBranch: () => entries } };
	const scout = { ...main, agent: { kind: "sub", name: "task" } };
	const type = (text: string) => fake.emit("input", { type: "input", text, source: "interactive" }, main);
	const write = (p: string, ctx: object = main) => fake.emit("tool_call", { toolName: "write", input: { path: p, content: "x" } }, ctx) as Held | undefined;
	return { repo, fake, main, scout, entries, type, write };
}

test("outside /epic nothing is held", () => {
	const s = session();
	s.fake.emit("session_start", {}, s.main);
	expect(s.write("src/app.ts")).toBeUndefined();
});

test("/epic holds code writes, in subagents too, and lets spec-kit files through", () => {
	const s = session();
	s.type("/epic payments rework");
	const held = s.write("src/app.ts");
	expect(held?.block).toBe(true);
	expect(held?.reason).toContain("src/app.ts");
	expect(s.write("src/app.ts", s.scout)?.block).toBe(true);
	for (const ok of ["specs/001-pay/spec.md", ".specify/memory/constitution.md", ".omp/commands/speckit.plan.md", "/tmp/scratch.md", "local://notes.md"]) expect(s.write(ok)).toBeUndefined();
	const edit = s.fake.emit("tool_call", { toolName: "edit", input: { input: "[src/pay.ts#ABCD]\nPUT 1.=1:\n+x" } }, s.main) as Held | undefined;
	expect(edit?.block).toBe(true);
});

test("/epic-done, /story and /build end it; /epics-like words do not start it", async () => {
	const s = session();
	s.type("/epical idea");
	expect(s.write("src/app.ts")).toBeUndefined();
	s.type("/epic x");
	await s.fake.runCommand("epic-done", "", s.main);
	expect(s.write("src/app.ts")).toBeUndefined();
	s.type("/epic x");
	s.type("/story 1");
	expect(s.write("src/app.ts")).toBeUndefined();
});

test("the guard survives a restart of the same session", () => {
	const entries: { type: string; customType: string; data: unknown }[] = [];
	session(entries).type("/epic x");
	delete (globalThis as Record<symbol, unknown>)[Symbol.for("omp-starter.epic-guard")];
	const resumed = session(entries);
	resumed.fake.emit("session_start", {}, resumed.main);
	expect(resumed.write("src/app.ts")?.block).toBe(true);
});

test("/story enters plan mode in the TUI and warns when it cannot", async () => {
	const fake = fakePi();
	storyPlan(fake.pi);
	const requests: object[] = [];
	let answer: object = { ok: true, changed: true };
	const ctx = { ...fakeContext({ cwd: "/", agent: { kind: "main", name: "main" } }), sessionModes: { set: async (r: object) => (requests.push(r), answer) } };
	await fake.emit("input", { text: "/story add login", source: "interactive" }, ctx);
	expect(requests).toEqual([{ mode: "plan", action: "enter" }]);
	await fake.emit("input", { text: "fix the story about login", source: "interactive" }, ctx);
	expect(requests).toHaveLength(1);
	answer = { ok: false, code: "conflict", message: "goal mode is active" };
	await fake.emit("input", { text: "/story again", source: "interactive" }, ctx);
	expect(ctx.ui.notifications.at(-1)?.message).toContain("conflict");
	const headless = { ...fakeContext({ cwd: "/", agent: { kind: "main", name: "main" } }) };
	expect(await fake.emit("input", { text: "/story x", source: "rpc" }, headless)).toBeUndefined();
});
