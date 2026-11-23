// First-run setup wizard: optional agent-skills install, Claude-first subscription presets, an optional
// TypeSafe Jev judge, and an Obsidian vault as omp's knowledge base and memory.
// Runs automatically in the TUI until each step is done or skipped; `/starter` reruns it.
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { JEV_MODEL, setupJev } from "./lib/jev";
import { setupModels } from "./lib/routing";
import { EVERY_SESSION_DIR, doneSources, overlapProblem, servesEverySession, sourceFolder } from "./lib/kb-sources";
import { HOME, STATE_FILE, expandHome, readState, readTooling, saveTooling, tildify, updateState, type KbSource, type KbState, type SetupState } from "./lib/state";
import type { ToolsUi } from "./lib/tooling";
import { AGENT_SKILLS_PLUGIN, checkPluginUpdates, readPluginInstallations } from "./lib/plugin-updates";

export interface WizardUi {
	notify(message: string, type?: "info" | "warning" | "error"): void;
	confirm(title: string, message: string): Promise<boolean>;
	select(title: string, options: string[]): Promise<string | undefined>;
	input(title: string, placeholder?: string): Promise<string | undefined>;
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

// ── agent-skills ────────────────────────────────────────────────────────────

/** Startup only detects presence; explicit commands may offer a confirmed update. */
export async function setupAgentSkills(ui: WizardUi, exec: Exec, offerUpgrade = false): Promise<"done" | "skipped"> {
	const installations = await readPluginInstallations(exec);
	if (installations.some(row => row.key === "agent-skills")) {
		if (offerUpgrade) await checkPluginUpdates(ui, exec, { keys: ["agent-skills"], installations });
		return "done";
	}
	const ok = await ui.confirm(
		"agent-skills",
		`Install ${AGENT_SKILLS_PLUGIN.repo}? Engineering-workflow skills, agents and commands (/spec, /plan, /build, /review, /ship).`,
	);
	if (!ok) return "skipped";
	const add = await exec("omp", ["plugin", "marketplace", "add", AGENT_SKILLS_PLUGIN.repo], { timeout: 120_000 });
	if (add.code !== 0 && !/already exists/.test(add.stdout + add.stderr)) throw new Error(`Cannot add the agent-skills marketplace (native exit ${add.code}).`);
	const install = await exec("omp", ["plugin", "install", "--scope", "user", AGENT_SKILLS_PLUGIN.id], { timeout: 300_000 });
	if (install.code !== 0) throw new Error(`Cannot install agent-skills (native exit ${install.code}); installed state may have changed.`);
	const after = await readPluginInstallations(exec);
	if (!after.some(row => row.key === "agent-skills" && row.kind === "marketplace" && row.scope === "user")) throw new Error("Native installation finished, but agent-skills could not be verified.");
	ui.notify(`Installed ${AGENT_SKILLS_PLUGIN.repo}. Restart your OMP session to load its extensions.`, "info");
	return "done";
}

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

export function renderContextFile(kbRef: string, kbAbs: string, pinned: string[], gate: boolean): string {
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
	const commitGate = gate
		? `\n### Commit gate\n\n\`git commit\` is blocked until a \`${kbRef}/\` file has been written in the session (\`kb_remember\`, \`write\` or \`edit\`). Save the relevant facts first; for commits with no new facts (typos, formatting) put \`[skip-mem]\` in the commit message.\n`
		: "";
	return `# Knowledge base (Obsidian)

KB root: \`${kbRef}/\`. Single source of truth for project context, conventions, and long-term memory.
${pointers.length ? `\n${pointers.join("\n")}\n` : ""}${pinnedSection}
## Memory

Per-fact memory notes live in \`${kbRef}/_memory/<slug>.md\`. The \`kb-memory\` extension injects the \`## Global\` section of \`${kbRef}/_memory/MEMORY.md\` plus the section for the current repo as a "Memory index" block; read the file for other scopes. Search the notes with \`kb_recall\`.

### Saving a memory

When you learn a durable fact (decision, gotcha, convention, user preference, resolved failure), save it with \`kb_remember\`: it writes \`${kbRef}/_memory/<slug>.md\` and its index line under the section for the current repo (\`scope\` overrides; facts that apply across projects go to \`Global\`). Use \`mode: "update"\` for an existing note after reading it. Without the tool, use \`write\`/\`edit\` (not shell heredocs):

1. Create or update \`${kbRef}/_memory/<kebab-slug>.md\`:
   \`\`\`markdown
   ---
   name: <kebab-slug>
   description: <one-line hook>
   metadata:
     node_type: memory
     type: project | feedback | reference | user
     modified: <ISO timestamp>
   ---

   <fact>. **Why:** <reason>. **How to apply:** <rule>. Link related notes with [[wikilinks]].
   \`\`\`
2. Add or update its line in \`${kbRef}/_memory/MEMORY.md\` under the \`## <Scope>\` section whose heading or \`<!-- repos: … -->\` list names the current repo (add a \`## <repo>\` section if none matches); facts that apply across projects go under \`## Global\`. Line format: \`- [Title](<slug>.md) — <hook, ≤ ~60 chars>\`.

Update stale memories instead of adding contradicting ones.
${commitGate}`;
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

/** Asks for one vault + folder and writes its AGENTS.md. `sources` are the existing ones (same folder = replace). */
async function addSource(ui: WizardUi, sources: KbSource[]): Promise<KbSource | undefined> {
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
			`${tildify(kbAbs)} does not exist yet (a synced vault may still be downloading). Create it with an empty memory index?`,
		);
		if (!go) return undefined;
	}
	const link = /\s/.test(vault) ? vaultLink(vault) : undefined;
	const kbRootAbs = link ? path.join(link, sub) : kbAbs;

