// Named assertions over a finished run (plan D.5). Each check returns { id, pass, detail }. A scenario's expect[] is a list of
// names (the checks in `named`) or mappings (see `genericCheck`). Unknown names and unknown keys FAIL: an expectation that is not
// implemented, or misspelt, never passes silently.
//
// Automatic checks run for every run, before its own expect[]:
//   driver-finished       omp exited 0 (unless a sigkill action fired), the run ended, no driver error, no ceiling stop;
//   log-present           the run wrote a log with `run-start` or `refused` (so a "nothing happened" check has a run behind it);
//   unmatched-gates       no gate went unanswered (unless the run opts in);
//   actions-fired         every declared action fired (a trigger that never came fails the run);
//   scripted runs         `scripted-slots` is the first log entry with the script's sha256, and no rule is left over;
//   haiku runs            no `scripted-*` event and no `scripted:` session file.
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fingerprint, lockFileOf, specWorktreeRoots } from "./setup.ts";
import { scanCode } from "./lib/network-scan.ts";
import type { Expect } from "./scenario.ts";

export interface CheckResult {
	id: string;
	pass: boolean;
	detail: string;
}

export interface RunContext {
	runDir: string;
	story: string;
	runner: "haiku" | "scripted";
	scripted?: string;
	plan: string;
	planFile: string;
	work: string;
	vault: string;
	code: string;
	repos: string[];
	args: string;
	budget: number;
	expect: Expect[];
	declaredActions: number;
	allowUnmatchedGates: boolean;
	/** The run ended before the scheduler wrote a log (scenario `endOn`). */
	noLog?: boolean;
}

const sh = (cwd: string, cmd: string[]) => {
	const r = Bun.spawnSync(cmd, { cwd, stderr: "pipe", stdout: "pipe" });
	return { out: r.stdout.toString(), err: r.stderr.toString(), code: r.exitCode };
};
const git = (repo: string, ...a: string[]) => sh(repo, ["git", "-C", repo, ...a]);

export function readContext(runDir: string): RunContext {
	return JSON.parse(fs.readFileSync(path.join(runDir, "context.json"), "utf8"));
}

/** The entries of the logs this run wrote (the driver copies only those), oldest file first. */
function readEntries(ctx: RunContext): any[] {
	const dir = path.join(ctx.runDir, "spec-runs");
	if (!fs.existsSync(dir)) return [];
	const files = fs.readdirSync(dir).flatMap(d => (fs.statSync(path.join(dir, d)).isDirectory() ? fs.readdirSync(path.join(dir, d)).filter(f => f.endsWith(".jsonl")).map(f => path.join(dir, d, f)) : [])).sort();
	return files.flatMap(f => fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l)));
}

function readDriverSummary(ctx: RunContext): any {
	return JSON.parse(fs.readFileSync(path.join(ctx.runDir, "summary.json"), "utf8"));
}

function readBefore(ctx: RunContext): any {
	return JSON.parse(fs.readFileSync(path.join(ctx.runDir, "before.json"), "utf8"));
}

function readFrames(ctx: RunContext): any[] {
	return fs
		.readFileSync(path.join(ctx.runDir, "events.jsonl"), "utf8")
		.split("\n")
		.filter(Boolean)
		.map(l => JSON.parse(l))
		.filter(e => e.kind === "in")
		.map(e => e.data);
}

function outcomeOf(ctx: RunContext): { outcome?: string; cost?: string; slots?: string } {
	const notifies: string[] = readDriverSummary(ctx).notifies ?? [];
	const found = notifies.map(n => /outcome: (\w+), \$([\d.]+) in (\d+) slot runs/.exec(n)).filter((m): m is RegExpExecArray => m !== null).at(-1);
	return { outcome: found?.[1], cost: found?.[2], slots: found?.[3] };
}

function planTaskIds(ctx: RunContext): string[] {
	const text = fs.readFileSync(path.join(ctx.vault, "Specs/T3/plan.md"), "utf8");
	return [...text.matchAll(/^id: (\S+)$/gm)].map(m => m[1] as string).filter(id => id !== ctx.story);
}

/** The scripted-session events with their parsed detail. */
function sessionsOf(entries: any[]): Array<{ task: string; d: any }> {
	return entries
		.filter(e => e.kind === "event" && e.event === "scripted-session")
		.map(e => {
			let d: any = {};
			try {
				d = JSON.parse(String(e.detail));
			} catch {
				// leave empty: the checks that read it will fail
			}
			return { task: e.task as string, d };
		});
}

const commitsOf = (repo: string, story: string): string[] => git(repo, "log", "--format=%H", "--reverse", `main..${story}`).out.split("\n").filter(Boolean);
const bodyOf = (repo: string, sha: string): string => git(repo, "log", "-1", "--format=%B", sha).out;
const trailerOf = (body: string, key: string): string[] => [...body.matchAll(new RegExp(`^${key}: (.+)$`, "gm"))].map(m => (m[1] as string).trim());

/** The plan revision the scheduler read at the start of this run. */
function runStartRevs(entries: any[]): string[] {
	return entries.filter(e => e.kind === "event" && e.event === "run-start").map(e => /^plan (\w+)/.exec(String(e.detail))?.[1] ?? "");
}

