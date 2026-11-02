import { beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import ompStarter, { discoverVaults, renderContextFile, setupKnowledgeBase, startupSteps, type WizardUi } from "./setup";
import { resolveKb } from "./lib/kb-sources";
import { HOME, readState, STATE_FILE, type KbSource } from "./lib/state";
import { fakeContext, fakePi, resetHome, scriptedUi, seedState, writeFiles, type FakeExec, type FakePi, type Prompt, type ScriptedUi, type UiScript } from "./test-harness";

beforeEach(resetHome);

/** Answers a `select` with the option starting with `prefix`. */
const choose = (prefix: string) => (prompt: Prompt) => {
	const picked = (prompt.detail as string[]).find(option => option.startsWith(prefix));
	if (!picked) throw new Error(`no option starting with "${prefix}" in ${JSON.stringify(prompt.detail)}`);
	return picked;
};

const home = (...parts: string[]) => path.join(HOME, ...parts);

/** A vault with a `KnowledgeBase` folder, under the private home. */
function vault(name: string, withKb = true): string {
	const dir = home("vaults", name);
	fs.mkdirSync(withKb ? path.join(dir, "KnowledgeBase", "projects") : dir, { recursive: true });
	if (withKb) fs.writeFileSync(path.join(dir, "KnowledgeBase", "_index.md"), "# Map\n");
	return dir;
}

describe("startupSteps", () => {
	test("a brand-new install is offered every step", () => {
		expect(startupSteps({}, false)).toEqual({ skills: true, models: true, jev: true, kb: true, tools: true });
	});

	test("an existing install is only offered the steps it never answered, never Jev or language tooling", () => {
		expect(startupSteps({ agentSkills: "done", models: "skipped" }, true)).toEqual({ skills: false, models: false, jev: false, kb: true, tools: false });
		expect(startupSteps({ agentSkills: "skipped", models: "done", kb: { status: "skipped" } }, true)).toBeUndefined();
	});
});

describe("discoverVaults", () => {
	test("lists Obsidian's registered vaults, open one first and then the most recent, skipping deleted ones", () => {
		const [old, recent, open] = [vault("old", false), vault("recent", false), vault("open", false)];
		writeFiles(HOME, {
			"Library/Application Support/obsidian/obsidian.json": JSON.stringify({
				vaults: {
					a: { path: old, ts: 1 },
					b: { path: recent, ts: 9 },
					c: { path: open, ts: 5, open: true },
					d: { path: home("vaults", "deleted"), ts: 99 },
				},
			}),
		});
		expect(discoverVaults()).toEqual([open, recent, old]);
	});

	test("adds iCloud vault folders but not the container or hidden folders", () => {
		const icloud = "Library/Mobile Documents/iCloud~md~obsidian/Documents";
		fs.mkdirSync(home(icloud, "Notes"), { recursive: true });
		fs.mkdirSync(home(icloud, ".trash"), { recursive: true });
		fs.writeFileSync(home(icloud, "stray.txt"), "");
		expect(discoverVaults()).toEqual([home(icloud, "Notes")]);
	});

	test("finds nothing when Obsidian was never used", () => {
		expect(discoverVaults()).toEqual([]);
	});
});

describe("renderContextFile", () => {
	test("points at the master map, the projects folder, and every pinned note", () => {
		const kb = home("vaults", "Notes", "KnowledgeBase");
		fs.mkdirSync(path.join(kb, "projects"), { recursive: true });
		fs.writeFileSync(path.join(kb, "_index.md"), "");
		const text = renderContextFile("~/vaults/Notes/KnowledgeBase", kb, ["conventions.md", "people.md"], false);
		expect(text).toContain("~/vaults/Notes/KnowledgeBase/_index.md");
		expect(text).toContain("~/vaults/Notes/KnowledgeBase/projects/<repo>.md");
		expect(text).toContain("@~/vaults/Notes/KnowledgeBase/conventions.md");
		expect(text).toContain("@~/vaults/Notes/KnowledgeBase/people.md");
		expect(text).not.toContain("Commit gate");
	});

	test("mentions the commit gate and its [skip-mem] escape only when the gate is on", () => {
		const kb = home("kb");
		fs.mkdirSync(kb);
		const gated = renderContextFile("~/kb", kb, [], true);
		expect(gated).toContain("Commit gate");
		expect(gated).toContain("[skip-mem]");
		expect(renderContextFile("~/kb", kb, [], false)).not.toContain("[skip-mem]");
	});

	test("skips pointers to files the vault does not have", () => {
		const kb = home("kb");
		fs.mkdirSync(kb);
		const text = renderContextFile("~/kb", kb, [], false);
		expect(text).not.toContain("_index.md");
		expect(text).not.toContain("projects/<repo>");
		expect(text).not.toContain("Always-loaded");
	});
});

describe("setupKnowledgeBase, first knowledge base", () => {
	/** Answers for a first run with no vault registered: vault folder typed in, one folder served. */
	function firstRun(overrides: { vault: string; sub?: string; pinned?: string; gate?: boolean; folder?: string; scope?: string; extraConfirm?: boolean[] }): { ui: ScriptedUi; script: UiScript } {
		const script: UiScript = {
			confirm: [true, ...(overrides.extraConfirm ?? []), overrides.gate ?? true],
			select: [choose(overrides.scope ?? "Sessions under")],
			input: [overrides.vault, overrides.sub ?? "KnowledgeBase", overrides.pinned ?? "", overrides.folder ?? home("projects")],
		};
		return { ui: scriptedUi(script), script };
	}

	test("wires one vault to one folder: AGENTS.md, empty index, and a gated source", async () => {
		const notes = vault("Notes");
		fs.mkdirSync(home("projects"));
		const { ui } = firstRun({ vault: notes });
		const state = await setupKnowledgeBase(ui, undefined);

		const kbRoot = path.join(notes, "KnowledgeBase");
		expect(state).toEqual({
			status: "done",
			sources: [{ vault: notes, kbRef: "~/vaults/Notes/KnowledgeBase", kbPaths: [kbRoot], contextFile: home("projects", "AGENTS.md"), gateDir: home("projects") }],
		});
		const agents = fs.readFileSync(home("projects", "AGENTS.md"), "utf8");
		expect(agents).toContain("KB root: `~/vaults/Notes/KnowledgeBase/`");
		expect(agents).toContain("[skip-mem]");
		expect(fs.readFileSync(path.join(kbRoot, "_memory", "MEMORY.md"), "utf8")).toBe("## Global\n");
		expect(resolveKb(home("projects", "app"), state)?.kbRef).toBe("~/vaults/Notes/KnowledgeBase");
		expect(resolveKb(home("elsewhere"), state)).toBeUndefined();
	});

	test("declining the commit gate leaves the source ungated", async () => {
		fs.mkdirSync(home("projects"));
		const { ui } = firstRun({ vault: vault("Notes"), gate: false });
		const state = await setupKnowledgeBase(ui, undefined);
		expect(state.sources?.[0].gateDir).toBeUndefined();
		expect(fs.readFileSync(home("projects", "AGENTS.md"), "utf8")).not.toContain("[skip-mem]");
	});

	test("pinned notes are written into AGENTS.md, and ones that do not exist yet are reported but kept", async () => {
		const notes = vault("Notes");
		fs.writeFileSync(path.join(notes, "KnowledgeBase", "rules.md"), "");
		fs.mkdirSync(home("projects"));
		const { ui } = firstRun({ vault: notes, pinned: "rules.md, later.md" });
		await setupKnowledgeBase(ui, undefined);
		const agents = fs.readFileSync(home("projects", "AGENTS.md"), "utf8");
		expect(agents).toContain("@~/vaults/Notes/KnowledgeBase/rules.md");
		expect(agents).toContain("@~/vaults/Notes/KnowledgeBase/later.md");
		expect(ui.notifications.find(n => n.type === "warning")?.message).toContain("later.md");
		expect(ui.notifications.some(n => n.message.includes("rules.md") && n.type === "warning")).toBe(false);
	});

	test("serving every session writes AGENTS.md into the agent directory and gates the whole home", async () => {
		const { ui } = firstRun({ vault: vault("Notes"), scope: "Every omp session" });
		ui.prompts.length = 0;
		const state = await setupKnowledgeBase(ui, undefined);
		const source = state.sources?.[0] as KbSource;
		expect(source.contextFile).toBe(home(".omp", "agent", "AGENTS.md"));
		expect(source.gateDir).toBe(HOME);
		expect(fs.existsSync(source.contextFile)).toBe(true);
		expect(resolveKb(home("anywhere"), state)?.kbRef).toBe(source.kbRef);
	});

	test("a vault path with spaces gets a space-free symlink as its reference", async () => {
		const spaced = vault("My Notes");
		fs.mkdirSync(home("projects"));
		const { ui } = firstRun({ vault: spaced });
		const state = await setupKnowledgeBase(ui, undefined);
		const source = state.sources?.[0] as KbSource;
		expect(source.vault).toBe(home(".omp-kb"));
		expect(source.kbRef).toBe("~/.omp-kb/KnowledgeBase");
		expect(fs.readlinkSync(home(".omp-kb"))).toBe(spaced);
		expect(source.kbPaths).toEqual([home(".omp-kb", "KnowledgeBase"), path.join(spaced, "KnowledgeBase")]);
		expect(fs.readFileSync(home("projects", "AGENTS.md"), "utf8")).toContain("KB root: `~/.omp-kb/KnowledgeBase/`");
	});

	test("a vault chosen from the discovered list is used as-is, and 'Other folder' asks for a path", async () => {
		const known = vault("Known");
		writeFiles(HOME, { "Library/Application Support/obsidian/obsidian.json": JSON.stringify({ vaults: { a: { path: known } } }) });
		fs.mkdirSync(home("projects"));
		const ui = scriptedUi({
			confirm: [true, false],
			select: [choose("~/vaults/Known"), choose("Sessions under")],
			input: ["", "", home("projects")],
		});
		const state = await setupKnowledgeBase(ui, undefined);
		expect(state.sources?.[0].kbRef).toBe("~/vaults/Known/KnowledgeBase");
		const offered = ui.prompts.find(p => p.title === "Obsidian vault")?.detail as string[];
		expect(offered).toEqual(["~/vaults/Known", "Other folder…"]);
	});

	test("creating a knowledge-base folder that does not exist yet needs a confirmation", async () => {
		const bare = vault("Bare", false);
		fs.mkdirSync(home("projects"));
		const declined = scriptedUi({ confirm: [true, false], input: [bare, "KnowledgeBase"] });
		expect((await setupKnowledgeBase(declined, undefined)).status).toBe("skipped");
		expect(fs.existsSync(path.join(bare, "KnowledgeBase"))).toBe(false);

		const { ui } = firstRun({ vault: bare, extraConfirm: [true] });
		expect((await setupKnowledgeBase(ui, undefined)).status).toBe("done");
		expect(fs.readFileSync(path.join(bare, "KnowledgeBase", "_memory", "MEMORY.md"), "utf8")).toBe("## Global\n");
	});

	test("every refusal or cancellation ends skipped and writes nothing", async () => {
		fs.mkdirSync(home("projects"));
		const cases: UiScript[] = [
			{ confirm: [false] },
			{ confirm: [true], input: [undefined] },
			{ confirm: [true], input: [HOME] },
			{ confirm: [true], input: [vault("Notes"), "KnowledgeBase", ""], select: [undefined] },
			{ confirm: [true], input: [vault("Notes"), "KnowledgeBase", "", home("not-a-folder")], select: [choose("Sessions under")] },
		];
		for (const script of cases) {
			const ui = scriptedUi(script);
			expect(await setupKnowledgeBase(ui, undefined)).toEqual({ status: "skipped" });
			expect(fs.existsSync(home("projects", "AGENTS.md"))).toBe(false);
		}
	});

	test("an existing AGENTS.md is only replaced after confirmation, and keeps a backup", async () => {
		const notes = vault("Notes");
		fs.mkdirSync(home("projects"));
		fs.writeFileSync(home("projects", "AGENTS.md"), "my own rules\n");

		const declined = firstRun({ vault: notes, extraConfirm: [] });
		declined.script.confirm = [true, true, false];
		expect(await setupKnowledgeBase(scriptedUi(declined.script), undefined)).toEqual({ status: "skipped" });
		expect(fs.readFileSync(home("projects", "AGENTS.md"), "utf8")).toBe("my own rules\n");

		const accepted = firstRun({ vault: notes });
		accepted.script.confirm = [true, true, true];
		expect((await setupKnowledgeBase(scriptedUi(accepted.script), undefined)).status).toBe("done");
		expect(fs.readFileSync(home("projects", "AGENTS.md"), "utf8")).toContain("KB root:");
		const backups = fs.readdirSync(home("projects")).filter(f => f.startsWith("AGENTS.md.bak-"));
		expect(backups).toHaveLength(1);
		expect(fs.readFileSync(home("projects", backups[0]), "utf8")).toBe("my own rules\n");
	});
});

describe("setupKnowledgeBase, existing knowledge bases", () => {
	/** One configured source serving ~/projects. */
	async function configured(): Promise<Awaited<ReturnType<typeof setupKnowledgeBase>>> {
		fs.mkdirSync(home("projects", "nested"), { recursive: true });
		fs.mkdirSync(home("other"));
		const ui = scriptedUi({ confirm: [true, true], select: [choose("Sessions under")], input: [vault("Notes"), "KnowledgeBase", "", home("projects")] });
		return setupKnowledgeBase(ui, undefined);
	}

	test("Done keeps the sources as they are", async () => {
		const state = await configured();
		const ui = scriptedUi({ select: [choose("Done")] });
		expect(await setupKnowledgeBase(ui, state)).toEqual(state);
		expect(ui.prompts[0].title).toContain("~/projects → ~/vaults/Notes/KnowledgeBase");
	});

	test("a second knowledge base for another folder is added next to the first, and every-session is no longer offered", async () => {
		const first = await configured();
		const ui = scriptedUi({
			confirm: [true],
			select: [choose("Add"), choose("Sessions under"), choose("Done")],
			input: [vault("Second"), "KnowledgeBase", "", home("other")],
		});
		const state = await setupKnowledgeBase(ui, first);
		expect(state.sources?.map(s => s.kbRef)).toEqual(["~/vaults/Notes/KnowledgeBase", "~/vaults/Second/KnowledgeBase"]);
		expect(ui.prompts.find(p => p.title === "Load this knowledge base in")?.detail).toEqual(["Sessions under one folder"]);
		expect(resolveKb(home("other", "app"), state)?.kbRef).toBe("~/vaults/Second/KnowledgeBase");
		expect(resolveKb(home("projects", "app"), state)?.kbRef).toBe("~/vaults/Notes/KnowledgeBase");
	});

	test("a folder inside another source's folder is refused and nothing is written", async () => {
		const first = await configured();
		const ui = scriptedUi({
			select: [choose("Add"), choose("Sessions under"), choose("Done")],
			input: [vault("Second"), "KnowledgeBase", "", home("projects", "nested")],
		});
		const state = await setupKnowledgeBase(ui, first);
		expect(state).toEqual(first);
		expect(ui.notifications.find(n => n.type === "error")?.message).toContain("overlaps");
		expect(fs.existsSync(home("projects", "nested", "AGENTS.md"))).toBe(false);
	});

	test("adding for a folder that already has a knowledge base replaces that source", async () => {
		const first = await configured();
		const ui = scriptedUi({
			confirm: [true, true],
			select: [choose("Add"), choose("Sessions under"), choose("Done")],
			input: [vault("Replacement"), "KnowledgeBase", "", home("projects")],
		});
		const state = await setupKnowledgeBase(ui, first);
		expect(state.sources?.map(s => s.kbRef)).toEqual(["~/vaults/Replacement/KnowledgeBase"]);
	});

	test("removing a knowledge base deletes its AGENTS.md after confirmation, keeping a backup, and the vault is untouched", async () => {
		const first = await configured();
		const ui = scriptedUi({ confirm: [true], select: [choose("Remove a"), choose("~/projects"), undefined] });
		const state = await setupKnowledgeBase(ui, first);
		expect(state).toEqual({ status: "skipped" });
		expect(fs.existsSync(home("projects", "AGENTS.md"))).toBe(false);
		expect(fs.readdirSync(home("projects")).some(f => f.startsWith("AGENTS.md.bak-"))).toBe(true);
		expect(fs.existsSync(home("vaults", "Notes", "KnowledgeBase", "_memory", "MEMORY.md"))).toBe(true);
	});

	test("declining the AGENTS.md deletion still removes the source but warns that the file stays", async () => {
		const first = await configured();
		const ui = scriptedUi({ confirm: [false], select: [choose("Remove a"), choose("~/projects"), choose("Done")] });
		expect(await setupKnowledgeBase(ui, first)).toEqual({ status: "skipped" });
		expect(fs.existsSync(home("projects", "AGENTS.md"))).toBe(true);
		expect(ui.notifications.some(n => n.type === "warning" && n.message.includes("kept"))).toBe(true);
	});
});

// ── The extension: /starter and the startup wizard ───────────────────────────

const NO_PLUGINS = JSON.stringify({ npm: [], marketplace: [] });
const AGENT_SKILLS_INSTALLED = JSON.stringify({ npm: [], marketplace: [{ id: "agent-skills@tung-agent-skills", entries: [{ scope: "user", version: "1.0.0" }] }] });

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
	test("records agent-skills as done when it is already installed, without asking", async () => {
		const ui = await starterCommand(starter(omp(AGENT_SKILLS_INSTALLED)), "skills", {});
		expect(readState().agentSkills).toBe("done");
		expect(ui.prompts).toEqual([]);
	});

	test("records a declined install as skipped, but a rerun never downgrades an earlier done", async () => {
		await starterCommand(starter(), "skills", { confirm: [false] });
		expect(readState().agentSkills).toBe("skipped");

		seedState({ agentSkills: "done" });
		await starterCommand(starter(), "skills", { confirm: [false] });
		expect(readState().agentSkills).toBe("done");
	});

	test("only the named step runs and the other answers are left alone", async () => {
		seedState({ models: "done", kb: { status: "skipped" } });
		await starterCommand(starter(), "skills", { confirm: [false] });
		expect(readState()).toEqual({ models: "done", kb: { status: "skipped" }, agentSkills: "skipped" });
	});
});

