import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { createPeer, type PeerParts } from "./peer";
import { parsePeerResult, validatePeerResult, type PeerBlocker } from "./peer/result";
import { readPeerDiff, type PeerDiff } from "./peer/source";
import { parseLink, parseTarget } from "./ship/pr";
import type { Gh, Note, PeerReview, PeerSnapshot, PeerThread, PrRef, Watch } from "./ship/types";
import { fakeContext, fakePi, privateHome, resetHome, type FakeContext, type FakePi } from "./test-harness";

const PR: PrRef = { host: "github.com", owner: "alice", repo: "sample", number: 7 };
const URL = "https://github.com/alice/sample/pull/7";
const ME = "reviewer";
const HEAD = "a".repeat(40);
const NEXT = "b".repeat(40);
const LATER = "d".repeat(40);
const BASE = "c".repeat(40);
const MARKER = "<!-- omp-peer -->";
const T0 = Date.UTC(2026, 10, 25, 9, 0, 0);

function note(id: string, author: string, body: string, yours = false, at = new Date(T0).toISOString()): Note {
	return { id, author, bot: false, yours, at, url: `${URL}#${id}`, body, cut: false };
}

function peerReview(over: Partial<PeerReview> = {}): PeerReview {
	return {
		id: "review-node",
		yours: true,
		author: ME,
		state: "COMMENTED",
		at: new Date(T0).toISOString(),
		body: `${MARKER}\nReviewed.`,
		commit: HEAD,
		...over,
	};
}

function ownThread(over: Partial<PeerThread> = {}): PeerThread {
	return {
		id: "PRRT_own",
		isResolved: false,
		path: "src/a.ts",
		line: 2,
		side: "RIGHT",
		firstNoteYours: true,
		notes: [note("comment-own", ME, `${MARKER}\nBlocker: This breaks callers.`, true)],
		...over,
	};
}

function snapshot(over: Partial<PeerSnapshot> = {}): PeerSnapshot {
	return {
		pr: PR,
		url: URL,
		state: "OPEN",
		isDraft: false,
		author: "alice",
		headRef: "feature",
		headSha: HEAD,
		baseRef: "main",
		baseSha: BASE,
		mergeable: "MERGEABLE",
		mergeState: "CLEAN",
		reviewDecision: null,
		checks: [],
		threads: [],
		comments: [],
		reviews: [],
		untrusted: 0,
		hash: "hash-0",
		...over,
	};
}

const DIFF: PeerDiff = {
	files: [
		{
			path: "src/a.ts",
			previousPath: null,
			status: "modified",
			patch: "@@ -1,2 +1,2 @@\n-old()\n+new()",
			leftReviewLines: [1, 2],
			rightReviewLines: [1, 2],
			baseSource: "old()\nkeep()\n",
			headSource: "new()\nkeep()\n",
		},
	],
};

function resultLine(headSha: string, options: { blockers?: PeerCompleteBlocker[]; replies?: { threadId: string; body: string }[]; resolvedThreadIds?: string[]; summary?: string } = {}): string {
	return `PEER-REVIEW: ${JSON.stringify({
		status: "complete",
		headSha,
		summary: options.summary ?? "Reviewed the captured changes.",
		blockers: options.blockers ?? [],
		replies: options.replies ?? [],
		resolvedThreadIds: options.resolvedThreadIds ?? [],
	})}`;
}

type PeerCompleteBlocker = PeerBlocker;

function blocker(body = "Blocker: This breaks consumers that call the exported function."): PeerCompleteBlocker {
	return { path: "src/a.ts", line: 2, side: "RIGHT", threadId: null, body };
}

function ownWatch(now: number, session: string): Watch {
	return {
		pr: PR,
		baseRef: "main",
		headRef: "feature",
		startedAt: now,
		lastPassAt: null,
		lastPushAt: null,
		lastHash: null,
		nextAt: null,
		passes: [],
		pushesPerCause: {},
		told: [],
		owner: { session, pid: process.pid, heartbeat: now },
	};
}

interface RecordedWrite {
	kind: "review" | "reply" | "resolve";
	payload: Record<string, unknown>;
}

