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
	baseSourceSha: string;
	files: PeerFile[];
}

interface ChangeFile {
	path: string;
	previousPath: string | null;
	status: string;
	additions: number;
	deletions: number;
	apiPatch: string | null;
}

type TextChange = Omit<PeerFile, "baseSource" | "headSource">;

type Obj = Record<string, unknown>;

const isObject = (value: unknown): value is Obj => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);
const count = (value: unknown): number | null => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null);
const sha = (value: unknown): string | null => typeof value === "string" && /^[0-9a-f]{40}$/.test(value) ? value : null;

function textChange(file: ChangeFile, patch: string | null): TextChange | null {
	if (patch === null) return null;
	const lines = patch.split(/\r?\n/);
	if (lines.at(-1) === "") lines.pop();
	const left = new Set<number>();
	const right = new Set<number>();
	let additions = 0;
	let deletions = 0;
	for (let i = 0; i < lines.length; ) {
		const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[i] ?? "");
		if (!header) return null;
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
					additions++;
					right.add(newLine++);
					break;
				case "-":
					if (oldRemaining-- <= 0) return null;
					deletions++;
					left.add(oldLine++);
					break;
				case "\\":
					if (line !== "\\ No newline at end of file") return null;
					break;
				default:
					return null;
			}
			i++;
		}
		if (oldRemaining !== 0 || newRemaining !== 0) return null;
	}
	if (lines.length === 0 || additions !== file.additions || deletions !== file.deletions) return null;
	return { path: file.path, previousPath: file.previousPath, status: file.status, patch, leftReviewLines: [...left], rightReviewLines: [...right] };
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
	const baseSha = sha(raw.base.sha);
	const headSha = sha(raw.head.sha);
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
	const additions = count(value.additions);
	const deletions = count(value.deletions);
	const previousPath = text(value.previous_filename);
	if (!file || !status || additions === null || deletions === null) return "GitHub returned incomplete changed-file metadata";
	if (!["added", "removed", "modified", "renamed", "copied", "changed"].includes(status)) return `GitHub returned an unsupported file status for ${file}`;
	if ((status === "renamed" || status === "copied") && previousPath === null) return `GitHub returned no previous path for ${file}`;
	return { path: file, previousPath, status, additions, deletions, apiPatch: text(value.patch) };
}

function diffPath(path: string): string {
	if (!/[^\x20-\x7e]|["\\]/.test(path)) return path;
	// Git quotes non-ASCII path bytes in octal, not Unicode code points.
	const escapes: Record<number, string> = { 7: "a", 8: "b", 9: "t", 10: "n", 11: "v", 12: "f", 13: "r", 34: '"', 92: "\\" };
	return '"' + Array.from(Buffer.from(path), byte => {
		const escape = escapes[byte];
		if (escape !== undefined) return `\\${escape}`;
		return byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : `\\${byte.toString(8).padStart(3, "0")}`;
	}).join("") + '"';
}

async function compareChanges(pr: PrRef, gh: Gh, snapshot: Pick<PeerSnapshot, "baseSha" | "headSha">, changed: ChangeFile[]): Promise<{ files: TextChange[]; baseSha: string } | string> {
	const endpoint = `repos/${pr.owner}/${pr.repo}/compare/${snapshot.baseSha}...${snapshot.headSha}`;
	const diff = await gh(["api", endpoint, "-H", "Accept: application/vnd.github.diff"]);
	if (diff.code !== 0) return "GitHub could not read the pinned comparison diff";
	if (!diff.out.startsWith("diff --git ") || !diff.out.endsWith("\n")) return "GitHub returned an incomplete pinned comparison diff";

	const sections = new Map<string, string>();
	for (const section of diff.out.split(/(?=^diff --git )/m)) {
		const header = section.slice(0, section.indexOf("\n"));
		if (sections.has(header)) return "GitHub returned a duplicate section in the pinned comparison diff";
		sections.set(header, section);
	}
	if (sections.size !== changed.length) return "the pinned comparison diff does not cover the changed-file list";

	const files: TextChange[] = [];
	for (const file of changed) {
		const header = `diff --git ${diffPath(`a/${file.previousPath ?? file.path}`)} ${diffPath(`b/${file.path}`)}`;
		const section = sections.get(header);
		const hunk = section?.search(/^@@ /m) ?? -1;
		const complete = textChange(file, section !== undefined && hunk !== -1 ? section.slice(hunk, -1) : null);
		if (complete === null) return `the pinned comparison has no complete text patch for ${file.path}`;
		sections.delete(header);
		files.push(complete);
	}

	// GitHub's three-dot diff uses the merge base, not the current base branch tip.
	const comparison = await gh(["api", `${endpoint}?per_page=1`]);
	if (comparison.code !== 0) return "GitHub could not read the pinned comparison merge base";
	let raw: unknown;
	try {
		raw = JSON.parse(comparison.out);
	} catch {
		return "GitHub returned unreadable pinned comparison metadata";
	}
	const baseSha = isObject(raw) && isObject(raw.merge_base_commit) ? sha(raw.merge_base_commit.sha) : null;
	return baseSha === null ? "GitHub returned no pinned comparison merge base" : { files, baseSha };
}

/** Read every changed file and its source. Recover omitted hunks from the pinned comparison. */
export async function readPeerDiff(pr: PrRef, gh: Gh, snapshot: Pick<PeerSnapshot, "baseSha" | "headSha">): Promise<PeerDiff | string> {
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

	let changes = changed.map(file => textChange(file, file.apiPatch)).filter(file => file !== null);
	let baseSha = snapshot.baseSha;
	if (changes.length !== changed.length) {
		const recovered = await compareChanges(pr, gh, snapshot, changed);
		if (typeof recovered === "string") return recovered;
		changes = recovered.files;
		baseSha = recovered.baseSha;
	}

	const files: PeerDiff["files"] = [];
	for (let i = 0; i < changes.length; i += 4) {
		const batch = changes.slice(i, i + 4);
		const loaded = await Promise.all(batch.map(async file => {
			const oldPath = file.previousPath ?? file.path;
			const base = file.status === "added" ? null : await sourceAt(pr, oldPath, baseSha, gh);
			if (file.status !== "added" && base === null) return `can't read ${oldPath} at captured base ${baseSha}`;
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
	return { files, baseSourceSha: baseSha };
}
