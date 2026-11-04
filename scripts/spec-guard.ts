#!/usr/bin/env bun
// Checks a range of commits against the plan each commit pins with its `Plan-Rev:` trailer: scope, locked tests, skipped or focused
// tests, suppressions, protected configs, and a valid plan (see the README, "Guard and checks"). Read-only: it writes nothing and pushes nothing.
//
//   bun scripts/spec-guard.ts --repo <path> [--plan <vault-plan-path>] [--range <from>..<to>] [--base <ref>]
//                             [--vault-git-dir <dir>] [--strict] [--json]
//
// The plan is read from the vault git dir at each commit's `Plan-Rev`, never from the vault work tree; `--plan` is its path inside the
// vault repo. Defaults come from the clone's `.git/spec-workflow.json` (saved by `spec-hook install`). `--range` defaults to
// `<base>..HEAD`; an empty `<from>` means the base and an empty `<to>` means HEAD. `--strict` also rejects commits without `Task:`.
// Exit codes: 0 no violations, 1 violations, 2 usage or IO error.
import { loadGuardInput } from "../extensions/lib/spec-diff";
import { type GuardViolation, formatViolation, guardCommits } from "../extensions/lib/spec-guard";
import { UsageError, parseArgs, resolveContext } from "../extensions/lib/spec-cli";
import { errorMessage } from "../extensions/lib/tooling/runtime";

const USAGE =
	"Usage: bun scripts/spec-guard.ts --repo <path> [--plan <vault-plan-path>] [--range <from>..<to>] [--base <ref>] [--vault-git-dir <dir>] [--strict] [--json]";

/** `<from>..<to>`; an empty side means the base and HEAD. */
function parseRange(spec: string | undefined, base: string): { from: string; to: string } {
	if (spec === undefined) return { from: base, to: "HEAD" };
	const parts = spec.split("..");
	if (parts.length !== 2 || spec.includes("...")) throw new UsageError(`--range must look like <from>..<to>, got ${spec}`);
	return { from: parts[0] || base, to: parts[1] || "HEAD" };
}

function render(violations: GuardViolation[], commits: number): string {
	if (violations.length === 0) return `ok: ${commits} ${commits === 1 ? "commit" : "commits"} checked, no violations`;
	const bad = new Set(violations.map(v => v.sha)).size;
	return [...violations.map(formatViolation), `${violations.length} ${violations.length === 1 ? "violation" : "violations"} in ${bad} of ${commits} commits`].join("\n");
}

export function main(argv: string[]): number {
	let output: { text: string; json: unknown; ok: boolean };
	let json: boolean;
	try {
		const args = parseArgs(argv, { bool: ["strict", "json"], value: ["repo", "plan", "range", "base", "vault-git-dir"] });
		if (args.positional.length > 0) throw new UsageError(`unexpected argument ${args.positional[0]}`);
		json = args.bool("json");
		const context = resolveContext(args);
		const range = parseRange(args.value("range"), context.base);
		const input = loadGuardInput({ repo: context.repo, ...range, vaultGitDir: context.vaultGitDir, planPath: context.plan }, args.bool("strict"));
		const violations = guardCommits(input);
		output = { text: render(violations, input.commits.length), json: { ok: violations.length === 0, commits: input.commits.length, violations }, ok: violations.length === 0 };
	} catch (error) {
		console.error(error instanceof UsageError ? `${error.message}\n${USAGE}` : errorMessage(error));
		return 2;
	}
	console.log(json ? JSON.stringify(output.json, null, 2) : output.text);
	return output.ok ? 0 : 1;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
