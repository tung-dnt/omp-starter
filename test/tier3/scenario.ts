// Loads and shape-checks scenarios/<id>.yml (plan D.5, LLD section D). Throws on a malformed file: unknown keys are errors, so a
// typo in an expectation can never turn into an assertion that matches nothing.
import * as fs from "node:fs";
import * as path from "node:path";
import { expectProblem } from "./assert.ts";

export type GateRule = {
	title: string;
	choose: string;
	note?: string;
	/** Waits this long before answering. */
	delayMs?: number;
	/** Does not answer until an action `release` with this name has run. */
	holdUntil?: string;
	/** The rule answers this many gates, then the next matching rule takes over. */
	times?: number;
};

/** What an action waits for. Actions run in order, each after the previous one. */
export type Trigger =
	| { start: true }
	| { event: string; task?: string; nth?: number; detail?: string }
	| { slot: Record<string, string | number>; nth?: number }
	| { session: { task: string; slot?: string; attempt?: number }; nth?: number }
	| { gate: string; nth?: number }
	| { request: string; nth?: number }
	| { marker: string; min?: number };

export type ActionKind =
	| "run-stop"
	| "sigkill"
	| "prompt"
	| "plan-commit"
	| "plan-edit"
	| "hold-on"
	| "hold-off"
	| "ticket-commit"
	| "task-branch-commit"
	| "index-lock-on"
	| "index-lock-off"
	| "release"
	| "second-run";

export type Action = { on: Trigger; do: ActionKind; delayMs?: number; plan?: string; text?: string; file?: string; content?: string; message?: string; tag?: string; task?: string; name?: string };
export type Expect = string | Record<string, any>;
export type RunSetup = "hook-installed" | "vault-dirty" | "clone-dirty" | "no-branch" | "lock-live" | "lock-foreign" | "lock-dead";

export interface ScenarioRun {
	name: string;
	/** Rebuild the isolated HOME, fixture and vault before this run (default: continue the previous run's state). */
	fresh: boolean;
	/** Plan file under fixtures/ (default: t3-sum.md). */
	plan: string;
	/** The command that starts the run. */
	command: "run-story" | "run-task";
	/** Extra /run-story arguments, e.g. "--slot-timeout 5". */
	args: string;
	gates: GateRule[];
	actions: Action[];
	expect: Expect[];
	/** Changes to the fresh segment before the run starts. */
	setup: RunSetup[];
	/** Gates no rule answers are cancelled; they fail the run unless this is true. */
	allowUnmatchedGates: boolean;
	/** Drive an interactive TUI in a pty (tui-driver.ts) instead of an RPC session. */
	tui: boolean;
	/** The run fails before it reaches the scheduler (no run log, no outcome notify): this notify text ends the wait. */
	endOn?: string;
}

export interface Scenario {
	id: string;
	runner: "haiku" | "scripted";
	proves: string[];
	description: string;
	repos: string[];
	runs: ScenarioRun[];
}

export const SCENARIO_DIR = process.env.T3_SCENARIOS ?? path.join(import.meta.dir, "scenarios");

export function scenarioFiles(dir = SCENARIO_DIR): string[] {
	return fs
		.readdirSync(dir)
		.filter(f => f.endsWith(".yml") && !f.endsWith(".slots.yml"))
		.map(f => f.replace(/\.yml$/, ""))
		.sort();
}

const SCENARIO_KEYS = ["id", "runner", "verified", "proves", "description", "repos", "runs"];
const RUN_KEYS = ["name", "fresh", "plan", "command", "args", "gates", "actions", "expect", "setup", "allowUnmatchedGates", "tui", "endOn"];
const GATE_KEYS = ["title", "choose", "note", "delayMs", "holdUntil", "times"];
const ACTION_KEYS = ["on", "do", "delayMs", "plan", "text", "file", "content", "message", "tag", "task", "name"];
const ACTIONS: readonly string[] = ["run-stop", "sigkill", "prompt", "plan-commit", "plan-edit", "hold-on", "hold-off", "ticket-commit", "task-branch-commit", "index-lock-on", "index-lock-off", "release", "second-run"];
const SETUPS: readonly string[] = ["hook-installed", "vault-dirty", "clone-dirty", "no-branch", "lock-live", "lock-foreign", "lock-dead"];
const TRIGGERS = ["start", "event", "slot", "session", "gate", "request", "marker"];

