import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startupSteps } from "../setup";
import { normalizeTooling, readTooling, saveTooling, type ToolingState } from "./state";
import { setupTools, resolveOmpPath, type ToolingContext, type ToolingDeps, type ToolsUi } from "./tooling";
import { effectiveEntry, inspectConfig } from "./tooling/config";
import type { ConfigEntry, IntegrationKind, IntegrationPlan, LanguageId, LanguagePlan, Runtime, ToolResult } from "./tooling/types";

const boxes: string[] = [];
afterEach(() => {
	for (const box of boxes.splice(0)) rmSync(box, { recursive: true, force: true });
});

interface Box {
	home: string;
	cwd: string;
	agentDir: string;
	stateFile: string;
	env: { PATH: string; HOME: string };
}

function sandbox(): Box {
	const home = mkdtempSync(join(tmpdir(), "omp-starter-tools-"));
	boxes.push(home);
	const cwd = join(home, "project");
	const agentDir = join(home, ".omp", "agent");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	return { home, cwd, agentDir, stateFile: join(agentDir, "omp-starter.json"), env: { PATH: process.env.PATH ?? "", HOME: home } };
}

const LABEL: Record<LanguageId, string> = { javascript: "JavaScript / TypeScript", python: "Python", go: "Go", rust: "Rust", cpp: "C / C++" };

/** A scripted wizard UI: picks languages in order, then answers the three consent questions. */
function scriptedUi(picks: LanguageId[], answers: { optional?: boolean; project?: boolean; proceed?: boolean } = {}) {
	const queue = [...picks.map(id => LABEL[id]), "Continue"];
	const confirms: { title: string; message: string }[] = [];
	const notes: { message: string; type?: string }[] = [];
	const statuses: (string | undefined)[] = [];
	let handler: ((data: string) => { consume?: boolean } | undefined) | undefined;
	let unsubscribed = 0;
	const ui: ToolsUi = {
		confirm: async (title, message) => {
			confirms.push({ title, message });
			if (title.startsWith("Language tooling")) return answers.optional ?? true;
			if (title.startsWith("Run programs")) return answers.project ?? true;
			return answers.proceed ?? true;
		},
		select: async (_title, options) => {
			const want = queue.shift();
			return options.find(option => (want === "Continue" ? option.startsWith("Continue") : want !== undefined && option.endsWith(want)));
		},
		notify: (message, type) => notes.push({ message, type }),
		input: async () => undefined,
		setStatus: (_key, text) => statuses.push(text),
		onTerminalInput: next => {
			handler = next;
			return () => {
				unsubscribed++;
				handler = undefined;
			};
		},
	};
	return {
		ui,
		confirms,
		notes,
		statuses,
		press: (data: string) => handler?.(data),
		get unsubscribed() {
			return unsubscribed;
		},
		get listening() {
			return handler !== undefined;
		},
	};
}

function fakeRuntime(failing: string[] = []) {
	const installs: string[] = [];
	const runtime = {
		install: async (request: { tool: string }) => {
			if (failing.includes(request.tool)) throw new Error(`could not download ${request.tool}`);
			installs.push(request.tool);
			return { status: "installed", destination: `/managed/${request.tool}`, manifest: {} };
		},
		dispose: async () => ({ terminated: [], survivors: [] }),
	} as unknown as Runtime;
	return { runtime, installs };
}

const ready = (launch?: ToolResult["command"]): ToolResult => ({ status: "ready", detail: "fixture passed", ...(launch ? { command: launch } : {}) });

type Judge = (plan: LanguagePlan, context: { approvedProjectLocal?: readonly string[] }) => Partial<Record<IntegrationKind, ToolResult>>;