// ---- named checks ----
type Check = (ctx: RunContext) => CheckResult;
const named: Record<string, Check> = {
	"run-outcome-complete": ctx => {
		const s = readDriverSummary(ctx);
		const o = outcomeOf(ctx);
		const errors = readFrames(ctx).filter(f => f.type === "prompt_result" && f.status === "error");
		const unmatched = s.unmatchedGates ?? [];
		return { id: "run-outcome-complete", pass: o.outcome === "complete" && unmatched.length === 0 && errors.length === 0 && !s.error, detail: `outcome=${o.outcome} cost=$${o.cost} slotRuns=${o.slots} unmatchedGates=${unmatched.length} errorPromptResults=${errors.length} driverError=${s.error ?? "none"}` };
	},
	"spec-status-done": ctx => {
		const states = statusStates(ctx);
		const ids = planTaskIds(ctx);
		const pass = ids.length > 0 && ids.every(id => states[id] === "done");
		return { id: "spec-status-done", pass, detail: `states=${JSON.stringify(states)} expected all done (${ids.join(",")})` };
	},
	/** Every commit carries Task and Plan-Rev, the Plan-Rev is the one the run read at its start, and every plan task has commits. */
	trailers: ctx => {
		const revs = new Set(runStartRevs(readEntries(ctx)).filter(Boolean));
		const bad: string[] = [];
		let commits = 0;
		const tasks = new Set<string>();
		for (const repo of ctx.repos) {
			const shas = commitsOf(repo, ctx.story);
			commits += shas.length;
			for (const sha of shas) {
				const body = bodyOf(repo, sha);
				const rev = trailerOf(body, "Plan-Rev");
				const task = trailerOf(body, "Task").flatMap(t => t.split(",").map(x => x.trim()));
				const lockish = trailerOf(body, "Task-Lock").length + trailerOf(body, "Task-Unlock").length;
				for (const t of task) tasks.add(t);
				if (!revs.has(rev[0] ?? "") || (task.length === 0 && lockish === 0)) bad.push(sha.slice(0, 8));
			}
		}
		const pass = revs.size > 0 && commits > 0 && bad.length === 0 && planTaskIds(ctx).every(id => tasks.has(id));
		return { id: "trailers", pass, detail: `commits=${commits} run-start revs=${[...revs].map(r => r.slice(0, 10)).join(",") || "none"} badTrailers=${bad.join(",") || "none"} tasks=${[...tasks].join(",")}` };
	},
	"task-lock": ctx => {
		let locks = 0;
		for (const repo of ctx.repos) for (const sha of commitsOf(repo, ctx.story)) if (/^Task-Lock: /m.test(bodyOf(repo, sha))) locks++;
		return { id: "task-lock", pass: locks >= planTaskIds(ctx).length, detail: `Task-Lock commits=${locks}` };
	},
	/** A task is checked on its implementation commit and noted on the commit that lands: the last commit of each task carries a passing note. */
	"check-notes": ctx => {
		const bad: string[] = [];
		let checked = 0;
		for (const repo of ctx.repos) {
			const last = new Map<string, string>();
			for (const sha of commitsOf(repo, ctx.story)) for (const t of trailerOf(bodyOf(repo, sha), "Task")) last.set(t, sha);
			for (const [task, sha] of last) {
				checked++;
				let parsed: any;
				try {
					parsed = JSON.parse(git(repo, "notes", "--ref=spec-checks", "show", sha).out);
				} catch {
					parsed = undefined;
				}
				const ok = parsed?.v === 1 && parsed?.checks?.test === "pass" && parsed?.checks?.guard === "pass" && parsed?.blocked === false;
				if (!ok) bad.push(`${task}@${sha.slice(0, 8)}`);
			}
		}
		return { id: "check-notes", pass: checked > 0 && checked >= planTaskIds(ctx).length && bad.length === 0, detail: `tasks checked=${checked} last commits without a passing note: ${bad.join(",") || "none"}` };
	},
	"pre-push-hook": ctx => {
		const marker = /export const MARKER = "([^"]+)"/.exec(fs.readFileSync(path.join(ctx.code, "extensions/lib/spec-cli.ts"), "utf8"))?.[1] ?? "";
		const problems: string[] = [];
		for (const repo of ctx.repos) {
			const common = path.resolve(repo, git(repo, "rev-parse", "--git-common-dir").out.trim());
			const hookFile = path.join(common, "hooks/pre-push");
			const hook = fs.existsSync(hookFile) ? fs.readFileSync(hookFile, "utf8") : "";
			const cfgFile = path.join(common, "spec-workflow.json");
			const wf = fs.existsSync(cfgFile) ? JSON.parse(fs.readFileSync(cfgFile, "utf8")) : undefined;
			// R-57: the hook runs bun (the guard script by `bun`), never the omp binary.
			const runsBun = /'[^']*\/bun' '[^']*spec-guard\.ts'/.test(hook);
			if (marker === "" || !hook.includes(marker) || !runsBun || wf?.plan !== ctx.planFile || wf?.base !== "main") problems.push(`${path.basename(repo)}: marker=${hook.includes(marker)} runsBun=${runsBun} workflow=${JSON.stringify(wf)}`);
		}
		return { id: "pre-push-hook", pass: problems.length === 0, detail: problems.join("; ") || `hook with marker, running bun, and workflow config in ${ctx.repos.length} clone(s)` };
	},
	/** R-92: the status line is pushed through setStatus while the run goes: the story counts and a running slot. */
	"status-frames": ctx => {
		const lines = readFrames(ctx).filter(f => f.type === "extension_ui_request" && f.method === "setStatus" && f.statusText).map(f => String(f.statusText));
		const counts = lines.some(l => /▸ \d+\/\d+ done/.test(l));
		const running = lines.some(l => /running T3-SUM-T0\d \w+/.test(l));
		return { id: "status-frames", pass: counts && running, detail: `status frames=${lines.length} counts=${counts} running slot=${running}` };
	},
	"run-log-shape": ctx => {
		const entries = readEntries(ctx);
		const slots = entries.filter(e => e.kind === "slot");
		const ev = (name: string) => entries.find(e => e.kind === "event" && e.event === name);
		const runEnd = ev("run-end");
		const endCost = Number(/\$([\d.]+)/.exec(runEnd?.detail ?? "")?.[1]);
		const slotCost = slots.reduce((s, e) => s + (Number(e.costUsd) || 0), 0);
		const bad = slots.filter(e => e.outcome !== "verdict");
		const pass = !!ev("run-start") && String(runEnd?.detail).startsWith("complete") && bad.length === 0 && Math.abs(slotCost - endCost) < 0.0105;
		return { id: "run-log-shape", pass, detail: `slotLines=${slots.length} nonVerdict=${bad.length} slotCost=$${slotCost.toFixed(4)} runEnd="${runEnd?.detail}"` };
	},
	"zero-typesafe": ctx => {
		const entries = readEntries(ctx);
		const sessionFiles = [...new Set(entries.filter(e => e.kind === "slot").map(e => e.sessionFile).filter((f): f is string => typeof f === "string" && f.startsWith("/")))];
		const hits = sessionFiles.filter(f => fs.existsSync(f) && /typesafe/i.test(fs.readFileSync(f, "utf8")));
		const missing = sessionFiles.filter(f => !fs.existsSync(f));
		const evHits = (fs.readFileSync(path.join(ctx.runDir, "events.jsonl"), "utf8").match(/typesafe/gi) ?? []).length;
		const pass = sessionFiles.length > 0 && missing.length === 0 && hits.length === 0 && evHits === 0;
		return { id: "zero-typesafe", pass, detail: `slot session files=${sessionFiles.length} missing=${missing.length} with "typesafe"=${hits.length} events.jsonl hits=${evHits}` };
	},
	"real-state-untouched": ctx => {
		const before: string[] = readBefore(ctx).real;
		const after = fingerprint();
		const changed = after.filter((l, i) => l !== before[i] && !/omp-starter tree/.test(l));
		return { id: "real-state-untouched", pass: before.length === after.length && changed.length === 0, detail: `changed lines (omp-starter tree excluded): ${changed.join(" | ") || "none"}` };
	},
	"cost-within-budget": ctx => {
		const slotCost = readEntries(ctx).filter(e => e.kind === "slot").reduce((s, e) => s + (Number(e.costUsd) || 0), 0);
		return { id: "cost-within-budget", pass: slotCost <= ctx.budget + 1e-9, detail: `slot cost=$${slotCost.toFixed(4)} budget=$${ctx.budget}` };
	},
	"hook-installed-by-scheduler": ctx => {
		const entries = readEntries(ctx);
		const gate = entries.find(e => e.kind === "gate" && e.cause === "missing-hook");
		const refused = entries.filter(e => e.kind === "event" && e.event === "refused").length;
		return { id: "hook-installed-by-scheduler", pass: gate?.choice === "install" && refused === 0, detail: `missing-hook gate=${JSON.stringify(gate ?? null)} refused events=${refused}` };
	},
	/** No worktree of this run is left: the clone lists only itself, and no spec-wt folder holds a worktree that points at this clone. */
	"no-leftover-worktree": ctx => {
		const clones = ctx.repos.map(r => path.join(r, ".git"));
		const leftover: string[] = [];
		for (const root of specWorktreeRoots().map(n => path.join("/tmp", n))) {
			let entries: string[] = [];
			try {
				entries = fs.readdirSync(root);
			} catch {
				continue;
			}
			for (const entry of entries) {
				try {
					const pointer = fs.readFileSync(path.join(root, entry, ".git"), "utf8");
					if (clones.some(c => pointer.includes(c))) leftover.push(path.join(root, entry));
				} catch {
					// not a worktree
				}
			}
		}
		const listed = ctx.repos.map(r => git(r, "worktree", "list", "--porcelain").out.split("\n").filter(l => l.startsWith("worktree ")).length);
		return { id: "no-leftover-worktree", pass: leftover.length === 0 && listed.every(n => n === 1), detail: `worktrees of this run left in spec-wt folders=${leftover.join(",") || "none"} clone worktree counts=${listed.join(",")}` };
	},
	/** R-106: no push and no vault write: the scenario vault is as it was, no remote-tracking ref exists, no `refs/remotes` push record. */
	"no-push-no-vault-write": ctx => {
		const before = readBefore(ctx);
		const vaultHead = git(ctx.vault, "rev-parse", "HEAD").out.trim();
		const vaultStatus = git(ctx.vault, "status", "--porcelain").out.trim();
		const remotes = ctx.repos.map(r => git(r, "for-each-ref", "refs/remotes").out.trim()).filter(Boolean);
		const pass = vaultHead === before.vaultHead && vaultStatus === "" && remotes.length === 0;
		return { id: "no-push-no-vault-write", pass, detail: `vault HEAD moved=${vaultHead !== before.vaultHead} vault status="${vaultStatus}" remote-tracking refs=${remotes.length}` };
	},
	/** R-106: no network use and no push in the scheduler's code (the run's own copy of it): a hit names file and line. */
	"no-network-code": ctx => {
		const { files, hits } = scanCode(ctx.code);
		return { id: "no-network-code", pass: files >= 10 && hits.length === 0, detail: `scanned ${files} files of the scheduler's code; hits: ${hits.map(h => `${h.file}:${h.line} ${h.why}: ${h.text}`).join(" | ") || "none"}` };
	},
	/** R-80: every slot line names the agent id its session ran under; none is Main; no two slots of the run share one (so overlapping slots never do). */
	"slot-agent-ids": ctx => {
		const slots = readEntries(ctx).filter(e => e.kind === "slot");
		const missing = slots.filter(e => typeof e.agentId !== "string" || e.agentId === "").length;
		const main = slots.filter(e => e.agentId === "Main").length;
		const ids = slots.map(e => e.agentId as string);
		const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
		const spans = slots.map(e => [Date.parse(e.at) - Number(e.durationMs), Date.parse(e.at), e.agentId as string] as const);
		let overlapping = 0;
		for (let i = 0; i < spans.length; i++) for (let j = i + 1; j < spans.length; j++) if ((spans[i] as readonly [number, number, string])[0] < (spans[j] as readonly [number, number, string])[1] && (spans[j] as readonly [number, number, string])[0] < (spans[i] as readonly [number, number, string])[1]) overlapping++;
		return { id: "slot-agent-ids", pass: slots.length > 0 && missing === 0 && main === 0 && dup.length === 0, detail: `slot lines=${slots.length} without agentId=${missing} Main=${main} duplicate ids=${dup.join(",") || "none"} overlapping pairs=${overlapping}` };
	},
	"spec-guard-strict": ctx => {
		const bad: string[] = [];
		for (const repo of ctx.repos) {
			const r = sh(ctx.code, ["bun", path.join(ctx.code, "scripts/spec-guard.ts"), "--strict", "--repo", repo, "--base", "main", "--range", `main..${ctx.story}`, "--plan", ctx.planFile, "--vault-git-dir", path.join(ctx.vault, ".git")]);
			if (r.code !== 0) bad.push(`${path.basename(repo)}: exit ${r.code} ${r.out.trim().split("\n")[0]}${r.err.trim()}`);
		}
		return { id: "spec-guard-strict", pass: bad.length === 0, detail: bad.join("; ") || "spec-guard --strict passes on main..ticket" };
	},
	/** R-108: Security-Accept names the task, and Accept-Gate equals the id of the patient_data gate the log shows answered `accept`. */
	"accept-trailers": ctx => {
		const entries = readEntries(ctx);
		const gate = entries.find(e => e.kind === "gate" && e.cause === "patient_data" && e.choice === "accept");
		const found: Array<{ accept: string[]; gate: string[] }> = [];
		for (const repo of ctx.repos) for (const sha of commitsOf(repo, ctx.story)) {
			const body = bodyOf(repo, sha);
			if (/^Security-Accept: /m.test(body)) found.push({ accept: trailerOf(body, "Security-Accept"), gate: trailerOf(body, "Accept-Gate") });
		}
		const pass = gate !== undefined && found.length === 1 && found[0]?.gate.length === 1 && found[0]?.gate[0] === gate.id && found[0]?.accept[0] === gate.task;
		return { id: "accept-trailers", pass, detail: `log gate=${gate?.id ?? "none"} accept commits=${JSON.stringify(found)}` };
	},
	/** R-14: the Task-Unlock commit carries Unlock-Gate equal to the id of the test_wrong gate the log shows answered `unlock`. */
	"unlock-trailers": ctx => {
		const gate = readEntries(ctx).find(e => e.kind === "gate" && e.cause === "test_wrong" && e.choice === "unlock");
		const found: string[][] = [];
		for (const repo of ctx.repos) for (const sha of commitsOf(repo, ctx.story)) {
			const body = bodyOf(repo, sha);
			if (/^Task-Unlock: /m.test(body)) found.push(trailerOf(body, "Unlock-Gate"));
		}
		return { id: "unlock-trailers", pass: gate !== undefined && found.length === 1 && found[0]?.length === 1 && found[0]?.[0] === gate.id, detail: `log gate=${gate?.id ?? "none"} unlock commits=${JSON.stringify(found)}` };
	},
	"scripted-slots-entry": ctx => {
		const entries = readEntries(ctx);
		const e = entries.find(x => x.kind === "event" && x.event === "scripted-slots");
		const sha = ctx.scripted ? createHash("sha256").update(fs.readFileSync(ctx.scripted)).digest("hex") : "";
		const first = entries[0] === e;
		return { id: "scripted-slots-entry", pass: e !== undefined && first && sha.length > 0 && String(e.detail).endsWith(` ${sha}`), detail: `scripted-slots first entry=${first} event=${JSON.stringify(e ?? null)} expected sha=${sha.slice(0, 12)}` };
	},
	"scripted-slots-unused-absent": ctx => {
		const unused = readEntries(ctx).filter(x => x.kind === "event" && x.event === "scripted-slots-unused");
		return { id: "scripted-slots-unused-absent", pass: unused.length === 0, detail: `scripted-slots-unused events=${unused.length}${unused[0] ? ` (${unused[0].detail})` : ""}` };
	},
	"haiku-no-scripted-entry": ctx => {
		const entries = readEntries(ctx);
		const events = entries.filter(x => x.kind === "event" && String(x.event).startsWith("scripted-"));
		const files = entries.filter(x => x.kind === "slot" && String(x.sessionFile ?? "").startsWith("scripted:"));
		return { id: "haiku-no-scripted-entry", pass: events.length === 0 && files.length === 0, detail: `scripted-* events=${events.length} scripted: session files=${files.length}` };
	},
};
export const LEGACY_NAMES = Object.keys(named);

