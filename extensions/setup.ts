// First-run setup wizard: a skill-kit picker (pstack, Matt Pocock, addy, spec-kit), Claude-first subscription presets,
// an optional TypeSafe Jev judge, and omp's memory backend with the commit gate.
// Runs automatically in the TUI until each step is done or skipped; `/starter` reruns it.
// `renderContextFile` composes the AGENTS.md this plugin writes: memory rules and the commit gate.
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { JEV_MODEL, setupJev } from "./lib/jev";
import { setupModels } from "./lib/routing";
import { EVERY_SESSION_FILE, gateSection, memorySection, setupMemory } from "./lib/memory";
import { HOME, STATE_FILE, readState, readTooling, saveTooling, tildify, updateState, type SetupState } from "./lib/state";
import type { ToolsUi } from "./lib/tooling";
import { checkPluginUpdates } from "./lib/plugin-updates";
import { setupSkillKits } from "./lib/skill-kits";

export interface WizardUi {
	notify(message: string, type?: "info" | "warning" | "error"): void;
	confirm(title: string, message: string): Promise<boolean>;
	select(title: string, options: string[]): Promise<string | undefined>;
	input(title: string, placeholder?: string): Promise<string | undefined>;
	/** HTML `<form>` dialog; absent on hosts that cannot draw one, which then get field-by-field prompts. */
	formDialog?(html: string): Promise<{ data: Record<string, unknown> } | undefined>;
}

export type Exec = (
	command: string,
	args: string[],
	options?: { timeout?: number },
) => Promise<{ stdout: string; stderr: string; code: number }>;

/**
 * The content of the AGENTS.md this plugin owns (`~/.omp/agent/AGENTS.md`): the memory rules for `memory.backend` and
 * the commit gate. Undefined when nothing belongs in it.
 */
export function renderContextFile(state: Pick<SetupState, "memory">): string | undefined {
	const sections = [
		state.memory?.status === "done" && memorySection(state.memory.backend),
		gateSection(state.memory),
	].filter((section): section is string => Boolean(section));
	return sections.length ? sections.join("\n") : undefined;
}

/** Writes `content` to `file`, backing up a differing existing file after confirmation. */
async function writeWithBackup(ui: WizardUi, file: string, content: string): Promise<boolean> {
	if (fs.existsSync(file)) {
		if (fs.readFileSync(file, "utf8") === content) return true;
		const ok = await ui.confirm("Replace existing file?", `${tildify(file)} already exists. Back it up and replace it?`);
		if (!ok) return false;
		fs.copyFileSync(file, `${file}.bak-${Date.now()}`);
	}
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
	return true;
}

/** Backs up and deletes an AGENTS.md nothing belongs in any more when the user agrees. False when the file stays. */
async function retireContextFile(ui: WizardUi, file: string): Promise<boolean> {
	if (!fs.existsSync(file)) return true;
	if (!(await ui.confirm("Delete AGENTS.md?", `Delete ${tildify(file)}? It holds rules for a memory backend that is no longer set up. A backup is kept next to it.`))) {
		return false;
	}
	fs.copyFileSync(file, `${file}.bak-${Date.now()}`);
	fs.rmSync(file);
	return true;
}

/** Brings the every-session AGENTS.md in line with `state`: writes it, or retires it when nothing belongs in it. False when the user kept the old file. */
async function writeContextFile(ui: WizardUi, state: Pick<SetupState, "memory">): Promise<boolean> {
	const content = renderContextFile(state);
	return content === undefined ? retireContextFile(ui, EVERY_SESSION_FILE) : writeWithBackup(ui, EVERY_SESSION_FILE, content);
}

// ── Wiring ──────────────────────────────────────────────────────────────────

export interface Steps {
	skills: boolean;
	models: boolean;
	jev: boolean;
	memory: boolean;
	tools: boolean;
}

/**
 * Steps the automatic wizard offers. The memory step, language tooling and the optional Jev judge are offered only to a
 * brand-new install (no state file existed before the wizard began); existing installs opt in with `/starter memory`,
 * `/starter tools` or `/starter jev`, so a new field never re-prompts them.
 */
export function startupSteps(state: SetupState, stateFileExisted: boolean): Steps | undefined {
	const steps: Steps = {
		skills: !state.agentSkills,
		models: !state.models,
		jev: !stateFileExisted,
		memory: !stateFileExisted,
		tools: !stateFileExisted,
	};
	return steps.skills || steps.models || steps.jev || steps.memory || steps.tools ? steps : undefined;
}

