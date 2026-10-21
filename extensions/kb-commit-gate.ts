// Blocks agent `git commit` under the configured directory until a knowledge-base file was
// written via write/edit in this session. `[skip-mem]` in the command bypasses it.
// Configured by the setup wizard (`kb.gateDir` / `kb.kbPaths` in ~/.omp/agent/omp-starter.json).
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
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

/** Existing path as written plus its symlink-resolved form, so either spelling matches. */
function forms(p: string): string[] {
	try {
		const real = fs.realpathSync(p);
		return real === p ? [p] : [p, real];
	} catch {
		return [p];
	}
}

const within = (p: string, dir: string) => p === dir || p.startsWith(dir + path.sep);

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

// Module-level: shared by the main session and its subagents, so a subagent's KB write
// satisfies the gate for the parent's commit.
let kbWritten = false;

export default function kbCommitGate(pi: ExtensionAPI): void {
	const reset = (ctx: { agent?: { kind: string } }) => {
		if (ctx.agent?.kind !== "sub") kbWritten = false;
	};
	pi.on("session_start", (_event, ctx) => reset(ctx));
	pi.on("session_switch", (_event, ctx) => reset(ctx));

	pi.on("tool_result", (event, ctx) => {
		if (kbWritten || event.isError || !WRITE_TOOLS[event.toolName]) return;
		const kb = readState().kb;
		if (!kb?.kbPaths) return;
		const roots = kb.kbPaths.flatMap(p => forms(path.resolve(expandHome(p))));
		kbWritten = targetPaths(event.toolName, (event.input ?? {}) as Record<string, unknown>).some(raw => {
			const p = unquote(raw.trim());
			// `vault://` addresses the Obsidian vault, which holds the knowledge base.
			if (p.startsWith("vault://")) return true;
			const abs = resolveFrom(ctx.cwd, p);
			return forms(abs).some(a => roots.some(root => within(a, root)));
		});
	});

	pi.on("tool_call", (event, ctx) => {
		if (event.toolName !== "bash" || kbWritten) return;
		const command = String(event.input.command ?? "");
		const match = GIT_COMMIT.exec(command);
		if (!match || command.includes("[skip-mem]")) return;
		const kb = readState().kb;
		if (!kb?.gateDir || !kb.kbRef) return;
		const dir = commitDir(command, match, event.input, ctx.cwd);
		const gates = forms(path.resolve(expandHome(kb.gateDir)));
		if (!forms(dir).some(d => gates.some(g => within(d, g)))) return;
		return {
			block: true,
			reason:
				`memory-before-code: commit blocked. Write/edit the relevant facts under ${kb.kbRef}/ ` +
				"(e.g. _memory/ or projects/) with the write/edit tools first, " +
				"or add [skip-mem] to the commit message if the commit carries no new facts.",
		};
	});
}