function statusStates(ctx: RunContext): Record<string, string> {
	const args = ctx.repos.flatMap(r => ["--repo", r]);
	const st = sh(ctx.code, ["bun", path.join(ctx.code, "scripts/spec-status.ts"), path.join(ctx.vault, ctx.planFile), ...args, "--branch", ctx.story, "--base", "main", "--vault-git-dir", path.join(ctx.vault, ".git"), "--json"]);
	try {
		return Object.fromEntries((JSON.parse(st.out)?.tasks ?? []).map((t: any) => [t.id, t.state]));
	} catch {
		return {};
	}
}

function statusTasks(ctx: RunContext): any[] {
	const args = ctx.repos.flatMap(r => ["--repo", r]);
	const st = sh(ctx.code, ["bun", path.join(ctx.code, "scripts/spec-status.ts"), path.join(ctx.vault, ctx.planFile), ...args, "--branch", ctx.story, "--base", "main", "--vault-git-dir", path.join(ctx.vault, ".git"), "--json"]);
	try {
		return JSON.parse(st.out)?.tasks ?? [];
	} catch {
		return [];
	}
}

// ---- generic expectations ----

/** The forms an entry matcher takes (inside `order` and as a top-level expectation). */
const ENTRY_KEYS = ["event", "slot", "session", "gate"] as const;
const COMMON_KEYS = ["count", "absent"];
const TOP_KEYS: Record<string, readonly string[]> = {
	event: ["event", "task", "detail", ...COMMON_KEYS],
	slot: ["slot", ...COMMON_KEYS],
	session: ["session", ...COMMON_KEYS],
	gate: ["gate", ...COMMON_KEYS],
	noSlot: ["noSlot"],
	order: ["order"],
	outcome: ["outcome"],
	notify: ["notify"],
	refused: ["refused"],
	ticket: ["ticket"],
	status: ["status"],
	commitTrailer: ["commitTrailer", "absent"],
	commitShape: ["commitShape"],
	keptRef: ["keptRef"],
	noTicketBranch: ["noTicketBranch"],
	gateOptions: ["gateOptions"],
	maxConcurrent: ["maxConcurrent"],
	overlap: ["overlap"],
	gatesSerial: ["gatesSerial"],
	sessionOptions: ["sessionOptions"],
	lockFile: ["lockFile"],
	ticketFile: ["ticketFile"],
	secondRun: ["secondRun"],
	worktreeSurvives: ["worktreeSurvives"],
	injected: ["injected"],
	tui: ["tui"],
};
/** What the pty driver observed (summary.tui). */
const TUI_FACTS = ["notice-shown", "controls-pass", "second-run-refused", "report-shown", "no-model-turn"];
const SLOT_KEYS = ["task", "slot", "attempt", "verdict", "outcome", "detail"];
const GATE_KEYS = ["cause", "task", "choice", "note"];
const SESSION_KEYS = ["task", "slot", "attempt", "promptHas"];

