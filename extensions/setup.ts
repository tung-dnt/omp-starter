// First-run setup wizard: a skill-kit picker (pstack, Matt Pocock, addy, spec-kit), Claude-first subscription presets,
// an optional TypeSafe Jev judge, omp's memory backend with the commit gate, and optional Obsidian vaults as docs.
// Runs automatically in the TUI until each step is done or skipped; `/starter` reruns it.
// `renderContextFile` composes every AGENTS.md this plugin writes: vault docs, memory rules and the commit gate.
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { JEV_MODEL, setupJev } from "./lib/jev";
import { setupModels } from "./lib/routing";
import { EVERY_SESSION_DIR, EVERY_SESSION_FILE, doneSources, existingFolder, overlapProblem, servesEverySession, sourceFolder } from "./lib/kb-sources";
import { gateSection, memorySection, setupMemory, withLiveBackend } from "./lib/memory";
import { HOME, STATE_FILE, expandHome, readState, readTooling, saveTooling, tildify, updateState, type KbSource, type KbState, type MemoryState, type SetupState } from "./lib/state";
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

const OBSIDIAN_REGISTRY = path.join(HOME, "Library/Application Support/obsidian/obsidian.json");
const ICLOUD_OBSIDIAN = path.join(HOME, "Library/Mobile Documents/iCloud~md~obsidian/Documents");
const KB_LINK = path.join(HOME, ".omp-kb");
const OTHER_FOLDER = "Other folder…";

// ── Obsidian knowledge base ─────────────────────────────────────────────────

/** Vaults Obsidian knows about (open one first, then most recent), plus iCloud vault folders. */
export function discoverVaults(): string[] {
	const found: string[] = [];
	try {
		const registry = JSON.parse(fs.readFileSync(OBSIDIAN_REGISTRY, "utf8")) as {
			vaults?: Record<string, { path: string; ts?: number; open?: boolean }>;
		};
		const vaults = Object.values(registry.vaults ?? {}).sort(
			(a, b) => Number(Boolean(b.open)) - Number(Boolean(a.open)) || (b.ts ?? 0) - (a.ts ?? 0),
		);
		for (const vault of vaults) found.push(vault.path);
	} catch {
		// Obsidian not installed or never opened.
	}
	if (fs.existsSync(ICLOUD_OBSIDIAN)) {
		for (const entry of fs.readdirSync(ICLOUD_OBSIDIAN, { withFileTypes: true })) {
			if (entry.isDirectory() && !entry.name.startsWith(".")) found.push(path.join(ICLOUD_OBSIDIAN, entry.name));
		}
	}
	// Registry entries can outlive deleted vaults; the iCloud container root is not itself a vault.
	return [...new Set(found)].filter(p => p !== ICLOUD_OBSIDIAN && fs.existsSync(p));
}

/** The docs section of a vault source: pointers into its knowledge base and the notes loaded in every session. */
function renderDocsSection(source: KbSource, pinned: string[]): string {
	const kbRef = source.kbRef;
	const kbAbs = expandHome(kbRef);
	const has = (rel: string) => fs.existsSync(path.join(kbAbs, rel));
	const pointers = [
		has("_index.md") && `- Start from the master map: \`${kbRef}/_index.md\`.`,
		has("projects") &&
			`- Before working a repo, read \`${kbRef}/projects/<repo>.md\` if it exists and follow its \`[[wikilinks]]\` (a link \`[[name]]\` resolves to \`name.md\` anywhere in the vault).`,
		kbAbs.includes("Mobile Documents") &&
			"- The vault syncs through iCloud, which may evict files to placeholders; a first read can stall briefly. Ignore \"conflicted copy\" duplicates.",
		"- Read KB files by plain path; `vault://…?op=` graph queries (backlinks, tags, search) need the Obsidian app running.",
	].filter(Boolean);
	const pinnedSection = pinned.length
		? `\n## Always-loaded notes\n\n${pinned.map(rel => `@${kbRef}/${rel}`).join("\n\n")}\n`
		: "";
	return `# Knowledge base (Obsidian docs)

KB root: \`${kbRef}/\`. Single source of truth for project context and conventions.
${pointers.length ? `\n${pointers.join("\n")}\n` : ""}${pinnedSection}`;
}

/** Notes a context file already loads from `kbRef` (its `@<kbRef>/<note>` lines), so a re-render keeps them. */
function pinnedNotes(file: string, kbRef: string): string[] {
	let text: string;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch {
		return [];
	}
	const prefix = `@${kbRef}/`;
	return text.split("\n").filter(line => line.startsWith(prefix)).map(line => line.slice(prefix.length).trim());
}

/**
 * The content of one AGENTS.md this plugin owns, or undefined when nothing belongs in it. A file holds the docs of the
 * vault source whose `contextFile` it is; the every-session file also holds the memory rules for `memory.backend` and the
 * commit gate. `pinned` replaces the notes the existing file loads (a source being added or changed).
 */