/** Mirrors the real verifier's contract: blocked integrations keep the planner's result, others get the judged outcome. */
function verifier(judge?: Judge, after?: () => void) {
	const calls: LanguageId[] = [];
	const verify: ToolingDeps["verify"] = async (plan, context) => {
		calls.push(plan.language);
		const judged = judge?.(plan, context) ?? {};
		const out = {} as Record<IntegrationKind, ToolResult>;
		for (const kind of ["lsp", "dap"] as const) {
			const integration = plan[kind];
			out[kind] = integration.status === "blocked" ? integration.result : (judged[kind] ?? ready(integration.launch));
		}
		after?.();
		return { ...out, observations: [] };
	};
	return { verify, calls };
}

function reusePlan(box: Box, kind: IntegrationKind, name: string, entries: ConfigEntry[] = []): IntegrationPlan {
	const command = join(box.home, "bin", name);
	return { kind, tool: { name, sources: [] }, prerequisites: [], notes: [], status: "reuse", source: "path", launch: { command, args: [] }, entries };
}

function goEntries(box: Box): { lsp: ConfigEntry[]; dap: ConfigEntry[] } {
	return {
		lsp: [{ kind: "lsp", key: "gopls", value: { command: join(box.home, "bin", "gopls"), args: [], fileTypes: [".go"], rootMarkers: ["go.mod"] } }],
		dap: [{ kind: "dap", key: "delve", value: { command: join(box.home, "bin", "dlv"), args: ["dap"], languages: ["go"] } }],
	};
}

function planFor(box: Box, language: LanguageId, extra: Partial<LanguagePlan> = {}): LanguagePlan {
	const entries = goEntries(box);
	const name = language === "go" ? ["gopls", "delve"] : [`${language}-ls`, `${language}-dap`];
	return {
		language,
		lsp: reusePlan(box, "lsp", name[0] as string, language === "go" ? entries.lsp : []),
		dap: reusePlan(box, "dap", name[1] as string, language === "go" ? entries.dap : []),
		fixtures: [],
		projectLocalExecutables: [],
		...extra,
	};
}

function build(box: Box, deps: Partial<ToolingDeps>, options: { prior?: ToolingState; runtime?: Runtime } = {}) {
	const persisted: ToolingState[] = [];
	const context: ToolingContext = {
		cwd: box.cwd,
		agentDir: box.agentDir,
		ompPath: "/usr/bin/omp",
		home: box.home,
		env: box.env,
		...(options.prior === undefined ? {} : { prior: options.prior }),
		persist: next => {
			persisted.push(next);
			saveTooling(next, box.stateFile);
		},
		deps: {
			createRuntime: () => options.runtime ?? fakeRuntime().runtime,
			switches: async () => ({ lsp: true, debug: true }),
			...deps,
		},
	};
	return { context, persisted };
}

const saved = (box: Box) => JSON.parse(readFileSync(box.stateFile, "utf8"));
const effective = async (box: Box, kind: IntegrationKind, key: string) =>
	effectiveEntry(await inspectConfig({ cwd: box.cwd, agentDir: box.agentDir, home: box.home, env: box.env, pluginDirs: [] }), kind, key);

const OLD: ToolingState["results"] = {
	rust: { lsp: { status: "ready", detail: "earlier" }, dap: { status: "ready", detail: "earlier" } },
};

test("declining the optional step writes no tool or config files and keeps other setup answers", async () => {
	const box = sandbox();
	writeFileSync(box.stateFile, JSON.stringify({ kb: { status: "done" }, custom: { keep: 1 } }));
	const script = scriptedUi(["go"], { optional: false });
	let planned = 0;
	const { context } = build(box, { plan: async () => (planned++, planFor(box, "go")) });

	const state = await setupTools(script.ui, context);

	expect(state).toEqual({ status: "skipped", selected: [], results: {} });
	expect(planned).toBe(0);
	expect(readdirSync(box.agentDir).sort()).toEqual(["omp-starter.json"]);
	expect(saved(box)).toEqual({ kb: { status: "done" }, custom: { keep: 1 }, tooling: { status: "skipped", selected: [], results: {} } });
});

