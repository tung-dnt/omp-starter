// Blocks agent `git commit` under a knowledge-base source's gate folder until that source's KB was
// written in this session, via write/edit or kb_remember. `[skip-mem]` in the command bypasses it.
// Configured by the setup wizard (`kb.sources[].gateDir` / `kbPaths` in ~/.omp/agent/omp-starter.json).
import * as path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { doneSources, inside, resolveKb, sourceOwning } from "./lib/kb-sources";
import { kbWritten, markKbWritten, resetKbWritten } from "./lib/kb-write-flag";
import { expandHome, readState } from "./lib/state";

// `git [global opts] commit`, not commit-tree or "commit" as an argument of another subcommand.
const GIT_COMMIT = /\bgit(?:\s+(?:-[Cc]\s+\S+|--?[\w-]+(?:=\S+)?))*\s+commit(?=[\s;&|)]|$)/;
const LEADING_CD = /^\s*cd\s+("[^"]*"|'[^']*'|\S+)\s*&&/;
const GIT_DASH_C = /\s-C\s+("[^"]*"|'[^']*'|\S+)/g;
const WRITE_TOOLS: Record<string, true> = { write: true, edit: true };
// Target paths named inside an `edit` payload: hashline `[PATH#TAG]` / `MV DEST`, apply_patch and sloppy headers.
const EDIT_TARGET =
	/^\[([^\]\n]+?)#[0-9A-Fa-f]{4}\]|^MV\s+("[^"]*"|'[^']*'|\S+)|^\*\*\* (?:Add|Update|Edit) File:\s*(.+?)(?:\s+all)?\s*$|^\*\*\* Move to:\s*(.+?)\s*$/gm;

const unquote = (s: string) => (/^(["']).*\1$/.test(s) ? s.slice(1, -1) : s);
const resolveFrom = (base: string, p: string) => path.resolve(base, expandHome(unquote(p.trim())));

/** Paths a write/edit tool call targets, as written (not yet resolved). */
function targetPaths(toolName: string, input: Record<string, unknown>): string[] {
	const out: string[] = [];
	if (typeof input.path === "string") out.push(input.path);
	if (toolName === "edit" && typeof input.input === "string") {
		for (const m of input.input.matchAll(EDIT_TARGET)) out.push(m[1] ?? m[2] ?? m[3] ?? m[4]);
	}
	return out;
}

/** Directory a `git commit` command runs in: bash `cwd`, a leading `cd <p> &&`, then each `git -C <p>`. */
function commitDir(command: string, match: RegExpExecArray, input: Record<string, unknown>, sessionCwd: string): string {
	let dir = resolveFrom(sessionCwd, typeof input.cwd === "string" && input.cwd ? input.cwd : ".");
	const cd = LEADING_CD.exec(command);
	if (cd) dir = resolveFrom(dir, cd[1]);
	for (const c of match[0].matchAll(GIT_DASH_C)) dir = resolveFrom(dir, c[1]);
	return dir;
}

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
		if (event.toolName !== "bash") return;
		const command = String(event.input.command ?? "");
		const match = GIT_COMMIT.exec(command);
		if (!match || command.includes("[skip-mem]")) return;
		const dir = commitDir(command, match, event.input, ctx.cwd);
		// The deepest gate folder holding the commit decides which KB must have been written.
		const source = doneSources(readState().kb)
			.filter(s => s.gateDir && inside(dir, path.resolve(expandHome(s.gateDir))))
			.sort((a, b) => b.gateDir!.length - a.gateDir!.length)[0];
		if (!source || kbWritten(source.kbRef)) return;
		return {
			block: true,
			reason:
				`memory-before-code: commit blocked. Write the relevant facts under ${source.kbRef}/ ` +
				"(e.g. _memory/ or projects/) with kb_remember or the write/edit tools first, " +
				"or add [skip-mem] to the commit message if the commit carries no new facts.",
		};
	});
}
