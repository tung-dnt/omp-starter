import type { Gh, PeerSnapshot, PrRef } from "../ship/types";

export interface PeerFile {
	path: string;
	previousPath: string | null;
	status: string;
	patch: string;
	leftReviewLines: number[];
	rightReviewLines: number[];
	baseSource: string | null;
	headSource: string | null;
}

export interface PeerDiff {
	files: PeerFile[];
}

interface ChangeFile {
	path: string;
	previousPath: string | null;
	status: string;
	patch: string;
	leftReviewLines: number[];
	rightReviewLines: number[];
}

type Obj = Record<string, unknown>;

const isObject = (value: unknown): value is Obj => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);
const count = (value: unknown): number | null => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null);

/** New- and old-side line anchors that are part of GitHub's reviewable diff. */
function reviewLines(patch: string): { left: number[]; right: number[] } | null {
	const lines = patch.split(/\r?\n/);
	if (lines.at(-1) === "") lines.pop();
	const left = new Set<number>();
	const right = new Set<number>();
	let sawHunk = false;
	for (let i = 0; i < lines.length; ) {
		const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[i] ?? "");
		if (!header) return null;
		sawHunk = true;
		let oldLine = Number(header[1]);
		let oldRemaining = Number(header[2] ?? 1);
		let newLine = Number(header[3]);
		let newRemaining = Number(header[4] ?? 1);
		if (!Number.isSafeInteger(oldLine) || !Number.isSafeInteger(newLine) || oldLine < 0 || newLine < 0) return null;
		i++;
		while (i < lines.length && !lines[i]?.startsWith("@@ ")) {
			const line = lines[i] ?? "";
			switch (line[0]) {
				case " ":
					if (oldRemaining-- <= 0 || newRemaining-- <= 0) return null;
					left.add(oldLine++);
					right.add(newLine++);
					break;
				case "+":
					if (newRemaining-- <= 0) return null;
					right.add(newLine++);
					break;
				case "-":
					if (oldRemaining-- <= 0) return null;
					left.add(oldLine++);
					break;
				case "\\":
					break;
				default:
					return null;
			}
			i++;
		}
		if (oldRemaining !== 0 || newRemaining !== 0) return null;
	}
	return sawHunk ? { left: [...left], right: [...right] } : null;
}

async function pullPair(pr: PrRef, gh: Gh): Promise<{ baseSha: string; headSha: string; changedFiles: number } | string> {
	const response = await gh(["api", `repos/${pr.owner}/${pr.repo}/pulls/${pr.number}`]);
	if (response.code !== 0) return "GitHub could not verify the PR's current base and head";
	let raw: unknown;
	try {
		raw = JSON.parse(response.out);
	} catch {
		return "GitHub returned unreadable PR identity data";
	}
	if (!isObject(raw) || !isObject(raw.base) || !isObject(raw.head)) return "GitHub returned incomplete PR identity data";
	const baseSha = text(raw.base.sha);
	const headSha = text(raw.head.sha);
	const changedFiles = count(raw.changed_files);
	return baseSha && headSha && changedFiles !== null ? { baseSha, headSha, changedFiles } : "GitHub returned incomplete PR commit or changed-file data";
}

async function sourceAt(pr: PrRef, file: string, sha: string, gh: Gh): Promise<string | null> {
	const encodedPath = file.split("/").map(encodeURIComponent).join("/");
	const response = await gh(["api", `repos/${pr.owner}/${pr.repo}/contents/${encodedPath}?ref=${sha}`]);
	if (response.code !== 0) return null;
	let raw: unknown;
	try {
		raw = JSON.parse(response.out);
	} catch {
		return null;
	}
	if (!isObject(raw) || raw.type !== "file" || raw.encoding !== "base64") return null;
	const size = count(raw.size);
	const content = typeof raw.content === "string" ? raw.content.replace(/\s/g, "") : null;
	if (size === null || size > 1_000_000 || content === null || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(content)) return null;
	const bytes = Buffer.from(content, "base64");
	if (bytes.byteLength !== size) return null;
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return null;
	}
}