interface Rig {
	fake: FakePi;
	ctx: FakeContext & { aborts: number; abort(): void };
	clock: { now: number };
	sent: { message: { customType: string; content: string }; options: { triggerTurn?: boolean } }[];
	writes: RecordedWrite[];
	released: string[];
	saved: Watch[];
	disarms: number;
	statuses: (string | undefined)[];
	current(): PeerSnapshot;
	update(patch: Partial<PeerSnapshot>): void;
	cmd(args: string): Promise<void>;
	finishTurn(reply: string): Promise<void>;
	tick(minutes?: number): Promise<void>;
	report(): unknown;
	loseOwnership(): void;
	waitForNextReply(): Promise<void>;
}

const settled = async (): Promise<void> => {
	for (let i = 0; i < 5; i++) {
		const { promise, resolve } = Promise.withResolvers<void>();
		setImmediate(resolve);
		await promise;
	}
};

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function object(value: unknown): Record<string, unknown> | null {
	return isObject(value) ? value : null;
}

function rig(options: { initial?: PeerSnapshot; report?: string; reviewMode?: "success" | "accepted-unknown" | "rejected-unknown" | "hold"; holdReply?: boolean; fenceAlreadyArmed?: boolean } = {}): Rig {
	let current = options.initial ?? snapshot();
	let sequence = 0;
	let saved: Watch | null = null;
	let fenceArmed = options.fenceAlreadyArmed ?? false;
	let ownershipLost = false;
	let nextReviewId = 0;
	let nextCommentId = 0;
	let replyStarted = false;
	let replyWaiter: (() => void) | null = null;
	const clock = { now: T0 };
	const sent: Rig["sent"] = [];
	const writes: RecordedWrite[] = [];
	const released: string[] = [];
	const savedWatches: Watch[] = [];
	const statuses: (string | undefined)[] = [];
	const fake = fakePi();
	const ctx = Object.assign(fakeContext({ cwd: privateHome(), sessionId: "peer-session", agent: { kind: "main", name: "main" } }), {
		aborts: 0,
		abort() {
			this.aborts++;
		},
	});
	Object.assign(ctx.ui, { setStatus: (_key: string, status: string | undefined) => statuses.push(status) });
	Object.assign(fake.pi, {
		sendMessage(message: Rig["sent"][number]["message"], options: Rig["sent"][number]["options"]) {
			sent.push({ message, options });
		},
	});

	const bump = (patch: Partial<PeerSnapshot>): void => {
		current = { ...current, ...patch, hash: `hash-${++sequence}` };
	};
	const gh: Gh = async (args, limits) => {
		if (args[0] === "api" && args[1] === "user") return { code: 0, out: `${ME}\n`, err: "" };
		const inputAt = args.indexOf("--input");
		const inputFile = args[inputAt + 1];
		if (!inputFile) return { code: 1, out: "", err: `unexpected gh read: ${args.join(" ")}` };
		const payload = object(JSON.parse(fs.readFileSync(inputFile, "utf8")));
		if (!payload) return { code: 1, out: "", err: "invalid input" };
		if (args.some(arg => arg.endsWith("/reviews"))) {
			writes.push({ kind: "review", payload });
			if (options.reviewMode === "hold") {
				const { promise, resolve } = Promise.withResolvers<{ code: number; out: string; err: string }>();
				const stop = (): void => resolve({ code: 1, out: "", err: "stopped" });
				if (limits?.signal?.aborted) stop();
				else limits?.signal?.addEventListener("abort", stop, { once: true });
				return await promise;
			}
			if (options.reviewMode !== "rejected-unknown") {
				const event = payload.event;
				const state = event === "APPROVE" ? "APPROVED" : event === "REQUEST_CHANGES" ? "CHANGES_REQUESTED" : "COMMENTED";
				const nodeId = `REVIEW_NODE_${++nextReviewId}`;
				const body = typeof payload.body === "string" ? payload.body : "";
				const commit = typeof payload.commit_id === "string" ? payload.commit_id : HEAD;
				const at = new Date(clock.now).toISOString();
				const added = Array.isArray(payload.comments) ? payload.comments.flatMap((entry, index) => {
					const comment = object(entry);
					if (!comment || typeof comment.path !== "string" || typeof comment.line !== "number" || (comment.side !== "LEFT" && comment.side !== "RIGHT") || typeof comment.body !== "string") return [];
					const threadId = `PRRT_${nextReviewId}_${index}`;
					return [{
						id: threadId,
						isResolved: false,
						path: comment.path,
						line: comment.line,
						side: comment.side,
						firstNoteYours: true,
						notes: [note(`COMMENT_NODE_${threadId}`, ME, comment.body, true, at)],
					} satisfies PeerThread];
				}) : [];
				bump({
					threads: [...current.threads, ...added],
					reviews: [...current.reviews, peerReview({ id: nodeId, state, at, body, commit })],
				});
				if (options.reviewMode !== "accepted-unknown") return { code: 0, out: JSON.stringify({ id: nextReviewId, node_id: nodeId, state, commit_id: commit, body }), err: "" };
			}
			return { code: 1, out: "", err: "connection interrupted after submission" };
		}

		const query = typeof payload.query === "string" ? payload.query : "";
		const variables = object(payload.variables);
		const threadId = typeof variables?.threadId === "string" ? variables.threadId : "";
		if (query.includes("addPullRequestReviewThreadReply")) {
			writes.push({ kind: "reply", payload });
			replyStarted = true;
			replyWaiter?.();
			replyWaiter = null;
			if (options.holdReply) {
				const { promise, resolve } = Promise.withResolvers<{ code: number; out: string; err: string }>();
				const stop = (): void => resolve({ code: 1, out: "", err: "stopped" });
				if (limits?.signal?.aborted) stop();
				else limits?.signal?.addEventListener("abort", stop, { once: true });
				return await promise;
			}
			const body = typeof variables?.body === "string" ? variables.body : "";
			const id = `REPLY_NODE_${++nextCommentId}`;
			const threads = current.threads.map(thread => thread.id === threadId ? { ...thread, notes: [...thread.notes, note(id, ME, body, true, new Date(clock.now).toISOString())] } : thread);
			bump({ threads });
			return { code: 0, out: JSON.stringify({ data: { addPullRequestReviewThreadReply: { comment: { id } } } }), err: "" };
		}
		if (query.includes("resolveReviewThread")) {
			writes.push({ kind: "resolve", payload });
			bump({ threads: current.threads.map(thread => thread.id === threadId ? { ...thread, isResolved: true } : thread) });
			return { code: 0, out: JSON.stringify({ data: { resolveReviewThread: { thread: { isResolved: true } } } }), err: "" };
		}
		return { code: 1, out: "", err: `unexpected gh mutation: ${query}` };
	};

	const parts: PeerParts = {
		now: () => clock.now,
		platform: "linux",
		git: async (_dir, args) => args[0] === "rev-parse" ? { code: 0, out: "/work/sample\n", err: "" } : { code: 0, out: "git@github.com:alice/sample.git\n", err: "" },
		ghFor: () => gh,
		sshHostname: () => null,
		parseTarget,
		parseLink,
		readPr: async () => {
			return current;
		},
		readDiff: async () => DIFF,
		loadWatch: () => saved,
		claimWatch: (_pr, start) => {
			const watch = ownWatch(start.now, start.session);
			saved = watch;
			return watch;
		},
		renewClaim: (watch, now) => ownershipLost ? null : { ...watch, owner: { ...watch.owner, heartbeat: now } },
		releaseWatch: (_watch, reason) => {
			released.push(reason);
			if (reason !== "taken_over" && saved !== null) saved = { ...saved, owner: { ...saved.owner, heartbeat: 0 } };
		},
		unclaimWatch: watch => { saved = { ...watch, owner: { ...watch.owner, heartbeat: 0 } }; },
		saveWatch: watch => {
			saved = watch;
			savedWatches.push(watch);
		},
		armPeerFence: () => {
			if (fenceArmed) throw new Error("already armed");
			fenceArmed = true;
		},
		disarmFence: () => {
			fenceArmed = false;
			disarms++;
		},
		currentState: () => ({ armed: fenceArmed }),
		rules: () => "Peer test rules",
	};
	let disarms = 0;
	createPeer(parts)(fake.pi);

	return {
		fake,
		ctx,
		clock,
		sent,
		writes,
		released,
		saved: savedWatches,
		get disarms() { return disarms; },
		statuses,
		current: () => current,
		update(patch) {
			bump(patch);
		},
		cmd: args => fake.runCommand("peer", args, ctx),
		async finishTurn(reply) {
			fake.emit("agent_end", { type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: reply }] }] }, ctx);
			await settled();
		},
		async tick(minutes = 2) {
			clock.now += minutes * 60_000;
			ctx.tick();
			await settled();
		},
		report: () => JSON.parse(fs.readFileSync(path.join(privateHome(), options.report ?? "peer-report.json"), "utf8")),
		loseOwnership: () => { ownershipLost = true; },
		waitForNextReply() {
			if (replyStarted) return Promise.resolve();
			const { promise, resolve } = Promise.withResolvers<void>();
			replyWaiter = resolve;
			return promise;
		},
	};
}

