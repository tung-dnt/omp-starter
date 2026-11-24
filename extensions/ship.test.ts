import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { type Args, createShip, exec, parseArgs, readVerdict, type Report, type ShipParts } from "./ship";
import { SHIM_DIR } from "./ship/fence-state";
import { putUp } from "./ship/putup";
import { type Note, SHIP, type Snapshot, type Step, type Watch } from "./ship/types";
import { claimWatch, loadWatch, nextStep, recordPass, recordPush, releaseWatch, renewClaim, saveWatch, unclaimWatch } from "./ship/watch";
import { fakeContext, fakePi, privateHome, resetHome, scriptedUi, type FakeContext, type FakePi } from "./test-harness";

const PR = { host: "github.com", owner: "tung-dnt", repo: "sandbox", number: 12 } as const;
const URL = "https://github.com/tung-dnt/sandbox/pull/12";
const T0 = Date.UTC(2026, 10, 24, 9, 0, 0);
const ROOT = "/work/sandbox";
/** What `gh pr list --head <branch>` finds when the branch already has the user's open PR. */
const listed = { number: 12, url: URL, author: { login: "tung-dnt" }, isCrossRepository: false };

const snap = (over: Partial<Snapshot> = {}): Snapshot => ({
	pr: PR,
	url: URL,
	state: "OPEN",
	isDraft: false,
	author: "tung-dnt",
	headRef: "feat/x",
	headSha: "a".repeat(40),
	baseRef: "main",
	mergeable: "MERGEABLE",
	mergeState: "CLEAN",
	reviewDecision: null,
	checks: [],
	threads: [],
	comments: [],
	reviews: [],
	untrusted: 0,
	hash: "h1",
	...over,
});

const watchOf = (over: Partial<Watch> = {}): Watch => ({
	pr: PR,
	baseRef: "main",
	headRef: "feat/x",
	startedAt: T0,
	lastPassAt: null,
	lastPushAt: null,
	lastHash: null,
	nextAt: null,
	passes: [],
	pushesPerCause: {},
	told: [],
	owner: { session: "sess-A", pid: process.pid, heartbeat: T0 },
	...over,
});

const PASS: Step = { kind: "pass", why: "the PR changed since the last pass" };
const failing = [{ name: "test", bucket: "fail" as const, link: null }];
const note = (id: string, author: string, yours = false): Note => ({ id, author, bot: false, yours, at: "2026-11-24T09:00:00Z", url: `${URL}#${id}`, body: `from ${author}`, cut: false });

interface Rig {
	fake: FakePi;
	ctx: FakeContext & { aborts: number; intervals: number[] };
	statuses: (string | undefined)[];
	sent: { at: number; message: { customType: string; content: string }; options: { triggerTurn?: boolean; deliverAs?: string } }[];
	/** What each part was asked, in order. */
	calls: {
		claims: { pr: unknown; start: Record<string, unknown> }[];
		armed: { pushBranch: string; root: string }[];
		disarmed: number;
		released: { reason: string }[];
		/** Claims that a start gave back because it never became a watch. */
		unclaimed: Watch[];
		saved: Watch[];
		reads: { trust: { me: string; bots: string[] } }[];
		pushes: string[];
		puts: { root: string; confirm: boolean }[];
		/** The abort signal each put-up was given: it fires when the start is stopped. */
		putSignals: (AbortSignal | undefined)[];
		/** The folders git was run in. */
		dirs: string[];
		/** Every `git push` that was run. */
		gitPushes: string[];
		/** Every `gh pr create` that was run. */
		creates: string[];
		/** Reads of the PR that have started and not answered yet, and the most there were at once. */
		open: number;
		mostOpen: number;
	};
	/** What the parts answer; the last snapshot repeats, and an Error is thrown by the read. `listed` is what `gh pr list` finds for the branch. */
	answers: { snapshots: (Snapshot | string | Error)[]; steps: Step[]; claim: string | Watch | null; put: unknown; putFiles: string[]; confirmed: boolean | null; renew: "held" | "taken"; branch: string; dirty: string; armError: string | null; listed: unknown[]; ahead: string; readMs: number };
	clock: { now: number };
	/** Makes the next read of the PR, `git status`, `gh pr list` or `gh api user`, or the next `git push`, wait until the returned function is called, as a slow GitHub, disk or link would. */
	hold(what?: "read" | "git" | "list" | "user" | "push"): () => void;
	cmd(args: string, ctx?: Rig["ctx"]): Promise<void>;
	/** Moves the clock, fires the timer and lets everything that isn't held run to its end. */
	tick(minutes?: number): Promise<void>;
	finishTurn(text: string, extra?: object): Promise<void>;
	report(file?: string): Report;
}

/** Lets every promise that doesn't wait on a hold settle: the code under test awaits only promises that resolve without real I/O. */
function settled(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	return promise;
}

