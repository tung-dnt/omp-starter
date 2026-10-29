// Subscription model + effort presets and subscription-agnostic agent settings, written by the
// setup wizard's "models" step. The Fable router shares the Claude model ids.
import type { Exec, WizardUi } from "../setup";

export const MODELS = {
	opus: "anthropic/claude-opus-5-5",
	sonnet: "anthropic/claude-sonnet-5-5",
	haiku: "anthropic/claude-haiku-5-5",
	fable: "anthropic/claude-fable-5-1",
} as const;

export const CODEX_MODELS = {
	sol: "openai-codex/gpt-6.1-sol",
	luna: "openai-codex/gpt-6-luna",
} as const;

export const MODEL_PRESETS = {
	codex: {
		modelRoles: {
			default: "openai-codex/gpt-6.1-sol",
			slow: "openai-codex/gpt-6.1-sol:high",
			plan: "@slow",
			deep: "openai-codex/gpt-6.1-sol:high",
			task: "openai-codex/gpt-6-luna:high",
			smol: "openai-codex/gpt-6-luna",
			tiny: "openai-codex/gpt-6-luna:low",
			judge: "openai-codex/gpt-6-luna:low",
			commit: "@smol",
			advisor: "openai-codex/gpt-6-luna:medium",
		},
		defaultThinkingLevel: "auto",
	},
	claude: {
		modelRoles: {
			default: `${MODELS.opus}:auto`,
			slow: `${MODELS.opus}:high`,
			plan: "@slow",
			deep: `${MODELS.fable}:high`,
			task: `${MODELS.sonnet}:high`,
			smol: MODELS.sonnet,
			tiny: MODELS.haiku,
			judge: MODELS.haiku,
			commit: "@smol",
			advisor: `${MODELS.sonnet}:medium`,
		},
		defaultThinkingLevel: "auto",
	},
} as const;

interface Setting {
	key: string;
	value: unknown;
	/** Merge into the existing record instead of replacing it. */
	merge?: boolean;
}

// Written on every subscription: none of these names a concrete model.
// Planning gets the effort (one plan feeds every slice); coders keep a `high` floor and the
// parent raises risky slices to `max`; Fable is reserved for the `deep` role and the router.
export const COMMON: Setting[] = [
	{ key: "defaultThinkingLevel", value: "auto" },
	{ key: "modelPresets", merge: true, value: MODEL_PRESETS },
	{ key: "cycleOrder", value: ["smol", "default", "slow", "deep"] },
	{ key: "task.enableEffort", value: true },
	{ key: "task.maxEffort", value: "max" },
	{
		key: "task.agentModelOverrides",
		merge: true,
		value: {
			sonic: "@tiny",
			// Read-only, short runs: Haiku 5.5 in the claude preset, Luna in codex.
			scout: "@tiny",
			// agent-skills agents carry Claude Code model names that omp does not resolve.
			"state-investigator": "@tiny",
			"code-reviewer": "@smol",
			"task-builder": "@task",
			"test-engineer": "@task",
			"web-performance-auditor": "@task",
			// Fable's safety classifier may refuse security work.
			"security-reviewer": "@slow",
			"security-auditor": "@slow",
		},
	},
	// LSP diagnostics after every edit, not only after whole-file writes; the TTSR reminders in
	// rules/ (LSP over grep, debugger over print) may fire again after 10 turns instead of once.
	{ key: "lsp.diagnosticsOnEdit", value: true },
	{ key: "ttsr.repeatMode", value: "after-gap" },
	{ key: "ttsr.repeatGap", value: 10 },
];

/** Active routing for one subscription, applied only when all of its models are available. */
const ROUTING = {
	claude: {
		models: Object.values(MODELS),
		settings: [
			{ key: "modelRoles", merge: true, value: MODEL_PRESETS.claude.modelRoles },
			{ key: "retry.fallbackChains", merge: true, value: { [MODELS.fable]: [MODELS.opus], [MODELS.opus]: [MODELS.sonnet] } },
		],
	},
	codex: {
		models: Object.values(CODEX_MODELS),
		settings: [{ key: "modelRoles", merge: true, value: MODEL_PRESETS.codex.modelRoles }],
	},
} satisfies Record<keyof typeof MODEL_PRESETS, { models: string[]; settings: Setting[] }>;

