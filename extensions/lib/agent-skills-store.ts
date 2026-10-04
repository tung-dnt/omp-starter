// Tells agent-skills where the Obsidian vault is, so its work state (stories, tasks) is stored
// there as project-manager notes. The file is per machine and never committed.
import * as fs from "node:fs";
import * as path from "node:path";
import { HOME, expandHome, type KbState, type SetupState } from "./state";

export function agentSkillsConfigFile(): string {
	const base = process.env.XDG_CONFIG_HOME || path.join(HOME, ".config");
	return path.join(base, "agent-skills", "config.json");
}

/** First directory at or above `start` that holds an `.obsidian/` folder. */
function findVaultRoot(start: string): string | undefined {
	let dir = path.resolve(start);
	for (;;) {
		if (fs.existsSync(path.join(dir, ".obsidian"))) return dir;
		const parent = path.dirname(dir);
		if (parent === dir || parent === HOME) return undefined;
		dir = parent;
	}
}

function vaultOf(kb: KbState): string | undefined {
	if (kb.vault) return kb.vault;
	for (const p of [kb.kbRef, ...(kb.kbPaths ?? [])]) {
		const root = p && findVaultRoot(expandHome(p));
		if (root) return root;
	}
	return undefined;
}

/**
 * Writes `{"vault": <abs vault>}` into agent-skills' user config, merging into any existing keys.
 * Only writes when the content changes, and never deletes the file.
 */
export function syncAgentSkillsStore(state: SetupState): void {
	const kb = state.kb;
	if (kb?.status !== "done") return;
	const vault = vaultOf(kb);
	if (!vault) return;

	const file = agentSkillsConfigFile();
	let config: Record<string, unknown> = {};
	if (fs.existsSync(file)) {
		const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error(`${file} is not a JSON object`);
		}
		config = parsed as Record<string, unknown>;
	}
	if (config.vault === vault) return;
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify({ ...config, vault }, null, 2)}\n`);
}
