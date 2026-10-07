// Injects the knowledge-base memory index into the system prompt, scoped to the current repo:
// the `## Global` section plus every section whose heading or `<!-- repos: … -->` list names the
// repo. Other scopes are listed by name so the agent can read the file when they matter.
// Configured by the setup wizard (`kb.kbRef` / `kb.contextFile` in ~/.omp/agent/omp-starter.json).
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { MEMORY_BLOCK_HEADER, parseMemoryIndex, renderMemoryBlock, selectSections } from "./lib/memory-index";
import { expandHome, HOME, readState, tildify } from "./lib/state";

// Keyed by cwd; computed once per session so a memory saved mid-session leaves the system prompt
// (and its prompt-cache prefix) unchanged until the next session.
const cache = new Map<string, string | undefined>();

// Subagents that write code get the index (repo gotchas); read-only ones (scout, reviewers, sonic, …) skip it.
const MEMORY_SUBAGENTS: Record<string, true> = { task: true, "task-builder": true, "test-engineer": true };

function git(cwd: string, args: string[]): string | undefined {
	const result = Bun.spawnSync({ cmd: ["git", "-C", cwd, ...args], stdout: "pipe", stderr: "ignore", timeout: 2000 });
	return result.exitCode === 0 ? result.stdout.toString().trim() || undefined : undefined;
}

/** Repo name from the origin URL (survives worktrees and suffixed clones), else the main checkout's folder. */
function resolveRepoName(cwd: string): string | undefined {
	const origin = git(cwd, ["remote", "get-url", "origin"]);
	if (origin) {
		const name = origin.replace(/\/+$/, "").replace(/\.git$/, "").split(/[/:]/).pop();
		if (name) return name;
	}
	const commonDir = git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
	return commonDir ? path.basename(path.dirname(commonDir)) : undefined;
}

function buildBlock(kbRef: string, cwd: string): string | undefined {
	const indexPath = path.join(expandHome(kbRef), "_memory", "MEMORY.md");
	let text: string;
	try {
		text = fs.readFileSync(indexPath, "utf8");
	} catch {
		return undefined;
	}
	const { loaded, other } = selectSections(parseMemoryIndex(text), resolveRepoName(cwd));
	return renderMemoryBlock(tildify(indexPath), loaded, other);
}

export default function kbMemory(pi: ExtensionAPI): void {
	const reset = (ctx: { agent?: { kind: string } }) => {
		if (ctx.agent?.kind !== "sub") cache.clear();
	};
	pi.on("session_start", (_event, ctx) => reset(ctx));
	pi.on("session_switch", (_event, ctx) => reset(ctx));

	pi.on("before_agent_start", (event, ctx) => {
		const agent = ctx.agent;
		if (agent && agent.kind !== "main" && !MEMORY_SUBAGENTS[agent.name.toLowerCase()]) return;
		const kb = readState().kb;
		if (kb?.status !== "done" || !kb.kbRef || !kb.contextFile) return;
		const root = path.dirname(kb.contextFile);
		const cwd = ctx.cwd;
		if (root !== path.join(HOME, ".omp", "agent") && cwd !== root && !(cwd + path.sep).startsWith(root + path.sep)) {
			return;
		}
		if (event.systemPrompt.some(s => s.includes(`${MEMORY_BLOCK_HEADER}\n`))) return;
		if (!cache.has(cwd)) cache.set(cwd, buildBlock(kb.kbRef, cwd));
		const block = cache.get(cwd);
		if (block) return { systemPrompt: [...event.systemPrompt, block] };
	});
}
