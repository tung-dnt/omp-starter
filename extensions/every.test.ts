import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { createEvery, formatDuration, parseDuration } from "./every";
import { fakeContext, fakePi, resetHome } from "./test-harness";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

beforeEach(() => {
	resetHome();
	delete process.env.OMP_STARTER_UNATTENDED;
});

afterAll(() => {
	delete process.env.OMP_STARTER_UNATTENDED;
});

function session(agent: "main" | "sub" = "main") {
	let clock = 1_000_000;
	const fake = fakePi();
	createEvery({ now: () => clock })(fake.pi);
	const ctx = fakeContext({ cwd: "/tmp", agent: { kind: agent, name: agent } });
	return {
		fake,
		ctx,
		every: (args: string) => fake.runCommand("every", args, ctx),
		advance: (ms: number) => void (clock += ms),
		notices: () => ctx.ui.notifications.map(n => n.message),
	};
}

describe("durations", () => {
	test("parse single units and combinations; reject anything else", () => {
		expect(parseDuration("30s")).toEqual({ ms: 30_000 });
		expect(parseDuration("1h30m")).toEqual({ ms: 90 * MINUTE });
		expect(parseDuration("1d")).toEqual({ ms: DAY });
		for (const bad of ["10", "m", "10x", "1.5h", "0m", "5m later", ""]) expect(parseDuration(bad)).toHaveProperty("error");
		expect(formatDuration(90 * MINUTE)).toBe("1h30m");
	});
});

describe("/every", () => {
	test("creates a repeating job that fires only once it is due, prefixed, and then waits a full interval again", async () => {
		const s = await (async () => {
			const x = session();
			await x.every("10m check CI");
			return x;
		})();
		expect(s.notices()[0]).toContain("Scheduled j1: every 10m");
		s.advance(9 * MINUTE);
		s.ctx.tick();
		expect(s.fake.sentMessages).toEqual([]);

		s.advance(MINUTE);
		s.ctx.tick();
		expect(s.fake.sentMessages).toEqual([{ content: "[scheduled j1] check CI", options: undefined }]);

		// A late tick does not catch up on the runs it missed.
		s.advance(35 * MINUTE);
		s.ctx.tick();
		expect(s.fake.sentMessages).toHaveLength(2);
		s.advance(9 * MINUTE);
		s.ctx.tick();
		expect(s.fake.sentMessages).toHaveLength(2);
		s.advance(MINUTE);
		s.ctx.tick();
		expect(s.fake.sentMessages).toHaveLength(3);
	});

	test("queues as a follow-up while a turn is running, starts a turn when idle", async () => {
		const s = session();
		await s.every("1m ping");
		s.ctx.idle = false;
		s.advance(MINUTE);
		s.ctx.tick();
		s.ctx.idle = true;
		s.advance(MINUTE);
		s.ctx.tick();
		expect(s.fake.sentMessages.map(m => m.options)).toEqual([{ deliverAs: "followUp" }, undefined]);
	});

	test("`in` fires once and is gone, with its timer", async () => {
		const s = session();
		await s.every("in 5m remind me");
		s.advance(5 * MINUTE);
		s.ctx.tick();
		await Promise.resolve();
		expect(s.fake.sentMessages).toHaveLength(1);
		expect(s.ctx.timers.size).toBe(0);
		await s.every("list");
		expect(s.notices().at(-1)).toBe("No scheduled prompts.");
	});

	test("a prompt the host refuses stays scheduled and is reported", async () => {
		const s = session();
		Object.assign(s.fake.pi, {
			sendUserMessage: async () => {
				throw new Error("dropped");
			},
		});
		await s.every("in 2m once");
		s.advance(2 * MINUTE);
		s.ctx.tick();
		for (let i = 0; i < 3; i++) await Promise.resolve();
		expect(s.notices().at(-1)).toContain("dropped");
		expect(s.ctx.timers.size).toBe(1);
	});

	test("rejects an interval under 60s, a 21st job, and a missing prompt", async () => {
		const s = session();
		await s.every("30s too fast");
		expect(s.notices().at(-1)).toContain("minimum is 60s");
		await s.every("10m");
		expect(s.notices().at(-1)).toContain("Usage:");
		expect(s.ctx.timers.size).toBe(0);
		for (let i = 0; i < 20; i++) await s.every(`5m job ${i}`);
		await s.every("5m one too many");
		expect(s.notices().at(-1)).toContain("At most 20");
		await s.every("list");
		expect(s.notices().at(-1)?.split("\n")).toHaveLength(20);
	});

	test("stop <id> removes one job; stop all clears the rest and the interval timer", async () => {
		const s = session();
		await s.every("5m a");
		await s.every("5m b");
		await s.every("stop j1");
		expect(s.ctx.timers.size).toBe(1);
		await s.every("stop j9");
		expect(s.notices().at(-1)).toBe("No scheduled prompt j9.");
		await s.every("stop all");
		expect(s.ctx.timers.size).toBe(0);
		s.advance(10 * MINUTE);
		s.ctx.tick();
		expect(s.fake.sentMessages).toEqual([]);
	});

	test("a job still waiting after 7 days is removed silently, with a notice", async () => {
		const s = session();
		await s.every("1d weekly");
		s.advance(7 * DAY);
		s.ctx.tick();
		expect(s.fake.sentMessages).toEqual([]);
		expect(s.notices().at(-1)).toContain("expired");
		expect(s.ctx.timers.size).toBe(0);
	});

	test("session_start clears all jobs", async () => {
		const s = session();
		await s.every("5m a");
		s.fake.emit("session_start", {}, s.ctx);
		expect(s.ctx.timers.size).toBe(0);
		await s.every("list");
		expect(s.notices().at(-1)).toBe("No scheduled prompts.");
	});
});

describe("tools", () => {
	test("schedule_prompt creates a job /every can list; cancel_scheduled_prompt removes it", async () => {
		const s = session();
		const scheduled = await s.fake.callTool("schedule_prompt", { prompt: "check CI", every: "10m" }, s.ctx);
		expect(scheduled.text).toContain("Scheduled j1");
		expect((await s.fake.callTool("list_scheduled_prompts", {}, s.ctx)).text).toContain("check CI");
		expect((await s.fake.callTool("schedule_prompt", { prompt: "x", every: "10m", in: "5m" }, s.ctx)).text).toContain("exactly one");
		expect((await s.fake.callTool("schedule_prompt", { prompt: "x", every: "5s" }, s.ctx)).text).toContain("minimum is 60s");
		expect((await s.fake.callTool("cancel_scheduled_prompt", { id: "j1" }, s.ctx)).text).toContain("Stopped");
		expect(s.ctx.timers.size).toBe(0);
	});

	test("refuse in a subagent and in an unattended session, without throwing or scheduling", async () => {
		const sub = session("sub");
		expect((await sub.fake.callTool("schedule_prompt", { prompt: "x", every: "10m" }, sub.ctx)).text).toContain("not in a subagent");
		expect(sub.ctx.timers.size).toBe(0);

		process.env.OMP_STARTER_UNATTENDED = "1";
		const main = session();
		expect((await main.fake.callTool("schedule_prompt", { prompt: "x", in: "10m" }, main.ctx)).text).toContain("unattended");
		expect((await main.fake.callTool("list_scheduled_prompts", {}, main.ctx)).text).toContain("unattended");
		expect(main.ctx.timers.size).toBe(0);
	});
});
