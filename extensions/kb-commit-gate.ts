// Blocks agent `git commit` under a knowledge-base source's gate folder until that source's KB was
// written in this session via write/edit. `[skip-mem]` in the command bypasses it, and
// an unattended build (OMP_STARTER_UNATTENDED=1, see unattended.ts) is never gated: nobody could answer it.
// Configured by the setup wizard (`kb.sources[].gateDir` / `kbPaths` in ~/.omp/agent/omp-starter.json).
import * as path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { doneSources, inside, resolveKb, sourceOwning } from "./lib/kb-sources";
import { kbWritten, markKbWritten, resetKbWritten } from "./lib/kb-write-flag";
import { expandHome, readState } from "./lib/state";
import { GIT_COMMIT, gitCommandDir, resolveFrom, targetPaths, unquote } from "./lib/tool-input";

const WRITE_TOOLS: Record<string, true> = { write: true, edit: true };

export default function kbCommitGate(pi: ExtensionAPI): void {
	const reset = (ctx: { agent?: { kind: string } }) => {
		if (ctx.agent?.kind !== "sub") resetKbWritten();
	};
	pi.on("session_start", (_event, ctx) => reset(ctx));
	pi.on("session_switch", (_event, ctx) => reset(ctx));

	pi.on("tool_result", (event, ctx) => {
		if (event.isError || !WRITE_TOOLS[event.toolName]) return;
		const kb = readState().kb;
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
				`memory-before-code: commit blocked. Write the relevant facts under ${source.kbRef}/ ` +
				"(e.g. projects/) with the write/edit tools first, " +
				"or add [skip-mem] to the commit message if the commit carries no new facts.",
		};
	});
}
