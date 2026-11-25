// The /ship fence, part 3: omp tool calls while the fence is armed. gh and git processes are judged by the shims;
// this catches what they can't see: edits to files /ship never touches (by any spelling of their path), the github
// tool's pushes and PRs, and shell or eval lines that would step around the shims.
import * as fs from "node:fs";
import * as path from "node:path";
import { repoRoot } from "../lib/repo";
import { resolveFrom, simpleCommands, targetPaths } from "../lib/tool-input";
import { canonical, checkPeerGh, isProtectedPath, peerRefused, refused } from "./fence";
import { FENCE_SOURCE, type FenceState, type Git, realGit, SHIM_DIR, stateDir } from "./fence-state";

/** omp URL schemes that never name a repo file. `conflict://` does (a conflicted file), so it is not here. */
const URL_SCHEMES: Record<string, true> = Object.fromEntries(
	["local", "skill", "agent", "history", "omp", "artifact", "mcp", "issue", "pr", "proc", "help", "attachment", "memory"].map(s => [s, true]),
);

const inside = (p: string, dir: string) => p === dir || p.startsWith(`${dir}${path.sep}`);

/** Paths a write, edit or ast_edit call names that /ship may not touch, as the user should read them. */
export function protectedTargets(toolName: string, input: Record<string, unknown>, cwd: string, state: FenceState, git: Git = realGit): string[] {
	const astPaths = Array.isArray(input.paths) ? input.paths : typeof input.paths === "string" ? [input.paths] : [];
	const named = toolName === "ast_edit" ? astPaths.flatMap(p => (typeof p === "string" ? p.split(/[;,\s]+/) : [])) : toolName === "write" || toolName === "edit" ? targetPaths(toolName, input) : [];
	const root = canonical(state.root ?? repoRoot(cwd) ?? cwd);
	const own = [SHIM_DIR, FENCE_SOURCE, stateDir()].map(canonical);
	const held: string[] = [];
	for (const p of named) {
		if (typeof p !== "string" || p === "") continue;
		const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(p)?.[1]?.toLowerCase();
		if (scheme === "conflict") {
			held.push(`${p} (resolve a conflict by editing the file by its path)`);
			continue;
		}
		if (scheme && Object.hasOwn(URL_SCHEMES, scheme)) continue;
		if (toolName === "ast_edit" && /[*?[{]/.test(p)) {
			held.push(`${p} (name files or folders, not a pattern)`);
			continue;
		}
		const target = canonical(resolveFrom(cwd, p));
		if (own.some(dir => inside(target, dir)) || state.gitDirs.some(dir => inside(target, dir))) {
			held.push(p);
			continue;
		}
		const rel = path.relative(root, target).split(path.sep).join("/");
		if (rel.startsWith("..") || path.isAbsolute(rel)) continue;
		if (isProtectedPath(rel)) held.push(rel);
		else if (toolName === "ast_edit" && fs.existsSync(target) && fs.statSync(target).isDirectory()) {
			const listing = git(root, "ls-files", "-z", "--", rel || ".").out.split("\0");
			if (listing.some(file => file && isProtectedPath(file))) held.push(`${rel || "."} (holds files /ship never edits; name the files)`);
		}
	}
	return held;
}

/** Variables that point gh and git elsewhere, or switch the fence off. */
const FENCE_VARS = /^(?:PATH|OMP_SHIP_FENCE\w*|GIT_CONFIG\w*|GIT_EXEC_PATH|GIT_DIR|GIT_WORK_TREE|BUN_BE_BUN|GH_CONFIG_DIR)$/;
const assignment = (word: string) => /^([A-Za-z_][A-Za-z0-9_]*)\+?=/.exec(word)?.[1];
/** Programs that run the next word as a command. */
const WRAPPERS: Record<string, true> = Object.fromEntries(["command", "builtin", "exec", "nohup", "time", "sudo", "xargs", "xcrun", "nice", "stdbuf", "caffeinate", "{", "!"].map(w => [w, true]));
const SETTERS: Record<string, true> = Object.fromEntries(["export", "unset", "declare", "typeset", "readonly", "local"].map(w => [w, true]));

/** Why one simple shell command would step around the shims, or null. Only the command's own words count. */
function commandProblem(words: string[]): string | null {
	let k = 0;
	for (;;) {
		const name = assignment(words[k] ?? "");
		if (name === undefined) break;
		if (FENCE_VARS.test(name)) return "PATH, the fence's variables, git's config variables and GH_CONFIG_DIR stay as they are";
		k++;
	}
	while (k < words.length) {
		const program = words[k] as string;
		if (program === "env") {
			k++;
			while (k < words.length && ((words[k] as string).startsWith("-") || assignment(words[k] as string) !== undefined)) {
				const word = words[k] as string;
				if (/^-(?:[a-zA-Z]*[iuS]|-ignore-environment|-unset|-split-string)/.test(word) || FENCE_VARS.test(assignment(word) ?? "")) return "env may not clear or reset the fence's variables";
				k++;
			}
			continue;
		}
		if (program === "command" && words[k + 1] === "-p") return "command -p skips PATH";
		if (!Object.hasOwn(WRAPPERS, program)) break;
		k++;
		while (k < words.length && (words[k] as string).startsWith("-")) k++;
	}
	const program = words[k] ?? "";
	if (Object.hasOwn(SETTERS, program) && words.slice(k + 1).some(w => FENCE_VARS.test(assignment(w) ?? w))) return "PATH, the fence's variables, git's config variables and GH_CONFIG_DIR stay as they are";
	// `/usr/bin/git`, `./git`, `~/.local/bin/gh`, `/usr/bin/g?t`, or a program computed by `$(which -a git …)`.
	if (program.includes("/") && /^(?:gh|git|git-lfs|gh-blinx)$|[*?[]/.test(path.basename(program))) return "call gh, git and git-lfs by name, not by path";
	if (/^[$`]/.test(program) && /\b(?:git|gh)\b/.test(words.join(" "))) return "call gh and git by name, not by a computed path";
	return null;
}

/** What a shell line or an eval cell may not do, whatever runs it. */
function checkText(toolName: string, text: unknown): string | null {
	if (typeof text !== "string") return null;
	const own = [SHIM_DIR, FENCE_SOURCE, stateDir(), "/.omp/agent/ship/"];
	if (own.some(p => text.includes(p)) || /\$\{?OMP_SHIP_FENCE/.test(text)) return refused("the fence's own files stay as they are");
	if (/api\.github\.com/i.test(text)) return refused("reach GitHub through gh and git only");
	if (/\bauth\s+token\b/.test(text)) return refused("the GitHub token stays inside gh");
	if (toolName === "eval") {
		if (/environ\s*\[\s*["'](?:PATH|OMP_SHIP_FENCE)|process\.env\.(?:PATH|OMP_SHIP_FENCE)\s*=|OMP_SHIP_FENCE/.test(text)) return refused("PATH and the fence's variables stay as they are");
		if (/["'`]\/[^"'`\s]*\/(?:gh|git|git-lfs|gh-blinx)["'`]/.test(text)) return refused("call gh, git and git-lfs by name, not by path");
		return null;
	}
	for (const { words } of simpleCommands(text)) {
		const why = commandProblem(words);
		if (why) return refused(why);
	}
	return null;
}

const PEER_READ_TOOLS: Record<string, true> = { read: true, glob: true, grep: true, ast_grep: true };
const PEER_LSP_READS: Record<string, true> = { diagnostics: true, definition: true, references: true, hover: true, symbols: true, type_definition: true, implementation: true, status: true, capabilities: true };
const PEER_REVIEW_AGENTS: Record<string, true> = {
	"thermo-nuclear-review-subagent": true,
	"thermo-nuclear-code-quality-review-subagent": true,
	scout: true,
	reviewer: true,
	"security-reviewer": true,
};
const PEER_CHILD_TOOLS: Record<string, true> = { read: true, glob: true, grep: true, ast_grep: true, lsp: true, bash: true };

function checkPeerTasks(input: Record<string, unknown>): string | null {
	if (input.isolation === "worktree" || "worktree" in input && input.worktree !== false && input.worktree !== undefined) return peerRefused("subagent worktrees are refused");
	if ("tools" in input && (!Array.isArray(input.tools) || input.tools.some((tool: unknown) => typeof tool !== "string" || !Object.hasOwn(PEER_CHILD_TOOLS, tool)))) return peerRefused("subagents may receive only read-only peer tools");
	const tasks: unknown[] = Array.isArray(input.tasks) ? input.tasks : "tasks" in input ? [] : typeof input.agent === "string" ? [input] : [];
	if (tasks.length === 0) return peerRefused("only named read-only review subagents may be started");
	for (const task of tasks) {
		if (typeof task !== "object" || task === null || Array.isArray(task) || !("agent" in task)) return peerRefused("only named read-only review subagents may be started");
		if (typeof task.agent !== "string" || !Object.hasOwn(PEER_REVIEW_AGENTS, task.agent)) return peerRefused("general-purpose and writer subagents are refused");
		if (("isolation" in task && task.isolation === "worktree") || ("worktree" in task && task.worktree !== false && task.worktree !== undefined)) return peerRefused("subagent worktrees are refused");
		if ("tools" in task && (!Array.isArray(task.tools) || task.tools.some((tool: unknown) => typeof tool !== "string" || !Object.hasOwn(PEER_CHILD_TOOLS, tool)))) {
			return peerRefused("subagents may receive only read-only peer tools");
		}
	}
	return null;
}

/** Peer shell allows one literal gh command; its argv is checked again by the shim. */
function checkPeerShell(text: unknown, state: FenceState, input: Record<string, unknown>): string | null {
	if (typeof text !== "string" || "env" in input) return peerRefused("shell input is not a single checked gh command");
	let quote: "'" | '"' | null = null;
	for (let i = 0; i < text.length; i++) {
		const char = text[i] ?? "";
		if (quote === "'") {
			if (char === "'") quote = null;
		} else if (quote === '"') {
			if (char === '"') quote = null;
			else if (char === "$" || char === "`" || char === "\\") return peerRefused("shell expansion is refused");
		} else if (char === "'" || char === '"') quote = char;
		else if (char === "\\" || ";&|<>`$()\n\r*?[]{}!".includes(char)) return peerRefused("shell operators, expansion and globbing are refused");
		else if (char === "#" && (i === 0 || /\s/.test(text[i - 1] ?? ""))) return peerRefused("shell comments are refused");
	}
	if (quote !== null) return peerRefused("unclosed shell quotes are refused");
	const commands = simpleCommands(text);
	if (commands.length !== 1) return peerRefused("shell input must be one gh command");
	const [command] = commands;
	if (command === undefined || command.piped || command.words.length === 0) return peerRefused("shell input must be one gh command");
	const [program, ...args] = command.words;
	if (program !== "gh" && program !== "gh-blinx") return peerRefused("only read-only gh commands may run in a peer review");
	return checkPeerGh(args, state.pr, process.env);
}

function checkPeerToolCall(toolName: string, input: Record<string, unknown>, state: FenceState): string | null {
	if (toolName === "bash") return checkPeerShell(input.command, state, input);
	if (toolName === "eval") return peerRefused("eval can execute arbitrary code");
	if (toolName === "task" || toolName === "agent" || toolName === "subagent") return checkPeerTasks(input);
	if (Object.hasOwn(PEER_REVIEW_AGENTS, toolName)) {
		if (
			input.isolation === "worktree" ||
			("worktree" in input && input.worktree !== false && input.worktree !== undefined) ||
			("tools" in input && (!Array.isArray(input.tools) || input.tools.some((tool: unknown) => typeof tool !== "string" || !Object.hasOwn(PEER_CHILD_TOOLS, tool))))
		) return peerRefused("review subagents may not create worktrees or receive writer tools");
		return null;
	}
	if (Object.hasOwn(PEER_READ_TOOLS, toolName)) return null;
	if (toolName === "lsp" && typeof input.action === "string" && Object.hasOwn(PEER_LSP_READS, input.action)) return null;
	if (toolName === "lsp" && input.action === "code_actions" && input.apply === false) return null;
	return peerRefused(`${toolName} is not an allowed read-only peer tool`);
}

export function checkToolCall(toolName: string, input: Record<string, unknown>, state: FenceState, cwd: string, git: Git = realGit): string | null {
	if (state.mode === "peer") return checkPeerToolCall(toolName, input, state);
	if (toolName === "bash") return checkText(toolName, input.command);
	if (toolName === "eval") return checkText(toolName, input.code);
	const held = protectedTargets(toolName, input, cwd, state, git);
	if (held.length > 0) return refused(`${held.join(", ")}: /ship never edits these; leave the fix to the user`);
	if (toolName !== "github") return null;
	if (input.op === "pr_create" && input.draft !== true) return refused("open the pull request as a draft (draft: true)");
	if (input.op !== "pr_push") return null;
	if (input.forceWithLease === true) return refused("force pushes are refused");
	if (state.pushBranch === null) return refused("this session pushes nothing");
	if (input.branch !== state.pushBranch) return refused(`this session pushes only to ${state.pushBranch}: pass branch "${state.pushBranch}"`);
	return null;
}
