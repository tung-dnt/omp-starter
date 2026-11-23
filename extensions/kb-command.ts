// `/kb`: read-only status of the knowledge base serving the session's folder: the vault, the commit gate
// and the other configured knowledge bases. Memory is omp's Hindsight backend, which `/memory` inspects.
import * as fs from "node:fs";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { doneSources, resolveKb, servesEverySession, sourceFolder } from "./lib/kb-sources";
import { kbWritten } from "./lib/kb-write-flag";
import { expandHome, readState, tildify, type KbSource } from "./lib/state";

const USAGE = "Usage: /kb [status]";

const served = (s: KbSource): string => (servesEverySession(s) ? "every session" : tildify(sourceFolder(s)));

function status(cwd: string): string {
	const all = doneSources(readState().kb);
	if (!all.length) return "No knowledge base is set up. Run /starter kb to add one.";
	const source = resolveKb(cwd);
	if (!source) {
		throw new Error(
			`No knowledge base serves ${tildify(cwd)} (configured for: ${all.map(served).join(", ")}). Run /starter kb to add one for this folder.`,
		);
	}
	const root = expandHome(source.kbRef);
	let real: string | undefined;
	try {
		real = fs.realpathSync(root);
	} catch {
		real = undefined;
	}
	const lines = [
		`Knowledge base ${source.kbRef} serves ${served(source)}.`,
		real ? `  Vault: ${tildify(real)}` : `  Vault: ${root} is not reachable (missing, unmounted or evicted)`,
		source.gateDir
			? `  Commit gate (${tildify(source.gateDir)}): ${kbWritten(source.kbRef) ? "satisfied, a note or memory was written this session" : "blocks git commit until this session writes a note to the KB or saves a memory"}`
			: "  Commit gate: off",
	];
	const others = all.filter(s => s.contextFile !== source.contextFile);
	if (others.length) lines.push(`  Other knowledge bases: ${others.map(s => `${s.kbRef} → ${served(s)}`).join("; ")}`);
	return lines.join("\n");
}

export default function kbCommand(pi: ExtensionAPI): void {
	pi.registerCommand("kb", {
		description: "Knowledge base: status",
		handler: async (args, ctx) => {
			const [sub = "status"] = args.trim().split(/\s+/).filter(Boolean);
			if (sub !== "status") {
				ctx.ui.notify(`Unknown /kb subcommand "${sub}". ${USAGE}`, "warning");
				return;
			}
			try {
				ctx.ui.notify(status(ctx.cwd), "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}