const unknownKeys = (obj: Record<string, unknown>, allowed: readonly string[], where: string): void => {
	const bad = Object.keys(obj).filter(k => !allowed.includes(k));
	if (bad.length) throw new Error(`${where}: unknown key ${bad.join(", ")}`);
};

function checkTrigger(t: any, where: string): void {
	if (typeof t !== "object" || t === null) throw new Error(`${where}: on must be a mapping`);
	const kind = TRIGGERS.filter(k => k in t);
	if (kind.length !== 1) throw new Error(`${where}: on needs exactly one of ${TRIGGERS.join(", ")}`);
	unknownKeys(t, [kind[0] as string, "task", "nth", "detail", "min"], `${where}.on`);
}

export function loadScenario(id: string, dir = SCENARIO_DIR): Scenario {
	const file = path.join(dir, `${id}.yml`);
	if (!fs.existsSync(file)) throw new Error(`no scenario file ${file}`);
	const raw: any = Bun.YAML.parse(fs.readFileSync(file, "utf8"));
	if (raw?.id !== id) throw new Error(`${file}: id must be ${id}`);
	unknownKeys(raw, SCENARIO_KEYS, file);
	if (raw.runner !== "haiku" && raw.runner !== "scripted") throw new Error(`${file}: runner must be haiku or scripted`);
	if (!Array.isArray(raw.runs) || raw.runs.length === 0) throw new Error(`${file}: runs[] must not be empty`);
	const runs: ScenarioRun[] = raw.runs.map((r: any, i: number) => {
		const where = `${file}: run ${i}`;
		unknownKeys(r, RUN_KEYS, where);
		if (!Array.isArray(r.expect) || r.expect.length === 0) throw new Error(`${where} has no expect[]`);
		for (const e of r.expect) {
			const problem = expectProblem(e);
			if (problem) throw new Error(`${where}: ${problem}`);
		}
		for (const g of r.gates ?? []) unknownKeys(g, GATE_KEYS, `${where} gate`);
		for (const a of r.actions ?? []) {
			unknownKeys(a, ACTION_KEYS, `${where} action`);
			if (!ACTIONS.includes(a.do)) throw new Error(`${where}: unknown action ${a.do}`);
			checkTrigger(a.on, `${where} action ${a.do}`);
		}
		for (const s of r.setup ?? []) if (!SETUPS.includes(s)) throw new Error(`${where}: unknown setup ${s}`);
		return {
			name: String(r.name ?? `run${i + 1}`),
			fresh: r.fresh === true || i === 0,
			plan: String(r.plan ?? "t3-sum.md"),
			command: r.command === "run-task" ? "run-task" : "run-story",
			args: String(r.args ?? ""),
			gates: Array.isArray(r.gates) ? r.gates : [],
			actions: Array.isArray(r.actions) ? r.actions : [],
			expect: r.expect,
			setup: Array.isArray(r.setup) ? r.setup : [],
			allowUnmatchedGates: r.allowUnmatchedGates === true,
			tui: r.tui === true,
			...(typeof r.endOn === "string" ? { endOn: r.endOn } : {}),
		};
	});
	return {
		id,
		runner: raw.runner,
		proves: Array.isArray(raw.proves) ? raw.proves : [],
		description: String(raw.description ?? ""),
		repos: Array.isArray(raw.repos) ? raw.repos : ["fixture"],
		runs,
	};
}
