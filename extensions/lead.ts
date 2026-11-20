// The lead-driven workflow. The lead (the user) writes a brief per story in the story's folder (`<kb>/lead/stories/<id>/`
// by default; see LeadLayout); the agent plans from it, the lead approves the plan once, and code keeps the build
// inside what was approved:
//  - `/story <id>` and `/build [id]` are checked before they expand: no brief, no planning; no approved plan, no build.
//  - The active story's brief, hard gates and the project notes of the plan's repositories are added to the system prompt of the main session and of the subagents that build or review.
//  - A plan is approved only when each of its repositories has a project note with a services block; an agent's change to such a block is announced to the lead.
//  - Repository edits are blocked until the plan is approved; afterwards reads and writes outside the plan's repositories are blocked.
//  - The `lead` tool is how the agent reaches the lead. No tool argument approves anything: every decision is a dialog
//    only the user can answer, and only the main session can open one (subagents have no UI).
// Active once `/starter lead` created hard-gates.md; off with OMP_STARTER_LEAD=off.
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { atomicWrite, withFileLock } from "./lib/file-lock";
import { inside } from "./lib/kb-sources";
import {
	approvalDigest,
	freshnessLines,
	inLead,
	isObject,
	type LeadLayout,
	leadLayoutFor,
	leadLock,
	leadReady,
	noteAge,
	noteNames,
	type ProofRow,
	readBrief,
	readHardGates,
	readPlan,
	readProjectNote,
	readStoryState,
	type Stage,
	type StoryState,
	syncGenerated,
	today,
	undescribedRepos,
	updateStoryState,
} from "./lib/lead/artifacts";
import { gateTitle, recordGate } from "./lib/lead/gates";
import { heads, loopStop, recordVerdict, REVIEW_BLOCK_HEADER, reviewBlock, runCheck } from "./lib/lead/loop";
import { leadNotify } from "./lib/lead/notify";
import { type ActiveStory, lead, resetLead } from "./lib/lead/registry";
import { JIRA_ID, planApproved, STORY_BLOCK_HEADER, storyBlock } from "./lib/lead/story";
import { PROJECT_NOTE_BLOCK, RETRO_HEADER } from "./lib/lead/templates";
import { headSha, repoRoot } from "./lib/repo";
import { tildify } from "./lib/state";
import { resolveFrom, targetPaths, touchedPaths } from "./lib/tool-input";

const COMMAND = /^\/(?:[\w-]+:)?(story|build)(?=\s|$)(?:\s+(\S+))?/;
const STORY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const WRITE_TOOLS: Record<string, true> = { write: true, edit: true };
// Subagents that build or review get the story block; scouts and the like do not need the brief.
const LEAD_SUBAGENTS: Record<string, true> = { task: true, "task-builder": true, "test-engineer": true, "code-reviewer": true, "security-auditor": true, reviewer: true };
// Subagents that write code count against `limits.builders` of hard-gates.md while a story is active.
const BUILDERS: Record<string, true> = { task: true, "task-builder": true, "test-engineer": true };
/** Budget of each git/gh call behind a status: a hung gh must not hold `/build`. */
const STATUS_TIMEOUT_MS = 10_000;

interface LeadParams {
	op: "approve" | "gate" | "status" | "retro" | "check";
	story?: string;
	summary?: string;
	artifact?: string;
	stage?: Stage;
}

/**
 * Makes story `id` the active one, or returns why it cannot start. With `draft`, a Jira-keyed story whose plan is not
 * approved yet may start without a valid brief: the agent drafts it from the ticket and the lead approves it with the plan.
 */
