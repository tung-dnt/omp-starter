import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import * as path from "node:path";
import { HOME } from "./lib/state";
import { fakeContext, fakePi, resetHome } from "./test-harness";
import unattended from "./unattended";

beforeEach(() => {
	resetHome();
	delete process.env.OMP_STARTER_UNATTENDED;
});

afterAll(() => {
	delete process.env.OMP_STARTER_UNATTENDED;
});

interface Refusal {
	block?: boolean;
	reason?: string;
}

function session(env: string | undefined) {
	if (env !== undefined) process.env.OMP_STARTER_UNATTENDED = env;
	const fake = fakePi();
	unattended(fake.pi);
	const tool = (toolName: string, agent: "main" | "sub" = "main") =>
		fake.emit("tool_call", { toolName, input: {} }, fakeContext({ cwd: path.join(HOME, "projects", "api"), agent: { kind: agent, name: agent } })) as Refusal | undefined;
	return { fake, tool };
}

describe("which sessions it applies to", () => {
	test("registers only the ask hook, and only when OMP_STARTER_UNATTENDED is exactly 1", () => {
		expect([...session(undefined).fake.handlers.keys()]).toEqual([]);
		expect([...session("true").fake.handlers.keys()]).toEqual([]);
		expect([...session("0").fake.handlers.keys()]).toEqual([]);
		expect([...session("1").fake.handlers.keys()]).toEqual(["tool_call"]);
	});
});

describe("ask", () => {
	test("is refused: decide, record in the PR's Decision log, or write stuck.md in the spec folder", () => {
		const s = session("1");
		const refusal = s.tool("ask");
		expect(refusal?.block).toBe(true);
		expect(refusal?.reason).toContain("## Decision log");
		expect(refusal?.reason).toContain("stuck.md");
		expect(s.tool("ask", "sub")?.block).toBe(true);
	});

	test("every other tool is left alone", () => {
		const s = session("1");
		for (const toolName of ["bash", "read", "write", "edit", "todo", "task", "retain"]) expect(s.tool(toolName)).toBeUndefined();
	});
});
