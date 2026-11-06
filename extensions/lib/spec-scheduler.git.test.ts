import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { loadGuardInput } from "./spec-diff";
import { CHECKS, PLAN_PATH, type Vault, cleanScratch, git, initRepo, initVault, planText, scratch } from "./spec-fixtures";
import { readCheckNote, readTaskCommits } from "./spec-git";
import { guardCommits } from "./spec-guard";
import { parsePlan } from "./spec-plan";
import { type OpsConfig, realCheckOps, realGitOps } from "./spec-ops";
import { type RunLog, fileRunLog } from "./spec-runlog";
import { type Gate, type GateAnswer, type GateRequest, type RunOptions, type RunSummary, runPlan, statusFromGit } from "./spec-scheduler";
import type { SlotResult, SlotRunner, SlotSpec } from "./spec-slots";
import { renderStatus } from "./spec-status";

afterEach(cleanScratch);

const REPO = "org/backend";
const STORY = "S-1";

/** Per task: the test (it fails until the implementation exists) and the implementation. */
const TESTS: Record<string, [string, string]> = {
	T1: ["t/t1.sh", "grep -q 'a = 2' src/a.ts\n"],
	T2: ["t/t2.sh", "grep -q 'b = 2' src/b.ts\n"],
	T3: ["t/t3.sh", "grep -q 'b = 2' src/b.ts\n"],
};
const SOURCES: Record<string, [string, string]> = {
	T1: ["src/a.ts", "export const a = 2;\n"],
	T2: ["src/b.ts", "export const b = 2;\n"],
	T3: ["src/b.ts", "export const b = 2;\n"],
};

function write(cwd: string, file: string, text: string): void {
	mkdirSync(dirname(join(cwd, file)), { recursive: true });
	writeFileSync(join(cwd, file), text);
}

const pass = (payload: object): SlotResult => ({ payload, costUsd: 0.001, contextTokens: 500 });

/** A worker that writes real files into the worktree it is given; a handler may misbehave first and return undefined to fall through to the honest run. */
class FileWorker implements SlotRunner {
	calls: SlotSpec[] = [];
	handlers = new Map<string, Array<(spec: SlotSpec) => SlotResult | undefined>>();
	on(key: string, ...handlers: Array<(spec: SlotSpec) => SlotResult | undefined>): this {
		this.handlers.set(key, [...(this.handlers.get(key) ?? []), ...handlers]);
		return this;
	}
	async run(spec: SlotSpec): Promise<SlotResult> {
		this.calls.push(spec);
		const custom = this.handlers.get(`${spec.task.id}:${spec.slot}`)?.shift()?.(spec);
		if (custom !== undefined) return custom;
		const [testFile, testText] = TESTS[spec.task.id] ?? ["", ""];
		switch (spec.slot) {
			case "test_author":
				write(spec.cwd, testFile, testText);
				return pass({ verdict: "pass", tests: [testFile], acceptance_map: { works: testFile }, notes: "" });
			case "implementer": {
				if (spec.lockedFiles.length === 0) write(spec.cwd, testFile, testText);
				else write(spec.cwd, SOURCES[spec.task.id][0], SOURCES[spec.task.id][1]);
				return pass({ verdict: "pass", notes: "done", checks_run: ["sh t/*.sh"] });
			}
			case "test_review":
				return pass({ verdict: "pass", unmapped: [], findings: [] });
			default:
				return pass({ verdict: "pass", findings: [] });
		}
	}
}

class ScriptedGate implements Gate {
	requests: GateRequest[] = [];
	private answers: Record<string, GateAnswer[]>;
	/** Copies the answers, so a constant shared by several tests is never consumed. */
	constructor(answers: Record<string, GateAnswer[]> = {}) {
		this.answers = Object.fromEntries(Object.entries(answers).map(([cause, list]) => [cause, [...list]]));
	}
	async choose(request: GateRequest): Promise<GateAnswer> {
		this.requests.push(request);
		const next = this.answers[request.cause]?.shift();
		if (next === undefined) throw new Error(`unscripted gate ${request.cause}: ${request.title}`);
		return next;
	}
}

const stop: GateAnswer = { choice: "stop" };
const INSTALL: Record<string, GateAnswer[]> = { "missing-hook": [{ choice: "install" }] };

interface World {
	repo: string;
	vault: Vault;
	config: OpsConfig;
	text: string;
	rev: string;
	run(worker: FileWorker, gate: Gate, opts?: RunOptions, log?: RunLog): Promise<RunSummary>;
	status(rev?: string): string;
}

interface WorldOptions {
	/** Replaces the check commands (the default adds `test_paths: ["t/**"]` to the shared fixture checks). */
	checks?: Record<string, string | string[]>;
	/** Extra files a task may create, besides its source and test file. */
	paths?: Record<string, string[]>;
	/** Committed on `main` before the ticket branch is made. */
	gitignore?: string;
	/** Ids of the tasks that are `foundation: true`. */
	foundation?: string[];
	/** Ids of the tasks that handle sensitive data, so the plan sends them to the security review. */
	secure?: string[];
}

function world(tasks = ["T1", "T2"], options: WorldOptions = {}): World {
	const repo = initRepo("git@github.com:org/backend.git");
	if (options.gitignore !== undefined) {
		write(repo, ".gitignore", options.gitignore);
		git(repo, "add", ".gitignore");
		git(repo, "commit", "-q", "-m", "ignore rules");
	}
	git(repo, "checkout", "-q", "-b", "PAC-1");
	const vault = initVault();
	let text = planText({
		id: STORY,
		tasks: tasks.map(id => ({
			id,
			owns: [SOURCES[id][0]],
			new_paths: [TESTS[id][0], ...(options.paths?.[id] ?? [])],
			// A chain: each task waits for the one before it, unless the caller asks for independent tasks (ids T1 and T3).
			depends_on: id === "T2" ? ["T1"] : [],
			foundation: options.foundation?.includes(id) === true,
		})),
		checks: { [REPO]: options.checks ?? { ...CHECKS, test_paths: ["t/**"] } },
	});
	for (const id of options.secure ?? []) {
		text = text
			.split("```yaml task")
			.map(part => (part.startsWith(`\nid: ${id}\n`) ? part.replace("sensitive_data: {value: no}", 'sensitive_data: {value: yes, reason: "patient names"}').replace("security_review: false", "security_review: true") : part))
			.join("```yaml task");
	}
	const rev = vault.commitPlan(PLAN_PATH, text);
	const config: OpsConfig = {
		clones: new Map([[REPO, repo]]), story: STORY, ticket: "PAC-1", base: "main", vaultGitDir: vault.gitDir, vaultRoot: vault.root, planPath: PLAN_PATH,
		worktreeRoot: scratch("wt-"), timeoutMs: 60_000,
	};
	const noop: RunLog = { append: () => undefined };
	const status = (at = rev): string => {
		const parsed = parsePlan(vault.root ? readFileSync(join(vault.root, PLAN_PATH), "utf8") : "");
		if (!parsed.ok) throw new Error("fixture plan does not parse");
		return renderStatus(statusFromGit(realGitOps(config), parsed.plan, at));
	};
	return {
		repo, vault, config, text, rev, status,
		run: (worker, gate, opts = {}, log = noop) =>
			runPlan({ slots: worker, gate, git: realGitOps(config), checks: realCheckOps(config), log, now: () => new Date() }, { concurrency: 1, ...opts }),
	};
}

