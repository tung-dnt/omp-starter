// `/undo` puts back the files the last prompt's write, edit and ast_edit calls changed; omp's checkpoint and rewind only prune the conversation.
// Each prompt is a group holding the pre-image of every file it first touched (by any agent) plus a git snapshot taken when it starts,
// so `/undo all` can also revert tracked files that bash changed. Groups live in memory until the session starts or switches.
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { tildify } from "./lib/state";
import { resolveFrom, targetPaths } from "./lib/tool-input";

const MAX_GROUPS = 20;
/** A larger file is not copied: `/undo` names it and leaves it alone. */
const MAX_BYTES = 5 * 1024 * 1024;
const GIT_TIMEOUT_MS = 5_000;
const RESTORE_CHUNK = 200;
const SHOWN = 8;
const ABSENT = "absent";
const UNREADABLE = "unreadable";
const URL_LIKE = /^[a-z][\w+.-]*:\/\//i;
const HASHLINE_HEADER = /^\[(.+)#[0-9A-Fa-f]{4}\]$/;
const DELETED_FILE = /^\*\*\* Delete File:\s*(.+?)\s*$/gm;
const SETTLES_COMMAND = /^\s*(?:resolve|reject)\b/;
const SETTLES_DEVICE = /^xd:\/\/(?:resolve|reject)\b/;

/** A file as it was at one moment. `digest` is ABSENT, UNREADABLE, `large:<size>:<mtime>` for a file over MAX_BYTES (never copied), else the sha256 of `bytes`. */
interface Snap {
	digest: string;
	bytes?: Buffer;
	mode?: number;
}

interface Entry {
	/** The file before the group's first change. */
	before: Snap;
	/** Digest of the file when the last tool call that changed it finished; unset until one has. */
	after?: string;
}

interface Group {
	startedAt: number;
	/** The main session's folder; a subagent working elsewhere (an isolated worktree) is not editing the user's files. */
	cwd: string;
	files: Map<string, Entry>;
	/** Files of `ast_edit` previews not applied yet: the edit lands later, when `resolve` runs. */
	staged: string[];
	/** Settles once `gitRef` is known, or git gave none. */
	snapshot: Promise<void>;
	gitRef?: string;
}

// Subagents run the factory again with their own `pi`, so the groups live on `globalThis`, shared by every session of the process.
const KEY = Symbol.for("omp-starter.file-undo");
const store = globalThis as typeof globalThis & { [KEY]?: Group[] };
const groups = (): Group[] => (store[KEY] ??= []);

function look(file: string): Snap {
	try {
		const stat = fs.statSync(file);
		if (!stat.isFile()) return { digest: UNREADABLE };
		if (stat.size > MAX_BYTES) return { digest: `large:${stat.size}:${stat.mtimeMs}` };
		const bytes = fs.readFileSync(file);
		return { digest: createHash("sha256").update(bytes).digest("hex"), bytes, mode: stat.mode & 0o777 };
	} catch (error) {
		const missing = error instanceof Error && "code" in error && error.code === "ENOENT";
		return { digest: missing ? ABSENT : UNREADABLE };
	}
}

/** The path resolved through symlinks as far as it exists, so a file has one spelling before and after it is created. */
function canonical(file: string): string {
	const tail: string[] = [];
	for (let dir = file; ; dir = path.dirname(dir)) {
		try {
			return path.join(fs.realpathSync(dir), ...tail);
		} catch {
			if (path.dirname(dir) === dir) return file;
			tail.unshift(path.basename(dir));
		}
	}
}

/** Absolute files a write or edit call changes: its `path`, the sections and `MV` targets of an edit payload, and the files a patch deletes. */
function writtenFiles(toolName: string, input: Record<string, unknown>, cwd: string): string[] {
	if (toolName !== "write" && toolName !== "edit") return [];
	const named = targetPaths(toolName, input);
	// The host derives `paths` from the headers of a multi-file hashline edit.
	if (Array.isArray(input.paths)) named.push(...input.paths.filter((p): p is string => typeof p === "string"));
	if (toolName === "edit" && typeof input.input === "string") named.push(...[...input.input.matchAll(DELETED_FILE)].map(m => m[1]));
	const files = new Set<string>();
	for (const raw of named) {
		// `write` accepts a copied `[path#TAG]`; internal URLs (`local://`, `xd://`) are not files.
		const target = (HASHLINE_HEADER.exec(raw.trim())?.[1] ?? raw).trim();
		if (target !== "" && !URL_LIKE.test(target)) files.add(canonical(resolveFrom(cwd, target)));
	}
	return [...files];
}

/** Files an `ast_edit` preview lists. A preview changes nothing, so they are still as they were before the rewrite. */
function previewedFiles(details: unknown, cwd: string): string[] {
	if (typeof details !== "object" || details === null || !("files" in details) || !Array.isArray(details.files)) return [];
	if ("applied" in details && details.applied === true) return [];
	const root = "cwd" in details && typeof details.cwd === "string" ? details.cwd : cwd;
	return details.files.filter((f): f is string => typeof f === "string" && f !== "" && !URL_LIKE.test(f)).map(f => canonical(path.resolve(root, f)));
}

/** `resolve` applies a staged `ast_edit` and `reject` drops it; each is a tool, a bash command, or a write to `xd://`. */
function settlesPreview(toolName: string, input: Record<string, unknown>): boolean {
	if (toolName === "resolve" || toolName === "reject") return true;
	if (toolName === "bash") return typeof input.command === "string" && SETTLES_COMMAND.test(input.command);
	return toolName === "write" && typeof input.path === "string" && SETTLES_DEVICE.test(input.path);
}

/** Commit holding the work tree as it is now: `git stash create` when there are local changes, else HEAD. Touches neither tree nor stash list. */
async function snapshot(pi: ExtensionAPI, cwd: string): Promise<string | undefined> {
	try {
		const stash = await pi.exec("git", ["-C", cwd, "stash", "create"], { timeout: GIT_TIMEOUT_MS });
		if (stash.code !== 0) return undefined;
		if (stash.stdout.trim()) return stash.stdout.trim();
		const head = await pi.exec("git", ["-C", cwd, "rev-parse", "HEAD"], { timeout: GIT_TIMEOUT_MS });
		return head.code === 0 ? head.stdout.trim() || undefined : undefined;
	} catch {
		return undefined;
	}
}

function startGroup(pi: ExtensionAPI, cwd: string): Group {
	const all = groups();
	// A prompt that changed nothing leaves nothing to undo; the next one takes its place instead of crowding out older groups.
	if (all.at(-1)?.files.size === 0) all.pop();
	const group: Group = { startedAt: Date.now(), cwd, files: new Map(), staged: [], snapshot: Promise.resolve() };
	// Not awaited here: git works while the model thinks, and `tool_call` waits for it before any tool runs.
	group.snapshot = snapshot(pi, cwd).then(ref => {
		group.gitRef = ref;
	});
	all.push(group);
	if (all.length > MAX_GROUPS) all.shift();
	return group;
}

function capture(group: Group, file: string): void {
	if (group.files.has(file)) return;
	const before = look(file);
	// A folder or an unreadable file is not something a write tool replaces.
	if (before.digest !== UNREADABLE) group.files.set(file, { before });
}

function restore(file: string, before: Snap): void {
	if (!before.bytes) {
		fs.rmSync(file, { force: true });
		return;
	}
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, before.bytes);
	fs.chmodSync(file, before.mode ?? 0o644);
}

