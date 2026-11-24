// omp tags Hindsight recall by the folder a session starts in, so a session opened in ~/projects recalls nothing
// repo-specific. When the main session starts working in another repo, this recalls that repo's memories
// (tag `project:<repo>`, the tag omp writes for sessions started there) once and hands them to the agent.
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { sourceReads } from "./cross-repo-reads";
import { repoRoot, resolveRepoName } from "./lib/repo";
import { HOME, tildify } from "./lib/state";
import { bashDir, resolveFrom, SELECTOR, targetPaths } from "./lib/tool-input";

const CONFIG = path.join(HOME, ".omp", "agent", "config.yml");
const TIMEOUT_MS = 5000;

export interface Hindsight {
	readonly url: string;
	readonly token: string | undefined;
	readonly bank: string;
}

type Section = Record<string, unknown>;
const section = (parent: unknown, key: string): Section => {
	const value = parent && typeof parent === "object" ? (parent as Section)[key] : undefined;
	return value && typeof value === "object" ? (value as Section) : {};
};
const text = (from: Section, key: string): string | undefined => {
	const value = from[key];
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
};

/** omp's Hindsight bank when memory is Hindsight with per-project tags (omp's default scoping); otherwise undefined. */
export function hindsightConfig(file = CONFIG, env: NodeJS.ProcessEnv = process.env): Hindsight | undefined {
	let parsed: unknown;
	try {
		parsed = Bun.YAML.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return undefined;
	}
	const hindsight = section(parsed, "hindsight");
	if (text(section(parsed, "memory"), "backend") !== "hindsight") return undefined;
	if ((text(hindsight, "scoping") ?? "per-project-tagged") !== "per-project-tagged") return undefined;
	// Same bank name rule as omp's hindsight/bank.ts.
	const id = text(hindsight, "bankId") ?? "omp";
	const prefix = text(hindsight, "bankIdPrefix");
	return {
		url: (text(hindsight, "apiUrl") ?? env.HINDSIGHT_API_URL ?? "http://localhost:8888").replace(/\/+$/, ""),
		token: text(hindsight, "apiToken") ?? env.HINDSIGHT_API_TOKEN,
		bank: prefix ? `${prefix}-${id}` : id,
	};
}

/** Files and folders a tool call works in, absolute. */
function touched(toolName: string, input: Record<string, unknown>, cwd: string): string[] {
	if (toolName === "read") {
		const p = typeof input.path === "string" ? input.path : "";
		return p && !p.includes("://") ? [resolveFrom(cwd, p.replace(SELECTOR, ""))] : [];
	}
	if (toolName === "edit" || toolName === "write") return targetPaths(toolName, input).map(p => resolveFrom(cwd, p));
	if (toolName === "bash" && typeof input.command === "string") {
		return [bashDir(input.command, input.cwd, cwd), ...sourceReads(toolName, input, cwd)];
	}
	return [];
}

/** omp's tags for a repo: its folder name, plus the origin repo name so worktrees such as `paco24-PAC2-1` match too. */
export function repoTags(root: string): string[] {
	const names = [path.basename(root), resolveRepoName(root)].filter((n): n is string => Boolean(n));
	return [...new Set(names.map(n => `project:${n.toLowerCase()}`))];
}

async function recall(hindsight: Hindsight, repo: string, tags: string[]): Promise<string[]> {
	const response = await fetch(`${hindsight.url}/v1/default/banks/${encodeURIComponent(hindsight.bank)}/memories/recall`, {
		method: "POST",
		headers: { "content-type": "application/json", ...(hindsight.token ? { authorization: `Bearer ${hindsight.token}` } : {}) },
		body: JSON.stringify({
			query: `${repo}: conventions, decisions, invariants and gotchas`,
			tags,
			tags_match: "any_strict",
			types: ["world", "experience"],
			budget: "mid",
			max_tokens: 1024,
		}),
		signal: AbortSignal.timeout(TIMEOUT_MS),
	});
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	const body = (await response.json()) as { results?: { text?: unknown }[] };
	return (body.results ?? []).flatMap(r => (typeof r.text === "string" ? [r.text] : []));
}

export default function repoMemory(pi: ExtensionAPI): void {
	const seen = new Set<string>();
	let hindsight: Hindsight | undefined;
	let loaded = false;
	pi.on("session_start", () => {
		seen.clear();
		loaded = false;
	});

	pi.on("tool_result", async (event, ctx) => {
		if (ctx.agent?.kind === "sub" || event.isError) return;
		const own = repoRoot(ctx.cwd);
		const roots = new Set<string>();
		for (const p of touched(event.toolName, (event.input ?? {}) as Record<string, unknown>, ctx.cwd)) {
			const root = repoRoot(p);
			if (root && root !== own && !seen.has(root)) roots.add(root);
		}
		if (roots.size === 0) return;
		if (!loaded) {
			hindsight = hindsightConfig();
			loaded = true;
		}
		if (!hindsight) return;

		const notes: string[] = [];
		for (const root of roots) {
			seen.add(root);
			const repo = path.basename(root);
			const tags = repoTags(root);
			try {
				const memories = await recall(hindsight, repo, tags);
				if (memories.length) {
					notes.push(`[repo-memory] Working in ${repo} (${tildify(root)}). Memories tagged ${tags.join(", ")}:\n${memories.map(m => `- ${m}`).join("\n")}`);
				}
			} catch (error) {
				notes.push(`[repo-memory] Recall for ${repo} failed (${String(error)}); use \`recall\` with "${repo}" in the query.`);
			}
		}
		if (notes.length) return { additionalContext: notes.join("\n\n") };
	});
}
