#!/usr/bin/env bun
// Installs or removes the clone-local `pre-push` hook that runs spec-guard on every ref a push would update. The hook lives in the clone's
// git dir (`.git/hooks/pre-push`) next to `.git/spec-workflow.json` ({plan, base, vaultGitDir?}); nothing is committed and the repo
// config is untouched. A push can still skip it with `--no-verify`.
//
//   bun scripts/spec-hook.ts install --repo <path> --plan <vault-plan-path> [--base <ref>] [--vault-git-dir <dir>] [--chain]
//   bun scripts/spec-hook.ts uninstall --repo <path>
//
// `install` refuses (exit 2) to replace a `pre-push` that does not carry the hook's marker, and to run when `core.hooksPath` is set (git
// would never call `.git/hooks`); with `--chain` the existing hook is renamed `pre-push.local` and runs first. `uninstall` removes only
// the marked hook and its config, and puts a chained hook back. Exit codes: 0 done, 2 usage error, IO error or refusal.
import * as fs from "node:fs";
import * as path from "node:path";
import { type Args, UsageError, assertVaultPath, gitCommonDir, parseArgs, removeWorkflowConfig, writeWorkflowConfig } from "../extensions/lib/spec-cli";
import { defaultBase, git, refExists } from "../extensions/lib/spec-git";
import { errorMessage } from "../extensions/lib/tooling/runtime";

const USAGE = [
	"Usage: bun scripts/spec-hook.ts install --repo <path> --plan <vault-plan-path> [--base <ref>] [--vault-git-dir <dir>] [--chain]",
	"       bun scripts/spec-hook.ts uninstall --repo <path>",
].join("\n");

const MARKER = "# managed-by: omp-starter spec-hook";
const CHAIN_MARKER = "# chained-hook: pre-push.local";
const GUARD = path.resolve(import.meta.dir, "spec-guard.ts");

const quote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * The hook: reads git's `<local ref> <local sha> <remote ref> <remote sha>` lines and runs spec-guard in strict mode over
 * `<remote sha>..<local sha>` for each, or over `<base>..<local sha>` for a new ref (an empty `<from>`). A deleted ref is skipped.
 * With `chained` it first feeds the same input to `pre-push.local`.
 */
function hookScript(bun: string, chained: boolean): string {
	return [
		"#!/bin/sh",
		MARKER,
		"# Runs spec-guard on the commits a push would add. Remove it with: bun scripts/spec-hook.ts uninstall --repo <path>",
		"input=$(cat)",
		...(chained ? [CHAIN_MARKER, 'chained="$(dirname "$0")/pre-push.local"', `if [ -x "$chained" ]; then printf '%s\\n' "$input" | "$chained" "$@" || exit $?; fi`] : []),
		"status=0",
		"while read -r local_ref local_sha remote_ref remote_sha; do",
		'\tcase "$local_sha" in *[!0]*) ;; *) continue ;; esac',
		'\tcase "$remote_sha" in *[!0]*) range="$remote_sha..$local_sha" ;; *) range="..$local_sha" ;; esac',
		`\t${quote(bun)} ${quote(GUARD)} --strict --repo "$PWD" --range "$range" </dev/null || status=1`,
		"done <<EOF",
		"$input",
		"EOF",
		"exit $status",
		"",
	].join("\n");
}

function install(args: Args): string {
	const repoArg = args.value("repo");
	if (repoArg === undefined) throw new UsageError("missing --repo <path>");
	const planArg = args.value("plan");
	if (planArg === undefined) throw new UsageError("missing --plan <vault-plan-path>");
	const plan = assertVaultPath(planArg);
	const repo = path.resolve(repoArg);
	const hooks = path.join(gitCommonDir(repo), "hooks");

	const hooksPath = git(repo, ["config", "--get", "core.hooksPath"]);
	if (hooksPath.ok && hooksPath.stdout.trim() !== "") {
		throw new Error(`core.hooksPath is set to ${hooksPath.stdout.trim()}, so git would not run .git/hooks/pre-push; unset it or put the hook there by hand`);
	}
	const base = args.value("base") ?? defaultBase(repo);
	if (!refExists(repo, base)) throw new Error(`base ${base} is not a commit in ${repo}; pass --base`);

	const hook = path.join(hooks, "pre-push");
	const chainedFile = path.join(hooks, "pre-push.local");
	const existing = fs.existsSync(hook) ? fs.readFileSync(hook, "utf8") : undefined;
	const foreign = existing !== undefined && !existing.includes(MARKER);
	let chained = existing !== undefined && !foreign && existing.includes(CHAIN_MARKER);
	if (foreign) {
		if (!args.bool("chain")) {
			throw new Error(`${hook} already exists and is not managed by spec-hook; run again with --chain to keep it (it is renamed to pre-push.local and runs first)`);
		}
		if (fs.existsSync(chainedFile)) throw new Error(`${chainedFile} already exists; move it away, then run again`);
		chained = true;
	}

	const vaultGitDir = args.value("vault-git-dir");
	writeWorkflowConfig(repo, { plan, base, ...(vaultGitDir === undefined ? {} : { vaultGitDir: path.resolve(vaultGitDir) }) });
	fs.mkdirSync(hooks, { recursive: true });
	if (foreign) fs.renameSync(hook, chainedFile);
	try {
		fs.writeFileSync(hook, hookScript(process.execPath, chained), { mode: 0o755 });
		fs.chmodSync(hook, 0o755);
	} catch (error) {
		if (foreign) fs.renameSync(chainedFile, hook);
		throw error;
	}
	return `installed ${hook} (plan ${plan}, base ${base})${chained ? `; the previous hook runs first as ${chainedFile}` : ""}`;
}

function uninstall(args: Args): string {
	const repoArg = args.value("repo");
	if (repoArg === undefined) throw new UsageError("missing --repo <path>");
	const repo = path.resolve(repoArg);
	const hooks = path.join(gitCommonDir(repo), "hooks");
	const hook = path.join(hooks, "pre-push");
	const chainedFile = path.join(hooks, "pre-push.local");
	if (!fs.existsSync(hook)) return `no pre-push hook in ${repo}; nothing to remove`;
	const text = fs.readFileSync(hook, "utf8");
	if (!text.includes(MARKER)) return `${hook} is not managed by spec-hook; left alone`;
	fs.rmSync(hook);
	removeWorkflowConfig(repo);
	if (text.includes(CHAIN_MARKER) && fs.existsSync(chainedFile)) {
		fs.renameSync(chainedFile, hook);
		return `removed the spec-workflow hook and restored the previous pre-push hook`;
	}
	return `removed ${hook}`;
}

export function main(argv: string[]): number {
	let message: string;
	try {
		const args = parseArgs(argv, { bool: ["chain"], value: ["repo", "plan", "base", "vault-git-dir"] });
		const [command, ...extra] = args.positional;
		if (command !== "install" && command !== "uninstall") throw new UsageError(command === undefined ? "missing command (install or uninstall)" : `unknown command ${command}`);
		if (extra.length > 0) throw new UsageError(`unexpected argument ${extra[0]}`);
		message = command === "install" ? install(args) : uninstall(args);
	} catch (error) {
		console.error(error instanceof UsageError ? `${error.message}\n${USAGE}` : errorMessage(error));
		return 2;
	}
	console.log(message);
	return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
