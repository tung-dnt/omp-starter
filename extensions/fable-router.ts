// Fable router: deterministic, capped escalation to Claude Fable.
//
// 1. Stuck detector: when the same bash command fails twice in one agent run, suggest delegating
//    to the `deep` agent instead of retrying. Advisory: expected failures (red tests) and
//    "don't spawn" instructions win.
// 2. High-stakes review: a `reviewer` / `code-reviewer` spawn runs on Fable when the git diff
//    touches migrations, SQL, auth/RBAC, infra, or CI workflows.
// 3. Daily cap: every Fable spawn (deep agent or escalated reviewer) consumes one unit; past the
//    cap the spawn is rerouted to Opus with a visible note. `FABLE_ROUTER_DAILY_CAP` (default 5).
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { MODELS } from "./lib/routing";
import { HOME } from "./lib/state";

const FABLE = `${MODELS.fable}:high`;
const OPUS = `${MODELS.opus}:high`;
const DAILY_CAP = Number(process.env.FABLE_ROUTER_DAILY_CAP ?? 5);
const STATE_FILE = path.join(HOME, ".omp", "agent", "fable-router.json");
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

function readUsed(): number {
	try {
		const state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as { day?: string; used?: number };
		return state.day === today() ? Number(state.used) || 0 : 0;
	} catch {
		return 0;
	}
}

/** Consumes one Fable unit; returns the new count, or null when the cap is reached. */
function takeQuota(): number | null {
	const used = readUsed();
	if (used >= DAILY_CAP) return null;
	const tmp = `${STATE_FILE}.${process.pid}.tmp`;
	fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
	fs.writeFileSync(tmp, JSON.stringify({ day: today(), used: used + 1 }));
	fs.renameSync(tmp, STATE_FILE);
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
		const used = takeQuota();
		if (used === null) {
			return { model: [OPUS], note: `fable cap ${DAILY_CAP}/day reached → opus (${reason})` };
		}
		const fallbacks = ((event.patterns ?? []) as string[]).filter(p => p !== FABLE);
		return { model: [FABLE, ...fallbacks, OPUS], note: `fable: ${reason} (${used}/${DAILY_CAP} today)` };
	});

	// Per-run failure counts, keyed by session agent id; reset on each agent run.
	const runs = new Map<string, { fails: Map<string, number>; escalated: boolean }>();
	const runKey = (ctx: { agent?: { id?: string } }) => ctx.agent?.id ?? "main";

	pi.on("agent_start", (_event, ctx) => {
		runs.delete(runKey(ctx));
	});

	pi.on("tool_result", (event, ctx) => {
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

		const left = DAILY_CAP - readUsed();
		if (left <= 0) return;
		run.escalated = true;
		return {
			additionalContext:
				`[fable-router] \`${command.slice(0, 120)}\` has failed ${count} times in this run. ` +
				"Ignore this notice if the failure is expected (a deliberate red test, a check meant to fail) " +
				"or the user said not to spawn agents. Otherwise, stop retrying variations and consider spawning the `deep` agent " +
				'(task tool, agent: "deep") with a self-contained brief: goal, what you tried, the exact error output, and the relevant files; ' +
				`implement its recommendation yourself. Fable escalations left today: ${left}.`,
		};
	});
}
