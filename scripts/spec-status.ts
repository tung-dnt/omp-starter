#!/usr/bin/env bun
// Computes the status of every task of a spec-workflow plan from git alone: commit trailers
// (`Task:`, `Task-Lock:`) and check notes (`refs/notes/spec-checks`) on the ticket branch.
// Read-only: it writes nothing and pushes nothing. The only network call is `gh pr list`, and only with --pr.
//
//   bun scripts/spec-status.ts <plan.md> --repo <path>... --branch <ticket> [--base <ref>] [--vault-git-dir <dir>] [--json] [--pr]
//
// --repo is repeatable; each clone serves the plan tasks whose `repo` equals the clone's origin `org/name`. A task that has no commit
// yet can still be blocked (a note on its task key); that note counts only under the plan's current revision in the vault, so the plan
// must lie inside the vault work tree of --vault-git-dir (default ~/.vault-git), else the notes are shown without that check.
// Exit codes: 0 status computed (whatever the states), 2 usage, IO or invalid-plan error.
import * as fs from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { DEFAULT_VAULT_GIT_DIR, planRevision } from "../extensions/lib/spec-diff";
import {
	type TaskCommit,
	cloneIdentities,
	defaultBase,
	listFilesByRepo,
	readCheckNote,
	readTaskCommits,
	readTaskNote,
	refExists,
} from "../extensions/lib/spec-git";
import { vaultRootOf } from "../extensions/lib/spec-ops";
import { parsePlan } from "../extensions/lib/spec-plan";
import { type StoryStatus, computeStatus, renderStatus } from "../extensions/lib/spec-status";
import { validatePlan } from "../extensions/lib/spec-validate";
import { errorMessage, isRecord } from "../extensions/lib/tooling/runtime";

const USAGE = "Usage: bun scripts/spec-status.ts <plan.md> --repo <path>... --branch <ticket> [--base <ref>] [--vault-git-dir <dir>] [--json] [--pr]";

class UsageError extends Error {}

interface CliArgs {
	plan: string;
	repos: string[];
	branch: string;
	base?: string;
	vaultGitDir: string;
	json: boolean;
	pr: boolean;
}

function parseArgs(argv: string[]): CliArgs {
	let plan: string | undefined;
	let branch: string | undefined;
	let base: string | undefined;
	let vaultGitDir = DEFAULT_VAULT_GIT_DIR;
	let json = false;
	let pr = false;
	const repos: string[] = [];
	const value = (flag: string, index: number): string => {
		const next = argv[index];
		if (next === undefined) throw new UsageError(`${flag} needs a value`);
		return next;
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--json") json = true;
		else if (arg === "--pr") pr = true;
		else if (arg === "--repo") repos.push(value(arg, ++i));
		else if (arg === "--branch") branch = value(arg, ++i);
		else if (arg === "--base") base = value(arg, ++i);
		else if (arg === "--vault-git-dir") vaultGitDir = resolve(value(arg, ++i));
		else if (arg.startsWith("--")) throw new UsageError(`unknown option ${arg}`);
		else if (plan === undefined) plan = arg;
		else throw new UsageError(`unexpected argument ${arg}`);
	}
	if (plan === undefined) throw new UsageError("missing <plan.md>");
	if (repos.length === 0) throw new UsageError("missing --repo <path>");
	if (branch === undefined) throw new UsageError("missing --branch <ticket>");
	return { plan, repos, branch, vaultGitDir, json, pr, ...(base === undefined ? {} : { base }) };
}