function activate(layout: LeadLayout, id: string, missingBrief: (storyDir: string) => string, draft: boolean): string | undefined {
	const storyDir = path.join(layout.stories, id);
	if (!STORY_ID.test(id)) return missingBrief(storyDir);
	const drafting = draft && JIRA_ID.test(id) && readStoryState(storyDir).plan === null;
	if (!fs.existsSync(path.join(storyDir, "brief.md")) && !drafting) return missingBrief(storyDir);
	const { brief, errors } = readBrief(storyDir);
	if (!brief && !drafting) return `lead: ${errors.join("; ")}`;
	lead().story = { id, dir: storyDir, layout, mode: brief?.mode ?? "async", invariants: brief?.invariants ?? [] };
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
function refusal(command: string, id: string | undefined, layout: LeadLayout, ctx: ExtensionContext): string | undefined {
	if (command === "story") {
		if (id === undefined || !STORY_ID.test(id)) return `lead: usage: /story <id>, where ${tildify(layout.stories)}/<id>/brief.md is your brief`;
		return activate(
			layout,
			id,
			storyDir =>
				`lead: no lead brief at ${tildify(storyDir)}/brief.md. Copy ${tildify(layout.templates)}/brief-template.md there and fill it in; planning does not start without it.`,
			true,
		);
	}
	if (id !== undefined) {
		const problem = activate(layout, id, () => `lead: no story ${id}; write its brief and run /story ${id}, or use /task for a small change.`, false);
		if (problem) return problem;
	}
	const story = lead().story;
	if (!story) return "lead: /build needs a story id";
	const { approved, repos } = approval(story, ctx);
	if (!approved) return `lead: the plan for ${story.id} is not approved; run /story ${story.id}.`;
	const undescribed = undescribedRepos(story.layout, repos);
	if (undescribed.length) return `lead: /build needs a project note with a services block for every repository in the plan: ${undescribed.join("; ")}.`;
	return undefined;
}

/** Names of the project notes (`<notes>/<name>.md`) a write/edit call targets. */
function targetedNotes(toolName: string, input: unknown, cwd: string, notesDir: string): string[] {
	if (!WRITE_TOOLS[toolName]) return [];
	return targetPaths(toolName, (input ?? {}) as Record<string, unknown>)
		.filter(p => !p.includes("://"))
		.map(p => resolveFrom(cwd, p))
		.filter(p => p.endsWith(".md") && inside(path.dirname(p), notesDir) && inside(notesDir, path.dirname(p)))
		.map(p => path.basename(p, ".md"));
}

/** What the harness reads from a project note, as one comparable string: a change to it is what the lead hears about. */
function machinePart(notesDir: string, name: string): string {
	const { note, error } = readProjectNote(notesDir, name);
	return JSON.stringify(note ? [note.services, note.invariants] : error);
}

/** `ac`'s proof, as the lead reads it in the approval dialog. */
function proofSummary(rows: ProofRow[]): string {
	return rows
		.map(row => {
			if (row.unprovable !== undefined) return `UNPROVABLE: ${row.unprovable}`;
			return row.test ? `test in ${row.repo}${row.acceptance ? " + acceptance" : ""}` : `acceptance in ${row.repo}`;
		})
		.join("; ");
}

/** The single approval of brief and plan: shows the criteria with their proof, the invariants, the boundaries and the plan's summary to the lead and records a yes. */
async function approvePlan(ctx: ExtensionContext): Promise<string> {
	const story = activeStory();
	const { plan, errors } = readPlan(story.dir);
	if (!plan) throw new Error(`lead: ${errors.join("; ")}`);
	const { brief, errors: briefErrors } = readBrief(story.dir);
	if (!brief) throw new Error(`lead: ${briefErrors.join("; ")}`);
	const missing = brief.invariants.filter(inv => !new RegExp(`\\b${inv.id}\\b`).test(plan.text)).map(inv => inv.id);
	if (missing.length) throw new Error(`lead: plan does not mention invariant(s) ${missing.join(", ")}`);
	const undescribed = undescribedRepos(story.layout, plan.repos);
	if (undescribed.length) {
		throw new Error(
			`lead: every repository in the plan needs a project note with a services block (${undescribed.join("; ")}). ` +
				`Add this to each note, one entry per service, and set the note's \`updated:\` date:\n${PROJECT_NOTE_BLOCK}`,
		);
	}
	const names = noteNames(plan.repos);
	const checks = readHardGates(story.layout.policy).gates?.checks ?? {};
	for (const ac of brief.acs) if (!plan.proof.some(row => row.ac === ac.id)) throw new Error(`lead: ${ac.id} has no proof row`);
	for (const row of plan.proof) {
		if (!brief.acs.some(ac => ac.id === row.ac)) throw new Error(`lead: proof row ${row.ac} names no brief AC`);
		if (row.repo && !names.includes(row.repo)) throw new Error(`lead: proof row ${row.ac} names ${row.repo}, which is not in the plan's repos`);
	}
	for (const name of names) {
		if (!checks[name]) throw new Error(`lead: hard-gates.md has no checks entry for ${name}; the lead adds one (see the text under its yaml block)`);
	}
	for (const row of plan.proof) {
		if (row.acceptance && row.repo && !checks[row.repo]?.acceptance) {
			throw new Error(`lead: ${row.repo} has no acceptance config in hard-gates.md; use a test row or mark the AC unprovable`);
		}
	}
	if (!ctx.hasUI) throw new Error("lead: approval needs an interactive session");
	// The first lines are the project notes, in the order of their names; the lead's own notes follow.
	const notes = freshnessLines(story.layout, plan.repos).map(
		(line, i) => `- ${line}${i < names.length && lead().editedNotes.has(names[i]) ? " · services block changed in this session" : ""}`,
	);
	const criteria = brief.acs.map(ac => `- ${ac.id}: ${ac.text} → ${proofSummary(plan.proof.filter(row => row.ac === ac.id))}`);
	const invariants = brief.invariants.length ? brief.invariants.map(inv => `- ${inv.id}: ${inv.text}`) : ["none"];
	const sections = [
		plan.summary.join("\n"),
		`Acceptance criteria and proof:\n${criteria.join("\n")}`,
		`Invariants:\n${invariants.join("\n")}`,
		`Boundaries:\n${brief.boundaries.join("\n")}`,
		`Repos: ${plan.repos.join(", ")}`,
		`Notes:\n${notes.join("\n")}`,
	];
	const yes = await ctx.ui.confirm(`Approve brief and plan for ${story.id}?`, sections.join("\n\n"));
	if (!yes) return "plan NOT approved; revise it with the lead and call approve again";
	await updateStoryState(story.dir, state => {
		state.plan = { digest: approvalDigest(plan, brief), approvedAt: new Date().toISOString() };
	});
	story.invariants = brief.invariants;
	story.mode = brief.mode;
	lead().notifiedPlanChange = false;
	return `plan approved; building may start (/build ${story.id})`;
}

/** Starts the loop for the story: new budgets, and the commit each repository is at as the base the proof tests must fail on. */
async function startLoop(story: ActiveStory): Promise<void> {
	lead().building = true;
	const { plan } = readPlan(story.dir);
	await updateStoryState(story.dir, state => {
		Object.assign(state.loop, { failures: {}, reviewRounds: 0, continuations: 0, stuck: null, readyNotified: null });
		for (const root of plan?.repos ?? []) {
			const name = noteNames([root])[0];
			const head = headSha(root);
			if (head && !state.loop.base[name]) state.loop.base[name] = head;
		}
	});
}

/** The text parts of the last assistant message. */
function lastAssistantText(messages: readonly unknown[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (!isObject(message) || message.role !== "assistant") continue;
		if (typeof message.content === "string") return message.content;
		if (!Array.isArray(message.content)) return "";
		return message.content.flatMap((part: unknown) => (isObject(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : [])).join("\n");
	}
	return "";
}

/** The reviewer's `# Lead review` block; undefined until the plan is approved. */
function reviewBlockFor(story: ActiveStory): string | undefined {
	if (!planApproved(story).approved) return undefined;
	const { plan } = readPlan(story.dir);
	return plan && reviewBlock(story, plan, readStoryState(story.dir), heads(plan.repos));
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

/**
 * Computes the story's status from the pull request of each plan repository's current branch and records it.
 * `endWhenDone` clears the active story once every pull request is merged (the explicit op); the refresh on activation keeps it.
 */
async function recordStatus(pi: ExtensionAPI, story: ActiveStory, endWhenDone: boolean): Promise<string> {
	const { plan, errors } = readPlan(story.dir);
	if (!plan) throw new Error(`lead: ${errors.join("; ")}`);
	const prs: Status["prs"] = [];
	const lines: string[] = [];
	for (const repo of plan.repos) {
		const branch = (await pi.exec("git", ["-C", repo, "rev-parse", "--abbrev-ref", "HEAD"], { timeout: STATUS_TIMEOUT_MS })).stdout.trim();
		const listed = await pi.exec("gh", ["pr", "list", "--head", branch, "--state", "all", "--json", "url,state", "--limit", "1"], { cwd: repo, timeout: STATUS_TIMEOUT_MS });
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
	if (value === "done" && endWhenDone) lead().story = undefined;
	return [`status: ${value}`, ...urls].join("\n");
}

const RETRO_CAUSES = ["spec gap", "missing invariant", "missing context (project note)", "missing test", "rule/skill gap", "model error"];

/** Appends an escaped bug to retro-log.md with the cause the lead picks. */
async function recordRetro(p: LeadParams, policyDir: string, ctx: ExtensionContext): Promise<string> {
	const [story, summary, artifact] = [p.story, p.summary, p.artifact].map(value => value?.replace(/\s+/g, " ").trim());
	if (!story || !summary || !artifact) throw new Error("lead: retro needs story, summary and artifact");
	if (!ctx.hasUI) throw new Error("lead: retro needs an interactive session");
	const cause = await ctx.ui.select(`Escaped bug in ${story}: ${summary}. Cause?`, RETRO_CAUSES);
	if (cause === undefined) return "retro not recorded";
	const file = path.join(policyDir, "retro-log.md");
	const line = `- ${new Date().toLocaleDateString("en-CA")} · ${cause} · ${story} · ${summary} · fixed: ${artifact}\n`;
	await withFileLock(leadLock(file), `${tildify(file)} is being updated by another session; retry`, () => {
		fs.mkdirSync(policyDir, { recursive: true });
		atomicWrite(file, (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : RETRO_HEADER) + line);
	});
	return line.trimEnd();
}

export default function leadExtension(pi: ExtensionAPI): void {
	if (process.env.OMP_STARTER_LEAD === "off") return;
	const z = pi.zod;

	pi.on("session_start", (_event, ctx) => {
		if (ctx.agent?.kind === "sub") return;
		resetLead(ctx.sessionManager.getSessionId());
		const layout = leadLayoutFor(ctx.cwd);
		if (!layout || !leadReady(layout)) return;
		try {
			// pr-format.md describes checks that live in this plugin's code, so it follows the plugin version.
			if (syncGenerated(layout).briefTemplateDiffers && ctx.hasUI) {
				ctx.ui.notify(`lead: ${tildify(layout.templates)}/brief-template.md differs from the template this plugin version ships; delete it and run /starter lead to take the new one, or keep yours.`, "info");
			}
		} catch {
			// A vault that cannot be read right now (iCloud) must not break the session start.
		}
	});

	pi.on("input", async (event, ctx) => {
		if (ctx.agent?.kind === "sub") return;
		const layout = leadLayoutFor(ctx.cwd);
		if (!layout || !leadReady(layout)) return;
		const command = COMMAND.exec(event.text);
		if (!command) return;
		const problem = refusal(command[1], command[2], layout, ctx);
		if (problem) {
			ctx.ui.notify(problem, "error");
			return { handled: true };
		}
		const story = lead().story;
		if (command[1] === "build" && story) await startLoop(story);
		else lead().building = false;
		// Returning to a story with an approved plan: bring status.md up to date; a failing gh must not hold the command.
		if (story && readStoryState(story.dir).plan) await recordStatus(pi, story, false).catch(() => undefined);
	});

	pi.on("before_agent_start", (event, ctx) => {
		const story = lead().story;
		if (!story) return;
		const agent = ctx.agent;
		if (agent && agent.kind !== "main" && !LEAD_SUBAGENTS[agent.name.toLowerCase()]) return;
		const blocks: string[] = [];
		if (!event.systemPrompt.some(s => s.includes(STORY_BLOCK_HEADER))) blocks.push(storyBlock(story));
		if (agent?.kind === "sub" && agent.name.toLowerCase() === "code-reviewer" && !event.systemPrompt.some(s => s.includes(REVIEW_BLOCK_HEADER))) {
			const review = reviewBlockFor(story);
			if (review) blocks.push(review);
		}
		if (blocks.length) return { systemPrompt: [...event.systemPrompt, ...blocks] };
	});

	// The fence: no repository edits before the plan is approved; afterwards nothing outside the plan's repositories.
	pi.on("tool_call", (event, ctx) => {
		// While the loop builds, the lead is out of it: a question to them would stall the build.
		if (lead().building && ctx.agent?.kind !== "sub" && event.toolName === "ask") {
			return {
				block: true,
				reason: `lead loop: the lead is out of the loop during /build. Decide yourself and record it in the plan's ## Decision log; if the work cannot meet an invariant or boundary, write why to ${path.join(lead().story?.dir ?? "<story dir>", "stuck.md")} and stop.`,
			};
		}
		// Before a write to a project note, keep what the harness read from it, so the result can tell a prose edit from a change to its services.
		const notesDir = leadLayoutFor(ctx.cwd)?.notes;
		if (notesDir) for (const name of targetedNotes(event.toolName, event.input, ctx.cwd, notesDir)) lead().noteBefore.set(name, machinePart(notesDir, name));
		const story = lead().story;
		if (!story) return;
		const paths = touchedPaths(event.toolName, (event.input ?? {}) as Record<string, unknown>, ctx.cwd).filter(p => !inLead(story.layout, p));
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

	// Agents keep the project notes current. The lead is not asked, so each change to a services block is announced and has to be described in the PR.
	pi.on("tool_result", async (event, ctx) => {
		if (event.isError) return;
		const layout = leadLayoutFor(ctx.cwd);
		if (!layout || !leadReady(layout)) return;
		const story = lead().story;
		const context: string[] = [];
		for (const name of targetedNotes(event.toolName, event.input, ctx.cwd, layout.notes)) {
			const file = path.join(layout.notes, `${name}.md`);
			const before = lead().noteBefore.get(name);
			lead().noteBefore.delete(name);
			const { note, error } = readProjectNote(layout.notes, name);
			if (before !== undefined && before !== machinePart(layout.notes, name)) {
				lead().editedNotes.add(name);
				leadNotify(ctx, `omp lead · ${story?.id ?? "session"} · services block of ${name}.md changed by ${ctx.agent?.name ?? "main"}`);
				if (story) {
					await updateStoryState(story.dir, state => {
						state.mapEditedAt = new Date().toISOString();
					});
				}
				if (error) context.push(`[lead] ${error}. Fix it now: plan approval and the structural gate read it.`);
			}
			if (note && noteAge(fs.readFileSync(file, "utf8")).updated !== today()) {
				context.push(`[lead] Set \`updated: ${today()}\` in the frontmatter of ${tildify(file)}: the lead approves plans against this note and sees its date.`);
			}
		}
		if (context.length) return { additionalContext: context.join("\n") };
	});

	const builderId = (ctx: ExtensionContext): string | undefined =>
		ctx.agent?.kind === "sub" && BUILDERS[ctx.agent.name.toLowerCase()] ? (ctx.agent.id ?? ctx.sessionManager.getSessionId()) : undefined;

	pi.on("agent_start", (_event, ctx) => {
		const id = builderId(ctx);
		if (id) lead().runningBuilders.add(id);
	});

	pi.on("agent_end", async (event, ctx) => {
		const id = builderId(ctx);
		if (id) lead().runningBuilders.delete(id);
		const story = lead().story;
		// The reviewer's verdict is how the loop learns a review is clean; only one for the current HEADs counts.
		if (story && ctx.agent?.kind === "sub" && ctx.agent.name.toLowerCase() === "code-reviewer" && !event.willContinue) {
			await recordVerdict(story, lastAssistantText(event.messages));
		}
		// In async mode the lead is away: tell them when the main session comes to rest, and how many gates wait for them. While the loop builds, its controller tells them instead.
		if (story?.mode !== "async" || ctx.agent?.kind === "sub" || event.willContinue || lead().building) return;
		const queued = lead().pending.size;
		leadNotify(ctx, `omp lead · ${story.id} · agent stopped: review or approve${queued ? ` · ${queued} gate${queued === 1 ? "" : "s"} queued` : ""}`);
	});

	pi.on("before_subagent_spawn", event => {
		const story = lead().story;
		if (!story) return;
		// The reviewer runs on another model than the builders (the task role), so it does not grade its own kind's work.
		if (event.agent.toLowerCase() === "code-reviewer") return { model: "@slow", note: "lead: independent reviewer on the slow role" };
		if (!BUILDERS[event.agent.toLowerCase()]) return;
		const limit = readHardGates(story.layout.policy).gates?.limits.builders ?? 2;
		const running = lead().runningBuilders.size;
		if (running < limit) return;
		return { block: true, reason: `lead: ${running} builders already running (limits.builders = ${limit} in hard-gates.md); wait for one to finish.` };
	});

	// The loop controller: at the end of a main-session turn it either sends the next step or lets the session rest.
	pi.on("session_stop", (_event, ctx) => loopStop(pi, ctx));

	pi.registerTool({
		name: "lead",
		label: "Lead",
		description:
			"Lead-driven workflow actions that need the lead (the user). approve: show the active story's brief criteria, proof plan and plan summary " +
			"to the lead for the single approval. gate: let the lead decide pending hard gates. status: compute the story's status from " +
			"GitHub and write status.md. retro: record an escaped bug in retro-log.md; the lead picks the cause. " +
			"No argument approves anything: every decision is a dialog only the user can answer. " +
			"check: run the lead's commands for a stage (verify, test, proof, acceptance) and record receipts keyed by HEAD; the loop and the PR check read them.",
		parameters: z.object({
			op: z.enum(["approve", "gate", "status", "retro", "check"]),
			story: z.string().optional().describe("retro: story id or PR"),
			summary: z.string().optional().describe("retro: what escaped, one line"),
			artifact: z.string().optional().describe("retro: root artifact that was fixed, a path"),
			stage: z.enum(["verify", "test", "proof", "acceptance"]).optional().describe("check: which stage to run"),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			if (ctx.agent?.kind === "sub") throw new Error("lead: only the main session can call this tool");
			const layout = leadLayoutFor(ctx.cwd);
			if (!layout) throw new Error("lead: no knowledge base serves this folder; run /starter kb, then /starter lead");
			const p = params as LeadParams;
			let text: string;
			if (p.op === "approve") text = await approvePlan(ctx);
			else if (p.op === "gate") text = await decideGates(ctx);
			else if (p.op === "status") text = await recordStatus(pi, activeStory(), true);
			else if (p.op === "check") {
				if (!p.stage) throw new Error("lead: check needs a stage");
				text = await runCheck(pi, activeStory(), p.stage, signal);
			} else text = await recordRetro(p, layout.policy, ctx);
			return { content: [{ type: "text", text }] };
		},
	});
}