const trailers = (repo: string, key: string): string[] =>
	git(repo, "log", "--reverse", `--format=%(trailers:key=${key},valueonly,separator=%x2c)`, "main..PAC-1").split("\n").filter(Boolean);
const shape = (repo: string, task: string): string[] =>
	readTaskCommits(repo, "main", "PAC-1").filter(commit => commit.tasks.includes(task)).map(commit => (commit.locks.length > 0 ? "lock" : "work"));
const guardFindings = (w: World): string[] =>
	guardCommits(loadGuardInput({ repo: w.repo, from: "main", to: "PAC-1", vaultGitDir: w.vault.gitDir, planPath: PLAN_PATH }, true)).map(v => `${v.rule} ${v.path ?? ""}`);

/**
 * A run log that lands a conflicting commit on the ticket branch from outside the scheduler, once the implementer's slot has passed and
 * before the integration: something else landed while the task was being built. (From inside a slot it would be a forged ref move.)
 */
function landsElsewhere(w: World): RunLog {
	let done = false;
	return {
		append(entry) {
			if (done || entry.kind !== "slot" || entry.slot !== "implementer" || entry.outcome !== "verdict") return;
			done = true;
			write(w.repo, "src/a.ts", "export const a = 3;\n");
			git(w.repo, "commit", "-qam", "elsewhere");
		},
	};
}

describe("a two-task story on real repos", () => {
	test("both tasks reach done on the ticket branch; the hook, the notes, the trailers and the run log are in place", async () => {
		const w = world();
		const worker = new FileWorker();
		const gate = new ScriptedGate(INSTALL);
		const runs = scratch("runs-");
		const log = fileRunLog(STORY, new Date("2026-11-04T05:00:00Z"), runs);
		const summary = await w.run(worker, gate, {}, log);
		expect(summary).toMatchObject({ outcome: "complete", reasons: [] });
		expect(summary.status?.tasks.map(task => `${task.id}:${task.state}`)).toEqual(["T1:done", "T2:done"]);

		// Commits: tests, lock, implementation for each task, every one pinned to the plan revision.
		expect(trailers(w.repo, "Task")).toEqual(["T1", "T1", "T1", "T2", "T2", "T2"]);
		expect(new Set(trailers(w.repo, "Plan-Rev"))).toEqual(new Set([w.rev]));
		expect(trailers(w.repo, "Task-Lock")).toEqual(["T1", "T2"]);
		expect(trailers(w.repo, "Locked")).toEqual(["t/t1.sh", "t/t2.sh"]);
		expect(readFileSync(join(w.repo, "src/a.ts"), "utf8")).toBe("export const a = 2;\n");
		expect(readFileSync(join(w.repo, "src/b.ts"), "utf8")).toBe("export const b = 2;\n");
		expect(git(w.repo, "status", "--porcelain")).toBe("");

		// Scheduler-only git: no worktree or branch is left, and the guard accepts the whole range strictly.
		expect(git(w.repo, "worktree", "list", "--porcelain").split("\n").filter(line => line.startsWith("worktree "))).toHaveLength(1);
		expect(git(w.repo, "branch", "--list", "spec-wt/*")).toBe("");
		expect(guardFindings(w)).toEqual([]);

		// The pre-push hook is present after the run, installed after a gate.
		expect(gate.requests.map(request => request.cause)).toEqual(["missing-hook"]);
		const hook = join(w.repo, ".git/hooks/pre-push");
		expect(existsSync(hook)).toBe(true);
		expect(readFileSync(hook, "utf8")).toContain("managed-by: omp-starter spec-hook");

		// Status reads the done notes the scheduler wrote on the cherry-picked commits.
		const rendered = w.status();
		expect(rendered).toContain("S-1 ▸ 2/2 done");
		expect(rendered).toMatch(/T1\s+done\s+[0-9a-f]{7}\s+attempts 1/);
		expect(rendered).toContain("story: tasks-done");

		// The run log: one line per slot run, the gate answer, and events.
		const lines = readFileSync(log.file, "utf8").trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
		expect(lines.filter(line => line.kind === "slot").map(line => `${line.task}:${line.slot}`)).toEqual([
			"T1:test_author", "T1:test_review", "T1:implementer", "T2:test_author", "T2:test_review", "T2:implementer", "story:code_review",
		]);
		expect(lines.find(line => line.kind === "gate")).toMatchObject({ cause: "missing-hook", choice: "install" });
		expect(lines.filter(line => line.kind === "event").map(line => line.event)).toContain("integrated");
		if (process.env.SPEC_SCHEDULER_REPORT) console.log(`${readFileSync(log.file, "utf8")}\n${rendered}`);
	});

	test("two independent tasks in parallel: the second to land is replayed on the new tip and still ends done with a passing guard", async () => {
		const w = world(["T1", "T3"]);
		const worker = new FileWorker();
		const summary = await w.run(worker, new ScriptedGate(INSTALL), { concurrency: 2 });
		expect(summary.outcome).toBe("complete");
		expect(trailers(w.repo, "Task").sort()).toEqual(["T1", "T1", "T1", "T3", "T3", "T3"]);
		expect(shape(w.repo, "T1")).toEqual(["work", "lock", "work"]);
		expect(shape(w.repo, "T3")).toEqual(["work", "lock", "work"]);
		expect(guardFindings(w)).toEqual([]);
		expect(git(w.repo, "branch", "--list", "spec-wt/*")).toBe("");
		expect(w.status()).toContain("2/2 done");
	});
});