/** `realPutUp` runs story 5's put-up on the fake git and gh instead of a fake put-up. */
function rig(options: { hasUI?: boolean; idle?: boolean; mode?: string; platform?: string; sessionId?: string; real?: boolean; realPutUp?: boolean } = {}): Rig {
	const fake = fakePi();
	const sent: Rig["sent"] = [];
	const clock = { now: T0 };
	Object.assign(fake.pi, { sendMessage: (message: Rig["sent"][0]["message"], opts: Rig["sent"][0]["options"]) => void sent.push({ at: clock.now, message, options: opts }) });
	const ctx = Object.assign(
		fakeContext({ cwd: privateHome(), hasUI: options.hasUI ?? true, mode: options.mode ?? "tui", agent: { kind: "main", name: "main" }, sessionId: options.sessionId ?? "sess-A", idle: options.idle ?? true, ui: scriptedUi({ confirm: [true] }) }),
		{ aborts: 0, intervals: [] as number[], abort() { this.aborts++; } },
	);
	const statuses: (string | undefined)[] = [];
	Object.assign(ctx.ui, { setStatus: (_key: string, text: string | undefined) => void statuses.push(text) });
	const setInterval = ctx.setInterval;
	ctx.setInterval = (callback, ms) => (ctx.intervals.push(ms), setInterval(callback, ms));

	const calls: Rig["calls"] = { claims: [], armed: [], disarmed: 0, released: [], unclaimed: [], saved: [], reads: [], pushes: [], puts: [], putSignals: [], dirs: [], gitPushes: [], creates: [], open: 0, mostOpen: 0 };
	const answers: Rig["answers"] = { snapshots: [snap()], steps: [], claim: null, put: PR, putFiles: [], confirmed: null, renew: "held", branch: "feat/x", dirty: "", armError: null, listed: [], ahead: "", readMs: 0 };
	const holds = { read: [] as Promise<void>[], git: [] as Promise<void>[], list: [] as Promise<void>[], user: [] as Promise<void>[], push: [] as Promise<void>[] };

	const parts: ShipParts = {
		now: () => clock.now,
		platform: options.platform ?? "darwin",
		git: async (dir, args) => {
			calls.dirs.push(dir);
			const key = args.join(" ");
			if (key === "rev-parse --show-toplevel") return { code: 0, out: `${ROOT}\n`, err: "" };
			if (key === "remote get-url origin") return { code: 0, out: "git@github.com:tung-dnt/sandbox.git\n", err: "" };
			if (key === "symbolic-ref --short -q HEAD") return { code: 0, out: `${answers.branch}\n`, err: "" };
			if (key === "symbolic-ref -q refs/remotes/origin/HEAD") return { code: 0, out: "refs/remotes/origin/main\n", err: "" };
			if (key === "status --porcelain -z") {
				await holds.git.shift();
				return { code: 0, out: answers.dirty, err: "" };
			}
			// The commits beyond main that put-up lists when the branch has no PR yet.
			if (args[0] === "log" && args[1] === "--reverse") return { code: 0, out: answers.ahead, err: "" };
			if (args[0] === "push") {
				calls.gitPushes.push(key);
				await holds.push.shift();
			}
			return { code: 0, out: "", err: "" };
		},
		ghFor: () => async args => {
			if (args.join(" ") === "api user --jq .login") {
				await holds.user.shift();
				return { code: 0, out: "tung-dnt\n", err: "" };
			}
			if (args[0] === "pr" && args[1] === "list") {
				await holds.list.shift();
				return { code: 0, out: JSON.stringify(answers.listed), err: "" };
			}
			if (args[0] === "pr" && args[1] === "create") {
				calls.creates.push(args.join(" "));
				return { code: 0, out: `${URL}\n`, err: "" };
			}
			return { code: 1, out: "", err: "unexpected gh call" };
		},
		sshHostname: () => null,
		parseTarget: arg => (arg === null ? { owner: "tung-dnt", repo: "sandbox" } : /^\d+$/.test(arg) ? { ...PR, number: Number(arg) } : `"${arg}" is not a PR number`),
		readPr: async (_pr, _gh, trust) => {
			calls.reads.push({ trust });
			const answer = (answers.snapshots.length > 1 ? answers.snapshots.shift() : answers.snapshots[0]) as Snapshot | string | Error;
			const hold = holds.read.shift();
			calls.mostOpen = Math.max(calls.mostOpen, ++calls.open);
			try {
				await hold;
				clock.now += answers.readMs;
				if (answer instanceof Error) throw answer;
				return answer;
			} finally {
				calls.open--;
			}
		},
		putUp: async (root, deps) => {
			calls.puts.push({ root, confirm: deps.confirm !== undefined });
			calls.putSignals.push(deps.signal);
			if (deps.confirm && answers.putFiles.length > 0) answers.confirmed = await deps.confirm(answers.putFiles);
			return answers.put as typeof PR | string;
		},
		nextStep: () => answers.steps.shift() ?? { kind: "wait", until: clock.now + 600_000 },
		claimWatch: (pr, start) => {
			calls.claims.push({ pr, start });
			return answers.claim ?? watchOf();
		},
		renewClaim: (watch, now) => (answers.renew === "taken" ? null : { ...watch, owner: { ...watch.owner, heartbeat: now } }),
		releaseWatch: (_watch, reason) => void calls.released.push({ reason }),
		unclaimWatch: watch => void calls.unclaimed.push(watch),
		saveWatch: watch => void calls.saved.push(watch),
		recordPass: (watch, snapshot, now) => ({ ...watch, lastPassAt: now, lastHash: snapshot.hash, nextAt: now + SHIP.quietMs, passes: [...watch.passes, now] }),
		recordPush: (watch, cause, now) => {
			calls.pushes.push(cause);
			return { ...watch, lastPushAt: now, nextAt: now + SHIP.afterPushMs, pushesPerCause: { ...watch.pushesPerCause, [cause]: (watch.pushesPerCause[cause] ?? 0) + 1 } };
		},
		armFence: watch => {
			if (answers.armError) throw new Error(answers.armError);
			calls.armed.push(watch);
		},
		disarmFence: () => void calls.disarmed++,
		rules: () => "RULES OF THE PASS",
	};
	// With `real`, story 3's engine decides and keeps the watch file; only reading the PR and the fence stay fakes.
	createShip({ ...parts, ...(options.real ? { claimWatch, nextStep, recordPass, recordPush, releaseWatch, renewClaim, saveWatch, unclaimWatch } : {}), ...(options.realPutUp ? { putUp } : {}) })(fake.pi);

	return {
		fake,
		ctx,
		statuses,
		sent,
		calls,
		answers,
		clock,
		hold(what = "read") {
			const { promise, resolve } = Promise.withResolvers<void>();
			holds[what].push(promise);
			return resolve;
		},
		cmd: (args, on = ctx) => fake.runCommand("ship", args, on),
		async tick(minutes = SHIP.tickMs / 60_000) {
			clock.now += minutes * 60_000;
			ctx.tick();
			await settled();
		},
		async finishTurn(text, extra = {}) {
			fake.emit("agent_end", { type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text }] }], ...extra }, ctx);
			await settled();
		},
		report: (file = "report.json") => JSON.parse(fs.readFileSync(path.join(privateHome(), file), "utf8")) as Report,
	};
}

const lastMessage = (t: Rig, ctx = t.ctx) => ctx.ui.notifications.at(-1)?.message ?? "";

beforeEach(() => {
	resetHome();
	delete process.env.OMP_STARTER_UNATTENDED;
});
afterEach(() => {
	delete process.env.OMP_STARTER_UNATTENDED;
});

describe("starting a watch", () => {
	test("claims the PR, arms the fence on its branch and starts the timer", async () => {
		const t = rig();
		await t.cmd("12");
		expect(t.calls.claims).toEqual([{ pr: PR, start: { baseRef: "main", headRef: "feat/x", session: "sess-A", pid: process.pid, now: T0 } }]);
		expect(t.calls.armed).toEqual([{ pushBranch: "feat/x", root: ROOT }]);
		expect(t.ctx.timers.size).toBe(1);
		expect(t.ctx.intervals).toEqual([SHIP.tickMs]);
	});

	test("the first pass carries the rules, the snapshot and the files the user changed", async () => {
		const t = rig();
		t.answers.steps = [{ kind: "pass", why: "first read of this PR" }];
		t.answers.dirty = " M notes.txt\0?? scratch.md\0";
		await t.cmd("12");
		expect(t.sent).toHaveLength(1);
		const { message, options } = t.sent[0] as Rig["sent"][0];
		expect(options).toEqual({ triggerTurn: true });
		expect(message.customType).toBe("ship-pass");
		expect(message.content).toContain("Ship pass 1 on tung-dnt/sandbox#12: first read of this PR.");
		expect(message.content).toContain("RULES OF THE PASS");
		expect(message.content).toContain(URL);
		expect(message.content).toContain("notes.txt, scratch.md");
		expect(message.content).not.toContain("Nobody answers questions");
		expect(t.statuses.at(-1)).toBe("ship #12: pass 1 running");
	});

	test("bots named with +bot reach the trust filter", async () => {
		const t = rig();
		await t.cmd("12 +coderabbit +github-actions");
		expect(t.calls.reads[0]?.trust).toEqual({ me: "tung-dnt", bots: ["coderabbit", "github-actions"] });
	});
});

describe("the timer", () => {
	test("reads the PR every tick but sends a pass only when nextStep says so", async () => {
		const t = rig();
		t.answers.steps = [PASS];
		await t.cmd("12");
		await t.finishTurn("Pushed a fix.\nSHIP-STATUS: working: pushed");
		const reads = t.calls.reads.length;
		for (let i = 0; i < 5; i++) await t.tick();
		expect(t.sent).toHaveLength(1);
		expect(t.calls.reads).toHaveLength(reads + 5);
		t.answers.steps = [PASS];
		await t.tick();
		expect(t.sent).toHaveLength(2);
		expect(t.sent[1]?.message.content).toContain("Ship pass 2");
	});

	test("a pass never starts on top of one that hasn't ended, even when the session looks idle", async () => {
		const t = rig();
		t.answers.steps = [PASS];
		await t.cmd("12");
		t.answers.steps = [PASS];
		await t.tick();
		expect(t.sent).toHaveLength(1);
		await t.finishTurn("Waiting on a background job.", { willContinue: true });
		t.answers.steps = [PASS];
		await t.tick();
		expect(t.sent).toHaveLength(1);
		expect(t.statuses.at(-1)).toBe("ship #12: pass 1 running");
		// A turn whose end never came stops counting after a while.
		t.answers.steps = [PASS];
		await t.tick(31);
		expect(t.sent).toHaveLength(2);
	});

	test("a due pass waits while the session is busy and is sent once when it is idle", async () => {
		const t = rig();
		await t.cmd("12");
		t.ctx.idle = false;
		t.answers.steps = [PASS];
		await t.tick();
		expect(t.sent).toHaveLength(0);
		expect(t.calls.saved.some(w => w.passes.length > 0)).toBe(false);
		t.ctx.idle = true;
		t.answers.steps = [PASS];
		await t.tick();
		expect(t.sent).toHaveLength(1);
	});

	test("a push by a pass is counted once for each failing check name and for the conflict", async () => {
		const t = rig();
		t.answers.snapshots = [snap({ checks: [...failing, ...failing], mergeable: "CONFLICTING", hash: "h1" })];
		t.answers.steps = [PASS];
		await t.cmd("12");
		t.answers.snapshots = [snap({ headSha: "b".repeat(40), checks: failing, hash: "h2" })];
		await t.tick();
		expect(t.calls.pushes).toEqual(["check:test", "conflict"]);
		await t.tick();
		expect(t.calls.pushes).toHaveLength(2);
	});

	test("a push for comments counts as feedback, and a cause at the cap is named in the next pass", async () => {
		const t = rig();
		t.answers.claim = watchOf({ pushesPerCause: { "check:test": 3, feedback: 5 } });
		t.answers.snapshots = [snap({ checks: failing })];
		t.answers.steps = [PASS];
		await t.cmd("12");
		const prompt = t.sent[0]?.message.content ?? "";
		expect(prompt).toContain("check:test 3, feedback 5");
		expect(prompt).toContain("At the cap, so don't push for these again; bring them to the user: check:test.");
		await t.finishTurn("Fixed the check.\nSHIP-STATUS: working: pushed");
		t.answers.snapshots = [snap({ headSha: "c".repeat(40), hash: "h3" })];
		await t.tick();
		t.answers.steps = [PASS];
		t.answers.snapshots = [snap({ headSha: "c".repeat(40), hash: "h4" })];
		await t.tick();
		await t.finishTurn("Answered the comment.\nSHIP-STATUS: working: pushed");
		t.answers.snapshots = [snap({ headSha: "e".repeat(40), hash: "h5" })];
		await t.tick();
		expect(t.calls.pushes).toEqual(["check:test", "feedback"]);
	});

	test("comments from people without write access are mentioned once", async () => {
		const t = rig();
		t.answers.snapshots = [snap({ untrusted: 2 })];
		await t.cmd("12");
		await t.tick();
		const told = t.ctx.ui.notifications.filter(n => n.message.includes("without write access"));
		expect(told).toHaveLength(1);
		expect(told[0]?.message).toContain("2 comment(s)");
		expect(t.calls.saved.at(-1)?.told).toContain("untrusted");
	});

	test("an unreadable PR is retried on the next tick and the claim stays alive", async () => {
		const t = rig();
		await t.cmd("12");
		t.answers.snapshots = ["gh pr view failed: HTTP 502"];
		await t.tick();
		expect(t.statuses.at(-1)).toBe("ship #12: watching");
		t.answers.snapshots = [snap()];
		await t.tick();
		expect(t.calls.reads).toHaveLength(3);
		expect(t.ctx.timers.size).toBe(1);
	});

	test("a read that throws shows on the status line, and the next tick tries again", async () => {
		const t = rig();
		await t.cmd("12 --report report.json");
		t.answers.snapshots = [new Error("socket hang up")];
		await t.tick();
		expect(t.report().lastLine).toBe("tick failed: socket hang up");
		t.answers.snapshots = [snap()];
		await t.tick();
		expect(t.calls.reads).toHaveLength(3);
		expect(t.ctx.timers.size).toBe(1);
	});
});

