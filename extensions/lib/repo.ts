import * as path from "node:path";

function git(cwd: string, args: string[]): string | undefined {
	const result = Bun.spawnSync({ cmd: ["git", "-C", cwd, ...args], stdout: "pipe", stderr: "ignore", timeout: 2000 });
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
