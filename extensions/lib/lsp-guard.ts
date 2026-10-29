// Decides whether a subagent's bash call is an rg/grep symbol lookup that should go to the language server.
// Code drops what it can rule out exactly (piped greps, searches of /tmp, docs, SQL, logs, git history);
// Jev judges the rest with the question of rules/lsp-symbol-judged.md, so the reminder and the block agree.

/** Agents with a language server tool: task-builder has `lsp`, the others the `xd://lsp` device. */
export const LSP_AGENTS: Record<string, true> = { "task-builder": true, task: true, "code-reviewer": true, "test-engineer": true };
/** Appended to a command, lets it run: the language has no server, or the search really is for text. */
export const BYPASS = "# text-search";
/** Block only when Jev is this sure; between 0.7 and this the judged rule only reminds. Measured on 94 labelled real greps: 27/36 symbol lookups, 3/58 others. */
export const BLOCK_AT = 0.85;

interface SimpleCommand {
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

/** Paths no language server covers: scratch files, artifacts, dependencies, docs, SQL, data and logs. */
function offTree(p: string): boolean {
	return (
		/^(\/tmp\/|\/dev\/|artifacts?:\/\/|proc:\/\/)/.test(p) ||
		/node_modules|(^|\/)docs?(\/|$)|(^|\/)migrations(\/|$)|\.(sql|md|log|txt|json|ya?ml|env|lock|csv)$/.test(p) ||
		/\$[A-Za-z{]/.test(p)
	);
}

/** The unpiped rg/grep commands that search at least one path a language server could cover. */
export function onTreeSearches(command: string): string[] {
	const found: string[] = [];
	for (const { words, piped } of simpleCommands(command)) {
		if (piped) continue;
		let k = 0;
		while (k < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[k])) k++;
		if (words[k] !== "rg" && words[k] !== "grep") continue;
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
		const paths = patternGiven ? positional : positional.slice(1);
		if (paths.length > 0 && paths.every(offTree)) continue;
		found.push(words.join(" "));
	}
	return found;
}

/** Probability that `command` looks up a code symbol, or undefined when the judge could not answer. */
export type Judge = (command: string) => Promise<number | undefined>;

export interface Verdict {
	block: boolean;
	p?: number;
}

/** Whether `agent`'s bash `command` is blocked. Anything uncertain (no judge answer, bypass, other agents) runs. */
export async function decide(command: string, agent: string | undefined, judge: Judge): Promise<Verdict> {
	if (!agent || !LSP_AGENTS[agent] || command.includes(BYPASS)) return { block: false };
	if (onTreeSearches(command).length === 0) return { block: false };
	const p = await judge(command);
	return { block: p !== undefined && p >= BLOCK_AT, p };
}

/** The block message: what to call instead, in the form this agent has. */
export function blockReason(agent: string, p: number): string {
	const call =
		agent === "task-builder"
			? 'the `lsp` tool, e.g. `{"action":"references","file":"/abs/path/x.go","line":42,"symbol":"Name"}`'
			: '`write` to `xd://lsp` with content like `{"action":"references","file":"/abs/path/x.go","line":42,"symbol":"Name"}`';
	return (
		`lsp-guard: blocked. This rg/grep looks up a code symbol (Jev p=${p.toFixed(2)}); ask the language server instead with ${call}. ` +
		'Find a symbol by name with `{"action":"symbols","file":"*","query":"Name"}`; `definition`, `implementation` and `rename` work the same way. ' +
		`If \`status\` shows no server for the language, or you need text matches (comments, strings, SQL, logs), run the same command with \` ${BYPASS}\` appended.`
	);
}
