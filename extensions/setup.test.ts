import { beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import ompStarter, { renderContextFile, startupSteps } from "./setup";
import { HOME, readState, STATE_FILE, type MemoryState } from "./lib/state";
import { fakeContext, fakePi, resetHome, scriptedUi, seedState, writeFiles, type FakeExec, type FakePi, type Prompt, type ScriptedUi, type UiScript } from "./test-harness";

beforeEach(resetHome);

/** Answers a `select` with the option starting with `prefix`. */
const choose = (prefix: string) => (prompt: Prompt) => {
	const picked = (prompt.detail as string[]).find(option => option.startsWith(prefix));
	if (!picked) throw new Error(`no option starting with "${prefix}" in ${JSON.stringify(prompt.detail)}`);
	return picked;
};

const home = (...parts: string[]) => path.join(HOME, ...parts);

describe("startupSteps", () => {
	test("a brand-new install is offered every step", () => {
		expect(startupSteps({}, false)).toEqual({ skills: true, models: true, jev: true, memory: true, tools: true });
	});

	test("an existing install is only offered the steps it never answered, never the memory step, Jev or language tooling", () => {
		expect(startupSteps({ agentSkills: "done" }, true)).toEqual({ skills: false, models: true, jev: false, memory: false, tools: false });
		expect(startupSteps({ agentSkills: "skipped", models: "done" }, true)).toBeUndefined();
	});
});

describe("renderContextFile", () => {
	test("composes the memory rules of the backend and the commit gate, in that order", () => {
		const memory: MemoryState = { status: "done", backend: "mnemopi", gateDirs: [home("projects"), home("work")] };
		const text = renderContextFile({ memory }) ?? "";
		expect(text.startsWith("# Memory")).toBe(true);
		expect(text.indexOf("# Commit gate")).toBeGreaterThan(text.indexOf("# Memory"));
		for (const fact of ["`retain`", "`recall`", "`reflect`", "`memory_edit`", "patient data", "secrets"]) expect(text).toContain(fact);
		expect(text).toContain("under ~/projects or ~/work is blocked");
		expect(text).toContain("a successful `retain`, `learn` or `memory_edit`");
		expect(text).toContain("[skip-mem]");
	});

	test("each backend gets its own rules, and only the backends that store something carry the data rule", () => {
		const render = (backend: MemoryState["backend"]) => renderContextFile({ memory: { status: "done", backend } });
		expect(render("hindsight")).toContain("Hindsight");
		expect(render("local")).toContain("summarises sessions");
		expect(render("local")).not.toContain("`recall`");
		expect(render("sharpshooter")).toContain("decision files");
		for (const backend of ["hindsight", "mnemopi", "local", "sharpshooter"] as const) expect(render(backend)).toContain("patient data");
		expect(render("off")).toBeUndefined();
		expect(render(undefined)).toBeUndefined();
		expect(renderContextFile({ memory: { status: "skipped", backend: "hindsight" } })).toBeUndefined();
		expect(renderContextFile({})).toBeUndefined();
	});

	test("the gate section needs gate folders and a backend with a write tool", () => {
		const gated = (backend: MemoryState["backend"], gateDirs: string[] = [HOME]): MemoryState => ({ status: "done", backend, gateDirs });
		expect(renderContextFile({ memory: gated("sharpshooter") }) ?? "").not.toContain("Commit gate");
		expect(renderContextFile({ memory: gated("hindsight", []) }) ?? "").not.toContain("Commit gate");
		expect(renderContextFile({ memory: gated("local") })).toContain("a successful `learn`");
		expect(renderContextFile({ memory: gated(undefined) })).toContain("a successful memory tool call such as `retain` or `learn`");
	});

	test("the skill triggers follow the gate only when pstack is installed", () => {
		const memory: MemoryState = { status: "done", backend: "hindsight", gateDirs: [HOME] };
		expect(renderContextFile({ memory }) ?? "").not.toContain("# Skill triggers");
		const text = renderContextFile({ memory }, true) ?? "";
		expect(text.indexOf("# Skill triggers")).toBeGreaterThan(text.indexOf("# Commit gate"));
	});
});

// ── The extension: /starter and the startup wizard ───────────────────────────

const NO_PLUGINS = JSON.stringify({ npm: [], marketplace: [] });
const ADDY_INSTALLED = JSON.stringify({ npm: [], marketplace: [{ id: "agent-skills@addy-agent-skills", entries: [{ scope: "user", version: "1.0.0" }] }] });

/** omp CLI that reports `plugins`, answers every setting as unset, and accepts writes; `onCall` sees each call first. */
function omp(plugins = NO_PLUGINS, onCall?: (args: string[]) => ReturnType<FakeExec> | undefined): FakeExec {
	return async (_command, args) => {
		const custom = onCall?.(args);
		if (custom) return custom;
		if (args[0] === "plugin" && args[1] === "list") return { stdout: plugins, code: 0 };
		if (args[0] === "config" && args[1] === "get") return { stdout: JSON.stringify({ value: null }), code: 0 };
		return { stdout: "", code: 0 };
	};
}

function starter(exec?: FakeExec): FakePi {
	const fake = fakePi(exec ?? omp());
	ompStarter(fake.pi);
	return fake;
}

/** Lets every pending promise reaction and I/O callback run; the wizard is fire-and-forget, so there is no promise to await. */
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

/** Waits for the wizard to reach `until`; a wizard that never does is cut off by the test timeout. */
async function settled(until: () => boolean): Promise<void> {
	while (!until()) await flush();
}

/** Runs `/starter <args>` from a repo folder and returns the UI it ran against. */
async function starterCommand(fake: FakePi, args: string, script: UiScript, options: { hasUI?: boolean; agent?: { kind: "main" | "sub"; name: string } } = {}): Promise<ScriptedUi> {
	const cwd = home("repo");
	fs.mkdirSync(cwd, { recursive: true });
	const ui = scriptedUi(script);
	await fake.runCommand("starter", args, fakeContext({ cwd, ui, ...options }));
	return ui;
}

describe("/starter skills", () => {
	test("records the step as done when a kit is already installed and the picker is cancelled", async () => {
		const ui = await starterCommand(starter(omp(ADDY_INSTALLED)), "skills", { form: [undefined] });
		expect(readState().agentSkills).toBe("done");
		expect(ui.prompts.map(p => p.kind)).toEqual(["form"]);
	});

	test("records a cancelled picker as skipped, but a rerun never downgrades an earlier done", async () => {
		await starterCommand(starter(), "skills", { form: [undefined] });
		expect(readState().agentSkills).toBe("skipped");

		seedState({ agentSkills: "done" });
		await starterCommand(starter(), "skills", { form: [undefined] });
		expect(readState().agentSkills).toBe("done");
	});

	test("only the named step runs and the other answers are left alone", async () => {
		seedState({ models: "done", jev: "skipped" });
		await starterCommand(starter(), "skills", { form: [undefined] });
		expect(readState()).toEqual({ models: "done", jev: "skipped", agentSkills: "skipped" });
	});
});

describe("/starter models", () => {
	test("saves the presets and records done, applying Claude routing when its models exist", async () => {
		const models = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-2"].map(m => ({ selector: `anthropic/${m}` }));
		const fake = starter(omp(NO_PLUGINS, args => (args[0] === "models" && args[1] === "anthropic" ? { stdout: JSON.stringify({ models }), code: 0 } : undefined)));
		const ui = await starterCommand(fake, "models", { confirm: [true] });
		expect(readState().models).toBe("done");
		const sets = fake.execCalls.filter(c => c.args[0] === "config" && c.args[1] === "set").map(c => c.args[2]);
		expect(sets).toContain("modelPresets");
		expect(sets).toContain("modelRoles");
		expect(ui.notifications.at(-1)?.message).toContain("Claude routing applied");
	});

	test("while Jev is the judge, rerunning the models step keeps routing the judge role to Jev", async () => {
		seedState({ jev: "done" });
		const fake = starter(omp(NO_PLUGINS, args => (args[0] === "models" ? { stdout: JSON.stringify({ models: [] }), code: 0 } : undefined)));
		await starterCommand(fake, "models", { confirm: [true] });
		const presets = fake.execCalls.find(c => c.args[1] === "set" && c.args[2] === "modelPresets")?.args[3] ?? "";
		expect(JSON.parse(presets).claude.modelRoles.judge).toBe("typesafe/jev-1.14.0");
	});

	test("declining records skipped, without changing any omp setting", async () => {
		const fake = starter();
		await starterCommand(fake, "models", { confirm: [false] });
		expect(readState().models).toBe("skipped");
		expect(fake.execCalls.some(c => c.args[1] === "set")).toBe(false);
	});
});

describe("/starter jev", () => {
	test("turning an active Jev off records skipped and routes the judge back to the presets", async () => {
		seedState({ jev: "done" });
		const fake = starter();
		await starterCommand(fake, "jev", { select: [choose("Turn Jev off")] });
		expect(readState().jev).toBe("skipped");
		expect(fake.execCalls.some(c => c.args[1] === "set" && c.args[2] === "modelRoles")).toBe(true);
	});

	test("keeping Jev leaves the answer done and changes no setting", async () => {
		seedState({ jev: "done" });
		const fake = starter();
		await starterCommand(fake, "jev", { select: [choose("Keep")] });
		expect(readState().jev).toBe("done");
		expect(fake.execCalls.some(c => c.args[1] === "set")).toBe(false);
	});

	test("a failure inside the step is reported and leaves the earlier answer", async () => {
		seedState({ jev: "done" });
		const fake = starter(omp(NO_PLUGINS, args => (args[0] === "config" ? { stderr: "boom", code: 1 } : undefined)));
		const ui = await starterCommand(fake, "jev", { select: [choose("Turn Jev off")] });
		expect(readState().jev).toBe("done");
		expect(ui.notifications.find(n => n.type === "error")?.message).toContain("Jev setup failed");
	});

	test("declining the optional step records skipped", async () => {
		await starterCommand(starter(), "jev", { confirm: [false] });
		expect(readState().jev).toBe("skipped");
	});
});

describe("/starter memory", () => {
	/** omp that reports `backend` as `memory.backend`. */
	const ompWith = (backend: string | null) => omp(NO_PLUGINS, args => (args[0] === "config" && args[1] === "get" ? { stdout: JSON.stringify({ value: backend }), code: 0 } : undefined));
	const sets = (fake: FakePi) => fake.execCalls.filter(c => c.args[0] === "config" && c.args[1] === "set").map(c => c.args.slice(2));
	const everySessionFile = () => home(".omp", "agent", "AGENTS.md");

	test("marks the current backend, sets only a changed one, records the gate folder and writes the memory rules", async () => {
		fs.mkdirSync(home("projects"));
		const fake = starter(ompWith("off"));
		const ui = await starterCommand(fake, "memory", { select: [choose("hindsight")], confirm: [true], input: [home("projects")] });
		const title = ui.prompts[0];
		expect(title.title).toBe("Memory backend (current: off)");
		expect((title.detail as string[]).map(o => o.split(":")[0])).toEqual(["off", "local", "hindsight", "mnemopi", "sharpshooter"]);
		expect((title.detail as string[])[0]).toContain("(current)");
		expect(sets(fake)).toEqual([["memory.backend", "hindsight"]]);
		expect(readState().memory).toEqual({ status: "done", backend: "hindsight", gateDirs: [home("projects")] });
		expect(ui.notifications.some(n => n.message.includes("HINDSIGHT_API_URL") && n.message.includes("/settings"))).toBe(true);
		const text = fs.readFileSync(everySessionFile(), "utf8");
		expect(text).toContain("# Memory");
		expect(text).toContain("`retain`");
		expect(text).toContain("under ~/projects is blocked");
	});

	test("keeping the current backend changes no omp setting", async () => {
		const fake = starter(ompWith("mnemopi"));
		await starterCommand(fake, "memory", { select: [choose("mnemopi")], confirm: [false] });
		expect(sets(fake)).toEqual([]);
		expect(readState().memory).toEqual({ status: "done", backend: "mnemopi" });
		expect(fs.readFileSync(everySessionFile(), "utf8")).toContain("memory_edit");
	});

	test("a backend with no write tool offers no gate, and writes no AGENTS.md when off", async () => {
		const fake = starter(ompWith("local"));
		const ui = await starterCommand(fake, "memory", { select: [choose("off")] });
		expect(ui.prompts.some(p => p.title === "Commit gate")).toBe(false);
		expect(readState().memory).toEqual({ status: "done", backend: "off" });
		expect(fs.existsSync(everySessionFile())).toBe(false);
	});

	test("cancelling the choice, or a failing omp, leaves the state alone", async () => {
		await starterCommand(starter(ompWith("off")), "memory", { select: [undefined] });
		expect(readState().memory).toEqual({ status: "skipped" });

		seedState({ memory: { status: "done", backend: "off" } });
		const failing = starter(omp(NO_PLUGINS, args => (args[1] === "set" ? { stderr: "boom", code: 1 } : args[1] === "get" ? { stdout: JSON.stringify({ value: "off" }), code: 0 } : undefined)));
		const ui = await starterCommand(failing, "memory", { select: [choose("local")] });
		expect(readState().memory).toEqual({ status: "done", backend: "off" });
		expect(ui.notifications.find(n => n.type === "error")?.message).toContain("Could not set memory.backend");
	});

	test("a gate folder that does not exist is refused, leaving the gate off", async () => {
		const ui = await starterCommand(starter(ompWith("hindsight")), "memory", { select: [choose("hindsight")], confirm: [true], input: [home("nowhere")] });
		expect(readState().memory).toEqual({ status: "done", backend: "hindsight" });
		expect(ui.notifications.find(n => n.type === "error")?.message).toContain("not an existing absolute folder");
	});
});

describe("/starter tools", () => {
	test("declining records skipped language tooling and nothing else", async () => {
		const fake = starter();
		await starterCommand(fake, "tools", { confirm: [false] });
		expect(readState()).toEqual({ tooling: { status: "skipped", selected: [], results: {} } });
		expect(fake.execCalls).toEqual([]);
	});

	test("a corrupt state file stops the step before anything is offered, and is not rewritten", async () => {
		writeFiles(HOME, { ".omp/agent/omp-starter.json": "{ not json" });
		const ui = await starterCommand(starter(), "tools", {});
		expect(ui.prompts).toEqual([]);
		expect(ui.notifications.find(n => n.type === "error")?.message).toContain("Language tooling setup failed");
		expect(fs.readFileSync(STATE_FILE, "utf8")).toBe("{ not json");
	});
});

describe("/starter updates", () => {
	test("needs an interactive main session", async () => {
		for (const options of [{ hasUI: false }, { agent: { kind: "sub" as const, name: "task" } }]) {
			const ui = await starterCommand(starter(), "updates", {}, options);
			expect(ui.notifications[0].type).toBe("warning");
			expect(ui.notifications[0].message).toContain("interactive");
		}
	});

	test("reports plugins that are not installed without contacting anything", async () => {
		const ui = await starterCommand(starter(), "updates", {});
		expect(ui.notifications.every(n => n.type === "info")).toBe(true);
		expect(ui.notifications.map(n => n.message).join("\n")).toContain("agent-skills is not installed");
	});

	test("reports a failing plugin listing as an error instead of throwing", async () => {
		const ui = await starterCommand(starter(omp(NO_PLUGINS, args => (args[0] === "plugin" ? { code: 1 } : undefined))), "updates", {});
		expect(ui.notifications).toHaveLength(1);
		expect(ui.notifications[0].type).toBe("error");
	});
});

describe("the startup wizard", () => {
	/** omp finished its own first-run setup, so the wizard may open dialogs. */
	const ompSetupDone = () => writeFiles(HOME, { ".omp/agent/config.yml": "setupVersion: 1\n" });
	const start = (fake: FakePi, ui: ScriptedUi, options: Partial<Parameters<typeof fakeContext>[0]> = {}) => {
		const ctx = fakeContext({ cwd: home("repo"), ui, ...options });
		fs.mkdirSync(ctx.cwd, { recursive: true });
		fake.emit("session_start", {}, ctx);
		return ctx;
	};

	test("a brand-new install is offered every step, and each answer is saved", async () => {
		ompSetupDone();
		const ui = scriptedUi({ form: [undefined], select: [undefined], confirm: [false, false, false] });
		start(starter(), ui);
		await settled(() => readState().tooling !== undefined);
		expect(ui.prompts).toHaveLength(5);
		expect(readState()).toEqual({
			agentSkills: "skipped",
			models: "skipped",
			jev: "skipped",
			memory: { status: "skipped" },
			tooling: { status: "skipped", selected: [], results: {} },
		});
	});

	test("an existing install is only asked the steps it never answered", async () => {
		ompSetupDone();
		seedState({ agentSkills: "done" });
		const ui = scriptedUi({ confirm: [false] });
		start(starter(), ui);
		await settled(() => readState().models !== undefined);
		expect(ui.prompts).toHaveLength(1);
		expect(readState()).toEqual({ agentSkills: "done", models: "skipped" });
	});

	test("nothing is asked when every step was already answered", async () => {
		ompSetupDone();
		seedState({ agentSkills: "skipped", models: "skipped" });
		const ui = scriptedUi();
		const ctx = start(starter(), ui);
		await flush();
		expect(ui.prompts).toEqual([]);
		expect(ctx.timers.size).toBe(0);
	});

	test("subagents, headless sessions and non-TUI modes never open the wizard", async () => {
		ompSetupDone();
		for (const options of [{ agent: { kind: "sub" as const, name: "task" } }, { hasUI: false }, { mode: "rpc" }]) {
			const ui = scriptedUi();
			const ctx = start(starter(), ui, options);
			await flush();
			expect(ui.prompts).toEqual([]);
			expect(ui.notifications).toEqual([]);
			expect(ctx.timers.size).toBe(0);
		}
		expect(fs.existsSync(STATE_FILE)).toBe(false);
	});

	test("while omp's own setup is unfinished it waits, then starts once that setup is recorded", async () => {
		const ui = scriptedUi({ form: [undefined], select: [undefined], confirm: [false, false, false] });
		const ctx = start(starter(), ui);
		expect(ctx.timers.size).toBe(1);
		ctx.tick();
		await flush();
		expect(ui.prompts).toEqual([]);

		ompSetupDone();
		ctx.tick();
		await settled(() => readState().tooling !== undefined);
		expect(ui.prompts).toHaveLength(5);
		expect(ctx.timers.size).toBe(0);
	});

	test("the first prompt submitted starts a waiting wizard immediately, once", async () => {
		const fake = starter();
		const ui = scriptedUi({ form: [undefined], select: [undefined], confirm: [false, false, false] });
		const ctx = start(fake, ui);
		expect(ui.prompts).toEqual([]);
		await fake.emit("input", {}, ctx);
		expect(readState().tooling?.status).toBe("skipped");
		expect(ui.prompts).toHaveLength(5);
		expect(ctx.timers.size).toBe(0);
		await fake.emit("input", {}, ctx);
		expect(ui.prompts).toHaveLength(5);
	});

	test("a step that throws is reported and does not crash the session", async () => {
		ompSetupDone();
		const fake = starter(omp(NO_PLUGINS, args => (args[0] === "plugin" ? { stdout: "not json", code: 0 } : undefined)));
		const ui = scriptedUi();
		start(fake, ui);
		await settled(() => ui.notifications.length > 0);
		expect(ui.notifications[0].type).toBe("error");
		expect(ui.notifications[0].message).toContain("Setup failed");
	});
});