describe("reading the PR never holds the watch up", () => {
	test("a tick that finds the last read still out does nothing, so reads never pile up", async () => {
		const t = rig();
		await t.cmd("12");
		const release = t.hold();
		await t.tick();
		const reads = t.calls.reads.length;
		await t.tick();
		await t.tick();
		expect(t.calls.reads).toHaveLength(reads);
		expect(t.calls.open).toBe(1);
		release();
		await settled();
		expect(t.calls.open).toBe(0);
		await t.tick();
		expect(t.calls.reads).toHaveLength(reads + 1);
		expect(t.calls.mostOpen).toBe(1);
	});

	test("a watch stopped while a read is out stays stopped when the read comes back", async () => {
		const t = rig();
		await t.cmd("12");
		t.answers.steps = [PASS];
		const release = t.hold();
		await t.tick();
		await t.cmd("stop");
		const saved = t.calls.saved.length;
		release();
		await settled();
		expect(t.sent).toEqual([]);
		expect(t.statuses.at(-1)).toBeUndefined();
		expect(t.calls.saved).toHaveLength(saved);
		expect(t.answers.steps).toEqual([PASS]);
	});

	test("a pass that was due is not sent if the watch was stopped while git listed the files the user changed", async () => {
		const t = rig();
		t.answers.steps = [PASS];
		const release = t.hold("git");
		const starting = t.cmd("12");
		await settled();
		await t.cmd("stop");
		release();
		await starting;
		expect(t.sent).toEqual([]);
		expect(t.calls.released).toEqual([{ reason: "stopped" }]);
	});

	test("a pass's re-read that comes back after the watch was stopped leaves the stopped watch alone", async () => {
		const t = rig({ real: true });
		await t.cmd("12 --report report.json");
		const release = t.hold();
		await t.finishTurn("Fixed it.\nSHIP-STATUS: working: pushed");
		await t.cmd("stop");
		release();
		await settled();
		expect(loadWatch(PR)?.owner.heartbeat).toBe(0);
		expect(t.statuses.at(-1)).toBeUndefined();
		expect(t.report()).toMatchObject({ state: "ended", reason: "stopped" });
	});

	test("a read that fails after the watch was stopped leaves the stopped watch alone too", async () => {
		const t = rig();
		await t.cmd("12 --report report.json");
		t.answers.snapshots = [new Error("socket hang up")];
		const release = t.hold();
		await t.tick();
		await t.cmd("stop");
		release();
		await settled();
		expect(t.statuses.at(-1)).toBeUndefined();
		expect(t.report()).toMatchObject({ state: "ended", reason: "stopped" });
	});

	test("a read that began before a pass ended is dropped, so it can't start the next pass from before that pass's own push", async () => {
		const t = rig();
		t.answers.steps = [PASS];
		await t.cmd("12");
		const release = t.hold();
		await t.tick();
		t.answers.steps = [PASS];
		await t.finishTurn("Fixed it.\nSHIP-STATUS: working: pushed");
		release();
		await settled();
		expect(t.sent).toHaveLength(1);
		expect(t.answers.steps).toEqual([PASS]);
	});

	test("while a pass's own re-read is out, a tick doesn't judge the PR against the old baseline", async () => {
		const t = rig({ real: true });
		t.answers.snapshots = [snap({ comments: [note("c1", "reviewer")], hash: "asked" })];
		await t.cmd("12");
		t.answers.snapshots = [snap({ comments: [note("c1", "reviewer"), note("c2", "tung-dnt", true)], hash: "answered" })];
		const release = t.hold();
		await t.finishTurn("Answered.\nSHIP-STATUS: working: answered");
		await t.tick(30);
		expect(t.calls.reads).toHaveLength(2);
		release();
		await settled();
		expect(loadWatch(PR)?.lastHash).toBe("answered");
		await t.tick();
		expect(t.sent).toHaveLength(1);
	});

	test("a pass's end is not waited for: the handler returns first, and the verdict follows the re-read", async () => {
		const t = rig();
		t.answers.steps = [PASS];
		await t.cmd("12 --report report.json");
		const release = t.hold();
		const text = "Found a security issue.\nSHIP-STATUS: needs-you: a security finding";
		const returned = t.fake.emit("agent_end", { type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text }] }] }, t.ctx);
		await settled();
		expect(returned).toBeUndefined();
		expect(t.report()).toMatchObject({ state: "working", lastLine: "pass 1 sent: the PR changed since the last pass" });
		release();
		await settled();
		expect(t.report()).toMatchObject({ state: "needs-you", waitingFor: "a security finding" });
	});

	test("a /ship that is still starting makes a second one wait, so only one watch starts", async () => {
		const t = rig();
		const release = t.hold();
		const first = t.cmd("12");
		await settled();
		await t.cmd("13");
		expect(lastMessage(t)).toBe("/ship: another /ship is still starting; run it again in a moment");
		expect(t.ctx.ui.notifications.at(-1)?.type).toBe("warning");
		release();
		await first;
		expect(t.calls.claims).toHaveLength(1);
		expect(t.ctx.timers.size).toBe(1);
	});
});