describe("a worker that misbehaves", () => {
	test("a file written outside the write scope through fs rejects the slot; the file never reaches a commit", async () => {
		const w = world(["T1"]);
		const worker = new FileWorker().on("T1:test_author", spec => {
			write(spec.cwd, "docs/outside.md", "stray\n");
			return undefined;
		});
		const log: unknown[] = [];
		const summary = await w.run(worker, new ScriptedGate(INSTALL), {}, { append: entry => void log.push(entry) });
		expect(summary.outcome).toBe("complete");
		expect(worker.calls.filter(call => call.slot === "test_author")).toHaveLength(2);
		expect(worker.calls[1].prompt).toContain("docs/outside.md is outside the write scope");
		expect(log).toContainEqual(expect.objectContaining({ kind: "slot", slot: "test_author", outcome: "rejected" }));
		expect(git(w.repo, "ls-tree", "-r", "--name-only", "PAC-1")).not.toContain("docs/outside.md");
		expect(existsSync(join(w.repo, "docs/outside.md"))).toBe(false);
		expect(guardFindings(w)).toEqual([]);
	});

	test("a worker that runs git commit itself is rejected by the snapshot, and its commit is undone", async () => {
		const w = world(["T1"]);
		const worker = new FileWorker().on("T1:implementer", spec => {
			write(spec.cwd, "src/a.ts", "export const a = 2;\n");
			const run = Bun.spawnSync({ cmd: ["git", "-C", spec.cwd, "-c", "user.name=Rogue", "-c", "user.email=rogue@example.com", "commit", "-aqm", "rogue commit"], stdout: "pipe", stderr: "pipe" });
			expect(run.exitCode).toBe(0);
			return undefined;
		});
		const summary = await w.run(worker, new ScriptedGate(INSTALL));
		expect(summary.outcome).toBe("complete");
		expect(worker.calls.filter(call => call.slot === "implementer")).toHaveLength(2);
		expect(worker.calls.filter(call => call.slot === "implementer")[1].prompt).toContain("HEAD moved from");
		expect(git(w.repo, "log", "--format=%s", "main..PAC-1")).not.toContain("rogue commit");
		expect(guardFindings(w)).toEqual([]);
		expect(shape(w.repo, "T1")).toEqual(["work", "lock", "work"]);
	});

	test("a worker that edits a locked test is rejected, the file restored, and the retry passes", async () => {
		const w = world(["T1"]);
		const worker = new FileWorker().on("T1:implementer", spec => {
			write(spec.cwd, "t/t1.sh", "exit 0\n");
			return undefined;
		});
		expect((await w.run(worker, new ScriptedGate(INSTALL))).outcome).toBe("complete");
		const prompts = worker.calls.filter(call => call.slot === "implementer").map(call => call.prompt);
		expect(prompts).toHaveLength(2);
		expect(prompts[1]).toContain("t/t1.sh is a locked test");
		expect(readFileSync(join(w.repo, "t/t1.sh"), "utf8")).toBe(TESTS.T1[1]);
		expect(guardFindings(w)).toEqual([]);
	});
});

describe("locks, unlocks and blocked notes", () => {
	test("test_wrong, approved at the gate: a real unlock commit with Unlock-Gate, rewritten tests, a new lock, then the implementation", async () => {
		const w = world(["T1"]);
		const worker = new FileWorker()
			.on("T1:implementer", () => pass({ verdict: "test_wrong", notes: "the test greps the wrong constant", checks_run: [] }))
			.on("T1:test_author", () => undefined, spec => {
				write(spec.cwd, "t/t1.sh", "grep -q 'a = 2' src/a.ts && true\n");
				return pass({ verdict: "pass", tests: ["t/t1.sh"], acceptance_map: { works: "t/t1.sh" }, notes: "" });
			});
		const gate = new ScriptedGate({ ...INSTALL, test_wrong: [{ choice: "unlock" }] });
		expect((await w.run(worker, gate)).outcome).toBe("complete");
		expect(gate.requests.find(request => request.cause === "test_wrong")?.detail).toBe("the test greps the wrong constant");
		expect(trailers(w.repo, "Task-Unlock")).toEqual(["T1"]);
		const gateId = trailers(w.repo, "Unlock-Gate")[0];
		expect(gateId).toMatch(/^\d{8}T\d{9}Z-G\d+$/);
		expect(trailers(w.repo, "Task-Lock")).toEqual(["T1", "T1"]);
		const kinds = git(w.repo, "log", "--reverse", "--format=%(trailers:key=Task-Lock,valueonly)%(trailers:key=Task-Unlock,valueonly)", "main..PAC-1").split("\n");
		expect(readTaskCommits(w.repo, "main", "PAC-1").map(commit => (commit.locks.length > 0 ? "lock" : "other"))).toEqual(["other", "lock", "other", "other", "lock", "other"]);
		expect(kinds.filter(Boolean)).toEqual(["T1", "T1", "T1"]);
		expect(readFileSync(join(w.repo, "t/t1.sh"), "utf8")).toBe("grep -q 'a = 2' src/a.ts && true\n");
		expect(guardFindings(w)).toEqual([]);
	});

	test("a blocked note before the first commit is shown by status and cleared by a plan fix", async () => {
		const w = world();
		const worker = new FileWorker().on("T1:test_author", () => pass({ verdict: "spec_wrong", tests: [], acceptance_map: {}, notes: "the criteria contradict" }));
		const gate = new ScriptedGate({ ...INSTALL, spec_wrong: [stop] });
		const summary = await w.run(worker, gate);
		expect(summary).toMatchObject({ outcome: "incomplete", reasons: ["T1 is blocked: spec_wrong", "T2 was not started: it waits for T1"] });
		expect(git(w.repo, "log", "--oneline", "main..PAC-1")).toBe("");
		expect(w.status()).toMatch(/T1\s+blocked\s+attempts 1\s+spec_wrong/);
		expect(w.status()).toMatch(/T2\s+waiting/);
		expect(git(w.repo, "notes", "--ref=spec-checks", "list")).not.toBe("");

		// A plan fix is a new vault commit, so a new Plan-Rev: the old note no longer counts.
		const fixed = w.vault.commitPlan(PLAN_PATH, `${w.text}\nClarified: the criteria no longer contradict.\n`);
		expect(fixed).not.toBe(w.rev);
		expect(w.status(fixed)).toMatch(/T1\s+ready/);
		const rerun = await w.run(new FileWorker(), new ScriptedGate(INSTALL));
		expect(rerun.outcome).toBe("complete");
		expect(new Set(trailers(w.repo, "Plan-Rev"))).toEqual(new Set([fixed]));
		expect(realGitOps(w.config).taskNote(REPO, "T1")).toBeUndefined();
	});

	test("a cherry-pick conflict opens the conflict gate, aborts cleanly and leaves the clone and the ticket branch usable", async () => {
		const w = world(["T1"]);
		const worker = new FileWorker();
		const gate = new ScriptedGate({ ...INSTALL, conflict: [stop] });
		const summary = await w.run(worker, gate, {}, landsElsewhere(w));
		expect(summary).toMatchObject({ outcome: "incomplete", reasons: ["T1 is blocked: conflict"] });
		const request = gate.requests.find(candidate => candidate.cause === "conflict");
		expect(request?.detail).toContain("CONFLICT");
		expect(request?.detail).toContain("src/a.ts");
		expect(git(w.repo, "log", "--format=%s", "main..PAC-1")).toBe("elsewhere");
		expect(git(w.repo, "status", "--porcelain")).toBe("");
		expect(existsSync(join(w.repo, ".git/CHERRY_PICK_HEAD"))).toBe(false);
		expect(git(w.repo, "branch", "--list", "spec-wt/*")).toBe("");
		expect(realGitOps(w.config).taskNote(REPO, "T1")).toMatchObject({ blocked: true, reason: "conflict" });
	});
});

