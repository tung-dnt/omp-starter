// Blocks agent `git commit` under the configured directory until a knowledge-base file was
// written via write/edit in this session. `[skip-mem]` in the command bypasses it.
// Configured by the setup wizard (`kb.gateDir` / `kb.kbPaths` in ~/.omp/agent/omp-starter.json).
import * as path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { readState, tildify } from "./lib/state";

// `git [global opts] commit`, not commit-tree or "commit" as an argument of another subcommand.
const GIT_COMMIT = /\bgit(?:\s+(?:-[Cc]\s+\S+|--?[\w-]+(?:=\S+)?))*\s+commit(?=[\s;&|)]|$)/;
const WRITE_TOOLS: Record<string, true> = { write: true, edit: true, ast_edit: true };

// Module-level: shared by the main session and its subagents, so a subagent's KB write
// satisfies the gate for the parent's commit.
let kbWritten = false;

export default function kbCommitGate(pi: ExtensionAPI): void {
	const reset = (ctx: { agent?: { kind: string } }) => {
		if (ctx.agent?.kind !== "sub") kbWritten = false;
	};
	pi.on("session_start", (_event, ctx) => reset(ctx));
	pi.on("session_switch", (_event, ctx) => reset(ctx));

	pi.on("tool_result", event => {
		if (kbWritten || event.isError || !WRITE_TOOLS[event.toolName]) return;
		const kb = readState().kb;
		if (!kb?.kbPaths) return;
		const input = JSON.stringify(event.input ?? {});
		kbWritten = kb.kbPaths.some(p => input.includes(p) || input.includes(tildify(p)));
	});

	pi.on("tool_call", (event, ctx) => {
		if (event.toolName !== "bash" || kbWritten) return;
		const command = String(event.input.command ?? "");
		if (!GIT_COMMIT.test(command) || command.includes("[skip-mem]")) return;
		const kb = readState().kb;
		if (!kb?.gateDir || !kb.kbRef) return;
		const dir = path.resolve(ctx.cwd, String(event.input.cwd ?? "."));
		if (!(dir + path.sep).startsWith(kb.gateDir + path.sep)) return;
		return {
			block: true,
			reason:
				`memory-before-code: commit blocked. Write/edit the relevant facts under ${kb.kbRef}/ ` +
				"(e.g. _memory/ or projects/) with the write/edit tools first, " +
				"or add [skip-mem] to the commit message if the commit carries no new facts.",
		};
	});
}
