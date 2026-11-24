import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pr, replay, snapshot, START } from "../../scripts/ship-watch-replay";
import { resetHome } from "../test-harness";
import { SHIP, type Step, type Watch } from "./types";
import { claimWatch, loadWatch, nextStep, recordPass, recordPush, releaseWatch, renewClaim, saveWatch } from "./watch";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = START;

beforeEach(resetHome);

// ---- nextStep ------------------------------------------------------------------------------------------------------

/** Times are offsets from NOW, so a row reads "4 minutes after the last pass". Default: last pass 30 minutes ago, next check in 30. */
interface Ago {
	startedAt?: number;
	lastPassAt?: number | null;
	lastPushAt?: number | null;
	nextAt?: number | null;
	lastHash?: string | null;
	passes?: number[];
}
const onWatch = (rel: number | null): number | null => (rel === null ? null : NOW + rel);
function watchAt({ startedAt = -6 * HOUR, lastPassAt = -30 * MIN, lastPushAt = null, nextAt = 30 * MIN, lastHash = "h1", passes = [] }: Ago = {}): Watch {
	return {
		pr,
		baseRef: "main",
		headRef: "s3-demo",
		startedAt: NOW + startedAt,
		lastPassAt: onWatch(lastPassAt),
		lastPushAt: onWatch(lastPushAt),
		lastHash,
		nextAt: onWatch(nextAt),
		passes: passes.map(at => NOW + at),
		pushesPerCause: {},
		told: [],
		owner: { session: "s1", pid: process.pid, heartbeat: NOW },
	};
}
const show = (step: Step): string => (step.kind === "pass" ? "pass" : step.kind === "wait" ? `wait ${(step.until - NOW) / MIN}m` : `end ${step.reason}`);
const day = Array.from({ length: SHIP.passCap }, (_, i) => -(i + 1) * HOUR + 30 * MIN);
/** What the last pass saw (the watch default), and a PR that has changed since. */
const same = { hash: "h1" };
const changed = { hash: "h2" };

describe("nextStep", () => {
	const rows: Array<[name: string, watch: Ago, seen: Parameters<typeof snapshot>[0], expected: string]> = [
		["a new watch starts with a pass", { lastHash: null, lastPassAt: null, nextAt: null }, same, "pass"],
		["a change 12 minutes after the last pass starts a pass", { lastPassAt: -12 * MIN, nextAt: 48 * MIN }, changed, "pass"],
		["a change exactly 10 minutes after the last pass starts a pass", { lastPassAt: -10 * MIN, nextAt: 50 * MIN }, changed, "pass"],
		["a change 4 minutes after the last pass waits for the 10-minute floor", { lastPassAt: -4 * MIN, nextAt: 56 * MIN }, changed, "wait 6m"],
		["a change inside the floor still gets a check that comes sooner", { lastPassAt: -8 * MIN, nextAt: MIN }, changed, "wait 1m"],
		["nothing changed: wait for the check the last pass set", { lastPassAt: -20 * MIN, nextAt: 10 * MIN }, same, "wait 10m"],
		["nothing changed, the check has come: a pass", { lastPassAt: -30 * MIN, nextAt: 0 }, same, "pass"],
		["checks pending, nothing changed: no pass before the 30 minutes are up", { lastPassAt: -5 * MIN, nextAt: 25 * MIN }, { ...same, checks: [{ name: "build", bucket: "pending", link: null }] }, "wait 25m"],
		["quiet for hours: the next check is hours away", { lastPassAt: -5 * HOUR, nextAt: 3 * HOUR }, same, "wait 180m"],
		["a watch whose last pass set no check falls back to the hourly one", { lastPassAt: -20 * MIN, nextAt: null }, same, "wait 40m"],
		["after a push, a changed PR waits 2 minutes though the floor is over", { lastPassAt: -15 * MIN, lastPushAt: -30_000, nextAt: 90_000 }, changed, "wait 1.5m"],
		["after a push, the pass comes 2 minutes later though the floor isn't over", { lastPassAt: -5 * MIN, lastPushAt: -2 * MIN, nextAt: 0 }, changed, "pass"],
		["a check that fell due before the push still waits for the push to settle", { lastPassAt: -35 * MIN, lastPushAt: -30_000, nextAt: -MIN }, same, "wait 1.5m"],
		["merged ends the watch, whatever is due", { lastHash: null, lastPassAt: null, nextAt: null }, { state: "MERGED" }, "end merged"],
		["closed ends the watch", {}, { ...changed, state: "CLOSED" }, "end closed"],
		["a different base on GitHub ends it as retargeted", {}, { ...changed, baseRef: "develop" }, "end retargeted"],
		["merged wins over retargeted", {}, { baseRef: "develop", state: "MERGED" }, "end merged"],
		["7 days after the start the watch ends", { startedAt: -7 * DAY }, changed, "end time_limit"],
		["a millisecond short of 7 days it goes on", { startedAt: -7 * DAY + 1, lastPassAt: -HOUR }, changed, "pass"],
		["24 passes in the last 24 hours: the cap, though a change is waiting", { passes: day }, changed, "end spend_cap"],
		["23 passes in the window leave room for one more", { passes: day.slice(1) }, changed, "pass"],
		["a pass exactly 24 hours old no longer counts", { passes: [-DAY, ...day.slice(1)] }, changed, "pass"],
		["7 days wins over the cap", { startedAt: -8 * DAY, passes: day }, same, "end time_limit"],
		["merged wins over the cap", { passes: day }, { state: "MERGED" }, "end merged"],
	];
	test.each(rows)("%s", (_name, watch, seen, expected) => {
		expect(show(nextStep(snapshot(seen), watchAt(watch), NOW))).toBe(expected);
	});
});

