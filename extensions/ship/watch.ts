// The /ship watch engine, code only (plans/001-ship.md, story 3): when a watch runs a model pass, and which session
// may run it. Nothing here calls a model or GitHub.
//
// A watch starts with no pass behind it (`lastHash` null, so its first step is a pass), watches from then on, and ends
// when `nextStep` says so. Each tick (`SHIP.tickMs`) the session calls `renewClaim`, reads the PR and asks `nextStep`.
// On a pass it calls `recordPass`, on each push `recordPush`, and saves the result with `saveWatch`; on an end it calls
// `releaseWatch`. (`spend_cap` is the one end that isn't final: keep ticking.) A claim taken before the watch can start
// (put-up claims before it pushes) that is then given up goes back with `unclaimWatch`. The Watch lives in one file per
// PR, which is what lets a rerun resume, a second live session be refused and a dead one be taken over.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type ClaimWatch, type EndReason, type NextStep, type PrRef, type SaveWatch, SHIP, type Snapshot, type Watch } from "./types";

// ---- what to do next -----------------------------------------------------------------------------------------------

/**
 * What the timer does next. Pure.
 *
 * Merged, closed, retargeted and 7 days old end the watch. So does the pass cap, but that one isn't final: the session
 * keeps reading, and the cap lifts as passes age out of the window or when /ship is run again.
 *
 * Otherwise a pass starts when the PR changed and `floorMs` have passed since the last pass, or when the check the last
 * pass set has come (that one is not held to the floor). Either way it waits `afterPushMs` after a push, so CI has had
 * time to start.
 */
export const nextStep: NextStep = (snapshot, watch, now) => {
	if (snapshot.state === "MERGED") return { kind: "end", reason: "merged" };
	if (snapshot.state === "CLOSED") return { kind: "end", reason: "closed" };
	if (snapshot.baseRef !== watch.baseRef) return { kind: "end", reason: "retargeted" };
	if (now - watch.startedAt >= SHIP.lifetimeMs) return { kind: "end", reason: "time_limit" };
	if (watch.passes.filter(at => now - at < SHIP.capWindowMs).length >= SHIP.passCap) return { kind: "end", reason: "spend_cap" };

	const changeAt = snapshot.hash === watch.lastHash ? Infinity : watch.lastPassAt === null ? -Infinity : watch.lastPassAt + SHIP.floorMs;
	// A watch whose last pass set no check falls back to the quiet cadence.
	const dueAt = watch.nextAt ?? (watch.lastPassAt ?? watch.startedAt) + SHIP.quietMs;
	const settledAt = watch.lastPushAt === null ? -Infinity : watch.lastPushAt + SHIP.afterPushMs;
	const passAt = Math.max(settledAt, Math.min(changeAt, dueAt));
	if (now < passAt) return { kind: "wait", until: passAt };
	if (now >= changeAt) return { kind: "pass", why: watch.lastHash === null ? "first read of this PR" : "the PR changed since the last pass" };
	return { kind: "pass", why: "the scheduled check is due" };
};

/** The longest wait between checks of a PR where nothing changes: one look a day. */
const maxQuietMs = SHIP.capWindowMs;

/**
 * The Watch after a pass starts on `snapshot`; the session saves it. Counts the pass against the cap and sets the next
 * check: 30 minutes while checks run, else an hour. A pass that found nothing changed since the one before doubles that
 * wait, up to a day. A push in the pass moves the check to 2 minutes after it (`recordPush`, called after this).
 */
export function recordPass(watch: Watch, snapshot: Snapshot, now: number): Watch {
	const base = snapshot.checks.some(check => check.bucket === "pending") ? SHIP.checksRunningMs : SHIP.quietMs;
	const waited = snapshot.hash === watch.lastHash && watch.nextAt !== null && watch.lastPassAt !== null ? watch.nextAt - watch.lastPassAt : 0;
	return {
		...watch,
		lastPassAt: now,
		lastHash: snapshot.hash,
		nextAt: now + Math.min(Math.max(base, 2 * waited), maxQuietMs),
		passes: [...watch.passes, now],
	};
}

/** The Watch after a pass pushes; the session saves it. `cause` keys the 3-pushes-per-cause count; the next check is `afterPushMs` away. */
export function recordPush(watch: Watch, cause: string, now: number): Watch {
	return {
		...watch,
		lastPushAt: now,
		nextAt: now + SHIP.afterPushMs,
		pushesPerCause: { ...watch.pushesPerCause, [cause]: (watch.pushesPerCause[cause] ?? 0) + 1 },
	};
}

// ---- the file ------------------------------------------------------------------------------------------------------

type Shape<T> = { [K in keyof T]-?: (v: unknown) => boolean };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): boolean => typeof v === "string";
const isNum = (v: unknown): boolean => typeof v === "number" && Number.isFinite(v);
const nullable = (ok: (v: unknown) => boolean) => (v: unknown) => v === null || ok(v);
const listOf = (ok: (v: unknown) => boolean) => (v: unknown) => Array.isArray(v) && v.every(ok);
const record =
	<T extends object>(shape: Shape<T>) =>
	(v: unknown): v is T =>
		isObject(v) && Object.entries<(v: unknown) => boolean>(shape).every(([key, ok]) => ok(v[key]));

const isWatch = record<Watch>({
	pr: record<PrRef>({ host: v => v === "github.com", owner: isStr, repo: isStr, number: Number.isInteger }),
	baseRef: isStr,
	headRef: isStr,
	startedAt: isNum,
	lastPassAt: nullable(isNum),
	lastPushAt: nullable(isNum),
	lastHash: nullable(isStr),
	nextAt: nullable(isNum),
	passes: listOf(isNum),
	pushesPerCause: v => isObject(v) && Object.values(v).every(isNum),
	told: listOf(isStr),
	owner: record<Watch["owner"]>({ session: isStr, pid: v => Number.isInteger(v) && (v as number) > 0, heartbeat: isNum }),
});