/** Why an expectation mapping is malformed, or undefined. Called when a scenario is loaded and again before it is judged. */
export function expectProblem(e: unknown): string | undefined {
	if (typeof e === "string") return LEGACY_NAMES.includes(e) ? undefined : `no such named check "${e}"`;
	if (typeof e !== "object" || e === null || Array.isArray(e)) return "an expectation is a name or a mapping";
	const keys = Object.keys(e);
	const form = Object.keys(TOP_KEYS).filter(k => k in e);
	if (form.length !== 1) return `needs exactly one of ${Object.keys(TOP_KEYS).join(", ")}; got ${keys.join(", ")}`;
	const allowed = TOP_KEYS[form[0] as string] as readonly string[];
	const stray = keys.filter(k => !allowed.includes(k));
	if (stray.length) return `unknown key ${stray.join(", ")} for ${form[0]}`;
	const m = e as Record<string, any>;
	const nested = (value: any, allowedKeys: string[], label: string): string | undefined => {
		if (typeof value !== "object" || value === null) return `${label} must be a mapping`;
		const bad = Object.keys(value).filter(k => !allowedKeys.includes(k));
		return bad.length ? `unknown key ${bad.join(", ")} in ${label}` : undefined;
	};
	if (form[0] === "slot") return nested(m.slot, SLOT_KEYS, "slot");
	if (form[0] === "gate") return nested(m.gate, GATE_KEYS, "gate");
	if (form[0] === "session") return nested(m.session, SESSION_KEYS, "session");
	if (form[0] === "noSlot") return nested(m.noSlot, ["task", "slot", "attempt"], "noSlot");
	if (form[0] === "order") {
		if (!Array.isArray(m.order) || m.order.length < 2) return "order needs a list of at least two entries";
		for (const item of m.order) {
			const f = ENTRY_KEYS.filter(k => k in item);
			if (f.length !== 1) return `an order entry needs exactly one of ${ENTRY_KEYS.join(", ")}`;
			const bad = Object.keys(item).filter(k => k !== f[0] && !(f[0] === "event" && ["task", "detail"].includes(k)));
			if (bad.length) return `unknown key ${bad.join(", ")} in an order entry`;
		}
	}
	if (form[0] === "ticket" && !["untouched", "advanced", "moved", "injected"].includes(m.ticket)) return "ticket must be untouched, advanced, moved or injected";
	if (form[0] === "outcome" && !["complete", "incomplete", "stopped", "refused"].includes(m.outcome)) return "outcome must be complete, incomplete, stopped or refused";
	if (form[0] === "status") return nested(m.status, ["task", "state", "reason"], "status") ?? (m.status.task && m.status.state ? undefined : "status needs task and state");
	if (form[0] === "gateOptions") return nested(m.gateOptions, ["title", "options", "only"], "gateOptions");
	if (form[0] === "maxConcurrent") return nested(m.maxConcurrent, ["atMost", "reached"], "maxConcurrent");
	if (form[0] === "gatesSerial") return nested(m.gatesSerial, ["min"], "gatesSerial");
	if (form[0] === "lockFile" && !["present", "absent"].includes(m.lockFile)) return "lockFile must be present or absent";
	if (form[0] === "ticketFile") return nested(m.ticketFile, ["path", "contains"], "ticketFile");
	if (form[0] === "secondRun") return nested(m.secondRun, ["refused"], "secondRun");
	if (form[0] === "tui" && !TUI_FACTS.includes(m.tui)) return `tui must be one of ${TUI_FACTS.join(", ")}`;
	return undefined;
}

