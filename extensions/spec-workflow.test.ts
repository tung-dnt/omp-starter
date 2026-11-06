import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CHECKS, PLAN_PATH, cleanScratch, git, initRepo, initVault, planText, scratch } from "./lib/spec-fixtures";
import { SLOTS } from "./lib/spec-slots";
import specWorkflow from "./spec-workflow";
import { fakePi, type FakePi } from "./test-harness";

const SLOT_AGENTS = [...new Set(Object.values(SLOTS).map(def => def.agent))];

/** Gives the fake host an SDK whose `discoverAgents` knows these agents and records the folder it was asked about. */
function withAgents(fp: FakePi, names: readonly string[] = SLOT_AGENTS): string[] {
	const asked: string[] = [];
	(fp.pi as unknown as { pi: unknown }).pi = {
		discoverAgents: async (cwd: string) => {
			asked.push(cwd);
			return { agents: names.map(name => ({ name, systemPrompt: `${name} body` })) };
		},
	};
	return asked;
}

afterEach(() => {
	delete process.env.SPEC_SLOT_SCRIPT;
	cleanScratch();
});

interface Ui {
	notes: Array<{ message: string; type: string | undefined }>;
	status: Array<string | undefined>;
	/** Resolves the pending select with this label (or undefined: dismissed). */
	pending: Array<(label: string | undefined) => void>;
	selects: string[][];
}

function context(cwd: string) {
	const ui: Ui = { notes: [], status: [], pending: [], selects: [] };
	const ctx = {
		cwd,
		hasUI: true,
		mode: "tui",
		models: { resolve: () => undefined },
		ui: {
			notify: (message: string, type?: string) => void ui.notes.push({ message, type }),
			setStatus: (_key: string, text: string | undefined) => void ui.status.push(text),
			select: (_title: string, options: string[]) => {
				ui.selects.push(options);
				const { promise, resolve } = Promise.withResolvers<string | undefined>();
				ui.pending.push(resolve);
				return promise;
			},
			input: async () => undefined,
		},
	};
	return { ctx, ui };
}

/** A clone on its ticket branch, a vault with the plan committed, and the command-line arguments that name them. */
function story() {
	const repo = initRepo("git@github.com:org/backend.git");
	git(repo, "checkout", "-q", "-b", "PAC-1");
	const vault = initVault();
	vault.commitPlan(PLAN_PATH, planText({ id: "PAC-1", tasks: [{ id: "T1", owns: ["src/a.ts"], new_paths: ["t/t1.sh"] }], checks: { "org/backend": CHECKS } }));
	return { repo, vault, args: `${PLAN_PATH} --repo ${repo} --vault-git-dir ${vault.gitDir}` };
}

async function until(condition: () => boolean): Promise<void> {
	for (let i = 0; i < 400 && !condition(); i++) await Bun.sleep(5);
	expect(condition()).toBe(true);
}

