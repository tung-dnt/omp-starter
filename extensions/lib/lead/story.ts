// The active story as the agent sees it: whether the lead approved its plan, and the system-prompt block carrying
// the lead's brief, the system map and the hard gates.
import * as path from "node:path";
import { approvalDigest, readBrief, readHardGates, readPlan, readStoryState, readSystemMap } from "./artifacts";
import type { ActiveStory } from "./registry";

export interface PlanApproval {
	approved: boolean;
	/** Symlink-resolved repository roots of the plan as it is now; empty while the plan is missing or invalid. */
	repos: string[];
	/** An approval was recorded, but the plan's repos or the brief's invariants or boundaries no longer match it. */
	changed: boolean;
	/** Why the plan or the brief cannot be read; an unreadable one is never approved. */
	errors: string[];
}

export function planApproved(story: ActiveStory): PlanApproval {
	const { plan, errors: planErrors } = readPlan(story.dir);
	const { brief, errors: briefErrors } = readBrief(story.dir);
	const stored = readStoryState(story.dir).plan;
	const errors = [...planErrors, ...briefErrors];
	const approved = plan !== undefined && brief !== undefined && approvalDigest(plan, brief) === stored?.digest;
	return { approved, repos: plan?.repos ?? [], changed: stored !== null && !approved && errors.length === 0, errors };
}

/** First line of the block; also how a prompt that already carries it is recognised. */
export const STORY_BLOCK_HEADER = "# Lead story ";
const TEXT_MAX = 8000;
const capped = (text: string): string => (text.length > TEXT_MAX ? `${text.slice(0, TEXT_MAX)}\n… (truncated; read the file)` : text);

/** The `# Lead story` system-prompt block, read from the files as they are now. */
export function storyBlock(story: ActiveStory): string {
	const { approved, repos } = planApproved(story);
	const brief = readBrief(story.dir);
	const map = readSystemMap(story.leadDir);
	const { gates, error } = readHardGates(story.leadDir);
	const gateLines = gates
		? gates.gates.map(gate => `${gate.id} · ${gate.category} · ${gate.paths.join(", ") || "(no paths)"}`)
		: [error ? `(unreadable: ${error}; gates fail closed)` : "(none configured)"];
	return [
		`${STORY_BLOCK_HEADER}${story.id} (${story.mode} mode)`,
		"",
		`Plan: ${approved ? "approved" : "NOT approved: repository edits are blocked until the lead approves it through the lead tool (op approve)"}`,
		`Plan file: ${path.join(story.dir, "plan.md")}`,
		`Repos in plan: ${repos.join(", ") || "none yet"}`,
		`PR body format: ${path.join(story.leadDir, "pr-format.md")}`,
		"",
		`## Lead brief (${path.join(story.dir, "brief.md")})`,
		capped(brief.brief?.text ?? brief.errors.join("; ")),
		"",
		`## System map (${path.join(story.leadDir, "system-map.md")})`,
		capped((map.text ?? map.error ?? "").trim()),
		"",
		`## Hard gates (${path.join(story.leadDir, "hard-gates.md")})`,
		...gateLines,
		story.mode === "async"
			? 'A write to a gated path is refused and queued for the lead, who is away: leave that path, continue with work that does not depend on it, and list the queued gates in your report. Call the lead tool with op "gate" only when the lead asks. Reads and writes outside the plan\'s repos are blocked.'
			: 'A write to a gated path stops for the lead. Subagents: stop and report "blocked: hard gate <id> <repo>/<path>"; the main session then calls the lead tool with op "gate". Reads and writes outside the plan\'s repos are blocked.',
	].join("\n");
}
