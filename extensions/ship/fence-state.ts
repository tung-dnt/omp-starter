// The /ship fence, part 2: its state and what a push carries.
//
// The state is one file per omp process, named by OMP_SHIP_FENCE. The extension creates it and puts bin/ship-fence
// first on PATH when it loads, before omp captures the environment its shells start from, so a later arm or disarm only
// rewrites the file: no shell needs a new environment. The shims read `"armed"` from it on every gh and git call.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isProtectedPath, type PushPolicy, refused } from "./fence";

export const FENCE_ENV = "OMP_SHIP_FENCE";
export const SHIM_DIR = path.resolve(import.meta.dir, "..", "..", "bin", "ship-fence");
/** The fence's own source, which a fenced session may not change. */
export const FENCE_SOURCE = import.meta.dir;
export const stateDir = (): string => path.join(os.homedir(), ".omp", "agent", "ship", "fence");

export interface FenceState extends PushPolicy {
	armed: boolean;
	/** The checkout /ship works in, and its git folders (a linked worktree's hooks live in the main repo's). */
	root: string | null;
	gitDirs: string[];
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

/** git found on PATH past the shims, so the fence's own reads don't go through it. */
export const realGit: Git = (dir, ...args) => {
	const git = Bun.which("git", { PATH: pathEntries().join(path.delimiter) }) ?? "git";
	const p = Bun.spawnSync([git, "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
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
 * Why a push that the argv checks allowed still can't go: it carries a change to a protected file that is neither how
 * the branch held it when /ship armed nor how the base holds it now (what merging the base brings is fine).
 */
export function checkPushContent(dir: string, sources: string[], state: FenceState, git: Git = realGit): string | null {
	const base = "refs/remotes/origin/HEAD";
	for (const src of sources) {
		const tip = git(dir, "rev-parse", "--verify", "--quiet", `${src}^{commit}`).out.trim();
		if (!tip) return refused(`can't read what ${src} would push`);
		const remote = git(dir, "rev-parse", "--verify", "--quiet", `refs/remotes/origin/${state.pushBranch}`).out.trim();
		const from = remote || git(dir, "merge-base", tip, base).out.trim();
		const changed = from ? git(dir, "diff", "--name-only", "-z", from, tip).out.split("\0") : Object.keys(protectedBlobs(dir, tip, git));
		const held = changed.filter(file => file && isProtectedPath(file)).filter(file => {
			const pushed = blobAt(dir, tip, file, git);
			return pushed !== (state.snapshot[file] ?? "") && pushed !== blobAt(dir, base, file, git);
		});
		if (held.length > 0) return refused(`the push would change ${held.join(", ")}, which /ship never edits; leave that change to the user`);
	}
	return null;
}
