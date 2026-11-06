// Drives one interactive `omp` TUI session in a pty for a scenario run with `tui: true` (R-90: typed interactive input during a run).
// Usage: bun test/tier3/tui-driver.ts <spec.json> (the same spec file driver.ts reads). No model answers: the slots are scripted.
// Writes <runDir>/{tui.raw,tui.log,summary.json,spec-runs/,sessions/}.
//
// Input rules: text is typed, then Enter submits it. Nothing is ever sent blank, and no dialog is answered with a bare Enter: the
// scenario's setup installs the hook and keeps the ticket branch, so no gate opens.
import * as fs from "node:fs";
import * as path from "node:path";
import type { DriverSpec } from "./driver.ts";
import { HAIKU } from "./setup.ts";

const spec = JSON.parse(fs.readFileSync(process.argv[2] ?? "", "utf8")) as DriverSpec;
fs.mkdirSync(spec.runDir, { recursive: true });
const t0 = Date.now();
const say = (s: string) => fs.appendFileSync(path.join(spec.runDir, "tui.log"), `[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}\n`);

const env: Record<string, string> = { ...(process.env as Record<string, string>), HOME: spec.home, T3_CODE: spec.code, TERM: "xterm-256color" };
for (const k of Object.keys(env)) if (/^(TYPESAFE|PI_|CLAUDE|OMPCODE|ANTHROPIC|SPEC_SLOT_SCRIPT)/.test(k) && k !== "T3_CODE") delete env[k];
if (spec.scripted !== undefined) env.SPEC_SLOT_SCRIPT = spec.scripted;

const LOGS = path.join(spec.home, ".omp/agent/spec-runs");
const listLogs = (): string[] => (fs.existsSync(LOGS) ? fs.readdirSync(LOGS).flatMap(d => (fs.statSync(path.join(LOGS, d)).isDirectory() ? fs.readdirSync(path.join(LOGS, d)).filter(f => f.endsWith(".jsonl")).map(f => path.join(d, f)) : [])) : []);
const logsBefore = new Set(listLogs());

let raw = "";
const decoder = new TextDecoder();
const proc = Bun.spawn([spec.omp, "--model", HAIKU, "--session-dir", path.join(spec.runDir, "sessions"), "--no-extensions", "-e", path.join(spec.code, "extensions/spec-workflow.ts")], {
	cwd: spec.work,
	env,
	terminal: {
		cols: 160,
		rows: 50,
		data(_t: unknown, d: Uint8Array) {
			raw += decoder.decode(d, { stream: true });
		},
	},
} as Parameters<typeof Bun.spawn>[1]);
const term = (proc as unknown as { terminal: { write(s: string): void } }).terminal;
let exited = false;
void proc.exited.then(() => {
	exited = true;
});

/** The screen text with escapes and all whitespace removed, so wrapped lines and cursor moves do not split a phrase. */
const flat = (from = 0): string =>
	raw
		.slice(from)
		.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "")
		.replace(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]/g, "")
		.replace(/\x1b[()][0-9A-B]/g, "")
		.replace(/[\x00-\x1f\x7f]/g, "")
		.replace(/\s+/g, "");

async function waitText(needle: string, from: number, timeoutMs: number): Promise<boolean> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (flat(from).includes(needle)) return true;
		if (exited) return false;
		await Bun.sleep(150);
	}
	return false;
}

/** Types the text, lets the editor settle, then submits it with Enter. */
async function submit(text: string): Promise<void> {
	say(`type: ${text}`);
	term.write(text);
	await Bun.sleep(600);
	term.write("\r");
}

const summary: Record<string, any> = { mode: "tui", runDir: spec.runDir, sigkilled: false, stoppedByDriver: false, unmatchedGates: [], gates: [], gateTimeline: [], notifies: [], actionsFired: [], injected: {}, tui: {} };

async function main(): Promise<void> {
	// startup: the editor is up when the output has gone quiet
	let last = -1;
	let quiet = 0;
	const startupBegan = Date.now();
	while (Date.now() - startupBegan < 60_000 && quiet < 12) {
		await Bun.sleep(250);
		if (raw.length === last && raw.length > 200) quiet++;
		else quiet = 0;
		last = raw.length;
	}
	say(`startup quiet after ${((Date.now() - startupBegan) / 1000).toFixed(1)}s, ${raw.length} bytes`);

	const repoArgs = spec.repos.map(r => `--repo ${r}`).join(" ");
	const runCommand = `/${spec.command ?? "run-story"} ${spec.plan} ${repoArgs} --vault-git-dir ${spec.vault}/.git --base main --concurrency ${spec.concurrency} --budget ${spec.budget} ${spec.args}`.trim();
	let mark = raw.length;
	await submit(runCommand);
	summary.tui.runStarted = await waitText("SCRIPTEDSLOTS:nomodelanswers", mark, 60_000);
	say(`run started: ${summary.tui.runStarted}`);

	// 1. typed interactive input is intercepted with a notice, and starts no turn
	const typed = "please refactor everything";
	mark = raw.length;
	const typedAt = mark;
	await submit(typed);
	summary.tui.noticeShown = await waitText("specrunactive:/run-stoptostop", mark, 20_000);
	say(`notice shown: ${summary.tui.noticeShown}`);

	// 2. run controls pass: /spec-status answers while the run is active
	mark = raw.length;
	await submit("/spec-status");
	summary.tui.statusShown = await waitText("story:in-progress", mark, 20_000);
	say(`status shown: ${summary.tui.statusShown}`);

	// 3. a second run typed while one is active is refused: the input handler answers it with the same notice (a second run from a
	// non-interactive source reaches the command and gets "A spec run is already active", which S-run-lock covers)
	mark = raw.length;
	await submit(runCommand);
	summary.tui.secondRefused = await waitText("specrunactive:/run-stoptostop", mark, 20_000);
	say(`second run refused: ${summary.tui.secondRefused}`);

	// the first run finishes on its own
	mark = raw.length;
	summary.tui.reportShown = await waitText("outcome:complete,$", mark, 120_000);
	summary.runEnded = summary.tui.reportShown === true;
	say(`report shown: ${summary.tui.reportShown}`);

	// No main-agent turn started while the run was going. The TUI shows "Working…" while a turn runs (seen by hand: a prompt typed with
	// no run active echoes as a message and shows "Working…" at once). No control prompt is sent here: it would be a model call.
	summary.tui.workingDuringRun = flat(typedAt).includes("Working…");

	// leave the way a user does: the exit command, typed and submitted
	await submit("/exit");
	const exit = await Promise.race([proc.exited, Bun.sleep(20_000).then(() => "timeout" as const)]);
	if (exit === "timeout") {
		proc.kill();
		summary.exit = "killed";
	} else summary.exit = exit;
}

try {
	await main();
} catch (error) {
	summary.error = String(error);
	say(`ERROR: ${error}`);
	process.exitCode = 1;
} finally {
	if (!exited) proc.kill();
	fs.writeFileSync(path.join(spec.runDir, "tui.raw"), raw);
	for (const rel of listLogs().filter(f => !logsBefore.has(f))) {
		fs.mkdirSync(path.dirname(path.join(spec.runDir, "spec-runs", rel)), { recursive: true });
		fs.copyFileSync(path.join(LOGS, rel), path.join(spec.runDir, "spec-runs", rel));
	}
	fs.writeFileSync(path.join(spec.runDir, "summary.json"), JSON.stringify(summary, null, 2));
}