function entryMatcher(m: Record<string, any>): (e: any) => boolean {
	if (m.event !== undefined) return e => e.kind === "event" && e.event === m.event && (m.task === undefined || e.task === m.task) && (m.detail === undefined || new RegExp(m.detail).test(String(e.detail ?? "")));
	if (m.slot !== undefined) {
		const s = m.slot;
		return e => e.kind === "slot" && e.slot === s.slot && (s.task === undefined || e.task === s.task) && (s.attempt === undefined || e.attempt === s.attempt) && (s.verdict === undefined || e.verdict === s.verdict) && (s.outcome === undefined || e.outcome === s.outcome) && (s.detail === undefined || new RegExp(s.detail).test(String(e.detail ?? "")));
	}
	if (m.gate !== undefined) {
		const g = m.gate;
		return e => e.kind === "gate" && e.cause === g.cause && (g.task === undefined || e.task === g.task) && (g.choice === undefined || e.choice === g.choice) && (g.note === undefined || new RegExp(g.note).test(String(e.note ?? "")));
	}
	if (m.session !== undefined) {
		const s = m.session;
		return e => {
			if (e.kind !== "event" || e.event !== "scripted-session" || (s.task !== undefined && e.task !== s.task)) return false;
			try {
				const d = JSON.parse(String(e.detail));
				return (s.slot === undefined || d.slot === s.slot) && (s.attempt === undefined || d.attempt === s.attempt) && (s.promptHas === undefined || new RegExp(s.promptHas).test(String(d.prompt ?? "")));
			} catch {
				return false;
			}
		};
	}
	return () => false;
}

