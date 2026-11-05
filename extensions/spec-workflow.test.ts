import { afterEach, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { CHECKS, PLAN_PATH, cleanScratch, git, initRepo, initVault, planText } from "./lib/spec-fixtures";
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

afterEach(cleanScratch);

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
