// Subscription-local, capped escalation: Claude Fable → Opus; Codex Astra → Sol.
// Repeated unexpected failures suggest `deep`; risky reviews escalate automatically.
// Ladder: a run's first `deep` consult runs on Opus/Sol at high effort, uncounted; later ones go to Fable/Astra.
// Each subscription has its own daily cap and persistent counter.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { withFileLock } from "./lib/file-lock";
import { repoRoot } from "./lib/repo";
import { CODEX_MODELS, MODELS } from "./lib/routing";
import { HOME } from "./lib/state";
import { resolveFrom, simpleCommands, targetPaths } from "./lib/tool-input";

const ROUTES = {
	anthropic: {
		name: "fable",
		id: MODELS.fable,
		model: `${MODELS.fable}:high`,
		fallback: `${MODELS.opus}:high`,
		fallbackName: "opus",
		cap: Number(process.env.FABLE_ROUTER_DAILY_CAP ?? 5),
		stateFile: path.join(HOME, ".omp", "agent", "fable-router.json"),
	},
	"openai-codex": {
		name: "astra",
		id: CODEX_MODELS.astra,
		model: `${CODEX_MODELS.astra}:high`,
		fallback: `${CODEX_MODELS.sol}:high`,
		fallbackName: "sol",
		cap: Number(process.env.ASTRA_ROUTER_DAILY_CAP ?? 5),
		stateFile: path.join(HOME, ".omp", "agent", "astra-router.json"),
	},
} as const;
type Route = (typeof ROUTES)[keyof typeof ROUTES];

const STUCK_REPEAT = 2;

