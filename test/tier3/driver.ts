// Drives one `omp --mode rpc` session for a scenario run (plan D.5, LLD section D driver.ts).
// Usage: bun test/tier3/driver.ts <spec.json>. Writes <runDir>/{events.jsonl,summary.json,stderr.log,spec-runs/,sessions/}.
// Gates: the run's own rules first, then the setup rules; an unmatched gate is cancelled (the gate's stop) and counted.
// Actions are sequential and fire on events of the run log, UI requests or marker files, never on wall-clock timers: an action
// whose trigger never comes is recorded as not fired, and assert.ts fails the run for it. The driver never judges the outcome.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Action, GateRule, Trigger } from "./scenario.ts";
import { HAIKU } from "./setup.ts";

export interface DriverSpec {
	runDir: string;
	home: string;
	work: string;
	vault: string;
	code: string;
	/** plan path inside the vault work tree, e.g. Specs/T3/plan.md */
	plan: string;
	/** fixtures/ directory, for plan-commit and plan-edit actions */
	fixtures: string;
	/** absolute clone paths for --repo */
	repos: string[];
	args: string;
	mode: "run" | "smoke";
	command?: string;
	/** the omp binary to drive (absolute path) */
	omp: string;
	/** absolute path of the slot script; sets SPEC_SLOT_SCRIPT for a scripted run only */
	scripted?: string;
	gates: GateRule[];
	actions: Action[];
	concurrency: number;
	budget: number;
	/** the ticket branch name */
	story: string;
	/** A notify matching this also ends the run (a run that fails before the scheduler logs no outcome). */
	endOn?: string;
}

