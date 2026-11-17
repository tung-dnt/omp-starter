// Parsing of tool-call inputs shared by extensions: bash commands, and the files and folders a call touches.
import * as path from "node:path";
import { expandHome } from "./state";

export interface SimpleCommand {
	words: string[];
	piped: boolean;
}

/** Splits a shell command into simple commands on unquoted `;`, `&&`, `||`, `|`, `&` and newlines, honouring quotes. */
export function simpleCommands(command: string): SimpleCommand[] {
	const out: SimpleCommand[] = [];
	let words: string[] = [];
	let word = "";
	let quote: string | null = null;
	let piped = false;
	const push = () => {
		if (word !== "") words.push(word);
		word = "";
	};
	const end = (nextPiped: boolean) => {
		push();
		if (words.length) out.push({ words, piped });
		words = [];
		piped = nextPiped;
	};
	for (let i = 0; i < command.length; i++) {
		const c = command[i];
		if (quote) {
			if (c === quote) quote = null;
			else if (c === "\\" && quote === '"' && i + 1 < command.length) word += command[++i];
			else word += c;
		} else if (c === '"' || c === "'") quote = c;
		else if (c === "\\" && i + 1 < command.length) word += command[++i];
		else if (c === " " || c === "\t") push();
		else if (c === "\n" || c === ";") end(false);
		else if ((c === "&" || c === "|") && command[i + 1] === c) {
			i++;
			end(false);
		} else if (c === "|") end(true);
		else if (c === "&") end(false);
		else word += c;
	}
	end(false);
	return out;
}

const VALUE_OPTIONS: Record<string, true> = Object.fromEntries(
	["-g", "--glob", "-t", "--type", "-T", "--type-not", "-A", "-B", "-C", "-m", "--max-count", "--include", "--exclude", "--exclude-dir"].map(o => [o, true]),
);

/** The paths an `rg`/`grep` simple command searches (empty: its current folder), or undefined when it is another command. */
export function searchPaths(words: string[]): string[] | undefined {
	let k = 0;
	while (k < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[k])) k++;
	if (words[k] !== "rg" && words[k] !== "grep") return undefined;
	const positional: string[] = [];
	let patternGiven = false;
	const args = words.slice(k + 1);
	for (let a = 0; a < args.length; a++) {
		const arg = args[a];
		if (arg === "-e" || arg === "--regexp") {
			patternGiven = true;
			a++;
		} else if (VALUE_OPTIONS[arg]) a++;
		else if (!arg.startsWith("-")) positional.push(arg);
	}
	return patternGiven ? positional : positional.slice(1);
}

const LEADING_CD = /^\s*cd\s+("[^"]*"|'[^']*'|\S+)\s*&&/;

export const unquote = (s: string): string => (/^(["']).*\1$/.test(s) ? s.slice(1, -1) : s);
export const resolveFrom = (base: string, p: string): string => path.resolve(base, expandHome(unquote(p.trim())));

/** Folder a bash command starts in: its `cwd` argument (relative to the session's folder), then a leading `cd <dir> &&`. */
export function bashDir(command: string, cwd: unknown, sessionCwd: string): string {
	let dir = resolveFrom(sessionCwd, typeof cwd === "string" && cwd ? cwd : ".");
	const cd = LEADING_CD.exec(command);
	if (cd) dir = resolveFrom(dir, cd[1]);
	return dir;
}

// Target paths named inside an `edit` payload: hashline `[PATH#TAG]` / `MV DEST`, apply_patch and sloppy headers.
const EDIT_TARGET =
	/^\[([^\]\n]+?)#[0-9A-Fa-f]{4}\]|^MV\s+("[^"]*"|'[^']*'|\S+)|^\*\*\* (?:Add|Update|Edit) File:\s*(.+?)(?:\s+all)?\s*$|^\*\*\* Move to:\s*(.+?)\s*$/gm;

/** Paths a write/edit tool call targets, as written (not yet resolved). */
export function targetPaths(toolName: string, input: Record<string, unknown>): string[] {
	const out: string[] = [];
	if (typeof input.path === "string") out.push(input.path);
	if (toolName === "edit" && typeof input.input === "string") {
		for (const m of input.input.matchAll(EDIT_TARGET)) out.push(m[1] ?? m[2] ?? m[3] ?? m[4]);
	}
	return out;
}
