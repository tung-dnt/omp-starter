#!/usr/bin/env bun
// Tier-3 harness CLI (plan D; `bun run tier3 <command>`). Commands:
//   run <id> [--runner scripted|haiku] [--repeat n] [--out dir] [--code dir]
//       one repeat of a scenario. Exit 0 PASS, 1 FAIL (a named assertion or a driver failure), 2 harness error.
//   assert <run dir>      re-run the assertions over a finished run dir
//   setup [--out dir] [--plan file]   build an isolated segment for manual inspection (copies credentials: delete its home)
//   selftest              embedded cases for the pure parts (no model, no HOME)
//   smoke                 not wired here: a driven session with one tiny prompt is a Haiku call (see driver.ts)
import * as fs from "node:fs";
import * as path from "node:path";
import { assertRun, readContext, type CheckResult } from "./assert.ts";
import { loadScenario, SCENARIO_DIR, type Scenario, type ScenarioRun } from "./scenario.ts";
import { buildSegment, copyCode, fingerprint, ompBinary, removeHome, specWorktreeRoots, STORY, TIER3, type SegmentEnv } from "./setup.ts";
import { runSelftest } from "./lib/selftest.ts";
import { slotCostOf } from "./lib/ledger.ts";

/** A driver that outlives its own 20-minute ceiling plus the stop and shutdown waits is hung: it is killed and the run fails. */
const DRIVER_TIMEOUT_MS = 25 * 60_000;

const argv = process.argv.slice(2);
const [command = "", ...rest] = argv;

function flag(name: string): string | undefined {
	const i = rest.indexOf(`--${name}`);
	return i >= 0 ? rest[i + 1] : undefined;
}

export class HarnessError extends Error {}

/** Last value wins, as in spec-cli. */
function budgetOf(args: string, dflt: number): number {
	const m = [...args.matchAll(/--budget\s+([\d.]+)/g)].at(-1);
	return m ? Number(m[1]) : dflt;
}

/**
 * The seam is live when the module exists in the code copy and the host entry point imports it. Without it a scripted
 * run would drive real model slots, so the run is refused before omp starts.
 */
export function seamPresent(code: string): boolean {
	const module = path.join(code, "extensions/lib/spec-scripted-slots.ts");
	const entry = path.join(code, "extensions/spec-workflow.ts");
	if (!fs.existsSync(module) || !fs.existsSync(entry)) return false;
	return /from\s+["'][^"']*spec-scripted-slots(\.ts)?["']/.test(fs.readFileSync(entry, "utf8"));
}

async function runOne(scenario: Scenario, run: ScenarioRun, index: number, outDir: string, code: string, seg: { current?: SegmentEnv; no: number }, runner: "haiku" | "scripted"): Promise<{ result: any; spend: number }> {
	if (run.fresh || seg.current === undefined) {
		if (seg.current) removeHome(seg.current);
		seg.no++;
		seg.current = await buildSegment(path.join(outDir, `seg-${seg.no}`), scenario.repos, run.plan, code, run.setup);
	}
	const env = seg.current;
	const runDir = path.join(outDir, `${String(index + 1).padStart(2, "0")}-${run.name}`);
	fs.mkdirSync(runDir, { recursive: true });
	let scripted: string | undefined;
	if (runner === "scripted") {
		const named = path.join(SCENARIO_DIR, `${scenario.id}.${run.name}.slots.yml`);
		const src = fs.existsSync(named) ? named : path.join(SCENARIO_DIR, `${scenario.id}.slots.yml`);
		if (!fs.existsSync(src)) throw new HarnessError(`scripted scenario ${scenario.id} has no ${src}`);
		scripted = path.join(outDir, `${scenario.id}.slots.yml`);
		fs.copyFileSync(src, scripted);
	}
	const tickets = Object.fromEntries(Object.entries(env.repos).map(([name, dir]) => [name, Bun.spawnSync(["git", "-C", dir, "rev-parse", STORY]).stdout.toString().trim()]));
	const vaultHead = Bun.spawnSync(["git", "-C", env.vault, "rev-parse", "HEAD"]).stdout.toString().trim();
	fs.writeFileSync(path.join(runDir, "before.json"), JSON.stringify({ real: fingerprint(), roots: specWorktreeRoots(), tickets, vaultHead }, null, 2));
	const defaultBudget = runner === "haiku" ? 0.25 : 0.5;
	const budget = budgetOf(`--budget ${defaultBudget} ${run.args}`, defaultBudget);
	const planFile = "Specs/T3/plan.md";
	const ctx = { runDir, story: STORY, runner, scripted, plan: planFile, planFile, work: env.work, vault: env.vault, code, repos: Object.values(env.repos), args: run.args, budget, expect: run.expect, id: scenario.id, run: run.name, declaredActions: run.actions.length, allowUnmatchedGates: run.allowUnmatchedGates, noLog: run.endOn !== undefined };
	fs.writeFileSync(path.join(runDir, "context.json"), JSON.stringify(ctx, null, 2));
	const spec = {
		runDir,
		home: env.home,
		work: env.work,
		vault: env.vault,
		code,
		plan: planFile,
		fixtures: path.join(TIER3, "fixtures"),
		repos: Object.values(env.repos),
		args: run.args,
		mode: "run",
		command: run.command,
		omp: ompBinary(),
		scripted,
		gates: run.gates,
		actions: run.actions,
		concurrency: 2,
		budget: defaultBudget,
		story: STORY,
		...(run.endOn === undefined ? {} : { endOn: run.endOn }),
	};
	const specFile = path.join(runDir, "driver.json");
	fs.writeFileSync(specFile, JSON.stringify(spec, null, 2));
	const driver = Bun.spawnSync(["bun", path.join(TIER3, run.tui ? "tui-driver.ts" : "driver.ts"), specFile], { cwd: path.resolve(TIER3, "../.."), stdout: "pipe", stderr: "pipe", timeout: DRIVER_TIMEOUT_MS });
	fs.writeFileSync(path.join(runDir, "driver.log"), driver.stdout.toString() + driver.stderr.toString());
	const results: CheckResult[] = [];
	if (driver.exitCode !== 0) results.push({ id: "driver-exit", pass: false, detail: `driver exited ${driver.exitCode}${driver.signalCode ? ` (${driver.signalCode})` : ""}` });
	results.push(...assertRun(readContext(runDir)));
	const logDir = path.join(runDir, "spec-runs");
	const spend = fs.existsSync(logDir) ? fs.readdirSync(logDir).flatMap(d => fs.readdirSync(path.join(logDir, d)).filter(f => f.endsWith(".jsonl")).map(f => slotCostOf(fs.readFileSync(path.join(logDir, d, f), "utf8")))).reduce((a, b) => a + b, 0) : 0;
	return { result: { name: run.name, runDir, driverExit: driver.exitCode, results }, spend };
}

