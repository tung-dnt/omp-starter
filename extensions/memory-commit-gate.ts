// Blocks agent `git commit` under a memory gate folder until this session saved a memory: a successful `retain`,
// `learn` or `memory_edit`, whichever the memory backend provides. `[skip-mem]` in the command bypasses it, and an
// unattended build (OMP_STARTER_UNATTENDED=1, see unattended.ts) is never gated: nobody could answer it.
// Configured by `/starter memory` (`memory.gateDirs` in ~/.omp/agent/omp-starter.json).
import * as path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { MEMORY_WRITE_TOOLS, gateRequirement, inside } from "./lib/memory";
import { markMemoryWritten, memoryWritten, resetMemoryWritten } from "./lib/memory-write-flag";
import { expandHome, readState } from "./lib/state";
import { GIT_COMMIT, gitCommandDir } from "./lib/tool-input";

export default function memoryCommitGate(pi: ExtensionAPI): void {
	const reset = (ctx: { agent?: { kind: string } }) => {
		if (ctx.agent?.kind !== "sub") resetMemoryWritten();
	};
	pi.on("session_start", (_event, ctx) => reset(ctx));
	pi.on("session_switch", (_event, ctx) => reset(ctx));

	pi.on("tool_result", event => {
		if (!event.isError && MEMORY_WRITE_TOOLS.includes(event.toolName)) markMemoryWritten();
	});

	pi.on("tool_call", (event, ctx) => {
		if (event.toolName !== "bash" || process.env.OMP_STARTER_UNATTENDED === "1" || memoryWritten()) return;
		const command = String(event.input.command ?? "");
		const match = GIT_COMMIT.exec(command);
		if (!match || command.includes("[skip-mem]")) return;
		const { memory } = readState();
		if (memory?.status !== "done") return;
		const dir = gitCommandDir(command, match, event.input.cwd, ctx.cwd);
		if (!(memory.gateDirs ?? []).some(gate => inside(dir, path.resolve(expandHome(gate))))) return;
		const requirement = gateRequirement(memory.backend);
		// A backend with no write tool leaves nothing that could satisfy the gate.
		if (!requirement) return;
		return {
			block: true,
			reason: `memory-before-code: commit blocked. Save the relevant facts first: ${requirement}. Add [skip-mem] to the commit message if the commit carries no new facts.`,
		};
	});
}