const files = (n: number): string => `${n} file${n === 1 ? "" : "s"}`;
const names = (list: string[]): string => list.slice(0, SHOWN).map(tildify).join(", ") + (list.length > SHOWN ? ` and ${list.length - SHOWN} more` : "");

function age(since: number): string {
	const s = Math.floor((Date.now() - since) / 1000);
	return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
}

interface GitChange {
	status: string;
	file: string;
}

/** Tracked files that differ from the group's snapshot. Undefined without a snapshot or when git fails. */
async function changedSince(pi: ExtensionAPI, group: Group): Promise<{ root: string; changes: GitChange[] } | undefined> {
	if (!group.gitRef) return undefined;
	try {
		const top = await pi.exec("git", ["-C", group.cwd, "rev-parse", "--show-toplevel"], { timeout: GIT_TIMEOUT_MS });
		const root = top.stdout.trim();
		if (top.code !== 0 || !root) return undefined;
		const diff = await pi.exec("git", ["-C", root, "diff", "--name-status", "--no-renames", "-z", group.gitRef], { timeout: GIT_TIMEOUT_MS });
		if (diff.code !== 0) return undefined;
		const parts = diff.stdout.split("\0");
		const changes: GitChange[] = [];
		for (let i = 0; i + 1 < parts.length; i += 2) changes.push({ status: parts[i], file: path.join(root, parts[i + 1]) });
		return { root, changes };
	} catch {
		return undefined;
	}
}

