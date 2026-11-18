// The lead-driven workflow. The lead (the user) writes a brief per story under `<kb>/lead/stories/<id>/`; the agent
// plans from it, the lead approves the plan once, and code keeps the build inside what was approved:
//  - `/story <id>` and `/build [id]` are checked before they expand: no brief or system map, no planning; no approved plan, no build.
//  - The active story's brief, system map and hard gates are added to the system prompt of the main session and of the subagents that build or review.
//  - Repository edits are blocked until the plan is approved; afterwards reads and writes outside the plan's repositories are blocked.
//  - The `lead` tool is how the agent reaches the lead. No tool argument approves anything: every decision is a dialog
//    only the user can answer, and only the main session can open one (subagents have no UI).
// Active once `/starter lead` created the folder; off with OMP_STARTER_LEAD=off.
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { atomicWrite, withFileLock } from "./lib/file-lock";
import { inside } from "./lib/kb-sources";
import { approvalDigest, leadDirFor, leadLock, leadReady, readBrief, readHardGates, readPlan, readSystemMap, type StoryState, updateStoryState } from "./lib/lead/artifacts";
import { gateTitle, recordGate } from "./lib/lead/gates";
import { leadNotify } from "./lib/lead/notify";
import { type ActiveStory, lead, resetLead } from "./lib/lead/registry";
import { planApproved, STORY_BLOCK_HEADER, storyBlock } from "./lib/lead/story";
import { RETRO_HEADER } from "./lib/lead/templates";
import { repoRoot } from "./lib/repo";
import { tildify } from "./lib/state";
import { resolveFrom, targetPaths, touchedPaths } from "./lib/tool-input";

const COMMAND = /^\/(?:[\w-]+:)?(story|build)(?=\s|$)(?:\s+(\S+))?/;
const STORY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const WRITE_TOOLS: Record<string, true> = { write: true, edit: true };
// Subagents that build or review get the story block; scouts and the like do not need the brief.
const LEAD_SUBAGENTS: Record<string, true> = { task: true, "task-builder": true, "test-engineer": true, "code-reviewer": true, "security-auditor": true, reviewer: true };
// Subagents that write code count against `limits.builders` of hard-gates.md while a story is active.
const BUILDERS: Record<string, true> = { task: true, "task-builder": true, "test-engineer": true };

interface LeadParams {
	op: "approve" | "gate" | "status" | "retro";
	story?: string;
	summary?: string;
	artifact?: string;
}

/** Makes story `id` the active one, or returns why it cannot start. */
function activate(leadDir: string, id: string, missingBrief: (storyDir: string) => string): string | undefined {
	const storyDir = path.join(leadDir, "stories", id);
	if (!STORY_ID.test(id) || !fs.existsSync(path.join(storyDir, "brief.md"))) return missingBrief(storyDir);
	const { brief, errors } = readBrief(storyDir);
	if (!brief) return `lead: ${errors.join("; ")}`;
	const map = readSystemMap(leadDir);
	if (map.error) return `lead: ${map.error}. The system map comes before any repo work; fill it in and rerun /story ${id}.`;
	lead().story = { id, dir: storyDir, leadDir, mode: brief.mode, invariants: brief.invariants };
	lead().notifiedPlanChange = false;
	return undefined;
}

function activeStory(): ActiveStory {
	const story = lead().story;
	if (!story) throw new Error("lead: no active story; the lead starts one with /story <id>");
	return story;
}

/** Whether the story's plan is approved; tells the lead once when what they approved has changed since. */
function approval(story: ActiveStory, ctx: ExtensionContext) {
	const state = planApproved(story);
	if (state.changed && !lead().notifiedPlanChange && ctx.hasUI) {
		lead().notifiedPlanChange = true;
		ctx.ui.notify("lead: the plan's repos or the brief's invariants or boundaries changed after approval; edits are blocked until the lead approves again.", "warning");
	}
	return state;
}