/** True when `gh` lists at least one merged PR for the branch; any failure is a warning and reads as not merged. */
function prMerged(repo: string, path: string, branch: string): boolean {
	try {
		const result = Bun.spawnSync({
			cmd: ["gh", "pr", "list", "--head", branch, "--state", "merged", "--json", "number"],
			cwd: path,
			stdout: "pipe",
			stderr: "pipe",
		});
		if (result.exitCode !== 0) {
			console.warn(`warning: gh pr list failed for ${repo} (${result.stderr.toString().trim() || `exit ${result.exitCode}`}); PR not counted as merged`);
			return false;
		}
		const listed: unknown = JSON.parse(result.stdout.toString());
		if (!Array.isArray(listed) || !listed.every(isRecord)) throw new Error("unexpected output");
		return listed.length > 0;
	} catch (error) {
		console.warn(`warning: could not check PRs for ${repo} (${errorMessage(error)}); PR not counted as merged`);
		return false;
	}
}

const NO_REVISION_CHECK = "note: blocked notes are shown without a plan-revision check";

/** The plan's revision in the vault, or undefined (with the reason to tell the user) when the plan is not a committed file of the vault. */
function revisionOf(planFile: string, vaultGitDir: string): string | undefined {
	const planPath = relative(vaultRootOf(vaultGitDir), resolve(planFile));
	if (planPath === "" || planPath.startsWith("..") || isAbsolute(planPath)) return undefined;
	return planRevision(vaultGitDir, planPath) || undefined;
}

function run(args: CliArgs): { status: StoryStatus; notes: string[] } {
	const markdown = fs.readFileSync(args.plan, "utf8");
	const clones = cloneIdentities(args.repos);
	const parsed = parsePlan(markdown);
	const violations = parsed.ok ? validatePlan(parsed.plan, listFilesByRepo(clones)) : parsed.errors;
	if (!parsed.ok || violations.length > 0) {
		const lines = violations.map(v => `${v.rule}${v.task === undefined ? "" : ` [${v.task}]`}: ${v.detail}`);
		throw new Error(`the plan is invalid:\n${lines.join("\n")}`);
	}
	const { plan } = parsed;

	const pathOf = (repo: string): string => {
		const path = clones.get(repo);
		if (path === undefined) throw new Error(`no --repo clone has origin ${repo}`);
		return path;
	};
	const commitsByRepo = new Map<string, TaskCommit[]>();
	for (const repo of new Set(plan.tasks.map(task => task.repo))) {
		const path = pathOf(repo);
		if (!refExists(path, args.branch)) {
			console.warn(`warning: branch ${args.branch} does not exist in ${repo}; its tasks have no commits`);
			commitsByRepo.set(repo, []);
			continue;
		}
		commitsByRepo.set(repo, readTaskCommits(path, args.base ?? defaultBase(path), args.branch));
	}

	const taskIds = new Set(plan.tasks.map(task => task.id));
	for (const [repo, commits] of commitsByRepo) {
		for (const commit of commits) {
			const unknown = commit.tasks.filter(id => !taskIds.has(id));
			if (unknown.length > 0) console.warn(`warning: commit ${commit.sha} in ${repo} has Task: ${unknown.join(", ")}, not in the plan; ignored`);
		}
	}

	const prs = args.pr ? new Map([...commitsByRepo.keys()].map(repo => [repo, prMerged(repo, pathOf(repo), args.branch)])) : undefined;
	const notes = (repo: string, sha: string) => readCheckNote(pathOf(repo), sha);
	const planRev = revisionOf(args.plan, args.vaultGitDir);
	const status = computeStatus(plan, commitsByRepo, notes, prs, {
		taskNote: (repo, id) => readTaskNote(pathOf(repo), plan.id, id),
		...(planRev === undefined ? {} : { planRev }),
	});
	return { status, notes: planRev === undefined ? [NO_REVISION_CHECK] : [] };
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
	let result: { status: StoryStatus; notes: string[] };
	try {
		result = run(args);
	} catch (error) {
		console.error(errorMessage(error));
		return 2;
	}
	// JSON output stays one document on stdout; a note then goes to stderr.
	if (args.json) {
		console.log(JSON.stringify(result.status, null, 2));
		for (const note of result.notes) console.error(note);
	} else {
		console.log([renderStatus(result.status), ...result.notes].join("\n"));
	}
	return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
