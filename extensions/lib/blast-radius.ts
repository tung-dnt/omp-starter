// Finds the exported symbols an edit changed and formats where else they are used.
// Pure text logic: the extension (extensions/blast-radius.ts) feeds it file snapshots and language-server answers.

export type Lang = "ts" | "go";

/** At most this many changed and this many removed symbols are looked up per tool call. */
export const MAX_SYMBOLS = 3;
/** Locations listed per symbol; the rest are counted. */
export const MAX_SITES = 8;
/** Upper bound of the appended block. */
export const MAX_CHARS = 700;

export function langOf(file: string): Lang | undefined {
	if (/\.go$/.test(file)) return "go";
	if (/\.(?:[cm]?[jt]s|[jt]sx)$/.test(file)) return "ts";
	return undefined;
}

/** A top-level exported declaration; `line`/`character` (0-based, UTF-16) point at its name. */
export interface ExportDecl {
	name: string;
	header: string;
	line: number;
	character: number;
}

export interface ExportChange {
	kind: "changed" | "removed";
	name: string;
	/** Position of the name in the new text; set for "changed" only. */
	at?: { line: number; character: number };
}

/** A use site; `line` is 1-based and absent for a text match. */
export interface RefSite {
	file: string;
	line?: number;
}

export interface BlastItem {
	change: ExportChange;
	sites: RefSite[];
	source: "lsp" | "text";
}

/** How far a header runs: to the body, to the initialiser, or over the whole declaration. */
type Extent = "body" | "assign" | "whole";

const MAX_HEADER_LINES = 20;
const MAX_WHOLE_LINES = 300;

const OPEN: Record<string, true> = { "(": true, "[": true, "{": true };
const CLOSE: Record<string, true> = { ")": true, "]": true, "}": true };

/**
 * End offset of the declaration header starting at `from`. Skips strings and comments and tracks bracket
 * depth (angle brackets too for TypeScript, where `Promise<{ a: string }>` must not end the header).
 */
function headerEnd(text: string, from: number, extent: Extent, lang: Lang): number {
	let depth = 0;
	let lines = 0;
	let closedBody = false;
	const maxLines = extent === "whole" ? MAX_WHOLE_LINES : MAX_HEADER_LINES;
	for (let i = from; i < text.length; i++) {
		const ch = text[i]!;
		const next = text[i + 1];
		if (ch === "/" && next === "/") {
			const nl = text.indexOf("\n", i);
			if (nl < 0) return text.length;
			i = nl - 1;
			continue;
		}
		if (ch === "/" && next === "*") {
			const end = text.indexOf("*/", i + 2);
			if (end < 0) return text.length;
			i = end + 1;
			continue;
		}
		if (ch === '"' || ch === "'" || ch === "`") {
			i = stringEnd(text, i);
			continue;
		}
		if (ch === "\n") {
			if (++lines >= maxLines) return i;
			if (depth === 0 && (extent !== "body" || closedBody) && !continues(text, i + 1, lang)) return i;
			continue;
		}
		if (ch === "=" && next === ">") {
			i++;
			continue;
		}
		if (lang === "ts" && ch === "<") depth++;
		else if (lang === "ts" && ch === ">" && depth > 0) depth--;
		else if (OPEN[ch]) {
			if (ch === "{" && depth === 0 && extent === "body") return i;
			depth++;
		} else if (CLOSE[ch] && depth > 0) {
			depth--;
			if (depth === 0 && ch === "}") closedBody = true;
		} else if (depth === 0 && ch === ";") return i;
		else if (depth === 0 && extent === "assign" && ch === "=" && next !== "=") return i;
	}
	return text.length;
}

function stringEnd(text: string, start: number): number {
	const quote = text[start];
	for (let i = start + 1; i < text.length; i++) {
		if (text[i] === "\\") i++;
		else if (text[i] === quote) return i;
		else if (text[i] === "\n" && quote !== "`") return i;
	}
	return text.length;
}

/** Whether the line starting at `at` continues a TypeScript declaration (`| B`, `& C`, `extends D`). */
function continues(text: string, at: number, lang: Lang): boolean {
	if (lang !== "ts") return false;
	return /^[ \t]*(?:[|&.?:]|=>|extends\b|implements\b)/.test(text.slice(at, at + 40));
}

/** Initialisers whose parameters belong to the signature: arrow functions and function expressions. */
const FUNCTION_INIT: Record<Lang, RegExp> = {
	ts: /^\s*(?:async\s+)?(?:function\b|<|\(|[A-Za-z_$][\w$]*\s*=>)/,
	go: /^\s*func\b/,
};

/** Collapses whitespace and formatter noise so a reformat alone never counts as a change. */
export function normalise(header: string): string {
	return header
		.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, "")
		.replace(/\s+/g, " ")
		.replace(/\s*([(){}[\],;:<>=|&?])\s*/g, "$1")
		.replace(/[,;]([)}\]])/g, "$1")
		.trim();
}