/** Why `/story <id>` or `/build [id]` must not run, or undefined after making the story active. */
function refusal(command: string, id: string | undefined, leadDir: string, ctx: ExtensionContext): string | undefined {
	if (command === "story") {
		if (id === undefined || !STORY_ID.test(id)) return "lead: usage: /story <id>, where lead/stories/<id>/brief.md is your brief";
		return activate(
			leadDir,
			id,
			storyDir =>
				`lead: no lead brief at ${tildify(storyDir)}/brief.md. Copy ${tildify(leadDir)}/brief-template.md there and fill it in; planning does not start without it.`,
		);
	}
	if (id !== undefined) {
		const problem = activate(leadDir, id, () => `lead: no story ${id}; write its brief and run /story ${id}, or use /task for a small change.`);
		if (problem) return problem;
	}
	const story = lead().story;
	if (!story) return "lead: /build needs a story id";
	if (!approval(story, ctx).approved) return `lead: the plan for ${story.id} is not approved; run /story ${story.id}.`;
	return undefined;
}

/** The single plan approval: shows the plan's summary and repositories to the lead and records a yes. */
async function approvePlan(ctx: ExtensionContext): Promise<string> {
	const story = activeStory();
	const { plan, errors } = readPlan(story.dir);
	if (!plan) throw new Error(`lead: ${errors.join("; ")}`);
	const { brief, errors: briefErrors } = readBrief(story.dir);
	if (!brief) throw new Error(`lead: ${briefErrors.join("; ")}`);
	const missing = brief.invariants.filter(inv => !new RegExp(`\\b${inv.id}\\b`).test(plan.text)).map(inv => inv.id);
	if (missing.length) throw new Error(`lead: plan does not mention invariant(s) ${missing.join(", ")}`);
	if (!ctx.hasUI) throw new Error("lead: approval needs an interactive session");
	const yes = await ctx.ui.confirm(`Approve plan for ${story.id}?`, `${plan.summary.join("\n")}\n\nRepos: ${plan.repos.join(", ")}`);
	if (!yes) return "plan NOT approved; revise it with the lead and call approve again";
	await updateStoryState(story.dir, state => {
		state.plan = { digest: approvalDigest(plan, brief), approvedAt: new Date().toISOString() };
	});
	lead().notifiedPlanChange = false;
	return `plan approved; building may start (/build ${story.id})`;
}

/** Puts every gate a subagent was blocked on to the lead; undecided ones stay queued. */
async function decideGates(ctx: ExtensionContext): Promise<string> {
	const pending = lead().pending;
	if (pending.size === 0) return "no pending gates";
	if (!ctx.hasUI) throw new Error("lead: gate decisions need an interactive session");
	const lines: string[] = [];
	for (const gate of [...pending.values()]) {
		const answer = await ctx.ui.select(gateTitle(gate, `, blocked ${gate.agent}`), ["Approve", "Reject", "Decide later"]);
		const decision = answer === "Approve" ? "approved" : answer === "Reject" ? "rejected" : undefined;
		if (decision) {
			await recordGate(gate.key, decision, gate.gateId, gate.category);
			pending.delete(gate.key);
		}
		lines.push(`${gate.gateId} ${gate.repoName}/${gate.rel}: ${decision ?? "pending"}`);
	}
	return lines.join("\n");
}

type Status = NonNullable<StoryState["status"]>;