const TASK_END = ["task-done", "task-blocked", "task-stopped", "task-error"];
/** [start, end] of each task from the log order (entries have no reliable clock resolution), as indexes. */
function taskSpans(entries: any[]): Map<string, [number, number]> {
	const spans = new Map<string, [number, number]>();
	entries.forEach((e, i) => {
		if (e.kind !== "event" || e.task === undefined) return;
		if (e.event === "task-start") spans.set(e.task, [i, Number.POSITIVE_INFINITY]);
		else if (TASK_END.includes(e.event) && spans.has(e.task)) spans.set(e.task, [spans.get(e.task)![0], i]);
	});
	return spans;
}

function genericCheck(expect: Record<string, any>, ctx: RunContext): CheckResult {
	const entries = readEntries(ctx);
	const label = JSON.stringify(expect);
	const problem = expectProblem(expect);
	if (problem) return { id: label, pass: false, detail: `malformed expectation: ${problem}` };
	if (expect.outcome !== undefined) {
		const o = outcomeOf(ctx);
		return { id: label, pass: o.outcome === expect.outcome, detail: `outcome=${o.outcome}` };
	}
	if (expect.event !== undefined || expect.slot !== undefined || expect.gate !== undefined || expect.session !== undefined) {
		const n = entries.filter(entryMatcher(expect)).length;
		const pass = expect.absent === true ? n === 0 : expect.count !== undefined ? n === expect.count : n >= 1;
		return { id: label, pass, detail: `matching entries=${n}${expect.absent ? " (must be 0)" : expect.count !== undefined ? ` (must be ${expect.count})` : ""}` };
	}
	if (expect.noSlot !== undefined) {
		const s = expect.noSlot;
		const asSlot = entries.filter(entryMatcher({ slot: { slot: s.slot, task: s.task, attempt: s.attempt } })).length;
		const asSession = entries.filter(entryMatcher({ session: { slot: s.slot, task: s.task, attempt: s.attempt } })).length;
		return { id: label, pass: asSlot + asSession === 0, detail: `slot lines=${asSlot} scripted sessions=${asSession} (both must be 0)` };
	}
	if (expect.order !== undefined) {
		let at = -1;
		const seen: string[] = [];
		for (const m of expect.order as Record<string, any>[]) {
			const match = entryMatcher(m);
			const idx = entries.findIndex((e, i) => i > at && match(e));
			seen.push(`${JSON.stringify(m)}@${idx}`);
			if (idx < 0) return { id: label, pass: false, detail: `not found in order: ${seen.join(" < ")}` };
			at = idx;
		}
		return { id: label, pass: true, detail: seen.join(" < ") };
	}
	if (expect.notify !== undefined) {
		const notifies: string[] = readDriverSummary(ctx).notifies ?? [];
		const hit = notifies.some(n => new RegExp(expect.notify).test(n));
		return { id: label, pass: hit, detail: `notify /${expect.notify}/ in ${notifies.length} notifies` };
	}
	if (expect.refused !== undefined) {
		const hit = entries.some(e => e.kind === "event" && e.event === "refused" && new RegExp(expect.refused).test(String(e.detail ?? "")));
		return { id: label, pass: hit, detail: `refused event /${expect.refused}/` };
	}
	if (expect.ticket !== undefined) {
		const before: Record<string, string> = readBefore(ctx).tickets;
		const injected = readDriverSummary(ctx).injected?.ticket as string | undefined;
		const moved = ctx.repos.map(r => {
			const name = path.basename(r);
			const now = git(r, "rev-parse", ctx.story).out.trim();
			return { name, now, moved: now !== before[name] };
		});
		let pass: boolean;
		if (expect.ticket === "untouched") pass = moved.every(m => !m.moved);
		else if (expect.ticket === "advanced") pass = moved.every(m => m.moved);
		else if (expect.ticket === "moved") pass = moved.some(m => m.moved);
		else pass = injected !== undefined && moved.every(m => m.now === injected);
		return { id: label, pass, detail: `ticket branch ${expect.ticket}: ${moved.map(m => `${m.name}=${m.moved ? "moved" : "same"}@${m.now.slice(0, 8)}`).join(" ")}${injected ? ` injected=${injected.slice(0, 8)}` : ""}` };
	}
	if (expect.status !== undefined) {
		const task = statusTasks(ctx).find(t => t.id === expect.status.task);
		const stateOk = task?.state === expect.status.state;
		const reasonOk = expect.status.reason === undefined || new RegExp(expect.status.reason).test(String(task?.reason ?? ""));
		return { id: label, pass: stateOk && reasonOk, detail: `${expect.status.task}=${task?.state} reason="${task?.reason ?? ""}"` };
	}
	if (expect.commitTrailer !== undefined) {
		const found = ctx.repos.some(r => commitsOf(r, ctx.story).some(sha => trailerOf(bodyOf(r, sha), expect.commitTrailer).length > 0));
		return { id: label, pass: expect.absent === true ? !found : found, detail: `trailer ${expect.commitTrailer} on a ticket-branch commit=${found}${expect.absent ? " (must be absent)" : ""}` };
	}
	if (expect.commitShape !== undefined) {
		const repo = ctx.repos[0] as string;
		const shape = commitsOf(repo, ctx.story).map(sha => {
			const body = bodyOf(repo, sha);
			return /^Task-Lock: /m.test(body) ? "lock" : /^Task-Unlock: /m.test(body) ? "unlock" : /^Security-Accept: /m.test(body) ? "accept" : "work";
		});
		return { id: label, pass: JSON.stringify(shape) === JSON.stringify(expect.commitShape), detail: `commit shape on the ticket branch=${shape.join(",")}` };
	}
	if (expect.keptRef !== undefined) {
		const ref = `refs/spec-conflict/${ctx.story}/${expect.keptRef}`;
		const log = git(ctx.repos[0] as string, "log", "--format=%H", `main..${ref}`);
		return { id: label, pass: log.code === 0 && log.out.trim().split("\n").filter(Boolean).length > 0, detail: `${ref} holds ${log.code === 0 ? log.out.trim().split("\n").filter(Boolean).length : 0} commits` };
	}
	if (expect.noTicketBranch !== undefined) {
		const r = git(ctx.repos[0] as string, "rev-parse", "--verify", "--quiet", `refs/heads/${ctx.story}`);
		return { id: label, pass: r.code !== 0, detail: `ticket branch exists=${r.code === 0}` };
	}
	if (expect.gateOptions !== undefined) {
		const want = expect.gateOptions;
		const gates: Array<{ title: string; options: string[] }> = readDriverSummary(ctx).gates ?? [];
		const gate = gates.find(g => new RegExp(want.title).test(g.title));
		const missing = (want.options as string[]).filter(o => !gate?.options.some(label => new RegExp(o).test(label)));
		const extra = want.only === true && gate ? gate.options.filter(label => !(want.options as string[]).some(o => new RegExp(o).test(label))) : [];
		return { id: label, pass: gate !== undefined && missing.length === 0 && extra.length === 0, detail: `gate "${gate?.title ?? "none"}" options=${JSON.stringify(gate?.options ?? [])} missing=${JSON.stringify(missing)} extra=${JSON.stringify(extra)}` };
	}
	if (expect.maxConcurrent !== undefined) {
		const spans = [...taskSpans(entries).values()];
		let max = 0;
		for (const [start] of spans) max = Math.max(max, spans.filter(([s, e]) => s <= start && start < e).length);
		const pass = max <= expect.maxConcurrent.atMost && (expect.maxConcurrent.reached === undefined || max === expect.maxConcurrent.reached) && spans.length > 0;
		return { id: label, pass, detail: `tasks=${spans.length} max concurrent=${max}` };
	}
	if (expect.overlap !== undefined) {
		const spans = taskSpans(entries);
		const [a, b] = (expect.overlap as string[]).map(t => spans.get(t));
		const pass = a !== undefined && b !== undefined && a[0] < b[1] && b[0] < a[1];
		return { id: label, pass, detail: `${expect.overlap[0]}=${JSON.stringify(a)} ${expect.overlap[1]}=${JSON.stringify(b)} (log positions)` };
	}
	if (expect.gatesSerial !== undefined) {
		const timeline: Array<{ id: string; title: string; reqAt: number; respAt?: number }> = [...(readDriverSummary(ctx).gateTimeline ?? [])].sort((x, y) => x.reqAt - y.reqAt);
		const real = timeline.filter(g => !/pre-push hook|does not exist/.test(g.title));
		const overlapping = real.filter((g, i) => i > 0 && (real[i - 1] as typeof g).respAt !== undefined && g.reqAt < (real[i - 1] as typeof g).respAt!);
		const unanswered = real.filter(g => g.respAt === undefined);
		const pass = real.length >= (expect.gatesSerial.min ?? 2) && overlapping.length === 0 && unanswered.length === 0;
		return { id: label, pass, detail: `gates=${real.length} overlapping=${overlapping.length} unanswered=${unanswered.length} ${real.map(g => `${g.title.slice(0, 40)}[${g.reqAt % 100000}-${g.respAt === undefined ? "?" : g.respAt % 100000}]`).join(" ")}` };
	}
	if (expect.sessionOptions !== undefined) return sessionOptionsCheck(entries, ctx);
	if (expect.lockFile !== undefined) {
		const present = fs.existsSync(lockFileOf(ctx.repos[0] as string));
		return { id: label, pass: present === (expect.lockFile === "present"), detail: `lock file ${lockFileOf(ctx.repos[0] as string)} present=${present}` };
	}
	if (expect.ticketFile !== undefined) {
		const show = git(ctx.repos[0] as string, "show", `${ctx.story}:${expect.ticketFile.path}`);
		return { id: label, pass: show.code === 0 && show.out.includes(expect.ticketFile.contains), detail: `${expect.ticketFile.path} on the ticket: ${show.code === 0 ? JSON.stringify(show.out.slice(0, 120)) : "absent"}` };
	}
	if (expect.secondRun !== undefined) {
		const file = path.join(ctx.runDir, "second-run.json");
		const second = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : undefined;
		const hit = (second?.notifies ?? []).some((n: string) => new RegExp(expect.secondRun.refused).test(n) && /outcome: refused/.test(n));
		return { id: label, pass: second?.finished === true && hit, detail: `second run finished=${second?.finished} refused /${expect.secondRun.refused}/ in its notifies=${hit}` };
	}
	if (expect.worktreeSurvives !== undefined) {
		const file = path.join(ctx.runDir, "second-run.json");
		const second = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : undefined;
		const pass = String(second?.worktreesAfter ?? "").includes(`spec-wt/${ctx.story}/${expect.worktreeSurvives}`);
		return { id: label, pass, detail: `first run's worktree branch listed after the second run=${pass}` };
	}
	if (expect.tui !== undefined) {
		const t = readDriverSummary(ctx).tui ?? {};
		const facts: Record<string, boolean> = {
			"notice-shown": t.noticeShown === true,
			"controls-pass": t.statusShown === true,
			"second-run-refused": t.secondRefused === true,
			"report-shown": t.reportShown === true,
			"no-model-turn": t.workingDuringRun === false && t.noticeShown === true,
		};
		return { id: label, pass: facts[expect.tui] === true, detail: `tui ${JSON.stringify(t)}` };
	}
	if (expect.injected !== undefined) {
		const injected = readDriverSummary(ctx).injected ?? {};
		return { id: label, pass: typeof injected[expect.injected] === "string", detail: `injected ${expect.injected}=${injected[expect.injected] ?? "none"}` };
	}
	return { id: label, pass: false, detail: "unknown expect form" };
}

