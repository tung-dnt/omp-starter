// Replays real tasks with and without the lead harness, to decide with numbers whether it earns its keep.
//
//   bun scripts/lead-replay.ts <tasks.yml> [--runs 3] [--out <file.md>] [--yes]
//
// tasks.yml:
//   variants:              # optional; this is the default
//     with: { env: {}, args: [] }
//     without: { env: { OMP_STARTER_LEAD: "off" }, args: [] }
//   tasks:
//     - id: race-bug
//       repo: ~/projects/example
//       base: "<commit sha>"              # quote it: an all-digit sha would be read as a number
//       prompt: "…"
//       check: "bun test src/x.test.ts"   # exit 0 = correct
//       timeout_min: 30                   # default 30
//
// Each run happens in a fresh detached worktree at `base`. Every task × variant × run spends model quota, so nothing
// runs without --yes. Hard-gate stops are counted through OMP_STARTER_LEAD_REPLAY_LOG: a gate with nobody to ask
// is approved and logged instead of blocking, so runs finish unattended. Exit codes: 0 ok; 2 usage or invalid file.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

interface Variant {
	env: Record<string, string>;
	args: string[];
}

interface Task {
	id: string;
	repo: string;
	base: string;
	prompt: string;
	check: string;
	timeoutMin: number;
}

interface RunResult {
	pass: boolean;
	wallMin: number;
	gates: number;
}

class UsageError extends Error {}

const DEFAULT_VARIANTS: Record<string, Variant> = {
	with: { env: {}, args: [] },
	without: { env: { OMP_STARTER_LEAD: "off" }, args: [] },
};

function git(repo: string, args: string[]): { code: number; stderr: string } {
	const run = Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "ignore", stderr: "pipe" });
	return { code: run.exitCode ?? 1, stderr: run.stderr.toString().trim() };
}

function expandHome(p: string): string {
	return p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p;
}

function parse(file: string): { tasks: Task[]; variants: Record<string, Variant> } {
	let doc: { variants?: Record<string, Partial<Variant>>; tasks?: Record<string, unknown>[] } | null;
	try {
		doc = Bun.YAML.parse(fs.readFileSync(file, "utf8")) as typeof doc;
	} catch (error) {
		throw new UsageError(`lead-replay: cannot read ${file}: ${(error as Error).message}`);
	}
	const problems: string[] = [];
	const tasks = (doc?.tasks ?? []).map((raw, i): Task => {
		const where = `tasks[${i}]${typeof raw.id === "string" ? ` (${raw.id})` : ""}`;
		for (const field of ["id", "repo", "base", "prompt", "check"]) {
			if (typeof raw[field] !== "string" || !raw[field]) {
				problems.push(`${where}: ${field} is required${typeof raw[field] === "number" ? " as a quoted string (YAML read it as a number)" : ""}`);
			}
		}
		const repo = expandHome(String(raw.repo ?? ""));
		if (raw.repo && !fs.existsSync(path.join(repo, ".git"))) problems.push(`${where}: repo ${repo} is not a git directory`);
		else if (raw.base && git(repo, ["cat-file", "-e", `${String(raw.base)}^{commit}`]).code !== 0) problems.push(`${where}: base ${String(raw.base)} is not a commit of ${repo}`);
		return { id: String(raw.id), repo, base: String(raw.base), prompt: String(raw.prompt), check: String(raw.check), timeoutMin: Number(raw.timeout_min ?? 30) };
	});
	if (!tasks.length) problems.push("tasks: at least one task is required");
	if (problems.length) throw new UsageError(`lead-replay: ${file} is invalid:\n- ${problems.join("\n- ")}`);
	const variants = Object.fromEntries(
		Object.entries(doc?.variants ?? DEFAULT_VARIANTS).map(([name, v]) => [name, { env: v.env ?? {}, args: v.args ?? [] }]),
	);
	return { tasks, variants };
}

const median = (values: number[]): number => {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

async function runOnce(task: Task, name: string, variant: Variant, n: number): Promise<RunResult> {
	const worktree = path.join(os.tmpdir(), `lead-replay-${task.id}-${name}-${n}`);
	const log = `${worktree}.gates.jsonl`;
	const added = git(task.repo, ["worktree", "add", "--detach", worktree, task.base]);
	if (added.code !== 0) throw new Error(`git worktree add failed: ${added.stderr}`);
	try {
		const started = Date.now();
		const omp = Bun.spawn(["omp", "-p", "--no-session", "--cwd", worktree, ...variant.args, task.prompt], {
			env: { ...process.env, ...variant.env, OMP_STARTER_LEAD_REPLAY_LOG: log },
			stdout: "ignore",
			stderr: "ignore",
		});
		const timer = setTimeout(() => omp.kill(), task.timeoutMin * 60_000);
		await omp.exited;
		clearTimeout(timer);
		const wallMin = (Date.now() - started) / 60_000;
		const check = Bun.spawnSync(["sh", "-c", task.check], { cwd: worktree, stdout: "ignore", stderr: "ignore" });
		const gates = fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean).length : 0;
		return { pass: check.exitCode === 0, wallMin, gates };
	} finally {
		git(task.repo, ["worktree", "remove", "--force", worktree]);
		fs.rmSync(log, { force: true });
	}
}

async function main(args: string[]): Promise<number> {
	const file = args.find(a => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--runs" && args[args.indexOf(a) - 1] !== "--out");
	if (!file) throw new UsageError("lead-replay: usage: lead-replay.ts <tasks.yml> [--runs 3] [--out <file.md>] [--yes]");
	const runsAt = args.indexOf("--runs");
	const runs = runsAt >= 0 ? Number(args[runsAt + 1]) : 3;
	if (!Number.isInteger(runs) || runs < 1) throw new UsageError("lead-replay: --runs needs a whole number of 1 or more");
	const outAt = args.indexOf("--out");
	const { tasks, variants } = parse(path.resolve(file));
	const names = Object.keys(variants);
	const total = tasks.length * names.length * runs;
	if (!args.includes("--yes")) {
		console.log(`lead-replay: ${tasks.length} tasks × ${names.length} variants × ${runs} runs = ${total} omp runs (each spends model quota). Rerun with --yes.`);
		return 0;
	}
	const rows = ["| task | variant | pass | median wall (min) | median gate stops |", "|---|---|---|---|---|"];
	for (const task of tasks) {
		for (const name of names) {
			const results: RunResult[] = [];
			for (let n = 1; n <= runs; n++) results.push(await runOnce(task, name, variants[name], n));
			const passed = results.filter(r => r.pass).length;
			rows.push(`| ${task.id} | ${name} | ${passed}/${runs} | ${median(results.map(r => r.wallMin)).toFixed(1)} | ${median(results.map(r => r.gates))} |`);
		}
	}
	const table = `${rows.join("\n")}\n`;
	console.log(table);
	if (outAt >= 0) fs.writeFileSync(path.resolve(args[outAt + 1]), table);
	return 0;
}

try {
	process.exit(await main(process.argv.slice(2)));
} catch (error) {
	if (!(error instanceof UsageError)) throw error;
	console.error(error.message);
	process.exit(2);
}
