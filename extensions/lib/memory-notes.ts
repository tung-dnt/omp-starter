// Pure text edits behind kb_remember / kb_recall: memory note frontmatter and the
// `_memory/MEMORY.md` index. Line-based so untouched lines (other keys, comments, spacing) survive.
import { isGlobal, sectionRepos } from "./memory-index";

export const MEMORY_TYPES = ["project", "feedback", "reference", "user"] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

/** Note file name without `.md`: lowercase words joined by `-` (`_` kept for older notes). */
export const SLUG = /^[a-z0-9][a-z0-9_-]*$/;

const HEADING = /^## (.+)$/;

// ── Notes ────────────────────────────────────────────────────────────────────

/** A plain scalar when YAML reads it back unchanged, else a double-quoted (JSON-compatible) string. */
export function yamlString(value: string): string {
	const plain =
		value !== "" &&
		value === value.trim() &&
		!/^[-?:,[\]{}#&*!|>'"%@`]/.test(value) &&
		!/: |:$| #|[\n\r\t]/.test(value) &&
		!/^(true|false|yes|no|on|off|null|~|[-+.\d][\d._:eE+-]*)$/i.test(value);
	return plain ? value : JSON.stringify(value);
}

export interface NoteFields {
	slug: string;
	description: string;
	type: MemoryType;
	modified: string;
	body: string;
}

export function renderNote(n: NoteFields): string {
	return [
		"---",
		`name: ${n.slug}`,
		`description: ${yamlString(n.description)}`,
		"metadata:",
		"  node_type: memory",
		`  type: ${n.type}`,
		`  modified: ${n.modified}`,
		"---",
		"",
		`${n.body.trim()}\n`,
	].join("\n");
}

/** Frontmatter lines (without the `---` fences) and the body, or no frontmatter. */
export function splitNote(text: string): { frontmatter?: string[]; body: string } {
	const lines = text.split("\n");
	if (lines[0]?.trimEnd() !== "---") return { body: text };
	const end = lines.findIndex((l, i) => i > 0 && l.trimEnd() === "---");
	if (end < 0) return { body: text };
	return { frontmatter: lines.slice(1, end), body: lines.slice(end + 1).join("\n") };
}

/** Top-level `key:` line in frontmatter, plus the indented lines that belong to it. */
function topKey(fm: string[], key: string): { at: number; end: number } | undefined {
	const at = fm.findIndex(l => l.startsWith(`${key}:`));
	if (at < 0) return undefined;
	let end = at + 1;
	while (end < fm.length && (/^\s+\S/.test(fm[end]) || fm[end].trim() === "")) end++;
	return { at, end };
}

/** Sets `key` inside the `metadata:` block when the note has one, else as a top-level key. */
function setMetaKey(fm: string[], key: string, value: string): void {
	const meta = topKey(fm, "metadata");
	if (meta) {
		const i = fm.slice(meta.at + 1, meta.end).findIndex(l => new RegExp(`^\\s+${key}:`).test(l));
		if (i >= 0) {
			const line = fm[meta.at + 1 + i];
			fm[meta.at + 1 + i] = `${line.slice(0, line.indexOf(key))}${key}: ${value}`;
		} else {
			fm.splice(meta.end, 0, `  ${key}: ${value}`);
		}
		return;
	}
	const flat = topKey(fm, key);
	if (flat) fm.splice(flat.at, flat.end - flat.at, `${key}: ${value}`);
	else fm.push(`${key}: ${value}`);
}

/**
 * Updates an existing note in place: replaces only the given fields and `modified`, keeps every
 * other frontmatter line (extra keys, nested or flat `type`/`modified`) as it was.
 */
export function updateNote(
	text: string,
	slug: string,
	patch: { description?: string; type?: MemoryType; modified: string; body?: string },
): string {
	const { frontmatter, body } = splitNote(text);
	if (!frontmatter) {
		throw new Error(`${slug}.md has no frontmatter; rewrite it with the write tool or mode "create" under a new slug`);
	}
	const fm = [...frontmatter];
	if (patch.description !== undefined) {
		const d = topKey(fm, "description");
		const line = `description: ${yamlString(patch.description)}`;
		if (d) fm.splice(d.at, d.end - d.at, line);
		else fm.splice(topKey(fm, "name") ? topKey(fm, "name")!.end : 0, 0, line);
	}
	if (patch.type !== undefined) setMetaKey(fm, "type", patch.type);
	setMetaKey(fm, "modified", patch.modified);
	const nextBody = patch.body !== undefined ? `\n${patch.body.trim()}\n` : body;
	return ["---", ...fm, "---", nextBody].join("\n");
}

// ── Index ────────────────────────────────────────────────────────────────────

export function indexLine(slug: string, title: string, hook: string): string {
	return `- [${title}](${slug}.md) — ${hook}`;
}

const ENTRY = /^- \[(.*)\]\(([^)]+)\.md\)(?:\s+—\s+(.*))?$/;