describe("spec-workflow extension", () => {
	test("registers the run commands, the status command and the read-only tool", () => {
		const fp = fakePi();
		specWorkflow(fp.pi);
		expect([...fp.commands.keys()].sort()).toEqual(["run-stop", "run-story", "run-task", "spec-status"]);
		expect([...fp.tools.keys()]).toEqual(["spec_status"]);
		expect(fp.handlers.has("input")).toBe(true);
	});

	test("bad arguments are reported with the usage line and nothing starts", async () => {
		const fp = fakePi();
		specWorkflow(fp.pi);
		const { ctx, ui } = context("/nowhere");
		await fp.runCommand("run-story", "", ctx);
		await fp.runCommand("run-story", "plan.md --concurrency 0", ctx);
		await fp.runCommand("run-story", "plan.md --nope", ctx);
		await fp.runCommand("run-stop", "", ctx);
		expect(ui.notes.map(note => note.type)).toEqual(["error", "error", "error", "info"]);
		expect(ui.notes[0].message).toContain("missing <plan>");
		expect(ui.notes[0].message).toContain("Usage: /run-story <plan>");
		expect(ui.notes[1].message).toContain("--concurrency must be a positive number");
		expect(ui.notes[2].message).toContain("unknown option --nope");
		expect(ui.notes[3].message).toBe("No spec run is active.");
		expect(ui.status).toEqual([]);
	});

	test("input is untouched while no run is active", () => {
		const fp = fakePi();
		specWorkflow(fp.pi);
		const { ctx, ui } = context("/nowhere");
		expect(fp.emit("input", { type: "input", text: "hello", source: "interactive" }, ctx)).toBeUndefined();
		expect(ui.notes).toEqual([]);
	});

	test("during a run typed prompts are intercepted and answered with a notice; run controls and non-interactive input pass; a second run is refused", async () => {
		const { args } = story();
		const fp = fakePi();
		specWorkflow(fp.pi);
		withAgents(fp);
		const { ctx, ui } = context("/elsewhere");
		// The hook is missing in a fresh clone, so the run waits at its first gate: a real active run, held open.
		const running = fp.runCommand("run-story", args, ctx);
		await until(() => ui.pending.length === 1);
		expect(ui.selects[0]).toEqual(["Install the pre-push hook", "Stop"]);
		expect(ui.status.at(-1)).toBeUndefined();

		expect(fp.emit("input", { type: "input", text: "please refactor everything", source: "interactive" }, ctx)).toEqual({ handled: true });
		expect(ui.notes.at(-1)).toEqual({ message: "spec run active: /run-stop to stop", type: "warning" });
		expect(fp.emit("input", { type: "input", text: "/run-stop", source: "interactive" }, ctx)).toBeUndefined();
		expect(fp.emit("input", { type: "input", text: "/spec-status", source: "interactive" }, ctx)).toBeUndefined();
		expect(fp.emit("input", { type: "input", text: "from the rpc driver", source: "rpc" }, ctx)).toBeUndefined();

		await fp.runCommand("run-story", args, ctx);
		expect(ui.notes.at(-1)?.message).toBe("A spec run is already active. /run-stop stops it.");

		ui.pending[0]("Stop");
		await running;
		expect(ui.notes.at(-1)).toMatchObject({ type: "warning" });
		expect(ui.notes.at(-1)?.message).toContain("outcome: refused");
		expect(ui.notes.at(-1)?.message).toContain("the pre-push hook is not installed");
		expect(ui.status.at(-1)).toBeUndefined();
		expect(fp.emit("input", { type: "input", text: "hello again", source: "interactive" }, ctx)).toBeUndefined();
	});

	test("/run-stop aborts the active run: a gate that is open when the run is stopped ends it", async () => {
		const { args } = story();
		const fp = fakePi();
		specWorkflow(fp.pi);
		withAgents(fp);
		const { ctx, ui } = context("/elsewhere");
		const running = fp.runCommand("run-story", args, ctx);
		await until(() => ui.pending.length === 1);
		await fp.runCommand("run-stop", "", ctx);
		expect(ui.notes.at(-1)?.message).toBe("Stopping the spec run...");
		ui.pending[0](undefined);
		await running;
		expect(ui.notes.at(-1)?.message).toContain("outcome: stopped");
	});

	test("the agent definitions are read once, from the starter folder; a missing one refuses the run before anything starts", async () => {
		const { args } = story();
		const fp = fakePi();
		specWorkflow(fp.pi);
		const asked = withAgents(fp, ["test-engineer", "task-builder"]);
		const { ctx, ui } = context("/elsewhere");
		await fp.runCommand("run-story", args, ctx);
		expect(asked).toEqual([resolve(import.meta.dir, "..")]);
		expect(ui.notes.at(-1)).toMatchObject({ type: "error" });
		expect(ui.notes.at(-1)?.message).toContain("no agent definition for");
		expect(ui.notes.at(-1)?.message).toContain("code-reviewer");
		expect(ui.notes.at(-1)?.message).not.toContain("test-engineer");
		expect(ui.selects).toEqual([]);
		expect(ui.status.at(-1)).toBeUndefined();
	});

	test("/run-task refuses a story plan, since each command runs its own kind of plan", async () => {
		const { args, repo } = story();
		git(repo, "config", "--local", "spec.test", "x");
		const fp = fakePi();
		specWorkflow(fp.pi);
		withAgents(fp);
		const { ctx, ui } = context("/elsewhere");
		await fp.runCommand("run-task", args, ctx);
		expect(ui.notes.at(-1)?.message).toContain("this command runs a task plan, but PAC-1 is kind: story");
	});

	test("/spec-status and the spec_status tool print the status from git; the tool needs a plan before any run", async () => {
		const { args } = story();
		const fp = fakePi();
		specWorkflow(fp.pi);
		const { ctx, ui } = context("/elsewhere");
		await fp.runCommand("spec-status", args, ctx);
		expect(ui.notes.at(-1)?.message).toContain("PAC-1 ▸ 0/1 done · 1 ready");
		expect(ui.notes.at(-1)?.message).toContain("T1  ready");
		await fp.runCommand("spec-status", "", ctx);
		expect(ui.notes.at(-1)?.message).toContain("story: in-progress");

		const [planArg, , repo] = args.split(" ");
		const called = await fp.callTool("spec_status", { plan: planArg, repo: [repo], vault_git_dir: args.split(" ").at(-1) }, { cwd: "/elsewhere" });
		expect(called.text).toContain("T1  ready");
		expect(called.details).toEqual({ story: "PAC-1" });

		const fresh = fakePi();
		specWorkflow(fresh.pi);
		await expect(fresh.callTool("spec_status", {}, { cwd: "/elsewhere" })).rejects.toThrow("no run yet: pass the plan");
	});
});