const spec = JSON.parse(fs.readFileSync(process.argv[2] ?? "", "utf8")) as DriverSpec;
fs.mkdirSync(spec.runDir, { recursive: true });
const log = (kind: string, data: unknown) => fs.appendFileSync(path.join(spec.runDir, "events.jsonl"), `${JSON.stringify({ at: Date.now(), kind, data })}\n`);
const t0 = Date.now();
const say = (s: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${s}`);
const sh = (cwd: string, cmd: string[]) => Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
const git = (repo: string, ...a: string[]) => sh(repo, ["git", "-C", repo, "-c", "user.name=t3", "-c", "user.email=t3@example.com", ...a]);

// setup gates (the clone's hook and the ticket branch); scenario rules come first
const SETUP_GATES: GateRule[] = [
	{ title: "the pre-push hook is not installed", choose: "^Install the pre-push hook$" },
	{ title: "branch .* does not exist", choose: "^Create " },
];
const rules = [...spec.gates, ...SETUP_GATES];
const used = new Map<GateRule, number>();
/** The first rule that matches the title and still has answers left. */
function ruleFor(title: string): GateRule | undefined {
	const rule = rules.find(g => new RegExp(g.title).test(title) && (g.times === undefined || (used.get(g) ?? 0) < g.times));
	if (rule) used.set(rule, (used.get(rule) ?? 0) + 1);
	return rule;
}

const env: Record<string, string> = { ...(process.env as Record<string, string>), HOME: spec.home, T3_CODE: spec.code };
for (const k of Object.keys(env)) if (/^(TYPESAFE|PI_|CLAUDE|OMPCODE|ANTHROPIC|SPEC_SLOT_SCRIPT)/.test(k) && k !== "T3_CODE") delete env[k];
delete env.PI_CODING_AGENT_DIR;
if (spec.scripted !== undefined) env.SPEC_SLOT_SCRIPT = spec.scripted;

const ompArgs = (name: string): string[] => [spec.omp, "--mode", "rpc", "--model", HAIKU, "--session-dir", path.join(spec.runDir, name), "--no-extensions", "-e", path.join(spec.code, "extensions/spec-workflow.ts"), "-e", path.join(import.meta.dir, "probe-agents.ts")];
const omp = Bun.spawn(ompArgs("sessions"), { cwd: spec.work, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
let exited = false;
void omp.exited.then(() => {
	exited = true;
});

const LOGS = path.join(spec.home, ".omp/agent/spec-runs");
const listLogs = (): string[] => (fs.existsSync(LOGS) ? fs.readdirSync(LOGS).flatMap(d => (fs.existsSync(path.join(LOGS, d)) && fs.statSync(path.join(LOGS, d)).isDirectory() ? fs.readdirSync(path.join(LOGS, d)).filter(f => f.endsWith(".jsonl")).map(f => path.join(d, f)) : [])) : []);
/** Logs that existed before this run started: an earlier run of the same segment wrote them. */
const logsBefore = new Set(listLogs());

const summary: Record<string, any> = { mode: spec.mode, runDir: spec.runDir, sigkilled: false, stoppedByDriver: false, actionsDeclared: spec.actions.length, actionsFired: [] as string[], injected: {} };
const frames: any[] = [];
const gates: { title: string; options: string[]; answered: string }[] = [];
const gateTimeline: { id: string; title: string; reqAt: number; respAt?: number }[] = [];
const unmatched: { title: string; options: string[] }[] = [];
const notifies: string[] = [];
let runEnded = false;
let settledAfterEnd = false;
let promptResultRun: any;
const released = new Set<string>();

const send = (frame: Record<string, unknown>) => {
	omp.stdin.write(`${JSON.stringify(frame)}\n`);
	omp.stdin.flush();
	log("out", frame);
};

function answer(f: any, response: Record<string, unknown>): void {
	const entry = gateTimeline.find(g => g.id === f.id);
	if (entry) entry.respAt = Date.now();
	send({ type: "extension_ui_response", id: f.id, ...response });
}

function onFrame(f: any): void {
	frames.push(f);
	log("in", f);
	if (f.type === "extension_ui_request") {
		if (f.method === "select") {
			gateTimeline.push({ id: f.id, title: f.title, reqAt: Date.now() });
			const rule = ruleFor(f.title ?? "");
			const label = rule ? (f.options as string[]).find(o => new RegExp(rule.choose).test(o)) : undefined;
			gates.push({ title: f.title, options: f.options, answered: label ?? "(cancelled)" });
			say(`gate: ${f.title} -> ${label ?? "(cancelled = stop)"}`);
			if (label === undefined) {
				unmatched.push({ title: f.title, options: f.options });
				answer(f, { cancelled: true });
			} else {
				const reply = () => answer(f, { value: label });
				void (async () => {
					if (rule?.delayMs) await Bun.sleep(rule.delayMs);
					while (rule?.holdUntil && !released.has(rule.holdUntil) && !released.has("*") && !exited) await Bun.sleep(50);
					reply();
				})();
			}
		} else if (f.method === "input") {
			const rule = rules.find(g => g.note !== undefined && new RegExp(g.title).test(f.title ?? ""));
			if (rule?.note !== undefined) send({ type: "extension_ui_response", id: f.id, value: rule.note });
			else {
				unmatched.push({ title: `input: ${f.title}`, options: [] });
				send({ type: "extension_ui_response", id: f.id, cancelled: true });
			}
		} else if (f.method === "confirm" || f.method === "editor") {
			unmatched.push({ title: `${f.method}: ${f.title}`, options: [] });
			send({ type: "extension_ui_response", id: f.id, cancelled: true });
		} else if (f.method === "notify") {
			notifies.push(String(f.message));
			say(`notify(${f.notifyType ?? "info"}): ${String(f.message).split("\n")[0].slice(0, 160)}`);
			if (/outcome: (\w+), \$([\d.]+) in (\d+) slot runs/.test(String(f.message)) || (spec.endOn !== undefined && new RegExp(spec.endOn).test(String(f.message)))) runEnded = true;
		} else if (f.method === "setStatus" && f.statusText) say(`status: ${String(f.statusText).slice(0, 160)}`);
	}
	if (f.type === "prompt_result" && f.id === "run-1") promptResultRun = f;
	if (f.type === "session_settled" && runEnded) settledAfterEnd = true;
}

async function pump(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void): Promise<void> {
	const dec = new TextDecoder();
	let buf = "";
	for await (const chunk of stream) {
		buf += dec.decode(chunk, { stream: true });
		for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
			const line = buf.slice(0, i);
			buf = buf.slice(i + 1);
			if (line.trim()) onLine(line);
		}
	}
}
const stdoutDone = pump(omp.stdout, line => {
	try {
		onFrame(JSON.parse(line));
	} catch {
		log("raw", line);
	}
});
void pump(omp.stderr, line => fs.appendFileSync(path.join(spec.runDir, "stderr.log"), `${line}\n`));

async function waitFor<T>(label: string, probe: () => T | undefined | false, timeoutMs: number): Promise<T> {
	const start = Date.now();
	for (;;) {
		const hit = probe();
		if (hit) return hit as T;
		if (exited) throw new Error(`omp exited while waiting for ${label}`);
		if (Date.now() - start > timeoutMs) throw new Error(`timeout (${timeoutMs}ms) waiting for ${label}`);
		await Bun.sleep(100);
	}
}
const response = (id: string) => frames.find(f => f.type === "response" && f.id === id);

// ── The run log of this run (files that did not exist when it started) ───────────────────────────────────────────────────────

function runEntries(): any[] {
	const out: any[] = [];
	for (const rel of listLogs().filter(f => !logsBefore.has(f)).sort()) {
		for (const line of fs.readFileSync(path.join(LOGS, rel), "utf8").split("\n")) {
			if (!line.trim()) continue;
			try {
				out.push(JSON.parse(line));
			} catch {
				// a line being written
			}
		}
	}
	return out;
}

const isSlot = (e: any, m: Record<string, any>): boolean => e.kind === "slot" && Object.entries(m).every(([k, v]) => (k === "nth" ? true : e[k] === v));
function triggered(t: Trigger): boolean {
	if ("start" in t) return true;
	if ("marker" in t) {
		const file = path.join(spec.home, `t3-${t.marker}.log`);
		return fs.existsSync(file) && fs.readFileSync(file, "utf8").split("\n").filter(Boolean).length >= (t.min ?? 1);
	}
	if ("request" in t) return gateTimeline.filter(g => new RegExp(t.request).test(g.title)).length >= (t.nth ?? 1);
	const entries = runEntries();
	const nth = t.nth ?? 1;
	if ("event" in t) return entries.filter(e => e.kind === "event" && e.event === t.event && (t.task === undefined || e.task === t.task) && (t.detail === undefined || new RegExp(t.detail).test(String(e.detail ?? "")))).length >= nth;
	if ("slot" in t) return entries.filter(e => isSlot(e, t.slot)).length >= nth;
	if ("session" in t) return entries.filter(e => e.kind === "event" && e.event === "scripted-session" && e.task === t.session.task && matchSession(e, t.session)).length >= nth;
	if ("gate" in t) return entries.filter(e => e.kind === "gate" && e.cause === t.gate).length >= nth;
	return false;
}
function matchSession(e: any, s: { slot?: string; attempt?: number }): boolean {
	try {
		const d = JSON.parse(String(e.detail));
		return (s.slot === undefined || d.slot === s.slot) && (s.attempt === undefined || d.attempt === s.attempt);
	} catch {
		return false;
	}
}

// ── Actions ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const clone = spec.repos[0] as string;

/** The worktree directory of a task: `git worktree list` names it by its branch. */
function worktreeOf(task: string): string | undefined {
	const list = git(clone, "worktree", "list", "--porcelain").stdout.toString().split("\n\n");
	for (const block of list) if (block.includes(`branch refs/heads/spec-wt/${spec.story}/${task}`)) return /^worktree (.+)$/m.exec(block)?.[1];
	return undefined;
}
/** `git` that retries while another git process (the scheduler's own) holds a lock in the same repository. */
function gitRetry(repo: string, ...a: string[]): ReturnType<typeof sh> {
	let r = git(repo, ...a);
	for (let i = 0; i < 40 && r.exitCode !== 0 && /index\.lock|\.lock'?: File exists|cannot lock ref/.test(r.stderr.toString()); i++) {
		Bun.sleepSync(100);
		r = git(repo, ...a);
	}
	return r;
}
const gitDirOf = (dir: string): string => path.resolve(dir, sh(dir, ["git", "-C", dir, "rev-parse", "--git-dir"]).stdout.toString().trim());

function applyPlan(a: Action): void {
	const dest = path.join(spec.vault, spec.plan);
	fs.copyFileSync(path.join(spec.fixtures, a.plan ?? "t3-sum.md"), dest);
	if (a.do === "plan-commit") {
		git(spec.vault, "add", "-A");
		const r = git(spec.vault, "commit", "-qm", "plan revision midrun");
		if (r.exitCode !== 0) throw new Error(`plan-commit committed nothing: ${r.stderr.toString() || r.stdout.toString()}`);
		summary.injected.planRev = git(spec.vault, "rev-parse", "HEAD").stdout.toString().trim();
	}
}

/** Commits on the ticket branch from outside the scheduler, through a throwaway worktree. */
function ticketCommit(a: Action, tag: string): void {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t3-ticket-"));
	try {
		const add = git(clone, "worktree", "add", "--quiet", "--detach", tmp, spec.story);
		if (add.exitCode !== 0) throw new Error(`worktree add failed: ${add.stderr.toString()}`);
		if (a.file !== undefined) {
			fs.mkdirSync(path.dirname(path.join(tmp, a.file)), { recursive: true });
			fs.writeFileSync(path.join(tmp, a.file), a.content ?? "");
			git(tmp, "add", "-A");
		}
		const commit = gitRetry(tmp, "commit", "--allow-empty", "-qm", a.message ?? `human commit ${tag}`);
		if (commit.exitCode !== 0) throw new Error(`commit failed: ${commit.stderr.toString()}`);
		const sha = git(tmp, "rev-parse", "HEAD").stdout.toString().trim();
		const move = gitRetry(clone, "update-ref", `refs/heads/${spec.story}`, sha);
		if (move.exitCode !== 0) throw new Error(`update-ref failed: ${move.stderr.toString()}`);
		summary.injected[tag] = sha;
		summary.injected.ticket = sha;
	} finally {
		git(clone, "worktree", "remove", "--force", tmp);
	}
}

async function secondRun(): Promise<void> {
	// The second run is refused before any slot: it runs without the seam, so it logs no scripted entries of its own.
	const { SPEC_SLOT_SCRIPT: _seam, ...secondEnv } = env;
	const second = Bun.spawn(ompArgs("sessions-second"), { cwd: spec.work, env: secondEnv, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
	const seen: string[] = [];
	let done = false;
	const out = pump(second.stdout, line => {
		try {
			const f = JSON.parse(line);
			if (f.type === "extension_ui_request") {
				if (f.method === "notify") {
					seen.push(String(f.message));
					if (/outcome: (\w+), \$([\d.]+) in (\d+) slot runs/.test(String(f.message))) done = true;
				} else if (["select", "input", "confirm", "editor"].includes(f.method)) {
					second.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: f.id, cancelled: true })}\n`);
					second.stdin.flush();
				}
			}
		} catch {
			// not a frame
		}
	});
	const repoArgs = spec.repos.map(r => `--repo ${r}`).join(" ");
	second.stdin.write(`${JSON.stringify({ id: "run-2", type: "prompt", message: `/${spec.command ?? "run-story"} ${spec.plan} ${repoArgs} --vault-git-dir ${spec.vault}/.git --base main --concurrency ${spec.concurrency} --budget ${spec.budget} ${spec.args}` })}\n`);
	second.stdin.flush();
	const start = Date.now();
	while (!done && Date.now() - start < 120_000 && second.exitCode === null) await Bun.sleep(100);
	const worktrees = git(clone, "worktree", "list", "--porcelain").stdout.toString();
	second.kill();
	await Promise.race([out, Bun.sleep(2000)]);
	fs.writeFileSync(path.join(spec.runDir, "second-run.json"), JSON.stringify({ notifies: seen, finished: done, worktreesAfter: worktrees }, null, 2));
}

