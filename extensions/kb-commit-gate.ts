// Blocks agent `git commit` under a memory gate folder until this session saved something: a successful memory
// write (`retain`, `learn` or `memory_edit`, whichever the memory backend provides) or a `write`/`edit` into a
// configured knowledge base. `[skip-mem]` in the command bypasses it, and an unattended build
// (OMP_STARTER_UNATTENDED=1, see unattended.ts) is never gated: nobody could answer it.
// Configured by `/starter memory` (`memory.gateDirs` in ~/.omp/agent/omp-starter.json); knowledge bases come from
// `kb.sources[].kbPaths`.
import * as path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { doneSources, inside, sourceOwning } from "./lib/kb-sources";
import { kbWritten, markKbWritten, resetKbWritten } from "./lib/kb-write-flag";
import { MEMORY_WRITE_TOOLS, gateRequirement } from "./lib/memory";
import { expandHome, readState } from "./lib/state";
import { GIT_COMMIT, gitCommandDir, resolveFrom, targetPaths, unquote } from "./lib/tool-input";

const FILE_TOOLS: readonly string[] = ["write", "edit"];

export default function kbCommitGate(pi: ExtensionAPI): void {
	const reset = (ctx: { agent?: { kind: string } }) => {
		if (ctx.agent?.kind !== "sub") resetKbWritten();
	};
	pi.on("session_start", (_event, ctx) => reset(ctx));
	pi.on("session_switch", (_event, ctx) => reset(ctx));

	pi.on("tool_result", (event, ctx) => {
		if (event.isError) return;
		if (MEMORY_WRITE_TOOLS.includes(event.toolName)) {
			markKbWritten();
			return;
		}
		if (!FILE_TOOLS.includes(event.toolName)) return;
		const kb = readState().kb;
		for (const raw of targetPaths(event.toolName, (event.input ?? {}) as Record<string, unknown>)) {
			const p = unquote(raw.trim());
			// `vault://` addresses the Obsidian vault of any configured knowledge base.
			if (p.startsWith("vault://") ? doneSources(kb).length : sourceOwning(resolveFrom(ctx.cwd, p), kb)) markKbWritten();
		}
	});

	pi.on("tool_call", (event, ctx) => {
		if (event.toolName !== "bash" || process.env.OMP_STARTER_UNATTENDED === "1" || kbWritten()) return;
		const command = String(event.input.command ?? "");
		const match = GIT_COMMIT.exec(command);
		if (!match || command.includes("[skip-mem]")) return;
		const { memory, kb } = readState();
		if (memory?.status !== "done") return;
		const dir = gitCommandDir(command, match, event.input.cwd, ctx.cwd);
		if (!(memory.gateDirs ?? []).some(gate => inside(dir, path.resolve(expandHome(gate))))) return;
		const requirement = gateRequirement(memory.backend, doneSources(kb).map(s => s.kbRef));
		// A backend with no write tool and no knowledge base leaves nothing that could satisfy the gate.
		if (!requirement) return;
		return {
			block: true,
			reason: `memory-before-code: commit blocked. Save the relevant facts first: ${requirement}. Add [skip-mem] to the commit message if the commit carries no new facts.`,
		};
	});
}