beforeEach(resetHome);
afterEach(resetHome);

describe("peer result contract", () => {
	test("accepts one complete result and a separate non-approvable incomplete result", () => {
		const complete = resultLine(HEAD, { blockers: [blocker()] });
		expect(parsePeerResult(complete)).toMatchObject({ status: "complete", headSha: HEAD, blockers: [{ side: "RIGHT" }] });
		const incomplete = `PEER-REVIEW: ${JSON.stringify({ status: "needs-you", headSha: HEAD, summary: "Incomplete", reason: "A caller could not be read.", blockers: [], replies: [], resolvedThreadIds: [] })}`;
		expect(parsePeerResult(incomplete)).toMatchObject({ status: "needs-you", blockers: [], replies: [], resolvedThreadIds: [] });
		expect(parsePeerResult(`${complete}\n${complete}`)).toBeNull();
		expect(parsePeerResult("No structured review was returned.")).toBeNull();
	});

	test("validates both diff sides and marker-bearing own findings", () => {
		const current = snapshot({ threads: [ownThread()] });
		const parsed = parsePeerResult(resultLine(HEAD, { resolvedThreadIds: ["PRRT_own"], replies: [{ threadId: "PRRT_own", body: "Fixed in the captured head." }] }));
		expect(parsed?.status).toBe("complete");
		if (parsed?.status !== "complete") return;
		expect(validatePeerResult(parsed, current, DIFF)).toBeNull();
		const otherThread = ownThread({ firstNoteYours: false, notes: [note("human-first", "alice", "Please fix this.")] });
		expect(validatePeerResult(parsed, snapshot({ threads: [otherThread] }), DIFF)).not.toBeNull();
		const left = parsePeerResult(resultLine(HEAD, { blockers: [{ ...blocker(), side: "LEFT" }] }));
		expect(left?.status).toBe("complete");
		if (left?.status === "complete") expect(validatePeerResult(left, current, DIFF)).toBeNull();
		const badLine = parsePeerResult(resultLine(HEAD, { blockers: [{ ...blocker(), line: 900 }] }));
		expect(badLine?.status).toBe("complete");
		if (badLine?.status === "complete") expect(validatePeerResult(badLine, current, DIFF)).not.toBeNull();
		const retained = parsePeerResult(resultLine(HEAD, { blockers: [{ ...blocker(), threadId: "PRRT_own" }] }));
		expect(retained?.status).toBe("complete");
		if (retained?.status === "complete") {
			expect(validatePeerResult(retained, current, DIFF)).toBeNull();
			expect(validatePeerResult(retained, snapshot({ threads: [otherThread] }), DIFF)).not.toBeNull();
			const question = ownThread({ notes: [note("question", ME, `${MARKER}\nCould this be simpler?`, true)] });
			expect(validatePeerResult(retained, snapshot({ threads: [question] }), DIFF)).not.toBeNull();
			expect(validatePeerResult({ ...retained, resolvedThreadIds: ["PRRT_own"] }, current, DIFF)).not.toBeNull();
		}
	});
});