const WRITING = ["read", "glob", "ast_grep", "lsp", "edit", "write", "bash"];
const READING = ["read", "glob", "ast_grep", "lsp"];
const WRITING_SLOTS = ["test_author", "implementer"];
const BANNED = ["find", "task", "ask", "todo", "yield", "mcp"];

/** R-77, R-78: the options the real runner passed to each scripted session. */
function sessionOptionsCheck(entries: any[], ctx: RunContext): CheckResult {
	const sessions = sessionsOf(entries);
	const problems: string[] = [];
	const ids = new Set<string>();
	for (const { task, d } of sessions) {
		const where = `${task}/${d.slot}#${d.attempt}`;
		const tools: string[] = d.toolNames ?? [];
		const want = WRITING_SLOTS.includes(d.slot) ? WRITING : READING;
		if (JSON.stringify(tools) !== JSON.stringify(want)) problems.push(`${where}: tools ${JSON.stringify(tools)}`);
		if (tools.some(t => BANNED.includes(t) || t.startsWith("mcp"))) problems.push(`${where}: banned tool`);
		if (!["low", "medium", "high"].includes(d.thinkingLevel)) problems.push(`${where}: thinkingLevel ${d.thinkingLevel}`);
		if (d.outputSchemaMode !== "strict") problems.push(`${where}: schema mode ${d.outputSchemaMode}`);
		if (d.restrictToolNames !== true || d.requireYieldTool !== true) problems.push(`${where}: restrict/yield not set`);
		if (d.bindProcessState !== false || d.hasUI !== false || d.enableMCP !== false) problems.push(`${where}: process state, UI or MCP not off`);
		if (d.guardHandlers !== 1) problems.push(`${where}: guard handlers ${d.guardHandlers}`);
		if (d.extensions !== false) problems.push(`${where}: extensions option present`);
		if (d.title !== `spec:${ctx.story}:${task}:${d.slot}`) problems.push(`${where}: title ${d.title}`);
		if (typeof d.agentId !== "string" || d.agentId === "Main" || !d.agentId.startsWith(`spec-${ctx.story}-`) || ids.has(d.agentId)) problems.push(`${where}: agent id ${d.agentId}`);
		ids.add(d.agentId);
	}
	const kinds = new Set(sessions.map(s => s.d.slot));
	const writing = [...kinds].some(k => WRITING_SLOTS.includes(k));
	const reading = [...kinds].some(k => !WRITING_SLOTS.includes(k));
	return { id: "sessionOptions", pass: sessions.length >= 2 && writing && reading && problems.length === 0, detail: `sessions=${sessions.length} slots=${[...kinds].join(",")} problems=${problems.join("; ") || "none"}` };
}

