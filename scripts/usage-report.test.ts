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
	m1: string;
	m2: string;
	m3: { ok: number; wrong: number; missing: number; unknownRepo: number };
	m5?: { endsOpen?: boolean; lag?: number; todoOnlyTurns: number };
};
type Result = {
	stdout: string;
	code: number;
	json: { rows: Row[]; coverage: { badLines: number; skipped: Record<string, number>; read: { main: number; subagents: number } } };
	row: (file: string) => Row;
};

const NOTE = (name: string, description: string) => `---\nname: ${name}\ndescription: ${description}\n---\nbody of ${name}\n`;
const INDEX = [
	"- [Global note](global-note.md) — cross-project fact",
	"",
	"## proj",
	"- [Proj note](proj-note.md) — fact about the proj repo",
	"",
	"## other",
	"- [Other note](other-note.md) — fact about another repo",
	"",
].join("\n");

/** A private HOME, a git checkout whose origin names the repo `proj`, and a vault with notes in three sections. */
function world() {
	const root = mkdtempSync(join(tmpdir(), "usage-report-"));
	roots.push(root);
	const home = join(root, "home");
	const repo = join(root, "checkout");
	const vault = join(root, "KnowledgeBase");
	const sessions = join(root, "sessions");
	for (const dir of [home, repo, join(vault, "_memory"), sessions]) mkdirSync(dir, { recursive: true });
	execFileSync("git", ["init", "--quiet"], { cwd: repo });
	execFileSync("git", ["remote", "add", "origin", "https://example.com/acme/proj.git"], { cwd: repo });
	writeFileSync(join(vault, "_memory", "MEMORY.md"), INDEX);
	writeFileSync(join(vault, "_memory", "global-note.md"), NOTE("global-note", "cross project fact about caching"));
	writeFileSync(join(vault, "_memory", "proj-note.md"), NOTE("proj-note", "fact about the proj repo build"));
	writeFileSync(join(vault, "_memory", "other-note.md"), NOTE("other-note", "fact about another repo deploys"));

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
	const recall: [string, Rec] = ["write", { path: "xd://kb_recall", content: JSON.stringify({ query: "build" }) }];
	const remember = (slug: string): [string, Rec] => ["write", { path: "xd://kb_remember", content: JSON.stringify({ mode: "create", slug, body: SENTINEL }) }];
	const edit = (file = "src/app.ts"): [string, Rec] => ["write", { path: join(repo, file), content: SENTINEL }];
	const read = (path: string): [string, Rec] => ["read", { path }];

	const write = (name: string, lines: (Rec | string)[]) => {
		const file = join(sessions, "-proj", name);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, `${lines.map(l => (typeof l === "string" ? l : JSON.stringify(l))).join("\n")}\n`);
	};

	function run(extra: string[] = []): Result {
		const child = Bun.spawnSync({
			cmd: ["bun", SCRIPT, "--sessions", sessions, "--vault", vault, "--json", join(root, "out", "report.json"), ...extra],
			env: { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config") },
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = child.stdout.toString();
		let json: Result["json"] = { rows: [], coverage: { badLines: 0, skipped: {}, read: { main: 0, subagents: 0 } } };
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
		return { stdout, code: child.exitCode, json, row };
	}

	return { sessions, root, session, turn, todoResult, bash, recall, remember, edit, read, write, run, repo, vault };
}

test("a recall before the first edit passes M1; an edit before any recall fails it", () => {
	const w = world();
	w.write("recalled.jsonl", [w.session(), w.turn(w.recall), w.turn(w.edit())]);
	w.write("blind.jsonl", [w.session(), w.turn(w.edit()), w.turn(w.recall)]);
	const hashline: [string, Rec] = ["edit", { input: `[${join(w.repo, "src/b.ts")}#1A2B]\nPUT 1:\n+${SENTINEL}\n` }];
	w.write("blind-hashline.jsonl", [w.session(), w.turn(hashline)]);
	const result = w.run();
	expect(result.row("recalled.jsonl").m1).toBe("pass");
	expect(result.row("blind.jsonl").m1).toBe("fail");
	expect(result.row("blind-hashline.jsonl").m1).toBe("fail");
	expect(result.row("recalled.jsonl").repo).toBe("proj");
});

test("reading the MEMORY.md index alone does not satisfy M1, reading a note does", () => {
	const w = world();
	const memory = (file: string) => join(w.vault, "_memory", file);
	w.write("index-only.jsonl", [w.session(), w.turn(w.read(memory("MEMORY.md"))), w.turn(w.edit())]);
	w.write("note.jsonl", [w.session(), w.turn(w.read(`${memory("proj-note.md")}:1-40`)), w.turn(w.edit())]);
	const result = w.run();
	expect(result.row("index-only.jsonl").m1).toBe("fail");
	expect(result.row("note.jsonl").m1).toBe("pass");
});

test("git commit without a save fails M2; [skip-mem] is its own bucket; a save first passes", () => {
	const w = world();
	w.write("unsaved.jsonl", [w.session(), w.turn(w.bash('git commit -m "feat: x"'))]);
	w.write("skipped.jsonl", [w.session(), w.turn(w.bash('git -C /tmp/x commit -m "chore: y [skip-mem]"'))]);
	w.write("saved.jsonl", [w.session(), w.turn(w.remember("proj-note")), w.turn(w.bash('git commit -m "feat: z"'))]);
	w.write("no-commit.jsonl", [w.session(), w.turn(w.bash("git log --oneline"))]);
	const result = w.run();
	expect(result.row("unsaved.jsonl").m2).toBe("fail");
	expect(result.row("skipped.jsonl").m2).toBe("skip-mem");
	expect(result.row("saved.jsonl").m2).toBe("pass");
	expect(result.row("no-commit.jsonl").m2).toBe("n/a");
});

test("a note saved under another repo's MEMORY.md section fails M3", () => {
	const w = world();
	w.write("scoped.jsonl", [w.session(), w.turn(w.remember("proj-note"), w.remember("global-note"), w.remember("other-note"), w.remember("ghost-note"))]);
	const m3 = w.run().row("scoped.jsonl").m3;
	expect(m3).toEqual({ ok: 2, wrong: 1, missing: 1, unknownRepo: 0 });
});

test("a session ending with an in-progress todo item fails M5a and the lag matches the fixture", () => {
	const w = world();
	w.write("open.jsonl", [
		w.session(),
		w.turn(["todo", { op: "init" }]),
		w.todoResult("init", ["in_progress", "pending"]),
		w.turn(w.bash("bun test")),
		w.turn(w.edit(), w.bash("bun run typecheck")),
		w.turn(w.recall),
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

test("a malformed line and a version-2 header are counted as skipped without stopping the run", () => {
	const w = world();
	w.write("good.jsonl", [w.session(), w.turn(w.recall), "{ this is not json", w.turn(w.edit())]);
	w.write("old.jsonl", [w.session(2), w.turn(w.edit())]);
	w.write("headerless.jsonl", [{ type: "title", v: 1 }, w.turn(w.edit())]);
	const result = w.run();
	expect(result.code).toBe(0);
	expect(result.json.coverage.badLines).toBe(1);
	expect(Object.values(result.json.coverage.skipped).reduce((a, b) => a + b, 0)).toBe(2);
	expect(result.json.rows.map(r => r.file)).toEqual([join("-proj", "good.jsonl")]);
	expect(result.row("good.jsonl").m1).toBe("pass");
});

test("subagent transcripts are counted apart from main sessions", () => {
	const w = world();
	w.write("main.jsonl", [w.session(), w.turn(w.recall), w.turn(w.edit())]);
	w.write(join("main", "Worker.jsonl"), [w.session(), w.turn(w.edit())]);
	const result = w.run();
	expect(result.json.coverage.read).toEqual({ main: 1, subagents: 1 });
	const nested = result.json.rows.find(r => r.file.endsWith("Worker.jsonl"));
	expect(nested?.nested).toBe(true);
	expect(nested?.m1).toBe("fail");
	expect(result.row("main.jsonl").nested).toBe(false);
});

test("an empty sessions folder exits 0 and says there are no sessions", () => {
	const w = world();
	const result = w.run();
	expect(result.code).toBe(0);
	expect(result.stdout).toMatch(/no sessions/i);
});

test("the report never contains text, arguments, commands or file contents from the transcripts", () => {
	const w = world();
	w.write("secret.jsonl", [
		w.session(),
		w.turn(w.recall, ["bash", { command: `echo ${SENTINEL}` }]),
		w.turn(w.remember("proj-note"), w.edit(), ["edit", { input: `[${join(w.repo, "src/c.ts")}#1A2B]\nPUT 1:\n+${SENTINEL}\n` }]),
		w.turn(w.bash(`git commit -m "${SENTINEL} [skip-mem]"`), ["todo", { op: "init", items: [SENTINEL] }]),
		{ type: "message", timestamp: "2026-11-01T11:00:00Z", message: { role: "user", content: [{ type: "text", text: SENTINEL }] } },
		w.todoResult("init", ["pending"]),
	]);
	const result = w.run();
	expect(result.json.rows).toHaveLength(1);
	expect(result.stdout).not.toContain(SENTINEL);
	expect(readFileSync(join(w.root, "out", "report.json"), "utf8")).not.toContain(SENTINEL);
});