/** Untracked files written since the group started; git cannot say when a file appeared, so the modification time stands in (with slack for coarse clocks). */
async function createdSince(pi: ExtensionAPI, root: string, group: Group): Promise<string[]> {
	try {
		const result = await pi.exec("git", ["-C", root, "ls-files", "--others", "--exclude-standard", "-z"], { timeout: GIT_TIMEOUT_MS });
		if (result.code !== 0) return [];
		return result.stdout
			.split("\0")
			.filter(Boolean)
			.map(f => path.join(root, f))
			.filter(f => {
				try {
					return fs.statSync(f).mtimeMs >= group.startedAt - 2000;
				} catch {
					return false;
				}
			});
	} catch {
		return [];
	}
}

async function undo(pi: ExtensionAPI, mode: string, ctx: ExtensionCommandContext): Promise<void> {
	if (ctx.agent?.kind === "sub") return;
	const lines: string[] = [];
	let warn = false;
	const say = (line: string, problem = false) => {
		lines.push(line);
		warn ||= problem;
	};
	const finish = () => ctx.ui.notify(lines.join("\n"), warn ? "warning" : "info");

	if (mode !== "" && mode !== "all" && mode !== "list") {
		say("undo: usage: /undo [list | all]", true);
		return finish();
	}
	if (mode === "list") {
		await Promise.all(groups().map(g => g.snapshot));
		const rows = groups().filter(g => g.files.size > 0).reverse();
		if (rows.length === 0) say("undo: nothing to undo");
		else say(`undo: ${rows.length} prompt${rows.length === 1 ? "" : "s"} with file changes, newest first`);
		for (const g of rows) say(`  ${age(g.startedAt)} ago, ${files(g.files.size)}, snapshot ${g.gitRef?.slice(0, 7) ?? "none"}`);
		return finish();
	}
	if (!ctx.isIdle()) {
		say("undo: the agent is still working; wait until the turn ends or press Esc, then run /undo", true);
		return finish();
	}

	// The newest group where some file no longer matches its pre-image; groups whose edits failed or were reverted by hand are dropped.
	const all = groups();
	let found: { group: Group; changed: [string, Entry][] } | undefined;
	while (!found && all.length > 0) {
		const group = all[all.length - 1];
		const changed = [...group.files].filter(([file, entry]) => look(file).digest !== entry.before.digest);
		if (changed.length > 0) found = { group, changed };
		else all.pop();
	}
	if (!found) {
		say("undo: nothing to undo (no edit tool has changed a file since this session started)");
		return finish();
	}

	const { group, changed } = found;
	await group.snapshot;
	const restored: string[] = [];
	const kept: string[] = [];
	const large: string[] = [];
	const failed: string[] = [];
	for (const [file, entry] of changed) {
		const { before } = entry;
		if (!before.bytes && before.digest !== ABSENT) {
			large.push(file);
			continue;
		}
		// Not what the agent left behind: someone edited it since (or no result ever confirmed the agent's write).
		if (entry.after !== look(file).digest) {
			const ok = ctx.hasUI && (await ctx.ui.confirm("Undo", `${tildify(file)} changed after the agent edited it. Restore the earlier version and lose those changes?`));
			if (!ok) {
				kept.push(file);
				continue;
			}
		}
		try {
			restore(file, before);
			restored.push(file);
		} catch (error) {
			failed.push(`${tildify(file)} (${error instanceof Error ? error.message : String(error)})`);
		}
	}
	if (restored.length > 0) say(`undo: restored ${files(restored.length)}: ${names(restored)}`);
	if (kept.length > 0) say(`undo: kept ${files(kept.length)} changed after the edit${ctx.hasUI ? "" : " (no UI to confirm)"}: ${names(kept)}`, true);
	if (large.length > 0) say(`undo: skipped ${files(large.length)} over ${MAX_BYTES / 1024 / 1024} MB (not copied): ${names(large)}`, true);
	if (failed.length > 0) say(`undo: could not restore ${failed.join(", ")}`, true);

	const git = await changedSince(pi, group);
	if (git) {
		const handled = new Set([...restored, ...kept, ...large].map(canonical));
		const outside = git.changes.filter(c => !handled.has(canonical(c.file)) && !kept.includes(c.file));
		const back = outside.filter(c => c.status === "M" || c.status === "D" || c.status === "T");
		const rest = outside.filter(c => !back.includes(c)).map(c => c.file);
		if (mode === "") {
			if (outside.length > 0) say(`undo: changed outside the edit tools (bash?): ${names(outside.map(c => c.file))}; /undo all also restores tracked ones from the snapshot`, true);
		} else {
			if (back.length > 0) {
				const list = back.map(c => c.file);
				if (!ctx.hasUI) say(`undo: /undo all needs a UI to confirm restoring ${files(back.length)} changed outside the edit tools: ${names(list)}`, true);
				else if (await ctx.ui.confirm("Undo all", `Restore ${files(back.length)} from the snapshot taken when the prompt started?\n${names(list)}`)) {
					let error: string | undefined;
					for (let i = 0; i < back.length && !error; i += RESTORE_CHUNK) {
						const chunk = back.slice(i, i + RESTORE_CHUNK).map(c => path.relative(git.root, c.file));
						const result = await pi.exec("git", ["--literal-pathspecs", "-C", git.root, "restore", `--source=${group.gitRef}`, "--worktree", "--", ...chunk], { timeout: GIT_TIMEOUT_MS * 4 });
						if (result.code !== 0) error = result.stderr.trim().split("\n")[0] || `git restore exited with ${result.code}`;
					}
					if (error) say(`undo: restoring from the snapshot failed: ${error}`, true);
					else say(`undo: restored ${files(back.length)} from the snapshot: ${names(list)}`);
				} else say(`undo: kept ${files(back.length)} changed outside the edit tools: ${names(list)}`, true);
			}
			if (rest.length > 0) say(`undo: added or unmerged since the snapshot, left alone: ${names(rest)}`, true);
			const created = (await createdSince(pi, git.root, group)).filter(f => !handled.has(canonical(f)));
			if (created.length > 0) say(`undo: untracked files written since the snapshot, never deleted: ${names(created)}`, true);
		}
	} else if (mode === "all") say("undo: no git snapshot for that prompt (not a git work tree?), so only the edit-tool changes were undone", true);

	all.splice(all.indexOf(group), 1);
	finish();
}

