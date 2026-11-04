// What keeps a worker session inside its slot, for the scheduler (build step 5) to load and call:
//  - `workerGuard`: a `tool_call` guard that blocks `write`/`edit` outside the write scope or on locked tests, and `bash` git mutations;
//  - `snapshotGit` / `compareSnapshot` and `scopeCheck`: the post-slot checks. The guard is best effort (bash can write files and
//    run git in ways no text match catches), so the scheduler rejects a slot when either check reports anything.
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { git, gitOrThrow } from "./spec-git";
import { inScope } from "./spec-guard";
import { expandHome } from "./state";
import { redact } from "./tooling/runtime";

export interface WorkerScope {
	/** The slot's worktree; relative tool paths resolve against it and nothing outside it may be written. */
	cwd: string;
	/** Patterns (globs, files or directories) the worker may write: the task's `owns` and `new_paths`. */
	writeScope: readonly string[];
	/** Locked test files, relative to `cwd`. */
	lockedFiles: readonly string[];
}

/** Git subcommands a worker never runs; only the scheduler commits and moves refs. */
export const GIT_MUTATIONS: readonly string[] = [
	"commit",
	"push",
	"reset",
	"checkout",
	"switch",
	"rebase",
	"merge",
	"cherry-pick",
	"tag",
	"update-ref",
	"stash",
	"worktree",
	"notes",
	"config",
];

