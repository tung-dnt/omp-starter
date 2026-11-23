// Blocks agent `git commit` under a knowledge-base source's gate folder until this session saved a memory
// or wrote that source's KB: a successful `retain`, `learn` or `memory_edit` (the Hindsight bank serves every
// source), or a `write`/`edit` into the KB. `[skip-mem]` in the command bypasses it, and an unattended build
// (OMP_STARTER_UNATTENDED=1, see unattended.ts) is never gated: nobody could answer it.
// Configured by the setup wizard (`kb.sources[].gateDir` / `kbPaths` in ~/.omp/agent/omp-starter.json).
import * as path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { doneSources, inside, resolveKb, sourceOwning } from "./lib/kb-sources";
import { kbWritten, markKbWritten, resetKbWritten } from "./lib/kb-write-flag";
import { expandHome, readState } from "./lib/state";
import { GIT_COMMIT, gitCommandDir, resolveFrom, targetPaths, unquote } from "./lib/tool-input";

/**
 * The tools whose successful result counts as a knowledge-base write, and what each one writes to: the files it
 * names (counted only inside a knowledge base), or the Hindsight bank, which every knowledge base shares.
 */
const WRITE_TOOLS: Record<string, "files" | "bank"> = {
	write: "files",
	edit: "files",
	retain: "bank",
	learn: "bank",
	memory_edit: "bank",
};

export default function kbCommitGate(pi: ExtensionAPI): void {
	const reset = (ctx: { agent?: { kind: string } }) => {
		if (ctx.agent?.kind !== "sub") resetKbWritten();
	};
	pi.on("session_start", (_event, ctx) => reset(ctx));
	pi.on("session_switch", (_event, ctx) => reset(ctx));

	pi.on("tool_result", (event, ctx) => {
		const target = WRITE_TOOLS[event.toolName];
		if (event.isError || !target) return;
		const kb = readState().kb;
		if (target === "bank") {
			for (const source of doneSources(kb)) markKbWritten(source.kbRef);
			return;
		}
		for (const raw of targetPaths(event.toolName, (event.input ?? {}) as Record<string, unknown>)) {
			const p = unquote(raw.trim());
			// `vault://` addresses the Obsidian vault, taken as the one serving this session's folder.
			const source = p.startsWith("vault://") ? resolveKb(ctx.cwd, kb) : sourceOwning(resolveFrom(ctx.cwd, p), kb);
			if (source) markKbWritten(source.kbRef);
		}
	});

	pi.on("tool_call", (event, ctx) => {
		if (event.toolName !== "bash" || process.env.OMP_STARTER_UNATTENDED === "1") return;
		const command = String(event.input.command ?? "");
		const match = GIT_COMMIT.exec(command);
		if (!match || command.includes("[skip-mem]")) return;
		const dir = gitCommandDir(command, match, event.input.cwd, ctx.cwd);
		// The deepest gate folder holding the commit decides which KB must have been written.
		const source = doneSources(readState().kb)
			.filter(s => s.gateDir && inside(dir, path.resolve(expandHome(s.gateDir))))
			.sort((a, b) => b.gateDir!.length - a.gateDir!.length)[0];
		if (!source || kbWritten(source.kbRef)) return;
		return {
			block: true,
			reason:
				"memory-before-code: commit blocked. Save the relevant facts first: retain or learn a memory, " +
				`or write a note under ${source.kbRef}/ (e.g. projects/) with the write/edit tools. ` +
				"Add [skip-mem] to the commit message if the commit carries no new facts.",
		};
	});
}