function parseChange(value: unknown): ChangeFile | string {
	if (!isObject(value)) return "GitHub returned an invalid changed-file entry";
	const file = text(value.filename);
	const status = text(value.status);
	const patch = text(value.patch);
	const previousPath = text(value.previous_filename);
	if (!file || !status || !patch) return "a changed file has no complete text patch";
	if (status === "renamed" && previousPath === null) return "GitHub returned an incomplete rename";
	if (!["added", "removed", "modified", "renamed", "copied", "changed"].includes(status)) return `GitHub returned an unsupported file status for ${file}`;
	const anchors = reviewLines(patch);
	if (anchors === null) return `GitHub returned an incomplete diff hunk for ${file}`;
	return { path: file, previousPath, status, patch, leftReviewLines: anchors.left, rightReviewLines: anchors.right };
}

/** Read every paginated changed file, then fetch extant source at the captured immutable base/head commits. */
export async function readPeerDiff(pr: PrRef, gh: Gh, snapshot: PeerSnapshot): Promise<PeerDiff | string> {
	const before = await pullPair(pr, gh);
	if (typeof before === "string") return before;
	if (before.baseSha !== snapshot.baseSha || before.headSha !== snapshot.headSha) return "the PR base or head changed before its diff was read";
	if (before.changedFiles > 3000) return "GitHub's 3000-file API limit prevents a complete review";

	const changed: ChangeFile[] = [];
	const paths = new Set<string>();
	for (let page = 1; page <= 30; page++) {
		const pair = await pullPair(pr, gh);
		if (typeof pair === "string") return pair;
		if (pair.baseSha !== snapshot.baseSha || pair.headSha !== snapshot.headSha) return "the PR base or head changed during diff pagination";
		const response = await gh(["api", `repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/files?per_page=100&page=${page}`]);
		if (response.code !== 0) return `GitHub changed-file page ${page} failed`;
		let raw: unknown;
		try {
			raw = JSON.parse(response.out);
		} catch {
			return `GitHub changed-file page ${page} was unreadable`;
		}
		if (!Array.isArray(raw) || raw.length > 100) return `GitHub changed-file page ${page} was incomplete`;
		for (const item of raw) {
			const file = parseChange(item);
			if (typeof file === "string") return file;
			if (paths.has(file.path)) return "GitHub returned a duplicate changed-file path";
			paths.add(file.path);
			changed.push(file);
		}
		const after = await pullPair(pr, gh);
		if (typeof after === "string") return after;
		if (after.baseSha !== snapshot.baseSha || after.headSha !== snapshot.headSha) return "the PR base or head changed during diff pagination";
		if (raw.length < 100) break;
	}
	if (changed.length !== before.changedFiles) return "GitHub returned an incomplete changed-file list";

	const files: PeerDiff["files"] = [];
	for (let i = 0; i < changed.length; i += 4) {
		const batch = changed.slice(i, i + 4);
		const loaded = await Promise.all(batch.map(async file => {
			const oldPath = file.previousPath ?? file.path;
			const base = file.status === "added" ? null : await sourceAt(pr, oldPath, snapshot.baseSha, gh);
			if (file.status !== "added" && base === null) return `can't read ${oldPath} at captured base ${snapshot.baseSha}`;
			const head = file.status === "removed" ? null : await sourceAt(pr, file.path, snapshot.headSha, gh);
			if (file.status !== "removed" && head === null) return `can't read ${file.path} at captured head ${snapshot.headSha}`;
			return { ...file, baseSource: base, headSource: head };
		}));
		for (const file of loaded) {
			if (typeof file === "string") return file;
			files.push(file);
		}
	}
	const after = await pullPair(pr, gh);
	if (typeof after === "string") return after;
	if (after.baseSha !== snapshot.baseSha || after.headSha !== snapshot.headSha) return "the PR base or head changed while reading pinned source";
	return { files };
}