test("picking nothing is an explicit skip, and an earlier completed setup is not overwritten by a later decline", async () => {
	const box = sandbox();
	const none = build(box, { plan: async () => planFor(box, "go") });
	expect((await setupTools(scriptedUi([]).ui, none.context)).status).toBe("skipped");

	const done: ToolingState = { status: "done", selected: ["rust"], results: OLD };
	saveTooling(done, box.stateFile);
	const again = build(box, {}, { prior: done });
	expect(await setupTools(scriptedUi(["go"], { optional: false }).ui, again.context)).toEqual(done);
	expect(again.persisted).toEqual([]);
	expect(saved(box).tooling).toEqual(done);
});

test("ready needs a passing check and an effective approved config; other languages' results and keys survive", async () => {
	const box = sandbox();
	writeFileSync(box.stateFile, JSON.stringify({ kb: { status: "done" }, custom: { keep: 1 }, tooling: { status: "done", selected: ["rust"], results: OLD } }));
	const prior = readTooling(box.stateFile).tooling;
	const script = scriptedUi(["go"]);
	const checked = verifier();
	const { context } = build(box, { plan: async () => planFor(box, "go"), verify: checked.verify }, { prior });

	const state = await setupTools(script.ui, context);

	expect(state.status).toBe("done");
	expect(state.selected).toEqual(["go"]);
	expect(state.results.go?.lsp.status).toBe("ready");
	expect(state.results.go?.dap.status).toBe("ready");
	expect(state.results.rust).toEqual(OLD.rust);
	expect((await effective(box, "lsp", "gopls"))?.value.command).toBe(join(box.home, "bin", "gopls"));
	expect((await effective(box, "dap", "delve"))?.value.command).toBe(join(box.home, "bin", "dlv"));
	const file = saved(box);
	expect(file.kb).toEqual({ status: "done" });
	expect(file.custom).toEqual({ keep: 1 });
	expect(file.tooling.results.rust).toEqual(OLD.rust);
	expect(file.tooling.status).toBe("done");
	expect(script.listening).toBe(false);
	expect(script.statuses.at(-1)).toBeUndefined();
	expect(script.confirms.map(item => item.title).filter(title => title.startsWith("Install"))).toHaveLength(1);
});

test("a fixture pass never hides a conflicting existing config entry", async () => {
	const box = sandbox();
	const existing = JSON.stringify({ gopls: { command: "/opt/other/gopls", fileTypes: [".go"], rootMarkers: ["go.mod"] } }, null, 2);
	writeFileSync(join(box.agentDir, "lsp.json"), existing);
	const script = scriptedUi(["go"]);
	const { context } = build(box, { plan: async () => planFor(box, "go"), verify: verifier().verify });

	const state = await setupTools(script.ui, context);

	expect(state.status).toBe("incomplete");
	expect(state.results.go?.lsp.status).toBe("failed");
	expect(state.results.go?.dap.status).toBe("ready");
	expect(readFileSync(join(box.agentDir, "lsp.json"), "utf8")).toBe(existing);
	expect((await effective(box, "lsp", "gopls"))?.value.command).toBe("/opt/other/gopls");
	expect((await effective(box, "dap", "delve"))?.value.command).toBe(join(box.home, "bin", "dlv"));
});

test("a globally disabled integration is disclosed, left disabled and never marked usable", async () => {
	const box = sandbox();
	const script = scriptedUi(["go"]);
	const { context } = build(box, { plan: async () => planFor(box, "go"), verify: verifier().verify, switches: async () => ({ lsp: false, debug: true }) });

	const state = await setupTools(script.ui, context);

	expect(state.status).toBe("incomplete");
	expect(state.results.go?.lsp.status).toBe("unverified");
	expect(state.results.go?.lsp.detail).toContain("lsp.enabled");
	expect(state.results.go?.dap.status).toBe("ready");
	expect(await effective(box, "lsp", "gopls")).toBeUndefined();
	expect(script.confirms.find(item => item.title.startsWith("Install"))?.message).toContain("lsp.enabled");
});