// ── Scripted slots and the run flags ────────────────────────────────────────────────────────────────────────────────────────────

const SCRIPT_TASK = `version: 1
slots:
  - match: {task: T1, slot: test_author, attempt: 1}
    steps:
      - yield: {verdict: spec_wrong, tests: [], acceptance_map: {}, notes: "scripted says no"}
  - match: {task: T9, slot: code_review}
    steps: []
`;

/** A script file in its own folder, outside every clone and the vault. */
function scriptFile(text = SCRIPT_TASK): { file: string; sha256: string } {
	const file = join(scratch("slots-"), "slots.yml");
	writeFileSync(file, text);
	return { file, sha256: new Bun.CryptoHasher("sha256").update(text).digest("hex") };
}

/** A context whose models resolve to something, so the real slot runner reaches its (scripted) session. */
function scriptedContext(cwd: string) {
	const made = context(cwd);
	(made.ctx.models as { resolve: () => unknown }).resolve = () => ({ id: "fake-model" });
	return made;
}

/** The run log the last notification names. */
function runLog(ui: Ui): Array<Record<string, unknown>> {
	const note = ui.notes.map(entry => entry.message).findLast(message => message.includes("run log: "));
	const file = note?.split("run log: ")[1]?.split("\n")[0];
	if (file === undefined || !existsSync(file)) return [];
	return readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
}

const names = (entries: Array<Record<string, unknown>>): string[] => entries.filter(entry => entry.kind === "event").map(entry => String(entry.event));