/** Computes the story's status from the pull request of each plan repository's current branch and records it. */
async function recordStatus(pi: ExtensionAPI): Promise<string> {
	const story = activeStory();
	const { plan, errors } = readPlan(story.dir);
	if (!plan) throw new Error(`lead: ${errors.join("; ")}`);
	const prs: Status["prs"] = [];
	const lines: string[] = [];
	for (const repo of plan.repos) {
		const branch = (await pi.exec("git", ["-C", repo, "rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
		const listed = await pi.exec("gh", ["pr", "list", "--head", branch, "--state", "all", "--json", "url,state", "--limit", "1"], { cwd: repo });
		if (listed.code !== 0) throw new Error(`lead: gh failed: ${listed.stderr.trim().split("\n")[0]}`);
		const pr = (JSON.parse(listed.stdout || "[]") as { url: string; state: string }[])[0];
		if (pr) prs.push({ repo, url: pr.url, state: pr.state });
		lines.push(`- ${path.basename(repo)} (${branch}): ${pr ? `${pr.state} ${pr.url}` : "no pull request"}`);
	}
	const value: Status["value"] =
		prs.length === plan.repos.length && prs.every(pr => pr.state === "MERGED") ? "done" : prs.some(pr => pr.state === "OPEN") ? "in-review" : "in-progress";
	await updateStoryState(story.dir, state => {
		state.status = { value, prs, at: new Date().toISOString() };
	});
	const urls = prs.map(pr => pr.url);
	atomicWrite(
		path.join(story.dir, "status.md"),
		`---\nstatus: ${value}\nprs:${urls.length ? urls.map(url => `\n  - ${url}`).join("") : " []"}\n---\n\n# ${story.id} status\n\n${lines.join("\n")}\n`,
	);
	if (value === "done") lead().story = undefined;
	return [`status: ${value}`, ...urls].join("\n");
}

const RETRO_CAUSES = ["spec gap", "missing invariant", "missing context (system map)", "missing test", "rule/skill gap", "model error"];

/** Appends an escaped bug to retro-log.md with the cause the lead picks. */
async function recordRetro(p: LeadParams, leadDir: string, ctx: ExtensionContext): Promise<string> {
	const [story, summary, artifact] = [p.story, p.summary, p.artifact].map(value => value?.replace(/\s+/g, " ").trim());
	if (!story || !summary || !artifact) throw new Error("lead: retro needs story, summary and artifact");
	if (!ctx.hasUI) throw new Error("lead: retro needs an interactive session");
	const cause = await ctx.ui.select(`Escaped bug in ${story}: ${summary}. Cause?`, RETRO_CAUSES);
	if (cause === undefined) return "retro not recorded";
	const file = path.join(leadDir, "retro-log.md");
	const line = `- ${new Date().toLocaleDateString("en-CA")} · ${cause} · ${story} · ${summary} · fixed: ${artifact}\n`;
	await withFileLock(leadLock(file), `${tildify(file)} is being updated by another session; retry`, () => {
		fs.mkdirSync(leadDir, { recursive: true });
		atomicWrite(file, (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : RETRO_HEADER) + line);
	});
	return line.trimEnd();
}

export default function leadExtension(pi: ExtensionAPI): void {
	if (process.env.OMP_STARTER_LEAD === "off") return;
	const z = pi.zod;

	pi.on("session_start", (_event, ctx) => {
		if (ctx.agent?.kind !== "sub") resetLead(ctx.sessionManager.getSessionId());
	});

	pi.on("input", (event, ctx) => {
		if (ctx.agent?.kind === "sub" || !leadReady(ctx.cwd)) return;
		const command = COMMAND.exec(event.text);
		if (!command) return;
		const problem = refusal(command[1], command[2], leadDirFor(ctx.cwd)!, ctx);
		if (!problem) return;
		ctx.ui.notify(problem, "error");
		return { handled: true };
	});

	pi.on("before_agent_start", (event, ctx) => {
		const story = lead().story;
		if (!story) return;
		const agent = ctx.agent;
		if (agent && agent.kind !== "main" && !LEAD_SUBAGENTS[agent.name.toLowerCase()]) return;
		if (event.systemPrompt.some(s => s.includes(STORY_BLOCK_HEADER))) return;
		return { systemPrompt: [...event.systemPrompt, storyBlock(story)] };
	});

	// The fence: no repository edits before the plan is approved; afterwards nothing outside the plan's repositories.
	pi.on("tool_call", (event, ctx) => {
		const story = lead().story;
		if (!story) return;
		const paths = touchedPaths(event.toolName, (event.input ?? {}) as Record<string, unknown>, ctx.cwd).filter(p => !inside(p, story.leadDir));
		if (!paths.length) return;
		const { approved, repos, changed, errors } = approval(story, ctx);
		const planFile = path.join(story.dir, "plan.md");
		for (const p of paths) {
			const repo = repoRoot(p);
			if (!repo) continue;
			if (!approved) {
				if (!WRITE_TOOLS[event.toolName]) continue;
				if (changed) {
					return {
						block: true,
						reason: `lead: the plan's repos, or the brief's invariants or boundaries, changed since the lead approved ${story.id}; call the lead tool with op "approve" again.`,
					};
				}
				const problems = errors.length && fs.existsSync(planFile) ? ` Problems: ${errors.join("; ")}.` : "";
				return { block: true, reason: `lead: the plan for ${story.id} is not approved yet; write ${planFile} and call the lead tool with op "approve".${problems}` };
			}
			if (!repos.includes(fs.realpathSync(repo)) && !/\/node_modules\//.test(p)) {
				return {
					block: true,
					reason:
						`lead fence: ${path.basename(repo)} is not in the plan's repos (${repos.map(r => path.basename(r)).join(", ")}). ` +
						"If the work needs it, stop and report the gap to the lead.",
				};
			}
		}
	});

	// Agents keep the system map current. The lead is not asked, so each edit is announced and has to be described in the PR.
	pi.on("tool_result", async (event, ctx) => {
		if (event.isError || !WRITE_TOOLS[event.toolName]) return;
		const leadDir = leadDirFor(ctx.cwd);
		if (!leadDir) return;
		const map = path.join(leadDir, "system-map.md");
		const targets = targetPaths(event.toolName, (event.input ?? {}) as Record<string, unknown>).filter(p => !p.includes("://"));
		if (!targets.some(p => inside(resolveFrom(ctx.cwd, p), map))) return;
		const story = lead().story;
		leadNotify(ctx, `omp lead · ${story?.id ?? "session"} · system-map.md edited by ${ctx.agent?.name ?? "main"}`);
		if (story) {
			await updateStoryState(story.dir, state => {
				state.mapEditedAt = new Date().toISOString();
			});
		}
		const { error } = readSystemMap(leadDir);
		if (error) return { additionalContext: `[lead] ${error}. Fix system-map.md now: /story and the structural gate read it.` };
	});

	const builderId = (ctx: ExtensionContext): string | undefined =>
		ctx.agent?.kind === "sub" && BUILDERS[ctx.agent.name.toLowerCase()] ? (ctx.agent.id ?? ctx.sessionManager.getSessionId()) : undefined;

	pi.on("agent_start", (_event, ctx) => {
		const id = builderId(ctx);
		if (id) lead().runningBuilders.add(id);
	});

	pi.on("agent_end", (event, ctx) => {
		const id = builderId(ctx);
		if (id) lead().runningBuilders.delete(id);
		const story = lead().story;
		// In async mode the lead is away: tell them when the main session comes to rest, and how many gates wait for them.
		if (story?.mode !== "async" || ctx.agent?.kind === "sub" || event.willContinue) return;
		const queued = lead().pending.size;
		leadNotify(ctx, `omp lead · ${story.id} · agent stopped: review or approve${queued ? ` · ${queued} gate${queued === 1 ? "" : "s"} queued` : ""}`);
	});

	pi.on("before_subagent_spawn", event => {
		const story = lead().story;
		if (!story || !BUILDERS[event.agent.toLowerCase()]) return;
		const limit = readHardGates(story.leadDir).gates?.limits.builders ?? 2;
		const running = lead().runningBuilders.size;
		if (running < limit) return;
		return { block: true, reason: `lead: ${running} builders already running (limits.builders = ${limit} in hard-gates.md); wait for one to finish.` };
	});

	pi.registerTool({
		name: "lead",
		label: "Lead",
		description:
			"Lead-driven workflow actions that need the lead (the user). approve: show the active story's plan summary to the lead " +
			"for the single plan approval. gate: let the lead decide pending hard gates. status: compute the story's status from " +
			"GitHub and write status.md. retro: record an escaped bug in retro-log.md; the lead picks the cause. " +
			"No argument approves anything: every decision is a dialog only the user can answer.",
		parameters: z.object({
			op: z.enum(["approve", "gate", "status", "retro"]),
			story: z.string().optional().describe("retro: story id or PR"),
			summary: z.string().optional().describe("retro: what escaped, one line"),
			artifact: z.string().optional().describe("retro: root artifact that was fixed, a path"),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (ctx.agent?.kind === "sub") throw new Error("lead: only the main session can call this tool");
			const leadDir = leadDirFor(ctx.cwd);
			if (!leadDir) throw new Error("lead: no knowledge base serves this folder; run /starter kb, then /starter lead");
			const p = params as LeadParams;
			let text: string;
			if (p.op === "approve") text = await approvePlan(ctx);
			else if (p.op === "gate") text = await decideGates(ctx);
			else if (p.op === "status") text = await recordStatus(pi);
			else text = await recordRetro(p, leadDir, ctx);
			return { content: [{ type: "text", text }] };
		},
	});
}