function positionAt(text: string, offset: number): { line: number; character: number } {
	let line = 0;
	let lineStart = 0;
	for (let i = text.indexOf("\n"); i >= 0 && i < offset; i = text.indexOf("\n", i + 1)) {
		line++;
		lineStart = i + 1;
	}
	return { line, character: offset - lineStart };
}

function add(decls: Map<string, ExportDecl>, text: string, name: string, nameAt: number, header: string): void {
	const existing = decls.get(name);
	// Overloads and `export { a }` next to `export const a`: one entry, both headers.
	if (existing) existing.header = `${existing.header}|${normalise(header)}`;
	else decls.set(name, { name, header: normalise(header), ...positionAt(text, nameAt) });
}

/** Header of the declaration at `start`, whose name ends at `nameEnd`. */
function header(text: string, start: number, nameEnd: number, extent: Extent, lang: Lang): string {
	let end = headerEnd(text, nameEnd, extent, lang);
	if (extent === "assign" && text[end] === "=" && FUNCTION_INIT[lang].test(text.slice(end + 1, end + 200))) {
		end = headerEnd(text, end + 1, "body", lang);
		const arrow = text.slice(start, end).lastIndexOf("=>");
		if (arrow >= 0 && text[end] !== "{") end = start + arrow + 2;
	}
	return text.slice(start, end);
}

const TS_DECL =
	/^export[ \t]+(?:default[ \t]+)?(?:declare[ \t]+)?(?:async[ \t]+)?(?:abstract[ \t]+)?(function\*?|class|const[ \t]+enum|const|let|var|interface|type|enum|namespace)[ \t]+([A-Za-z_$][\w$]*)/gm;
const TS_LIST = /^export[ \t]+(?:type[ \t]+)?\{([^}]*)\}([ \t]*from[ \t]*["'][^"']+["'])?/gm;

function tsDecls(text: string): Map<string, ExportDecl> {
	const decls = new Map<string, ExportDecl>();
	for (const m of text.matchAll(TS_DECL)) {
		const kind = m[1]!;
		const name = m[2]!;
		const nameAt = m.index + m[0].length - name.length;
		const extent: Extent = /^(?:interface|type|enum|const[ \t]+enum)$/.test(kind)
			? "whole"
			: /^(?:const|let|var)$/.test(kind)
				? "assign"
				: "body";
		add(decls, text, name, nameAt, header(text, m.index, nameAt + name.length, extent, "ts"));
	}
	for (const m of text.matchAll(TS_LIST)) {
		const body = m[1]!;
		const from = m[2] ?? "";
		const bodyAt = m.index + m[0].indexOf("{") + 1;
		let offset = 0;
		for (const raw of body.split(",")) {
			const entry = raw.trim();
			const alias = /(?:^|\s)as\s+([A-Za-z_$][\w$]*)$/.exec(entry)?.[1];
			const name = alias ?? /([A-Za-z_$][\w$]*)$/.exec(entry)?.[1];
			if (name && name !== "default") {
				const nameAt = bodyAt + offset + raw.lastIndexOf(name);
				add(decls, text, name, nameAt, `${entry}${from}`);
			}
			offset += raw.length + 1;
		}
	}
	return decls;
}

const GO_FUNC = /^func[ \t]+(?:\([ \t]*(?:\w+[ \t]+)?\*?[ \t]*(\w+)(?:\[[^\]]*\])?[ \t]*\)[ \t]*)?([A-Z]\w*)/gm;
const GO_SINGLE = /^(type|var|const)[ \t]+([A-Z]\w*)/gm;
const GO_GROUP = /^(type|var|const)[ \t]*\(\n([\s\S]*?)^\)/gm;