describe("the next check a pass sets", () => {
	const running = { checks: [{ name: "build", bucket: "pending" as const, link: null }] };
	const nextCheck = (watch: Watch): number => (watch.nextAt ?? NaN) - (watch.lastPassAt ?? NaN);

	test("a pass is counted and remembers what it saw", () => {
		const watch = recordPass(watchAt({ lastHash: null, lastPassAt: null, nextAt: null }), snapshot({ hash: "h7" }), NOW);
		expect(watch).toMatchObject({ lastPassAt: NOW, lastHash: "h7", passes: [NOW] });
	});

	test("checks running: the next check is 30 minutes away; nothing running: an hour", () => {
		const fresh = watchAt({ lastHash: null, lastPassAt: null, nextAt: null });
		expect(nextCheck(recordPass(fresh, snapshot(running), NOW))).toBe(30 * MIN);
		expect(nextCheck(recordPass(fresh, snapshot(), NOW))).toBe(HOUR);
	});

	test("while nothing changes, each check is pushed back: 1, 2, 4, 8, 16 hours, then a day", () => {
		let watch = recordPass(watchAt({ lastHash: null, lastPassAt: null, nextAt: null }), snapshot(), NOW);
		const waits: number[] = [];
		for (let i = 0; i < 7; i++) {
			waits.push(nextCheck(watch) / HOUR);
			watch = recordPass(watch, snapshot(), watch.nextAt ?? NaN);
		}
		expect(waits).toEqual([1, 2, 4, 8, 16, 24, 24]);
	});

	test("checks that keep running with nothing changed are pushed back too", () => {
		const first = recordPass(watchAt({ lastHash: null, lastPassAt: null, nextAt: null }), snapshot(running), NOW);
		const second = recordPass(first, snapshot(running), first.nextAt ?? NaN);
		expect([nextCheck(first) / MIN, nextCheck(second) / MIN]).toEqual([30, 60]);
	});

	test("a change starts the wait over", () => {
		let watch = recordPass(watchAt({ lastHash: null, lastPassAt: null, nextAt: null }), snapshot(), NOW);
		for (let i = 0; i < 3; i++) watch = recordPass(watch, snapshot(), watch.nextAt ?? NaN);
		expect(nextCheck(watch)).toBe(8 * HOUR);
		expect(nextCheck(recordPass(watch, snapshot({ hash: "other" }), watch.nextAt ?? NaN))).toBe(HOUR);
	});

	test("a push sets the next check 2 minutes out and is counted against its cause", () => {
		let watch = recordPass(watchAt({ lastHash: null, lastPassAt: null, nextAt: null }), snapshot(), NOW);
		watch = recordPush(watch, "ci:build", NOW + 4 * MIN);
		watch = recordPush(watch, "ci:build", NOW + 20 * MIN);
		watch = recordPush(watch, "conflict", NOW + 40 * MIN);
		expect(watch).toMatchObject({ lastPushAt: NOW + 40 * MIN, nextAt: NOW + 42 * MIN, pushesPerCause: { "ci:build": 2, conflict: 1 } });
	});

	test("recording a pass or a push leaves the watch it was given as it was", () => {
		const watch = watchAt();
		const before = structuredClone(watch);
		recordPush(recordPass(watch, snapshot({ hash: "h2" }), NOW), "ci:build", NOW);
		expect(watch).toEqual(before);
	});

	test("the cap is a rolling window of what recordPass counted", () => {
		let watch = watchAt({ lastHash: null, lastPassAt: null, nextAt: null });
		for (let i = 0; i < SHIP.passCap; i++) watch = recordPass(watch, snapshot({ hash: `h${i}` }), NOW + i * HOUR);
		const later = snapshot({ hash: "later" });
		expect(show(nextStep(later, watch, NOW + 23 * HOUR + 11 * MIN))).toBe("end spend_cap");
		expect(show(nextStep(later, watch, NOW + DAY))).toBe("pass");
	});
});

