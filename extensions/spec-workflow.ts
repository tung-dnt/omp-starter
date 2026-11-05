// The spec-workflow scheduler as an omp extension: `/run-story` and `/run-task` run a plan from the vault to the end, `/run-stop` stops
// the run, `/spec-status` and the read-only `spec_status` tool show where it stands, and an `input` handler keeps typed prompts from
// starting a parallel main-agent turn while a run is active. No orchestration logic lives here: the commands build the deps (real git
// and checks, the SDK slot runner, a TUI gate) and call `runPlan` (lib/spec-scheduler.ts).
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { UsageError, parseArgs } from "./lib/spec-cli";
import { DEFAULT_VAULT_GIT_DIR } from "./lib/spec-diff";
import { cloneIdentities } from "./lib/spec-git";
import { type OpsConfig, realCheckOps, realGitOps, vaultRootOf } from "./lib/spec-ops";
import { type Plan, parsePlan } from "./lib/spec-plan";
import { fileRunLog } from "./lib/spec-runlog";
import { DEFAULTS, type Gate, type RunSummary, runPlan, statusFromGit } from "./lib/spec-scheduler";
import { createSlotRunner, sdkOf } from "./lib/spec-slot-runner";
import { SLOTS } from "./lib/spec-slots";
import { renderStatus } from "./lib/spec-status";
import { errorMessage } from "./lib/tooling/runtime";

/** Where the slot agents are read from, once per run: a fixed folder, never a worktree a slot can write into. */
const AGENT_DIR = path.resolve(import.meta.dir, "..");
const STATUS_KEY = "spec-run";
const USAGE =
	"Usage: /run-story <plan> [--repo <path>]... [--branch <ticket>] [--base <ref>] [--concurrency <n>] [--budget <usd>] [--vault-git-dir <dir>]\n" +
	"       <plan> is the plan's path in the vault repo, or its file path under the vault work tree; --repo defaults to the current folder.";
const FLAGS = { list: ["repo"], value: ["branch", "base", "concurrency", "budget", "vault-git-dir"] } as const;

/** The arguments of the `spec_status` tool. */
interface StatusParams {
	plan?: string;
	repo?: string[];
	branch?: string;
	vault_git_dir?: string;
}

interface Prepared {
	config: OpsConfig;
	plan: Plan;
	concurrency?: number;
	budgetUsd?: number;
}

/** The plan's path inside the vault repo: as given, or relative to the vault work tree when given as a file path. */
function vaultPath(plan: string, root: string): string {
	if (!path.isAbsolute(plan)) return plan;
	const relative = path.relative(root, plan);
	if (relative.startsWith("..") || path.isAbsolute(relative)) throw new UsageError(`${plan} is not inside the vault work tree ${root}`);
	return relative;
}

function positive(label: string, value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const number = Number(value);
	if (!Number.isFinite(number) || number <= 0) throw new UsageError(`${label} must be a positive number, got ${value}`);
	return number;
}

/** Everything a run or a status needs from the command line: the vault, the plan (read and parsed once to learn its id), and the clones. */
function prepare(argv: readonly string[], cwd: string): Prepared {
	const args = parseArgs(argv, FLAGS);
	const concurrency = positive("--concurrency", args.value("concurrency"));
	const budgetUsd = positive("--budget", args.value("budget"));
	const [planArg, ...extra] = args.positional;
	if (planArg === undefined) throw new UsageError("missing <plan>");
	if (extra.length > 0) throw new UsageError(`unexpected argument ${extra[0]}`);
	const vaultGitDir = path.resolve(args.value("vault-git-dir") ?? DEFAULT_VAULT_GIT_DIR);
	const vaultRoot = vaultRootOf(vaultGitDir);
	const planPath = vaultPath(planArg, vaultRoot);
	const parsed = parsePlan(fs.readFileSync(path.join(vaultRoot, planPath), "utf8"));
	if (!parsed.ok) throw new Error(`the plan does not parse:\n${parsed.errors.map(error => `${error.rule}: ${error.detail}`).join("\n")}`);
	const repos = args.list("repo");
	const clones = cloneIdentities(repos.length > 0 ? repos.map(repo => path.resolve(cwd, repo)) : [cwd]);
	const base = args.value("base");
	return {
		plan: parsed.plan,
		config: { clones, story: parsed.plan.id, ticket: args.value("branch") ?? parsed.plan.id, ...(base === undefined ? {} : { base }), vaultGitDir, vaultRoot, planPath },
		...(concurrency === undefined ? {} : { concurrency }),
		...(budgetUsd === undefined ? {} : { budgetUsd }),
	};
}

