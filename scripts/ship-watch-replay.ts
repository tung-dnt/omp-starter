#!/usr/bin/env bun
// Replays a scripted day of one pull request through the /ship watch engine and prints every pass, push and wait. The
// day is written by hand as the states `readPr` would report, one entry per change; the engine is driven as the
// session's 2-minute timer drives it. No network, no model, no files.
//
//   bun scripts/ship-watch-replay.ts
import { type Check, type CheckBucket, type Note, type PrRef, SHIP, type Snapshot, type Watch } from "../extensions/ship/types";
import { nextStep, recordPass, recordPush } from "../extensions/ship/watch";

export const START = Date.UTC(2026, 10, 24, 9, 0, 0);
const DAY_MS = 24 * 3_600_000;

export const pr: PrRef = { host: "github.com", owner: "tung-dnt", repo: "omp-ship-sandbox", number: 7 };

const quiet: Snapshot = {
	pr,
	url: "https://github.com/tung-dnt/omp-ship-sandbox/pull/7",
	state: "OPEN",
	isDraft: false,
	author: "tung-dnt",
	headRef: "s3-demo",
	headSha: "1111111",
	baseRef: "main",
	mergeable: "MERGEABLE",
	mergeState: "CLEAN",
	reviewDecision: null,
	checks: [],
	threads: [],
	comments: [],
	reviews: [],
	untrusted: 0,
	hash: "",
};

/** A snapshot with `change` applied. Its hash follows what the real one covers (head, mergeable state, check buckets, trusted comments) unless `change` names one. */
export function snapshot(change: Partial<Snapshot> = {}): Snapshot {
	const s = { ...quiet, ...change };
	const covered = [s.headSha, s.mergeable, s.mergeState, s.checks.map(c => [c.name, c.bucket]), s.comments.map(n => n.id)];
	return { ...s, hash: change.hash ?? Bun.hash(JSON.stringify(covered)).toString(16) };
}

const build = (bucket: CheckBucket): Check[] => [{ name: "build", bucket, link: null }];
const note = (id: string, author: string, yours: boolean, body: string): Note => ({ id, author, bot: false, yours, at: "2026-11-24T14:10:00Z", url: "", body, cut: false });
const ask = note("c1", "reviewer", false, "Could you rename this helper?");
const answer = note("c2", "tung-dnt", true, "<!-- omp-ship -->\nRenamed.");

/** What the PR looked like, as `[hh:mm into the day, what changed]`; each entry builds on the ones before. */
const DAY: Array<[at: string, change: Partial<Snapshot>]> = [
	["00:00", { checks: build("pending") }],
	["00:14", { checks: build("fail") }],
	["00:17", { headSha: "2222222", checks: build("pending") }],
	["00:27", { checks: build("pass") }],
	// A comment from someone the trust filter keeps out: counted, not part of the hash.
	["03:50", { untrusted: 1 }],
	["05:10", { comments: [ask] }],
	["05:14", { headSha: "3333333", checks: build("pending"), comments: [ask, answer] }],
	["05:41", { checks: build("pass") }],
	["14:00", { mergeable: "CONFLICTING" }],
	["14:05", { headSha: "4444444", mergeable: "MERGEABLE", checks: build("pending") }],
	["14:30", { checks: build("pass") }],
	["22:20", { state: "MERGED" }],
];

/** The pushes the passes made, as `[hh:mm, cause]`; each is a head change in DAY. */
const PUSHES: Array<[at: string, cause: string]> = [
	["00:17", "ci:build"],
	["05:14", "comment:c1"],
	["14:05", "conflict"],
];

const timeOf = (clock: string): number => {
	const [hours = 0, minutes = 0] = clock.split(":").map(Number);
	return START + (hours * 60 + minutes) * 60_000;
};
const clockOf = (ms: number): string => {
	const minutes = Math.round((ms - START) / 60_000);
	return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
};

const world = (now: number): Snapshot => snapshot(DAY.filter(([clock]) => timeOf(clock) <= now).reduce<Partial<Snapshot>>((state, [, change]) => ({ ...state, ...change }), {}));

export interface Row {
	clock: string;
	kind: "pass" | "push" | "wait" | "end";
	detail: string;
}

/** Ticks the engine every `SHIP.tickMs` through the day. A wait is listed when it changes, not on every tick. */
export function replay(): Row[] {
	const rows: Row[] = [];
	const row = (ms: number, kind: Row["kind"], detail: string) => rows.push({ clock: clockOf(ms), kind, detail });
	const pushes = PUSHES.map(([clock, cause]) => ({ at: timeOf(clock), cause }));
	let watch: Watch = {
		pr,
		baseRef: "main",
		headRef: "s3-demo",
		startedAt: START,
		lastPassAt: null,
		lastPushAt: null,
		lastHash: null,
		nextAt: null,
		passes: [],
		pushesPerCause: {},
		told: [],
		owner: { session: "replay", pid: 1, heartbeat: START },
	};
	let pushed = 0;
	let waitingUntil: number | null = null;
	for (let now = START; now <= START + DAY_MS; now += SHIP.tickMs) {
		while (pushed < pushes.length && pushes[pushed].at <= now) {
			const { at, cause } = pushes[pushed++];
			watch = recordPush(watch, cause, at);
			row(at, "push", cause);
		}
		const seen = world(now);
		const step = nextStep(seen, watch, now);
		if (step.kind === "end") {
			row(now, "end", step.reason);
			break;
		}
		if (step.kind === "pass") {
			watch = recordPass(watch, seen, now);
			row(now, "pass", step.why);
			waitingUntil = null;
		} else if (step.until !== waitingUntil) {
			row(now, "wait", `until ${clockOf(step.until)}`);
			waitingUntil = step.until;
		}
	}
	return rows;
}

if (import.meta.main) {
	const rows = replay();
	for (const { clock, kind, detail } of rows) console.log(`${clock}  ${kind.padEnd(4)}  ${detail}`);
	const count = (kind: Row["kind"]) => rows.filter(r => r.kind === kind).length;
	console.log(`\n${count("pass")} passes and ${count("push")} pushes by ${rows.at(-1)?.clock}; the watch ended: ${rows.at(-1)?.detail}`);
}