describe("a /ship that is still starting can be stopped", () => {
	test("without a stop, a branch with a commit beyond main and nothing to confirm is pushed, put up and watched", async () => {
		const t = rig({ real: true, realPutUp: true });
		t.answers.ahead = "a1b2c3d feat: x\n";
		await t.cmd("");
		expect(t.calls.gitPushes).toEqual(["push origin feat/x"]);
		expect(t.calls.creates).toHaveLength(1);
		expect(t.ctx.timers.size).toBe(1);
	});

	test("/ship stop cancels it: nothing is claimed, armed or watched, and the stop is the only word said", async () => {
		const t = rig();
		const release = t.hold();
		const starting = t.cmd("12");
		await settled();
		await t.cmd("stop");
		expect(lastMessage(t)).toBe("Stopped the /ship that was still starting.");
		release();
		await starting;
		expect(t.calls.claims).toEqual([]);
		expect(t.calls.armed).toEqual([]);
		expect(t.ctx.timers.size).toBe(0);
		expect(t.statuses).toEqual([]);
		expect(t.ctx.ui.notifications).toHaveLength(1);
	});

	test("a put-up is given the start's signal, aborted by /ship stop", async () => {
		const t = rig();
		t.answers.putFiles = ["src/a.ts"];
		t.ctx.ui.confirm = (_title, _message, options?: { signal?: AbortSignal }) => {
			const answer = Promise.withResolvers<boolean>();
			options?.signal?.addEventListener("abort", () => answer.resolve(false));
			return answer.promise;
		};
		const starting = t.cmd("");
		await settled();
		const [signal] = t.calls.putSignals;
		expect(signal?.aborted).toBe(false);
		await t.cmd("stop");
		expect(signal?.aborted).toBe(true);
		await starting;
	});

	test("a second /ship waits until the stopped one has unwound, then runs", async () => {
		const t = rig();
		const release = t.hold();
		const starting = t.cmd("12");
		await settled();
		await t.cmd("stop");
		await t.cmd("12");
		expect(lastMessage(t)).toBe("/ship: another /ship is still starting; run it again in a moment");
		release();
		await starting;
		await t.cmd("12");
		expect(t.calls.claims).toHaveLength(1);
		expect(t.ctx.timers.size).toBe(1);
	});

	test("stopping while a rerun on the same PR is starting ends the old watch and cancels the rerun", async () => {
		const t = rig();
		await t.cmd("12");
		const release = t.hold();
		const rerun = t.cmd("12");
		await settled();
		await t.cmd("stop");
		release();
		await rerun;
		expect(t.calls.claims).toHaveLength(1);
		expect(t.calls.armed).toHaveLength(1);
		expect(t.calls.released).toEqual([{ reason: "stopped" }]);
		expect(t.ctx.timers.size).toBe(0);
	});

	test.each(["session_shutdown", "session_switch", "session_clear", "session_start"])("%s cancels it too, without a word to the session that is gone", async event => {
		const t = rig();
		const release = t.hold();
		const starting = t.cmd("12");
		await settled();
		t.fake.emit(event, {}, t.ctx);
		release();
		await starting;
		expect(t.calls.claims).toEqual([]);
		expect(t.calls.armed).toEqual([]);
		expect(t.ctx.timers.size).toBe(0);
		expect(t.ctx.ui.notifications).toEqual([]);
	});

	test("a stop after put-up claimed the PR gives the claim back, and the fence is never armed", async () => {
		const t = rig({ real: true, realPutUp: true });
		t.answers.listed = [listed];
		const release = t.hold();
		const starting = t.cmd("");
		await settled();
		// Claimed before the push, and still held while the PR is read.
		expect(loadWatch(PR)?.owner.heartbeat).toBe(T0);
		expect(t.calls.gitPushes).toEqual(["push origin feat/x"]);
		await t.cmd("stop");
		release();
		await starting;
		expect(loadWatch(PR)).toBeNull();
		expect(t.calls.armed).toEqual([]);
		expect(t.ctx.timers.size).toBe(0);
	});

	test("a stop that comes before put-up has found the PR keeps it from claiming or pushing", async () => {
		const t = rig({ real: true, realPutUp: true });
		t.answers.listed = [listed];
		const release = t.hold("list");
		const starting = t.cmd("");
		await settled();
		await t.cmd("stop");
		release();
		await starting;
		expect(t.calls.gitPushes).toEqual([]);
		expect(loadWatch(PR)).toBeNull();
		expect(t.calls.armed).toEqual([]);
	});

	test("a stop that comes before put-up starts keeps it from pushing or opening a PR", async () => {
		const t = rig({ real: true, realPutUp: true });
		t.answers.ahead = "a1b2c3d feat: x\n";
		const release = t.hold("user");
		const starting = t.cmd("");
		await settled();
		await t.cmd("stop");
		release();
		await starting;
		expect(t.calls.gitPushes).toEqual([]);
		expect(t.calls.creates).toEqual([]);
		expect(t.calls.armed).toEqual([]);
	});

	test("a stop that comes while put-up pushes ends the start before the PR is read, and gives the claim back", async () => {
		const t = rig({ real: true, realPutUp: true });
		t.answers.listed = [listed];
		const release = t.hold("push");
		const starting = t.cmd("");
		await settled();
		expect(t.calls.gitPushes).toEqual(["push origin feat/x"]);
		await t.cmd("stop");
		release();
		await starting;
		expect(t.calls.reads).toEqual([]);
		expect(loadWatch(PR)).toBeNull();
		expect(t.calls.armed).toEqual([]);
	});

	test("/ship stop closes the confirm a starting /ship is waiting on, so the dialog doesn't outlive it", async () => {
		const t = rig();
		t.answers.putFiles = ["src/a.ts"];
		let dialog: AbortSignal | undefined;
		t.ctx.ui.confirm = (_title, _message, options?: { signal?: AbortSignal }) => {
			dialog = options?.signal;
			const answer = Promise.withResolvers<boolean>();
			dialog?.addEventListener("abort", () => answer.resolve(false));
			return answer.promise;
		};
		const starting = t.cmd("");
		await settled();
		expect(dialog?.aborted).toBe(false);
		await t.cmd("stop");
		expect(dialog?.aborted).toBe(true);
		await starting;
		expect(t.answers.confirmed).toBe(false);
		expect(t.calls.claims).toEqual([]);
		expect(t.calls.armed).toEqual([]);
		expect(t.ctx.ui.notifications).toHaveLength(1);
	});

	test("a ship_start call that is stopped fails with the reason", async () => {
		process.env.OMP_STARTER_UNATTENDED = "1";
		const t = rig();
		const release = t.hold();
		const failure = t.fake.callTool("ship_start", {}, t.ctx).then(
			() => null,
			(error: Error) => error,
		);
		await settled();
		await t.cmd("stop");
		release();
		expect((await failure)?.message).toBe("/ship: stopped before it started watching");
		expect(t.calls.armed).toEqual([]);
	});
});

describe("ending", () => {
	test("a merged PR disarms the fence, releases the claim and stops the timer", async () => {
		const t = rig();
		await t.cmd("12 --report report.json");
		t.answers.steps = [{ kind: "end", reason: "merged" }];
		await t.tick();
		expect(t.calls.disarmed).toBe(1);
		expect(t.calls.released).toEqual([{ reason: "merged" }]);
		expect(t.ctx.timers.size).toBe(0);
		expect(t.statuses.at(-1)).toBeUndefined();
		expect(t.report()).toMatchObject({ state: "ended", reason: "merged", pr: URL, waitingFor: null });
		const reads = t.calls.reads.length;
		await t.tick();
		expect(t.calls.reads).toHaveLength(reads);
		await t.cmd("status");
		expect(lastMessage(t)).toBe("No /ship watch in this session.");
	});

	test("/ship stop ends the watch without a notification", async () => {
		const t = rig();
		await t.cmd("12");
		await t.cmd("stop");
		expect(t.calls.disarmed).toBe(1);
		expect(t.calls.released).toEqual([{ reason: "stopped" }]);
		expect(t.ctx.timers.size).toBe(0);
		expect(t.fake.execCalls).toHaveLength(0);
		expect(lastMessage(t)).toBe("Stopped watching PR #12.");
	});

	test("stopping a watch aborts the pass that is still running", async () => {
		const t = rig();
		t.answers.steps = [PASS];
		await t.cmd("12");
		await t.cmd("stop");
		expect(t.ctx.aborts).toBe(1);
	});

	test("a merge tells you with a desktop notification", async () => {
		const t = rig();
		await t.cmd("12");
		t.answers.steps = [{ kind: "end", reason: "merged" }];
		await t.tick();
		expect(t.fake.execCalls).toHaveLength(1);
		expect(t.fake.execCalls[0]?.args[1]).toContain("PR #12 merged");
	});

	test("the pass cap needs you once each time it is hit, keeps reading, and lifts when passes age out", async () => {
		const t = rig();
		await t.cmd("12 --report report.json");
		const cap: Step = { kind: "end", reason: "spend_cap" };
		t.answers.steps = [cap, cap, cap];
		for (let i = 0; i < 3; i++) await t.tick();
		expect(t.calls.released).toEqual([]);
		expect(t.ctx.timers.size).toBe(1);
		expect(t.report()).toMatchObject({ state: "needs-you", reason: null });
		expect(t.report().waitingFor).toContain("24 passes");
		expect(t.calls.saved.at(-1)?.told).toContain("spend_cap");
		expect(t.fake.execCalls).toHaveLength(1);
		await t.tick();
		expect(t.report().state).toBe("watching");
		expect(t.calls.saved.at(-1)?.told).not.toContain("spend_cap");
		t.answers.steps = [cap];
		await t.tick();
		expect(t.fake.execCalls).toHaveLength(2);
	});

	test("a claim taken by another session ends the watch here", async () => {
		const t = rig();
		await t.cmd("12");
		t.answers.renew = "taken";
		await t.tick();
		expect(t.calls.released).toEqual([{ reason: "taken_over" }]);
		expect(t.ctx.timers.size).toBe(0);
	});

	test("the session ending ends the watch without aborting anything", async () => {
		for (const event of ["session_shutdown", "session_switch", "session_clear", "session_start"]) {
			const t = rig();
			t.answers.steps = [PASS];
			await t.cmd("12");
			t.fake.emit(event, {}, t.ctx);
			expect(t.calls.released).toEqual([{ reason: "stopped" }]);
			expect(t.calls.disarmed).toBe(1);
			expect(t.ctx.aborts).toBe(0);
			expect(t.ctx.timers.size).toBe(0);
		}
	});
});

