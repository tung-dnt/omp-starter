// `/kb`: read-only status of the memory backend, the commit gate and the knowledge base (Obsidian docs vault)
// serving the session's folder. omp's `/memory` inspects the memory backend itself.
import * as fs from "node:fs";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { doneSources, resolveKb, servesEverySession, sourceFolder } from "./lib/kb-sources";
import { kbWritten } from "./lib/kb-write-flag";
import { expandHome, readState, tildify, type KbSource, type MemoryState } from "./lib/state";

const USAGE = "Usage: /kb [status]";

const served = (s: KbSource): string => (servesEverySession(s) ? "every session" : tildify(sourceFolder(s)));

function memoryLines(memory: MemoryState | undefined): string[] {
	if (memory?.status !== "done") return ["Memory: not set up. Run /starter memory to pick a backend.", "Commit gate: off"];
	const dirs = memory.gateDirs ?? [];
	return [
		`Memory backend: ${memory.backend ?? "unknown, see /settings → Memory"}`,
		dirs.length
			? `Commit gate (${dirs.map(tildify).join(", ")}): ${kbWritten() ? "satisfied, a memory or note was saved this session" : "blocks git commit until this session saves a memory or writes a note to the KB"}`
			: "Commit gate: off",
	];
}

function status(cwd: string): { text: string; type: "info" | "error" } {
	const { memory, kb } = readState();
	const lines = memoryLines(memory);
	const all = doneSources(kb);
	if (!all.length) return { text: [...lines, "No knowledge base is set up. Run /starter kb to add an Obsidian docs vault."].join("\n"), type: "info" };
	const source = resolveKb(cwd);
	if (!source) {
		const none = `No knowledge base serves ${tildify(cwd)} (configured for: ${all.map(served).join(", ")}). Run /starter kb to add one for this folder.`;
		return { text: [...lines, none].join("\n"), type: "error" };
	}
	const root = expandHome(source.kbRef);
	let real: string | undefined;
	try {
		real = fs.realpathSync(root);
	} catch {
		real = undefined;
	}
	lines.push(
		`Knowledge base ${source.kbRef} serves ${served(source)}.`,
		real ? `  Vault: ${tildify(real)}` : `  Vault: ${root} is not reachable (missing, unmounted or evicted)`,
	);
	const others = all.filter(s => s.contextFile !== source.contextFile);
	if (others.length) lines.push(`  Other knowledge bases: ${others.map(s => `${s.kbRef} → ${served(s)}`).join("; ")}`);
	return { text: lines.join("\n"), type: "info" };
}

export default function kbCommand(pi: ExtensionAPI): void {
	pi.registerCommand("kb", {
		description: "Memory backend, commit gate and knowledge base: status",
		handler: async (args, ctx) => {
			const [sub = "status"] = args.trim().split(/\s+/).filter(Boolean);
			if (sub !== "status") {
				ctx.ui.notify(`Unknown /kb subcommand "${sub}". ${USAGE}`, "warning");
				return;
			}
			const { text, type } = status(ctx.cwd);
			ctx.ui.notify(text, type);
		},
	});
}
