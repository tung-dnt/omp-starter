import * as fs from "node:fs";
import * as path from "node:path";
import { HOME } from "./state";

function git(cwd: string, args: string[]): string | undefined {
	const result = Bun.spawnSync({ cmd: ["git", "-C", cwd, ...args], stdout: "pipe", stderr: "ignore", timeout: 5000 });
	return result.exitCode === 0 ? result.stdout.toString().trim() || undefined : undefined;
}

/** Repo name from the origin URL (survives worktrees and suffixed clones), else the main checkout's folder. */
export function resolveRepoName(cwd: string): string | undefined {
	const origin = git(cwd, ["remote", "get-url", "origin"]);
	if (origin) {
		const name = origin.replace(/\/+$/, "").replace(/\.git$/, "").split(/[/:]/).pop();
		if (name) return name;
	}
	const commonDir = git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
	return commonDir ? path.basename(path.dirname(commonDir)) : undefined;
}

/** Work tree holding `p` (a file or folder, existing or not): its nearest ancestor below HOME with a `.git` entry. */
export function repoRoot(p: string): string | undefined {
	for (let dir = path.resolve(p); dir !== HOME && path.dirname(dir) !== dir; dir = path.dirname(dir)) {
		if (fs.existsSync(path.join(dir, ".git"))) return dir;
	}
	return undefined;
}

const BASE_REFS = ["origin/HEAD", "origin/main", "origin/master", "origin/develop", "origin/development"];

/** The commit the branch at `cwd` forked from: its merge base with the first base ref that exists. */
function mergeBase(cwd: string): string | undefined {
	for (const ref of BASE_REFS) {
		const base = git(cwd, ["merge-base", "HEAD", ref]);
		if (base) return base;
	}
	return undefined;
}

/** Uncommitted, untracked, and branch-vs-base changed paths, repo-root relative. */
export function changedFiles(cwd: string): string[] {
	const files = new Set<string>();
	const add = (out: string | undefined) => {
		for (const f of out ? out.split("\n") : []) if (f) files.add(f);
	};
	add(git(cwd, ["diff", "--name-only", "HEAD"]));
	add(git(cwd, ["ls-files", "--others", "--exclude-standard"]));
	const base = mergeBase(cwd);
	if (base) add(git(cwd, ["diff", "--name-only", `${base}...HEAD`]));
	return [...files];
}
