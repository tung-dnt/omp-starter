#!/usr/bin/env bun
// Read-only report on how agents use the knowledge base and the native todo, mined from omp session
// transcripts (`~/.omp/agent/sessions/**/*.jsonl`). No model calls, no network.
//
//   bun scripts/usage-report.ts [--sessions <dir>] [--vault <KnowledgeBase dir>] [--since YYYY-MM-DD] [--json <file>]
//
// Privacy: the output holds counts, session file names, repo names, tool names and note slugs. Message
// text, tool arguments, command lines and file contents are read only to classify a call and are never
// kept in the report.
import * as fs from "node:fs";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { checkMemory, type MemoryProblems } from "../extensions/lib/kb-report";
import { listMemoryDir, memoryDir } from "../extensions/lib/kb-store";
import { doneSources } from "../extensions/lib/kb-sources";
import { isGlobal, parseMemoryIndex, type MemorySection } from "../extensions/lib/memory-index";
import { frontmatterDescription, listEntries, splitNote } from "../extensions/lib/memory-notes";
import { resolveRepoName } from "../extensions/lib/repo";
import { expandHome, HOME, readState } from "../extensions/lib/state";

// ── Parsing ──────────────────────────────────────────────────────────────────────────────────────

/** A tool call reduced to what the metrics need. `kb_recall` etc. come from `write` to `xd://<tool>`. */
export type ToolCall = {
	name: string;
	/** Target of read/write/edit/ast_edit; for `kb_remember` the saved note slug is in `slug`, never the body. */
	path?: string;
	/** Kept only for `git commit` bash calls (to detect `[skip-mem]`); never reported. */
	command?: string;
	slug?: string;
	/** Extra file of a multi-file edit: counts toward file checks, not as another call. */
	extra?: true;
	at: number;
};

export type TodoSnapshot = {
	op: string;
	at: number;
	/** Number of `calls` recorded when this snapshot arrived. */
	callIndex: number;
	/** Items still pending or in progress. */
	open: number;
};

export type Session = {
	file: string;
	cwd: string;
	repo: string | undefined;
	/** Transcript of a subagent (nested under a session folder), not of a main session. */
	nested: boolean;
	calls: ToolCall[];
	todoSnapshots: TodoSnapshot[];
	/** Assistant turns whose only tool calls were `todo`. */
	todoOnlyTurns: number;
	startedAt: number;
	/** Time of the last tool activity in the file. */
	endedAt: number;
	version: number;
	badLines: number;
};

export type Skipped = { skipped: string; badLines: number };

