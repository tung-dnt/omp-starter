// Structural gate at commit time: a repository that keeps docs/arch/ (scripts/arch-graph.ts) must commit it fresh,
// and may only add cross-service calls and table writes the lead's system map allows.
import * as fs from "node:fs";
import * as path from "node:path";
import { collectEdges, readServices, renderFiles, staleFiles, structureViolations } from "../../../scripts/arch-graph";
import { resolveRepoName } from "../repo";
import { type GateHit, gateKey } from "./gates";
import { readSystemMap } from "./artifacts";

const SCRIPT = path.join(import.meta.dir, "..", "..", "..", "scripts", "arch-graph.ts");

/**
 * `block` is why the commit cannot go ahead (stale or unreadable docs/arch); `hits` are structure violations to put
 * to the lead like any gate. Nothing happens in a repository without docs/arch/services.json.
 * The graph is rendered from the system map's services for this repository, so a map change (a service's path, calls
 * or tables) makes docs/arch stale too; services.json stands in only when the map lists none for the repository.
 */
export async function checkStructure(repo: string, policyDir: string): Promise<{ block?: string; hits: GateHit[] }> {
	if (!fs.existsSync(path.join(repo, "docs", "arch", "services.json"))) return { hits: [] };
	const regenerate = `run bun ${SCRIPT} generate ${repo} --map ${path.join(policyDir, "system-map.md")} and commit docs/arch.`;
	const repoName = resolveRepoName(repo) ?? path.basename(repo);
	const mapped = readSystemMap(policyDir).services?.filter(s => s.repo === repoName) ?? [];
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