/** Whether omp's own first-run setup has not finished yet: it records `setupVersion` in config.yml when done. */
function ompSetupPending(): boolean {
	try {
		const match = /^setupVersion:\s*(\d+)/m.exec(fs.readFileSync(path.join(HOME, ".omp", "agent", "config.yml"), "utf8"));
		return !match || Number(match[1]) === 0;
	} catch {
		return true;
	}
}

export default function ompStarter(pi: ExtensionAPI): void {
	const exec: Exec = async (command, args, options) => {
		const result = await pi.exec(command, args, { timeout: options?.timeout ?? 30_000 });
		return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", code: result.code ?? 1 };
	};

	/** `fromCommand`: run by `/starter`, so installed steps may offer updates; the startup wizard never does. */
	async function run(ui: ToolsUi, steps: Steps, cwd: string, fromCommand = false): Promise<void> {
		if (steps.skills) {
			const next = await setupSkillKits(ui, exec, fromCommand);
			updateState({ agentSkills: readState().agentSkills === "done" && next === "skipped" ? "done" : next });
		}
		if (steps.models) {
			// Rerunning the models step must not move the judge off Jev.
			const next = await setupModels(ui, exec, readState().jev === "done" ? JEV_MODEL : undefined);
			updateState({ models: readState().models === "done" && next === "skipped" ? "done" : next });
		}
		if (steps.jev) {
			try {
				updateState({ jev: await setupJev(ui, exec, { current: readState().jev }) });
			} catch (error) {
				ui.notify(`Jev setup failed: ${String(error)}`, "error");
			}
		}
		if (steps.memory) {
			const state = readState();
			const memory = await setupMemory(ui, exec, state);
			updateState({ memory });
			// Rewrite the every-session AGENTS.md with the memory rules and the gate.
			if (memory.status === "done" && !(await writeContextFile(ui, { memory }))) {
				ui.notify(`${tildify(EVERY_SESSION_FILE)} was not updated, so it has no memory rules for the new backend.`, "warning");
			}
		}
		if (steps.tools) {
			try {
				// Dynamic on purpose: omp loads this extension on every start (and for subagents), and a failure to
				// load the large tooling modules must stay inside this step instead of breaking the other wizard steps.
				const { setupTools, resolveToolingEnvironment } = await import("./lib/tooling");
				// A corrupt state file stops here, before anything is offered or installed.
				const { tooling, problems } = readTooling();
				for (const problem of problems) ui.notify(problem, "warning");
				const environment = await resolveToolingEnvironment(cwd);
				await setupTools(ui, { cwd, ...environment, prior: tooling, persist: next => saveTooling(next) });
			} catch (error) {
				ui.notify(`Language tooling setup failed: ${String(error)}`, "error");
			}
		}
	}

	// Wizard waiting for omp's own first-run setup to finish.
	let deferred: (() => Promise<void>) | undefined;

	pi.on("session_start", (_event, ctx) => {
		if (ctx.agent?.kind === "sub" || ctx.mode !== "tui" || !ctx.hasUI) return;
		const steps = startupSteps(readState(), fs.existsSync(STATE_FILE));
		if (!steps) return;
		if (!ompSetupPending()) {
			void run(ctx.ui, steps, ctx.cwd).catch((error: unknown) => ctx.ui.notify(`Setup failed: ${String(error)}`, "error"));
			return;
		}
		// omp shows its own setup screens after session_start, and a dialog opened before them stays on
		// screen without keyboard focus. Start once omp records its setup as done, or at the first prompt.
		const fire = () => {
			deferred = undefined;
			ctx.clearTimer(timer);
			return run(ctx.ui, steps, ctx.cwd).catch((error: unknown) => ctx.ui.notify(`Setup failed: ${String(error)}`, "error"));
		};
		const timer = ctx.setInterval(() => {
			if (!ompSetupPending()) void fire();
		}, 1_000);
		deferred = fire;
	});

	pi.on("input", async () => {
		await deferred?.();
	});


	pi.registerCommand("starter", {
		description: "Setup or confirmed plugin updates. Args: updates | skills | models | jev | memory | tools (default: setup all)",
		handler: async (args, ctx) => {
			const which = args.trim();
			if (which === "updates") {
				if (!ctx.hasUI || ctx.agent?.kind === "sub") {
					ctx.ui.notify("Plugin updates require a main session with interactive user confirmation.", "warning");
					return;
				}
				try {
					await checkPluginUpdates(ctx.ui, exec);
				} catch (error) {
					ctx.ui.notify(error instanceof Error ? error.message : "Plugin update check failed.", "error");
				}
				return;
			}
			await run(
				ctx.ui,
				{
					skills: !which || which === "skills",
					models: !which || which === "models",
					jev: !which || which === "jev",
					memory: !which || which === "memory",
					tools: !which || which === "tools",
				},
				ctx.cwd,
				true,
			);
		},
	});
}