test("when omp's settings cannot be read nothing is reported ready", async () => {
	const box = sandbox();
	const script = scriptedUi(["go"]);
	const { context } = build(box, { plan: async () => planFor(box, "go"), verify: verifier().verify, switches: async () => ({ lsp: undefined, debug: undefined }) });

	const state = await setupTools(script.ui, context);

	expect(state.status).toBe("incomplete");
	expect(state.results.go?.lsp.status).toBe("unverified");
	expect(state.results.go?.dap.status).toBe("unverified");
});

test("one group failing, or failing to inspect, does not erase another group's success", async () => {
	const box = sandbox();
	const script = scriptedUi(["go", "python", "rust"]);
	const checked = verifier(plan => (plan.language === "python" ? { dap: { status: "failed", detail: "debugger permission denied" } } : {}));
	const { context, persisted } = build(box, {
		plan: async language => {
			if (language === "rust") throw new Error("toolchain probe exploded");
			return planFor(box, language);
		},
		verify: checked.verify,
	});

	const state = await setupTools(script.ui, context);

	expect(state.status).toBe("incomplete");
	expect(state.results.go?.lsp.status).toBe("ready");
	expect(state.results.go?.dap.status).toBe("ready");
	expect(state.results.python?.lsp.status).toBe("ready");
	expect(state.results.python?.dap).toMatchObject({ status: "failed", detail: "debugger permission denied" });
	expect(state.results.rust?.lsp.status).toBe("failed");
	expect(state.results.rust?.lsp.detail).toContain("toolchain probe exploded");
	expect(saved(box).tooling.results.go.lsp.status).toBe("ready");
	expect(persisted.length).toBeGreaterThanOrEqual(3);
	expect(script.notes.at(-1)?.type).toBe("warning");
});

test("a missing SDK is reported and persisted without asking to install anything", async () => {
	const box = sandbox();
	const script = scriptedUi(["go"]);
	const { runtime, installs } = fakeRuntime();
	const missing = (kind: IntegrationKind): IntegrationPlan => ({
		kind,
		tool: { name: "gopls", sources: [] },
		prerequisites: [{ name: "go", requirement: "Go >= 1.22", satisfied: false, remediation: "Install Go yourself" }],
		notes: [],
		status: "blocked",
		result: { status: "needs-sdk", detail: "Go is not installed" },
	});
	const { context } = build(box, { plan: async () => ({ language: "go", lsp: missing("lsp"), dap: missing("dap"), fixtures: [], projectLocalExecutables: [] }), verify: verifier().verify }, { runtime });

	const state = await setupTools(script.ui, context);

	expect(state.status).toBe("incomplete");
	expect(state.results.go?.lsp).toEqual({ status: "needs-sdk", detail: "Go is not installed" });
	expect(installs).toEqual([]);
	expect(script.confirms.some(item => item.title.startsWith("Install"))).toBe(false);
	expect(saved(box).tooling.results.go.dap.status).toBe("needs-sdk");
});

test("a failed install is a failed integration, and installs that did land are disclosed", async () => {
	const box = sandbox();
	const script = scriptedUi(["go"]);
	const { runtime, installs } = fakeRuntime(["delve"]);
	const entries = goEntries(box);
	const install = (kind: IntegrationKind, tool: string, list: ConfigEntry[]): IntegrationPlan => ({
		kind,
		tool: { name: tool, version: "1.0.0", sources: ["https://github.com/example/release"], destination: `/managed/${tool}` },
		prerequisites: [],
		notes: [],
		status: "install",
		install: { tool, version: "1.0.0", operations: [] },
		launch: { command: join(box.home, "bin", tool), args: [] },
		entries: list,
	});
	const { context } = build(
		box,
		{ plan: async () => ({ language: "go", lsp: install("lsp", "gopls", entries.lsp), dap: install("dap", "delve", entries.dap), fixtures: [], projectLocalExecutables: [] }), verify: verifier().verify },
		{ runtime },
	);

	const state = await setupTools(script.ui, context);

	expect(installs).toEqual(["gopls"]);
	expect(state.results.go?.lsp.status).toBe("ready");
	expect(state.results.go?.dap.status).toBe("failed");
	expect(state.results.go?.dap.detail).toContain("could not download delve");
	expect(state.status).toBe("incomplete");
	expect(script.notes.at(-1)?.message).toContain("/managed/gopls");
	expect(await effective(box, "dap", "delve")).toBeUndefined();
});

