// Guided language tooling wizard (`/starter tools`): optional consent, five language groups, a disclosed
// plan, then install / verify / apply one group at a time with honest per-integration outcomes.
// It reuses the plan, runtime, verifier and configuration modules under ./tooling and adds no installer
// of its own. SDKs are inspected and reported, never installed; nothing here needs a provider login.
import { execFile } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import type { WizardUi } from "../setup";
import type { LanguageToolingResult, ToolingState } from "./state";
import { applyConfig, inspectConfig } from "./tooling/config";
import { planJavascript, planPython, planGo } from "./tooling/managed";
import { planCpp, planRust } from "./tooling/native";
import { absolutePathDirs, createRuntime, errorMessage, findExecutable, isExecutableFile } from "./tooling/runtime";
import {
	LANGUAGE_IDS,
	type BlockedPlan,
	type ConfigSnapshot,
	type IntegrationKind,
	type IntegrationPlan,
	type LanguageId,
	type LanguagePlan,
	type PlanContext,
	type Runtime,
	type ToolResult,
} from "./tooling/types";
import { verifyLanguage } from "./tooling/verify";

const execFileAsync = promisify(execFile);

/** WizardUi plus the optional public hooks used only while an operation runs. */
export interface ToolsUi extends WizardUi {
	setStatus?(key: string, text: string | undefined): void;
	onTerminalInput?(handler: (data: string) => { consume?: boolean; data?: string } | undefined): () => void;
}

/** omp's global switches for the two integrations; `undefined` means the value could not be read. */
export interface GlobalSwitches {
	lsp: boolean | undefined;
	debug: boolean | undefined;
}

/** Seams for the real planners, verifier and configuration merge; defaults are the production modules. */
export interface ToolingDeps {
	createRuntime: typeof createRuntime;
	inspectConfig: typeof inspectConfig;
	plan(language: LanguageId, context: PlanContext, grants: readonly string[]): Promise<LanguagePlan>;
	verify: typeof verifyLanguage;
	apply: typeof applyConfig;
	switches(request: { ompPath: string | undefined; cwd: string; signal: AbortSignal; env: NodeJS.ProcessEnv | undefined }): Promise<GlobalSwitches>;
}

export interface ToolingContext {
	/** The user's project: inspected statically, never a child's working directory. */
	cwd: string;
	/** The native omp agent directory (`resolveToolingEnvironment`): installs and config both live here. */
	agentDir: string;
	/** Absolute omp executable the verifier drives; undefined when none could be found. */
	ompPath: string | undefined;
	signal?: AbortSignal;
	/** Saved tooling state, read strictly by the caller before anything runs. */
	prior?: ToolingState;
	/** Writes the whole tooling field; called after every completed group. */
	persist(state: ToolingState): void | Promise<void>;
	home?: string;
	env?: NodeJS.ProcessEnv;
	deps?: Partial<ToolingDeps>;
}

