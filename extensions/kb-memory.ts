// Injects the knowledge-base memory index into the system prompt, scoped to the current repo:
// the `## Global` section plus every section whose heading or `<!-- repos: … -->` list names the
// repo. Other scopes are listed by name so the agent can read the file when they matter.
// The knowledge base is the source serving the cwd (`kb.sources` in ~/.omp/agent/omp-starter.json).
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { resolveKb } from "./lib/kb-sources";
import { memoryBlock, memorySnapshots } from "./lib/kb-store";
import { MEMORY_BLOCK_HEADER } from "./lib/memory-index";

// Subagents that write code get the index (repo gotchas); read-only ones (scout, reviewers, sonic, …) skip it.
const MEMORY_SUBAGENTS: Record<string, true> = { task: true, "task-builder": true, "test-engineer": true };

export default function kbMemory(pi: ExtensionAPI): void {
	const reset = (ctx: { sessionManager: { getSessionId(): string } }) => {
		memorySnapshots.delete(ctx.sessionManager.getSessionId());
	};
	pi.on("session_start", (_event, ctx) => reset(ctx));
	pi.on("session_switch", (_event, ctx) => reset(ctx));
	pi.on("session_shutdown", (_event, ctx) => reset(ctx));

	pi.on("before_agent_start", (event, ctx) => {
		const agent = ctx.agent;
		if (agent && agent.kind !== "main" && !MEMORY_SUBAGENTS[agent.name.toLowerCase()]) return;
		const cwd = ctx.cwd;
		const source = resolveKb(cwd);
		if (!source) return;
		if (event.systemPrompt.some(s => s.includes(`${MEMORY_BLOCK_HEADER}\n`))) return;
		const id = ctx.sessionManager.getSessionId();
		let cache = memorySnapshots.get(id);
		if (!cache) memorySnapshots.set(id, (cache = new Map()));
		if (!cache.has(cwd)) cache.set(cwd, { kbRef: source.kbRef, block: memoryBlock(source.kbRef, cwd) });
		const snapshot = cache.get(cwd)!;
		if (snapshot.block) return { systemPrompt: [...event.systemPrompt, snapshot.block] };
	});
}