async function perform(a: Action): Promise<void> {
	log("action", { do: a.do, on: a.on });
	switch (a.do) {
		case "run-stop":
			send({ id: "stop-action", type: "prompt", message: "/run-stop" });
			break;
		case "sigkill":
			summary.sigkilled = true;
			omp.kill("SIGKILL");
			break;
		case "prompt":
			send({ id: "typed", type: "prompt", message: a.text ?? "hello" });
			break;
		case "plan-commit":
		case "plan-edit":
			applyPlan(a);
			break;
		case "hold-on":
			fs.writeFileSync(path.join(spec.home, `t3-hold-${a.name ?? "1"}`), "hold\n");
			break;
		case "hold-off":
			fs.rmSync(path.join(spec.home, `t3-hold-${a.name ?? "1"}`), { force: true });
			break;
		case "ticket-commit":
			ticketCommit(a, a.tag ?? "a");
			break;
		case "task-branch-commit": {
			const dir = worktreeOf(a.task ?? "");
			if (dir === undefined) throw new Error(`no worktree for ${a.task}`);
			const r = gitRetry(dir, "commit", "--allow-empty", "-qm", a.message ?? "rogue commit without trailers");
			if (r.exitCode !== 0) throw new Error(`commit in ${dir} failed: ${r.stderr.toString()}`);
			summary.injected.taskBranch = git(dir, "rev-parse", "HEAD").stdout.toString().trim();
			break;
		}
		case "index-lock-on": {
			const dir = worktreeOf(a.task ?? "");
			if (dir === undefined) throw new Error(`no worktree for ${a.task}`);
			const lock = path.join(gitDirOf(dir), "index.lock");
			fs.writeFileSync(lock, "");
			summary.injected.indexLock = lock;
			break;
		}
		case "index-lock-off":
			if (typeof summary.injected.indexLock === "string") fs.rmSync(summary.injected.indexLock, { force: true });
			break;
		case "release":
			released.add(a.name ?? "");
			break;
		case "second-run":
			await secondRun();
			break;
		default:
			throw new Error(`unknown action ${a.do}`);
	}
	(summary.actionsFired as string[]).push(a.do);
}