// ---- the file ------------------------------------------------------------------------------------------------------

const recordFile = path.join(os.homedir(), ".omp", "agent", "ship", "watches", "tung-dnt-omp-ship-sandbox-7.json");
const deadPid = Bun.spawnSync([process.execPath, "--version"]).pid;
type Start = Parameters<typeof claimWatch>[1];
const start = (over: Partial<Start> = {}): Start => ({ baseRef: "main", headRef: "s3-demo", session: "s1", pid: process.pid, now: NOW, ...over });
function claimed(over: Partial<Start> = {}): Watch {
	const result = claimWatch(pr, start(over));
	if (typeof result === "string") throw new Error(result);
	return result;
}

describe("claiming a watch", () => {
	test("the first claim saves a watch whose first step is a pass", () => {
		const watch = claimed();
		expect(loadWatch(pr)).toEqual(watch);
		expect(watch).toMatchObject({ startedAt: NOW, baseRef: "main", headRef: "s3-demo", owner: { session: "s1", pid: process.pid, heartbeat: NOW }, passes: [], pushesPerCause: {}, told: [] });
		expect(show(nextStep(snapshot(), watch, NOW))).toBe("pass");
	});

	test("a second live session is refused, and told which session holds it", () => {
		claimed({ session: "omp-7f3a" });
		const refusal = claimWatch(pr, start({ session: "omp-91bc", now: NOW + 5 * MIN }));
		expect(typeof refusal).toBe("string");
		expect(refusal).toContain("omp-7f3a");
		expect(loadWatch(pr)?.owner.session).toBe("omp-7f3a");
	});

	test("one PR has one file, named in lower case however the PR was spelled", () => {
		claimWatch({ ...pr, owner: "Tung-DNT", repo: "Omp-Ship-Sandbox" }, start());
		expect(fs.readdirSync(path.dirname(recordFile))).toEqual(["tung-dnt-omp-ship-sandbox-7.json"]);
		expect(typeof claimWatch(pr, start({ session: "s2", now: NOW + MIN }))).toBe("string");
	});

	test("an owner whose heartbeat is older than 10 minutes is taken over, and the facts GitHub can't hold stay", () => {
		const held = recordPush(claimed(), "ci:build", NOW + MIN);
		saveWatch({ ...held, told: ["untrusted"] });
		expect(typeof claimWatch(pr, start({ session: "s2", now: NOW + SHIP.staleOwnerMs }))).toBe("string");
		const taken = claimed({ session: "s2", pid: process.pid, now: NOW + SHIP.staleOwnerMs + 1 });
		expect(taken).toMatchObject({ owner: { session: "s2" }, startedAt: NOW, pushesPerCause: { "ci:build": 1 }, told: ["untrusted"] });
		expect(loadWatch(pr)).toEqual(taken);
	});

	test("an owner whose process is gone is taken over at once", () => {
		claimed({ session: "s1", pid: deadPid });
		expect(claimed({ session: "s2", now: NOW + MIN }).owner.session).toBe("s2");
	});

	test("an owner that keeps renewing its claim is never taken over", () => {
		const watch = claimed();
		renewClaim(watch, NOW + 9 * MIN);
		expect(typeof claimWatch(pr, start({ session: "s2", now: NOW + 15 * MIN }))).toBe("string");
	});

	test("a session resumed in another process takes the watch from its old process", () => {
		const old = claimed();
		const resumed = claimed({ pid: deadPid, now: NOW + MIN });
		expect(resumed.owner.pid).toBe(deadPid);
		expect(renewClaim(old, NOW + 2 * MIN)).toBeNull();
	});

	test("the same session claims its own watch again: facts stay, the pass count starts over, the first step is a pass", () => {
		const held = { ...claimed(), lastPassAt: NOW + MIN, lastHash: "h9", nextAt: NOW + HOUR, passes: Array.from({ length: SHIP.passCap }, (_, i) => NOW + (i + 1) * MIN), pushesPerCause: { "ci:build": 2 }, told: ["untrusted"] };
		saveWatch(held);
		const later = NOW + 30 * MIN;
		expect(show(nextStep(snapshot({ hash: "h9" }), held, later))).toBe("end spend_cap");
		const again = claimed({ now: later });
		expect(again).toMatchObject({ startedAt: NOW, passes: [], pushesPerCause: { "ci:build": 2 }, told: ["untrusted"] });
		expect(show(nextStep(snapshot({ hash: "h9" }), again, later))).toBe("pass");
	});

	test("a claim takes the base the PR has now", () => {
		claimed();
		const again = claimed({ baseRef: "develop", now: NOW + MIN });
		expect(show(nextStep(snapshot({ baseRef: "develop" }), again, NOW + MIN))).toBe("pass");
	});

	test("a watch older than 7 days is not resumed", () => {
		saveWatch({ ...watchAt({ startedAt: -8 * DAY }), pushesPerCause: { "ci:build": 3 }, owner: { session: "old", pid: deadPid, heartbeat: NOW - 8 * DAY } });
		expect(claimed()).toMatchObject({ startedAt: NOW, pushesPerCause: {} });
	});
});

