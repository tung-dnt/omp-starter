// Shared fixtures for the spec guard tests: scratch folders under the private test HOME, temp git repos, a temp vault
// git repo that holds plans, and plan text. Nothing here touches a real repo or the real vault.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { RISK_FIELDS } from "./spec-risk";

const dirs: string[] = [];

/** Removes every scratch folder made since the last call; use it from `afterEach`. */
export function cleanScratch(): void {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/** A fresh scratch folder under the private test HOME (see extensions/test-preload.ts). */
export function scratch(prefix = "spec-"): string {
	const home = process.env.OMP_STARTER_TEST_HOME;
	if (!home) throw new Error("OMP_STARTER_TEST_HOME is not set; the test preload did not run");
	const dir = mkdtempSync(join(home, prefix));
	dirs.push(dir);
	return dir;
}

/** Runs git in `repo` with an explicit identity and no signing; returns trimmed stdout and throws with git's message on failure. */
export function git(repo: string, ...args: string[]): string {
	const result = Bun.spawnSync({
		cmd: ["git", "-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args],
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
	return result.stdout.toString().trim();
}

/** Writes `files` (relative paths) into `repo`; a `null` content deletes the file. */
export function writeFiles(repo: string, files: Record<string, string | null>): void {
	for (const [rel, content] of Object.entries(files)) {
		const file = join(repo, rel);
		if (content === null) {
			rmSync(file, { force: true });
			continue;
		}
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, content);
	}
}

/** A repo on `main` with `src/a.ts` and `src/b.ts` committed as `base`, a local identity and, when given, an `origin` URL. */
export function initRepo(origin?: string): string {
	const repo = join(scratch(), "repo");
	mkdirSync(repo, { recursive: true });
	git(repo, "init", "-q", "-b", "main");
	git(repo, "config", "user.name", "Test");
	git(repo, "config", "user.email", "test@example.com");
	writeFiles(repo, { "src/a.ts": "export const a = 1;\n", "src/b.ts": "export const b = 1;\n" });
	git(repo, "add", "-A");
	git(repo, "commit", "-q", "-m", "base");
	if (origin !== undefined) git(repo, "remote", "add", "origin", origin);
	return repo;
}

/** An empty commit whose last paragraph holds the given trailer lines; returns its sha. */
export function commit(repo: string, subject: string, ...trailers: string[]): string {
	git(repo, "commit", "-q", "--allow-empty", "-m", subject, ...(trailers.length > 0 ? ["-m", trailers.join("\n")] : []));
	return git(repo, "rev-parse", "HEAD");
}

/** Writes `files` (a `null` deletes), stages everything and commits with the given trailer lines; returns the sha. */
export function commitFiles(repo: string, files: Record<string, string | null>, subject: string, ...trailers: string[]): string {
	writeFiles(repo, files);
	git(repo, "add", "-A");
	git(repo, "commit", "-q", "-m", subject, ...(trailers.length > 0 ? ["-m", trailers.join("\n")] : []));
	return git(repo, "rev-parse", "HEAD");
}

export interface Vault {
	root: string;
	/** The git dir to pass as the vault git dir. */
	gitDir: string;
	/** Commits `text` at `path` (relative to the vault root) and returns the vault commit sha. */
	commitPlan(path: string, text: string): string;
}

/** A temp vault: a git repo whose commits hold plans. */
export function initVault(): Vault {
	const root = join(scratch("spec-vault-"), "vault");
	mkdirSync(root, { recursive: true });
	git(root, "init", "-q", "-b", "main");
	return {
		root,
		gitDir: join(root, ".git"),
		commitPlan(path, text) {
			writeFiles(root, { [path]: text });
			git(root, "add", "-A");
			git(root, "commit", "-q", "-m", `plan ${path}`);
			return git(root, "rev-parse", "HEAD");
		},
	};
}

export interface PlanTask {
	id: string;
	owns?: string[];
	new_paths?: string[];
	depends_on?: string[];
	repo?: string;
}

export interface PlanOptions {
	tasks: PlanTask[];
	id?: string;
	/** Check commands by repo; the default declares `test: "true"` for `org/backend`. */
	checks?: Record<string, Record<string, string>>;
}

const FENCE = "`".repeat(3);
const list = (items: readonly string[]): string => `[${items.map(item => JSON.stringify(item)).join(", ")}]`;

/** A valid `plan.md` (every risk `no`) for the given tasks; tasks default to repo `org/backend`. */
export function planText(options: PlanOptions): string {
	const checks = options.checks ?? { "org/backend": { test: "true" } };
	const header = [`${FENCE}yaml plan`, `id: ${options.id ?? "S-1"}`, "kind: story", "shared_paths: []", "checks:"];
	for (const [repo, commands] of Object.entries(checks)) {
		header.push(`  ${repo}:`);
		for (const [name, command] of Object.entries(commands)) header.push(`    ${name}: ${JSON.stringify(command)}`);
	}
	const blocks = options.tasks.map(task =>
		[
			`${FENCE}yaml task`,
			`id: ${task.id}`,
			`repo: ${task.repo ?? "org/backend"}`,
			`depends_on: ${list(task.depends_on ?? [])}`,
			"foundation: false",
			`owns: ${list(task.owns ?? [])}`,
			`new_paths: ${list(task.new_paths ?? [])}`,
			"reads: []",
			"risk:",
			...RISK_FIELDS.map(field => `  ${field}: {value: no}`),
			"lld_required: false",
			"security_review: false",
			"required_tests: []",
			'acceptance: ["works"]',
			FENCE,
		].join("\n"),
	);
	return [[...header, FENCE].join("\n"), ...blocks].join("\n\n") + "\n";
}

/** A tiny test runner: every `t/*.sh` is a test and passes when it exits zero. */
const TEST = 'for f in t/*.sh; do [ -e "$f" ] || continue; sh "$f" || exit 1; done';

/** Check commands for the story fixture: the runner above, a typecheck that fails on any `TYPEERR` under `src`, and no lint. */
export const CHECKS: Record<string, string> = { test: TEST, test_files: "sh {files}", typecheck: "! grep -rq TYPEERR src", lint: "" };

export const PLAN_PATH = "Specs/S/plan.md";

/**
 * An `org/backend` clone on branch PAC-1 (base `main`), a vault holding the plan's first revision, and helpers. The plan has T1 (owns `src/**`,
 * may create `t/`) and T2 (depends on T1, owns `src/b.ts`); `text(commands, t1Owns)` renders another revision of it.
 */
export function storyWorld(checks: Record<string, string> = CHECKS) {
	const repo = initRepo("git@github.com:org/backend.git");
	const vault = initVault();
	const text = (commands: Record<string, string>, t1Owns = ["src/**"]) =>
		planText({ tasks: [{ id: "T1", owns: t1Owns, new_paths: ["t/"] }, { id: "T2", depends_on: ["T1"], owns: ["src/b.ts"] }], checks: { "org/backend": commands } });
	const rev = vault.commitPlan(PLAN_PATH, text(checks));
	git(repo, "checkout", "-q", "-b", "PAC-1");
	const options = { planPath: PLAN_PATH, vaultGitDir: vault.gitDir, base: "main" };
	/** Commits `files` as work of `task` against plan revision `planRev`. */
	const work = (files: Record<string, string | null>, subject = "work", task = "T1", planRev = rev) =>
		commitFiles(repo, files, subject, `Task: ${task}`, `Plan-Rev: ${planRev}`);
	return { repo, vault, rev, text, options, work };
}
