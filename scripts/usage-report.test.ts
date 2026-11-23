import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const SCRIPT = resolve(import.meta.dir, "usage-report.ts");
const SENTINEL = "SENTINEL-4f9c1d-never-printed";
const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type Rec = Record<string, unknown>;
type Row = {
	file: string;
	repo?: string;
	nested: boolean;
	calls: number;
	m5?: { endsOpen?: boolean; lag?: number; todoOnlyTurns: number };
};
type Group = {
	sessions: number;
	m5: { sessions: number; endedClean: number; endedOpen: number };
	m6: { todo: { calls: number; sessions: number } };
};
type Result = {
	stdout: string;
	stderr: string;
	code: number;
	json: { rows: Row[]; main: Group; subagents: Group; coverage: { badLines: number; skipped: Record<string, number>; read: { main: number; subagents: number } } };
	row: (file: string) => Row;
};

/** A private HOME, a git checkout whose origin names the repo `proj`, and an empty sessions folder. */
function world() {
	const root = mkdtempSync(join(tmpdir(), "usage-report-"));
	roots.push(root);
	const home = join(root, "home");
	const repo = join(root, "checkout");
	const sessions = join(root, "sessions");
	for (const dir of [home, repo, sessions]) mkdirSync(dir, { recursive: true });
	execFileSync("git", ["init", "--quiet"], { cwd: repo });
	execFileSync("git", ["remote", "add", "origin", "https://example.com/acme/proj.git"], { cwd: repo });

	let tick = Date.parse("2026-11-01T10:00:00Z");
	const stamp = () => new Date((tick += 1000)).toISOString();
	const session = (version = 3): Rec => ({ type: "session", version, id: "s", timestamp: stamp(), cwd: repo });
	const turn = (...calls: [name: string, args: Rec][]): Rec => ({
		type: "message",
		timestamp: stamp(),
		message: {
			role: "assistant",
			content: [
				{ type: "text", text: `${SENTINEL} thinking out loud` },
				...calls.map(([name, args], i) => ({ type: "toolCall", id: `c${i}`, name, arguments: args })),
			],
		},
	});
	const todoResult = (op: string, statuses: string[]): Rec => ({
		type: "message",
		timestamp: stamp(),
		message: { role: "toolResult", toolName: "todo", details: { op, phases: [{ name: "Work", tasks: statuses.map(status => ({ content: "task", status })) }] } },
	});
	const bash = (command: string): [string, Rec] => ["bash", { command }];
	/** A discoverable tool called through `write xd://<tool>`, the way the model calls `recall` or `retain`. */
	const device = (tool: string, args: Rec): [string, Rec] => ["write", { path: `xd://${tool}`, content: JSON.stringify(args) }];
	const edit = (file = "src/app.ts"): [string, Rec] => ["write", { path: join(repo, file), content: SENTINEL }];

	const write = (name: string, lines: (Rec | string)[]) => {
		const file = join(sessions, "-proj", name);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, `${lines.map(l => (typeof l === "string" ? l : JSON.stringify(l))).join("\n")}\n`);
	};

	function run(extra: string[] = []): Result {
		const child = Bun.spawnSync({
			cmd: ["bun", SCRIPT, "--sessions", sessions, "--json", join(root, "out", "report.json"), ...extra],
			env: { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config") },
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = child.stdout.toString();
		const empty: Group = { sessions: 0, m5: { sessions: 0, endedClean: 0, endedOpen: 0 }, m6: { todo: { calls: 0, sessions: 0 } } };
		let json: Result["json"] = { rows: [], main: empty, subagents: empty, coverage: { badLines: 0, skipped: {}, read: { main: 0, subagents: 0 } } };
		try {
			json = JSON.parse(readFileSync(join(root, "out", "report.json"), "utf8"));
		} catch {
			// no JSON written (empty sessions dir or a rejected run)
		}
		const row = (file: string) => {
			const found = json.rows.find(r => r.file === join("-proj", file));
			if (!found) throw new Error(`no row for ${file}; stderr: ${child.stderr.toString()}`);
			return found;
		};
		return { stdout, stderr: child.stderr.toString(), code: child.exitCode, json, row };
	}

	return { sessions, root, session, turn, todoResult, bash, device, edit, write, run, repo };
}

test("a session ending with an in-progress todo item fails M5a and the lag matches the fixture", () => {
	const w = world();
	w.write("open.jsonl", [
		w.session(),
		w.turn(["todo", { op: "init" }]),
		w.todoResult("init", ["in_progress", "pending"]),
		w.turn(w.bash("bun test")),
		w.turn(w.edit(), w.bash("bun run typecheck")),
		// A device call is not an edit: it does not count toward the lag.
		w.turn(w.device("recall", { query: "build" })),
	]);
	w.write("clean.jsonl", [
		w.session(),
		w.turn(["todo", { op: "init" }]),
		w.todoResult("init", ["in_progress"]),
		w.turn(w.bash("bun test")),
		w.turn(["todo", { op: "done" }]),
		w.todoResult("done", ["completed"]),
	]);
	const result = w.run();
	expect(result.row("open.jsonl").m5).toEqual({ endsOpen: true, lag: 3, todoOnlyTurns: 1 });
	expect(result.row("clean.jsonl").m5).toEqual({ endsOpen: false, lag: 0, todoOnlyTurns: 2 });
});

test("a session that never calls todo has no todo row, and its calls are counted", () => {
	const w = world();
	w.write("plain.jsonl", [w.session(), w.turn(["read", { path: "src/app.ts" }]), w.turn(w.edit(), w.bash("bun test"))]);
	const row = w.run().row("plain.jsonl");
	expect(row.m5).toBeUndefined();
	expect(row.calls).toBe(3);
});

test("a session's repo name comes from the origin URL of its working folder", () => {
	const w = world();
	w.write("repo.jsonl", [w.session(), w.turn(w.edit())]);
	expect(w.run().row("repo.jsonl").repo).toBe("proj");
});

test("a malformed line and a version-2 header are counted as skipped without stopping the run", () => {
	const w = world();
	w.write("good.jsonl", [w.session(), w.turn(["read", { path: "src/app.ts" }]), "{ this is not json", w.turn(w.edit())]);
	w.write("old.jsonl", [w.session(2), w.turn(w.edit())]);
	w.write("headerless.jsonl", [{ type: "title", v: 1 }, w.turn(w.edit())]);
	const result = w.run();
	expect(result.code).toBe(0);
	expect(result.json.coverage.badLines).toBe(1);
	expect(Object.values(result.json.coverage.skipped).reduce((a, b) => a + b, 0)).toBe(2);
	expect(result.json.rows.map(r => r.file)).toEqual([join("-proj", "good.jsonl")]);
	expect(result.row("good.jsonl").calls).toBe(2);
});

test("subagent transcripts are counted apart from main sessions", () => {
	const w = world();
	w.write("main.jsonl", [w.session(), w.turn(["todo", { op: "init" }]), w.todoResult("init", ["completed"]), w.turn(w.edit())]);
	w.write(join("main", "Worker.jsonl"), [w.session(), w.turn(w.edit())]);
	const result = w.run();
	expect(result.json.coverage.read).toEqual({ main: 1, subagents: 1 });
	expect(result.json.rows.find(r => r.file.endsWith("Worker.jsonl"))?.nested).toBe(true);
	expect(result.row("main.jsonl").nested).toBe(false);
	expect(result.json.main).toMatchObject({ sessions: 1, m5: { sessions: 1, endedClean: 1 }, m6: { todo: { calls: 1, sessions: 1 } } });
	expect(result.json.subagents).toMatchObject({ sessions: 1, m5: { sessions: 0 }, m6: { todo: { calls: 0, sessions: 0 } } });
});

test("an empty sessions folder exits 0 and says there are no sessions", () => {
	const w = world();
	const result = w.run();
	expect(result.code).toBe(0);
	expect(result.stdout).toMatch(/no sessions/i);
});

test("--vault is refused: the report no longer reads a vault", () => {
	const w = world();
	const result = w.run(["--vault", join(w.root, "KnowledgeBase")]);
	expect(result.code).toBe(2);
	expect(result.stderr).toContain('Unknown argument "--vault"');
});

test("the report never contains text, arguments, commands or file contents from the transcripts", () => {
	const w = world();
	w.write("secret.jsonl", [
		w.session(),
		w.turn(w.device("recall", { query: SENTINEL }), ["bash", { command: `echo ${SENTINEL}` }]),
		w.turn(w.device("retain", { items: [{ content: SENTINEL }] }), w.edit(), ["edit", { input: `[${join(w.repo, "src/c.ts")}#1A2B]\nPUT 1:\n+${SENTINEL}\n` }]),
		w.turn(w.bash(`git commit -m "${SENTINEL} [skip-mem]"`), ["todo", { op: "init", items: [SENTINEL] }]),
		{ type: "message", timestamp: "2026-11-01T11:00:00Z", message: { role: "user", content: [{ type: "text", text: SENTINEL }] } },
		w.todoResult("init", ["pending"]),
	]);
	const result = w.run();
	expect(result.json.rows).toHaveLength(1);
	expect(result.stdout).not.toContain(SENTINEL);
	expect(readFileSync(join(w.root, "out", "report.json"), "utf8")).not.toContain(SENTINEL);
});
