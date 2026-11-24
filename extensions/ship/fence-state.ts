// The /ship fence, part 2: its state and what a push carries.
//
// The state is one file per omp process, named by OMP_SHIP_FENCE. The extension creates it and puts bin/ship-fence
// first on PATH when it loads, before omp captures the environment its shells start from, so a later arm or disarm only
// rewrites the file: no shell needs a new environment. The shims read `"armed"` from it on every gh and git call.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type GitPolicy, isProtectedPath, refused, retryable } from "./fence";

export const FENCE_ENV = "OMP_SHIP_FENCE";
export const SHIM_DIR = path.resolve(import.meta.dir, "..", "..", "bin", "ship-fence");
/** The fence's own source, which a fenced session may not change. */
export const FENCE_SOURCE = import.meta.dir;
export const stateDir = (): string => path.join(os.homedir(), ".omp", "agent", "ship", "fence");

export interface FenceState extends GitPolicy {
	armed: boolean;
	/** The checkout /ship works in; its git folders are `gitDirs`. */
	root: string | null;
	/** Protected files as the branch held them when /ship armed: path to blob id. A push may keep these. */
	snapshot: Record<string, string>;
	/** What the shims run their check with: bun, or omp's own binary with BUN_BE_BUN=1. */
	bun: string;
	beBun: boolean;
}

const unarmed = (): FenceState => ({ armed: false, pushBranch: null, root: null, gitDirs: [], snapshot: {}, ...checker() });

function checker(): { bun: string; beBun: boolean } {
	const found = Bun.which("bun", { PATH: pathEntries().join(path.delimiter) });
	return found ? { bun: found, beBun: false } : { bun: process.execPath, beBun: true };
}

function pathEntries(): string[] {
	return (process.env.PATH ?? "").split(path.delimiter).filter(entry => entry !== "" && entry !== SHIM_DIR);
}

/** A missing file is an unarmed fence (a session that never ran /ship); an unreadable one is armed and pushes nothing. */
export function readState(file: string | undefined): FenceState {
	if (!file || !fs.existsSync(file)) return unarmed();
	try {
		const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<FenceState>;
		return {
			armed: raw.armed !== false,
			pushBranch: typeof raw.pushBranch === "string" && raw.pushBranch !== "" ? raw.pushBranch : null,
			root: typeof raw.root === "string" ? raw.root : null,
			gitDirs: Array.isArray(raw.gitDirs) ? raw.gitDirs.filter((d): d is string => typeof d === "string") : [],
			snapshot: raw.snapshot && typeof raw.snapshot === "object" ? (raw.snapshot as Record<string, string>) : {},
			bun: typeof raw.bun === "string" ? raw.bun : checker().bun,
			beBun: raw.beBun === true,
		};
	} catch {
		return { ...unarmed(), armed: true };
	}
}

function writeState(file: string, state: FenceState): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(`${file}.tmp`, JSON.stringify(state));
	fs.renameSync(`${file}.tmp`, file);
}

export const currentState = (): FenceState => readState(process.env[FENCE_ENV]);

/**
 * Called when the extension loads: names this process's state file (unless the launcher already did) and puts the
 * shims first on PATH. Until /ship arms it, the shims pass every call straight through. State files of omp processes
 * that have exited are removed.
 */
export function installFence(): void {
	if (!process.env[FENCE_ENV]) {
		const dir = stateDir();
		for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
			const pid = Number(name.replace(/\.json$/, ""));
			if (!Number.isInteger(pid) || pid === process.pid) continue;
			try {
				process.kill(pid, 0);
			} catch {
				fs.rmSync(path.join(dir, name), { force: true });
			}
		}
		const file = path.join(dir, `${process.pid}.json`);
		writeState(file, unarmed());
		process.env[FENCE_ENV] = file;
	}
	process.env.PATH = [SHIM_DIR, ...pathEntries()].join(path.delimiter);
}

export type Git = (dir: string, ...args: string[]) => { code: number; out: string };

/**
 * git found on PATH past the shims, so the fence's own reads don't go through it. Replacement refs are off: the session
 * can plant them with update-ref, and a push sends the real objects, not the ones a replacement shows.
 */