describe("refusals leave nothing behind", () => {
	const nothingStarted = (t: Rig) => {
		expect(t.calls.armed).toEqual([]);
		expect(t.calls.disarmed).toBe(0);
		expect(t.ctx.timers.size).toBe(0);
		expect(t.sent).toEqual([]);
	};

	test("a second session is refused with the reason the watch part gives", async () => {
		const t = rig();
		t.answers.claim = "tung-dnt/sandbox#12 is already watched by session sess-B (pid 4242); run /ship stop there first";
		await t.cmd("12");
		expect(lastMessage(t)).toBe("/ship: tung-dnt/sandbox#12 is already watched by session sess-B (pid 4242); run /ship stop there first");
		expect(t.ctx.ui.notifications.at(-1)?.type).toBe("error");
		nothingStarted(t);
	});

	test.each([
		["a PR someone else opened", () => ({ snapshots: [snap({ author: "someone" })] }), "was opened by someone"],
		["a checkout on another branch", () => ({ branch: "main" }), "this checkout is on main, but tung-dnt/sandbox#12 is feat/x"],
		["a merged PR", () => ({ snapshots: [snap({ state: "MERGED" })] }), "is merged; nothing to watch"],
		["an unreadable PR", () => ({ snapshots: ["gh pr view failed"] }), "gh pr view failed"],
		["a PR number that isn't one", () => ({}), '"abc" is not a PR number'],
	])("%s", async (_name, change, why) => {
		const t = rig();
		Object.assign(t.answers, change());
		await t.cmd(why.includes("abc") ? "abc" : "12");
		expect(lastMessage(t)).toContain(why);
		expect(t.calls.claims).toEqual([]);
		nothingStarted(t);
	});

	test("a merged PR is a warning, not an error", async () => {
		const t = rig();
		t.answers.snapshots = [snap({ state: "MERGED" })];
		await t.cmd("12");
		expect(t.ctx.ui.notifications.at(-1)?.type).toBe("warning");
		nothingStarted(t);
	});

	test("a session that exits after one prompt can't watch", async () => {
		const t = rig({ mode: "print" });
		await t.cmd("12");
		expect(lastMessage(t)).toContain("stays open");
		nothingStarted(t);
	});

	test("a missing fence releases the claim instead of watching unfenced", async () => {
		const t = rig();
		t.answers.armError = "ship fence: the ship-fence extension is not loaded in this session";
		await t.cmd("12");
		expect(t.calls.unclaimed).toHaveLength(1);
		expect(t.calls.released).toEqual([]);
		expect(lastMessage(t)).toContain("not loaded");
		expect(t.ctx.timers.size).toBe(0);
	});

	test("bad arguments print the usage", async () => {
		const t = rig();
		await t.cmd("12 --verbose");
		expect(lastMessage(t)).toContain("unknown option --verbose");
		expect(lastMessage(t)).toContain("/ship stop");
		nothingStarted(t);
	});
});

describe("running it again", () => {
	test("a second PR is refused while one is watched", async () => {
		const t = rig();
		await t.cmd("12");
		await t.cmd("13");
		expect(lastMessage(t)).toContain("already watching tung-dnt/sandbox#12");
		expect(t.calls.claims).toHaveLength(1);
		expect(t.ctx.timers.size).toBe(1);
	});

	test("the same PR starts the watch over with one timer", async () => {
		const t = rig();
		await t.cmd("12");
		await t.cmd("12");
		expect(t.calls.claims).toHaveLength(2);
		expect(t.calls.released).toEqual([{ reason: "stopped" }]);
		expect(t.ctx.timers.size).toBe(1);
	});

	test("/ship status says what it watches", async () => {
		const t = rig();
		t.answers.steps = [PASS];
		await t.cmd("12");
		await t.cmd("status");
		const text = lastMessage(t);
		expect(text).toContain(`Watching tung-dnt/sandbox#12 (${URL}): pass 1 running`);
		expect(text).toContain("Passes: 1 this session, 1 of 24 in the last 24 hours.");
	});
});

describe("a second /ship on a PR another session watches", () => {
	test("is refused before put-up pushes anything, and names the session that holds the PR", async () => {
		const first = rig({ real: true, sessionId: "sess-A" });
		const second = rig({ real: true, realPutUp: true, sessionId: "sess-B" });
		second.answers.listed = [listed];
		await first.cmd("12");
		await second.cmd("");
		expect(lastMessage(second)).toContain("already watched by session sess-A");
		expect(second.calls.gitPushes).toEqual([]);
		expect(second.calls.armed).toEqual([]);
		expect(second.ctx.timers.size).toBe(0);
		expect(loadWatch(PR)?.owner.session).toBe("sess-A");
	});

	test("pushes the branch and watches once the first session has let go", async () => {
		const first = rig({ real: true, sessionId: "sess-A" });
		const second = rig({ real: true, realPutUp: true, sessionId: "sess-B" });
		second.answers.listed = [listed];
		await first.cmd("12");
		await first.cmd("stop");
		await second.cmd("");
		expect(second.calls.gitPushes).toEqual(["push origin feat/x"]);
		expect(second.ctx.timers.size).toBe(1);
		expect(loadWatch(PR)?.owner.session).toBe("sess-B");
	});

	test("two sessions starting within one read can't both push: the first to find the PR claims it before it pushes", async () => {
		const first = rig({ real: true, realPutUp: true, sessionId: "sess-A" });
		const second = rig({ real: true, realPutUp: true, sessionId: "sess-B" });
		first.answers.listed = second.answers.listed = [listed];
		const release = first.hold();
		const starting = first.cmd("");
		await settled();
		await second.cmd("");
		expect(lastMessage(second)).toContain("already watched by session sess-A");
		expect(second.calls.gitPushes).toEqual([]);
		expect(second.calls.armed).toEqual([]);
		release();
		await starting;
		expect(first.calls.gitPushes).toEqual(["push origin feat/x"]);
		expect(first.ctx.timers.size).toBe(1);
		expect(loadWatch(PR)?.owner.session).toBe("sess-A");
	});

	test("a start that is refused after put-up claimed the PR leaves no claim and no file behind", async () => {
		const first = rig({ real: true, realPutUp: true, sessionId: "sess-A" });
		first.answers.listed = [listed];
		first.answers.snapshots = ["gh pr view failed: HTTP 502"];
		await first.cmd("");
		expect(lastMessage(first)).toContain("HTTP 502");
		expect(loadWatch(PR)).toBeNull();
		const second = rig({ real: true, sessionId: "sess-B" });
		await second.cmd("12");
		expect(second.ctx.timers.size).toBe(1);
		expect(loadWatch(PR)?.owner.session).toBe("sess-B");
	});

	test("a refused start over a saved watch gives the claim back but keeps what GitHub can't hold", async () => {
		saveWatch(watchOf({ told: ["reviewed"], pushesPerCause: { "check:test": 2 }, owner: { session: "sess-A", pid: process.pid, heartbeat: 0 } }));
		const first = rig({ real: true, realPutUp: true, sessionId: "sess-A" });
		first.answers.listed = [listed];
		first.answers.snapshots = ["gh pr view failed: HTTP 502"];
		await first.cmd("");
		expect(loadWatch(PR)).toMatchObject({ told: ["reviewed"], pushesPerCause: { "check:test": 2 }, owner: { session: "sess-A", heartbeat: 0 } });
	});
});