describe("/starter models", () => {
	test("saves the presets and records done, applying Claude routing when its models exist", async () => {
		const models = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-1"].map(m => ({ selector: `anthropic/${m}` }));
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

describe("/starter kb", () => {
	test("runs the knowledge-base step and saves the sources it returns", async () => {
		fs.mkdirSync(home("projects"));
		await starterCommand(starter(), "kb", {
			confirm: [true, true],
			select: [choose("Sessions under")],
			input: [vault("Notes"), "KnowledgeBase", "", home("projects")],
		});
		expect(readState().kb?.sources?.[0]).toMatchObject({ kbRef: "~/vaults/Notes/KnowledgeBase", gateDir: home("projects") });
		expect(readState().agentSkills).toBeUndefined();
	});

	test("declining records skipped", async () => {
		await starterCommand(starter(), "kb", { confirm: [false] });
		expect(readState().kb).toEqual({ status: "skipped" });
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
		expect(ui.notifications.map(n => n.type)).toEqual(["info", "info"]);
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
		const ui = scriptedUi({ confirm: [false, false, false, false, false] });
		start(starter(), ui);
		await settled(() => readState().tooling !== undefined);
		expect(ui.prompts.map(p => p.title).length).toBe(5);
		expect(readState()).toEqual({
			agentSkills: "skipped",
			models: "skipped",
			jev: "skipped",
			kb: { status: "skipped" },
			tooling: { status: "skipped", selected: [], results: {} },
		});
	});

	test("an existing install is only asked the steps it never answered", async () => {
		ompSetupDone();
		seedState({ agentSkills: "done", models: "done" });
		const ui = scriptedUi({ confirm: [false] });
		start(starter(), ui);
		await settled(() => readState().kb !== undefined);
		expect(ui.prompts).toHaveLength(1);
		expect(readState()).toEqual({ agentSkills: "done", models: "done", kb: { status: "skipped" } });
	});

	test("nothing is asked when every step was already answered", async () => {
		ompSetupDone();
		seedState({ agentSkills: "skipped", models: "skipped", kb: { status: "skipped" } });
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
		const ui = scriptedUi({ confirm: [false, false, false, false, false] });
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
		const ui = scriptedUi({ confirm: [false, false, false, false, false] });
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