const KINDS: readonly IntegrationKind[] = ["lsp", "dap"];
const KIND_LABEL: Readonly<Record<IntegrationKind, string>> = { lsp: "LSP", dap: "DAP" };
const SWITCH_KEY: Readonly<Record<IntegrationKind, string>> = { lsp: "lsp.enabled", dap: "debug.enabled" };
const LABELS: Readonly<Record<LanguageId, string>> = {
	javascript: "JavaScript / TypeScript",
	python: "Python",
	go: "Go",
	rust: "Rust",
	cpp: "C / C++",
};
const STATUS_KEY = "starter-tools";
const DETAIL_LIMIT = 600;
/** Esc and Ctrl+C, including their Kitty keyboard-protocol spellings. */
const CANCEL_KEYS = /^(\x1b|\x03|\x1b\[27(;\d+)?u|\x1b\[99;5u)$/;

function clip(text: string, max = DETAIL_LIMIT): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}

function toolResult(status: ToolResult["status"], detail: string, command?: ToolResult["command"]): ToolResult {
	return { status, detail: clip(detail), ...(command === undefined ? {} : { command }) };
}

// ── Environment ─────────────────────────────────────────────────────────────

/**
 * The omp executable that is running this wizard: a compiled binary is its own `process.execPath`, but an npm
 * install runs under Bun or Node, so the `omp` shim on PATH is the executable to drive.
 */
export function resolveOmpPath(execPath = process.execPath, env: NodeJS.ProcessEnv = process.env): string | undefined {
	const name = path.basename(execPath).toLowerCase().replace(/\.exe$/, "");
	if (name !== "bun" && name !== "node" && path.isAbsolute(execPath) && isExecutableFile(execPath)) return execPath;
	return findExecutable("omp", absolutePathDirs(env.PATH));
}

/** The native agent directory omp really reads user-level lsp/dap config from (profile and PI_CONFIG_DIR aware), plus the omp executable. */
export async function resolveToolingEnvironment(cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<{ agentDir: string; ompPath: string | undefined }> {
	const probe = await inspectConfig({ cwd, agentDir: path.join(os.homedir(), ".omp", "agent"), env });
	return { agentDir: probe.context.nativeDir, ompPath: resolveOmpPath(process.execPath, env) };
}

async function readSwitch(ompPath: string, key: string, cwd: string, signal: AbortSignal, env: NodeJS.ProcessEnv | undefined): Promise<boolean | undefined> {
	try {
		const { stdout } = await execFileAsync(ompPath, ["config", "get", key], { cwd, env: env ?? process.env, timeout: 20_000, signal, maxBuffer: 64 * 1024 });
		const value = stdout.trim().toLowerCase();
		return value === "true" ? true : value === "false" ? false : undefined;
	} catch {
		return undefined;
	}
}

const DEFAULT_DEPS: ToolingDeps = {
	createRuntime,
	inspectConfig,
	plan: (language, context, grants) => {
		const options = { approvedProjectLocal: grants };
		switch (language) {
			case "javascript":
				return planJavascript(context, options);
			case "python":
				return planPython(context, options);
			case "go":
				return planGo(context, options);
			case "rust":
				return planRust(context);
			case "cpp":
				return planCpp(context);
		}
	},
	verify: verifyLanguage,
	apply: applyConfig,
	switches: async ({ ompPath, cwd, signal, env }) =>
		ompPath === undefined
			? { lsp: undefined, debug: undefined }
			: { lsp: await readSwitch(ompPath, SWITCH_KEY.lsp, cwd, signal, env), debug: await readSwitch(ompPath, SWITCH_KEY.dap, cwd, signal, env) },
};

// ── Operation guard (status line + Esc/Ctrl+C) ──────────────────────────────

async function operate<T>(ui: ToolsUi, controller: AbortController, label: string, run: (progress: (message: string) => void) => Promise<T>): Promise<T> {
	const show = (message: string): void => ui.setStatus?.(STATUS_KEY, `${message} (Esc to cancel)`);
	const unsubscribe = ui.onTerminalInput?.(data => {
		if (!CANCEL_KEYS.test(data)) return undefined;
		controller.abort();
		return { consume: true };
	});
	show(label);
	try {
		return await run(show);
	} finally {
		unsubscribe?.();
		ui.setStatus?.(STATUS_KEY, undefined);
	}
}

// ── Plan disclosure ─────────────────────────────────────────────────────────

function describe(language: LanguageId, plan: LanguagePlan, snapshot: ConfigSnapshot, shared: Map<string, LanguageId>): string[] {
	const lines = [LABELS[language]];
	for (const kind of KINDS) {
		const integration: IntegrationPlan = plan[kind];
		const version = integration.tool.version === undefined ? "" : ` ${integration.tool.version}`;
		const name = `${KIND_LABEL[kind]} ${integration.tool.name}${version}`;
		if (integration.status === "blocked") {
			lines.push(`  ${name}: not possible — ${integration.result.status}: ${clip(integration.result.detail, 300)}`);
		} else if (integration.status === "reuse") {
			lines.push(`  ${name}: use the existing ${integration.source} tool ${integration.launch.command}; nothing is installed`);
		} else {
			const destination = integration.tool.destination ?? `${integration.tool.name}@${integration.tool.version ?? ""}`;
			const owner = shared.get(destination);
			if (owner !== undefined) {
				lines.push(`  ${name}: shared with ${LABELS[owner]} — installed once into ${destination}`);
			} else {
				shared.set(destination, language);
				lines.push(`  ${name}: install into ${destination}`);
				lines.push(`    from ${integration.tool.sources.map(source => clip(source, 200)).join(", ")}`);
			}
		}
		for (const need of integration.prerequisites) {
			const found = need.found === undefined ? "" : ` (found ${need.found.path}${need.found.version === undefined ? "" : ` ${need.found.version}`})`;
			const missing = need.remediation === undefined ? "" : `: ${clip(need.remediation, 200)}`;
			lines.push(`    needs ${need.name} ${need.requirement}: ${need.satisfied ? `ok${found}` : `MISSING${missing}`}`);
		}
		if (integration.status !== "blocked") {
			const keys = integration.entries.filter(entry => entry.kind === kind).map(entry => entry.key);
			lines.push(
				keys.length > 0
					? `    config: add ${keys.join(", ")} to ${snapshot.targets[kind].path}`
					: "    config: no change needed",
			);
		}
		for (const note of integration.notes.slice(0, 3)) lines.push(`    note: ${clip(note, 240)}`);
	}
	return lines;
}

function switchNotes(switches: GlobalSwitches): string[] {
	const notes: string[] = [];
	for (const kind of KINDS) {
		const value = kind === "lsp" ? switches.lsp : switches.debug;
		const key = SWITCH_KEY[kind];
		if (value === false) {
			notes.push(`Your omp setting ${key} is false. It stays unchanged, so ${KIND_LABEL[kind]} results are reported as not usable until you enable it yourself.`);
		} else if (value === undefined) {
			notes.push(`omp setting ${key} could not be read, so ${KIND_LABEL[kind]} cannot be reported ready.`);
		}
	}
	return notes;
}


// ── Selection ───────────────────────────────────────────────────────────────

async function chooseLanguages(ui: ToolsUi): Promise<LanguageId[] | undefined> {
	const picked = new Set<LanguageId>();
	for (;;) {
		const options = [
			...LANGUAGE_IDS.map(id => `${picked.has(id) ? "[x]" : "[ ]"} ${LABELS[id]}`),
			picked.size === 0 ? "Continue (nothing selected)" : `Continue with ${picked.size} selected`,
		];
		const choice = await ui.select("Language tooling: pick a language to toggle it, then Continue", options);
		if (choice === undefined) return undefined;
		const index = options.indexOf(choice);
		if (index === LANGUAGE_IDS.length) return LANGUAGE_IDS.filter(id => picked.has(id));
		const id = LANGUAGE_IDS[index];
		if (id === undefined) continue;
		if (picked.has(id)) picked.delete(id);
		else picked.add(id);
	}
}

// ── Execution of one group ──────────────────────────────────────────────────

interface Run {
	readonly context: ToolingContext;
	readonly deps: ToolingDeps;
	readonly runtime: Runtime;
	readonly signal: AbortSignal;
	readonly progress: (message: string) => void;
	readonly grants: readonly string[];
	readonly switches: GlobalSwitches;
	snapshot: ConfigSnapshot;
	/** Installs this run published (and keeps; there is no rollback). */
	readonly installed: string[];
}

function blocked(integration: IntegrationPlan, result: ToolResult): BlockedPlan {
	return { kind: integration.kind, tool: integration.tool, prerequisites: integration.prerequisites, notes: integration.notes, status: "blocked", result };
}

function replaceIntegration(plan: LanguagePlan, kind: IntegrationKind, integration: BlockedPlan): LanguagePlan {
	return kind === "lsp" ? { ...plan, lsp: integration } : { ...plan, dap: integration };
}

async function runGroup(plan: LanguagePlan, run: Run): Promise<{ result: LanguageToolingResult; interrupted: boolean }> {
	const { signal } = run;
	let working = plan;
	for (const kind of KINDS) {
		const integration = working[kind];
		if (integration.status !== "install") continue;
		if (signal.aborted) {
			working = replaceIntegration(working, kind, blocked(integration, toolResult("unverified", "Cancelled before this tool was installed.")));
			continue;
		}
		try {
			run.progress(`Installing ${integration.tool.name}`);
			const done = await run.runtime.install(integration.install, { signal, onProgress: run.progress });
			if (done.status === "installed") run.installed.push(`${integration.tool.name} ${integration.install.version} at ${done.destination}`);
		} catch (error) {
			const cancelled = signal.aborted;
			const detail = cancelled ? "Installation was cancelled; nothing was verified." : `Installation failed: ${errorMessage(error)}`;
			working = replaceIntegration(working, kind, blocked(integration, toolResult(cancelled ? "unverified" : "failed", detail)));
		}
	}

	let verified: ToolResult[];
	try {
		const verification = await run.deps.verify(working, {
			ompPath: run.context.ompPath ?? "",
			cwd: run.context.cwd,
			config: run.snapshot,
			consent: true,
			approvedProjectLocal: run.grants,
			signal,
			...(run.context.env === undefined ? {} : { env: run.context.env }),
			onProgress: run.progress,
		});
		verified = [verification.lsp, verification.dap];
	} catch (error) {
		const detail = signal.aborted ? "Verification was cancelled." : `Verification could not run: ${errorMessage(error)}`;
		verified = [toolResult(signal.aborted ? "unverified" : "failed", detail), toolResult(signal.aborted ? "unverified" : "failed", detail)];
	}
	const results: Record<IntegrationKind, ToolResult> = { lsp: verified[0] as ToolResult, dap: verified[1] as ToolResult };

	// A passing fixture is not enough: omp must actually use the integration.
	for (const kind of KINDS) {
		if (results[kind].status !== "ready") continue;
		const on = kind === "lsp" ? run.switches.lsp : run.switches.debug;
		if (on === true) continue;
		const key = SWITCH_KEY[kind];
		const why =
			on === false
				? `Your omp setting ${key} is false, so omp will not use it. The setting was left unchanged; run "omp config set ${key} true" and /starter tools again.`
				: `omp setting ${key} could not be read, so it is unknown whether omp will use it.`;
		results[kind] = toolResult("unverified", `Passed the disposable check. ${why}`, results[kind].command);
	}

	const wanted = KINDS.filter(kind => results[kind].status === "ready").flatMap(kind => {
		const integration = working[kind];
		return integration.status === "blocked" ? [] : integration.entries.filter(entry => entry.kind === kind);
	});
	if (wanted.length > 0) {
		const kinds = [...new Set(wanted.map(entry => entry.kind))];
		if (signal.aborted) {
			for (const kind of kinds) results[kind] = toolResult("unverified", "Passed the disposable check, but the run was cancelled before the configuration was applied.", results[kind].command);
		} else {
			try {
				run.progress(`Applying ${LABELS[plan.language]} configuration`);
				const applied = await run.deps.apply(run.snapshot, { entries: wanted });
				run.snapshot = applied.snapshot;
				const rejected = new Set<IntegrationKind>();
				for (const outcome of applied.outcomes) {
					const previous = results[outcome.kind];
					if (outcome.status !== "applied" && outcome.status !== "unchanged") {
						rejected.add(outcome.kind);
						results[outcome.kind] = toolResult("failed", `Passed the disposable check, but ${outcome.key} is not enabled: ${outcome.detail}`, previous.command);
					} else if (!rejected.has(outcome.kind)) {
						results[outcome.kind] = toolResult("ready", `${clip(previous.detail, 280)} ${outcome.detail}`, previous.command);
					}
				}
			} catch (error) {
				for (const kind of kinds) results[kind] = toolResult("failed", `Passed the disposable check, but the configuration was not applied: ${errorMessage(error)}`, results[kind].command);
			}
		}
	}
	return { result: { lsp: results.lsp, dap: results.dap }, interrupted: signal.aborted };
}

// ── Summary ─────────────────────────────────────────────────────────────────

function summarize(state: ToolingState, installed: readonly string[], extra: readonly string[]): string {
	const lines = [state.status === "done" ? "Language tooling: done — every selected group is ready." : "Language tooling: incomplete."];
	for (const id of state.selected) {
		const record = state.results[id];
		if (record === undefined) {
			lines.push(`${LABELS[id]}: not run`);
			continue;
		}
		for (const kind of KINDS) lines.push(`${LABELS[id]} ${KIND_LABEL[kind]}: ${record[kind].status} — ${clip(record[kind].detail, 220)}`);
	}
	if (installed.length > 0) lines.push(`Installed this run (kept; nothing is rolled back): ${installed.join("; ")}`);
	lines.push(...extra);
	if (state.status !== "done") lines.push("Run /starter tools to retry; tools already installed are re-verified and reused, never replaced.");
	return lines.join("\n");
}

// ── Entry point ─────────────────────────────────────────────────────────────

export async function setupTools(ui: ToolsUi, context: ToolingContext): Promise<ToolingState> {
	const deps: ToolingDeps = { ...DEFAULT_DEPS, ...context.deps };
	const prior = context.prior;
	const controller = new AbortController();
	const relay = (): void => controller.abort();
	if (context.signal?.aborted) controller.abort();
	else context.signal?.addEventListener("abort", relay, { once: true });
	const { signal } = controller;

	/** Declining or backing out writes no tool or config file; an earlier completed setup stays as it was. */
	const skip = async (): Promise<ToolingState> => {
		if (prior?.status === "done") return prior;
		const state: ToolingState = { status: "skipped", selected: [], results: { ...prior?.results } };
		await context.persist(state);
		return state;
	};

	const runtime = deps.createRuntime({
		agentDir: context.agentDir,
		cwd: context.cwd,
		signal,
		...(context.env === undefined ? {} : { env: context.env }),
	});
	try {
		const consent = await ui.confirm(
			"Language tooling (optional)",
			"Set up language servers (LSP) and debuggers (DAP) for the languages you pick? You choose the languages, review exactly what would be downloaded or changed, and confirm again before anything runs. Existing SDKs are used and never installed or changed, and no login is needed.",
		);
		if (!consent) return await skip();
		const selected = await chooseLanguages(ui);
		if (selected === undefined || selected.length === 0) {
			if (selected?.length === 0) ui.notify("No language selected; language tooling skipped.", "info");
			return await skip();
		}

		const configContext = { cwd: context.cwd, agentDir: context.agentDir, ...(context.home === undefined ? {} : { home: context.home }), ...(context.env === undefined ? {} : { env: context.env }) };
		const inspected = await operate(ui, controller, "Inspecting your SDKs and tool configuration", async () => {
			const snapshot = await deps.inspectConfig(configContext);
			const plans = new Map<LanguageId, LanguagePlan | string>();
			const planAll = async (grants: readonly string[], only?: readonly LanguageId[]): Promise<void> => {
				for (const language of selected) {
					if (signal.aborted) return;
					if (only !== undefined && !only.includes(language)) continue;
					try {
						plans.set(language, await deps.plan(language, { runtime, config: snapshot }, grants));
					} catch (error) {
						plans.set(language, errorMessage(error));
					}
				}
			};
			await planAll([]);
			const switches = await deps.switches({ ompPath: context.ompPath, cwd: context.cwd, signal, env: context.env });
			return { snapshot, plans, planAll, switches };
		});
		if (signal.aborted) {
			ui.notify("Language tooling was cancelled while inspecting; nothing was installed or changed.", "warning");
			return await skip();
		}
		const { plans, planAll, switches } = inspected;
		let { snapshot } = inspected;

		// Project-local programs run only after the user approves those exact paths; the planners then re-probe.
		const disclosed = [...new Set([...plans.values()].flatMap(plan => (typeof plan === "string" ? [] : plan.projectLocalExecutables)))].sort();
		let grants: string[] = [];
		if (disclosed.length > 0) {
			const allowed = await ui.confirm(
				"Run programs from your project?",
				`These tools live inside your project, so running them runs project code (version probes and the disposable fixture check):\n${disclosed.map(file => `  ${file}`).join("\n")}\nApprove exactly these paths? If not, they are never run and the affected integrations stay unverified.`,
			);
			if (allowed) {
				grants = disclosed;
				const managed = selected.filter(id => id === "javascript" || id === "python" || id === "go");
				await operate(ui, controller, "Re-inspecting with your approved project tools", () => planAll(grants, managed));
				if (signal.aborted) {
					ui.notify("Language tooling was cancelled while inspecting; nothing was installed or changed.", "warning");
					return await skip();
				}
			}
		}

		const shared = new Map<string, LanguageId>();
		const planned = selected.flatMap(language => {
			const plan = plans.get(language);
			return plan === undefined || typeof plan === "string" ? [] : [plan];
		});
		const disclosure = [
			...selected.flatMap(language => {
				const plan = plans.get(language);
				if (typeof plan === "string") return [LABELS[language], `  could not be inspected: ${clip(plan, 300)}`];
				return plan === undefined ? [] : describe(language, plan, snapshot, shared);
			}),
			...(disclosed.length > 0 ? [grants.length > 0 ? "Approved project programs: " + grants.join(", ") : "Project programs not approved: they will not run."] : []),
			...switchNotes(switches),
			"Verification builds disposable fixtures with your existing SDKs in a private temporary directory and removes them afterwards. Missing SDKs are reported, never installed.",
		];
		if (planned.some(plan => KINDS.some(kind => plan[kind].status !== "blocked"))) {
			const go = await ui.confirm("Install, verify and apply?", `${disclosure.join("\n")}\n\nInstall the listed tools, verify them, and add the listed configuration?`);
			if (!go) {
				ui.notify("Nothing was installed or changed.", "info");
				return await skip();
			}
		} else {
			ui.notify(`${disclosure.join("\n")}\nNothing can be installed or verified yet.`, "warning");
		}

		const results: ToolingState["results"] = { ...prior?.results };
		const completed = new Set<LanguageId>();
		const installed: string[] = [];
		const extra: string[] = [];
		let persistFailure: string | undefined;
		const state = (status: ToolingState["status"]): ToolingState => ({ status, selected: [...selected], results: { ...results } });
		const save = async (status: ToolingState["status"]): Promise<void> => {
			try {
				await context.persist(state(status));
				persistFailure = undefined;
			} catch (error) {
				persistFailure = errorMessage(error);
			}
		};

		await operate(ui, controller, "Setting up language tooling", async progress => {
			snapshot = await deps.inspectConfig(configContext);
			const run: Run = { context, deps, runtime, signal, progress, grants, switches, snapshot, installed };
			for (const language of selected) {
				const plan = plans.get(language);
				if (typeof plan === "string") {
					const failure = toolResult("failed", `Could not inspect this language: ${plan}`);
					results[language] = { lsp: failure, dap: failure };
					completed.add(language);
					await save("incomplete");
					continue;
				}
				if (plan === undefined) continue;
				if (signal.aborted) break;
				progress(`Setting up ${LABELS[language]}`);
				const { result, interrupted } = await runGroup(plan, run);
				const before = results[language];
				// A cancelled rerun keeps what an earlier run already proved; it never trusts it for this run's status.
				results[language] = {
					lsp: interrupted && result.lsp.status !== "ready" && before?.lsp.status === "ready" ? before.lsp : result.lsp,
					dap: interrupted && result.dap.status !== "ready" && before?.dap.status === "ready" ? before.dap : result.dap,
				};
				if (!interrupted) completed.add(language);
				await save("incomplete");
			}
		});

		const cancelled = signal.aborted;
		const done = !cancelled && selected.every(id => completed.has(id) && results[id]?.lsp.status === "ready" && results[id]?.dap.status === "ready");
		const final = state(done ? "done" : "incomplete");
		await save(final.status);
		if (cancelled) extra.push("The run was cancelled: remaining groups were not started, and earlier results above are kept.");
		if (persistFailure !== undefined) extra.push(`The results could not be saved: ${persistFailure}`);
		ui.notify(summarize(final, installed, extra), done ? "info" : "warning");
		return final;
	} finally {
		context.signal?.removeEventListener("abort", relay);
		try {
			await runtime.dispose();
		} catch (error) {
			ui.notify(`Language tooling cleanup could not be confirmed: ${errorMessage(error)}`, "warning");
		}
	}
}
