// Extension loaded into every driven session: `/t3-agents` reports whether the four slot agents are discoverable
// from the code copy (the same discoverAgents call spec-workflow.ts makes).
import * as path from "node:path";
export default function (pi: any): void {
	pi.registerCommand("t3-agents", {
		description: "t3 probe",
		handler: async (_args: string, ctx: any) => {
			const found: any = await pi.pi.discoverAgents(process.env.T3_CODE ?? "");
			const want = ["test-engineer", "task-builder", "code-reviewer", "security-auditor"];
			const rows = want.map(name => {
				const a = (found.agents as any[]).find(x => x.name === name);
				return a ? `${name}: found source=${a.source} file=${a.filePath ?? "?"} prompt=${String(a.systemPrompt ?? "").length}ch model=${a.model ?? "-"}` : `${name}: MISSING`;
			});
			ctx.ui.notify(`T3AGENTS\n${rows.join("\n")}\nsearched: ${(found.searchedDirs ?? []).map((d: string) => path.relative("/", d)).join(" | ")}`, "info");
		},
	});
}