test("Esc stops the run after the group in flight, keeps earlier results and a rerun finishes the job", async () => {
	const box = sandbox();
	const prior: ToolingState = {
		status: "incomplete",
		selected: ["go", "python"],
		results: {
			go: { lsp: { status: "ready", detail: "earlier go lsp" }, dap: { status: "ready", detail: "earlier go dap" } },
			python: { lsp: { status: "ready", detail: "earlier python lsp" }, dap: { status: "ready", detail: "earlier python dap" } },
		},
	};
	saveTooling(prior, box.stateFile);
	const script = scriptedUi(["go", "python"]);
	let consumed: unknown;
	const first = verifier(undefined, () => {
		consumed = script.press("\x1b");
	});
	const run = build(box, { plan: async language => planFor(box, language), verify: first.verify }, { prior });

	const state = await setupTools(script.ui, run.context);

	expect(consumed).toEqual({ consume: true });
	expect(first.calls).toHaveLength(1);
	expect(state.status).toBe("incomplete");
	expect(state.results.go?.lsp.detail).toBe("earlier go lsp");
	expect(state.results.python?.dap.status).toBe("ready");
	expect(await effective(box, "lsp", "gopls")).toBeUndefined();
	expect(script.unsubscribed).toBeGreaterThan(0);
	expect(script.listening).toBe(false);
	expect(script.statuses.at(-1)).toBeUndefined();
	expect(saved(box).tooling.status).toBe("incomplete");

	const retry = scriptedUi(["go", "python"]);
	const second = verifier();
	const rerun = build(box, { plan: async language => planFor(box, language), verify: second.verify }, { prior: readTooling(box.stateFile).tooling });
	const finished = await setupTools(retry.ui, rerun.context);
	expect(new Set(second.calls)).toEqual(new Set(["go", "python"]));
	expect(finished.status).toBe("done");
	expect(finished.results.go?.lsp.status).toBe("ready");
	expect((await effective(box, "lsp", "gopls"))?.value.command).toBe(join(box.home, "bin", "gopls"));
});

test("only Esc and Ctrl+C are consumed while an operation runs", async () => {
	const box = sandbox();
	const script = scriptedUi(["go"]);
	const results: unknown[] = [];
	const checked = verifier(undefined, () => {
		results.push(script.press("a"), script.press("\x1b[27u"));
	});
	const { context } = build(box, { plan: async () => planFor(box, "go"), verify: checked.verify });

	await setupTools(script.ui, context);

	expect(results).toEqual([undefined, { consume: true }]);
});

test("project-local tools run only after the exact paths are approved, and the approval outlives re-planning", async () => {
	const local = join(tmpdir(), "omp-starter-project", "node_modules", ".bin", "tsc");
	const judge: Judge = (_plan, context) => (context.approvedProjectLocal?.includes(local) ? {} : { lsp: { status: "unverified", detail: "project tool not approved" } });
	const make = async (approve: boolean) => {
		const box = sandbox();
		const script = scriptedUi(["go"], { project: approve });
		let plans = 0;
		const { context } = build(box, {
			plan: async (language, _plan, grants) => {
				plans++;
				return planFor(box, language, { projectLocalExecutables: grants.includes(local) ? [] : [local] });
			},
			verify: verifier(judge).verify,
		});
		const state = await setupTools(script.ui, context);
		return { state, plans, prompt: script.confirms.find(item => item.title.startsWith("Run programs")) };
	};

	const approved = await make(true);
	expect(approved.prompt?.message).toContain(local);
	expect(approved.plans).toBe(2);
	expect(approved.state.status).toBe("done");

	const declined = await make(false);
	expect(declined.plans).toBe(1);
	expect(declined.state.results.go?.lsp.status).toBe("unverified");
	expect(declined.state.status).toBe("incomplete");
});

