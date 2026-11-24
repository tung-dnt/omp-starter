import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { createNotify } from "./notify";
import { fakeContext, fakePi, resetHome, seedState, type FakeContext, type FakePi } from "./test-harness";

beforeEach(() => {
	resetHome();
	delete process.env.OMP_STARTER_UNATTENDED;
});

afterAll(() => {
	delete process.env.OMP_STARTER_UNATTENDED;
});

interface Session {
	fake: FakePi;
	advance(seconds: number): void;
	ctx(options?: { cwd?: string; agent?: "main" | "sub"; hasUI?: boolean }): FakeContext;
}

function session(platform = "darwin"): Session {
	let clock = 1_000_000;
	const fake = fakePi();
	createNotify({ platform, now: () => clock })(fake.pi);
	return {
		fake,
		advance: (seconds: number) => void (clock += seconds * 1000),
		ctx: (options: { cwd?: string; agent?: "main" | "sub"; hasUI?: boolean } = {}) =>
			fakeContext({
				cwd: options.cwd ?? "/work/api",
				hasUI: options.hasUI ?? true,
				agent: { kind: options.agent ?? "main", name: options.agent ?? "main" },
			}),
	};
}

function turn(s: Session, seconds: number, ctx = s.ctx()) {
	s.fake.emit("agent_start", {}, ctx);
	s.advance(seconds);
	s.fake.emit("agent_end", {}, ctx);
}

const scriptOf = (s: Session, i = 0) => s.fake.execCalls[i]?.args[1] ?? "";

describe("turn end", () => {
	test("a long turn notifies with the formatted duration", () => {
		const s = session();
		turn(s, 72);
		expect(s.fake.execCalls).toHaveLength(1);
		expect(s.fake.execCalls[0]?.command).toBe("osascript");
		expect(scriptOf(s)).toContain('display notification "Done in 1m 12s"');
		expect(scriptOf(s)).toContain('subtitle "api"');
	});

	test("a short turn does not", () => {
		const s = session();
		turn(s, 5);
		expect(s.fake.execCalls).toHaveLength(0);
	});

	test("minSeconds from state decides the threshold", () => {
		seedState({ notify: { minSeconds: 3 } });
		const s = session();
		turn(s, 5);
		expect(scriptOf(s)).toContain("Done in 5s");
	});
});

describe("which sessions notify", () => {
	test("subagents and sessions without a UI are ignored", () => {
		const s = session();
		turn(s, 60, s.ctx({ agent: "sub" }));
		turn(s, 60, s.ctx({ hasUI: false }));
		expect(s.fake.execCalls).toHaveLength(0);
	});

	test("non-darwin, unattended and notify.off register nothing", () => {
		expect(session("linux").fake.handlers.size).toBe(0);
		process.env.OMP_STARTER_UNATTENDED = "1";
		expect(session().fake.handlers.size).toBe(0);
		delete process.env.OMP_STARTER_UNATTENDED;
		seedState({ notify: { off: true } });
		expect(session().fake.handlers.size).toBe(0);
	});
});

describe("waiting for you", () => {
	test("ask notifies and is not blocked; other tools are silent", () => {
		const s = session();
		expect(s.fake.emit("tool_call", { toolName: "ask", input: {} }, s.ctx())).toBeUndefined();
		expect(scriptOf(s)).toContain("Waiting for your answer");
		s.advance(10);
		s.fake.emit("tool_call", { toolName: "bash", input: {} }, s.ctx());
		expect(s.fake.execCalls).toHaveLength(1);
	});

	test("an approval request names the tool", () => {
		const s = session();
		s.fake.emit("tool_approval_requested", { toolName: "bash" }, s.ctx());
		expect(scriptOf(s)).toContain("Approval needed: bash");
	});
});

describe("sending", () => {
	test("quotes, backslashes and newlines in the project name are escaped", () => {
		const s = session();
		s.fake.emit("tool_call", { toolName: "ask", input: {} }, s.ctx({ cwd: '/work/a"b\\c\nd' }));
		expect(scriptOf(s)).toContain('subtitle "a\\"b\\\\c d"');
	});

	test("two events within 5 seconds send one notification", () => {
		const s = session();
		s.fake.emit("tool_call", { toolName: "ask", input: {} }, s.ctx());
		s.advance(2);
		s.fake.emit("tool_approval_requested", { toolName: "bash" }, s.ctx());
		expect(s.fake.execCalls).toHaveLength(1);
		s.advance(4);
		s.fake.emit("tool_approval_requested", { toolName: "bash" }, s.ctx());
		expect(s.fake.execCalls).toHaveLength(2);
	});
});