describe("scripted slots", () => {
	/** Starts a run, installs the hook at its first gate and stops at the first gate after that. Returns the notes and the status lines. */
	async function scriptedRun(args: string, ctx: ReturnType<typeof scriptedContext>["ctx"], ui: Ui, stopLabel: string) {
		const fp = fakePi();
		specWorkflow(fp.pi);
		withAgents(fp);
		const running = fp.runCommand("run-story", args, ctx);
		await until(() => ui.pending.length === 1);
		ui.pending[0]("Install the pre-push hook");
		await until(() => ui.pending.length === 2);
		ui.pending[1](stopLabel);
		await running;
	}

	/** Stops a plain run at its hook gate: the run starts, so a refusal or a seam would show. */
	async function plainRun(args: string, ctx: ReturnType<typeof context>["ctx"], ui: Ui) {
		const fp = fakePi();
		specWorkflow(fp.pi);
		withAgents(fp);
		const running = fp.runCommand("run-story", args, ctx);
		await until(() => ui.pending.length === 1);
		ui.pending[0]("Stop");
		await running;
	}

	test("without SPEC_SLOT_SCRIPT nothing scripted is read or built", async () => {
		const { args } = story();
		// A file that is not a script, and a variable that is empty: neither may be read, so neither may refuse.
		const broken = scriptFile("not: [a script");
		for (const value of [undefined, ""]) {
			if (value === undefined) delete process.env.SPEC_SLOT_SCRIPT;
			else process.env.SPEC_SLOT_SCRIPT = value;
			const { ctx, ui } = context("/elsewhere");
			await plainRun(args, ctx, ui);
			expect(ui.notes.some(note => note.message.includes("SCRIPTED SLOTS") || note.message.includes("SPEC_SLOT_SCRIPT"))).toBe(false);
			expect(ui.status.filter(line => line !== undefined && line.includes("SCRIPTED"))).toEqual([]);
			expect(names(runLog(ui)).filter(name => name.startsWith("scripted"))).toEqual([]);
			expect(ui.notes.at(-1)?.message).toContain("outcome: refused");
		}
		expect(readFileSync(broken.file, "utf8")).toBe("not: [a script");
	});

	test("a slot_script key in the plan changes nothing", async () => {
		const repo = initRepo("git@github.com:org/backend.git");
		git(repo, "checkout", "-q", "-b", "PAC-1");
		const vault = initVault();
		const { file } = scriptFile();
		const text = planText({ id: "PAC-1", tasks: [{ id: "T1", owns: ["src/a.ts"], new_paths: ["t/t1.sh"] }], checks: { "org/backend": CHECKS } })
			.replace("kind: story\n", `kind: story\nslot_script: ${file}\n`)
			.replace("repo: org/backend\n", `repo: org/backend\nslot_script: ${file}\n`);
		vault.commitPlan(PLAN_PATH, text);
		delete process.env.SPEC_SLOT_SCRIPT;
		const { ctx, ui } = context("/elsewhere");
		await plainRun(`${PLAN_PATH} --repo ${repo} --vault-git-dir ${vault.gitDir}`, ctx, ui);
		expect(ui.notes.some(note => note.message.includes("SCRIPTED SLOTS"))).toBe(false);
		expect(names(runLog(ui)).filter(name => name.startsWith("scripted"))).toEqual([]);
		expect(ui.notes.at(-1)?.message).toContain("outcome: refused");
	});

	test("a relative path, a script inside a clone and a dotenv definition each refuse the run", async () => {
		const { args, repo, vault } = story();
		const fp = fakePi();
		specWorkflow(fp.pi);
		withAgents(fp);
		const refused = async (value: string, ctx: ReturnType<typeof context>["ctx"], ui: Ui, why: string): Promise<void> => {
			process.env.SPEC_SLOT_SCRIPT = value;
			await fp.runCommand("run-story", args, ctx);
			expect(ui.notes.at(-1)).toMatchObject({ type: "error" });
			expect(ui.notes.at(-1)?.message).toContain("The spec run was not started");
			expect(ui.notes.at(-1)?.message).toContain(why);
			expect(ui.selects).toEqual([]);
			expect(ui.status).toEqual([]);
		};
		const outside = scriptFile();
		const a = context("/elsewhere");
		await refused("slots.yml", a.ctx, a.ui, "must be an absolute path");
		await refused(join(scratch("gone-"), "missing.yml"), a.ctx, a.ui, "cannot be read");
		await refused(scriptFile("version: 2").file, a.ctx, a.ui, "not a valid slot script");

		writeFileSync(join(repo, "slots.yml"), SCRIPT_TASK);
		await refused(join(repo, "slots.yml"), a.ctx, a.ui, "lies inside");
		writeFileSync(join(vault.root, "slots.yml"), SCRIPT_TASK);
		await refused(join(vault.root, "slots.yml"), a.ctx, a.ui, "lies inside");

		// A dotenv file next to the host session (Bun loads it, and omp copies it into the environment) that defines the same value.
		const cwd = scratch("host-");
		writeFileSync(join(cwd, ".env.local"), `export SPEC_SLOT_SCRIPT="${outside.file}"\n`);
		const b = context(cwd);
		await refused(outside.file, b.ctx, b.ui, ".env.local");

		// A dotenv file with another value does not refuse; the run starts and waits at its first gate.
		writeFileSync(join(cwd, ".env.local"), "SPEC_SLOT_SCRIPT=/somewhere/else.yml\n");
		process.env.SPEC_SLOT_SCRIPT = outside.file;
		const running = fp.runCommand("run-story", args, b.ctx);
		await until(() => b.ui.pending.length === 1);
		b.ui.pending[0]("Stop");
		await running;
		expect(b.ui.notes.some(note => note.message.includes("SCRIPTED SLOTS"))).toBe(true);
	});

	test("an enabled script is the first run-log entry with its sha256 and marks every status line and the final report", async () => {
		const { args } = story();
		const { file, sha256 } = scriptFile();
		process.env.SPEC_SLOT_SCRIPT = file;
		const { ctx, ui } = scriptedContext("/elsewhere");
		await scriptedRun(args, ctx, ui, "Stop this task (edit the plan, then rerun)");

		expect(ui.notes[0]).toMatchObject({ type: "warning" });
		expect(ui.notes[0].message).toContain(`SCRIPTED SLOTS`);
		expect(ui.notes[0].message).toContain(sha256);
		const entries = runLog(ui);
		expect(entries[0]).toMatchObject({ kind: "event", event: "scripted-slots", detail: `${file} ${sha256}` });
		const session = entries.find(entry => entry.event === "scripted-session");
		expect(session).toMatchObject({ task: "T1" });
		expect(JSON.parse(String(session?.detail))).toMatchObject({ slot: "test_author", attempt: 1, rule: 0, thinkingLevel: "medium", outputSchemaMode: "strict", title: "spec:PAC-1:T1:test_author" });
		expect(entries.find(entry => entry.kind === "slot")).toMatchObject({ task: "T1", slot: "test_author", verdict: "spec_wrong", sessionFile: `scripted:${sha256.slice(0, 12)}#0` });
		expect(entries.find(entry => entry.event === "scripted-slots-unused")).toMatchObject({ detail: expect.stringContaining('"task":"T9"') });

		const lines = ui.status.filter((line): line is string => line !== undefined);
		expect(lines.length).toBeGreaterThan(0);
		for (const line of lines) expect(line.endsWith(" · SCRIPTED SLOTS")).toBe(true);
		const final = ui.notes.at(-1)?.message ?? "";
		expect(final).toContain("outcome: incomplete");
		expect(final).toContain(`SCRIPTED SLOTS: ${file} sha256 ${sha256}`);
	});

	test("--slot-timeout and --max-context reach runPlan", async () => {
		const { args } = story();
		const { file } = scriptFile(`version: 1
slots:
  - match: {task: T1, slot: test_author, attempt: 1}
    steps: [{usage: {costUsd: 0, contextTokens: 100}}, {yield: {verdict: pass}}]
  - match: {task: T1, slot: test_author, attempt: 2}
    steps: [{sleep: 30000}]
`);
		process.env.SPEC_SLOT_SCRIPT = file;
		const { ctx, ui } = scriptedContext("/elsewhere");
		// The third session has no rule: its prompt fails, which is an environment failure and ends the run at a gate.
		await scriptedRun(`${args} --slot-timeout 0.05 --max-context 50`, ctx, ui, "Stop this task");
		const slots = runLog(ui).filter(entry => entry.kind === "slot");
		expect(slots.map(entry => `${entry.slot}:${entry.outcome}`)).toEqual(["test_author:aborted", "test_author:aborted"]);
		expect(String(slots[0].detail)).toContain("50 token context ceiling");
		expect(String(slots[1].detail)).toContain("wall timeout");
		expect(ui.selects[1]).toEqual(["Stop this task", "Retry once more"]);

		const bad = context("/nowhere");
		const fp = fakePi();
		specWorkflow(fp.pi);
		await fp.runCommand("run-story", "plan.md --slot-timeout 0", bad.ctx);
		await fp.runCommand("run-story", "plan.md --max-context nope", bad.ctx);
		expect(bad.ui.notes.map(note => note.message.split("\n")[0])).toEqual(["--slot-timeout must be a positive number, got 0", "--max-context must be a positive number, got nope"]);
		expect(bad.ui.notes[0].message).toContain("[--slot-timeout <seconds>] [--max-context <tokens>]");
	});
});
