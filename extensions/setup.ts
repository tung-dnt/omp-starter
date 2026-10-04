// First-run setup wizard: optional agent-skills install, Claude model routing, and an Obsidian
// vault as omp's knowledge base and memory.
// Runs automatically in the TUI until each step is done or skipped; `/starter` reruns it.
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { syncAgentSkillsStore } from "./lib/agent-skills-store";
import { setupModels } from "./lib/routing";
import { HOME, expandHome, readState, tildify, updateState, type KbState } from "./lib/state";

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

const AGENT_SKILLS_REPO = "tung-dnt/agent-skills";
const AGENT_SKILLS_ID = "agent-skills@tung-agent-skills";
const OBSIDIAN_REGISTRY = path.join(HOME, "Library/Application Support/obsidian/obsidian.json");
const ICLOUD_OBSIDIAN = path.join(HOME, "Library/Mobile Documents/iCloud~md~obsidian/Documents");
const KB_LINK = path.join(HOME, ".omp-kb");
const OTHER_FOLDER = "Other folder…";

// ── agent-skills ────────────────────────────────────────────────────────────

export async function setupAgentSkills(ui: WizardUi, exec: Exec): Promise<"done" | "skipped"> {
	const list = await exec("omp", ["plugin", "list"]);
	if (list.stdout.includes(AGENT_SKILLS_ID)) return "done";
	const ok = await ui.confirm(
		"agent-skills",
		`Install ${AGENT_SKILLS_REPO}? Engineering-workflow skills, agents and commands (/spec, /plan, /build, /review, /ship).`,
	);
	if (!ok) return "skipped";
	const add = await exec("omp", ["plugin", "marketplace", "add", AGENT_SKILLS_REPO], { timeout: 120_000 });
	if (add.code !== 0 && !/already exists/.test(add.stdout + add.stderr)) {
		throw new Error(`marketplace add failed: ${(add.stderr || add.stdout).trim()}`);
	}
	const install = await exec("omp", ["plugin", "install", AGENT_SKILLS_ID], { timeout: 300_000 });
	if (install.code !== 0) throw new Error(`plugin install failed: ${(install.stderr || install.stdout).trim()}`);
	ui.notify(`Installed ${AGENT_SKILLS_REPO}. Run /reload-plugins to load it.`, "info");
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
	].filter(Boolean);
	const pinnedSection = pinned.length
		? `\n## Always-loaded notes\n\n${pinned.map(rel => `@${kbRef}/${rel}`).join("\n\n")}\n`
		: "";
	const commitGate = gate
		? `\n### Commit gate\n\n\`git commit\` is blocked until a \`${kbRef}/\` file has been written or edited in the session. Write the relevant facts first; for commits with no new facts (typos, formatting) put \`[skip-mem]\` in the commit message.\n`
		: "";
	return `# Knowledge base (Obsidian)

KB root: \`${kbRef}/\`. Single source of truth for project context, conventions, and long-term memory.
${pointers.length ? `\n${pointers.join("\n")}\n` : ""}${pinnedSection}
## Memory

Per-fact memory notes live in \`${kbRef}/_memory/<slug>.md\`. Index (one line per note; read the note before relying on it, and verify against the current repo):

@${kbRef}/_memory/MEMORY.md

### Saving a memory

When you learn a durable fact (decision, gotcha, convention, user preference, resolved failure), use the \`write\`/\`edit\` tools (not shell heredocs) to:

1. Create or update \`${kbRef}/_memory/<kebab-slug>.md\`:
   \`\`\`markdown
   ---
   name: <kebab-slug>
   description: <one-line hook>
   type: project | feedback | reference | user
   modified: <ISO timestamp>
   ---

   <fact>. **Why:** <reason>. **How to apply:** <rule>. Link related notes with [[wikilinks]].
   \`\`\`
2. Add or update its line in \`${kbRef}/_memory/MEMORY.md\`: \`- [Title](<slug>.md) — <hook, ≤ ~60 chars>\`.

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

export async function setupKnowledgeBase(ui: WizardUi): Promise<KbState> {
	if (!(await ui.confirm("Obsidian knowledge base", "Use an Obsidian vault as omp's knowledge base and memory?"))) {
		return { status: "skipped" };
	}
	const vaults = discoverVaults();
	let vault: string | undefined;
	if (vaults.length) {
		const picked = await ui.select("Obsidian vault", [...vaults.map(tildify), OTHER_FOLDER]);
		if (!picked) return { status: "skipped" };
		if (picked !== OTHER_FOLDER) vault = expandHome(picked);
	}
	vault ??= expandHome((await ui.input("Vault folder", "~/Documents/MyVault"))?.trim() ?? "");
	if (!vault || vault === HOME) return { status: "skipped" };

	const sub = (await ui.input("Knowledge-base folder inside the vault", "KnowledgeBase"))?.trim() || "KnowledgeBase";
	const kbAbs = path.join(vault, sub);
	if (!fs.existsSync(kbAbs)) {
		const go = await ui.confirm(
			"Folder not found",
			`${tildify(kbAbs)} does not exist yet (a synced vault may still be downloading). Create it with an empty memory index?`,
		);
		if (!go) return { status: "skipped" };
	}

	// `@` imports stop at whitespace, so a vault path with spaces needs a space-free symlink.
	let kbRootAbs = kbAbs;
	if (/\s/.test(vault)) {
		const current = fs.lstatSync(KB_LINK, { throwIfNoEntry: false });
		if (current && !(current.isSymbolicLink() && fs.readlinkSync(KB_LINK) === vault)) {
			const replace = await ui.confirm("Replace link?", `${tildify(KB_LINK)} exists and points elsewhere. Repoint it to the vault?`);
			if (!replace) return { status: "skipped" };
			fs.rmSync(KB_LINK, { force: true });
		}
		if (!fs.existsSync(KB_LINK)) fs.symlinkSync(vault, KB_LINK);
		kbRootAbs = path.join(KB_LINK, sub);
	}

	const memoryIndex = path.join(kbAbs, "_memory", "MEMORY.md");
	if (!fs.existsSync(memoryIndex)) {
		fs.mkdirSync(path.dirname(memoryIndex), { recursive: true });
		fs.writeFileSync(memoryIndex, "");
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

	const scope = await ui.select("Load the knowledge base in", [
		"Every omp session",
		"Sessions under one folder",
	]);
	if (!scope) return { status: "skipped" };
	let contextFile = path.join(HOME, ".omp", "agent", "AGENTS.md");
	let gateDir = HOME;
	if (scope === "Sessions under one folder") {
		const dir = expandHome((await ui.input("Folder", "~/projects"))?.trim() || "~/projects");
		contextFile = path.join(dir, "AGENTS.md");
		gateDir = dir;
	}
	const gate = await ui.confirm(
		"Commit gate",
		`Block agent \`git commit\` under ${tildify(gateDir)} until a knowledge-base note was written in the session ([skip-mem] bypasses)?`,
	);
	const kbRef = tildify(kbRootAbs);
	if (!(await writeWithBackup(ui, contextFile, renderContextFile(kbRef, kbAbs, pinned, gate)))) {
		return { status: "skipped" };
	}
	ui.notify(`Knowledge base wired into ${tildify(contextFile)}. Takes effect in new sessions.`, "info");
	return {
		status: "done",
		vault: kbRootAbs === kbAbs ? vault : KB_LINK,
		kbRef,
		kbPaths: [...new Set([kbRootAbs, kbAbs])],
		contextFile,
		...(gate ? { gateDir } : {}),
	};
}