function goDecls(text: string): Map<string, ExportDecl> {
	const decls = new Map<string, ExportDecl>();
	for (const m of text.matchAll(GO_FUNC)) {
		const receiver = m[1];
		const method = m[2]!;
		const nameAt = m.index + m[0].length - method.length;
		const name = receiver ? `${receiver}.${method}` : method;
		add(decls, text, name, nameAt, header(text, m.index, nameAt + method.length, "body", "go"));
	}
	for (const m of text.matchAll(GO_SINGLE)) {
		const name = m[2]!;
		const nameAt = m.index + m[0].length - name.length;
		const extent: Extent = m[1] === "type" ? "whole" : "assign";
		add(decls, text, name, nameAt, header(text, m.index, nameAt + name.length, extent, "go"));
	}
	for (const m of text.matchAll(GO_GROUP)) {
		const bodyAt = m.index + m[0].indexOf("\n") + 1;
		let offset = 0;
		for (const line of m[2]!.split("\n")) {
			const entry = /^[ \t]+([A-Z]\w*)\b/.exec(line);
			if (entry) add(decls, text, entry[1]!, bodyAt + offset + line.indexOf(entry[1]!), `${m[1]} ${line}`);
			offset += line.length + 1;
		}
	}
	return decls;
}

export function exportedDecls(text: string, lang: Lang): Map<string, ExportDecl> {
	return lang === "ts" ? tsDecls(text) : goDecls(text);
}

/**
 * Exports whose header differs between the two texts ("changed", in new-file order) and exports that are gone
 * ("removed", in old-file order). New exports and body-only edits are not changes: nothing calls the former yet
 * and the latter keep every caller working.
 */
export function changedExports(oldText: string, newText: string, lang: Lang): ExportChange[] {
	const before = exportedDecls(oldText, lang);
	const after = exportedDecls(newText, lang);
	const byLine = (a: ExportDecl, b: ExportDecl) => a.line - b.line || a.character - b.character;
	const changed = [...after.values()]
		.filter(decl => {
			const old = before.get(decl.name);
			return old !== undefined && old.header !== decl.header;
		})
		.sort(byLine)
		.map((decl): ExportChange => ({ kind: "changed", name: decl.name, at: { line: decl.line, character: decl.character } }));
	const removed = [...before.values()]
		.filter(decl => !after.has(decl.name))
		.sort(byLine)
		.map((decl): ExportChange => ({ kind: "removed", name: decl.name }));
	return [...changed, ...removed];
}

/** A language-server location, as `textDocument/references` returns it. */
export interface Location {
	uri: string;
	range: { start: { line: number } };
}

/**
 * Use sites outside the edited file, relative to `cwd`, one per file and line, sorted. `toPath` turns a
 * location URI into an absolute path (the host's `uriToFile`).
 */
export function referenceSites(locations: Location[], editedFile: string, cwd: string, toPath: (uri: string) => string): RefSite[] {
	const seen = new Set<string>();
	const sites: RefSite[] = [];
	for (const location of locations) {
		const file = toPath(location.uri);
		if (file === editedFile) continue;
		const site = { file: relative(file, cwd), line: location.range.start.line + 1 };
		const key = `${site.file}:${site.line}`;
		if (seen.has(key)) continue;
		seen.add(key);
		sites.push(site);
	}
	return sites.sort((a, b) => a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0));
}

export function relative(file: string, cwd: string): string {
	const root = cwd.endsWith("/") ? cwd : `${cwd}/`;
	return file.startsWith(root) ? file.slice(root.length) : file;
}

function itemLine(item: BlastItem): string | undefined {
	const { change, sites, source } = item;
	if (sites.length === 0) return undefined;
	const shown = sites.slice(0, MAX_SITES).map(site => (site.line === undefined ? site.file : `${site.file}:${site.line}`));
	const more = sites.length > MAX_SITES ? ` (+${sites.length - MAX_SITES})` : "";
	const files = new Set(sites.map(site => site.file)).size;
	const what = change.kind === "changed" ? "signature changed" : "removed";
	const count =
		source === "lsp"
			? `${sites.length} ref${sites.length === 1 ? "" : "s"} in ${files} file${files === 1 ? "" : "s"}`
			: `text matches in ${files} file${files === 1 ? "" : "s"}`;
	return `- ${change.name}: ${what}; ${count}: ${shown.join(", ")}${more}`;
}

const HEAD = "Blast radius (exported symbols changed by this edit; other files only):";
const FOOT = "Update or check these before finishing.";

/** The block appended to the tool result, or undefined when no changed symbol has a use elsewhere. */
export function formatBlastRadius(items: BlastItem[]): string | undefined {
	const lines: string[] = [];
	let size = HEAD.length + FOOT.length + 2;
	let dropped = 0;
	for (const item of items) {
		const line = itemLine(item);
		if (!line) continue;
		if (size + line.length + 1 > MAX_CHARS - 24) {
			dropped++;
			continue;
		}
		lines.push(line);
		size += line.length + 1;
	}
	if (lines.length === 0) return undefined;
	if (dropped > 0) lines.push(`- (+${dropped} more symbol${dropped === 1 ? "" : "s"})`);
	return [HEAD, ...lines, FOOT].join("\n");
}