describe("putting the branch up", () => {
	test("with no PR named it puts up, reviews first, then triages the review in the first pass", async () => {
		const t = rig();
		t.answers.steps = [PASS];
		await t.cmd("");
		expect(t.calls.puts).toEqual([{ root: ROOT, confirm: true }]);
		expect(t.sent).toHaveLength(1);
		// A follow-up, not a steer: sent from inside the ship_start tool, a steer would background that tool call (#9).
		expect(t.sent[0]?.options).toEqual({ triggerTurn: true, deliverAs: "followUp" });
		const review = t.sent[0]?.message.content ?? "";
		expect(review).toContain("skill://interrogate");
		expect(review).toContain("origin/main...HEAD");
		expect(review).toContain("Report only");
		expect(t.calls.saved.at(-1)?.told).toContain("reviewed");
		t.ctx.idle = false;
		await t.tick();
		expect(t.sent).toHaveLength(1);
		await t.finishTurn("Findings: none.\nSHIP-STATUS: working: reviewed");
		t.ctx.idle = true;
		t.answers.steps = [PASS];
		await t.tick();
		expect(t.sent).toHaveLength(2);
		expect(t.sent[1]?.message.content).toContain("first pass since the review");
	});

	test("a watch that already holds its review doesn't run it again", async () => {
		const t = rig();
		t.answers.claim = watchOf({ told: ["reviewed"] });
		await t.cmd("");
		expect(t.sent).toEqual([]);
		expect(t.calls.reads).toHaveLength(1);
	});

	test("a refusal from put-up is shown and nothing starts", async () => {
		const t = rig();
		t.answers.put = "put-up refused: main is the default branch";
		await t.cmd("");
		expect(lastMessage(t)).toBe("/ship: put-up refused: main is the default branch");
		expect(t.calls.claims).toEqual([]);
		expect(t.calls.armed).toEqual([]);
	});

	test("an interactive session is asked once about the files, with the list", async () => {
		const t = rig();
		t.answers.putFiles = ["src/a.ts", "src/b.ts"];
		await t.cmd("");
		expect(t.ctx.ui.prompts).toEqual([{ kind: "confirm", title: "Commit these files and open a draft PR?", detail: "src/a.ts\nsrc/b.ts" }]);
		expect(t.answers.confirmed).toBe(true);
	});
});

describe("a review that can't be sent", () => {
	test("ends the watch, releases the claim, disarms the fence and says why", async () => {
		const t = rig();
		Object.assign(t.fake.pi, {
			sendMessage: () => {
				throw new Error("session is closing");
			},
		});
		await t.cmd("");
		expect(t.calls.released).toEqual([{ reason: "stopped" }]);
		expect(t.calls.disarmed).toBe(1);
		expect(lastMessage(t)).toBe("/ship: session is closing");
		expect(t.statuses.at(-1)).toBeUndefined();
		await t.cmd("status");
		expect(lastMessage(t)).toBe("No /ship watch in this session.");
	});
});

describe("an unattended session", () => {
	test("never asks: put-up gets no confirm and nothing is prompted or notified", async () => {
		process.env.OMP_STARTER_UNATTENDED = "1";
		const t = rig();
		t.answers.steps = [PASS];
		await t.cmd("");
		expect(t.calls.puts).toEqual([{ root: ROOT, confirm: false }]);
		expect(t.ctx.ui.prompts).toEqual([]);
		expect(t.sent[0]?.message.content).toContain("review");
		await t.finishTurn("done\nSHIP-STATUS: working: reviewed");
		t.answers.steps = [PASS];
		await t.tick();
		expect(t.sent[1]?.message.content).toContain("Nobody answers questions in this session.");
		await t.finishTurn("Needs a decision.\nSHIP-STATUS: needs-you: a larger ask");
		t.answers.steps = [{ kind: "end", reason: "merged" }];
		await t.tick();
		expect(t.ctx.ui.prompts).toEqual([]);
		expect(t.fake.execCalls).toEqual([]);
	});

	test("a session without a UI doesn't confirm or notify either", async () => {
		const t = rig({ hasUI: false });
		await t.cmd("");
		expect(t.calls.puts).toEqual([{ root: ROOT, confirm: false }]);
		t.answers.steps = [{ kind: "end", reason: "closed" }];
		await t.tick();
		expect(t.fake.execCalls).toEqual([]);
	});
});

describe("the report file", () => {
	test("is rewritten after each pass with the state, PR, last line and what it waits for", async () => {
		const t = rig();
		t.answers.steps = [PASS];
		await t.cmd("12 --report out/ship.json");
		expect(t.report("out/ship.json")).toMatchObject({ state: "working", reason: null, pr: URL, passes: 1, waitingFor: null });
		expect(t.report("out/ship.json").lastLine).toBe("pass 1 sent: the PR changed since the last pass");

		await t.finishTurn("Fixed it.\nSHIP-STATUS: needs-you: a larger ask: split the module");
		expect(t.report("out/ship.json")).toMatchObject({ state: "needs-you", passes: 1, lastLine: "a larger ask: split the module", waitingFor: "a larger ask: split the module" });
		expect(Date.parse(t.report("out/ship.json").updatedAt)).toBe(T0);

		t.answers.steps = [PASS];
		await t.tick();
		await t.finishTurn("All green.\nSHIP-STATUS: ready: undraft it and approve");
		expect(t.report("out/ship.json")).toMatchObject({ state: "ready", passes: 2, waitingFor: "undraft it and approve" });

		t.answers.steps = [PASS];
		await t.tick();
		await t.finishTurn("Looked again.\nSHIP-STATUS: working: checks are running");
		expect(t.report("out/ship.json")).toMatchObject({ state: "watching", waitingFor: null, lastLine: "checks are running" });
	});

	test("a reply without a status line leaves the state at watching and keeps its first line", async () => {
		const t = rig();
		t.answers.steps = [PASS];
		await t.cmd("12 --report report.json");
		await t.finishTurn("I looked at the checks and they are green.\nNothing else.");
		expect(t.report()).toMatchObject({ state: "watching", lastLine: "I looked at the checks and they are green." });
	});

	test("an update from a turn that isn't a pass or that will continue is ignored", async () => {
		const t = rig();
		await t.cmd("12 --report report.json");
		await t.finishTurn("SHIP-STATUS: ready: x");
		expect(t.report().state).toBe("watching");
		t.answers.steps = [PASS];
		await t.tick();
		await t.finishTurn("SHIP-STATUS: ready: x", { willContinue: true });
		expect(t.report().state).toBe("working");
	});
});

describe("notifications", () => {
	test("ready and needs-you notify once each; a repeat stays quiet", async () => {
		const t = rig();
		t.answers.steps = [PASS];
		await t.cmd("12");
		await t.finishTurn("SHIP-STATUS: needs-you: a security finding");
		t.answers.steps = [PASS];
		await t.tick();
		await t.finishTurn("SHIP-STATUS: needs-you: a security finding");
		t.answers.steps = [PASS];
		await t.tick();
		await t.finishTurn("SHIP-STATUS: ready: undraft it");
		const scripts = t.fake.execCalls.map(c => c.args[1] ?? "");
		expect(t.fake.execCalls.every(c => c.command === "osascript")).toBe(true);
		expect(scripts).toHaveLength(2);
		expect(scripts[0]).toContain("PR #12 needs you: a security finding");
		expect(scripts[1]).toContain("PR #12 is ready: undraft it");
	});

	test("nothing is posted off macOS", async () => {
		const t = rig({ platform: "linux" });
		t.answers.steps = [PASS];
		await t.cmd("12");
		await t.finishTurn("SHIP-STATUS: ready: undraft it");
		expect(t.fake.execCalls).toEqual([]);
	});
});