// ── Wiring ──────────────────────────────────────────────────────────────────

interface Steps {
	skills: boolean;
	models: boolean;
	kb: boolean;
}

export default function ompStarter(pi: ExtensionAPI): void {
	const exec: Exec = async (command, args, options) => {
		const result = await pi.exec(command, args, { timeout: options?.timeout ?? 30_000 });
		return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", code: result.code ?? 1 };
	};

	async function run(ui: WizardUi, steps: Steps): Promise<void> {
		if (steps.skills) updateState({ agentSkills: await setupAgentSkills(ui, exec) });
		if (steps.models) updateState({ models: await setupModels(ui, exec) });
		if (steps.kb) {
			const next = updateState({ kb: await setupKnowledgeBase(ui) });
			try {
				syncAgentSkillsStore(next);
			} catch (error) {
				ui.notify(`Could not point agent-skills at the vault: ${String(error)}`, "warning");
			}
		}
	}

	pi.on("session_start", (_event, ctx) => {
		if (ctx.agent?.kind === "sub" || ctx.mode !== "tui" || !ctx.hasUI) return;
		const state = readState();
		const steps = { skills: !state.agentSkills, models: !state.models, kb: !state.kb };
		if (!steps.skills && !steps.models && !steps.kb) return;
		void run(ctx.ui, steps).catch((error: unknown) => ctx.ui.notify(`Setup failed: ${String(error)}`, "error"));
	});

	// Cheap sync so installs that predate the vault key pick it up without rerunning the wizard.
	pi.on("session_start", (_event, ctx) => {
		if (ctx.agent?.kind === "sub") return;
		try {
			syncAgentSkillsStore(readState());
		} catch (error) {
			if (ctx.hasUI) ctx.ui.notify(`Could not point agent-skills at the vault: ${String(error)}`, "warning");
		}
	});

	pi.registerCommand("starter", {
		description: "Rerun omp-starter setup. Args: skills | models | kb (default: all)",
		handler: async (args, ctx) => {
			const which = args.trim();
			await run(ctx.ui, {
				skills: !which || which === "skills",
				models: !which || which === "models",
				kb: !which || which === "kb",
			});
		},
	});
}