/** Global git options that take their value as the next word. */
const VALUE_OPTIONS: readonly string[] = ["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env"];
const SEPARATOR = /[\s;&|()<>`]/;
const MAX_DEPTH = 4;

/** The words of a shell command line: quotes removed and escapes undone; whitespace, `;`, `&`, `|`, parentheses, redirections and backticks end a word. */
function words(text: string): string[] {
	const out: string[] = [];
	let word = "";
	let started = false;
	let quote: string | undefined;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (quote !== undefined) {
			if (ch === quote) quote = undefined;
			else if (ch === "\\" && quote === '"' && i + 1 < text.length) word += text[++i];
			else word += ch;
		} else if (ch === '"' || ch === "'") {
			quote = ch;
			started = true;
		} else if (ch === "\\" && i + 1 < text.length) {
			word += text[++i];
			started = true;
		} else if (SEPARATOR.test(ch)) {
			if (started) out.push(word);
			word = "";
			started = false;
		} else {
			word += ch;
			started = true;
		}
	}
	if (started) out.push(word);
	return out;
}

/**
 * The git mutation a bash command line runs, or undefined. Looks at every `git` word (also `/usr/bin/git`, and the old `git-commit`
 * form) and skips its global options (`-C dir`, `-c k=v`, `--git-dir=x`, `--no-pager`, ...) to the subcommand. A quoted string that
 * holds a command line (`sh -c "git commit"`, `bash -c '...'`, `$(...)`) is read again, so `env`, `sh -c` and `xargs` prefixes do not
 * hide it. Best effort: variables, aliases, scripts and encoded commands are not seen.
 */
export function gitMutation(command: string, depth = 0): string | undefined {
	const tokens = words(command);
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (depth < MAX_DEPTH && SEPARATOR.test(token)) {
			const inner = gitMutation(token, depth + 1);
			if (inner !== undefined) return inner;
		}
		const name = path.basename(token);
		const dashed = /^git-([a-z-]+)$/.exec(name)?.[1];
		if (dashed !== undefined && GIT_MUTATIONS.includes(dashed)) return dashed;
		if (name !== "git") continue;
		for (let j = i + 1; j < tokens.length; j++) {
			const next = tokens[j];
			if (VALUE_OPTIONS.includes(next)) j++;
			else if (!next.startsWith("-")) {
				if (GIT_MUTATIONS.includes(next)) return next;
				break;
			}
		}
	}
	return undefined;
}

/** Path lines of an `edit` payload: hashline `[PATH#TAG]` headers (and the legacy `¶PATH#TAG`), `MV DEST`, and apply_patch headers. */
const EDIT_LINES: readonly RegExp[] = [
	/^\[([^\]\n]+?)#[0-9A-Fa-f]{4}\]\s*$/,
	/^¶+\s*(.+?)#[0-9A-Fa-f]{4}\s*$/,
	/^MV\s+(.+?)\s*$/,
	/^\*\*\* (?:Add|Update|Edit|Delete) File:\s*(.+?)(?:\s+all)?\s*$/,
	/^\*\*\* Move to:\s*(.+?)\s*$/,
];

/**
 * Every path a `write` or `edit` call names, as written: `path`, `_path` and `paths`, and every path found in the payload itself.
 * The payload is read even when `path` is present, because the host only derives `paths` from the payload when `path` is absent.
 */
function writeTargets(input: Record<string, unknown>): string[] {
	const out: string[] = [];
	for (const key of ["path", "_path"]) {
		const value = input[key];
		if (typeof value === "string") out.push(value);
	}
	if (Array.isArray(input.paths)) out.push(...input.paths.filter((value): value is string => typeof value === "string"));
	for (const key of ["input", "_input"]) {
		const payload = input[key];
		if (typeof payload !== "string") continue;
		for (const line of payload.replace(/^\uFEFF/, "").split(/\r?\n/)) {
			for (const pattern of EDIT_LINES) {
				const match = pattern.exec(line);
				if (match) out.push(/^(["']).*\1$/.test(match[1]) ? match[1].slice(1, -1) : match[1]);
			}
		}
	}
	return out;
}

/** Why a write to `target` is not allowed, or undefined. Tool devices and other URLs (`xd://...`) are not repo files. */
function writeBlock(scope: WorkerScope, target: string): string | undefined {
	const raw = target.trim();
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) && !raw.startsWith("file://")) return undefined;
	let absolute: string;
	try {
		absolute = raw.startsWith("file://") ? fileURLToPath(raw) : path.resolve(scope.cwd, expandHome(raw));
	} catch {
		return `worker-guard: ${raw} is not a usable path`;
	}
	const relative = path.relative(scope.cwd, absolute);
	if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		return `worker-guard: ${raw} is outside the worktree ${scope.cwd}; write only inside it.`;
	}
	const inside = relative.split(path.sep).join("/");
	if (scope.lockedFiles.some(file => file.replace(/^(?:\.\/)+/, "") === inside)) {
		return `worker-guard: ${inside} is a locked test. Do not change it; report test_wrong if it is wrong.`;
	}
	if (!inScope(inside, scope.writeScope)) {
		return `worker-guard: ${inside} is outside this task's write scope (${scope.writeScope.join(", ") || "empty"}). Report need_shared_change if it must change.`;
	}
	return undefined;
}

/**
 * An extension factory for a worker session. Its `tool_call` handler blocks `write` and `edit` calls that name a path outside
 * `writeScope` or a locked file, and `bash` commands that run a git mutation (see `gitMutation`).
 */
export function workerGuard(scope: WorkerScope): (pi: ExtensionAPI) => void {
	return pi => {
		pi.on("tool_call", event => {
			if (event.toolName === "bash") {
				const mutation = gitMutation(String(event.input.command ?? ""));
				if (mutation === undefined) return undefined;
				return { block: true, reason: `worker-guard: git ${mutation} is blocked. Workers never touch git; the scheduler commits after the slot.` };
			}
			if (event.toolName !== "write" && event.toolName !== "edit") return undefined;
			for (const target of writeTargets({ ...event.input })) {
				const reason = writeBlock(scope, target);
				if (reason !== undefined) return { block: true, reason };
			}
			return undefined;
		});
	};
}

/** What the scheduler records around a slot to see whether the worker moved anything in git. */
export interface GitSnapshot {
	/** The commit HEAD points at; empty on an unborn branch. */
	head: string;
	/** The branch HEAD names (`refs/heads/x`); empty when HEAD is detached. */
	headRef: string;
	/** Every ref under `refs/` and the object it names. */
	refs: Record<string, string>;
	/** `git config --local --list`, one `key=value` per line. */
	config: string[];
}

export function snapshotGit(repo: string): GitSnapshot {
	const refs: Record<string, string> = {};
	for (const line of gitOrThrow(repo, ["for-each-ref", "--format=%(objectname) %(refname)"]).split("\n")) {
		const space = line.indexOf(" ");
		if (space > 0) refs[line.slice(space + 1)] = line.slice(0, space);
	}
	return {
		head: git(repo, ["rev-parse", "--verify", "--quiet", "HEAD"]).stdout.trim(),
		headRef: git(repo, ["symbolic-ref", "--quiet", "HEAD"]).stdout.trim(),
		refs,
		config: gitOrThrow(repo, ["config", "--local", "--list"]).split("\n").filter(Boolean),
	};
}

/** Every difference between two snapshots, one line each; empty when nothing moved. Credentials in URLs are hidden. */
export function compareSnapshot(before: GitSnapshot, after: GitSnapshot): string[] {
	const changes: string[] = [];
	const short = (sha: string): string => (sha === "" ? "none" : sha.slice(0, 7));
	if (before.head !== after.head) changes.push(`HEAD moved from ${short(before.head)} to ${short(after.head)}`);
	if (before.headRef !== after.headRef) changes.push(`HEAD now names ${after.headRef || "a detached commit"} (was ${before.headRef || "detached"})`);
	for (const ref of [...new Set([...Object.keys(before.refs), ...Object.keys(after.refs)])].sort()) {
		const was = before.refs[ref];
		const now = after.refs[ref];
		if (was === now) continue;
		if (was === undefined) changes.push(`ref ${ref} created at ${short(now)}`);
		else if (now === undefined) changes.push(`ref ${ref} deleted (was ${short(was)})`);
		else changes.push(`ref ${ref} moved from ${short(was)} to ${short(now)}`);
	}
	for (const line of before.config) if (!after.config.includes(line)) changes.push(`config removed: ${redact(line)}`);
	for (const line of after.config) if (!before.config.includes(line)) changes.push(`config added: ${redact(line)}`);
	return changes;
}

export interface ScopeFinding {
	/** The path as `git status` lists it, relative to the worktree root. */
	path: string;
	reason: "outside-scope" | "locked";
}

/**
 * The changed paths of a worktree (`git status`: modified, deleted, staged and untracked files, every untracked file listed) that
 * lie outside `writeScope` or touch a locked file. Catches what the tool guard cannot, such as a file written by a bash redirect.
 * Ignored files are not listed by git and not checked.
 */
export function scopeCheck(worktree: string, writeScope: readonly string[], lockedFiles: readonly string[]): ScopeFinding[] {
	const findings: ScopeFinding[] = [];
	for (const entry of gitOrThrow(worktree, ["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]).split("\0")) {
		if (entry.length < 4) continue;
		const changed = entry.slice(3);
		if (lockedFiles.includes(changed)) findings.push({ path: changed, reason: "locked" });
		else if (!inScope(changed, writeScope)) findings.push({ path: changed, reason: "outside-scope" });
	}
	return findings;
}
