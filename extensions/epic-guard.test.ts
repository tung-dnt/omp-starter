import { beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import epicGuard, { PLAN_ONLY } from "./epic-guard";
import planMode from "./plan-mode";
import { fakeContext, fakePi, initGitRepo, privateHome, resetHome } from "./test-harness";

beforeEach(() => {
	resetHome();
	delete (globalThis as Record<symbol, unknown>)[Symbol.for("omp-starter.epic-guard")];
	delete (globalThis as Record<symbol, unknown>)[Symbol.for("omp-starter.epic-guard.carry")];
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

test("/epic holds code writes, in subagents too, and lets its plan through", () => {
	const s = session();
	s.type("/epic payments rework");
	const held = s.write("src/app.ts");
	expect(held?.block).toBe(true);
	expect(held?.reason).toContain("src/app.ts");
	expect(s.write("src/app.ts", s.scout)?.block).toBe(true);
	for (const ok of ["plans/001-pay.md", "/tmp/scratch.md", "local://notes.md"]) expect(s.write(ok)).toBeUndefined();
	for (const held of ["specs/001-pay/spec.md", "src/plans/x.ts"]) expect(s.write(held)?.block).toBe(true);
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

test("approving the epic's plan with a fresh context keeps the guard on; a later unrelated session does not", () => {
	const s = session();
	s.type("/epic x");
	s.fake.emit("plan_review_requested", { type: "plan_review_requested" }, s.main);
	// "Approve and execute" clears the context: a new session with an empty branch, before the review closes.
	const fresh = { ...s.main, sessionManager: { getSessionId: () => "s2", getBranch: () => [] } };
	s.fake.emit("session_switch", { reason: "new" }, fresh);
	expect(s.write("src/app.ts", fresh)?.block).toBe(true);
	expect(s.entries.at(-1)).toEqual({ type: "custom", customType: "epic-guard", data: { active: true } });
	s.fake.emit("plan_review_resolved", { type: "plan_review_resolved", choice: "execute" }, fresh);
	const later = { ...s.main, sessionManager: { getSessionId: () => "s3", getBranch: () => [] } };
	s.fake.emit("session_switch", { reason: "new" }, later);
	expect(s.write("src/app.ts", later)).toBeUndefined();
});

test("a plan review outside /epic carries nothing into the next session", () => {
	const s = session();
	s.fake.emit("plan_review_requested", { type: "plan_review_requested" }, s.main);
	s.fake.emit("session_switch", { reason: "new" }, { ...s.main, sessionManager: { getSessionId: () => "s2", getBranch: () => [] } });
	expect(s.write("src/app.ts")).toBeUndefined();
});

test("/story and /epic enter plan mode in the TUI and warn when they cannot", async () => {
	const fake = fakePi();
	planMode(fake.pi);
	const requests: object[] = [];
	let answer: object = { ok: true, changed: true };
	const ctx = { ...fakeContext({ cwd: "/", agent: { kind: "main", name: "main" } }), sessionModes: { set: async (r: object) => (requests.push(r), answer) } };
	await fake.emit("input", { text: "/story add login", source: "interactive" }, ctx);
	await fake.emit("input", { text: "/epic payments rework", source: "interactive" }, ctx);
	expect(requests).toEqual([
		{ mode: "plan", action: "enter" },
		{ mode: "plan", action: "enter" },
	]);
	for (const text of ["fix the story about login", "/epical idea", "/stories"]) await fake.emit("input", { text, source: "interactive" }, ctx);
	expect(requests).toHaveLength(2);
	answer = { ok: false, code: "conflict", message: "goal mode is active" };
	await fake.emit("input", { text: "/epic again", source: "interactive" }, ctx);
	expect(ctx.ui.notifications.at(-1)?.message).toContain("epic: plan mode not entered (conflict");
	const headless = { ...fakeContext({ cwd: "/", agent: { kind: "main", name: "main" } }) };
	expect(await fake.emit("input", { text: "/story x", source: "rpc" }, headless)).toBeUndefined();
});

test("every plan path the epic and build skills name is one the guard lets /epic write", () => {
	const skills = ["epic", "build"].map(name => fs.readFileSync(path.join(import.meta.dir, "..", "skills", name, "SKILL.md"), "utf8")).join("\n");
	const plans = [...skills.matchAll(/`([^`\s]*plans\/[^`\s]+\.md)`/g)].map(m => m[1].replace(/<[^>]+>/g, "001-x"));
	expect(plans.length).toBeGreaterThan(0);
	for (const plan of plans) expect(PLAN_ONLY.test(plan)).toBe(true);
});
