#!/usr/bin/env bun
// Validates a spec-workflow `plan.md`: parses its `yaml plan` / `yaml task` blocks, routes risks and
// checks the plan rules against the files of the plan's git repos. Read-only: no network, no writes.
//
//   bun scripts/validate-plan.ts <plan.md> --repo <path>... [--json]
//
// --repo is repeatable; each clone serves the tasks whose `repo` equals the clone's origin `org/name`.
// A single --repo for a single-repo plan needs no origin.
// Exit codes: 0 valid, 1 invalid, 2 usage or IO error.
import * as fs from "node:fs";
import { cloneIdentities, listFiles, listFilesByRepo, repoIdentity } from "../extensions/lib/spec-git";
import { parsePlan } from "../extensions/lib/spec-plan";
import { type Violation, validatePlan } from "../extensions/lib/spec-validate";
import { errorMessage } from "../extensions/lib/tooling/runtime";

const USAGE = "Usage: bun scripts/validate-plan.ts <plan.md> --repo <path>... [--json]";

class UsageError extends Error {}

interface CliArgs {
	plan: string;
	repos: string[];
	json: boolean;
}

function parseArgs(argv: string[]): CliArgs {
	let plan: string | undefined;
	const repos: string[] = [];
	let json = false;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--json") json = true;
		else if (arg === "--repo") {
			const repo = argv[++i];
			if (repo === undefined) throw new UsageError("--repo needs a path");
			repos.push(repo);
		} else if (arg.startsWith("--")) throw new UsageError(`unknown option ${arg}`);
		else if (plan === undefined) plan = arg;
		else throw new UsageError(`unexpected argument ${arg}`);
	}
	if (plan === undefined) throw new UsageError("missing <plan.md>");
	if (repos.length === 0) throw new UsageError("missing --repo <path>");
	return { plan, repos, json };
}

function render(violations: Violation[]): string {
	if (violations.length === 0) return "valid";
	return violations.map(v => `${v.rule}${v.task === undefined ? "" : ` [${v.task}]`}: ${v.detail}`).join("\n");
}

/**
 * Tracked files per plan repo (`org/name`). Each clone serves the tasks whose `repo` equals its origin's `org/name`;
 * a lone clone without such an origin serves the plan's single repo.
 */
function filesByRepo(paths: readonly string[], planRepos: ReadonlySet<string>): Map<string, string[]> {
	if (paths.length === 1 && repoIdentity(paths[0]) === undefined) {
		const files = listFiles(paths[0]);
		if (planRepos.size > 1) throw new Error(`--repo ${paths[0]} has no org/name origin URL, so it cannot serve a plan with ${planRepos.size} repos`);
		return new Map([...planRepos].map(repo => [repo, files]));
	}
	return listFilesByRepo(cloneIdentities(paths));
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
	try {
		markdown = fs.readFileSync(args.plan, "utf8");
	} catch (error) {
		console.error(errorMessage(error));
		return 2;
	}
	const parsed = parsePlan(markdown);
	let files: Map<string, string[]>;
	try {
		files = filesByRepo(args.repos, new Set(parsed.ok ? parsed.plan.tasks.map(task => task.repo) : []));
	} catch (error) {
		console.error(errorMessage(error));
		return 2;
	}
	const violations = parsed.ok ? validatePlan(parsed.plan, files) : parsed.errors;
	const ok = violations.length === 0;
	console.log(args.json ? JSON.stringify({ ok, violations }, null, 2) : render(violations));
	return ok ? 0 : 1;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