export async function runRepeat(id: string, runner: "haiku" | "scripted", repeat: number, outDir: string, codeDir?: string): Promise<{ pass: boolean; spendUsd: number; runs: any[] }> {
	const scenario = loadScenario(id);
	if (scenario.runner !== runner) throw new HarnessError(`scenario ${id} is ${scenario.runner}, not ${runner}`);
	fs.mkdirSync(outDir, { recursive: true });
	const code = codeDir ?? copyCode(path.join(outDir, "code"));
	if (runner === "scripted" && !seamPresent(code)) {
		// nothing runs: a scripted run without the seam would be a real, paid run
		return { pass: false, spendUsd: 0, runs: [{ name: "seam", repeat, driverExit: null, results: [{ id: "seam-present", pass: false, detail: "SPEC_SLOT_SCRIPT is not in the code under test; no run was started" }] }] };
	}
	const seg: { current?: SegmentEnv; no: number } = { no: 0 };
	const runs: any[] = [];
	let spend = 0;
	try {
		for (const [i, run] of scenario.runs.entries()) {
			const out = await runOne(scenario, run, i, outDir, code, seg, runner);
			spend += out.spend;
			runs.push({ ...out.result, repeat });
		}
	} finally {
		if (seg.current) removeHome(seg.current);
	}
	const pass = runs.every(r => r.driverExit === 0 && r.results.every((x: CheckResult) => x.pass));
	return { pass, spendUsd: spend, runs };
}

async function main(): Promise<number> {
	if (command === "run") {
		const id = rest[0];
		if (!id) throw new HarnessError("usage: run <id> [--runner scripted|haiku] [--repeat n] [--out dir] [--code dir]");
		const scenario = loadScenario(id);
		const runner = (flag("runner") ?? scenario.runner) as "haiku" | "scripted";
		const repeat = Number(flag("repeat") ?? 1);
		const out = path.resolve(flag("out") ?? path.join(TIER3, "runs", "manual", `${id}-${runner}-r${repeat}-${Date.now()}`));
		const code = flag("code") ? path.resolve(flag("code") as string) : undefined;
		const res = await runRepeat(id, runner, repeat, out, code);
		fs.writeFileSync(path.join(out, "result.json"), JSON.stringify({ id, runner, repeat, pass: res.pass, spendUsd: res.spendUsd, runs: res.runs }, null, 2));
		for (const r of res.runs) for (const x of r.results) console.log(`${x.pass ? "PASS" : "FAIL"} ${x.id}: ${x.detail}`);
		console.log(`${res.pass ? "PASS" : "FAIL"} ${id} [${runner}] repeat ${repeat} spend=$${res.spendUsd.toFixed(4)} dir=${out}`);
		return res.pass ? 0 : 1;
	}
	if (command === "assert") {
		const dir = path.resolve(rest[0] ?? "");
		const results = assertRun(readContext(dir));
		for (const x of results) console.log(`${x.pass ? "PASS" : "FAIL"} ${x.id}: ${x.detail}`);
		return results.every(x => x.pass) ? 0 : 1;
	}
	if (command === "setup") {
		const out = path.resolve(flag("out") ?? path.join(TIER3, "runs", "manual", `setup-${Date.now()}`));
		const env = await buildSegment(out, ["fixture"], flag("plan") ?? "t3-sum.md", copyCode(path.join(out, "code")));
		console.log(`segment ${env.root}; remove its home when done: ${env.home}`);
		return 0;
	}
	if (command === "selftest") {
		const cases = runSelftest();
		for (const c of cases) console.log(`${c.pass ? "PASS" : "FAIL"} ${c.name}${c.pass ? "" : ` :: ${c.detail}`}`);
		const failed = cases.filter(c => !c.pass).length;
		console.log(`selftest: ${cases.length - failed}/${cases.length} passed`);
		return failed === 0 ? 0 : 2;
	}
	if (command === "smoke") {
		throw new HarnessError("smoke is not wired into the CLI; run driver.ts with mode smoke in a segment (costs one Haiku call)");
	}
	throw new HarnessError(`unknown command "${command}". Commands: run, assert, setup, selftest`);
}

if (import.meta.main) {
	try {
		process.exitCode = await main();
	} catch (error) {
		console.error(error instanceof HarnessError ? `harness error: ${error.message}` : error);
		process.exitCode = 2;
	}
}
