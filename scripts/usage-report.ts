#!/usr/bin/env bun
// Read-only report on how agents use the native todo, mined from omp session transcripts
// (`~/.omp/agent/sessions/**/*.jsonl`). No model calls, no network.
//
//   bun scripts/usage-report.ts [--sessions <dir>] [--since YYYY-MM-DD] [--json <file>]
//
// Privacy: the output holds counts, session file names, repo names and tool names. Message text, tool
// arguments, command lines and file contents are read only to classify a call and are never kept in the report.
import * as fs from "node:fs";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { resolveRepoName } from "../extensions/lib/repo";
import { expandHome, HOME } from "../extensions/lib/state";

// ── Parsing ──────────────────────────────────────────────────────────────────────────────────────

/** A tool call reduced to what the metrics need. A `write` to `xd://<tool>` is a call of that tool. */
export type ToolCall = {
	name: string;
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

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function normalise(name: string, rawArgs: unknown, at: number): ToolCall {
	const target = isRecord(rawArgs) && typeof rawArgs.path === "string" ? rawArgs.path : undefined;
	if (name === "write" && target?.startsWith("xd://")) return { name: target.slice("xd://".length).split(/[/?#]/)[0] ?? "", at };
	return { name, at };
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
			for (const c of turn) calls.push(normalise(c.name as string, c.arguments, at));
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

// ── Metrics ──────────────────────────────────────────────────────────────────────────────────────

export type SessionRow = {
	file: string;
	repo: string | undefined;
	nested: boolean;
	calls: number;
	m5: { endsOpen: boolean | undefined; lag: number | undefined; todoOnlyTurns: number } | undefined;
};

export type GroupReport = {
	sessions: number;
	m5: { sessions: number; endedClean: number; endedOpen: number; noResult: number; lagMean: number; lagMedian: number; lagMax: number; todoOnlyTurns: number };
	m6: { todo: { calls: number; sessions: number } };
};

export type Report = {
	main: GroupReport;
	subagents: GroupReport;
	rows: SessionRow[];
};

function rowFor(s: Session): SessionRow {
	const row: SessionRow = { file: s.file, repo: s.repo, nested: s.nested, calls: s.calls.length, m5: undefined };

	// M5: todo hygiene.
	if (s.calls.some(c => c.name === "todo")) {
		const updates = s.todoSnapshots.filter(t => t.op !== "view");
		const final = s.todoSnapshots.at(-1);
		const lastUpdate = updates.at(-1);
		row.m5 = {
			endsOpen: final ? final.open > 0 : undefined,
			lag: lastUpdate ? s.calls.slice(lastUpdate.callIndex).filter(c => c.name === "edit" || c.name === "write" || c.name === "bash").length : undefined,
			todoOnlyTurns: s.todoOnlyTurns,
		};
	}
	return row;
}

function group(sessions: Session[], rows: SessionRow[]): GroupReport {
	const g: GroupReport = {
		sessions: sessions.length,
		m5: { sessions: 0, endedClean: 0, endedOpen: 0, noResult: 0, lagMean: 0, lagMedian: 0, lagMax: 0, todoOnlyTurns: 0 },
		m6: { todo: { calls: 0, sessions: 0 } },
	};
	const lags: number[] = [];
	sessions.forEach((s, i) => {
		const row = rows[i];
		if (row.m5) {
			g.m5.sessions++;
			g.m5.todoOnlyTurns += row.m5.todoOnlyTurns;
			if (row.m5.endsOpen === undefined) g.m5.noResult++;
			else if (row.m5.endsOpen) g.m5.endedOpen++;
			else g.m5.endedClean++;
			if (row.m5.lag !== undefined) lags.push(row.m5.lag);
		}
		const todoCalls = s.calls.filter(c => c.name === "todo").length;
		if (todoCalls) {
			g.m6.todo.calls += todoCalls;
			g.m6.todo.sessions++;
		}
	});
	if (lags.length) {
		lags.sort((a, b) => a - b);
		g.m5.lagMean = Math.round((lags.reduce((a, b) => a + b, 0) / lags.length) * 10) / 10;
		g.m5.lagMedian = lags[Math.floor(lags.length / 2)];
		g.m5.lagMax = lags[lags.length - 1];
	}
	return g;
}

export function metrics(sessions: Session[]): Report {
	const rows = sessions.map(rowFor);
	const pick = (nested: boolean) => {
		const idx = sessions.map((s, i) => (s.nested === nested ? i : -1)).filter(i => i >= 0);
		return group(idx.map(i => sessions[i]), idx.map(i => rows[i]));
	};
	return { main: pick(false), subagents: pick(true), rows };
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

const table = (head: string[], rows: (string | number)[][]): string =>
	[`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...rows.map(r => `| ${r.join(" | ")} |`)].join("\n");

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
	out.push("## M5 Todo hygiene", table(
		["group", "sessions with todo", "ended clean", "ended with open items", "no result seen", "mean lag", "median lag", "max lag", "todo-only turns"],
		both.map(([n, g]) => [n, g.m5.sessions, g.m5.endedClean, g.m5.endedOpen, g.m5.noResult, g.m5.lagMean, g.m5.lagMedian, g.m5.lagMax, g.m5.todoOnlyTurns]),
	), "Lag = edit/write/bash calls after the last todo update when the session ends.");
	out.push("## M6 Todo calls", table(
		["group", "todo calls (sessions)"],
		both.map(([n, g]) => [n, `${g.m6.todo.calls} (${g.m6.todo.sessions})`]),
	));
	out.push(coverageLine(coverage));
	return out.join("\n\n");
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────────

type Options = { sessions: string; since?: number; json?: string };

export function parseArgs(argv: string[]): Options {
	const opts: Options = { sessions: path.join(HOME, ".omp", "agent", "sessions") };
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i];
		const value = argv[i + 1];
		if (!["--sessions", "--since", "--json"].includes(flag)) throw new Error(`Unknown argument "${flag}"`);
		if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value`);
		i++;
		if (flag === "--sessions") opts.sessions = path.resolve(expandHome(value));
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

export function main(argv: string[]): number {
	let opts: Options;
	try {
		opts = parseArgs(argv);
	} catch (error) {
		console.error(`${(error as Error).message}\nUsage: bun scripts/usage-report.ts [--sessions <dir>] [--since YYYY-MM-DD] [--json <file>]`);
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
	const report = metrics(sessions);
	console.log(render(report, coverage));
	if (opts.json) {
		fs.mkdirSync(path.dirname(opts.json), { recursive: true });
		fs.writeFileSync(opts.json, `${JSON.stringify({ coverage, ...report }, null, 2)}\n`);
	}
	return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
