// `/kb`: read-only view of the knowledge base serving the session's folder, the way `/memory` serves
// omp's built-in memory backends. Writes stay with the kb_remember tool (locking, commit gate).
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { checkMemory, problemCount, renderProblems, renderScopes } from "./lib/kb-report";
import { doneSources, servesEverySession, sourceFolder } from "./lib/kb-sources";
import { listMemoryDir, memoryBlock, memoryDir, memorySnapshots, recall, type MemorySnapshot } from "./lib/kb-store";
import { kbWritten } from "./lib/kb-write-flag";
import { parseMemoryIndex, selectSections } from "./lib/memory-index";
import { resolveRepoName } from "./lib/repo";
import { expandHome, readState, tildify, type KbSource } from "./lib/state";

const USAGE = "Usage: /kb [status] | /kb search <words> | /kb scopes | /kb view [scope] | /kb check";

const served = (s: KbSource): string => (servesEverySession(s) ? "every session" : tildify(sourceFolder(s)));

function readIndex(dir: string): string | undefined {
	try {
		return fs.readFileSync(path.join(dir, "MEMORY.md"), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		return undefined;
	}
}

function status(cwd: string, snapshot: MemorySnapshot | undefined): string {
	const all = doneSources(readState().kb);
	if (!all.length) return "No knowledge base is set up. Run /starter kb to add one.";
	const { source, dir } = memoryDir(cwd);
	const root = expandHome(source.kbRef);
	let real: string | undefined;
	try {
		real = fs.realpathSync(root);
	} catch {
		real = undefined;
	}
	const lines = [
		`Knowledge base ${source.kbRef} serves ${served(source)}${source.primary ? " (primary, used by agent-skills)" : ""}.`,
		real ? `  Vault: ${tildify(real)}` : `  Vault: ${root} is not reachable (missing, unmounted or evicted)`,
	];
	const index = readIndex(dir);
	if (real && fs.existsSync(dir)) {
		const { notes, evicted, copies } = listMemoryDir(dir);
		lines.push(
			`  Notes: ${notes.length} in ${tildify(dir)}` +
				(evicted.length ? `; ${evicted.length} evicted to iCloud` : "") +
				(copies.length ? `; ${copies.length} sync duplicate(s), see /kb check` : ""),
		);
	} else if (real) {
		lines.push(`  Notes: ${tildify(dir)} does not exist yet; kb_remember creates it`);
	}
	const repo = resolveRepoName(cwd);
	if (index === undefined) {
		lines.push(`  Index: ${tildify(path.join(dir, "MEMORY.md"))} is missing, so no memory index is injected`);
	} else {
		const { loaded, other } = selectSections(parseMemoryIndex(index), repo);
		lines.push(
			`  Repo: ${repo ?? "none (not in a git repo)"}`,
			`  Eligible scopes on disk: ${loaded.map(s => `${s.name} (${s.lines})`).join(", ")}`,
			`  Other scopes: ${other.length ? other.map(s => `${s.name} (${s.lines})`).join(", ") : "none"}`,
		);
	}
	lines.push(
		`  This session: ${snapshot?.block ? "memory snapshot prepared; /kb view shows it" : "no memory snapshot prepared yet"}`,
		source.gateDir
			? `  Commit gate (${tildify(source.gateDir)}): ${kbWritten(source.kbRef) ? "satisfied, KB written this session" : "blocks git commit until this session writes to the KB"}`
			: "  Commit gate: off",
	);
	const others = all.filter(s => s.contextFile !== source.contextFile);
	if (others.length) lines.push(`  Other knowledge bases: ${others.map(s => `${s.kbRef} → ${served(s)}`).join("; ")}`);
	return lines.join("\n");
}

function scopes(cwd: string): string {
	const { dir } = memoryDir(cwd);
	const index = readIndex(dir);
	if (index === undefined) return `${tildify(path.join(dir, "MEMORY.md"))} is missing.`;
	const repo = resolveRepoName(cwd);
	const sections = parseMemoryIndex(index);
	const loaded = new Set(selectSections(sections, repo).loaded.map(s => s.name));
	return `Scopes in ${tildify(path.join(dir, "MEMORY.md"))} (● loaded for ${repo ?? "this folder"}):\n${renderScopes(sections, loaded)}`;
}

function view(cwd: string, scope: string, snapshot: MemorySnapshot | undefined): string {
	const { source, dir } = memoryDir(cwd);
	if (!scope) {
		if (snapshot) return snapshot.block ?? "No memory index was available when this session prepared its prompt.";
		return "No session snapshot yet. Preview from disk:\n" + (memoryBlock(source.kbRef, cwd) ?? "(no memory index)");
	}
	const index = readIndex(dir);
	if (index === undefined) return `${tildify(path.join(dir, "MEMORY.md"))} is missing.`;
	const sections = parseMemoryIndex(index);
	const section = sections.find(s => s.name.toLowerCase() === scope.toLowerCase());
	if (!section) throw new Error(`No scope "${scope}". Scopes: ${sections.map(s => s.name).join(", ")}`);
	return `Current scope on disk:\n## ${section.name}\n${section.body || "(empty)"}`;
}

function check(cwd: string): { text: string; problems: number } {
	const { dir } = memoryDir(cwd);
	const index = readIndex(dir);
	if (index === undefined) return { text: `${tildify(path.join(dir, "MEMORY.md"))} is missing.`, problems: 1 };
	const { notes, evicted, copies } = listMemoryDir(dir);
	const problems = checkMemory(
		index,
		notes.map(slug => ({ slug, text: fs.readFileSync(path.join(dir, `${slug}.md`), "utf8") })),
		evicted,
		copies,
	);
	return { text: renderProblems(problems, tildify(dir)), problems: problemCount(problems) };
}

export default function kbCommand(pi: ExtensionAPI): void {
	pi.registerCommand("kb", {
		description: "Knowledge base memory: status | search <words> | scopes | view [scope] | check",
		handler: async (args, ctx) => {
			const [sub = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);
			const arg = rest.join(" ");
			const snapshot = memorySnapshots.get(ctx.sessionManager.getSessionId())?.get(ctx.cwd);
			try {
				switch (sub) {
					case "status":
						ctx.ui.notify(status(ctx.cwd, snapshot), "info");
						return;
					case "search": {
						if (!arg) throw new Error("Usage: /kb search <words>");
						const { source, dir } = memoryDir(ctx.cwd);
						ctx.ui.notify(recall({ query: arg }, dir, source), "info");
						return;
					}
					case "scopes":
						ctx.ui.notify(scopes(ctx.cwd), "info");
						return;
					case "view":
						ctx.ui.notify(view(ctx.cwd, arg, snapshot), "info");
						return;
					case "check": {
						const result = check(ctx.cwd);
						ctx.ui.notify(result.text, result.problems ? "warning" : "info");
						return;
					}
					default:
						ctx.ui.notify(`Unknown /kb subcommand "${sub}". ${USAGE}`, "warning");
				}
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}