describe("the file on disk", () => {
	test("a crash before the rename leaves the previous watch whole", () => {
		const first = claimed();
		const rename = spyOn(fs, "renameSync").mockImplementation(() => {
			throw new Error("killed before the rename");
		});
		try {
			expect(() => saveWatch({ ...first, told: ["half-written"] })).toThrow();
		} finally {
			rename.mockRestore();
		}
		expect(loadWatch(pr)).toEqual(first);
	});

	test("a temp file a dead writer left behind changes nothing", () => {
		const first = claimed();
		fs.writeFileSync(`${recordFile}.99999.tmp`, '{"pr": {"owner": "half');
		expect(loadWatch(pr)).toEqual(first);
		saveWatch({ ...first, told: ["after"] });
		expect(loadWatch(pr)?.told).toEqual(["after"]);
	});

	test("a file that isn't a watch is no watch, and a claim replaces it", () => {
		const valid = claimed();
		const broken: Array<[string, unknown]> = [
			["not JSON", "{not json"],
			["no owner", { ...valid, owner: undefined }],
			["a pid that is text", { ...valid, owner: { ...valid.owner, pid: "12" } }],
			["a pid of 0", { ...valid, owner: { ...valid.owner, pid: 0 } }],
			["passes that are text", { ...valid, passes: ["x"] }],
			["another host", { ...valid, pr: { ...valid.pr, host: "gitlab.com" } }],
		];
		for (const [, content] of broken) {
			fs.writeFileSync(recordFile, typeof content === "string" ? content : JSON.stringify(content));
			expect(loadWatch(pr)).toBeNull();
			expect(claimed({ now: NOW + MIN }).owner.session).toBe("s1");
			expect(loadWatch(pr)).not.toBeNull();
		}
	});

	test("renewing writes the heartbeat, and writes the watch again if its file is gone", () => {
		const watch = claimed();
		expect(renewClaim(watch, NOW + 8 * MIN)?.owner.heartbeat).toBe(NOW + 8 * MIN);
		expect(loadWatch(pr)?.owner.heartbeat).toBe(NOW + 8 * MIN);
		fs.rmSync(recordFile);
		expect(renewClaim(watch, NOW + 9 * MIN)).not.toBeNull();
		expect(loadWatch(pr)?.owner.heartbeat).toBe(NOW + 9 * MIN);
	});

	test("a session that was taken over is told so, and leaves the new owner's file alone", () => {
		const first = claimed();
		const second = claimed({ session: "s2", now: NOW + SHIP.staleOwnerMs + 1 });
		expect(renewClaim(first, NOW + SHIP.staleOwnerMs + 2)).toBeNull();
		releaseWatch(first, "merged");
		releaseWatch(first, "stopped");
		expect(loadWatch(pr)).toEqual(second);
	});

	test.each(["merged", "closed", "time_limit"] as const)("a watch that ends as %s leaves no file", reason => {
		const watch = claimed();
		releaseWatch(watch, reason);
		expect(fs.existsSync(recordFile)).toBe(false);
	});

	test.each(["stopped", "retargeted", "spend_cap"] as const)("a watch that ends as %s stays for a rerun: any session may claim it at once, and resumes its facts", reason => {
		const watch = recordPush(claimed(), "ci:build", NOW + MIN);
		saveWatch(watch);
		releaseWatch(watch, reason);
		expect(claimed({ session: "s2", now: NOW + 2 * MIN }).pushesPerCause).toEqual({ "ci:build": 1 });
	});
});