// ---- automatic checks ----
function automatic(ctx: RunContext): CheckResult[] {
	const out: CheckResult[] = [];
	let s: any;
	try {
		s = readDriverSummary(ctx);
	} catch {
		return [{ id: "driver-finished", pass: false, detail: "no summary.json" }];
	}
	const killed = s.sigkilled === true;
	out.push({
		id: "driver-finished",
		pass: s.error === undefined && s.stoppedByDriver !== true && (killed ? s.runEnded !== true : s.runEnded === true && s.exit === 0),
		detail: `error=${s.error ?? "none"} stoppedByDriver=${s.stoppedByDriver === true} sigkilled=${killed} runEnded=${s.runEnded === true} ompExit=${s.exit}`,
	});
	const entries = readEntries(ctx);
	const started = entries.some(e => e.kind === "event" && (e.event === "run-start" || e.event === "refused"));
	if (ctx.noLog) out.push({ id: "log-absent", pass: entries.length === 0, detail: `the run fails before the scheduler: log entries=${entries.length} (must be 0)` });
	else out.push({ id: "log-present", pass: started, detail: `entries=${entries.length} run-start or refused=${started}` });
	const unmatched = s.unmatchedGates ?? [];
	out.push({ id: "unmatched-gates", pass: ctx.allowUnmatchedGates || unmatched.length === 0, detail: `unmatched gates=${unmatched.map((u: any) => u.title).join(" | ") || "none"}${ctx.allowUnmatchedGates ? " (allowed)" : ""}` });
	const fired: string[] = s.actionsFired ?? [];
	out.push({ id: "actions-fired", pass: fired.length === ctx.declaredActions && s.actionError === undefined, detail: `declared=${ctx.declaredActions} fired=${fired.join(",") || "none"} actionError=${s.actionError ?? "none"}` });
	return out;
}

/** Runs the automatic checks, then one run's expect[]. */
export function assertRun(ctx: RunContext): CheckResult[] {
	const names: Expect[] = [...ctx.expect];
	if (ctx.runner === "haiku") names.push("haiku-no-scripted-entry");
	else if (!ctx.noLog) names.push("scripted-slots-entry", "scripted-slots-unused-absent");
	const results = names.map(e => {
		if (typeof e === "string") {
			const check = named[e];
			return check ? check(ctx) : { id: e, pass: false, detail: "no such named check" };
		}
		return genericCheck(e, ctx);
	});
	return [...automatic(ctx), ...results];
}

