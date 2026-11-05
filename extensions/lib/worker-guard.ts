// What keeps a worker session inside its slot, for the scheduler (build step 5) to load and call:
//  - `workerGuard`: a `tool_call` guard that blocks `write`/`edit` outside the write scope or on locked tests, and `bash` git mutations;
//  - `snapshotGit` / `compareSnapshot` and `scopeCheck`: the post-slot checks. The guard is best effort (bash can write files and
//    run git in ways no text match catches), so the scheduler rejects a slot when either check reports anything.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { gitCommonDir } from "./spec-cli";
import { NO_HOOKS, git, gitOrThrow } from "./spec-git";
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
	/** When set, a write is allowed only to a file this accepts (repo-relative path): the tests phase writes test files only. */
	only?: (path: string) => boolean;
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
	if (scope.only !== undefined && !scope.only(inside)) return `worker-guard: ${inside} ${NOT_A_TEST_FILE}`;
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

/** Why the tests phase refuses a file: only test files may be written, so no source stub ends up locked as a "test". */
export const NOT_A_TEST_FILE =
	"is not a test file. This phase writes only test files: the repo's checks.test_paths from the plan, else *.test.*, *.spec.*, *_test.*, test_*.*, __tests__/ and tests/. Report need_shared_change if a helper outside them is needed.";

/** What the scheduler records around a slot to see whether the worker moved anything in git. */
export interface GitSnapshot {
	/** The commit HEAD points at; empty on an unborn branch. */
	head: string;
	/** The branch HEAD names (`refs/heads/x`); empty when HEAD is detached. */
	headRef: string;
	/** Every ref under `refs/` and the object it names. */
	refs: Record<string, string>;
	/** The target of every ref that is a symbolic ref (`refs/heads/x` → `refs/heads/y`); its `refs` value is the object it resolves to. */
	symrefs: Record<string, string>;
	/** `git config --local --list`, one `key=value` per line. */
	config: string[];
	/** Digests (mode and bytes) of every file under `<common-dir>/hooks` and `<common-dir>/info`, and of `<common-dir>/config`, keyed `hooks/<name>`, `info/<name>` and `config`. */
	guarded: Record<string, string>;
}

/** A file under `<common-dir>/hooks` or `<common-dir>/info`, as it was read. */
export interface GuardedFile {
	/** Digest of the mode and the content. */
	digest: string;
	mode: number;
	/** The target of a symlink. */
	link?: string;
	/** The bytes of a regular file. */
	data?: Buffer;
}

/** The files git runs or reads on its own authority: hooks and `info/` (exclude rules, sparse checkout). Keyed by their path under the common dir. */
export function readGuarded(repo: string): Map<string, GuardedFile> {
	const common = gitCommonDir(repo);
	const out = new Map<string, GuardedFile>();
	const visit = (relative: string): void => {
		const full = path.join(common, relative);
		let stat: fs.Stats;
		try {
			stat = fs.lstatSync(full);
		} catch {
			return;
		}
		if (stat.isDirectory()) {
			for (const entry of fs.readdirSync(full).sort()) visit(`${relative}/${entry}`);
			return;
		}
		const mode = stat.mode & 0o7777;
		const link = stat.isSymbolicLink() ? fs.readlinkSync(full) : undefined;
		const data = link === undefined ? fs.readFileSync(full) : undefined;
		const hasher = new Bun.CryptoHasher("sha256");
		hasher.update(`${mode.toString(8)}\0`);
		hasher.update(link === undefined ? (data ?? "") : `link:${link}`);
		out.set(relative, { digest: hasher.digest("hex"), mode, ...(link === undefined ? {} : { link }), ...(data === undefined ? {} : { data }) });
	};
	visit("hooks");
	visit("info");
	visit("config");
	return out;
}

/**
 * Puts `hooks/`, `info/` and `config` back as `baseline` read them, byte for byte: whatever stands at a path (a directory, a symlink, a
 * file where a folder was) is removed without following it, then the baseline file is written. Every file is tried even when one fails,
 * and the result is read back: a restore that did not take throws, so a missing `pre-push` is never left silently.
 */