export interface IndexEntry {
	line: number;
	title: string;
	hook: string;
	section: string;
}

interface Group {
	name: string;
	/** Heading line, or -1 for the lines before the first heading (part of Global). */
	heading: number;
	start: number;
	end: number;
	repos: string[];
}

function scan(lines: string[]): Group[] {
	const groups: Group[] = [{ name: "Global", heading: -1, start: 0, end: lines.length, repos: [] }];
	lines.forEach((l, i) => {
		const m = HEADING.exec(l);
		if (!m) return;
		groups[groups.length - 1].end = i;
		groups.push({ name: m[1].trim(), heading: i, start: i + 1, end: lines.length, repos: [] });
	});
	for (const g of groups) g.repos = sectionRepos(g.name, lines.slice(g.start, g.end).join("\n")).repos;
	return groups;
}

export function findEntry(text: string, slug: string): IndexEntry | undefined {
	const lines = text.split("\n");
	for (const g of scan(lines)) {
		for (let i = g.start; i < g.end; i++) {
			const m = ENTRY.exec(lines[i]);
			if (m && m[2] === slug) return { line: i, title: m[1], hook: m[3] ?? "", section: g.name };
		}
	}
	return undefined;
}

/** Slugs listed under `section` (case-insensitive; `Global` includes the lines before the first heading). */
export function sectionSlugs(text: string, section: string): Set<string> {
	const lines = text.split("\n");
	const want = section.toLowerCase();
	const out = new Set<string>();
	for (const g of scan(lines)) {
		if (g.name.toLowerCase() !== want && !(isGlobal(want) && isGlobal(g.name))) continue;
		for (let i = g.start; i < g.end; i++) {
			const m = ENTRY.exec(lines[i]);
			if (m) out.add(m[2]);
		}
	}
	return out;
}

/** Section named `scope`, or for a repo the first non-Global section listing it. */
function pickGroup(groups: Group[], scope: string | undefined, repo: string | undefined): Group | undefined {
	if (scope !== undefined) {
		if (isGlobal(scope)) return groups.find(g => g.heading >= 0 && isGlobal(g.name)) ?? groups[0];
		return groups.find(g => g.name.toLowerCase() === scope.toLowerCase());
	}
	if (repo === undefined) return groups.find(g => g.heading >= 0 && isGlobal(g.name)) ?? groups[0];
	const key = repo.toLowerCase();
	return groups.find(g => !isGlobal(g.name) && g.repos.includes(key));
}

/** Insert position: after the section's last entry, else after its heading and `<!-- repos -->` comment. */
function insertAt(lines: string[], g: Group): number {
	for (let i = g.end - 1; i >= g.start; i--) if (lines[i].startsWith("- [")) return i + 1;
	let i = g.start;
	if (i < g.end && lines[i].trimStart().startsWith("<!--")) {
		while (i < g.end && !lines[i].includes("-->")) i++;
		i++;
	}
	return Math.min(i, g.end);
}