describe("a ready the PR doesn't bear out", () => {
	test.each([
		["a check still running", { checks: [{ name: "test", bucket: "pending" as const, link: null }] }, "1 check is not green"],
		["two failing checks", { checks: [...failing, ...failing] }, "2 checks are not green"],
		["a conflict", { mergeable: "CONFLICTING" as const }, "the PR still has a conflict"],
		["no checks listed right after a push", { headSha: "b".repeat(40) }, "no checks are listed yet after the push"],
		["a cancelled check", { checks: [{ name: "test", bucket: "cancel" as const, link: null }] }, "1 check is not green"],
	])("%s is not ready, so nobody is told it is", async (_name, fresh, why) => {
		const t = rig();
		t.answers.steps = [PASS];
		await t.cmd("12 --report report.json");
		t.answers.snapshots = [snap(fresh)];
		await t.finishTurn("All done.\nSHIP-STATUS: ready: undraft it");
		expect(t.report()).toMatchObject({ state: "watching", waitingFor: null, lastLine: `said ready, but ${why}` });
		expect(t.fake.execCalls).toEqual([]);
	});

	test("a pass whose PR can't be read afterwards is not believed when it says ready", async () => {
		const t = rig();
		t.answers.steps = [PASS];
		await t.cmd("12 --report report.json");
		t.answers.snapshots = ["gh: HTTP 502"];
		await t.finishTurn("All done.\nSHIP-STATUS: ready: undraft it");
		expect(t.report()).toMatchObject({ state: "watching", waitingFor: null, lastLine: "said ready, but couldn't re-read the PR" });
		expect(t.fake.execCalls).toEqual([]);
	});

	test("a pass whose re-read throws is not believed when it says ready either", async () => {
		const t = rig();
		t.answers.steps = [PASS];
		await t.cmd("12 --report report.json");
		t.answers.snapshots = [new Error("socket hang up")];
		await t.finishTurn("All done.\nSHIP-STATUS: ready: undraft it");
		expect(t.report()).toMatchObject({ state: "watching", waitingFor: null, lastLine: "said ready, but couldn't re-read the PR" });
		expect(t.fake.execCalls).toEqual([]);
	});

	test("green checks, or none on a PR nobody pushed, stand", async () => {
		for (const checks of [[{ name: "test", bucket: "pass" as const, link: null }], []]) {
			const t = rig();
			t.answers.steps = [PASS];
			await t.cmd("12 --report report.json");
			t.answers.snapshots = [snap({ checks })];
			await t.finishTurn("All done.\nSHIP-STATUS: ready: undraft it");
			expect(t.report()).toMatchObject({ state: "ready", waitingFor: "undraft it" });
			expect(t.fake.execCalls).toHaveLength(1);
		}
	});
});

describe("with the real watch engine", () => {
	const minutes = (n: number) => T0 + n * 60_000;

	test("a fix is looked at once, again two minutes after its push, then not while nothing changes", async () => {
		const t = rig({ real: true });
		const running = [{ name: "test", bucket: "pending" as const, link: null }];
		t.answers.snapshots = [snap({ checks: failing, hash: "red" })];
		await t.cmd("12");
		await t.finishTurn("Fixed it and pushed.\nSHIP-STATUS: working: pushed");
		// The head moved, so the push is counted; CI needs a moment before anything is worth looking at.
		t.answers.snapshots = [snap({ headSha: "b".repeat(40), checks: running, hash: "running" })];
		await t.tick();
		await t.tick();
		await t.finishTurn("Checks are running.\nSHIP-STATUS: working: checks are running");
		for (let i = 0; i < 14; i++) await t.tick();
		expect(t.sent.map(s => s.at)).toEqual([minutes(0), minutes(4)]);
		t.answers.snapshots = [snap({ headSha: "b".repeat(40), checks: [{ name: "test", bucket: "pass", link: null }], hash: "green" })];
		await t.tick();
		expect(t.sent.map(s => s.at)).toEqual([minutes(0), minutes(4), minutes(34)]);
		expect(t.sent[2]?.message.content).toContain("check:test 1");
	});

	test("the check due two minutes after a push runs on that tick even when GitHub takes seconds to answer", async () => {
		const t = rig({ real: true });
		t.answers.snapshots = [snap({ checks: failing, hash: "red" })];
		await t.cmd("12");
		await t.finishTurn("Fixed it and pushed.\nSHIP-STATUS: working: pushed");
		t.answers.readMs = 3_000;
		const at = async (when: number) => {
			t.clock.now = when;
			t.ctx.tick();
			await settled();
		};
		t.answers.snapshots = [snap({ headSha: "b".repeat(40), checks: [{ name: "test", bucket: "pending", link: null }], hash: "running" })];
		await at(minutes(2));
		expect(t.sent).toHaveLength(1);
		expect(loadWatch(PR)?.lastPushAt).toBe(minutes(2));
		t.answers.readMs = 1_000;
		await at(minutes(4));
		expect(t.sent).toHaveLength(2);
	});

	test("the watch file is kept while it runs, released by a stop and gone after a merge", async () => {
		const t = rig({ real: true });
		await t.cmd("12");
		expect(loadWatch(PR)?.owner).toEqual({ session: "sess-A", pid: process.pid, heartbeat: minutes(0) });
		await t.tick();
		expect(loadWatch(PR)?.owner.heartbeat).toBe(minutes(2));
		await t.cmd("stop");
		expect(loadWatch(PR)?.owner.heartbeat).toBe(0);
		await t.cmd("12");
		t.answers.snapshots = [snap({ state: "MERGED" })];
		await t.tick();
		expect(loadWatch(PR)).toBeNull();
		expect(lastMessage(t)).toBe("PR #12 merged. Stopped watching.");
	});

	test("a second session is refused while the first is alive and takes over when its heartbeat is stale", async () => {
		const a = rig({ real: true, sessionId: "sess-A" });
		const b = rig({ real: true, sessionId: "sess-B" });
		await a.cmd("12");
		await b.cmd("12");
		expect(lastMessage(b)).toContain("already watched by session sess-A");
		expect(b.ctx.timers.size).toBe(0);
		expect(b.calls.armed).toEqual([]);
		b.clock.now = minutes(11);
		await b.cmd("12");
		expect(b.ctx.timers.size).toBe(1);
		expect(loadWatch(PR)?.owner.session).toBe("sess-B");
		await a.tick(13);
		expect(a.calls.disarmed).toBe(1);
		expect(a.ctx.timers.size).toBe(0);
		expect(lastMessage(a)).toBe("Another session took over the watch of PR #12. Stopped here.");
		expect(loadWatch(PR)?.owner.session).toBe("sess-B");
	});

	test("a pass's own reply is the baseline, so it doesn't start another pass", async () => {
		const t = rig({ real: true });
		t.answers.snapshots = [snap({ comments: [note("c1", "reviewer")], hash: "asked" })];
		await t.cmd("12");
		t.answers.snapshots = [snap({ comments: [note("c1", "reviewer"), note("c2", "tung-dnt", true)], hash: "answered" })];
		await t.finishTurn("Answered.\nSHIP-STATUS: working: answered");
		expect(loadWatch(PR)?.lastHash).toBe("answered");
		for (let i = 0; i < 8; i++) await t.tick();
		expect(t.sent.map(s => s.at)).toEqual([minutes(0)]);
	});

	test("a comment someone else adds while a pass runs still starts the next pass", async () => {
		const t = rig({ real: true });
		t.answers.snapshots = [snap({ comments: [note("c1", "reviewer")], hash: "asked" })];
		await t.cmd("12");
		t.answers.snapshots = [snap({ comments: [note("c1", "reviewer"), note("c2", "tung-dnt", true), note("c3", "other-reviewer")], hash: "more" })];
		await t.finishTurn("Answered.\nSHIP-STATUS: working: answered");
		expect(loadWatch(PR)?.lastHash).toBe("asked");
		for (let i = 0; i < 6; i++) await t.tick();
		expect(t.sent.map(s => s.at)).toEqual([minutes(0), minutes(10)]);
	});
});

describe("the command line", () => {
	test.each<[string, Args]>([
		["12", { kind: "start", target: "12", bots: [], report: null }],
		["", { kind: "start", target: null, bots: [], report: null }],
		["#12 +coderabbit +dependabot[bot] --report /tmp/s.json", { kind: "start", target: "#12", bots: ["coderabbit", "dependabot[bot]"], report: "/tmp/s.json" }],
		['https://github.com/o/r/pull/3 --report="/tmp/my dir/s.json"', { kind: "start", target: "https://github.com/o/r/pull/3", bots: [], report: "/tmp/my dir/s.json" }],
		["--report=out.json", { kind: "start", target: null, bots: [], report: "out.json" }],
		["stop", { kind: "stop" }],
		["status", { kind: "status" }],
	])("%j", (text, expected) => expect(parseArgs(text)).toEqual(expected));

	test.each([["stop now"], ["12 13"], ["--report"], ["+"], ["--fast"]])("%j is a usage error", text => expect(parseArgs(text).kind).toBe("usage"));
});

