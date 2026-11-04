#!/usr/bin/env bun
// Checks one task commit: runs the plan's `test`, `typecheck` and `lint` commands in a temporary worktree at the commit, runs the guard
// over the task's commits, and writes the check note (`refs/notes/spec-checks`, local only) that `spec-status` reads.
//
//   bun scripts/spec-check.ts <sha> --repo <path> [--plan <vault-plan-path>] [--base <ref>] [--vault-git-dir <dir>]
//                             [--timeout <seconds>] [--json]
//
// The commit names its task (`Task:`) and plan (`Plan-Rev:`); the commands come from the `checks` of the task's repo in the plan at that
// `Plan-Rev`. `--timeout` bounds each command (default 900). Defaults for --plan, --base and --vault-git-dir come from the clone's
// `.git/spec-workflow.json`. Exit codes: 0 every check passed or was skipped and the guard found nothing, 1 a check or the guard
// failed (the note is written either way), 2 usage or IO error (no note is written).
import { DEFAULT_TIMEOUT_MS, type CheckReport, checkCommit } from "../extensions/lib/spec-check";
import { formatViolation } from "../extensions/lib/spec-guard";
import { UsageError, parseArgs, resolveContext } from "../extensions/lib/spec-cli";
import { errorMessage } from "../extensions/lib/tooling/runtime";

const USAGE =
	"Usage: bun scripts/spec-check.ts <sha> --repo <path> [--plan <vault-plan-path>] [--base <ref>] [--vault-git-dir <dir>] [--timeout <seconds>] [--json]";
const SHOWN_LINES = 20;

function render(report: CheckReport): string {
	const lines = [`spec-check ${report.sha.slice(0, 7)} ${report.task} attempt ${report.attempts}`];
	for (const result of report.results) {
		const detail = result.status === "fail" ? `  (${result.reason})` : result.status === "pass" ? `  (${(result.ms / 1000).toFixed(1)}s)` : "";
		lines.push(`  ${result.name.padEnd(9)} ${result.status}${detail}`);
		if (result.status === "fail") {
			const tail = result.output.trimEnd().split("\n").slice(-SHOWN_LINES);
			lines.push(...tail.map(line => `    | ${line}`));
		}
	}
	lines.push(`  ${"guard".padEnd(9)} ${report.note.checks.guard}`);
	lines.push(...report.violations.map(violation => `    ${formatViolation(violation)}`));
	lines.push(`note written on ${report.sha.slice(0, 7)}: ${report.ok ? "all checks passed" : "failing"}`);
	return lines.join("\n");
}

export async function main(argv: string[]): Promise<number> {
	let report: CheckReport;
	let json: boolean;
	try {
		const args = parseArgs(argv, { bool: ["json"], value: ["repo", "plan", "base", "vault-git-dir", "timeout"] });
		const [sha, ...extra] = args.positional;
		if (sha === undefined) throw new UsageError("missing <sha>");
		if (extra.length > 0) throw new UsageError(`unexpected argument ${extra[0]}`);
		const seconds = args.value("timeout");
		const timeoutMs = seconds === undefined ? DEFAULT_TIMEOUT_MS : Number(seconds) * 1000;
		if (!(timeoutMs > 0)) throw new UsageError(`--timeout must be a positive number of seconds, got ${seconds}`);
		json = args.bool("json");
		const context = resolveContext(args);
		report = await checkCommit(context.repo, sha, { planPath: context.plan, vaultGitDir: context.vaultGitDir, base: context.base, timeoutMs });
	} catch (error) {
		console.error(error instanceof UsageError ? `${error.message}\n${USAGE}` : errorMessage(error));
		return 2;
	}
	console.log(
		json
			? JSON.stringify({ ok: report.ok, sha: report.sha, task: report.task, attempts: report.attempts, checks: report.note.checks, results: report.results, violations: report.violations, note: report.note }, null, 2)
			: render(report),
	);
	return report.ok ? 0 : 1;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