/** The status of the plan's story from git alone, as the status CLI prints it. */
function statusText(prepared: Prepared): string {
	const git = realGitOps(prepared.config);
	const snapshot = git.plan();
	const parsed = parsePlan(snapshot.text);
	if (!parsed.ok) throw new Error("the plan does not parse");
	const note = snapshot.committed ? "" : "\nnote: plan.md has uncommitted edits in the vault; the scheduler refuses to run until they are committed";
	return `${renderStatus(statusFromGit(git, parsed.plan, snapshot.rev))}${note}`;
}

/** Gates in the TUI: the choices are code's, the human picks one; a dismissed dialog takes the request's stopping choice. */
function tuiGate(ui: ExtensionCommandContext["ui"]): Gate {
	return {
		async choose(request, signal) {
			const dialog = signal === undefined ? undefined : { signal };
			ui.notify(`${request.title}\n${request.detail}`, "warning");
			const picked = await ui.select(request.title, request.choices.map(choice => choice.label), dialog);
			const choice = request.choices.find(candidate => candidate.label === picked);
			if (choice === undefined) return { choice: request.fallback };
			if (!choice.note) return { choice: choice.id };
			const note = await ui.input(`Note for ${request.task ?? "the run"}`, "What should the agent know?", dialog);
			if (note === undefined) return { choice: request.fallback };
			return note.trim() === "" ? { choice: choice.id } : { choice: choice.id, note: note.trim() };
		},
	};
}

function report(summary: RunSummary, logFile: string): string {
	const lines = [summary.status === undefined ? `run ${summary.outcome}` : renderStatus(summary.status), `outcome: ${summary.outcome}, $${summary.costUsd.toFixed(2)} in ${summary.slotRuns} slot runs`];
	for (const reason of summary.reasons) lines.push(`- ${reason}`);
	lines.push(`run log: ${logFile}`);
	return lines.join("\n");
}

