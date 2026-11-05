// Shared pieces of the three spec CLIs (`spec-guard`, `spec-check`, `spec-hook`): option parsing, and the per-clone
// workflow config that `spec-hook install` saves in the repo's git dir so the hook can find its plan and base.
import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_VAULT_GIT_DIR } from "./spec-diff";
import { defaultBase, gitOrThrow, refExists } from "./spec-git";
import { errorMessage, isRecord } from "./tooling/runtime";

/** Bad command-line arguments; the CLI prints it with the usage line and exits 2. */
export class UsageError extends Error {}

export interface FlagSpec {
	/** Flags without a value (`--json`). */
	bool?: readonly string[];
	/** Flags that take one value (`--repo <path>`); the last one wins. */
	value?: readonly string[];
	/** Flags that take a value and may repeat. */
	list?: readonly string[];
}

export interface Args {
	positional: string[];
	bool(name: string): boolean;
	value(name: string): string | undefined;
	list(name: string): string[];
}

/** Parses `--name` flags per `spec`; everything else is positional. Throws `UsageError` for an unknown flag or a missing value. */
export function parseArgs(argv: readonly string[], spec: FlagSpec): Args {
	const bools = new Set<string>();
	const values = new Map<string, string>();
	const lists = new Map<string, string[]>();
	const positional: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (!arg.startsWith("--")) {
			positional.push(arg);
			continue;
		}
		const name = arg.slice(2);
		if (spec.bool?.includes(name)) {
			bools.add(name);
			continue;
		}
		const repeats = spec.list?.includes(name) === true;
		if (!repeats && !spec.value?.includes(name)) throw new UsageError(`unknown option ${arg}`);
		const next = argv[++i];
		if (next === undefined) throw new UsageError(`${arg} needs a value`);
		if (repeats) lists.set(name, [...(lists.get(name) ?? []), next]);
		else values.set(name, next);
	}
	return { positional, bool: name => bools.has(name), value: name => values.get(name), list: name => lists.get(name) ?? [] };
}

/** What `spec-hook install` saves for the hook: the plan's path in the vault repo, the base ref, and a non-default vault git dir. */
export interface WorkflowConfig {
	plan: string;
	base: string;
	vaultGitDir?: string;
}

const CONFIG_FILE = "spec-workflow.json";

/** The line that marks the `pre-push` hook as the one `spec-hook install` wrote; a hook without it is foreign (or forged). */
export const MARKER = "# managed-by: omp-starter spec-hook";

/**
 * The bun executable that runs the spec scripts and the pre-push hook. Inside omp `process.execPath` is the `omp` binary, which
 * does not take a script path and rejects the hook's flags, so it is used only when it is bun itself; otherwise bun comes from PATH.
 * Throws when neither is available.
 */
export function resolveBun(execPath: string = process.execPath, which: (name: string) => string | null = name => Bun.which(name)): string {
	if (path.basename(execPath).toLowerCase().replace(/\.exe$/, "") === "bun") return execPath;
	const found = which("bun");
	if (found === null) throw new Error(`bun was not found on PATH (the running executable is ${execPath}, not bun); the spec scripts and the pre-push hook need bun`);
	return path.resolve(found);
}

/** The git dir shared by every worktree of the clone (`.git`), as an absolute path. Throws when `repo` is not a git repo. */
export function gitCommonDir(repo: string): string {
	return path.resolve(repo, gitOrThrow(repo, ["rev-parse", "--git-common-dir"]).trim());
}

export function readWorkflowConfig(repo: string): WorkflowConfig | undefined {
	const file = path.join(gitCommonDir(repo), CONFIG_FILE);
	if (!fs.existsSync(file)) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(file, "utf8"));
	} catch (error) {
		throw new Error(`${file} is not valid JSON: ${errorMessage(error)}`);
	}
	if (!isRecord(parsed) || typeof parsed.plan !== "string" || typeof parsed.base !== "string" || (parsed.vaultGitDir !== undefined && typeof parsed.vaultGitDir !== "string")) {
		throw new Error(`${file} must hold {"plan": string, "base": string} and optionally "vaultGitDir": string`);
	}
	return { plan: parsed.plan, base: parsed.base, ...(parsed.vaultGitDir === undefined ? {} : { vaultGitDir: parsed.vaultGitDir }) };
}

export function writeWorkflowConfig(repo: string, config: WorkflowConfig): void {
	fs.writeFileSync(path.join(gitCommonDir(repo), CONFIG_FILE), `${JSON.stringify(config, null, 2)}\n`);
}

export function removeWorkflowConfig(repo: string): void {
	fs.rmSync(path.join(gitCommonDir(repo), CONFIG_FILE), { force: true });
}

/** An absolute path cannot be a vault path: `git show <rev>:<path>` takes the path inside the vault repo. */
export function assertVaultPath(plan: string): string {
	if (path.isAbsolute(plan)) {
		throw new UsageError(`--plan is the plan's path inside the vault repo (for example Specs/PAC2/stories/PAC2-1234/plan.md), not a file path: ${plan}`);
	}
	return plan;
}

export interface Context {
	/** Absolute path of the clone. */
	repo: string;
	/** The plan's path inside the vault repo. */
	plan: string;
	base: string;
	vaultGitDir: string;
}

/**
 * The repo, plan path, base and vault git dir of a `spec-guard` or `spec-check` run. Each comes from its flag, else from the
 * clone's saved workflow config, else from its default (base: `origin/HEAD`, else `main`; vault: `~/.vault-git`). The plan has no default.
 * Throws `UsageError` for a missing `--repo` or plan, and an error when `repo` is not a git repo or the base is not a commit.
 */
export function resolveContext(args: Args): Context {
	const repoArg = args.value("repo");
	if (repoArg === undefined) throw new UsageError("missing --repo <path>");
	const repo = path.resolve(repoArg);
	const config = readWorkflowConfig(repo);
	const plan = args.value("plan") ?? config?.plan;
	if (plan === undefined) throw new UsageError("missing --plan <vault-plan-path> (or install the hook, which saves it)");
	const base = args.value("base") ?? config?.base ?? defaultBase(repo);
	if (!refExists(repo, base)) throw new Error(`base ${base} is not a commit in ${repo}; pass --base`);
	return { repo, plan: assertVaultPath(plan), base, vaultGitDir: args.value("vault-git-dir") ?? config?.vaultGitDir ?? DEFAULT_VAULT_GIT_DIR };
}