let actionsDone = false;
async function runActions(): Promise<void> {
	for (const a of spec.actions) {
		while (!triggered(a.on)) {
			if (exited || runEnded) return;
			await Bun.sleep(40);
		}
		if (a.delayMs) await Bun.sleep(a.delayMs);
		try {
			await perform(a);
		} catch (error) {
			summary.actionError = String(error);
			say(`action ${a.do} failed: ${error}`);
			// Nothing may stay held: a check waiting for a hold file that will never go away would stall the run until its timeout.
			for (const f of fs.readdirSync(spec.home)) if (f.startsWith("t3-hold-")) fs.rmSync(path.join(spec.home, f), { force: true });
			released.add("*");
			return;
		}
	}
	actionsDone = true;
}

async function finish(): Promise<void> {
	omp.stdin.end();
	const exit = await Promise.race([omp.exited, Bun.sleep(30_000).then(() => "timeout")]);
	if (exit === "timeout") omp.kill();
	await stdoutDone.catch(() => undefined);
	summary.exit = exit === "timeout" ? "killed" : exit;
	summary.unmatchedGates = unmatched;
	summary.gates = gates;
	summary.gateTimeline = gateTimeline;
	summary.notifies = notifies;
	summary.runEnded = runEnded;
	summary.actionsDone = actionsDone;
	summary.promptResultRun = promptResultRun ?? null;
	// only the logs this run wrote travel with the run dir (no credentials); the HOME is removed by the caller
	for (const rel of listLogs().filter(f => !logsBefore.has(f))) {
		fs.mkdirSync(path.dirname(path.join(spec.runDir, "spec-runs", rel)), { recursive: true });
		fs.copyFileSync(path.join(LOGS, rel), path.join(spec.runDir, "spec-runs", rel));
	}
	// Slot sessions are the only record of what a real slot did; the HOME that holds them is removed with the segment.
	const slotSessions = path.join(spec.home, ".omp/agent/sessions");
	if (spec.scripted === undefined && fs.existsSync(slotSessions)) fs.cpSync(slotSessions, path.join(spec.runDir, "slot-sessions"), { recursive: true });
	fs.writeFileSync(path.join(spec.runDir, "summary.json"), JSON.stringify(summary, null, 2));
	say(`done; ${spec.runDir}`);
}

