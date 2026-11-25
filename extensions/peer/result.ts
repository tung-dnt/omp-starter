import type { PeerSnapshot } from "../ship/types";
import type { PeerDiff } from "./source";

export function isPeerBlocker(note: PeerSnapshot["threads"][number]["notes"][number]): boolean {
	return note.yours && note.body.startsWith("<!-- omp-peer -->\nBlocker: ");
}

export interface PeerBlocker {
	path: string;
	line: number;
	side: "LEFT" | "RIGHT";
	threadId: string | null;
	body: string;
}

export interface PeerReply {
	threadId: string;
	body: string;
}

export interface PeerComplete {
	status: "complete";
	headSha: string;
	summary: string;
	blockers: PeerBlocker[];
	replies: PeerReply[];
	resolvedThreadIds: string[];
}

export interface PeerNeedsYou {
	status: "needs-you";
	headSha: string;
	summary: string;
	reason: string;
	blockers: [];
	replies: [];
	resolvedThreadIds: [];
}

export type PeerResult = PeerComplete | PeerNeedsYou;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isText = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && value.length <= max && value.trim() === value;
const safeId = (value: unknown): value is string => isText(value, 1024) && !/[\r\n\0]/.test(value);
const safeBody = (value: unknown, max: number): value is string => isText(value, max) && !value.startsWith("<!--") && !value.includes("\0");
const safePath = (value: unknown): value is string =>
	typeof value === "string" && value.length > 0 && value.length <= 1024 && !value.startsWith("/") && !value.includes("\\") && !/[\r\n\0]/.test(value) && value.split("/").every(part => part !== "" && part !== "." && part !== "..");

const exactKeys = (value: Record<string, unknown>, keys: string[]): boolean => {
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};

/** Accept exactly one machine-readable result, and only when it is the final non-empty line. */
export function parsePeerResult(reply: string): PeerResult | null {
	const lines = reply.trimEnd().split(/\r?\n/);
	const resultLines = lines.filter(line => line.startsWith("PEER-REVIEW: "));
	const final = lines.at(-1);
	if (resultLines.length !== 1 || final !== resultLines[0]) return null;

	let value: unknown;
	try {
		value = JSON.parse(resultLines[0].slice("PEER-REVIEW: ".length));
	} catch {
		return null;
	}
	if (!isObject(value) || typeof value.status !== "string") return null;
	const commonKeys = ["status", "headSha", "summary", "blockers", "replies", "resolvedThreadIds"];
	if (typeof value.headSha !== "string" || !/^[0-9a-f]{40}$/i.test(value.headSha) || !safeBody(value.summary, 2000)) return null;
	if (!Array.isArray(value.blockers) || !Array.isArray(value.replies) || !Array.isArray(value.resolvedThreadIds)) return null;

	if (value.status === "needs-you") {
		if (!exactKeys(value, [...commonKeys, "reason"]) || !safeBody(value.reason, 1000) || value.blockers.length !== 0 || value.replies.length !== 0 || value.resolvedThreadIds.length !== 0) return null;
		return { status: "needs-you", headSha: value.headSha, summary: value.summary, reason: value.reason, blockers: [], replies: [], resolvedThreadIds: [] };
	}
	if (value.status !== "complete" || !exactKeys(value, commonKeys)) return null;

	const blockers: PeerBlocker[] = [];
	const seenFindings = new Set<string>();
	for (const blocker of value.blockers) {
		if (!isObject(blocker) || !exactKeys(blocker, ["path", "line", "side", "threadId", "body"])) return null;
		const { path, line, side, threadId, body } = blocker;
		if (!safePath(path) || typeof line !== "number" || !Number.isSafeInteger(line) || line < 1 || (side !== "LEFT" && side !== "RIGHT") || (threadId !== null && !safeId(threadId)) || !safeBody(body, 8000) || !body.startsWith("Blocker: ")) return null;
		const key = JSON.stringify([path, line, side, threadId, body]);
		if (seenFindings.has(key)) return null;
		seenFindings.add(key);
		blockers.push({ path, line, side, threadId, body });
	}

	const replies: PeerReply[] = [];
	const seenReplies = new Set<string>();
	for (const replyItem of value.replies) {
		if (!isObject(replyItem) || !exactKeys(replyItem, ["threadId", "body"])) return null;
		const { threadId, body } = replyItem;
		if (!safeId(threadId) || !safeBody(body, 4000) || seenReplies.has(threadId)) return null;
		seenReplies.add(threadId);
		replies.push({ threadId, body });
	}

	const resolvedThreadIds: string[] = [];
	const seenResolutions = new Set<string>();
	for (const id of value.resolvedThreadIds) {
		if (!safeId(id) || seenResolutions.has(id) || !seenReplies.has(id)) return null;
		seenResolutions.add(id);
		resolvedThreadIds.push(id);
	}
	return { status: "complete", headSha: value.headSha, summary: value.summary, blockers, replies, resolvedThreadIds };
}

/** Validate model-selected locations and thread IDs against the GitHub snapshot supplied for this pass. */
export function validatePeerResult(result: PeerComplete, snapshot: PeerSnapshot, diff: PeerDiff): string | null {
	if (result.headSha !== snapshot.headSha) return "the result names a different head SHA";
	const locations = new Map(diff.files.map(file => [file.path, { left: new Set(file.leftReviewLines), right: new Set(file.rightReviewLines) }]));
	for (const blocker of result.blockers) {
		const file = locations.get(blocker.path);
		const validLines = blocker.side === "LEFT" ? file?.left : file?.right;
		if (!validLines?.has(blocker.line)) return `finding ${blocker.path}:${blocker.line} on ${blocker.side.toLowerCase()} is not on the captured diff`;
		if (blocker.threadId !== null) {
			const thread = snapshot.threads.find(candidate => candidate.id === blocker.threadId);
			if (!thread || thread.isResolved || !thread.firstNoteYours || !thread.notes.some(isPeerBlocker) || thread.path !== blocker.path || thread.side !== blocker.side || result.resolvedThreadIds.includes(thread.id)) return `finding target ${blocker.threadId} is not an unresolved peer finding`;
		}
	}
	for (const reply of result.replies) {
		const thread = snapshot.threads.find(candidate => candidate.id === reply.threadId);
		if (!thread || thread.isResolved || (!thread.firstNoteYours && !thread.notes.some(note => !note.yours))) return `reply target ${reply.threadId} is not an unresolved human or peer thread`;
	}
	for (const id of result.resolvedThreadIds) {
		const thread = snapshot.threads.find(candidate => candidate.id === id);
		if (!thread || thread.isResolved || !thread.firstNoteYours || !thread.notes.some(isPeerBlocker)) return `resolution target ${id} is not an unresolved peer finding`;
	}
	return null;
}