test("without a located omp executable the real settings probe leaves everything unverified", async () => {
	const box = sandbox();
	const script = scriptedUi(["go"]);
	const { context } = build(box, { plan: async () => planFor(box, "go"), verify: verifier().verify });
	const { switches: _unused, ...deps } = context.deps ?? {};

	const state = await setupTools(script.ui, { ...context, ompPath: undefined, deps: { ...deps } });

	expect(state.status).toBe("incomplete");
	expect(state.results.go?.lsp.status).toBe("unverified");
});

test("a corrupt state file is an error that never resets the file, and saving keeps unrelated keys atomically", () => {
	const box = sandbox();
	writeFileSync(box.stateFile, "{oops");
	const tooling: ToolingState = { status: "skipped", selected: [], results: {} };
	expect(() => readTooling(box.stateFile)).toThrow();
	expect(() => saveTooling(tooling, box.stateFile)).toThrow();
	expect(readFileSync(box.stateFile, "utf8")).toBe("{oops");

	writeFileSync(box.stateFile, JSON.stringify({ models: "done", kb: { status: "skipped" } }));
	saveTooling(tooling, box.stateFile);
	expect(saved(box)).toEqual({ models: "done", kb: { status: "skipped" }, tooling });
	expect(readdirSync(box.agentDir)).toEqual(["omp-starter.json"]);

	writeFileSync(box.stateFile, "[1]");
	expect(() => saveTooling(tooling, box.stateFile)).toThrow();
});

test("invalid saved tooling records are reported and dropped, never promoted to ready", () => {
	const { tooling, problems } = normalizeTooling({
		status: "done",
		selected: ["go", "zig"],
		results: {
			go: { lsp: { status: "ready", detail: "ok" } },
			rust: { lsp: { status: "ready", detail: "ok" }, dap: { status: "bogus", detail: "?" } },
			python: { lsp: { status: "ready", detail: "ok" }, dap: { status: "failed", detail: "no" } },
		},
	});
	expect(tooling?.selected).toEqual(["go"]);
	expect(Object.keys(tooling?.results ?? {})).toEqual(["python"]);
	expect(problems.length).toBeGreaterThanOrEqual(3);
	expect(normalizeTooling({ status: "weird" }).tooling).toBeUndefined();
});

test("only a brand-new install is offered tooling and the Jev judge automatically", () => {
	const complete = { agentSkills: "done", models: "done", kb: { status: "done" } } as const;
	expect(startupSteps(complete, true)).toBeUndefined();
	expect(startupSteps({ ...complete, tooling: { status: "skipped", selected: [], results: {} } }, true)).toBeUndefined();
	expect(startupSteps({ agentSkills: "done", models: "done" }, true)).toEqual({ skills: false, models: false, jev: false, kb: true, tools: false });
	expect(startupSteps({}, true)).toMatchObject({ jev: false, tools: false });
	expect(startupSteps({}, false)).toEqual({ skills: true, models: true, jev: true, kb: true, tools: true });
});

test("the omp executable is the compiled binary itself, or the shim on PATH when running under Bun or Node", () => {
	const box = sandbox();
	const bin = join(box.home, "bin");
	mkdirSync(bin, { recursive: true });
	const shim = join(bin, "omp");
	const compiled = join(bin, "omp-compiled");
	for (const file of [shim, compiled]) {
		writeFileSync(file, "#!/bin/sh\nexit 0\n");
		chmodSync(file, 0o755);
	}
	expect(resolveOmpPath(compiled, { PATH: "" })).toBe(compiled);
	expect(resolveOmpPath("/opt/bun/bin/bun", { PATH: bin })).toBe(shim);
	expect(resolveOmpPath("/usr/bin/node", { PATH: `relative/dir:${bin}` })).toBe(shim);
	expect(resolveOmpPath("/opt/bun/bin/bun", { PATH: join(box.home, "empty") })).toBeUndefined();
});