describe("the status line a pass ends with", () => {
	test.each([
		["done\nSHIP-STATUS: ready: undraft it", "ready", "undraft it"],
		["SHIP-STATUS: needs-you — a larger ask", "needs-you", "a larger ask"],
		["**SHIP-STATUS: working: checks are running**", "working", "checks are running"],
		["`SHIP-STATUS: ready`", "ready", ""],
		["SHIP-STATUS: working: a\nmore text\nship-status: ready: b", "ready", "b"],
	])("%j", (text, verdict, note) => expect(readVerdict(text)).toEqual({ verdict: verdict as "ready", note }));

	test.each([["no line at all"], ["SHIP-STATUS: done: x"], ["the SHIP-STATUS: ready is in the middle"]])("%j is none", text => expect(readVerdict(text)).toBeNull());
});

describe("the ship_start tool", () => {
	test("only an unattended session has it", () => {
		expect(rig().fake.tools.has("ship_start")).toBe(false);
		process.env.OMP_STARTER_UNATTENDED = "1";
		expect(rig().fake.tools.has("ship_start")).toBe(true);
	});

	test("puts the branch up in cwd, starts the watch and returns the PR URL", async () => {
		process.env.OMP_STARTER_UNATTENDED = "1";
		const t = rig();
		const dir = path.join(privateHome(), "story-worktree");
		const { text } = await t.fake.callTool("ship_start", { cwd: dir, report: "ship.json" }, t.ctx);
		expect(text).toBe(URL);
		expect(t.calls.puts).toEqual([{ root: ROOT, confirm: false }]);
		expect(t.calls.armed).toEqual([{ pushBranch: "feat/x", root: ROOT }]);
		expect(t.ctx.timers.size).toBe(1);
		expect(fs.existsSync(path.join(dir, "ship.json"))).toBe(true);
	});

	test("a refusal is a tool error carrying its text", async () => {
		process.env.OMP_STARTER_UNATTENDED = "1";
		const t = rig();
		t.answers.put = "put-up refused: main is the default branch";
		await expect(t.fake.callTool("ship_start", {}, t.ctx)).rejects.toThrow("/ship: put-up refused: main is the default branch");
		expect(t.calls.armed).toEqual([]);
	});

	test("the review is queued behind the call as a follow-up, so the call's own result is the PR URL", async () => {
		process.env.OMP_STARTER_UNATTENDED = "1";
		// The tool runs inside a model turn, so the session is busy: a steer sent now would background the call (#9).
		const t = rig({ idle: false });
		const { text } = await t.fake.callTool("ship_start", {}, t.ctx);
		expect(text).toBe(URL);
		expect(t.sent).toHaveLength(1);
		expect(t.sent[0]?.options).toEqual({ triggerTurn: true, deliverAs: "followUp" });
		expect(t.sent[0]?.message.content).toContain("skill://interrogate");
	});
});

describe("a leading ~ in a path", () => {
	test("is the home folder in ship_start's cwd and report, not a folder named ~ in the checkout", async () => {
		process.env.OMP_STARTER_UNATTENDED = "1";
		const t = rig();
		await t.fake.callTool("ship_start", { cwd: "~/story-worktree", report: "~/out/ship.json" }, t.ctx);
		expect(t.calls.dirs[0]).toBe(path.join(privateHome(), "story-worktree"));
		expect(fs.existsSync(path.join(privateHome(), "out", "ship.json"))).toBe(true);
		expect(fs.existsSync(path.join(privateHome(), "~"))).toBe(false);
	});

	test("is the home folder in /ship --report too", async () => {
		const t = rig();
		await t.cmd("12 --report ~/ship-report.json");
		expect(t.report("ship-report.json")).toMatchObject({ state: "watching" });
		expect(fs.existsSync(path.join(privateHome(), "~"))).toBe(false);
	});
});

describe("the real gh and git runner", () => {
	test("leaves the event loop running while the command runs", async () => {
		// A real child and the real event loop: a runner that waits synchronously holds this loop still for the whole 0.4 s, which no fake can show.
		let turns = 0;
		let waiting = true;
		const spin = () => {
			turns++;
			if (waiting) setImmediate(spin);
		};
		setImmediate(spin);
		const done = await exec("git", ["-c", "alias.nap=!sleep 0.4", "nap"]);
		waiting = false;
		expect(done.code).toBe(0);
		expect(turns).toBeGreaterThan(50);
	});

	test("returns the exit code and the output untrimmed", async () => {
		expect(await exec("printf", [" a\n\n"])).toEqual({ code: 0, out: " a\n\n", err: "" });
		expect(await exec("sh", ["-c", "echo out; echo oops >&2; exit 3"])).toEqual({ code: 3, out: "out\n", err: "oops\n" });
	});

	test("kills a command that outlives its timeout, and that counts as a failure", async () => {
		const done = await exec("sleep", ["30"], 200);
		expect(done.code).not.toBe(0);
	});

	test("stops waiting at the timeout even when a grandchild still holds the pipes open", async () => {
		// The shell is killed at 300 ms, but its `sleep` outlives it and keeps both pipes open: a runner that waits for the pipes to close is held up for those 3 s.
		const started = performance.now();
		const done = await exec("sh", ["-c", "sleep 3 & wait"], 300);
		expect(performance.now() - started).toBeLessThan(2000);
		expect(done.code).not.toBe(0);
	});

	test("a command that times out hands back what it printed, and says that it timed out", async () => {
		const done = await exec("sh", ["-c", "echo partial; echo oops >&2; sleep 4"], 300);
		expect(done).toEqual({ code: 1, out: "partial\n", err: "timed out after 0.3 s\noops\n" });
	});

	test("a command that already exited but left a grandchild holding the pipes still fails at the timeout", async () => {
		const done = await exec("sh", ["-c", "echo hi; sleep 3 &"], 300);
		expect(done).toEqual({ code: 1, out: "hi\n", err: "timed out after 0.3 s" });
	});

	test("gives the pipes up at the timeout, so repeated timeouts leak no descriptors", async () => {
		const before = fs.readdirSync("/dev/fd").length;
		for (let i = 0; i < 10; i++) await exec("sh", ["-c", "sleep 2 & wait"], 100);
		// The last child's pidfd and pipe sockets close a few ms after exec returns: poll the real descriptor table until the count settles (a real leak never does).
		// Real wall-clock polling is deliberate: the OS closes these on its own schedule, which fake timers cannot drive.
		const allowed = before + 2;
		const deadline = performance.now() + 1000;
		let open = fs.readdirSync("/dev/fd").length;
		while (open > allowed && performance.now() < deadline) {
			await Bun.sleep(20);
			open = fs.readdirSync("/dev/fd").length;
		}
		expect(open).toBeLessThanOrEqual(allowed);
	});

	test("leaves no timer behind once the command has finished, so a process that ran it can exit at once", async () => {
		const script = `import { exec } from ${JSON.stringify(path.join(import.meta.dir, "ship.ts"))}; await exec("true", [], 6000);`;
		const started = performance.now();
		const child = Bun.spawn([process.execPath, "-e", script], { stdout: "ignore", stderr: "ignore" });
		expect(await child.exited).toBe(0);
		expect(performance.now() - started).toBeLessThan(4000);
	});

	test("a command that isn't there fails with 127 instead of throwing", async () => {
		expect(await exec("no-such-command-ship-test", [])).toMatchObject({ code: 127, out: "" });
	});

	test("runs without the fence's shims on PATH, and never prompts", async () => {
		const before = process.env.PATH ?? "";
		process.env.PATH = `${SHIM_DIR}${path.delimiter}${before}`;
		try {
			const done = await exec("sh", ["-c", 'printf "%s|%s|%s" "$PATH" "$GH_PROMPT_DISABLED" "$GIT_TERMINAL_PROMPT"']);
			const [searched = "", ghPrompt, gitPrompt] = done.out.split("|");
			expect(searched.split(path.delimiter)).not.toContain(SHIM_DIR);
			expect([ghPrompt, gitPrompt]).toEqual(["1", "0"]);
		} finally {
			process.env.PATH = before;
		}
	});
});