async function omp(exec: Exec, args: string[]): Promise<string> {
	const result = await exec("omp", args, { timeout: 60_000 });
	if (result.code !== 0) throw new Error(`omp ${args.join(" ")}: ${(result.stderr || result.stdout).trim()}`);
	return result.stdout;
}

async function available(exec: Exec, provider: string): Promise<Set<string>> {
	const listed = JSON.parse(await omp(exec, ["models", provider, "--json"])) as { models: { selector: string }[] };
	return new Set(listed.models.map(m => m.selector));
}

export async function applySettings(exec: Exec, settings: readonly Setting[]): Promise<void> {
	for (const { key, value, merge } of settings) {
		let next = value;
		if (merge) next = { ...((await readSetting(exec, key)) as Record<string, unknown> | undefined), ...(value as Record<string, unknown>) };
		await omp(exec, ["config", "set", key, typeof next === "string" ? next : JSON.stringify(next)]);
	}
}

/** Effective value of one setting, or undefined when unset. */
export async function readSetting(exec: Exec, key: string): Promise<unknown> {
	const parsed: unknown = JSON.parse(await omp(exec, ["config", "get", key, "--json"]));
	return parsed && typeof parsed === "object" && "value" in parsed ? (parsed.value ?? undefined) : undefined;
}

/** `settings` with every `modelRoles.judge` (active roles and saved presets) replaced by `judge`. */
function withJudge(settings: readonly Setting[], judge: string | undefined): Setting[] {
	if (!judge) return [...settings];
	return settings.map(s => {
		if (s.key === "modelRoles") return { ...s, value: { ...(s.value as object), judge } };
		if (s.key !== "modelPresets") return s;
		const presets = s.value as Record<string, { modelRoles: object }>;
		return { ...s, value: Object.fromEntries(Object.entries(presets).map(([n, p]) => [n, { ...p, modelRoles: { ...p.modelRoles, judge } }])) };
	});
}

/** `judge` overrides the presets' judge model; the Jev step passes it so rerunning this step keeps Jev. */
export async function setupModels(ui: WizardUi, exec: Exec, judge?: string): Promise<"done" | "skipped"> {
	const ok = await ui.confirm(
		"Subscription presets and model routing",
		"Save `claude` and `codex` subscription presets for /modelpreset switch, plus effort, agent overrides, " +
			"LSP diagnostics after every edit and repeating LSP/debugger reminders, on any subscription. " +
			"Then apply routing for the subscription whose models are available: Claude first (Opus for the main session " +
			"and planning, Sonnet for coding and review, Haiku 5.5 for exploration and mechanical work, Fable for deep consultation), " +
			"otherwise Codex (GPT-6.1 Sol and GPT-6 Luna). With neither, routing stays unchanged. " +
			"Existing roles and presets with the same names are replaced; others are kept.",
	);
	if (!ok) return "skipped";
	await applySettings(exec, withJudge(COMMON, judge));
	let active: keyof typeof ROUTING | undefined;
	for (const [name, provider] of [["claude", "anthropic"], ["codex", "openai-codex"]] as const) {
		const models = await available(exec, provider);
		if (ROUTING[name].models.every(m => models.has(m))) {
			active = name;
			break;
		}
	}
	if (active) await applySettings(exec, withJudge(ROUTING[active].settings, judge));
	ui.notify(
		active
			? `${active === "claude" ? "Claude" : "Codex"} routing applied; claude/codex presets saved. Restart open sessions, then use /modelpreset switch codex or claude.`
			: "Claude/codex presets and shared settings saved; routing unchanged. Log in before using a preset's models.",
		"info",
	);
	return "done";
}