export function restoreGuarded(repo: string, baseline: ReadonlyMap<string, GuardedFile>): void {
	const common = gitCommonDir(repo);
	const errors: unknown[] = [];
	const attempt = (fn: () => void): void => {
		try {
			fn();
		} catch (error) {
			errors.push(error);
		}
	};
	const remove = (full: string): void => fs.rmSync(full, { recursive: true, force: true });
	for (const relative of readGuarded(repo).keys()) if (!baseline.has(relative)) attempt(() => remove(path.join(common, relative)));
	for (const [relative, file] of baseline) {
		attempt(() => {
			const full = path.join(common, relative);
			// A file where a folder must be (`hooks` replaced by a file) blocks the write: clear every ancestor that is not a folder.
			const parts = relative.split("/").slice(0, -1);
			for (let i = 1; i <= parts.length; i++) {
				const ancestor = path.join(common, ...parts.slice(0, i));
				const stat = fs.lstatSync(ancestor, { throwIfNoEntry: false });
				if (stat !== undefined && !stat.isDirectory()) remove(ancestor);
			}
			fs.mkdirSync(path.dirname(full), { recursive: true });
			if (readGuarded(repo).get(relative)?.digest === file.digest) return;
			remove(full);
			if (file.link !== undefined) fs.symlinkSync(file.link, full);
			else {
				fs.writeFileSync(full, file.data ?? "");
				fs.chmodSync(full, file.mode);
			}
		});
	}
	if (errors.length === 0) {
		const now = readGuarded(repo);
		const wrong = [...new Set([...baseline.keys(), ...now.keys()])].filter(relative => baseline.get(relative)?.digest !== now.get(relative)?.digest);
		if (wrong.length > 0) throw new Error(`the git dir could not be restored: ${wrong.join(", ")} still differ from the baseline`);
	}
	if (errors.length > 0) throw errors[0];
}

export function snapshotGit(repo: string): GitSnapshot {
	const refs: Record<string, string> = {};
	const symrefs: Record<string, string> = {};
	for (const line of gitOrThrow(repo, ["for-each-ref", "--format=%(objectname) %(symref) %(refname)"]).split("\n")) {
		const [sha, symref, ref] = line.split(" ");
		if (!sha || !ref) continue;
		refs[ref] = sha;
		if (symref) symrefs[ref] = symref;
	}
	return {
		head: git(repo, ["rev-parse", "--verify", "--quiet", "HEAD"]).stdout.trim(),
		headRef: git(repo, ["symbolic-ref", "--quiet", "HEAD"]).stdout.trim(),
		refs,
		symrefs,
		config: gitOrThrow(repo, ["config", "--local", "--list"]).split("\n").filter(Boolean),
		guarded: Object.fromEntries([...readGuarded(repo)].map(([file, { digest }]) => [file, digest])),
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
		const wasLink = before.symrefs[ref];
		const nowLink = after.symrefs[ref];
		if (wasLink !== nowLink) {
			if (wasLink === undefined) changes.push(`ref ${ref} became a symref to ${nowLink}`);
			else if (nowLink === undefined) changes.push(`ref ${ref} is no longer a symref (was ${wasLink})`);
			else changes.push(`ref ${ref} now points at ${nowLink} (was ${wasLink})`);
			continue;
		}
		if (was === now) continue;
		if (was === undefined) changes.push(`ref ${ref} created at ${short(now)}`);
		else if (now === undefined) changes.push(`ref ${ref} deleted (was ${short(was)})`);
		else changes.push(`ref ${ref} moved from ${short(was)} to ${short(now)}`);
	}
	for (const line of before.config) if (!after.config.includes(line)) changes.push(`config removed: ${redact(line)}`);
	for (const line of after.config) if (!before.config.includes(line)) changes.push(`config added: ${redact(line)}`);
	for (const file of [...new Set([...Object.keys(before.guarded), ...Object.keys(after.guarded)])].sort()) {
		const was = before.guarded[file];
		const now = after.guarded[file];
		if (was === now) continue;
		changes.push(was === undefined ? `${file} was created in the git dir` : now === undefined ? `${file} was deleted from the git dir` : `${file} was changed in the git dir`);
	}
	return changes;
}

export interface ScopeFinding {
	/** The path as `git status` lists it, relative to the worktree root. */
	path: string;
	reason: "outside-scope" | "locked" | "not-test";
}

/**
 * The changed paths of a worktree (`git status`: modified, deleted, staged and untracked files, every untracked file listed) that
 * lie outside `writeScope` or touch a locked file. Catches what the tool guard cannot, such as a file written by a bash redirect.
 * Ignored files are not listed by git and not checked.
 */
export function scopeCheck(worktree: string, writeScope: readonly string[], lockedFiles: readonly string[], only?: (path: string) => boolean): ScopeFinding[] {
	const findings: ScopeFinding[] = [];
	for (const entry of gitOrThrow(worktree, [...NO_HOOKS, "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]).split("\0")) {
		if (entry.length < 4) continue;
		const changed = entry.slice(3);
		if (lockedFiles.includes(changed)) findings.push({ path: changed, reason: "locked" });
		else if (!inScope(changed, writeScope)) findings.push({ path: changed, reason: "outside-scope" });
		else if (only !== undefined && !only(changed)) findings.push({ path: changed, reason: "not-test" });
	}
	return findings;
}
