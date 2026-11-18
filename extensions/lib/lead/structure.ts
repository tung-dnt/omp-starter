// Structural gate at commit time: a repository that keeps docs/arch/ (scripts/arch-graph.ts) must commit it fresh,
// and may only add cross-service calls and table writes the repository's project note allows.
import * as fs from "node:fs";
import * as path from "node:path";
import { collectEdges, readServices, renderFiles, staleFiles, structureViolations } from "../../../scripts/arch-graph";
import { type GateHit, gateKey } from "./gates";
import { noteName, readProjectNote } from "./artifacts";

const SCRIPT = path.join(import.meta.dir, "..", "..", "..", "scripts", "arch-graph.ts");

/**
 * `block` is why the commit cannot go ahead (stale or unreadable docs/arch); `hits` are structure violations to put
 * to the lead like any gate. Nothing happens in a repository without docs/arch/services.json.
 * The graph is rendered from the services in the repository's project note, so a change there (a service's path, calls
 * or tables) makes docs/arch stale too; services.json stands in only when the note lists none.
 */
export async function checkStructure(repo: string, notesDir: string): Promise<{ block?: string; hits: GateHit[] }> {
	if (!fs.existsSync(path.join(repo, "docs", "arch", "services.json"))) return { hits: [] };
	const repoName = noteName(repo);
	const regenerate = `run bun ${SCRIPT} generate ${repo} --map ${path.join(notesDir, `${repoName}.md`)} and commit docs/arch.`;
	const mapped = readProjectNote(notesDir, repoName).note?.services ?? [];
	let edges: string[];
	try {
		const services = mapped.length ? mapped : readServices(repo);
		edges = await collectEdges(repo, services);
		const stale = staleFiles(repo, renderFiles(edges, services));
		if (stale.length) return { block: `lead: docs/arch is stale (${stale.join(", ")}); ${regenerate}`, hits: [] };
	} catch (error) {
		return { block: `lead: docs/arch cannot be checked (${(error as Error).message}); ${regenerate}`, hits: [] };
	}
	const hits = structureViolations(edges, mapped).map(violation => ({
		gate: { id: "structure", category: "structure" },
		repo,
		repoName,
		rel: violation,
		key: gateKey(`structure::${repo}`, violation),
	}));
	return { hits };
}