const REVIEW_AGENTS: Record<string, true> = { reviewer: true, "code-reviewer": true };
const HIGH_STAKES = [
	/(^|\/)(migrations?|migrate)\//i,
	/\.sql$/i,
	/(^|\/)(auth|rbac|permissions?|cognito)([/._-]|$)/i,
	/(^|\/)(infra|terraform|cdk)\//i,
	/(^|\/)serverless\.(ya?ml|ts)$/i,
	/^\.github\/workflows\//,
];
const BASE_REFS = ["origin/HEAD", "origin/main", "origin/master", "origin/develop", "origin/development"];
// Probe commands whose non-zero exit means "no match", not "stuck".
const PROBE = /^(grep|rg|egrep|fgrep|diff|test|\[|which|command -v|ls|cat|head|tail|find|git (diff|status|log|show|grep))\b/;

// en-CA formats as YYYY-MM-DD in local time, so the cap resets at local midnight.
function today(): string {
	return new Date().toLocaleDateString("en-CA");
}

function readUsed(route: Route): number {
	try {
		const state = JSON.parse(fs.readFileSync(route.stateFile, "utf8")) as { day?: string; used?: number };
		return state.day === today() ? Number(state.used) || 0 : 0;
	} catch {
		return 0;
	}
}

/** Consumes one escalation unit under a lock, so concurrent sessions can't pass the cap; returns the new count, or null at the cap. */
async function takeQuota(route: Route): Promise<number | null> {
	fs.mkdirSync(path.dirname(route.stateFile), { recursive: true });
	return withFileLock(`${route.stateFile}.lock`, `${route.stateFile} is locked by another session`, () => {
		const used = readUsed(route);
		if (used >= route.cap) return null;
		const tmp = `${route.stateFile}.${process.pid}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify({ day: today(), used: used + 1 }));
		fs.renameSync(tmp, route.stateFile);
		return used + 1;
	});
}

// Repos written by write/edit in this process. One process serves the main session and its subagents, and omp
// evaluates extension modules separately, so the set lives on `globalThis` (see lib/kb-write-flag).
const EDITED = Symbol.for("omp-starter.edited-repos");
const store = globalThis as typeof globalThis & { [EDITED]?: Set<string> };
const editedRepos = (store[EDITED] ??= new Set<string>());
const WRITE_TOOLS: Record<string, true> = { write: true, edit: true };

/** Repos a review covers: the session folder's own repo plus every repo edited in this process. */
function reviewRepos(cwd: string): string[] {
	const own = repoRoot(cwd);
	return [...new Set([...(own ? [own] : []), ...editedRepos])];
}

function git(cwd: string, args: string[]): string | null {
	try {
		return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }).trim();
	} catch {
		return null;
	}
}

/** Uncommitted, untracked, and branch-vs-base changed paths, repo-root relative. */
function changedFiles(cwd: string): string[] {
	const files = new Set<string>();
	const add = (out: string | null) => {
		for (const f of out ? out.split("\n") : []) if (f) files.add(f);
	};
	add(git(cwd, ["diff", "--name-only", "HEAD"]));
	add(git(cwd, ["ls-files", "--others", "--exclude-standard"]));
	for (const ref of BASE_REFS) {
		const base = git(cwd, ["merge-base", "HEAD", ref]);
		if (base) {
			add(git(cwd, ["diff", "--name-only", `${base}...HEAD`]));
			break;
		}
	}
	return [...files];
}

export default function fableRouter(pi: ExtensionAPI): void {
	// Per-run state keyed by session agent id, reset on each agent run: failure counts, whether a stuck
	// notice was sent, and whether the run's first `deep` consult already went to the high-effort step.
	const runs = new Map<string, { fails: Map<string, number>; escalated: boolean; laddered: boolean }>();
	const runKey = (ctx: { agent?: { id?: string } }) => ctx.agent?.id ?? "main";
	const runFor = (ctx: { agent?: { id?: string } }) => {
		let run = runs.get(runKey(ctx));
		if (!run) {
			run = { fails: new Map(), escalated: false, laddered: false };
			runs.set(runKey(ctx), run);
		}
		return run;
	};
	let leadWarned = false;

	pi.on("session_start", (_event, ctx) => {
		if (ctx.agent?.kind === "sub") return;
		editedRepos.clear();
		leadWarned = false;
	});

	pi.on("agent_start", (_event, ctx) => {
		runs.delete(runKey(ctx));
		// A main session led by Fable/Astra spends that quota on every turn and isn't counted by the cap.
		const provider: string | undefined = ctx.model?.provider;
		const route = provider === "anthropic" || provider === "openai-codex" ? ROUTES[provider] : undefined;
		if (leadWarned || ctx.agent?.kind === "sub" || !route || ctx.model?.id !== route.id || !ctx.hasUI) return;
		leadWarned = true;
		ctx.ui.notify(
			`${route.name} is leading this session: every turn uses ${route.name} quota and the daily cap of ${route.cap} ` +
				"does not count it. Keep it to a fresh session for one large job; run /compact or start a new session before switching models.",
			"warning",
		);
	});

	pi.on("before_subagent_spawn", async (event, ctx) => {
		const provider: string | undefined = ctx.model?.provider;
		const route = provider === "anthropic" || provider === "openai-codex" ? ROUTES[provider] : undefined;
		if (!route) return;
		const agent = event.agent;
		let reason: string;
		if (agent === "deep") {
			const run = runFor(ctx);
			// A session already led by the escalation model skips the step: Opus/Sol would be a downgrade.
			if (!run.laddered && ctx.model?.id !== route.id) {
				run.laddered = true;
				return {
					model: [route.fallback],
					note: `${route.fallbackName} high: first deep consult in this run (uncounted); the next one goes to ${route.name}`,
				};
			}
			reason = "deep escalation";
		} else if (REVIEW_AGENTS[agent]) {
			const repos = reviewRepos(ctx.cwd);
			const hits = repos.flatMap(repo =>
				changedFiles(repo)
					.filter(f => HIGH_STAKES.some(re => re.test(f)))
					.map(f => (repos.length > 1 ? `${path.basename(repo)}/${f}` : f)),
			);
			if (hits.length === 0) return;
			reason = `diff touches ${hits.slice(0, 3).join(", ")}${hits.length > 3 ? ` +${hits.length - 3}` : ""}`;
		} else {
			return;
		}
		const used = await takeQuota(route);
		if (used === null) {
			return { model: [route.fallback], note: `${route.name} cap ${route.cap}/day reached → ${route.fallbackName} (${reason})` };
		}
		const fallbacks = ((event.patterns ?? []) as string[])
			.filter(p => p.startsWith(`${ctx.model?.provider}/`) && p !== route.model && p !== route.fallback);
		return { model: [route.model, ...fallbacks, route.fallback], note: `${route.name}: ${reason} (${used}/${route.cap} today)` };
	});

	pi.on("tool_result", (event, ctx) => {
		if (!event.isError && WRITE_TOOLS[event.toolName]) {
			for (const p of targetPaths(event.toolName, (event.input ?? {}) as Record<string, unknown>)) {
				const root = p.includes("://") ? undefined : repoRoot(resolveFrom(ctx.cwd, p));
				if (root) editedRepos.add(root);
			}
			return;
		}
		const provider: string | undefined = ctx.model?.provider;
		const route = provider === "anthropic" || provider === "openai-codex" ? ROUTES[provider] : undefined;
		if (!route) return;
		if (event.toolName !== "bash" || !event.isError || ctx.agent?.name === "deep") return;
		const command = String(event.input?.command ?? "").replace(/\s+/g, " ").trim();
		// Judge the first command after any leading `cd`: `cd repo && rg x` finding nothing is still a probe.
		const first = simpleCommands(command).find(c => c.words[0] !== "cd");
		if (!command || PROBE.test(first?.words.join(" ") ?? "")) return;

		const run = runFor(ctx);
		const count = (run.fails.get(command) ?? 0) + 1;
		run.fails.set(command, count);
		if (count < STUCK_REPEAT || run.escalated) return;

		const left = route.cap - readUsed(route);
		const ladder = !run.laddered && ctx.model?.id !== route.id;
		if (left <= 0 && !ladder) return;
		run.escalated = true;
		return {
			additionalContext:
				`[${route.name}-router] \`${command.slice(0, 120)}\` has failed ${count} times in this run. ` +
				"Ignore this notice if the failure is expected (a deliberate red test, a check meant to fail) " +
				"or the user said not to spawn agents. Otherwise, stop retrying variations and consider spawning the `deep` agent " +
				'(task tool, agent: "deep") with a self-contained brief: goal, what done looks like and how to verify it, ' +
				"what you tried, the exact error output, and the relevant files; implement its recommendation yourself. " +
				(ladder
					? `This run's first deep consult uses ${route.fallbackName} at high effort and is not counted; a second one uses ${route.name}. `
					: "") +
				`${route.name} escalations left today: ${Math.max(left, 0)}.`,
		};
	});
}