// ---- a day ---------------------------------------------------------------------------------------------------------

describe("a scripted day of one PR", () => {
	const rows = replay();
	const timeline = rows.map(row => (row.kind === "pass" ? `${row.clock} pass` : `${row.clock} ${row.kind} ${row.detail}`));
	const minutes = (clock: string): number => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5));

	test("the passes, pushes and waits the rules give", () => {
		expect(timeline).toEqual([
			// CI is still running at the first read: the next check is 30 minutes away.
			"00:00 pass",
			"00:02 wait until 00:30",
			// CI goes red at 00:14, 14 minutes after the last pass: a pass. It pushes a fix at 00:17.
			"00:14 pass",
			"00:16 wait until 01:14",
			"00:17 push ci:build",
			// A pass after a push waits 2 minutes, though only 6 have passed since the last one.
			"00:18 wait until 00:19",
			"00:20 pass",
			"00:22 wait until 00:50",
			// CI goes green at 00:27, 7 minutes after the last pass: it waits out the 10-minute floor.
			"00:28 wait until 00:30",
			"00:30 pass",
			// Then nothing changes: checks come due after 1, 2, 4 hours, each pushed back further.
			"00:32 wait until 01:30",
			"01:30 pass",
			"01:32 wait until 03:30",
			"03:30 pass",
			"03:32 wait until 07:30",
			// A comment the trust filter kept out at 03:50 starts nothing. A reviewer's at 05:10 does; the answer is pushed at 05:14.
			"05:10 pass",
			"05:12 wait until 06:10",
			"05:14 push comment:c1",
			"05:14 wait until 05:16",
			"05:16 pass",
			"05:18 wait until 05:46",
			"05:42 pass",
			"05:44 wait until 06:42",
			// Quiet again, and the wait starts over from an hour.
			"06:42 pass",
			"06:44 wait until 08:42",
			"08:42 pass",
			"08:44 wait until 12:42",
			"12:42 pass",
			"12:44 wait until 20:42",
			// The base moves on at 14:00 and the PR conflicts; the merge is pushed at 14:05.
			"14:00 pass",
			"14:02 wait until 15:00",
			"14:05 push conflict",
			"14:06 wait until 14:07",
			"14:08 pass",
			"14:10 wait until 14:38",
			"14:30 pass",
			"14:32 wait until 15:30",
			"15:30 pass",
			"15:32 wait until 17:30",
			"17:30 pass",
			"17:32 wait until 21:30",
			"21:30 pass",
			"21:32 wait until 29:30",
			"22:20 end merged",
		]);
	});

	test("two passes are never closer than 10 minutes unless a push came between them", () => {
		const events = rows.filter(row => row.kind === "pass" || row.kind === "push");
		const passes = events.filter(row => row.kind === "pass");
		expect(passes.length).toBeGreaterThan(10);
		passes.forEach((pass, i) => {
			const previous = passes[i - 1];
			if (!previous || minutes(pass.clock) - minutes(previous.clock) >= SHIP.floorMs / MIN) return;
			const between = events.slice(events.indexOf(previous), events.indexOf(pass));
			expect(between.some(row => row.kind === "push")).toBe(true);
		});
	});
});
