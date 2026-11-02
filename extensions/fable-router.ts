// Subscription-local, capped escalation: Claude Fable → Opus; Codex Astra → Sol.
// Repeated unexpected failures suggest `deep`; risky reviews escalate automatically.
// Each subscription has its own daily cap and persistent counter.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { CODEX_MODELS, MODELS } from "./lib/routing";
import { HOME } from "./lib/state";

const ROUTES = {
	anthropic: {
		name: "fable",
		model: `${MODELS.fable}:high`,
		fallback: `${MODELS.opus}:high`,
		fallbackName: "opus",
		cap: Number(process.env.FABLE_ROUTER_DAILY_CAP ?? 5),
		stateFile: path.join(HOME, ".omp", "agent", "fable-router.json"),
	},
	"openai-codex": {
		name: "astra",
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

/** Consumes one escalation unit; returns the new count, or null at the cap. */
function takeQuota(route: Route): number | null {
	const used = readUsed(route);
	if (used >= route.cap) return null;
	const tmp = `${route.stateFile}.${process.pid}.tmp`;
	fs.mkdirSync(path.dirname(route.stateFile), { recursive: true });
	fs.writeFileSync(tmp, JSON.stringify({ day: today(), used: used + 1 }));
	fs.renameSync(tmp, route.stateFile);
	return used + 1;
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
	pi.on("before_subagent_spawn", (event, ctx) => {
		const provider: string | undefined = ctx.model?.provider;
		const route = provider === "anthropic" || provider === "openai-codex" ? ROUTES[provider] : undefined;
		if (!route) return;
		const agent = typeof event.agent === "string" ? event.agent : String(event.agent?.name ?? "");
		let reason: string;
		if (agent === "deep") {
			reason = "deep escalation";
		} else if (REVIEW_AGENTS[agent]) {
			const hits = changedFiles(ctx.cwd).filter(f => HIGH_STAKES.some(re => re.test(f)));
			if (hits.length === 0) return;
			reason = `diff touches ${hits.slice(0, 3).join(", ")}${hits.length > 3 ? ` +${hits.length - 3}` : ""}`;
		} else {
			return;
		}
		const used = takeQuota(route);
		if (used === null) {
			return { model: [route.fallback], note: `${route.name} cap ${route.cap}/day reached → ${route.fallbackName} (${reason})` };
		}
		const fallbacks = ((event.patterns ?? []) as string[])
			.filter(p => p.startsWith(`${ctx.model?.provider}/`) && p !== route.model && p !== route.fallback);
		return { model: [route.model, ...fallbacks, route.fallback], note: `${route.name}: ${reason} (${used}/${route.cap} today)` };
	});

	// Per-run failure counts, keyed by session agent id; reset on each agent run.
	const runs = new Map<string, { fails: Map<string, number>; escalated: boolean }>();
	const runKey = (ctx: { agent?: { id?: string } }) => ctx.agent?.id ?? "main";

	pi.on("agent_start", (_event, ctx) => {
		runs.delete(runKey(ctx));
	});

	pi.on("tool_result", (event, ctx) => {
		const provider: string | undefined = ctx.model?.provider;
		const route = provider === "anthropic" || provider === "openai-codex" ? ROUTES[provider] : undefined;
		if (!route) return;
		if (event.toolName !== "bash" || !event.isError || ctx.agent?.name === "deep") return;
		const command = String(event.input?.command ?? "").replace(/\s+/g, " ").trim();
		if (!command || PROBE.test(command)) return;

		let run = runs.get(runKey(ctx));
		if (!run) {
			run = { fails: new Map(), escalated: false };
			runs.set(runKey(ctx), run);
		}
		const count = (run.fails.get(command) ?? 0) + 1;
		run.fails.set(command, count);
		if (count < STUCK_REPEAT || run.escalated) return;

		const left = route.cap - readUsed(route);
		if (left <= 0) return;
		run.escalated = true;
		return {
			additionalContext:
				`[${route.name}-router] \`${command.slice(0, 120)}\` has failed ${count} times in this run. ` +
				"Ignore this notice if the failure is expected (a deliberate red test, a check meant to fail) " +
				"or the user said not to spawn agents. Otherwise, stop retrying variations and consider spawning the `deep` agent " +
				'(task tool, agent: "deep") with a self-contained brief: goal, what you tried, the exact error output, and the relevant files; ' +
				`implement its recommendation yourself. ${route.name} escalations left today: ${left}.`,
		};
	});
}