test("refuses self-review and an already active fence before claiming a watch", async () => {
	const self = rig({ initial: snapshot({ author: ME }) });
	await self.cmd(URL);
	expect(self.sent).toHaveLength(0);
	expect(self.saved).toHaveLength(0);
	expect(self.disarms).toBe(0);

	const fenced = rig({ fenceAlreadyArmed: true });
	await fenced.cmd(URL);
	expect(fenced.writes).toHaveLength(0);
	expect(fenced.saved).toHaveLength(0);
	expect(fenced.disarms).toBe(0);
});

describe("peer review lifecycle", () => {
	test("requests a blocker, stays quiet, resolves only its own thread, approves, and reopens on a new SHA", async () => {
		const t = rig({ report: "peer-report.json" });
		await t.cmd(`${URL} --report peer-report.json`);
		expect(t.sent).toHaveLength(1);
		await t.finishTurn(resultLine(HEAD, { blockers: [blocker()] }));
		expect(t.writes.map(write => write.kind)).toEqual(["review"]);
		expect(t.writes[0]?.payload).toMatchObject({ event: "REQUEST_CHANGES", commit_id: HEAD, comments: [{ path: "src/a.ts", line: 2, side: "RIGHT" }] });
		const thread = t.current().threads[0];
		expect(thread).toMatchObject({ firstNoteYours: true, notes: [{ body: `${MARKER}\n${blocker().body}`, yours: true }] });

		await t.tick();
		expect(t.sent).toHaveLength(1);
		const authorReply = note("author-reply", "alice", "Fixed in the new commit.", false, new Date(T0 + 12 * 60_000).toISOString());
		t.update({ headSha: NEXT, threads: [{ ...thread!, notes: [...thread!.notes, authorReply] }] });
		await t.tick(10);
		expect(t.sent).toHaveLength(2);
		await t.finishTurn(resultLine(NEXT, { replies: [{ threadId: "PRRT_1_0", body: "Verified fixed at the captured head." }], resolvedThreadIds: ["PRRT_1_0"] }));
		expect(t.writes.map(write => write.kind)).toEqual(["review", "reply", "resolve", "review"]);
		expect(t.writes.at(-1)?.payload).toMatchObject({ event: "APPROVE", commit_id: NEXT, comments: [] });
		expect(t.report()).toMatchObject({ state: "approved", waitingFor: null });

		await t.tick();
		expect(t.sent).toHaveLength(2);
		t.update({
			comments: [...t.current().comments, note("post-approval", "alice", "One question after the approval.")],
			checks: [{ name: "verify", bucket: "pending", link: null }],
		});
		await t.tick(10);
		expect(t.sent).toHaveLength(2);
		expect(t.report()).toMatchObject({ state: "approved" });

		t.update({ headSha: LATER, checks: [{ name: "verify", bucket: "pass", link: null }] });
		await t.tick(10);
		expect(t.sent).toHaveLength(3);
		await t.finishTurn(resultLine(LATER, { summary: "No blockers in the new head." }));
		expect(t.report()).toMatchObject({ state: "approved" });
		const approval = t.current().reviews.at(-1);
		if (!approval) throw new Error("the current head approval should be in the GitHub snapshot");
		t.update({ reviews: t.current().reviews.map(review => review.id === approval.id ? { ...review, state: "DISMISSED", at: new Date(t.clock.now + 1).toISOString() } : review) });
		await t.tick(10);
		expect(t.sent).toHaveLength(4);
		expect(t.writes.filter(write => object(write.payload)?.event === "APPROVE")).toHaveLength(2);
		await t.cmd("stop");
		expect(t.released).toEqual(["stopped"]);
		expect(t.disarms).toBe(1);
		expect(t.ctx.timers.size).toBe(0);
	});

	test("pending and failed checks never approve; temporary ignored checks do not change that decision", async () => {
		const t = rig({
			report: "peer-report.json",
			initial: snapshot({ checks: [
				{ name: "verify", bucket: "pending", link: null },
				{ name: "SonarCloud Code Analysis", bucket: "fail", link: null },
				{ name: "Approve Deployment", bucket: "cancel", link: null },
			] }),
		});
		await t.cmd(`${URL} --report peer-report.json`);
		await t.finishTurn(resultLine(HEAD));
		expect(t.writes.map(write => object(write.payload)?.event)).toEqual(["COMMENT"]);
		expect(t.report()).toMatchObject({ state: "waiting", waitingFor: "CI" });

		t.update({ checks: [{ name: "verify", bucket: "fail", link: null }] });
		await t.tick(10);
		await t.finishTurn(resultLine(HEAD, { summary: "Still waiting for CI." }));
		expect(t.writes.map(write => object(write.payload)?.event)).toEqual(["COMMENT"]);
		expect(t.report()).toMatchObject({ state: "waiting", waitingFor: "CI" });

		t.update({ checks: [{ name: "verify", bucket: "pass", link: null }] });
		await t.tick(10);
		await t.finishTurn(resultLine(HEAD, { summary: "Checks passed." }));
		expect(t.writes.map(write => object(write.payload)?.event)).toEqual(["COMMENT", "APPROVE"]);
	});

	test("deduplicates a marker-bearing own finding, and author reply edits wake review", async () => {
		const existing = ownThread();
		const prior = peerReview({ state: "CHANGES_REQUESTED", commit: HEAD });
		const t = rig({ initial: snapshot({ threads: [existing], reviews: [prior] }), report: "peer-report.json" });
		await t.cmd(`${URL} --report peer-report.json`);
		expect(t.sent).toHaveLength(0);
		const authorReply = note("author-reply", "alice", "I will fix it.");
		t.update({ threads: [{ ...existing, notes: [...existing.notes, authorReply] }] });
		await t.tick();
		expect(t.sent).toHaveLength(1);
		await t.finishTurn(resultLine(HEAD, { blockers: [{ ...blocker(), threadId: existing.id }] }));
		expect(t.writes).toHaveLength(0);
		expect(t.report()).toMatchObject({ state: "waiting", waitingFor: "author" });
		const editedReply = { ...authorReply, body: "I have fixed it in the new commit.", at: new Date(T0 + 1).toISOString() };
		t.update({ threads: [{ ...existing, notes: [...existing.notes, editedReply] }] });
		await t.tick(10);
		expect(t.sent).toHaveLength(2);
		await t.finishTurn(resultLine(HEAD, { blockers: [{ ...blocker(), threadId: existing.id }] }));
		expect(t.writes).toHaveLength(0);
	});

	test("posts a different blocker on the same line instead of hiding it as a duplicate", async () => {
		const existing = ownThread();
		const reply = note("author-reply", "alice", "Please check this again.");
		const t = rig({ initial: snapshot({
			threads: [{ ...existing, notes: [...existing.notes, reply] }],
			reviews: [peerReview({ state: "CHANGES_REQUESTED" })],
		}) });
		await t.cmd(URL);
		const different = blocker("Blocker: This path swallows database errors and reports success.");
		await t.finishTurn(resultLine(HEAD, { blockers: [different] }));
		expect(t.writes).toHaveLength(1);
		expect(t.writes[0]?.payload).toMatchObject({
			event: "REQUEST_CHANGES",
			comments: [{ path: different.path, line: different.line, body: `${MARKER}\n${different.body}` }],
		});
	});

	test("reconciles an accepted ambiguous review and never retries an unchanged unknown outcome", async () => {
		const accepted = rig({ reviewMode: "accepted-unknown", report: "peer-report.json" });
		await accepted.cmd(`${URL} --report peer-report.json`);
		await accepted.finishTurn(resultLine(HEAD));
		expect(accepted.report()).toMatchObject({ state: "approved" });
		await accepted.tick(20);
		expect(accepted.writes).toHaveLength(1);

		const rejected = rig({ reviewMode: "rejected-unknown", report: "peer-report.json" });
		await rejected.cmd(`${URL} --report peer-report.json`);
		await rejected.finishTurn(resultLine(HEAD));
		expect(rejected.report()).toMatchObject({ state: "needs-you" });
		await rejected.tick(30);
		expect(rejected.sent).toHaveLength(1);
		expect(rejected.writes).toHaveLength(1);
	});

	test("discards a pass when another session takes ownership", async () => {
		const t = rig({ report: "peer-report.json" });
		await t.cmd(`${URL} --report peer-report.json`);
		t.loseOwnership();
		await t.finishTurn(resultLine(HEAD, { blockers: [blocker()] }));
		expect(t.writes).toHaveLength(0);
		expect(t.released).toEqual(["taken_over"]);
		expect(t.disarms).toBe(1);
	});

	test("stop aborts an in-flight review submission and prevents later writes", async () => {
		const thread = ownThread({ notes: [ownThread().notes[0]!, note("author-reply", "alice", "Fixed this.")] });
		const t = rig({ initial: snapshot({ threads: [thread] }), holdReply: true });
		await t.cmd(URL);
		const ending = t.finishTurn(resultLine(HEAD, { replies: [{ threadId: thread.id, body: "Confirmed the fix." }], resolvedThreadIds: [thread.id] }));
		await t.waitForNextReply();
		await t.cmd("stop");
		await ending;
		expect(t.writes.map(write => write.kind)).toEqual(["reply"]);
		expect(t.released).toEqual(["stopped"]);
		expect(t.disarms).toBe(1);
		expect(t.ctx.timers.size).toBe(0);
	});
});

