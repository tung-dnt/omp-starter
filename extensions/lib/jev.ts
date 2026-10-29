// Optional TypeSafe Jev step: stores the API key where omp and its child processes read it, and routes
// the `judge` role (TTSR `question` rules, native `judge()`, auto-thinking) to Jev.
import * as fs from "node:fs";
import * as path from "node:path";
import type { Exec, WizardUi } from "../setup";
import { MODEL_PRESETS, applySettings, readSetting } from "./routing";
import { HOME } from "./state";

export const JEV_MODEL = "typesafe/jev-1.14.0";
/** omp loads this file into its process environment, so bash/eval children (agent-skills `jev.sh`) see the key too. */
export const ENV_FILE = path.join(HOME, ".omp", "agent", ".env");
const KEY_VAR = "TYPESAFE_API_KEY";
/** The regex rule `rules/lsp-symbol-judged.md` replaces while Jev judges; both at once would remind twice. */
const REGEX_LSP_RULE = "lsp-symbol-search";
const API = "https://api.typesafe.ai/v1/systemone";

/** Resolves to undefined when TypeSafe accepts `key`, otherwise to the reason it did not. */
export type VerifyKey = (key: string) => Promise<string | undefined>;

export const verifyKey: VerifyKey = async key => {
	let res: Response;
	try {
		res = await fetch(API, {
			method: "POST",
			headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
			body: JSON.stringify({
				model: JEV_MODEL.split("/")[1],
				state: { text: "The sky is blue." },
				questions: { q: { type: "noul", instructions: "Does `text` describe a colour?" } },
			}),
			signal: AbortSignal.timeout(15_000),
		});
	} catch (error) {
		return error instanceof Error && error.name === "TimeoutError" ? "TypeSafe did not answer within 15 s" : "could not reach api.typesafe.ai";
	}
	if (res.status === 401 || res.status === 403) return "TypeSafe rejected the key";
	if (!res.ok) return `TypeSafe answered HTTP ${res.status}`;
	const body: unknown = await res.json().catch(() => undefined);
	const answers = body && typeof body === "object" && "answers" in body ? body.answers : undefined;
	const answer = answers && typeof answers === "object" && "q" in answers ? answers.q : undefined;
	return answer && typeof answer === "object" && "noul" in answer && typeof answer.noul === "number" ? undefined : "TypeSafe returned no answer";
};

/** Sets `KEY_VAR` in a dotenv file, replacing any earlier assignment and keeping every other line; the file ends mode 600. */
export function writeEnvKey(file: string, key: string): void {
	const lines = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n") : [];
	const kept = lines.filter(line => !new RegExp(`^\\s*(?:export\\s+)?${KEY_VAR}\\s*=`).test(line));
	while (kept.length > 0 && kept[kept.length - 1] === "") kept.pop();
	kept.push(`${KEY_VAR}=${key}`);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${kept.join("\n")}\n`, { mode: 0o600 });
	fs.chmodSync(file, 0o600);
}

async function routeJudge(exec: Exec, judge: (preset: keyof typeof MODEL_PRESETS) => string, disableRegexRule: boolean): Promise<void> {
	const presets = ((await readSetting(exec, "modelPresets")) ?? {}) as Record<string, { modelRoles?: Record<string, string> }>;
	for (const name of Object.keys(MODEL_PRESETS) as (keyof typeof MODEL_PRESETS)[]) {
		const preset = presets[name];
		if (preset) presets[name] = { ...preset, modelRoles: { ...preset.modelRoles, judge: judge(name) } };
	}
	const disabled = new Set(((await readSetting(exec, "ttsr.disabledRules")) ?? []) as string[]);
	if (disableRegexRule) disabled.add(REGEX_LSP_RULE);
	else disabled.delete(REGEX_LSP_RULE);
	await applySettings(exec, [
		{ key: "modelRoles", merge: true, value: { judge: disableRegexRule ? JEV_MODEL : "@tiny" } },
		{ key: "modelPresets", value: presets },
		{ key: "ttsr.disabledRules", value: [...disabled] },
	]);
}

export interface JevOptions {
	verify?: VerifyKey;
	envFile?: string;
	env?: Record<string, string | undefined>;
	/** Current answer from the state file; `done` offers to turn Jev off instead of setting it up again. */
	current?: "done" | "skipped";
}

/**
 * Optional: routes the `judge` role to TypeSafe Jev. Nothing is written until TypeSafe accepts the key.
 * Turning it off restores the presets' own judge models and the regex LSP rule; the stored key stays.
 */
export async function setupJev(ui: WizardUi, exec: Exec, options: JevOptions = {}): Promise<"done" | "skipped"> {
	const { verify = verifyKey, envFile = ENV_FILE, env = process.env, current } = options;
	if (current === "done") {
		const keep = "Keep Jev as the judge";
		const off = "Turn Jev off";
		if ((await ui.select("TypeSafe Jev is the judge model", [keep, off])) !== off) return "done";
		await routeJudge(exec, preset => MODEL_PRESETS[preset].modelRoles.judge, false);
		ui.notify(`Jev turned off: judge back to the presets' models, regex LSP reminder back on. ${KEY_VAR} stays in ${envFile}; delete it if unwanted.`, "info");
		return "skipped";
	}
	const ok = await ui.confirm(
		"TypeSafe Jev judge (optional)",
		"Route the `judge` role to TypeSafe Jev (jev-1.14.0): it answers `question` rules such as the LSP-over-grep reminder " +
			"(24/24 symbol searches caught vs 7/24 by regex) and picks the thinking level for each prompt. " +
			"Judged tool calls and your prompts are sent to TypeSafe (processed in the US); skip this if your data rules don't allow that. " +
			`Needs an API key from typesafe.ai, stored in ${envFile} (mode 600).`,
	);
	if (!ok) return "skipped";
	let key = env[KEY_VAR]?.trim();
	const entered = !key;
	if (!key) {
		key = (await ui.input(`${KEY_VAR} (shown while you type)`, "paste the key, or leave empty to skip"))?.trim();
		if (!key) return "skipped";
	}
	const problem = await verify(key);
	if (problem) {
		ui.notify(`Jev not set up: ${problem}. Nothing was changed.`, "error");
		return "skipped";
	}
	if (entered) {
		writeEnvKey(envFile, key);
		env[KEY_VAR] = key;
	}
	await routeJudge(exec, () => JEV_MODEL, true);
	await applySettings(exec, [
		{ key: "retry.fallbackChains", merge: true, value: { judge: ["@tiny"] } },
		{ key: "ttsr.judge", value: "auto" },
	]);
	ui.notify(
		`Jev is the judge (${JEV_MODEL}, falls back to @tiny). ${entered ? `Key saved to ${envFile}. ` : `Using ${KEY_VAR} from the environment. `}` +
			"Restart open sessions to load it.",
		"info",
	);
	return "done";
}