const SCHEMA_VERSION = 3;
const HEADER_SCAN_LIMIT = 50;
const EDIT_TOOLS = new Set(["edit", "write", "ast_edit"]);
const URI = /^[a-z][a-z0-9+.-]*:\/\//i;
const MEMORY_PATH = /(?:^|\/)_memory\/([^/]+)$/;
const GIT_COMMIT = /(?:^|[\s;&|(])git(?:\s+-\S+(?:\s+(?!commit(?![\w-]))\S+)?)*\s+commit(?![\w-])/;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** File paths named by an `edit` call: hashline `[path#TAG]` headers, `*** Update File:` patches, or a plain `path`. */
function editPaths(args: Record<string, unknown>): string[] {
	if (typeof args.path === "string") return [args.path];
	const input = typeof args.input === "string" ? args.input : "";
	const out: string[] = [];
	for (const line of input.split("\n")) {
		const patch = /^\*\*\* (?:Add|Update|Delete) File: (.+?)\s*$/.exec(line) ?? /^\*\*\* Move to: (.+?)\s*$/.exec(line);
		const hash = patch ? undefined : /^\[([^\]\n]+?)(?:#[0-9A-Za-z]*)?\]\s*$/.exec(line);
		const found = (patch ?? hash)?.[1];
		if (found && !out.includes(found)) out.push(found);
	}
	return out;
}

function slugOf(value: unknown): string | undefined {
	if (isRecord(value) && typeof value.slug === "string") return value.slug;
	if (typeof value !== "string") return undefined;
	try {
		return slugOf(JSON.parse(value));
	} catch {
		return undefined;
	}
}

function normalise(name: string, rawArgs: unknown, at: number): ToolCall[] {
	const args = isRecord(rawArgs) ? rawArgs : {};
	const target = typeof args.path === "string" ? args.path : undefined;
	if (name === "write" && target?.startsWith("xd://")) {
		const device = target.slice("xd://".length).split(/[/?#]/)[0] ?? "";
		return [{ name: device, slug: device === "kb_remember" ? slugOf(args.content) : undefined, at }];
	}
	if (name === "kb_remember") return [{ name, slug: slugOf(args), at }];
	if (name === "edit") {
		const paths = editPaths(args);
		if (!paths.length) return [{ name, at }];
		return paths.map((p, i) => ({ name, path: p, at, ...(i > 0 ? { extra: true as const } : {}) }));
	}
	if (name === "bash") {
		const command = typeof args.command === "string" ? args.command : "";
		return [{ name, ...(GIT_COMMIT.test(command) ? { command } : {}), at }];
	}
	if (name === "read" || name === "write" || name === "ast_edit") return [{ name, path: target, at }];
	return [{ name, at }];
}

/** Parses one transcript. Streams the lines it is given; only lines that can matter are JSON-parsed. */
export function parseSession(lines: Iterable<string>, file: string): Session | Skipped {
	let bad = 0;
	let header: { cwd: string; version: number; startedAt: number } | undefined;
	let seen = 0;
	let endedAt = 0;
	const calls: ToolCall[] = [];
	const todoSnapshots: TodoSnapshot[] = [];
	let todoOnlyTurns = 0;

	for (const line of lines) {
		if (!line.trim()) continue;
		const last = line.charCodeAt(line.length - 1) === 13 ? line.length - 2 : line.length - 1;
		if (line.charCodeAt(0) !== 123 || line.charCodeAt(last) !== 125) {
			bad++;
			continue;
		}
		if (!header) {
			if (++seen > HEADER_SCAN_LIMIT) return { skipped: "schema: no session header", badLines: bad };
			if (!line.startsWith('{"type":"session"')) continue;
		} else if (!line.includes('"toolCall"') && !line.includes('"toolName":"todo"')) continue;

		let rec: unknown;
		try {
			rec = JSON.parse(line);
		} catch {
			bad++;
			continue;
		}
		if (!isRecord(rec)) continue;
		const stamp = typeof rec.timestamp === "string" ? Date.parse(rec.timestamp) : Number.NaN;

		if (!header) {
			if (rec.type !== "session") continue;
			if (rec.version !== SCHEMA_VERSION) return { skipped: `schema: version ${String(rec.version)}`, badLines: bad };
			if (typeof rec.cwd !== "string") return { skipped: "schema: no cwd", badLines: bad };
			header = { cwd: rec.cwd, version: rec.version, startedAt: Number.isNaN(stamp) ? 0 : stamp };
			continue;
		}
		if (rec.type !== "message" || !isRecord(rec.message)) continue;
		const at = Number.isNaN(stamp) ? endedAt : stamp;
		const message = rec.message;

		if (message.role === "assistant" && Array.isArray(message.content)) {
			const turn = message.content.filter((c): c is Record<string, unknown> => isRecord(c) && c.type === "toolCall" && typeof c.name === "string");
			if (!turn.length) continue;
			endedAt = at;
			if (turn.every(c => c.name === "todo")) todoOnlyTurns++;
			for (const c of turn) calls.push(...normalise(c.name as string, c.arguments, at));
		} else if (message.role === "toolResult" && message.toolName === "todo" && isRecord(message.details)) {
			endedAt = at;
			const phases = Array.isArray(message.details.phases) ? message.details.phases : [];
			let open = 0;
			for (const phase of phases) {
				const tasks = isRecord(phase) && Array.isArray(phase.tasks) ? phase.tasks : [];
				for (const t of tasks) if (isRecord(t) && (t.status === "pending" || t.status === "in_progress")) open++;
			}
			todoSnapshots.push({ op: String(message.details.op ?? ""), at, callIndex: calls.length, open });
		}
	}
	if (!header) return { skipped: "schema: no session header", badLines: bad };
	return {
		file,
		cwd: header.cwd,
		repo: undefined,
		nested: false,
		calls,
		todoSnapshots,
		todoOnlyTurns,
		startedAt: header.startedAt,
		endedAt: endedAt || header.startedAt,
		version: header.version,
		badLines: bad,
	};
}

/** Lines of a file without loading it whole. */
export function* readLines(file: string): Generator<string> {
	const fd = fs.openSync(file, "r");
	try {
		const buf = Buffer.allocUnsafe(1 << 18);
		const decoder = new StringDecoder("utf8");
		let carry = "";
		for (;;) {
			const n = fs.readSync(fd, buf, 0, buf.length, null);
			if (n === 0) break;
			carry += decoder.write(buf.subarray(0, n));
			let start = 0;
			for (let nl = carry.indexOf("\n", start); nl >= 0; nl = carry.indexOf("\n", start)) {
				yield carry.slice(start, nl);
				start = nl + 1;
			}
			carry = carry.slice(start);
		}
		carry += decoder.end();
		if (carry) yield carry;
	} finally {
		fs.closeSync(fd);
	}
}

// ── Vault ────────────────────────────────────────────────────────────────────────────────────────

export type VaultIndex = {
	sections: MemorySection[];
	entries: { slug: string; section: string }[];
	notes: number;
	problems: MemoryProblems;
	nearDuplicates: { a: string; b: string; similarity: number }[];
};

const tokens = (text: string): Set<string> => new Set(text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(t => t.length > 1));

function jaccard(a: Set<string>, b: Set<string>): number {
	if (!a.size || !b.size) return 0;
	let shared = 0;
	for (const t of a) if (b.has(t)) shared++;
	return shared / (a.size + b.size - shared);
}

/** Reads `<vault>/_memory`: index, notes and the `/kb check` findings. Throws when the folder or index is unreadable. */
export function loadVault(vault: string): VaultIndex {
	const dir = path.join(vault, "_memory");
	const indexText = fs.readFileSync(path.join(dir, "MEMORY.md"), "utf8");
	const listing = listMemoryDir(dir);
	const notes = listing.notes.map(slug => ({ slug, text: fs.readFileSync(path.join(dir, `${slug}.md`), "utf8") }));
	const names = notes.map(n => {
		const description = frontmatterDescription(splitNote(n.text).frontmatter);
		return { slug: n.slug, tokens: tokens(`${n.slug.replace(/[-_]/g, " ")} ${description}`) };
	});
	const nearDuplicates: VaultIndex["nearDuplicates"] = [];
	for (let i = 0; i < names.length; i++) {
		for (let j = i + 1; j < names.length; j++) {
			const similarity = jaccard(names[i].tokens, names[j].tokens);
			if (similarity >= 0.8) nearDuplicates.push({ a: names[i].slug, b: names[j].slug, similarity: Math.round(similarity * 100) / 100 });
		}
	}
	return {
		sections: parseMemoryIndex(indexText),
		entries: listEntries(indexText).map(e => ({ slug: e.slug, section: e.section })),
		notes: notes.length,
		problems: checkMemory(indexText, notes, listing.evicted, listing.copies),
		nearDuplicates,
	};
}

// ── Metrics ──────────────────────────────────────────────────────────────────────────────────────

type Verdict = "pass" | "fail" | "n/a";

export type SessionRow = {
	file: string;
	repo: string | undefined;
	nested: boolean;
	calls: number;
	m1: Verdict;
	m1Why?: string;
	m2: Verdict | "skip-mem";
	m3: { ok: number; wrong: number; missing: number; unknownRepo: number } | "vault unavailable";
	m5: { endsOpen: boolean | undefined; lag: number | undefined; todoOnlyTurns: number } | undefined;
};

export type GroupReport = {
	sessions: number;
	m1: { applicable: number; pass: number; fail: number; notApplicable: Record<string, number> };
	m2: { sessions: number; pass: number; fail: number; skipMem: number };
	m3: { notes: number; ok: number; wrong: number; missing: number; unknownRepo: number } | "vault unavailable";
	m5: { sessions: number; endedClean: number; endedOpen: number; noResult: number; lagMean: number; lagMedian: number; lagMax: number; todoOnlyTurns: number };
	m6: Record<"kb_remember" | "kb_recall" | "memoryFileWrites" | "todo", { calls: number; sessions: number }>;
};

export type Report = {
	vaultAvailable: boolean;
	main: GroupReport;
	subagents: GroupReport;
	m4: { notes: number; dangling: { slug: string; section: string }[]; unindexed: string[]; nearDuplicates: VaultIndex["nearDuplicates"] } | "vault unavailable";
	rows: SessionRow[];
};

const isMemoryPath = (p: string | undefined): boolean => p !== undefined && MEMORY_PATH.test(p.split(/[?#]/)[0]);
const isSave = (c: ToolCall): boolean => c.name === "kb_remember" || (EDIT_TOOLS.has(c.name) && isMemoryPath(c.path));

function savedSlugs(calls: ToolCall[]): Set<string> {
	const out = new Set<string>();
	for (const c of calls) {
		if (c.name === "kb_remember" && c.slug) out.add(c.slug);
		else if (EDIT_TOOLS.has(c.name) && c.path) {
			const m = MEMORY_PATH.exec(c.path.split(/[?#]/)[0]);
			if (m && m[1].endsWith(".md") && m[1] !== "MEMORY.md") out.add(m[1].slice(0, -3));
		}
	}
	return out;
}

/** An edit of a file inside the session's checkout; memory notes, URIs and files elsewhere do not count. */
function isRepoEdit(c: ToolCall, cwd: string): boolean {
	if (!EDIT_TOOLS.has(c.name)) return false;
	if (c.path === undefined) return true;
	if (URI.test(c.path) || isMemoryPath(c.path)) return false;
	const resolved = path.resolve(cwd, expandHome(c.path.split(/[?#]/)[0]));
	return resolved === cwd || resolved.startsWith(cwd + path.sep);
}

/** Whether a call consulted the memory: kb_recall, a note in `_memory/`, or the repo's project page. */
function isRecall(c: ToolCall, repo: string | undefined): boolean {
	if (c.name === "kb_recall") return true;
	if (c.name !== "read" || !c.path || URI.test(c.path)) return false;
	const p = c.path.replace(/:[\d,+-]+$/, "");
	const note = /(?:^|\/)_memory\/([^/]+\.md)$/.exec(p);
	if (note) return note[1] !== "MEMORY.md";
	const page = /(?:^|\/)KnowledgeBase\/projects\/([^/]+)\.md$/.exec(p);
	return page !== null && repo !== undefined && page[1].toLowerCase() === repo.toLowerCase();
}

const repoNoteCount = (vault: VaultIndex, repo: string): number =>
	vault.sections.filter(s => !isGlobal(s.name) && s.repos.includes(repo.toLowerCase())).reduce((n, s) => n + s.lines, 0);

function rowFor(s: Session, vault: VaultIndex | undefined): SessionRow {
	const row: SessionRow = { file: s.file, repo: s.repo, nested: s.nested, calls: s.calls.length, m1: "n/a", m2: "n/a", m3: "vault unavailable", m5: undefined };

	// M1: recall before the first edit of a repo file.
	const firstEdit = s.calls.findIndex(c => isRepoEdit(c, s.cwd));
	if (firstEdit < 0) row.m1Why = "no repo edit";
	else if (!vault) row.m1Why = "vault unavailable";
	else if (!s.repo) row.m1Why = "repo unresolved";
	else if (repoNoteCount(vault, s.repo) === 0) row.m1Why = "no repo notes";
	else row.m1 = s.calls.slice(0, firstEdit).some(c => isRecall(c, s.repo)) ? "pass" : "fail";

	// M2: a save before the first real `git commit`.
	const commits = s.calls.map((c, i) => ({ c, i })).filter(x => x.c.command !== undefined);
	if (commits.length) {
		const real = commits.find(x => !x.c.command!.includes("[skip-mem]"));
		row.m2 = !real ? "skip-mem" : s.calls.slice(0, real.i).some(isSave) ? "pass" : "fail";
	}

	// M3: each saved note is indexed under the session's repo or Global.
	if (vault) {
		const tally = { ok: 0, wrong: 0, missing: 0, unknownRepo: 0 };
		const repo = s.repo?.toLowerCase();
		for (const slug of savedSlugs(s.calls)) {
			const where = vault.entries.filter(e => e.slug === slug).map(e => e.section);
			if (!where.length) tally.missing++;
			else if (where.some(name => isGlobal(name))) tally.ok++;
			else if (!repo) tally.unknownRepo++;
			else if (where.some(name => vault.sections.some(sec => sec.name.toLowerCase() === name.toLowerCase() && sec.repos.includes(repo)))) tally.ok++;
			else tally.wrong++;
		}
		row.m3 = tally;
	}

	// M5: todo hygiene.
	if (s.calls.some(c => c.name === "todo")) {
		const updates = s.todoSnapshots.filter(t => t.op !== "view");
		const final = s.todoSnapshots.at(-1);
		const lastUpdate = updates.at(-1);
		row.m5 = {
			endsOpen: final ? final.open > 0 : undefined,
			lag: lastUpdate ? s.calls.slice(lastUpdate.callIndex).filter(c => !c.extra && (c.name === "edit" || c.name === "write" || c.name === "bash") && !(c.name === "write" && c.path?.startsWith("xd://"))).length : undefined,
			todoOnlyTurns: s.todoOnlyTurns,
		};
	}
	return row;
}

function group(sessions: Session[], rows: SessionRow[], vault: VaultIndex | undefined): GroupReport {
	const g: GroupReport = {
		sessions: sessions.length,
		m1: { applicable: 0, pass: 0, fail: 0, notApplicable: {} },
		m2: { sessions: 0, pass: 0, fail: 0, skipMem: 0 },
		m3: vault ? { notes: 0, ok: 0, wrong: 0, missing: 0, unknownRepo: 0 } : "vault unavailable",
		m5: { sessions: 0, endedClean: 0, endedOpen: 0, noResult: 0, lagMean: 0, lagMedian: 0, lagMax: 0, todoOnlyTurns: 0 },
		m6: { kb_remember: { calls: 0, sessions: 0 }, kb_recall: { calls: 0, sessions: 0 }, memoryFileWrites: { calls: 0, sessions: 0 }, todo: { calls: 0, sessions: 0 } },
	};
	const lags: number[] = [];
	sessions.forEach((s, i) => {
		const row = rows[i];
		if (row.m1 === "n/a") g.m1.notApplicable[row.m1Why ?? "n/a"] = (g.m1.notApplicable[row.m1Why ?? "n/a"] ?? 0) + 1;
		else {
			g.m1.applicable++;
			g.m1[row.m1]++;
		}
		if (row.m2 !== "n/a") {
			g.m2.sessions++;
			if (row.m2 === "skip-mem") g.m2.skipMem++;
			else g.m2[row.m2]++;
		}
		if (typeof g.m3 === "object" && typeof row.m3 === "object") {
			g.m3.ok += row.m3.ok;
			g.m3.wrong += row.m3.wrong;
			g.m3.missing += row.m3.missing;
			g.m3.unknownRepo += row.m3.unknownRepo;
			g.m3.notes += row.m3.ok + row.m3.wrong + row.m3.missing + row.m3.unknownRepo;
		}
		if (row.m5) {
			g.m5.sessions++;
			g.m5.todoOnlyTurns += row.m5.todoOnlyTurns;
			if (row.m5.endsOpen === undefined) g.m5.noResult++;
			else if (row.m5.endsOpen) g.m5.endedOpen++;
			else g.m5.endedClean++;
			if (row.m5.lag !== undefined) lags.push(row.m5.lag);
		}
		const count = (key: keyof GroupReport["m6"], n: number) => {
			if (!n) return;
			g.m6[key].calls += n;
			g.m6[key].sessions++;
		};
		count("kb_remember", s.calls.filter(c => c.name === "kb_remember").length);
		count("kb_recall", s.calls.filter(c => c.name === "kb_recall").length);
		count("memoryFileWrites", s.calls.filter(c => !c.extra && EDIT_TOOLS.has(c.name) && isMemoryPath(c.path)).length);
		count("todo", s.calls.filter(c => c.name === "todo").length);
	});
	if (lags.length) {
		lags.sort((a, b) => a - b);
		g.m5.lagMean = Math.round((lags.reduce((a, b) => a + b, 0) / lags.length) * 10) / 10;
		g.m5.lagMedian = lags[Math.floor(lags.length / 2)];
		g.m5.lagMax = lags[lags.length - 1];
	}
	return g;
}

export function metrics(sessions: Session[], vault: VaultIndex | undefined): Report {
	const rows = sessions.map(s => rowFor(s, vault));
	const pick = (nested: boolean) => {
		const idx = sessions.map((s, i) => (s.nested === nested ? i : -1)).filter(i => i >= 0);
		return group(idx.map(i => sessions[i]), idx.map(i => rows[i]), vault);
	};
	return {
		vaultAvailable: vault !== undefined,
		main: pick(false),
		subagents: pick(true),
		m4: vault
			? { notes: vault.notes, dangling: vault.problems.dangling, unindexed: vault.problems.unindexed, nearDuplicates: vault.nearDuplicates }
			: "vault unavailable",
		rows,
	};
}

// ── Rendering ────────────────────────────────────────────────────────────────────────────────────

export type Coverage = {
	read: { main: number; subagents: number };
	skipped: Record<string, number>;
	badLines: number;
	filteredBySince: number;
	versions: Record<string, number>;
	repoUnresolved: number;
};

const pct = (n: number, d: number): string => (d ? `${((n / d) * 100).toFixed(1)}%` : "n/a");
const table = (head: string[], rows: (string | number)[][]): string =>
	[`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...rows.map(r => `| ${r.join(" | ")} |`)].join("\n");
const LIST_LIMIT = 25;
const list = (items: string[]): string => (items.length ? items.slice(0, LIST_LIMIT).join(", ") + (items.length > LIST_LIMIT ? `, +${items.length - LIST_LIMIT} more` : "") : "none");

export function coverageLine(c: Coverage): string {
	const skipped = Object.entries(c.skipped).map(([k, v]) => `${k} ×${v}`);
	const total = Object.values(c.skipped).reduce((a, b) => a + b, 0);
	const versions = Object.entries(c.versions).map(([v, n]) => `v${v} ×${n}`);
	return (
		`Coverage: read ${c.read.main + c.read.subagents} files (${c.read.main} main, ${c.read.subagents} subagent); ` +
		`skipped ${total}${skipped.length ? ` (${skipped.join(", ")})` : ""}; ${c.badLines} malformed lines; ` +
		`${c.filteredBySince} files before --since; schema versions read: ${versions.join(", ") || "none"}; ` +
		`repo unresolved in ${c.repoUnresolved} sessions.`
	);
}

export function render(r: Report, coverage: Coverage): string {
	const both = [["main", r.main], ["subagents", r.subagents]] as const;
	const out: string[] = [];
	out.push("## M1 Recall before the first repo edit", table(
		["group", "sessions", "applicable", "recalled first", "edited first", "recall rate", "not applicable"],
		both.map(([n, g]) => [n, g.sessions, g.m1.applicable, g.m1.pass, g.m1.fail, pct(g.m1.pass, g.m1.applicable), Object.entries(g.m1.notApplicable).map(([k, v]) => `${k} ${v}`).join(", ") || "-"]),
	));
	out.push("## M2 Save before commit", table(
		["group", "sessions with git commit", "saved first", "no save", "all [skip-mem]", "save rate"],
		both.map(([n, g]) => [n, g.m2.sessions, g.m2.pass, g.m2.fail, g.m2.skipMem, pct(g.m2.pass, g.m2.pass + g.m2.fail)]),
	));
	out.push("## M3 Save scope", typeof r.main.m3 === "string" ? "vault unavailable" : table(
		["group", "notes saved", "right section", "wrong section", "not in index", "repo unknown", "right rate"],
		both.map(([n, g]) => {
			const m = g.m3 as Exclude<GroupReport["m3"], string>;
			return [n, m.notes, m.ok, m.wrong, m.missing, m.unknownRepo, pct(m.ok, m.ok + m.wrong)];
		}),
	));
	if (typeof r.m4 === "string") out.push("## M4 Vault hygiene", "vault unavailable");
	else {
		out.push(
			"## M4 Vault hygiene",
			table(["notes", "dangling index lines", "unindexed notes", "near-duplicate pairs"], [[r.m4.notes, r.m4.dangling.length, r.m4.unindexed.length, r.m4.nearDuplicates.length]]),
			[
				`- dangling: ${list(r.m4.dangling.map(d => `${d.slug} (${d.section})`))}`,
				`- unindexed: ${list(r.m4.unindexed)}`,
				`- near duplicates: ${list(r.m4.nearDuplicates.map(d => `${d.a} ~ ${d.b} (${d.similarity})`))}`,
			].join("\n"),
		);
	}
	out.push("## M5 Todo hygiene", table(
		["group", "sessions with todo", "ended clean", "ended with open items", "no result seen", "mean lag", "median lag", "max lag", "todo-only turns"],
		both.map(([n, g]) => [n, g.m5.sessions, g.m5.endedClean, g.m5.endedOpen, g.m5.noResult, g.m5.lagMean, g.m5.lagMedian, g.m5.lagMax, g.m5.todoOnlyTurns]),
	), "Lag = edit/write/bash calls after the last todo update when the session ends.");
	out.push("## M6 Tool split", table(
		["group", "kb_remember calls (sessions)", "kb_recall calls (sessions)", "_memory file writes (sessions)", "todo calls (sessions)"],
		both.map(([n, g]) => [n, ...(["kb_remember", "kb_recall", "memoryFileWrites", "todo"] as const).map(k => `${g.m6[k].calls} (${g.m6[k].sessions})`)]),
	));
	out.push(coverageLine(coverage));
	return out.join("\n\n");
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────────

type Options = { sessions: string; vault?: string; since?: number; json?: string };

export function parseArgs(argv: string[]): Options {
	const opts: Options = { sessions: path.join(HOME, ".omp", "agent", "sessions") };
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i];
		const value = argv[i + 1];
		if (!["--sessions", "--vault", "--since", "--json"].includes(flag)) throw new Error(`Unknown argument "${flag}"`);
		if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value`);
		i++;
		if (flag === "--sessions") opts.sessions = path.resolve(expandHome(value));
		else if (flag === "--vault") opts.vault = path.resolve(expandHome(value));
		else if (flag === "--json") opts.json = path.resolve(expandHome(value));
		else {
			if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value))) throw new Error(`--since needs YYYY-MM-DD, got "${value}"`);
			opts.since = Date.parse(value);
		}
	}
	return opts;
}

/** Transcript files under `root`; those at most one folder deep are main sessions, deeper ones are subagents. */
export function findTranscripts(root: string): { file: string; rel: string; nested: boolean }[] {
	const out: { file: string; rel: string; nested: boolean }[] = [];
	const walk = (dir: string, depth: number) => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(full, depth + 1);
			else if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push({ file: full, rel: path.relative(root, full), nested: depth >= 2 });
		}
	};
	walk(root, 0);
	return out;
}

function resolveVault(explicit: string | undefined): VaultIndex | undefined {
	try {
		if (explicit) return loadVault(explicit);
		try {
			return loadVault(path.dirname(memoryDir(process.cwd()).dir));
		} catch {
			const source = doneSources(readState().kb)[0];
			return source ? loadVault(expandHome(source.kbRef)) : undefined;
		}
	} catch {
		return undefined;
	}
}

export function main(argv: string[]): number {
	let opts: Options;
	try {
		opts = parseArgs(argv);
	} catch (error) {
		console.error(`${(error as Error).message}\nUsage: bun scripts/usage-report.ts [--sessions <dir>] [--vault <KnowledgeBase dir>] [--since YYYY-MM-DD] [--json <file>]`);
		return 2;
	}
	if (opts.json && (opts.json === opts.sessions || opts.json.startsWith(opts.sessions + path.sep))) {
		console.error("--json must point outside the sessions folder");
		return 2;
	}
	if (!fs.existsSync(opts.sessions)) {
		console.log(`No sessions: ${opts.sessions} does not exist.`);
		return 0;
	}

	const coverage: Coverage = { read: { main: 0, subagents: 0 }, skipped: {}, badLines: 0, filteredBySince: 0, versions: {}, repoUnresolved: 0 };
	const sessions: Session[] = [];
	const repos = new Map<string, string | undefined>();
	for (const t of findTranscripts(opts.sessions)) {
		const parsed = parseSession(readLines(t.file), t.rel);
		coverage.badLines += parsed.badLines;
		if ("skipped" in parsed) {
			coverage.skipped[parsed.skipped] = (coverage.skipped[parsed.skipped] ?? 0) + 1;
			continue;
		}
		if (opts.since !== undefined && parsed.startedAt < opts.since) {
			coverage.filteredBySince++;
			continue;
		}
		if (!repos.has(parsed.cwd)) repos.set(parsed.cwd, resolveRepoName(parsed.cwd));
		parsed.repo = repos.get(parsed.cwd);
		parsed.nested = t.nested;
		if (!parsed.repo) coverage.repoUnresolved++;
		coverage.read[t.nested ? "subagents" : "main"]++;
		coverage.versions[parsed.version] = (coverage.versions[parsed.version] ?? 0) + 1;
		sessions.push(parsed);
	}
	if (!sessions.length) {
		console.log(`No sessions found in ${opts.sessions}.\n\n${coverageLine(coverage)}`);
		return 0;
	}
	const report = metrics(sessions, resolveVault(opts.vault));
	console.log(render(report, coverage));
	if (opts.json) {
		fs.mkdirSync(path.dirname(opts.json), { recursive: true });
		fs.writeFileSync(opts.json, `${JSON.stringify({ coverage, ...report }, null, 2)}\n`);
	}
	return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
