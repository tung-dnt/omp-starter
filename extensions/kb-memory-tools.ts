// Model-callable memory tools over the knowledge base serving the session's folder:
// kb_remember writes a memory note plus its `_memory/MEMORY.md` index line; kb_recall searches the notes.
// The knowledge base comes from `kb.sources` in ~/.omp/agent/omp-starter.json (see lib/kb-sources).
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { doneSources, forms } from "./lib/kb-sources";
import { memoryDir, recall, type RecallParams } from "./lib/kb-store";
import { markKbWritten } from "./lib/kb-write-flag";
import {
	findEntry,
	frontmatterDescription,
	indexLine,
	MEMORY_TYPES,
	type MemoryType,
	renderNote,
	SLUG,
	splitNote,
	updateNote,
	upsertIndex,
} from "./lib/memory-notes";
import { resolveRepoName } from "./lib/repo";
import { readState, tildify, type KbSource } from "./lib/state";

const LOCK_WAIT_MS = 5_000;
const STALE_LOCK_MS = 30_000;

/** Writes through a temp file in the same folder and renames it, so readers never see half a file. */
function atomicWrite(file: string, content: string): void {
	const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
	try {
		fs.writeFileSync(temporary, content, { flag: "wx" });
		fs.renameSync(temporary, file);
	} catch (error) {
		fs.rmSync(temporary, { force: true });
		throw error;
	}
}

/**
 * Serializes index edits across sessions on this machine. The lock lives in the temp dir, not the
 * vault, so it never syncs; a lock older than STALE_LOCK_MS is from a crashed writer and is taken over.
 */
async function withIndexLock<T>(indexPath: string, fn: () => T): Promise<T> {
	const key = crypto.createHash("sha1").update(forms(indexPath).at(-1)!).digest("hex").slice(0, 16);
	const lock = path.join(os.tmpdir(), `omp-starter-kb-${key}.lock`);
	const deadline = Date.now() + LOCK_WAIT_MS;
	for (;;) {
		try {
			fs.writeFileSync(lock, String(process.pid), { flag: "wx" });
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const mtime = fs.statSync(lock, { throwIfNoEntry: false })?.mtimeMs;
			if (mtime === undefined || Date.now() - mtime > STALE_LOCK_MS) {
				fs.rmSync(lock, { force: true });
				continue;
			}
			if (Date.now() > deadline) throw new Error(`${tildify(indexPath)} is being edited by another session; retry shortly`);
			await Bun.sleep(50);
		}
	}
	try {
		return fn();
	} finally {
		fs.rmSync(lock, { force: true });
	}
}

function oneLine(name: string, value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	const trimmed = value.trim();
	if (!trimmed) throw new Error(`${name} must not be empty`);
	if (/[\r\n]/.test(trimmed)) throw new Error(`${name} must be a single line`);
	return trimmed;
}

interface RememberParams {
	mode: "create" | "update";
	slug: string;
	title?: string;
	description?: string;
	hook?: string;
	type?: MemoryType;
	body?: string;
	scope?: string;
}

