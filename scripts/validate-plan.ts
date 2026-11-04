#!/usr/bin/env bun
// Validates a spec-workflow `plan.md`: parses its `yaml plan` / `yaml task` blocks, routes risks and
// checks the plan rules against the files of a git repo. Read-only: no network, no writes.
//
//   bun scripts/validate-plan.ts <plan.md> --repo <path> [--json]
//
// Exit codes: 0 valid, 1 invalid, 2 usage or IO error.
import * as fs from "node:fs";
import { parsePlan } from "../extensions/lib/spec-plan";
import { type Violation, validatePlan } from "../extensions/lib/spec-validate";
import { errorMessage } from "../extensions/lib/tooling/runtime";

const USAGE = "Usage: bun scripts/validate-plan.ts <plan.md> --repo <path> [--json]";

class UsageError extends Error {}

interface CliArgs {
	plan: string;
	repo: string;
	json: boolean;
}

function parseArgs(argv: string[]): CliArgs {
	let plan: string | undefined;
	let repo: string | undefined;
	let json = false;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--json") json = true;
		else if (arg === "--repo") {
			repo = argv[++i];
			if (repo === undefined) throw new UsageError("--repo needs a path");
		} else if (arg.startsWith("--")) throw new UsageError(`unknown option ${arg}`);
		else if (plan === undefined) plan = arg;
		else throw new UsageError(`unexpected argument ${arg}`);
	}
	if (plan === undefined) throw new UsageError("missing <plan.md>");
	if (repo === undefined) throw new UsageError("missing --repo <path>");
	return { plan, repo, json };
}

/** Tracked files of the work tree at `repo`, relative to its root. */
function gitFiles(repo: string): string[] {
	const result = Bun.spawnSync({ cmd: ["git", "-C", repo, "ls-files", "-z"], stdout: "pipe", stderr: "pipe" });
	if (result.exitCode !== 0) {
		throw new Error(`${repo} is not a git work tree: ${result.stderr.toString().trim() || `git exited ${result.exitCode}`}`);
	}
	return result.stdout.toString().split("\0").filter(Boolean);
}

function render(violations: Violation[]): string {
	if (violations.length === 0) return "valid";
	return violations.map(v => `${v.rule}${v.task === undefined ? "" : ` [${v.task}]`}: ${v.detail}`).join("\n");
}

export function main(argv: string[]): number {
	let args: CliArgs;
	try {
		args = parseArgs(argv);
	} catch (error) {
		if (!(error instanceof UsageError)) throw error;
		console.error(`${error.message}\n${USAGE}`);
		return 2;
	}
	let markdown: string;
	let files: string[];
	try {
		markdown = fs.readFileSync(args.plan, "utf8");
		files = gitFiles(args.repo);
	} catch (error) {
		console.error(errorMessage(error));
		return 2;
	}
	const parsed = parsePlan(markdown);
	const violations = parsed.ok ? validatePlan(parsed.plan, files) : parsed.errors;
	const ok = violations.length === 0;
	console.log(args.json ? JSON.stringify({ ok, violations }, null, 2) : render(violations));
	return ok ? 0 : 1;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