export function renderContextFile(file: string, state: Pick<SetupState, "kb" | "memory">, pinned?: string[]): string | undefined {
	const sources = doneSources(state.kb);
	const source = sources.find(s => s.contextFile === file);
	const everySession = file === EVERY_SESSION_FILE;
	const sections = [
		source && renderDocsSection(source, pinned ?? pinnedNotes(file, source.kbRef)),
		everySession && state.memory?.status === "done" && memorySection(state.memory.backend),
		everySession && gateSection(state.memory, sources.map(s => s.kbRef)),
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

const ADD_SOURCE = "Add or replace a knowledge base for a folder";
const REMOVE_SOURCE = "Remove a knowledge base";
const KB_DONE = "Done";
const EVERY_SESSION = "Every omp session";
const ONE_FOLDER = "Sessions under one folder";

function sourceLabel(s: KbSource): string {
	const scope = servesEverySession(s) ? "every session" : tildify(sourceFolder(s));
	return `${scope} → ${s.kbRef}`;
}

/**
 * Space-free symlink to `vault`, since `@` imports stop at whitespace. Reuses a link already pointing
 * there and never repoints an existing one (another knowledge base may depend on it).
 */
function vaultLink(vault: string): string {
	const slug = path.basename(vault).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "vault";
	const candidates = [KB_LINK, `${KB_LINK}-${slug}`, ...Array.from({ length: 8 }, (_, i) => `${KB_LINK}-${slug}-${i + 2}`)];
	for (const link of candidates) {
		const current = fs.lstatSync(link, { throwIfNoEntry: false });
		if (!current) {
			fs.symlinkSync(vault, link);
			return link;
		}
		if (current.isSymbolicLink() && fs.readlinkSync(link) === vault) return link;
	}
	throw new Error(`No free link name for ${vault} (tried ${tildify(KB_LINK)}-${slug}…)`);
}

/**
 * Asks for one vault + folder and writes the AGENTS.md that serves it. `sources` are the existing ones (same folder =
 * replace); `memory` decides what else the every-session file carries.
 */
async function addSource(ui: WizardUi, sources: KbSource[], memory: MemoryState | undefined): Promise<KbSource | undefined> {
	const vaults = discoverVaults();
	let vault: string | undefined;
	if (vaults.length) {
		const picked = await ui.select("Obsidian vault", [...vaults.map(tildify), OTHER_FOLDER]);
		if (!picked) return undefined;
		if (picked !== OTHER_FOLDER) vault = expandHome(picked);
	}
	vault ??= expandHome((await ui.input("Vault folder", "~/Documents/MyVault"))?.trim() ?? "");
	if (!vault || vault === HOME) return undefined;

	const sub = (await ui.input("Knowledge-base folder inside the vault", "KnowledgeBase"))?.trim() || "KnowledgeBase";
	const kbAbs = path.join(vault, sub);
	if (!fs.existsSync(kbAbs)) {
		const go = await ui.confirm(
			"Folder not found",
			`${tildify(kbAbs)} does not exist yet (a synced vault may still be downloading). Create it?`,
		);
		if (!go) return undefined;
		fs.mkdirSync(kbAbs, { recursive: true });
	}
	const link = /\s/.test(vault) ? vaultLink(vault) : undefined;
	const kbRootAbs = link ? path.join(link, sub) : kbAbs;

	const pinnedInput = await ui.input(
		"Notes to load in every session (optional, comma-separated, relative to the knowledge base)",
		"e.g. conventions/coding-standards.md",
	);
	const pinned = (pinnedInput ?? "")
		.split(",")
		.map(s => s.trim())
		.filter(rel => rel && !rel.startsWith("e.g."));
	const missing = pinned.filter(rel => !fs.existsSync(path.join(kbAbs, rel)));
	if (missing.length) ui.notify(`Not found yet (kept anyway): ${missing.join(", ")}`, "warning");

	// "Every session" only while it would be the sole knowledge base: its AGENTS.md loads everywhere.
	const everySessionAllowed = sources.every(servesEverySession);
	const scope = await ui.select("Load this knowledge base in", everySessionAllowed ? [EVERY_SESSION, ONE_FOLDER] : [ONE_FOLDER]);
	if (!scope) return undefined;
	let folder = EVERY_SESSION_DIR;
	if (scope === ONE_FOLDER) {
		const chosen = existingFolder(ui, (await ui.input("Folder", "~/projects"))?.trim() || "~/projects");
		if (!chosen) return undefined;
		folder = chosen;
	}
	const contextFile = path.join(folder, "AGENTS.md");
	const replaced = sources.find(s => s.contextFile === contextFile);
	const others = sources.filter(s => s !== replaced);
	const problem = overlapProblem(folder, others);
	if (problem) {
		ui.notify(`Can't add this knowledge base: ${problem}.`, "error");
		return undefined;
	}
	const kbRef = tildify(kbRootAbs);
	const source: KbSource = { vault: link ?? vault, kbRef, kbPaths: [...new Set([kbRootAbs, kbAbs])], contextFile };
	if (!(await writeContextFile(ui, contextFile, { kb: { status: "done", sources: [...others, source] }, memory }, pinned))) return undefined;
	ui.notify(`Knowledge base wired into ${tildify(contextFile)}. Takes effect in new sessions.`, "info");
	return source;
}

/** Backs up and deletes an AGENTS.md nothing belongs in any more when the user agrees. False when the file stays. */
async function retireContextFile(ui: WizardUi, file: string): Promise<boolean> {
	if (!fs.existsSync(file)) return true;
	if (!(await ui.confirm("Delete AGENTS.md?", `Delete ${tildify(file)}? It holds rules for a knowledge base or memory backend that is no longer set up. A backup is kept next to it.`))) {
		return false;
	}
	fs.copyFileSync(file, `${file}.bak-${Date.now()}`);
	fs.rmSync(file);
	return true;
}

/** Brings `file` in line with `state` through the composer: writes it, or retires it when nothing belongs in it. False when the user kept the old file. */
async function writeContextFile(ui: WizardUi, file: string, state: Pick<SetupState, "kb" | "memory">, pinned?: string[]): Promise<boolean> {
	const content = renderContextFile(file, state, pinned);
	return content === undefined ? retireContextFile(ui, file) : writeWithBackup(ui, file, content);
}

/**
 * Optional Obsidian docs. First run: one knowledge base. Later runs: a menu to add or replace one per folder or remove one.
 * Cancelling returns the current state unchanged. `memory` is what the every-session AGENTS.md carries besides docs.
 */
export async function setupKnowledgeBase(ui: WizardUi, current: KbState | undefined, memory?: MemoryState): Promise<KbState> {
	let sources = doneSources(current);
	if (!sources.length) {
		if (!(await ui.confirm("Obsidian docs", "Also use an Obsidian vault for docs and standards?"))) {
			return { status: "skipped" };
		}
		const added = await addSource(ui, [], memory);
		return added ? { status: "done", sources: [added] } : { status: "skipped" };
	}
	for (;;) {
		const choice = await ui.select(`Knowledge bases: ${sources.map(sourceLabel).join("; ")}`, [
			ADD_SOURCE,
			REMOVE_SOURCE,
			KB_DONE,
		]);
		if (!choice || choice === KB_DONE) break;
		if (choice === ADD_SOURCE) {
			const added = await addSource(ui, sources, memory);
			if (added) sources = [...sources.filter(s => s.contextFile !== added.contextFile), added];
		} else if (choice === REMOVE_SOURCE) {
			const picked = await ui.select("Remove which knowledge base?", sources.map(sourceLabel));
			const target = sources.find(s => sourceLabel(s) === picked);
			if (!target) continue;
			sources = sources.filter(s => s !== target);
			// The every-session file keeps its memory rules and gate; any other file has nothing left and is retired.
			if (!(await writeContextFile(ui, target.contextFile, { kb: { status: "done", sources }, memory }))) {
				ui.notify(`${tildify(target.contextFile)} kept; edit it so it no longer names the removed knowledge base.`, "warning");
			}
		}
	}
	return sources.length ? { status: "done", sources } : { status: "skipped" };
}

// ── Wiring ──────────────────────────────────────────────────────────────────

export interface Steps {
	skills: boolean;
	models: boolean;
	jev: boolean;
	memory: boolean;
	kb: boolean;
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
		kb: !state.kb,
		tools: !stateFileExisted,
	};
	return steps.skills || steps.models || steps.jev || steps.memory || steps.kb || steps.tools ? steps : undefined;
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
			// Rewrite the every-session AGENTS.md with the memory rules and the gate, next to the docs of a vault serving it.
			if (memory.status === "done" && !(await writeContextFile(ui, EVERY_SESSION_FILE, { kb: state.kb, memory }))) {
				ui.notify(`${tildify(EVERY_SESSION_FILE)} was not updated, so it has no memory rules for the new backend.`, "warning");
			}
		}
		if (steps.kb) {
			const state = readState();
			// A migrated memory state has no backend yet; the docs rewrite must not drop its memory rules.
			const memory = await withLiveBackend(exec, state.memory);
			if (memory?.backend && memory.backend !== state.memory?.backend) updateState({ memory });
			updateState({ kb: await setupKnowledgeBase(ui, state.kb, memory) });
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
		description: "Setup or confirmed plugin updates. Args: updates | skills | models | jev | memory | kb | tools (default: setup all)",
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
					kb: !which || which === "kb",
					tools: !which || which === "tools",
				},
				ctx.cwd,
				true,
			);
		},
	});
}