export default function fileUndo(pi: ExtensionAPI): void {
	const reset = (ctx: { agent?: { kind: string } }) => {
		if (ctx.agent?.kind !== "sub") groups().length = 0;
	};
	pi.on("session_start", (_event, ctx) => reset(ctx));
	pi.on("session_switch", (_event, ctx) => reset(ctx));

	// Once per user prompt, and awaited by the host before the turn starts, unlike `agent_start`.
	pi.on("before_agent_start", (event, ctx) => {
		if (ctx.agent?.kind !== "sub" && event.reason !== "revive") startGroup(pi, ctx.cwd);
	});

	pi.on("tool_call", async (event, ctx) => {
		// tool_call handlers fail closed: a throw here would block the user's edit, so none may escape.
		try {
			const input = (event.input ?? {}) as Record<string, unknown>;
			const touched = writtenFiles(event.toolName, input, ctx.cwd);
			const group = touched.length > 0 ? (groups().at(-1) ?? startGroup(pi, ctx.cwd)) : groups().at(-1);
			// Nothing, bash included, runs before the git snapshot of the prompt exists.
			await group?.snapshot;
			if (!group || (ctx.agent?.kind === "sub" && ctx.cwd !== group.cwd)) return;
			for (const file of touched) capture(group, file);
		} catch (error) {
			pi.logger.warn("file-undo: could not record a pre-image", { error: String(error) });
		}
	});

	pi.on("tool_result", (event, ctx) => {
		const group = groups().at(-1);
		if (!group || (ctx.agent?.kind === "sub" && ctx.cwd !== group.cwd)) return;
		const input = (event.input ?? {}) as Record<string, unknown>;
		if (event.toolName === "ast_edit") {
			if (event.isError) return;
			for (const file of previewedFiles(event.details, ctx.cwd)) {
				capture(group, file);
				if (group.files.has(file)) group.staged.push(file);
			}
		} else if (settlesPreview(event.toolName, input)) {
			for (const g of groups()) {
				for (const file of g.staged.splice(0)) {
					const entry = g.files.get(file);
					if (entry) entry.after = look(file).digest;
				}
			}
		} else {
			// Error or not: what the call left on disk is what a later /undo must find.
			for (const file of writtenFiles(event.toolName, input, ctx.cwd)) {
				const entry = group.files.get(file);
				if (entry) entry.after = look(file).digest;
			}
		}
	});

	pi.registerCommand("undo", {
		description: "Undo the file changes the agent made in the last prompt. Args: list | all (also restore tracked files bash changed)",
		handler: (args, ctx) => undo(pi, args.trim().toLowerCase(), ctx),
	});
}