describe("pinned changed-file reads", () => {
	test("paginates the changed-file endpoint and loads both exact source SHAs", async () => {
		const current = snapshot();
		const calls: string[][] = [];
		const baseText = "old()\n";
		const headText = "new()\n";
		const gh: Gh = async args => {
			calls.push(args);
			const endpoint = args[1] ?? "";
			if (endpoint.endsWith("/files?per_page=100&page=1")) return { code: 0, out: JSON.stringify([{ filename: "src/a.ts", status: "modified", patch: "@@ -1 +1 @@\n-old()\n+new()" }]), err: "" };
			if (endpoint.endsWith("/files?per_page=100&page=2")) return { code: 0, out: "[]", err: "" };
			if (endpoint.includes("/contents/src/a.ts?ref=")) {
				const content = endpoint.endsWith(`ref=${BASE}`) ? baseText : headText;
				return { code: 0, out: JSON.stringify({ type: "file", encoding: "base64", size: Buffer.byteLength(content), content: Buffer.from(content).toString("base64") }), err: "" };
			}
			return { code: 0, out: JSON.stringify({ base: { sha: BASE }, head: { sha: HEAD }, changed_files: 1 }), err: "" };
		};
		const read = await readPeerDiff(PR, gh, current);
		expect(read).toMatchObject({ files: [{ path: "src/a.ts", leftReviewLines: [1], rightReviewLines: [1], baseSource: baseText, headSource: headText }] });
		expect(calls.filter(args => (args[1] ?? "").includes("/contents/")).map(args => args[1])).toEqual([
			`repos/alice/sample/contents/src/a.ts?ref=${BASE}`,
			`repos/alice/sample/contents/src/a.ts?ref=${HEAD}`,
		]);
	});

	test("reads more than 300 files and refuses an incomplete changed-file list", async () => {
		let expectedFiles = 301;
		const current = snapshot();
		const content = Buffer.from("new\n").toString("base64");
		const gh: Gh = async args => {
			const endpoint = args[1] ?? "";
			if (endpoint.includes("/files?")) {
				const page = Number(new globalThis.URL(endpoint, "https://api.github.com").searchParams.get("page"));
				const first = (page - 1) * 100;
				const files = Array.from({ length: Math.min(100, Math.max(0, 301 - first)) }, (_, index) => ({
					filename: `src/${first + index}.ts`, status: "modified", patch: "@@ -1 +1 @@\n-old\n+new",
				}));
				return { code: 0, out: JSON.stringify(files), err: "" };
			}
			if (endpoint.includes("/contents/")) return { code: 0, out: JSON.stringify({ type: "file", encoding: "base64", size: 4, content }), err: "" };
			return { code: 0, out: JSON.stringify({ base: { sha: BASE }, head: { sha: HEAD }, changed_files: expectedFiles }), err: "" };
		};
		const complete = await readPeerDiff(PR, gh, current);
		expect(typeof complete).not.toBe("string");
		if (typeof complete !== "string") expect(complete.files.at(-1)).toMatchObject({ path: "src/300.ts", headSource: "new\n" });
		expectedFiles = 302;
		expect(typeof await readPeerDiff(PR, gh, current)).toBe("string");
		expectedFiles = 3001;
		expect(typeof await readPeerDiff(PR, gh, current)).toBe("string");
	});
});
