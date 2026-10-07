// Parses the knowledge-base memory index (`_memory/MEMORY.md`) into scope sections and renders
// the subset that applies to the current repo. Pure functions; the extension does the I/O.
//
// Format: `## <Scope>` headings, each optionally followed by `<!-- repos: a, b -->` naming the repos
// it applies to (default: the heading itself). Lines before the first heading belong to `Global`,
// so an index without headings loads exactly as before.

export interface MemorySection {
	name: string;
	repos: string[];
	body: string;
	/** Number of index entries (`- [` lines) in the body. */
	lines: number;
}

export const MEMORY_BLOCK_HEADER = "# Memory index";

const HEADING = /^## (.+)$/;
const REPOS_COMMENT = /<!--\s*repos:([\s\S]*?)-->/;

const isGlobal = (name: string) => name.toLowerCase() === "global";

function toSection(name: string, raw: string[]): MemorySection {
	let text = raw.join("\n");
	let repos = [name.toLowerCase()];
	const match = REPOS_COMMENT.exec(text);
	if (match) {
		repos = match[1]
			.split(",")
			.map(s => s.trim().toLowerCase())
			.filter(Boolean);
		text = text.slice(0, match.index) + text.slice(match.index + match[0].length);
	}
	const body = text.trim();
	const lines = body ? body.split("\n").filter(l => l.startsWith("- [")).length : 0;
	return { name, repos, body, lines };
}

export function parseMemoryIndex(text: string): MemorySection[] {
	const groups: { name: string; raw: string[] }[] = [{ name: "Global", raw: [] }];
	for (const line of text.split(/\r?\n/)) {
		const heading = HEADING.exec(line);
		if (heading) groups.push({ name: heading[1].trim(), raw: [] });
		else groups[groups.length - 1].raw.push(line);
	}
	// Merge the implicit preamble with every explicit `## Global` into one section.
	const globalRaw = groups.filter(g => isGlobal(g.name)).flatMap(g => g.raw);
	const sections = [toSection("Global", globalRaw)];
	for (const g of groups) if (!isGlobal(g.name)) sections.push(toSection(g.name, g.raw));
	return sections;
}

export function selectSections(
	sections: MemorySection[],
	repo: string | undefined,
): { loaded: MemorySection[]; other: MemorySection[] } {
	const key = repo?.toLowerCase();
	const loaded: MemorySection[] = [];
	const other: MemorySection[] = [];
	for (const s of sections) {
		if (isGlobal(s.name) || (key !== undefined && s.repos.includes(key))) loaded.push(s);
		else if (s.lines > 0) other.push(s);
	}
	return { loaded, other };
}

export function renderMemoryBlock(
	indexRef: string,
	loaded: MemorySection[],
	other: MemorySection[],
): string | undefined {
	const withBody = loaded.filter(s => s.body);
	if (!withBody.length && !other.length) return undefined;
	let source = `Source: \`${indexRef}\`. Loaded scopes: ${loaded.map(s => s.name).join(", ")}.`;
	if (other.length) {
		source += ` Other scopes (read the file when relevant): ${other.map(s => `${s.name} (${s.lines})`).join(", ")}.`;
	}
	const blocks = withBody.map(s => `## ${s.name}\n${s.body}`);
	return [
		MEMORY_BLOCK_HEADER,
		source,
		"One line per note; read the note before relying on it, and verify against the current repo.",
		"",
		blocks.join("\n\n"),
	].join("\n");
}
