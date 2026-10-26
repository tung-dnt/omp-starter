// Pure text behind `/kb scopes`, `/kb view` and `/kb check`: classifies `_memory/` file names,
// finds index/note drift, and renders scope listings. The command does the I/O.
import { isGlobal, type MemorySection } from "./memory-index";
import { listEntries, splitNote } from "./memory-notes";

export type MemoryFile = { kind: "note"; slug: string } | { kind: "evicted"; slug: string } | { kind: "copy" };

/**
 * What a file in `_memory/` is: a note, a note iCloud evicted to a `.<slug>.md.icloud` placeholder,
 * or a sync duplicate such as "note 2.md" / "note (conflicted copy).md". The index, temp files,
 * other dotfiles and non-Markdown files are undefined.
 */
export function classifyMemoryFile(name: string): MemoryFile | undefined {
	if (name.startsWith(".") && name.endsWith(".md.icloud")) {
		const slug = name.slice(1, -".md.icloud".length);
		return slug && !/\s/.test(slug) ? { kind: "evicted", slug } : undefined;
	}
	if (!name.endsWith(".md") || name === "MEMORY.md" || name.startsWith(".")) return undefined;
	if (/\s/.test(name)) return { kind: "copy" };
	const slug = name.slice(0, -3);
	return slug ? { kind: "note", slug } : undefined;
}

export interface MemoryProblems {
	/** Index lines whose note file is missing (not evicted either). */
	dangling: { slug: string; section: string }[];
	/** Notes with no index line, so the memory index never mentions them. */
	unindexed: string[];
	/** Slugs indexed more than once. */
	duplicates: { slug: string; sections: string[] }[];
	/** Sync duplicates to merge or delete. */
	copies: string[];
	/** Notes whose frontmatter is missing or incomplete. */
	frontmatter: { slug: string; reason: string }[];
}

export function checkMemory(
	indexText: string,
	notes: { slug: string; text: string }[],
	evicted: string[],
	copies: string[],
): MemoryProblems {
	const present = new Set([...notes.map(n => n.slug), ...evicted]);
	const sectionsBySlug = new Map<string, string[]>();
	for (const e of listEntries(indexText)) sectionsBySlug.set(e.slug, [...(sectionsBySlug.get(e.slug) ?? []), e.section]);

	const frontmatter: MemoryProblems["frontmatter"] = [];
	for (const n of notes) {
		const { frontmatter: fm } = splitNote(n.text);
		if (!fm) {
			frontmatter.push({ slug: n.slug, reason: "no frontmatter" });
			continue;
		}
		let parsed: unknown;
		try {
			parsed = Bun.YAML.parse(fm.join("\n"));
		} catch {
			frontmatter.push({ slug: n.slug, reason: "invalid YAML frontmatter" });
			continue;
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			frontmatter.push({ slug: n.slug, reason: "frontmatter must be a mapping" });
			continue;
		}
		const fields = parsed as Record<string, unknown>;
		if (typeof fields.description !== "string" || !fields.description.trim()) {
			frontmatter.push({ slug: n.slug, reason: "no description" });
		}
		if (typeof fields.name !== "string" || !fields.name.trim()) {
			frontmatter.push({ slug: n.slug, reason: "no name" });
		} else if (fields.name !== n.slug) {
			frontmatter.push({ slug: n.slug, reason: `name is "${fields.name}"` });
		}
	}

	return {
		dangling: [...sectionsBySlug]
			.filter(([slug]) => !present.has(slug))
			.flatMap(([slug, sections]) => sections.map(section => ({ slug, section }))),
		unindexed: notes.map(n => n.slug).filter(slug => !sectionsBySlug.has(slug)),
		duplicates: [...sectionsBySlug].filter(([, s]) => s.length > 1).map(([slug, sections]) => ({ slug, sections })),
		copies: [...copies].sort(),
		frontmatter,
	};
}

export const problemCount = (p: MemoryProblems): number =>
	p.dangling.length + p.unindexed.length + p.duplicates.length + p.copies.length + p.frontmatter.length;

export function renderProblems(p: MemoryProblems, dirRef: string): string {
	const total = problemCount(p);
	if (!total) return `${dirRef}: index and notes agree; no problems found.`;
	const groups: [string, string[]][] = [
		["Index lines with no note (fix the link or remove the line)", p.dangling.map(d => `${d.slug}.md under "## ${d.section}"`)],
		["Notes missing from MEMORY.md (never shown in the memory index)", p.unindexed.map(s => `${s}.md`)],
		["Notes indexed more than once", p.duplicates.map(d => `${d.slug}.md under ${d.sections.map(s => `"## ${s}"`).join(", ")}`)],
		["Sync duplicates (merge into the original, then delete)", p.copies],
		["Frontmatter problems", p.frontmatter.map(f => `${f.slug}.md: ${f.reason}`)],
	];
	const body = groups
		.filter(([, items]) => items.length)
		.map(([title, items]) => `${title} (${items.length}):\n${items.map(i => `  - ${i}`).join("\n")}`);
	return [`${dirRef}: ${total} problem(s).`, ...body].join("\n\n");
}

/** One line per section: name, entry count, the repos it applies to, and whether this session loads it. */
export function renderScopes(sections: MemorySection[], loaded: Set<string>): string {
	return sections
		.map(s => {
			const repos = isGlobal(s.name) ? "every repo" : s.repos.length ? s.repos.join(", ") : "no repos";
			return `${loaded.has(s.name) ? "●" : "○"} ${s.name} — ${s.lines} note(s); ${repos}`;
		})
		.join("\n");
}