/** GitHub names are case-insensitive, so one PR has one file however it was spelled. */
const watchFile = (pr: PrRef): string => path.join(os.homedir(), ".omp", "agent", "ship", "watches", `${pr.owner}-${pr.repo}-${pr.number}.json`.toLowerCase());

/** The saved Watch of this PR. A missing file, or one that doesn't hold a Watch, is no watch. */
export function loadWatch(pr: PrRef): Watch | null {
	try {
		const raw: unknown = JSON.parse(fs.readFileSync(watchFile(pr), "utf8"));
		return isWatch(raw) ? raw : null;
	} catch {
		return null;
	}
}

/** The file only ever changes by a rename, so a crash before it leaves the previous Watch whole. */
export const saveWatch: SaveWatch = watch => {
	const file = watchFile(watch.pr);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	try {
		fs.writeFileSync(tmp, `${JSON.stringify(watch, null, 2)}\n`);
		fs.renameSync(tmp, file);
	} finally {
		fs.rmSync(tmp, { force: true });
	}
};

// ---- who holds it --------------------------------------------------------------------------------------------------

const processExists = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
};

/** An owner is live while its heartbeat is recent and its process exists. */
const isLive = (owner: Watch["owner"], now: number): boolean => now - owner.heartbeat <= SHIP.staleOwnerMs && processExists(owner.pid);

const isOwner = (held: Watch, watch: Watch): boolean => held.owner.session === watch.owner.session && held.owner.pid === watch.owner.pid;

/** Why another live session holds `held`, the saved Watch of `pr`, or null when `session` may claim it: no watch, its own, or an owner gone stale. */
function heldBy(pr: PrRef, held: Watch | null, session: string, now: number): string | null {
	if (held === null || held.owner.session === session || !isLive(held.owner, now)) return null;
	return `${pr.owner}/${pr.repo}#${pr.number} is already watched by session ${held.owner.session} (pid ${held.owner.pid}); run /ship stop there first`;
}

/**
 * The Watch this session may run, saved with it as owner; or why another live session holds it. The same session, or one
 * taking over a stale or dead owner, resumes the saved Watch: the start time, pushes per cause and what the user was told
 * stay, since GitHub can't hold them. A claim starts the pass count over (AC14) and makes the first step a pass. A Watch
 * past its lifetime is not resumed; a new one starts.
 */
export const claimWatch: ClaimWatch = (pr, start) => {
	const held = loadWatch(pr);
	const refusal = heldBy(pr, held, start.session, start.now);
	if (refusal !== null) return refusal;
	const owner = { session: start.session, pid: start.pid, heartbeat: start.now };
	const watch: Watch =
		held !== null && start.now - held.startedAt < SHIP.lifetimeMs
			? { ...held, baseRef: start.baseRef, headRef: start.headRef, lastHash: null, passes: [], owner }
			: { pr, baseRef: start.baseRef, headRef: start.headRef, startedAt: start.now, lastPassAt: null, lastPushAt: null, lastHash: null, nextAt: null, passes: [], pushesPerCause: {}, told: [], owner };
	saveWatch(watch);
	return watch;
};

/**
 * Call each tick, so the claim stays live (a heartbeat older than `staleOwnerMs` can be taken over). Returns the Watch
 * with the new heartbeat, or null when another session has claimed the file since: end with `taken_over`.
 */
export function renewClaim(watch: Watch, now: number): Watch | null {
	const held = loadWatch(watch.pr);
	if (held !== null && !isOwner(held, watch)) return null;
	const renewed = { ...watch, owner: { ...watch.owner, heartbeat: now } };
	saveWatch(renewed);
	return renewed;
}

/**
 * Call when the watch ends. A finished or expired watch leaves no file. One the user may pick up again (`stopped`,
 * `retargeted`, `spend_cap`) keeps its facts but no longer counts as held, so another session can claim it at once.
 * A session that was taken over leaves the new owner's file alone.
 */
export function releaseWatch(watch: Watch, reason: EndReason): void {
	if (reason === "taken_over") return;
	const held = loadWatch(watch.pr);
	if (held !== null && !isOwner(held, watch)) return;
	switch (reason) {
		case "merged":
		case "closed":
		case "time_limit":
			fs.rmSync(watchFile(watch.pr), { force: true });
			return;
		case "stopped":
		case "retargeted":
		case "spend_cap":
			saveWatch({ ...watch, owner: { ...watch.owner, heartbeat: 0 } });
			return;
		default: {
			const _exhaustive: never = reason;
			return _exhaustive;
		}
	}
}

/**
 * Call for a claim that never became a running watch: a start that was stopped, or refused after it claimed. A claim that
 * made the file, with no fact in it since, takes the file away again, so such a start leaves no trace. One over a saved
 * watch keeps what GitHub can't hold and no longer counts as held, as a stopped watch does. A session that was taken
 * over leaves the new owner's file alone.
 */
export function unclaimWatch(watch: Watch): void {
	const facts = watch.lastPassAt !== null || watch.lastPushAt !== null || watch.told.length > 0 || Object.keys(watch.pushesPerCause).length > 0;
	if (facts) return releaseWatch(watch, "stopped");
	const held = loadWatch(watch.pr);
	if (held !== null && !isOwner(held, watch)) return;
	fs.rmSync(watchFile(watch.pr), { force: true });
}
