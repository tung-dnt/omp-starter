// Hard gates: which gate a path hits, what the lead decided for it, and how an undecided hit is put to the lead.
// A decision lasts per gated path for the active story (stored in its state.json), or for the session outside a story.
// Once the lead approves a story's plan, that approval covers its hard gates: a hit is recorded as approved, not asked.
import * as fs from "node:fs";
import * as path from "node:path";
import { repoRoot, resolveRepoName } from "../repo";
import { type Gate, readStoryState, updateStoryState } from "./artifacts";
import { planApproved } from "./story";
import { leadNotify, type NotifyContext } from "./notify";
import { lead } from "./registry";

export interface GateHit {
	gate: { id: string; category: string };
	/** Repository root. */
	repo: string;
	repoName: string;
	/** What was hit, as shown to the lead: a repository-relative path. */
	rel: string;
	/** What a decision is stored under. */
	key: string;
}

export const gateKey = (repo: string, rel: string): string => `${repo}::${rel}`;

/** Gate hits for repository-relative paths (`/` separators) of the repository at `repo`. */
export function matchRepoFiles(repo: string, rels: string[], gates: Gate[]): GateHit[] {
	const repoName = resolveRepoName(repo) ?? path.basename(repo);
	const applicable = gates
		.filter(gate => gate.repos.includes("*") || gate.repos.includes(repoName))
		.map(gate => ({ gate, globs: gate.paths.map(p => new Bun.Glob(p)) }));
	return rels.flatMap(rel =>
		applicable.filter(({ globs }) => globs.some(glob => glob.match(rel))).map(({ gate }) => ({ gate, repo, repoName, rel, key: gateKey(repo, rel) })),
	);
}

/** Gate hits for one absolute path; none outside a repository. */
export function matchGates(absPath: string, gates: Gate[]): GateHit[] {
	const repo = repoRoot(absPath);
	return repo ? matchRepoFiles(repo, [path.relative(repo, absPath).split(path.sep).join("/")], gates) : [];
}

export function gateDecision(key: string): "approved" | "rejected" | undefined {
	const story = lead().story;
	return story ? readStoryState(story.dir).gates[key]?.decision : lead().sessionApprovals.get(key);
}

export async function recordGate(key: string, decision: "approved" | "rejected", gateId: string, category: string): Promise<void> {
	const story = lead().story;
	if (!story) {
		lead().sessionApprovals.set(key, decision);
		return;
	}
	await updateStoryState(story.dir, state => {
		state.gates[key] = { decision, gateId, category, at: new Date().toISOString() };
	});
}

export interface GateContext extends NotifyContext {
	agent?: { kind: string; name: string };
	ui: NotifyContext["ui"] & { select(title: string, options: string[]): Promise<string | undefined> };
}

/** Title shared by the gate dialogs. */
export const gateTitle = (hit: { gateId: string; category: string; repoName: string; rel: string }, suffix = ""): string =>
	`HARD GATE · ${hit.category} · ${hit.repoName}/${hit.rel} (gate ${hit.gateId}${suffix})`;

/**
 * Settles each hit with the lead's decision. In a story whose plan the lead approved, an undecided hit is recorded as
 * approved: the plan approval is the one decision. Otherwise an undecided hit opens a dialog in an interactive main
 * session, unless the active story is in async mode (the lead is away); anywhere else it is queued for the `lead` tool
 * (op "gate") and blocks that one call. Undefined means every hit is approved.
 */
export async function resolveGate(ctx: GateContext, hits: GateHit[]): Promise<{ block: true; reason: string } | undefined> {
	for (const hit of hits) {
		const { id, category } = hit.gate;
		const where = `${hit.repoName}/${hit.rel}`;
		const rejected = { block: true as const, reason: `HARD GATE ${id} (${category}): ${where} was rejected by the lead.` };
		const decided = gateDecision(hit.key);
		if (decided === "approved") continue;
		if (decided === "rejected") return rejected;

		const story = lead().story;
		if (story && planApproved(story).approved) {
			await recordGate(hit.key, "approved", id, category);
			continue;
		}
		const notice = `omp lead · ${story?.id ?? "session"} · gate ${id} (${category}) · ${where}`;
		const subagent = ctx.agent?.kind === "sub";
		if (!subagent && ctx.hasUI && story?.mode !== "async") {
			leadNotify(ctx, notice);
			const scope = story ? `for story ${story.id}` : "for this session";
			const approve = category === "lead-owned" ? `Approve implementing lead-owned code ${scope}` : `Approve ${scope}`;
			const answer = await ctx.ui.select(gateTitle({ gateId: id, category, repoName: hit.repoName, rel: hit.rel }), [approve, "Reject"]);
			if (answer === approve) {
				await recordGate(hit.key, "approved", id, category);
				continue;
			}
			if (answer === "Reject") {
				await recordGate(hit.key, "rejected", id, category);
				return rejected;
			}
			return { block: true, reason: `HARD GATE ${id}: not approved (dialog dismissed); retry to ask again.` };
		}

		// The replay script (scripts/lead-replay.ts) counts gate stops instead of waiting for a lead.
		const replayLog = process.env.OMP_STARTER_LEAD_REPLAY_LOG;
		if (replayLog && !ctx.hasUI) {
			fs.appendFileSync(replayLog, `${JSON.stringify({ event: "gate", key: hit.key, category, at: new Date().toISOString() })}\n`);
			await recordGate(hit.key, "approved", id, category);
			continue;
		}

		if (!lead().pending.has(hit.key)) leadNotify(ctx, notice);
		lead().pending.set(hit.key, { key: hit.key, gateId: id, category, repoName: hit.repoName, rel: hit.rel, agent: ctx.agent?.name ?? "main" });
		const needs = `HARD GATE ${id} (${category}): ${where} needs the lead's approval`;
		if (!subagent) {
			return {
				block: true,
				reason:
					`${needs} and is queued. Leave this path, continue with work that does not depend on it, and list the queued gates ` +
					'in your report. Call the lead tool with op "gate" only when the lead is back and asks for it.',
			};
		}
		const next = story?.mode === "async" ? "The gate is queued for the lead, who is away." : 'The main session then calls the lead tool with op "gate".';
		return { block: true, reason: `${needs}. Stop this task and report "blocked: hard gate ${id} ${where}" to your parent. ${next}` };
	}
	return undefined;
}