try {
	await waitFor("ready frame", () => frames.some(f => f.type === "ready"), 90_000);
	send({ id: "cmds", type: "get_available_commands" });
	const cmds = await waitFor("get_available_commands response", () => response("cmds"), 30_000);
	const names: string[] = [];
	const walk = (x: any): void => {
		if (Array.isArray(x)) x.forEach(walk);
		else if (x && typeof x === "object") {
			if (typeof x.name === "string") names.push(x.name);
			Object.values(x).forEach(walk);
		}
	};
	walk(cmds.data);
	const runStory = names.filter(n => /^\/?run-story$/.test(n));
	summary.runStoryCount = runStory.length;
	if (runStory.length !== 1) throw new Error(`expected exactly one run-story, saw ${runStory.length}`);

	send({ id: "agents", type: "prompt", message: "/t3-agents" });
	const probe = await waitFor("agent probe notify", () => notifies.find(n => n.startsWith("T3AGENTS")), 30_000);
	summary.agentProbe = probe;
	if (/MISSING/.test(probe)) throw new Error("an agent definition is not discoverable");

	if (spec.mode === "smoke") {
		send({ id: "smoke", type: "prompt", message: "Reply with the word OK and nothing else." });
		const result = await waitFor("smoke prompt_result", () => frames.find(f => f.type === "prompt_result" && f.id === "smoke"), 120_000);
		const ends = frames.filter(f => f.type === "message_end" && f.message?.role === "assistant");
		summary.smokeCostUsd = ends.reduce((sum, f) => sum + (Number(f.message?.usage?.cost?.total) || 0), 0);
		summary.smokeModel = ends.at(-1)?.message?.model;
		summary.smokeStatus = result.status;
		if (result.status !== "completed" || ends.length === 0) throw new Error("smoke prompt did not complete with an assistant message");
	} else {
		const repoArgs = spec.repos.map(r => `--repo ${r}`).join(" ");
		send({ id: "run-1", type: "prompt", message: `/${spec.command ?? "run-story"} ${spec.plan} ${repoArgs} --vault-git-dir ${spec.vault}/.git --base main --concurrency ${spec.concurrency} --budget ${spec.budget} ${spec.args}` });
		const acting = runActions();
		const started = Date.now();
		while (!exited && !(runEnded && (settledAfterEnd || promptResultRun)) && Date.now() - started < 20 * 60_000) await Bun.sleep(200);
		summary.elapsedMs = Date.now() - started;
		if (!runEnded && !exited) {
			say("ceiling reached: /run-stop");
			send({ id: "stop-1", type: "prompt", message: "/run-stop" });
			await waitFor("run end after stop", () => runEnded, 90_000).catch(() => undefined);
			summary.stoppedByDriver = true;
		}
		await Promise.race([acting, Bun.sleep(1000)]);
	}
} catch (error) {
	summary.error = String(error);
	say(`ERROR: ${error}`);
	process.exitCode = 1;
} finally {
	await finish().catch(() => undefined);
}
