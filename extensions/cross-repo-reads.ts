// Reminds the main session to hand source mapping to scouts once it reads source code from a second repository.
// A session that reads and edits code in one repo never sees it; see rules/cross-repo-investigation.md.
import * as path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { repoRoot } from "./lib/repo";
import { bashDir, PRINTERS, resolveFrom, searchPaths, SELECTOR, simpleCommands } from "./lib/tool-input";

const SOURCE = /\.(?:tsx?|jsx?|mjs|cjs|go|sql|py|rs|java|kt|cs|php|rb|c|cc|cpp|h|hpp)$/;
/**
 * Paths that are never a repository's own source: system folders, dependencies, dot folders. `/tmp` is not listed:
 * scratch files outside a git repo are already dropped by `repoRoot`, and listing it made Linux (`/tmp`) and
 * macOS (`/private/tmp`) disagree about repos cloned there.
 */
const NOT_SOURCE = /^\/(?:dev|proc|usr|etc|opt\/homebrew)\/|\/node_modules\/|\/\.[^/]/;

/** Absolute paths of the source a `read` or `bash` call reads or searches. */
export function sourceReads(toolName: string, input: Record<string, unknown>, sessionCwd: string): string[] {
	if (toolName === "read") {
		const p = typeof input.path === "string" ? input.path : "";
		if (!p || p.includes("://")) return [];
		const file = resolveFrom(sessionCwd, p.replace(SELECTOR, ""));
		return SOURCE.test(file) ? [file] : [];
	}
	if (toolName !== "bash" || typeof input.command !== "string") return [];
	const dir = bashDir(input.command, input.cwd, sessionCwd);
	const out: string[] = [];
	for (const { words, piped } of simpleCommands(input.command)) {
		if (piped) continue;
		const searched = searchPaths(words);
		if (searched) out.push(...(searched.length ? searched : ["."]).map(p => resolveFrom(dir, p)));
		else if (PRINTERS[words[0]]) out.push(...words.slice(1).filter(w => SOURCE.test(w)).map(w => resolveFrom(dir, w)));
	}
	return out;
}

export default function crossRepoReads(pi: ExtensionAPI): void {
	const repos = new Set<string>();
	pi.on("session_start", () => repos.clear());

	pi.on("tool_result", (event, ctx) => {
		if (ctx.agent?.kind === "sub" || event.isError) return;
		const added: string[] = [];
		for (const file of sourceReads(event.toolName, (event.input ?? {}) as Record<string, unknown>, ctx.cwd)) {
			if (NOT_SOURCE.test(file)) continue;
			const root = repoRoot(file);
			if (root && !repos.has(root)) {
				repos.add(root);
				added.push(root);
			}
		}
		if (added.length === 0 || repos.size < 2) return;
		const names = [...repos].map(r => path.basename(r)).join(", ");
		return {
			additionalContext:
				`[cross-repo] This session has now read source from ${repos.size} repositories (${names}). ` +
				"If this is one investigation across them, stop mapping code here and follow rules/cross-repo-investigation: " +
				"fan out one `scout` per repo with a brief (question, repo path, revision, known facts); each writes " +
				"`local://<repo>-trace.md` with `path:start-end`, symbol, a short excerpt and an evidence label. Read the reports, " +
				"and open only the cited range of a claim you doubt. Carry on when this read is a scout's cited range or a file the user named.",
		};
	});
}