export default function specWorkflow(pi: ExtensionAPI): void {
	let active: { controller: AbortController; prepared: Prepared } | undefined;
	let last: Prepared | undefined;

	const start = (kind: "story" | "task") => async (rawArgs: string, ctx: ExtensionCommandContext): Promise<void> => {
		if (active !== undefined) {
			ctx.ui.notify("A spec run is already active. /run-stop stops it.", "warning");
			return;
		}
		let prepared: Prepared;
		try {
			prepared = prepare(rawArgs.split(/\s+/).filter(Boolean), ctx.cwd);
		} catch (error) {
			ctx.ui.notify(error instanceof UsageError ? `${error.message}\n${USAGE}` : errorMessage(error), "error");
			return;
		}
		const controller = new AbortController();
		active = { controller, prepared };
		last = prepared;
		try {
			const sdk = sdkOf(pi);
			const agents = await sdk.discoverAgents(AGENT_DIR);
			const missing = [...new Set(Object.values(SLOTS).map(def => def.agent))].filter(name => !agents.some(agent => agent.name === name));
			if (missing.length > 0) {
				ctx.ui.notify(`The spec run was not started: no agent definition for ${missing.join(", ")}. Install agent-skills.`, "error");
				return;
			}
			const log = fileRunLog(prepared.plan.id, new Date());
			const summary = await runPlan(
				{
					slots: createSlotRunner({ sdk, agents, resolveModel: role => ctx.models.resolve(`@${role}`) }),
					gate: tuiGate(ctx.ui),
					git: realGitOps(prepared.config),
					checks: realCheckOps(prepared.config),
					log,
					now: () => new Date(),
				},
				{
					kind,
					concurrency: prepared.concurrency ?? DEFAULTS.concurrency,
					budgetUsd: prepared.budgetUsd ?? DEFAULTS.budgetUsd,
					signal: controller.signal,
					onStatus: line => ctx.ui.setStatus(STATUS_KEY, line),
				},
			);
			ctx.ui.notify(report(summary, log.file), summary.outcome === "complete" ? "info" : "warning");
		} catch (error) {
			ctx.ui.notify(`The spec run failed: ${errorMessage(error)}`, "error");
		} finally {
			active = undefined;
			ctx.ui.setStatus(STATUS_KEY, undefined);
		}
	};

	pi.registerCommand("run-story", { description: "Run a story plan from the vault: tests first, locks, implementation, checks, reviews, cherry-picks. Usage: /run-story <plan> [--repo path]...", handler: start("story") });
	pi.registerCommand("run-task", { description: "Run a one-task plan from the vault. Usage: /run-task <plan> [--repo path]...", handler: start("task") });

	pi.registerCommand("run-stop", {
		description: "Stop the active spec run: in-flight slots are aborted and the worktrees removed; no blocked note is written",
		handler: async (_args, ctx) => {
			if (active === undefined) ctx.ui.notify("No spec run is active.", "info");
			else {
				active.controller.abort();
				ctx.ui.notify("Stopping the spec run...", "info");
			}
		},
	});

	pi.registerCommand("spec-status", {
		description: "Status of a plan's tasks from git alone. Usage: /spec-status [<plan> --repo path...] (default: the last run)",
		handler: async (rawArgs, ctx) => {
			try {
				const argv = rawArgs.split(/\s+/).filter(Boolean);
				const prepared = argv.length > 0 ? (last = prepare(argv, ctx.cwd)) : last;
				if (prepared === undefined) throw new UsageError("no run yet: pass the plan");
				ctx.ui.notify(statusText(prepared), "info");
			} catch (error) {
				ctx.ui.notify(error instanceof UsageError ? `${error.message}\n${USAGE}` : errorMessage(error), "error");
			}
		},
	});

	const z = pi.zod;
	pi.registerTool({
		name: "spec_status",
		label: "Spec status",
		description:
			"Read-only status of a spec-workflow plan, computed from git alone: each task is done, ready, waiting, blocked, failing, checking or awaiting-lock. " +
			"Without arguments it reports the active or last run. `plan` is the plan's path in the vault repo.",
		parameters: z.object({
			plan: z.string().optional().describe("Plan path in the vault repo, e.g. Specs/PAC2/stories/PAC2-1234/plan.md"),
			repo: z.array(z.string()).optional().describe("Clone paths; default: the current folder"),
			branch: z.string().optional().describe("Ticket branch; default: the plan id"),
			vault_git_dir: z.string().optional().describe("Vault git dir; default: ~/.vault-git"),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const { plan, repo = [], branch, vault_git_dir } = params as StatusParams;
			const prepared =
				plan === undefined
					? (active?.prepared ?? last)
					: prepare(
							[
								plan,
								...repo.flatMap(path => ["--repo", path]),
								...(branch === undefined ? [] : ["--branch", branch]),
								...(vault_git_dir === undefined ? [] : ["--vault-git-dir", vault_git_dir]),
							],
							ctx.cwd,
						);
			if (prepared === undefined) throw new Error("no run yet: pass the plan");
			return { content: [{ type: "text", text: statusText(prepared) }], details: { story: prepared.plan.id } };
		},
	});

	// Typed prompts start a parallel main-agent turn (spike finding 6); during a run only the run controls are accepted.
	pi.on("input", (event, ctx) => {
		if (active === undefined || event.source !== "interactive") return undefined;
		const command = event.text.trim().split(/\s+/)[0];
		if (command === "/run-stop" || command === "/spec-status") return undefined;
		ctx.ui.notify("spec run active: /run-stop to stop", "warning");
		return { handled: true };
	});

	pi.on("session_shutdown", () => active?.controller.abort());
}