	const memoryIndex = path.join(kbAbs, "_memory", "MEMORY.md");
	if (!fs.existsSync(memoryIndex)) {
		fs.mkdirSync(path.dirname(memoryIndex), { recursive: true });
		fs.writeFileSync(memoryIndex, "## Global\n");
	}

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
	let gateDir = HOME;
	if (scope === ONE_FOLDER) {
		const rawDir = expandHome((await ui.input("Folder", "~/projects"))?.trim() || "~/projects");
		if (!path.isAbsolute(rawDir) || !fs.statSync(rawDir, { throwIfNoEntry: false })?.isDirectory()) {
			ui.notify(`${rawDir} is not an existing absolute folder. Use a path like ~/projects.`, "error");
			return undefined;
		}
		folder = path.resolve(rawDir);
		gateDir = folder;
	}
	const contextFile = path.join(folder, "AGENTS.md");
	const replaced = sources.find(s => s.contextFile === contextFile);
	const problem = overlapProblem(folder, sources.filter(s => s !== replaced));
	if (problem) {
		ui.notify(`Can't add this knowledge base: ${problem}.`, "error");
		return undefined;
	}
	const gate = await ui.confirm(
		"Commit gate",
		`Block agent \`git commit\` under ${tildify(gateDir)} until a note in this knowledge base was written in the session ([skip-mem] bypasses)?`,
	);
	const kbRef = tildify(kbRootAbs);
	if (!(await writeWithBackup(ui, contextFile, renderContextFile(kbRef, kbAbs, pinned, gate)))) return undefined;
	ui.notify(`Knowledge base wired into ${tildify(contextFile)}. Takes effect in new sessions.`, "info");
	return {
		vault: link ?? vault,
		kbRef,
		kbPaths: [...new Set([kbRootAbs, kbAbs])],
		contextFile,
		...(gate ? { gateDir } : {}),
	};
}

/** Backs up and deletes a removed source's AGENTS.md when the user agrees; the vault is never touched. */
async function retireContextFile(ui: WizardUi, file: string): Promise<void> {
	if (!fs.existsSync(file)) return;
	if (!(await ui.confirm("Delete AGENTS.md?", `Delete ${tildify(file)}? It still points sessions at the removed knowledge base. A backup is kept next to it.`))) {
		ui.notify(`${tildify(file)} kept; edit it so it no longer names the removed knowledge base.`, "warning");
		return;
	}
	fs.copyFileSync(file, `${file}.bak-${Date.now()}`);
	fs.rmSync(file);
}

/**
 * First run: one knowledge base. Later runs: a menu to add or replace one per folder or remove one.
 * Cancelling returns the current state unchanged.
 */
export async function setupKnowledgeBase(ui: WizardUi, current: KbState | undefined): Promise<KbState> {
	let sources = doneSources(current);
	if (!sources.length) {
		if (!(await ui.confirm("Obsidian knowledge base", "Use an Obsidian vault as omp's knowledge base and memory?"))) {
			return { status: "skipped" };
		}
		const added = await addSource(ui, []);
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
			const added = await addSource(ui, sources);
			if (added) sources = [...sources.filter(s => s.contextFile !== added.contextFile), added];
		} else if (choice === REMOVE_SOURCE) {
			const picked = await ui.select("Remove which knowledge base?", sources.map(sourceLabel));
			const target = sources.find(s => sourceLabel(s) === picked);
			if (!target) continue;
			await retireContextFile(ui, target.contextFile);
			sources = sources.filter(s => s !== target);
		}
	}
	return sources.length ? { status: "done", sources } : { status: "skipped" };
}

// ── Wiring ──────────────────────────────────────────────────────────────────

export interface Steps {
	skills: boolean;
	models: boolean;
	jev: boolean;
	kb: boolean;
	tools: boolean;
}

/**
 * Steps the automatic wizard offers. Language tooling and the optional Jev judge are offered only to a brand-new install
 * (no state file existed before the wizard began); existing installs opt in with `/starter tools` or `/starter jev`,
 * so a new field never re-prompts them.
 */
export function startupSteps(state: SetupState, stateFileExisted: boolean): Steps | undefined {
	const steps: Steps = {
		skills: !state.agentSkills,
		models: !state.models,
		jev: !stateFileExisted,
		kb: !state.kb,
		tools: !stateFileExisted,
	};
	return steps.skills || steps.models || steps.jev || steps.kb || steps.tools ? steps : undefined;
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
			const next = await setupAgentSkills(ui, exec, fromCommand);
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
		if (steps.kb) {
			updateState({ kb: await setupKnowledgeBase(ui, readState().kb) });
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
		description: "Setup or confirmed plugin updates. Args: updates | skills | models | jev | kb | tools (default: setup all)",
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
					kb: !which || which === "kb",
					tools: !which || which === "tools",
				},
				ctx.cwd,
				true,
			);
		},
	});
}