export const realGit: Git = (dir, ...args) => {
	const git = Bun.which("git", { PATH: pathEntries().join(path.delimiter) }) ?? "git";
	const p = Bun.spawnSync([git, "--no-replace-objects", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
	return { code: p.exitCode ?? 1, out: p.stdout.toString() };
};

/** Protected files in `ref`'s tree: path to blob id. */
function protectedBlobs(dir: string, ref: string, git: Git): Record<string, string> {
	const out: Record<string, string> = {};
	const listing = git(dir, "ls-tree", "-r", "-z", ref);
	if (listing.code !== 0) return out;
	for (const entry of listing.out.split("\0")) {
		const tab = entry.indexOf("\t");
		if (tab < 0) continue;
		const file = entry.slice(tab + 1);
		if (isProtectedPath(file)) out[file] = entry.slice(0, tab).split(" ")[2] ?? "";
	}
	return out;
}

/** Arms the fence for a watch of `pushBranch` in `root`. Arming again replaces the watch. */
export function armFence(watch: { pushBranch: string; root: string }, git: Git = realGit): void {
	const file = process.env[FENCE_ENV];
	if (!file) throw new Error("ship fence: the ship-fence extension is not loaded in this session");
	const root = fs.realpathSync(watch.root);
	const gitDirs = ["--git-dir", "--git-common-dir"]
		.map(flag => git(root, "rev-parse", "--path-format=absolute", flag).out.trim())
		.filter(Boolean)
		.map(dir => fs.realpathSync(dir));
	writeState(file, { ...readState(file), armed: true, pushBranch: watch.pushBranch, root, gitDirs: [...new Set(gitDirs)], snapshot: protectedBlobs(root, "HEAD", git) });
}

export function disarmFence(): void {
	const file = process.env[FENCE_ENV];
	if (file) writeState(file, { ...readState(file), armed: false, pushBranch: null, root: null, gitDirs: [], snapshot: {} });
}

const blobAt = (dir: string, ref: string, file: string, git: Git): string => {
	const r = git(dir, "rev-parse", "--verify", "--quiet", `${ref}:${file}`);
	return r.code === 0 ? r.out.trim() : "";
};

/**
 * What origin holds now, asked of origin itself: a remote-tracking ref only says what some fetch saw, and the session can
 * move one. `baseName` is the branch origin's HEAD points at, when it names one. Null when origin can't be read.
 */
function originTips(dir: string, branch: string, git: Git): { branch?: string; base?: string; baseName?: string } | null {
	const listing = git(dir, "ls-remote", "--symref", "origin", `refs/heads/${branch}`, "HEAD");
	if (listing.code !== 0) return null;
	const tips: { branch?: string; base?: string; baseName?: string } = {};
	for (const line of listing.out.split("\n")) {
		const [oid, ref] = line.split("\t");
		if (!oid) continue;
		// `ref: refs/heads/main<TAB>HEAD` names where HEAD points. ls-remote matches names by their tail, so only the exact refs count.
		if (oid.startsWith("ref: ")) {
			if (ref === "HEAD") tips.baseName = oid.slice("ref: ".length).replace(/^refs\/heads\//, "");
		} else if (ref === `refs/heads/${branch}`) tips.branch = oid;
		else if (ref === "HEAD") tips.base = oid;
	}
	return tips;
}

/** The fetch that brings the tips of `refs`. The names come from origin: one that opens with `-` would read as an option, so it goes in full, and one a shell would read is quoted. */
const fetchCommand = (refs: string[]): string => {
	const words = refs.map(ref => (ref.startsWith("-") ? `refs/heads/${ref}` : ref)).map(ref => (/^[\w./@+-]+$/.test(ref) ? ref : `'${ref.replace(/'/g, "'\\''")}'`));
	return `git fetch origin ${words.join(" ")}`;
};

/**
 * Why a push that the argv checks allowed still can't go: it carries a change to a protected file that is neither how
 * the branch held it when /ship armed nor how origin's default branch holds it now (what merging the base brings is
 * fine). Origin is asked for its tips, and the push is compared with its watched branch, or with where the push's
 * history leaves the default branch when origin has no such branch yet. A tip this checkout lacks is not a verdict but
 * the fetch that brings it: a plain `git fetch origin` leaves out the default branch of a single-branch or shallow clone.
 */
export function checkPushContent(dir: string, sources: string[], state: FenceState, git: Git = realGit): string | null {
	if (state.pushBranch === null) return refused("this session pushes nothing");
	const tips = originTips(dir, state.pushBranch, git);
	if (tips === null) return retryable("can't read origin (git ls-remote origin failed), so can't tell what the push changes");
	const lacking = ([[state.pushBranch, tips.branch], [tips.baseName ?? "HEAD", tips.base]] as const)
		.filter(([, oid]) => oid !== undefined && git(dir, "cat-file", "-e", `${oid}^{commit}`).code !== 0)
		.map(([name]) => name);
	if (lacking.length > 0) return retryable(`this checkout lacks origin's ${lacking.join(" and ")}, so can't tell what the push changes: run ${fetchCommand(lacking)}`);
	for (const src of sources) {
		const tip = git(dir, "rev-parse", "--verify", "--quiet", `${src}^{commit}`).out.trim();
		if (!tip) return refused(`can't read what ${src} would push`);
		const from = tips.branch ?? (tips.base === undefined ? "" : git(dir, "merge-base", tip, tips.base).out.trim());
		let changed: string[];
		if (from) {
			// A move is the old name's deletion and the new name's addition: --name-only alone would show only the new one.
			const diff = git(dir, "diff-tree", "-r", "--no-renames", "--name-only", "-z", from, tip);
			if (diff.code !== 0) return retryable(`can't compare what ${src} would push with what origin holds: run ${fetchCommand([tips.branch === undefined ? (tips.baseName ?? "HEAD") : state.pushBranch])}`);
			changed = diff.out.split("\0");
		} else changed = Object.keys(protectedBlobs(dir, tip, git));
		const held = changed.filter(file => file && isProtectedPath(file)).filter(file => {
			const pushed = blobAt(dir, tip, file, git);
			return pushed !== (state.snapshot[file] ?? "") && pushed !== (tips.base === undefined ? undefined : blobAt(dir, tips.base, file, git));
		});
		if (held.length > 0) return refused(`the push would change ${held.join(", ")}, which /ship never edits; leave that change to the user`);
	}
	return null;
}
