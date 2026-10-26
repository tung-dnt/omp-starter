// Reads the `_memory/` folder of the knowledge base serving a directory. Shared by the injected
// memory index (kb-memory), the kb_recall tool (kb-memory-tools) and the /kb command, so all three
// see the same knowledge base, sections and search results.
import * as fs from "node:fs";
import * as path from "node:path";
import { classifyMemoryFile } from "./kb-report";
import { doneSources, resolveKb, servesEverySession, sourceFolder } from "./kb-sources";
import { parseMemoryIndex, renderMemoryBlock, selectSections } from "./memory-index";
import { excerpt, findEntry, frontmatterDescription, queryTerms, scoreNote, sectionSlugs, splitNote } from "./memory-notes";
import { resolveRepoName } from "./repo";
import { expandHome, readState, tildify, type KbSource } from "./state";

export interface MemorySnapshot {
	kbRef: string;
	block: string | undefined;
}

// Imports are evaluated separately per extension; snapshots must still be shared with /kb.
const SNAPSHOTS = Symbol.for("omp-starter.memory-index-snapshots");
const shared = globalThis as typeof globalThis & { [SNAPSHOTS]?: Map<string, Map<string, MemorySnapshot>> };
export const memorySnapshots = (shared[SNAPSHOTS] ??= new Map<string, Map<string, MemorySnapshot>>());

/** The source serving `cwd` and its `_memory` folder; throws with the configured folders when none does. */
export function memoryDir(cwd: string): { source: KbSource; dir: string } {
	const kb = readState().kb;
	const source = resolveKb(cwd, kb);
	if (!source) {
		const served = doneSources(kb).map(s => (servesEverySession(s) ? "every session" : tildify(sourceFolder(s))));
		throw new Error(
			`No knowledge base serves ${tildify(cwd)}` +
				(served.length ? ` (configured for: ${served.join(", ")})` : "") +
				". Run /starter kb to add one for this folder.",
		);
	}
	return { source, dir: path.join(expandHome(source.kbRef), "_memory") };
}

/** The "Memory index" system-prompt block for `cwd`, or undefined when the index is unreadable or empty. */
export function memoryBlock(kbRef: string, cwd: string): string | undefined {
	const indexPath = path.join(expandHome(kbRef), "_memory", "MEMORY.md");
	let text: string;
	try {
		text = fs.readFileSync(indexPath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		return undefined;
	}
	const { loaded, other } = selectSections(parseMemoryIndex(text), resolveRepoName(cwd));
	return renderMemoryBlock(tildify(indexPath), loaded, other);
}

export interface MemoryDirListing {
	notes: string[];
	evicted: string[];
	copies: string[];
}

/** Note slugs, iCloud-evicted slugs and sync-duplicate file names in `dir`, each sorted. */
export function listMemoryDir(dir: string): MemoryDirListing {
	const out: MemoryDirListing = { notes: [], evicted: [], copies: [] };
	for (const name of fs.readdirSync(dir).sort()) {
		const file = classifyMemoryFile(name);
		if (file?.kind === "note") out.notes.push(file.slug);
		else if (file?.kind === "evicted") out.evicted.push(file.slug);
		else if (file?.kind === "copy") out.copies.push(name);
	}
	return out;
}

export interface RecallParams {
	query: string;
	scope?: string;
	limit?: number;
}

export function recall(p: RecallParams, dir: string, source: KbSource): string {
	const terms = queryTerms(p.query);
	if (!terms.length) throw new Error("query needs at least one word of two or more characters");
	const indexPath = path.join(dir, "MEMORY.md");
	const indexText = fs.existsSync(indexPath) ? fs.readFileSync(indexPath, "utf8") : "";
	const allowed = p.scope ? sectionSlugs(indexText, p.scope) : undefined;
	const { notes, evicted } = listMemoryDir(dir);
	const hits: { slug: string; description: string; body: string; matched: number; score: number }[] = [];
	for (const slug of notes) {
		if (allowed && !allowed.has(slug)) continue;
		const { frontmatter, body } = splitNote(fs.readFileSync(path.join(dir, `${slug}.md`), "utf8"));
		const description = frontmatterDescription(frontmatter);
		const { matched, score } = scoreNote(terms, { slug, description, body });
		if (matched) hits.push({ slug, description, body, matched, score });
	}
	hits.sort((a, b) => b.matched - a.matched || b.score - a.score || a.slug.localeCompare(b.slug));
	const limit = Math.min(Math.max(Math.trunc(p.limit ?? 8), 1), 20);
	const lines = hits.slice(0, limit).map(h => {
		const section = findEntry(indexText, h.slug)?.section ?? "not indexed";
		const quote = excerpt(h.body, terms);
		return `- ${tildify(path.join(dir, `${h.slug}.md`))} [${section}] (${h.matched}/${terms.length} terms) — ${h.description}${quote ? `\n  > ${quote}` : ""}`;
	});
	const full = hits.filter(h => h.matched === terms.length).length;
	const header =
		`In ${source.kbRef}/_memory, ${full} note(s) match every word of "${p.query}" and ${hits.length - full} match some` +
		(p.scope ? ` (within "## ${p.scope}")` : "") +
		(hits.length > limit ? `; showing the best ${limit}` : "") +
		(evicted.length ? `; ${evicted.length} note(s) evicted to iCloud were not searched` : "") +
		".";
	return lines.length ? `${header} Read a note before relying on it.\n${lines.join("\n")}` : header;
}