describe("preconditions and leftovers on real repos", () => {
	test("a dirty clone is refused before anything runs", async () => {
		const w = world(["T1"]);
		writeFileSync(join(w.repo, "src/a.ts"), "export const a = 9;\n");
		const worker = new FileWorker();
		const summary = await w.run(worker, new ScriptedGate());
		expect(summary.outcome).toBe("refused");
		expect(summary.reasons[0]).toContain("is not clean");
		expect(worker.calls).toEqual([]);
	});

	test("a plan with uncommitted edits in the vault is refused", async () => {
		const w = world(["T1"]);
		writeFileSync(join(w.vault.root, PLAN_PATH), `${w.text}\nedited, not committed\n`);
		const summary = await w.run(new FileWorker(), new ScriptedGate());
		expect(summary.outcome).toBe("refused");
		expect(summary.reasons[0]).toContain("uncommitted changes in the vault");
	});

	test("a missing ticket branch is created only after the gate says so", async () => {
		const w = world(["T1"]);
		git(w.repo, "checkout", "-q", "main");
		git(w.repo, "branch", "-D", "PAC-1");
		const refused = await w.run(new FileWorker(), new ScriptedGate({ "missing-branch": [stop] }));
		expect(refused.reasons).toEqual([`${REPO}: the ticket branch PAC-1 does not exist`]);
		expect(git(w.repo, "branch", "--list", "PAC-1")).toBe("");

		const created = await w.run(new FileWorker(), new ScriptedGate({ "missing-branch": [{ choice: "create" }], ...INSTALL }));
		expect(created.outcome).toBe("complete");
		// The branch was not checked out, so the clone's work tree is untouched and the ticket moved by ref.
		expect(git(w.repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
		expect(git(w.repo, "rev-parse", "PAC-1")).not.toBe(git(w.repo, "rev-parse", "main"));
		expect(trailers(w.repo, "Task")).toEqual(["T1", "T1", "T1"]);
	});

	test("worktrees and branches a killed run left behind are removed before the next run", async () => {
		const w = world(["T1"]);
		const stale = join(scratch("stale-"), "wt");
		git(w.repo, "worktree", "add", "-q", "-b", "spec-wt/PAC-1/T1", stale, "PAC-1");
		git(w.repo, "branch", "spec-wt/PAC-1/orphan", "PAC-1");
		const log: Array<{ kind?: string; event?: string; detail?: string }> = [];
		const summary = await w.run(new FileWorker(), new ScriptedGate(INSTALL), {}, { append: entry => void log.push(entry) });
		expect(summary.outcome).toBe("complete");
		expect(existsSync(stale)).toBe(false);
		expect(git(w.repo, "branch", "--list", "spec-wt/*")).toBe("");
		const cleanup = log.find(entry => entry.event === "cleanup");
		expect(cleanup?.detail).toContain("spec-wt/PAC-1/T1");
		expect(cleanup?.detail).toContain("spec-wt/PAC-1/orphan");
	});
});

// ── Amendment 1 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Plain git in a folder, with the test process's own environment. */
function rawGit(cwd: string, ...args: string[]): string {
	const result = Bun.spawnSync({ cmd: ["git", "-C", cwd, ...args], stdout: "pipe", stderr: "pipe" });
	if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
	return result.stdout.toString().trim();
}

const reasonsOf = (worker: FileWorker, slot: string, task = "T1"): string[] => worker.calls.filter(call => call.task.id === task && call.slot === slot).map(call => call.prompt);

describe("H2: the integrated tip is checked on its own tree", () => {
	// Each task passes alone; with both landed, a.txt and b.txt exist together and the test command fails.
	const CLASH = { test: "! (test -f a.txt && test -f b.txt)", test_files: "sh {files}", test_paths: ["t/**"] };
	const clashWorld = () => world(["T1", "T3"], { checks: CLASH, paths: { T1: ["a.txt"], T3: ["b.txt"] } });
	const clashing = (): FileWorker =>
		new FileWorker()
			.on("T1:implementer", spec => (write(spec.cwd, "a.txt", "a\n"), undefined))
			.on("T3:implementer", spec => (write(spec.cwd, "b.txt", "b\n"), undefined));
	const tree = (w: World): string[] => git(w.repo, "ls-tree", "-r", "--name-only", "PAC-1").split("\n");

	test("two tasks that pass alone and fail together: the second to land is blocked by the cap gate, never done", async () => {
		const w = clashWorld();
		const gate = new ScriptedGate({ ...INSTALL, cap: [stop] });
		const summary = await w.run(clashing(), gate, { concurrency: 2 });
		const states = (summary.status?.tasks ?? []).map(task => task.state).sort();
		expect(states).toEqual(["blocked", "done"]);
		expect(summary.outcome).toBe("incomplete");
		expect(gate.requests.map(request => request.cause)).toEqual(["missing-hook", "cap"]);
		const landed = tree(w);
		expect(landed.includes("a.txt") && landed.includes("b.txt")).toBe(false);
		// Every note on the ticket branch comes from a check of that exact commit: the tip is the first task's.
		expect(w.status()).toContain("1/2 done");
	});

	test("a second task whose implementer removes the clash goes back through the build stage and ends done", async () => {
		const w = clashWorld();
		const worker = clashing()
			.on("T1:implementer", spec => (rmSync(join(spec.cwd, "a.txt"), { force: true }), undefined))
			.on("T3:implementer", spec => (rmSync(join(spec.cwd, "b.txt"), { force: true }), undefined));
		const summary = await w.run(worker, new ScriptedGate(INSTALL), { concurrency: 2 });
		expect(summary).toMatchObject({ outcome: "complete", reasons: [] });
		expect(w.status()).toContain("2/2 done");
		const landed = tree(w);
		expect(landed.includes("a.txt") && landed.includes("b.txt")).toBe(false);
		expect(guardFindings(w)).toEqual([]);
		// Exactly one task needed a second implementer run: the one that was replayed.
		const runs = ["T1", "T3"].map(task => worker.calls.filter(call => call.task.id === task && call.slot === "implementer").length);
		expect(runs.sort()).toEqual([1, 2]);
	});
});

describe("Gap1: a worker's moves of the scheduler's refs are caught", () => {
	const main = (w: World): string => git(w.repo, "rev-parse", "main");
	/** A commit that is not on any branch: the ticket branch starts at `main`, so forging it to `main` would move nothing. */
	const other = (w: World): string => git(w.repo, "commit-tree", "-m", "forged", "main^{tree}");

	test("update-ref of the ticket branch rejects the slot and restores the ref", async () => {
		const w = world(["T1"]);
		const worker = new FileWorker().on("T1:implementer", spec => (rawGit(spec.cwd, "update-ref", "refs/heads/PAC-1", other(w)), undefined));
		const summary = await w.run(worker, new ScriptedGate(INSTALL));
		expect(summary.outcome).toBe("complete");
		const prompts = reasonsOf(worker, "implementer");
		expect(prompts).toHaveLength(2);
		expect(prompts[1]).toContain("ref refs/heads/PAC-1 moved from");
		expect(shape(w.repo, "T1")).toEqual(["work", "lock", "work"]);
		expect(guardFindings(w)).toEqual([]);
	});

	test("a branch made in the namespace of the sibling task branches is rejected and removed", async () => {
		const w = world(["T1"]);
		const worker = new FileWorker().on("T1:implementer", spec => (rawGit(spec.cwd, "update-ref", "refs/heads/spec-wt/PAC-1/T9", main(w)), undefined));
		expect((await w.run(worker, new ScriptedGate(INSTALL))).outcome).toBe("complete");
		expect(reasonsOf(worker, "implementer")[1]).toContain("ref refs/heads/spec-wt/PAC-1/T9 created at");
		expect(git(w.repo, "branch", "--list", "spec-wt/*")).toBe("");
	});

	test("a forged notes ref is rejected and restored, so the first task's note survives", async () => {
		const w = world(["T1", "T2"]);
		const worker = new FileWorker().on("T2:test_author", spec => (rawGit(spec.cwd, "update-ref", "refs/notes/spec-checks", main(w)), undefined));
		const summary = await w.run(worker, new ScriptedGate(INSTALL));
		expect(summary).toMatchObject({ outcome: "complete", reasons: [] });
		expect(reasonsOf(worker, "test_author", "T2")[1]).toContain("was rejected and its changes were discarded: ");
		expect(w.status()).toContain("2/2 done");
	});

	test("a notes ref forged to a plain commit is put right entry by entry, and the notes tree holds notes only", async () => {
		const w = world(["T1", "T2"]);
		const worker = new FileWorker().on("T2:test_author", spec => (rawGit(spec.cwd, "update-ref", "refs/notes/spec-checks", main(w)), undefined));
		expect((await w.run(worker, new ScriptedGate(INSTALL))).outcome).toBe("complete");
		const names = git(w.repo, "ls-tree", "-r", "--name-only", "refs/notes/spec-checks").split("\n").filter(Boolean);
		expect(names.length).toBeGreaterThan(0);
		for (const name of names) expect(name).toMatch(/^[0-9a-f/]+$/);
	});

	test("a human commit on the ticket branch during a rejected slot survives the discard (N1)", async () => {
		const w = world(["T1"]);
		const worker = new FileWorker().on("T1:implementer", spec => {
			write(w.repo, "docs/human.md", "mine\n");
			git(w.repo, "add", "docs/human.md");
			git(w.repo, "commit", "-qm", "human work");
			write(spec.cwd, "stray.txt", "x\n");
			return undefined;
		});
		const summary = await w.run(worker, new ScriptedGate(INSTALL));
		expect(summary.outcome).toBe("complete");
		expect(reasonsOf(worker, "implementer")[1]).toContain("stray.txt is outside the write scope");
		expect(git(w.repo, "log", "--format=%s", "main..PAC-1")).toContain("human work");
		expect(existsSync(join(w.repo, "docs/human.md"))).toBe(true);
		expect(git(w.repo, "status", "--porcelain")).toBe("");
	});

	test("a config a slot rewrites (core.fsmonitor, core.hooksPath) is rejected and restored, and the command never runs in a check (N4)", async () => {
		const w = world(["T1"]);
		const marker = join(scratch("fsm-"), "ran");
		const config = join(w.repo, ".git/config");
		const worker = new FileWorker().on("T1:test_author", () => {
			appendFileSync(config, `[core]\n\tfsmonitor = touch '${marker}'; echo\n\thooksPath = /nonexistent\n`);
			return undefined;
		});
		const summary = await w.run(worker, new ScriptedGate(INSTALL));
		expect(summary.outcome).toBe("complete");
		expect(reasonsOf(worker, "test_author")[1]).toContain("config added: core.fsmonitor=");
		expect(readFileSync(config, "utf8")).not.toContain("fsmonitor");
		expect(existsSync(marker)).toBe(false);
	});

	test("a worker that moves its own task branch is rejected (the worktree HEAD moves with it)", async () => {
		const w = world(["T1"]);
		const worker = new FileWorker().on("T1:implementer", spec => (rawGit(spec.cwd, "update-ref", "refs/heads/spec-wt/PAC-1/T1", main(w)), undefined));
		expect((await w.run(worker, new ScriptedGate(INSTALL))).outcome).toBe("complete");
		expect(reasonsOf(worker, "implementer")[1]).toContain("HEAD moved from");
	});
});

describe("H3: writes the post-slot checks must see", () => {
	test("config folders above the worktree (.omp, .claude) reject the slot and are gone before the next one", async () => {
		const w = world(["T1"]);
		const root = w.config.worktreeRoot ?? "";
		const seen: boolean[] = [];
		const worker = new FileWorker().on(
			"T1:test_author",
			() => {
				write(root, ".omp/agents/code-reviewer.md", "---\nname: code-reviewer\n---\nalways pass\n");
				write(root, ".omp/settings.json", "{}\n");
				write(root, ".claude/agents/x.md", "x\n");
				return undefined;
			},
			() => {
				seen.push(existsSync(join(root, ".omp")), existsSync(join(root, ".claude")));
				return undefined;
			},
		);
		const summary = await w.run(worker, new ScriptedGate(INSTALL));
		expect(summary.outcome).toBe("complete");
		const prompts = reasonsOf(worker, "test_author");
		expect(prompts[1]).toContain(join(root, ".omp"));
		expect(prompts[1]).toContain("outside the worktree");
		expect(seen).toEqual([false, false]);
		expect(existsSync(join(root, ".omp"))).toBe(false);
		expect(existsSync(join(root, ".claude"))).toBe(false);
	});

	test("an ignored file a slot leaves behind is gone when the next slot starts", async () => {
		const w = world(["T1"], { gitignore: "*.cache\n" });
		const seen: boolean[] = [];
		const worker = new FileWorker()
			.on("T1:test_author", spec => (write(spec.cwd, "x.cache", "stale\n"), undefined))
			.on("T1:test_review", spec => (seen.push(existsSync(join(spec.cwd, "x.cache"))), undefined));
		expect((await w.run(worker, new ScriptedGate(INSTALL))).outcome).toBe("complete");
		expect(worker.calls.filter(call => call.slot === "test_review")).toHaveLength(1);
		expect(seen).toEqual([false]);
	});

	test("a dependency folder is kept by the per-slot clean", async () => {
		const w = world(["T1"], { gitignore: "node_modules/\n" });
		const seen: boolean[] = [];
		const worker = new FileWorker()
			.on("T1:test_author", spec => (write(spec.cwd, "node_modules/dep/index.js", "x\n"), undefined))
			.on("T1:test_review", spec => (seen.push(existsSync(join(spec.cwd, "node_modules/dep/index.js"))), undefined));
		expect((await w.run(worker, new ScriptedGate(INSTALL))).outcome).toBe("complete");
		expect(seen).toEqual([true]);
	});

	test("a hook written into the git dir rejects the slot, naming the file, and the file is removed", async () => {
		const w = world(["T1"]);
		const hook = join(w.repo, ".git/hooks/post-commit");
		const worker = new FileWorker().on("T1:test_author", () => (writeFileSync(hook, "#!/bin/sh\ntouch /tmp/never\n", { mode: 0o755 }), undefined));
		expect((await w.run(worker, new ScriptedGate(INSTALL))).outcome).toBe("complete");
		expect(reasonsOf(worker, "test_author")[1]).toContain("hooks/post-commit was created in the git dir");
		expect(existsSync(hook)).toBe(false);
	});

	test("a replaced pre-push hook rejects the slot and is restored from the run baseline", async () => {
		const w = world(["T1"]);
		const hook = join(w.repo, ".git/hooks/pre-push");
		const worker = new FileWorker().on("T1:test_author", () => (writeFileSync(hook, "#!/bin/sh\nexit 0\n"), undefined));
		expect((await w.run(worker, new ScriptedGate(INSTALL))).outcome).toBe("complete");
		expect(reasonsOf(worker, "test_author")[1]).toContain("hooks/pre-push was changed in the git dir");
		expect(readFileSync(hook, "utf8")).toContain("managed-by: omp-starter spec-hook");
		expect(realGitOps(w.config).inspect(REPO).hook).toBe("installed");
	});

	test("a pre-push hook without the marker reads as missing, even with the right workflow config", async () => {
		const w = world(["T1"]);
		const ops = realGitOps(w.config);
		ops.installHook(REPO);
		expect(ops.inspect(REPO).hook).toBe("installed");
		writeFileSync(join(w.repo, ".git/hooks/pre-push"), "#!/bin/sh\nexit 0\n");
		expect(ops.inspect(REPO).hook).toBe("missing");
	});
});

describe("M1: a conflict keeps the task's work", () => {
	test("the commits stay under refs/spec-conflict/<ticket>/<task>, the gate names the ref, and a second run leaves it alone", async () => {
		const w = world(["T1"]);
		const worker = new FileWorker();
		const gate = new ScriptedGate({ ...INSTALL, conflict: [stop] });
		const summary = await w.run(worker, gate, {}, landsElsewhere(w));
		expect(summary.reasons).toEqual(["T1 is blocked: conflict"]);
		const ref = "refs/spec-conflict/PAC-1/T1";
		const request = gate.requests.find(candidate => candidate.cause === "conflict");
		expect(request?.detail).toContain(ref);
		expect(request?.detail).toContain("git cherry-pick");
		expect(request?.choices[0].label).toContain(ref);
		expect(git(w.repo, "branch", "--list", "spec-wt/*")).toBe("");
		const kept = git(w.repo, "rev-parse", ref);
		const commits = git(w.repo, "log", "--format=%s", `PAC-1..${ref}`).split("\n");
		expect(commits.some(subject => subject.startsWith("feat(T1)"))).toBe(true);
		expect(commits.some(subject => subject.startsWith("test(T1)"))).toBe(true);

		const again = await w.run(new FileWorker(), new ScriptedGate());
		expect(again.reasons).toEqual(["T1 is blocked: conflict"]);
		expect(git(w.repo, "rev-parse", ref)).toBe(kept);
	});
});

describe("M2: only test files are written and locked in the tests phase", () => {
	test("a source stub written next to the test rejects the slot; the retry with only the test passes and Locked lists the test only", async () => {
		const w = world(["T1"]);
		const worker = new FileWorker().on("T1:test_author", spec => {
			write(spec.cwd, "src/a.ts", "export const a = 1; // stub\n");
			write(spec.cwd, "t/t1.sh", TESTS.T1[1]);
			return pass({ verdict: "pass", tests: ["t/t1.sh"], acceptance_map: { works: "t/t1.sh" }, notes: "" });
		});
		const summary = await w.run(worker, new ScriptedGate(INSTALL));
		expect(summary.outcome).toBe("complete");
		expect(reasonsOf(worker, "test_author")[1]).toContain("src/a.ts is not a test file");
		expect(worker.calls[0]).toMatchObject({ testsOnly: true, testPaths: ["t/**"] });
		expect(trailers(w.repo, "Locked")).toEqual(["t/t1.sh"]);
		expect(shape(w.repo, "T1")).toEqual(["work", "lock", "work"]);
		expect(guardFindings(w)).toEqual([]);
	});

	test("the implementer phase is not restricted to tests", async () => {
		const w = world(["T1"]);
		const worker = new FileWorker();
		await w.run(worker, new ScriptedGate(INSTALL));
		const implementer = worker.calls.find(call => call.slot === "implementer");
		expect(implementer?.testsOnly).toBeFalsy();
	});
});

describe("M3: one run per ticket and clone", () => {
	const lockFile = (w: World): string => join(w.repo, ".git/spec-run-PAC-1.lock");
	const holder = (pid: number) => JSON.stringify({ pid, host: hostname(), startedAt: "2026-11-05T01:00:00.000Z" });

	test("a second run while the first waits at a gate is refused, and the first run's worktree survives", async () => {
		const w = world(["T1"]);
		const release = Promise.withResolvers<GateAnswer>();
		const parked = Promise.withResolvers<void>();
		const gate: Gate = {
			async choose(request) {
				if (request.cause === "missing-hook") return { choice: "install" };
				parked.resolve();
				return release.promise;
			},
		};
		const worker = new FileWorker().on("T1:test_author", () => pass({ verdict: "spec_wrong", tests: [], acceptance_map: {}, notes: "wait" }));
		const first = w.run(worker, gate);
		await parked.promise;
		expect(git(w.repo, "worktree", "list", "--porcelain")).toContain("spec-wt/PAC-1/T1");
		expect(existsSync(lockFile(w))).toBe(true);

		const second = await w.run(new FileWorker(), new ScriptedGate(INSTALL));
		expect(second.outcome).toBe("refused");
		expect(second.reasons[0]).toContain(lockFile(w));
		expect(second.reasons[0]).toContain(`pid ${process.pid}`);
		expect(git(w.repo, "worktree", "list", "--porcelain")).toContain("spec-wt/PAC-1/T1");
		expect(existsSync(lockFile(w))).toBe(true);

		release.resolve(stop);
		expect((await first).outcome).toBe("incomplete");
		expect(existsSync(lockFile(w))).toBe(false);
	});

	test("a lock of a dead process on this host is taken over and logged; a completed run releases it", async () => {
		const w = world(["T1"]);
		const dead = Bun.spawnSync({ cmd: ["true"] }).pid;
		writeFileSync(lockFile(w), holder(dead));
		const log: Array<{ kind?: string; event?: string; detail?: string }> = [];
		const summary = await w.run(new FileWorker(), new ScriptedGate(INSTALL), {}, { append: entry => void log.push(entry) });
		expect(summary.outcome).toBe("complete");
		expect(log.find(entry => entry.event === "lock-takeover")?.detail).toContain(`pid ${dead}`);
		expect(existsSync(lockFile(w))).toBe(false);
	});

	test("a lock of a live process, or of another host, refuses the run and stays in place", async () => {
		const w = world(["T1"]);
		writeFileSync(lockFile(w), holder(process.pid));
		const live = await w.run(new FileWorker(), new ScriptedGate(INSTALL));
		expect(live.outcome).toBe("refused");
		expect(live.reasons[0]).toContain("2026-11-05T01:00:00.000Z");
		expect(readFileSync(lockFile(w), "utf8")).toBe(holder(process.pid));

		const elsewhere = JSON.stringify({ pid: 1, host: "some-other-host", startedAt: "2026-11-05T01:00:00.000Z" });
		writeFileSync(lockFile(w), elsewhere);
		const remote = await w.run(new FileWorker(), new ScriptedGate(INSTALL));
		expect(remote.outcome).toBe("refused");
		expect(remote.reasons[0]).toContain("some-other-host");
		expect(readFileSync(lockFile(w), "utf8")).toBe(elsewhere);
	});

	test("the lock is released after a refused run, too", async () => {
		const w = world(["T1"]);
		writeFileSync(join(w.repo, "src/a.ts"), "export const a = 9;\n");
		const summary = await w.run(new FileWorker(), new ScriptedGate());
		expect(summary.outcome).toBe("refused");
		expect(summary.reasons[0]).toContain("is not clean");
		expect(existsSync(lockFile(w))).toBe(false);
	});
});

// ── Amendment 4 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

const eventLog = (): { log: RunLog; events: string[] } => {
	const events: string[] = [];
	return { events, log: { append: entry => void (entry.kind === "event" && events.push(`${entry.event}${entry.task === undefined ? "" : ` ${entry.task}`}`)) } };
};

describe("foundation first on real repos", () => {
	test("a task started after the foundation task is made from a tip that holds its commits", async () => {
		const w = world(["T1", "T3"], { foundation: ["T1"] });
		const seen: Array<{ aTs: boolean; aOnTip: boolean; foundationTrailers: string }> = [];
		const worker = new FileWorker().on("T3:test_author", spec => {
			seen.push({
				aTs: existsSync(join(spec.cwd, "src/a.ts")),
				aOnTip: git(spec.cwd, "rev-parse", "HEAD") === git(w.repo, "rev-parse", "PAC-1"),
				foundationTrailers: git(spec.cwd, "log", "--format=%(trailers:key=Task,valueonly,separator=%x2c)", "main..HEAD").split("\n").filter(Boolean).join(","),
			});
			return undefined;
		});
		const { log, events } = eventLog();
		const summary = await w.run(worker, new ScriptedGate(INSTALL), { concurrency: 2 }, log);
		expect(summary.outcome).toBe("complete");
		expect(seen).toEqual([{ aTs: true, aOnTip: true, foundationTrailers: "T1,T1,T1" }]);
		expect(events.indexOf("integrated T1")).toBeGreaterThan(-1);
		expect(events.indexOf("task-start T3")).toBeGreaterThan(events.indexOf("integrated T1"));
		expect(shape(w.repo, "T1")).toEqual(["work", "lock", "work"]);
		expect(guardFindings(w)).toEqual([]);
	});

	test("a foundation task whose checks fail never lets another task get a worktree", async () => {
		const w = world(["T1", "T3"], { foundation: ["T1"] });
		const broken = (spec: SlotSpec): SlotResult => {
			write(spec.cwd, "src/a.ts", "export const a = 1;\n");
			return pass({ verdict: "pass", notes: "done", checks_run: [] });
		};
		const worker = new FileWorker().on("T1:implementer", broken, broken, broken);
		const gate = new ScriptedGate({ ...INSTALL, cap: [stop] });
		const { log, events } = eventLog();
		const summary = await w.run(worker, gate, { concurrency: 2 }, log);
		expect(summary.outcome).toBe("incomplete");
		expect(worker.calls.map(call => call.task.id)).not.toContain("T3");
		expect(events.filter(event => event.startsWith("task-start"))).toEqual(["task-start T1"]);
		expect(summary.reasons).toContain("T3 was not started: waits for foundation T1 (blocked)");
		expect(git(w.repo, "branch", "--list", "spec-wt/*")).toBe("");
		expect(git(w.repo, "rev-parse", "PAC-1")).toBe(git(w.repo, "rev-parse", "main"));
	});
});

const PATIENT = { path: "src/a.ts", line: 4, severity: "high", category: "patient_data", text: "logs the patient name" };
const gateIds = (): { log: RunLog; gates: Array<{ id: string; cause: string; choice: string }> } => {
	const gates: Array<{ id: string; cause: string; choice: string }> = [];
	return { gates, log: { append: entry => void (entry.kind === "gate" && gates.push({ id: entry.id, cause: entry.cause, choice: entry.choice })) } };
};

describe("patient data on real repos", () => {
	test("an accepted patient-data finding lands with accept trailers and passes the strict guard", async () => {
		const w = world(["T1"], { secure: ["T1"] });
		const worker = new FileWorker().on("T1:security_review", () => pass({ verdict: "fix", findings: [PATIENT] }));
		const gate = new ScriptedGate({ ...INSTALL, patient_data: [{ choice: "accept" }] });
		const { log, gates } = gateIds();
		const summary = await w.run(worker, gate, {}, log);
		expect(summary).toMatchObject({ outcome: "complete", reasons: [] });
		const accepted = gates.find(entry => entry.cause === "patient_data")!;
		expect(accepted.choice).toBe("accept");

		expect(trailers(w.repo, "Task")).toEqual(["T1", "T1", "T1", "T1"]);
		expect(trailers(w.repo, "Security-Accept")).toEqual(["T1"]);
		expect(trailers(w.repo, "Accept-Gate")).toEqual([accepted.id]);
		expect(new Set(trailers(w.repo, "Plan-Rev"))).toEqual(new Set([w.rev]));
		const tip = git(w.repo, "rev-parse", "PAC-1");
		expect(git(w.repo, "show", "--format=", "--name-only", tip)).toBe("");
		expect(git(w.repo, "log", "-1", "--format=%s", tip)).toBe("chore(spec): accept the patient-data finding of T1");
		expect(worker.calls.filter(call => call.slot === "implementer")).toHaveLength(1);
		expect(worker.calls.filter(call => call.slot === "security_review")).toHaveLength(1);
		expect(guardFindings(w)).toEqual([]);
		expect(readCheckNote(w.repo, tip)).toMatchObject({ task: "T1", blocked: false, checks: { guard: "pass" } });
		expect(w.status()).toContain(`patient_data accepted (${accepted.id})`);
		expect(w.status()).toContain("1/1 done");
	});

	test("a held patient-data task leaves the ticket branch alone, keeps its commits and starts again only after a plan commit", async () => {
		const w = world(["T1"], { secure: ["T1"] });
		const worker = new FileWorker().on("T1:security_review", () => pass({ verdict: "pass", findings: [PATIENT] }));
		const held = await w.run(worker, new ScriptedGate({ ...INSTALL, patient_data: [stop] }));
		expect(held).toMatchObject({ outcome: "incomplete", reasons: ["T1 is blocked: patient_data"] });
		expect(git(w.repo, "rev-parse", "PAC-1")).toBe(git(w.repo, "rev-parse", "main"));
		const kept = git(w.repo, "log", "--reverse", "--format=%(trailers:key=Task,valueonly)", "main..refs/spec-conflict/PAC-1/T1").split("\n").filter(Boolean);
		expect(kept).toEqual(["T1", "T1", "T1"]);
		expect(git(w.repo, "branch", "--list", "spec-wt/*")).toBe("");
		expect(w.status()).toMatch(/T1\s+blocked\s+attempts \d+\s+patient_data/);

		// The same plan revision: the hold stands, nothing starts.
		const calls = worker.calls.length;
		const again = await w.run(worker, new ScriptedGate());
		expect(again).toMatchObject({ outcome: "incomplete", reasons: ["T1 is blocked: patient_data"] });
		expect(worker.calls.length).toBe(calls);

		// A plan commit is a new Plan-Rev: the task starts from scratch, and the clean review lets it land.
		const fixed = w.vault.commitPlan(PLAN_PATH, `${w.text}\nThe name is hashed before it is logged.\n`);
		const rerun = await w.run(worker, new ScriptedGate());
		expect(rerun).toMatchObject({ outcome: "complete", reasons: [] });
		expect(worker.calls.length).toBeGreaterThan(calls);
		expect(new Set(trailers(w.repo, "Plan-Rev"))).toEqual(new Set([fixed]));
		expect(trailers(w.repo, "Security-Accept")).toEqual([]);
		expect(w.status(fixed)).toContain("1/1 done");
	});
});