export interface UpsertResult {
	text: string;
	section: string;
	action: "added" | "updated" | "moved";
	createdSection: boolean;
}

/**
 * Adds or replaces the index line for `slug`.
 * - `scope` given: the line goes to that section (created at the end if missing), moving it if needed.
 * - no `scope`, line exists: replaced where it is.
 * - no `scope`, new line: the first section listing `repo`, else a new `## <repo>` section, else Global.
 */
export function upsertIndex(
	text: string,
	slug: string,
	line: string,
	target: { scope?: string; repo?: string },
): UpsertResult {
	let lines = text.split("\n");
	const existing = findEntry(text, slug);
	const scope = target.scope?.trim() || undefined;

	if (existing && scope === undefined) {
		lines[existing.line] = line;
		return { text: lines.join("\n"), section: existing.section, action: "updated", createdSection: false };
	}
	if (existing) {
		const sameSection =
			existing.section.toLowerCase() === scope!.toLowerCase() || (isGlobal(existing.section) && isGlobal(scope!));
		if (sameSection) {
			lines[existing.line] = line;
			return { text: lines.join("\n"), section: existing.section, action: "updated", createdSection: false };
		}
		lines = [...lines.slice(0, existing.line), ...lines.slice(existing.line + 1)];
	}

	const group = pickGroup(scan(lines), scope, target.repo);
	const action = existing ? "moved" : "added";
	if (group) {
		const at = insertAt(lines, group);
		lines.splice(at, 0, line);
		return { text: lines.join("\n"), section: group.heading < 0 ? "Global" : group.name, action, createdSection: false };
	}
	const name = scope ?? target.repo!;
	while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
	lines.push(...(lines.length ? [""] : []), `## ${name}`, line, "");
	return { text: lines.join("\n"), section: name, action, createdSection: true };
}

// ── Recall ───────────────────────────────────────────────────────────────────

export function queryTerms(query: string): string[] {
	return [...new Set(query.toLowerCase().split(/[^\p{L}\p{N}_.-]+/u).filter(t => t.length > 1))];
}

/** Distinct terms matched and a weighted score (name 3, description 2, body 1 per term). */
export function scoreNote(terms: string[], note: { slug: string; description: string; body: string }): {
	matched: number;
	score: number;
} {
	const name = note.slug.toLowerCase();
	const description = note.description.toLowerCase();
	const body = note.body.toLowerCase();
	let matched = 0;
	let score = 0;
	for (const t of terms) {
		const s = (name.includes(t) ? 3 : 0) + (description.includes(t) ? 2 : 0) + (body.includes(t) ? 1 : 0);
		if (s) matched++;
		score += s;
	}
	return { matched, score };
}

/** First body line containing a term, clipped around the match. */
export function excerpt(body: string, terms: string[], width = 220): string {
	for (const raw of body.split("\n")) {
		const line = raw.trim();
		const lower = line.toLowerCase();
		const at = terms.map(t => lower.indexOf(t)).filter(i => i >= 0).sort((a, b) => a - b)[0];
		if (at === undefined) continue;
		if (line.length <= width) return line;
		const start = Math.max(0, Math.min(at - Math.floor(width / 3), line.length - width));
		return `${start > 0 ? "…" : ""}${line.slice(start, start + width)}${start + width < line.length ? "…" : ""}`;
	}
	return "";
}

/** `description:` value from frontmatter lines (unquoted when it was a JSON-style string). */
export function frontmatterDescription(frontmatter: string[] | undefined): string {
	const line = frontmatter?.find(l => l.startsWith("description:"));
	if (!line) return "";
	const value = line.slice("description:".length).trim();
	if (value.startsWith('"')) {
		try {
			return JSON.parse(value) as string;
		} catch {
			return value;
		}
	}
	return value.replace(/^'(.*)'$/, "$1");
}
