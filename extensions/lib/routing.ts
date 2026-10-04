// Claude model + effort routing profile: written to omp settings by the setup wizard's
// "models" step, and read by the Fable router so both agree on model ids.
import type { Exec, WizardUi } from "../setup";

export const MODELS = {
	opus: "anthropic/claude-opus-5-5",
	sonnet: "anthropic/claude-sonnet-5-5",
	haiku: "anthropic/claude-haiku-4-5",
	fable: "anthropic/claude-fable-5-1",
} as const;

interface Setting {
	key: string;
	value: unknown;
	/** Merge into the existing record instead of replacing it. */
	merge?: boolean;
}

// Planning gets the effort (one plan feeds every slice); coders keep a `high` floor and the
// parent raises risky slices to `max`; Fable is reserved for the `deep` role and the router.
export const PROFILE: Setting[] = [
	{ key: "defaultThinkingLevel", value: "auto" },
	{
		key: "modelRoles",
		merge: true,
		value: {
			default: `${MODELS.opus}:auto`,
			slow: `${MODELS.opus}:high`,
			plan: "@slow",
			deep: `${MODELS.fable}:high`,
			task: `${MODELS.sonnet}:high`,
			smol: MODELS.sonnet,
			tiny: MODELS.haiku,
			judge: MODELS.haiku,
			commit: "@smol",
		},
	},
	{ key: "cycleOrder", value: ["smol", "default", "slow", "deep"] },
	{ key: "task.enableEffort", value: true },
	{ key: "task.maxEffort", value: "max" },
	{
		key: "task.agentModelOverrides",
		merge: true,
		value: {
			sonic: "@tiny",
			// agent-skills agents carry Claude Code model names that omp does not resolve.
			"state-investigator": "@tiny",
			"code-reviewer": "@smol",
			"task-builder": "@task",
			"test-engineer": "@task",
			"web-performance-auditor": "@task",
			// Fable's safety classifier may refuse security work.
			"security-reviewer": `${MODELS.opus}:high`,
			"security-auditor": `${MODELS.opus}:high`,
		},
	},
	{
		key: "retry.fallbackChains",
		merge: true,
		value: { [MODELS.fable]: [MODELS.opus], [MODELS.opus]: [MODELS.sonnet] },
	},
];

async function omp(exec: Exec, args: string[]): Promise<string> {
	const result = await exec("omp", args, { timeout: 60_000 });
	if (result.code !== 0) throw new Error(`omp ${args.join(" ")}: ${(result.stderr || result.stdout).trim()}`);
	return result.stdout;
}

export async function setupModels(ui: WizardUi, exec: Exec): Promise<"done" | "skipped"> {
	const listed = JSON.parse(await omp(exec, ["models", "anthropic", "--json"])) as { models: { selector: string }[] };
	const available = new Set(listed.models.map(m => m.selector));
	const missing = Object.values(MODELS).filter(m => !available.has(m));
	if (missing.length > 0) {
		ui.notify(`Model routing skipped: needs a Claude login with ${missing.join(", ")} (run /login).`, "warning");
		return "skipped";
	}
	const ok = await ui.confirm(
		"Model routing",
		"Route work by model tier? Main session: Opus (auto effort). Planning and review: Opus at high effort. " +
			"Coding subagents: Sonnet at high effort, raised to max for risky slices. Exploration: Sonnet. " +
			"Mechanical work and classifiers: Haiku. Fable: only for the `deep` agent and the capped auto-router. " +
			"Existing role assignments with the same names are replaced; others are kept.",
	);
	if (!ok) return "skipped";
	for (const { key, value, merge } of PROFILE) {
		let next = value;
		if (merge) {
			const current = JSON.parse((await omp(exec, ["config", "get", key])).trim() || "{}") as Record<string, unknown>;
			next = { ...current, ...(value as Record<string, unknown>) };
		}
		await omp(exec, ["config", "set", key, typeof next === "string" ? next : JSON.stringify(next)]);
	}
	ui.notify("Model routing applied. Restart open sessions to pick it up.", "info");
	return "done";
}