function remember(p: RememberParams, cwd: string, dir: string, source: KbSource): string {
	if (!SLUG.test(p.slug)) throw new Error(`slug "${p.slug}" must be lowercase letters, digits, "-" or "_" (no .md)`);
	const title = oneLine("title", p.title);
	if (title?.includes("]")) throw new Error('title must not contain "]"');
	const description = oneLine("description", p.description);
	const hook = oneLine("hook", p.hook);
	const scope = oneLine("scope", p.scope);
	const body = p.body?.trim();
	if (p.body !== undefined && !body) throw new Error("body must not be empty");

	const notePath = path.join(dir, `${p.slug}.md`);
	const indexPath = path.join(dir, "MEMORY.md");
	const modified = new Date().toISOString();
	const exists = fs.existsSync(notePath);
	if (!exists && fs.existsSync(path.join(dir, `.${p.slug}.md.icloud`))) {
		throw new Error(`${tildify(notePath)} is evicted to iCloud; download it first (macOS: brctl download "${notePath}")`);
	}

	let noteDescription = description;
	if (p.mode === "create") {
		if (exists) throw new Error(`${tildify(notePath)} already exists; read it, then call kb_remember with mode "update"`);
		const missing = (["title", "description", "type", "body"] as const).filter(k => !{ title, description, type: p.type, body }[k]);
		if (missing.length) throw new Error(`mode "create" needs ${missing.join(", ")}`);
		fs.mkdirSync(dir, { recursive: true });
		atomicWrite(notePath, renderNote({ slug: p.slug, description: description!, type: p.type!, modified, body: body! }));
	} else {
		if (!exists) throw new Error(`${tildify(notePath)} does not exist; use mode "create"`);
		if ([title, description, hook, p.type, body, scope].every(v => v === undefined)) {
			throw new Error('mode "update" needs at least one of title, description, hook, type, body, scope');
		}
		const text = fs.readFileSync(notePath, "utf8");
		atomicWrite(notePath, updateNote(text, p.slug, { description, type: p.type, modified, body }));
		noteDescription ??= frontmatterDescription(splitNote(text).frontmatter);
	}

	const indexText = fs.existsSync(indexPath) ? fs.readFileSync(indexPath, "utf8") : "## Global\n";
	const entry = findEntry(indexText, p.slug);
	let indexNote: string;
	if (entry && title === undefined && hook === undefined && scope === undefined) {
		indexNote = `index line unchanged under "## ${entry.section}"`;
	} else {
		const lineTitle = title ?? entry?.title;
		if (!lineTitle) throw new Error(`${p.slug} has no index line yet; pass title (the note was saved, the index was not)`);
		const lineHook = hook ?? entry?.hook ?? noteDescription ?? "";
		const result = upsertIndex(indexText, p.slug, indexLine(p.slug, lineTitle, lineHook), {
			scope,
			repo: resolveRepoName(cwd),
		});
		atomicWrite(indexPath, result.text);
		indexNote = `index line ${result.action} under "## ${result.section}"${result.createdSection ? " (new section)" : ""}`;
	}
	markKbWritten(source.kbRef);
	return (
		`${p.mode === "create" ? "Created" : "Updated"} ${tildify(notePath)}; ${indexNote} in ${tildify(indexPath)}. ` +
		"The injected memory index refreshes in the next session."
	);
}

export default function kbMemoryTools(pi: ExtensionAPI): void {
	// Registered only once a knowledge base exists; the factory runs again for every new session.
	if (!doneSources(readState().kb).length) return;
	const z = pi.zod;

	pi.registerTool({
		name: "kb_remember",
		label: "KB Remember",
		description:
			"Save a durable fact (decision, gotcha, convention, user preference, resolved failure) as a memory note in the " +
			"knowledge base serving this folder: writes `_memory/<slug>.md` (nested `metadata:` frontmatter) and its " +
			"`- [Title](<slug>.md) — <hook>` line in `_memory/MEMORY.md`. The line goes under `scope` when given, else the " +
			"section listing the current repo (a new `## <repo>` section if none), Global outside a repo. " +
			'mode "create" fails if the note exists; read it, then use mode "update", which replaces only the fields you pass ' +
			"(body replaces the whole body) and keeps other frontmatter keys. Counts as a knowledge-base write for the commit gate.",
		parameters: z.object({
			mode: z.enum(["create", "update"]).describe('"create" a new note or "update" an existing one'),
			slug: z.string().describe("Note file name without .md, kebab-case, e.g. `jira-comments-only-when-asked`"),
			title: z.string().optional().describe("Index link text, e.g. `Jira comments only when asked` (create: required)"),
			description: z.string().optional().describe("One-line frontmatter description (create: required)"),
			hook: z.string().optional().describe("Index line hook, ≤ ~60 chars; defaults to the description"),
			type: z.enum(MEMORY_TYPES).optional().describe("project | feedback | reference | user (create: required)"),
			body: z
				.string()
				.optional()
				.describe("Markdown body: `<fact>. **Why:** <reason>. **How to apply:** <rule>.` plus [[wikilinks]] (create: required)"),
			scope: z.string().optional().describe("Index section name, e.g. `Global` for cross-project facts; moves an existing line"),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const { source, dir } = memoryDir(ctx.cwd);
			const text = await withIndexLock(path.join(dir, "MEMORY.md"), () => remember(params as RememberParams, ctx.cwd, dir, source));
			return { content: [{ type: "text", text }], details: { kbRef: source.kbRef } };
		},
	});

	pi.registerTool({
		name: "kb_recall",
		label: "KB Recall",
		description:
			"Search the memory notes (`_memory/*.md`) of the knowledge base serving this folder by words in their name, " +
			"description and body. Returns note paths with their index section and a matching line; read a note before relying on it.",
		parameters: z.object({
			query: z.string().describe("Words to look for, e.g. `commit gate worktree`"),
			scope: z.string().optional().describe("Only notes indexed under this MEMORY.md section, e.g. `Global`"),
			limit: z.number().optional().describe("Results to return, 1–20 (default 8)"),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const { source, dir } = memoryDir(ctx.cwd);
			const text = recall(params as RecallParams, dir, source);
			return { content: [{ type: "text", text }], details: { kbRef: source.kbRef } };
		},
	});
}
