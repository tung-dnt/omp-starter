import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanScratch, git, initRepo } from "./spec-fixtures";
import type { RunLogEntry } from "./spec-runlog";
import { type OpenedScript, ScriptError, parseSlotScript, scriptedSdk } from "./spec-scripted-slots";
import { type SlotModel, createSlotRunner } from "./spec-slot-runner";
import { SLOTS, type SlotSpec, parseVerdict } from "./spec-slots";

afterEach(cleanScratch);

const MODEL = { id: "fake-model" } as unknown as SlotModel;
const SHA = "ab".repeat(32);
const PASS = { verdict: "pass", notes: "done", checks_run: [] };

/** A real runner over the scripted SDK, as the extension builds it, and the log the seam writes. */
function harness(text: string) {
	const opened: OpenedScript = { file: "/outside/slots.yml", sha256: SHA, script: parseSlotScript(text) };
	const log: RunLogEntry[] = [];
	let discovered = 0;
	const real = {
		createAgentSession: async () => {
			throw new Error("the real SDK must not create a session");
		},
		discoverAgents: async () => {
			discovered++;
			return [{ name: "task-builder", systemPrompt: "B" }];
		},
	};
	const scripted = scriptedSdk(opened, real, { append: entry => void log.push(entry) }, () => new Date("2026-11-05T00:00:00Z"));
	const runner = createSlotRunner({ sdk: scripted.sdk, agents: [{ name: "task-builder", systemPrompt: "BUILDER" }], resolveModel: () => MODEL });
	return { scripted, runner, log, discovered: () => discovered };
}

const spec = (cwd: string, over: Partial<SlotSpec> = {}): SlotSpec => ({
	slot: "implementer", task: { id: "T1", repo: "org/backend" }, story: "S-1", cwd, prompt: "do the task", writeScope: ["src/ok.ts", "out.txt"], lockedFiles: ["t/locked.sh"],
	schema: SLOTS.implementer.schema, modelRole: "task", thinkingLevel: "medium", agent: "task-builder", maxContextTokens: 1000, ...over,
});
const signal = (): AbortSignal => new AbortController().signal;
const events = (log: RunLogEntry[], name: string) => log.filter(entry => entry.kind === "event" && entry.event === name);

describe("the scripted SDK under the real slot runner", () => {
	test("rules match by task, slot and attempt, first unconsumed first", async () => {
		const h = harness(`
version: 1
slots:
  - match: {task: T1, slot: implementer, attempt: 2}
    steps: [{yield: {verdict: pass, notes: second, checks_run: []}}]
  - match: {task: "*", slot: implementer, attempt: "*"}
    steps: [{yield: {verdict: pass, notes: any, checks_run: []}}]
  - match: {task: T1, slot: implementer, attempt: 1}
    steps: [{yield: {verdict: pass, notes: never, checks_run: []}}]
`);
		const cwd = "/nowhere";
		const first = await h.runner.run(spec(cwd), signal());
		const second = await h.runner.run(spec(cwd), signal());
		expect([(first.payload as { notes: string }).notes, (second.payload as { notes: string }).notes]).toEqual(["any", "second"]);
		// Attempt 3 of T1: rule 0 and rule 1 are consumed and rule 2 wants attempt 1, so nothing fits.
		await expect(h.runner.run(spec(cwd), signal())).rejects.toThrow("no scripted slot for T1 implementer #3");
		// Another task has its own attempt count, but every rule it fits is consumed or names T1.
		await expect(h.runner.run(spec(cwd, { task: { id: "T2", repo: "org/backend" } }), signal())).rejects.toThrow("no scripted slot for T2 implementer #1");

		expect([first.sessionFile, second.sessionFile]).toEqual([`scripted:${SHA.slice(0, 12)}#1`, `scripted:${SHA.slice(0, 12)}#0`]);
		const sessions = events(h.log, "scripted-session");
		expect(sessions).toHaveLength(2);
		const detail = JSON.parse((sessions[0] as { detail: string }).detail);
		expect(sessions[0]).toMatchObject({ task: "T1" });
		expect(detail).toMatchObject({
			slot: "implementer", attempt: 1, rule: 1, thinkingLevel: "medium", outputSchemaMode: "strict", title: "spec:S-1:T1:implementer",
			toolNames: ["read", "glob", "ast_grep", "lsp", "edit", "write", "bash"],
		});
		expect(detail.agentId).toMatch(/^spec-S-1-T1-implementer-\d+$/);
		// The rest of the options the real runner passed: restricted, yield required, no process state, no UI, no MCP, the guard preloaded, no extensions.
		expect(detail).toMatchObject({ restrictToolNames: true, requireYieldTool: true, bindProcessState: false, hasUI: false, enableMCP: false, guardHandlers: 1, extensions: false });
		// The prompt the runner handed the session, so a run can show what the next prompt carried.
		expect(detail.prompt).toBe("do the task");
		expect(h.discovered()).toBe(0);
	});

	test("a tool step goes through the real worker guard", async () => {
		const repo = initRepo();
		const h = harness(`
version: 1
slots:
  - match: {task: T1, slot: implementer}
    steps:
      - tool: {name: write, input: {path: src/ok.ts, content: "ok\\n"}}
      - tool: {name: write, input: {path: src/other.ts, content: "x\\n"}}
      - tool: {name: write, input: {path: t/locked.sh, content: "x\\n"}}
      - tool: {name: edit, input: {path: src/a.ts, input: "x"}}
      - tool: {name: read, input: {path: src/ok.ts}}
      - yield: {verdict: pass, notes: done, checks_run: []}
`);
		const result = await h.runner.run(spec(repo), signal());
		expect(result.payload).toEqual(PASS);
		expect(readFileSync(join(repo, "src/ok.ts"), "utf8")).toBe("ok\n");
		expect(existsSync(join(repo, "src/other.ts"))).toBe(false);
		expect(existsSync(join(repo, "t/locked.sh"))).toBe(false);
		expect(h.scripted.trace.map(entry => [entry.tool, entry.blocked === undefined ? "ran" : "blocked"])).toEqual([
			["write", "ran"], ["write", "blocked"], ["write", "blocked"], ["edit", "blocked"], ["read", "ran"],
		]);
		expect(h.scripted.trace[1].blocked).toContain("outside this task's write scope");
		expect(h.scripted.trace[2].blocked).toContain("is a locked test");
		// An edit that the guard allows is judged, not applied.
		expect(readFileSync(join(repo, "src/a.ts"), "utf8")).toBe("export const a = 1;\n");
	});

	test("bash steps run in the worktree: git commit is blocked, a redirect is not", async () => {
		const repo = initRepo();
		const before = git(repo, "rev-parse", "HEAD");
		const h = harness(`
version: 1
slots:
  - match: {task: T1, slot: implementer}
    steps:
      - tool: {name: bash, input: {command: "git commit --allow-empty -m x"}}
      - tool: {name: bash, input: {command: "sh -c 'git commit --allow-empty -m y'"}}
      - tool: {name: bash, input: {command: "pwd > out.txt"}}
      - yield: {verdict: pass, notes: done, checks_run: []}
`);
		await h.runner.run(spec(repo), signal());
		expect(git(repo, "rev-parse", "HEAD")).toBe(before);
		expect(h.scripted.trace.map(entry => entry.blocked?.includes("git commit is blocked") === true)).toEqual([true, true, false]);
		expect(readFileSync(join(repo, "out.txt"), "utf8").trim()).toBe(repo);
	});

	test("usage past the ceiling aborts through the real runner", async () => {
		const h = harness(`
version: 1
slots:
  - match: {task: T1, slot: implementer}
    steps:
      - usage: {costUsd: 0.02, contextTokens: 400}
      - usage: {costUsd: 0.03, contextTokens: 5000}
      - yield: {verdict: pass, notes: late, checks_run: []}
`);
		const result = await h.runner.run(spec("/nowhere"), signal());
		expect(result).toMatchObject({ aborted: "context", costUsd: 0.05, contextTokens: 5000 });
		expect(result.payload).toBeUndefined();
	});

	test("sleep ends when the runner aborts the session", async () => {
		const h = harness(`
version: 1
slots:
  - match: {task: T1, slot: implementer}
    steps:
      - sleep: 60000
      - yield: {verdict: pass, notes: late, checks_run: []}
`);
		const controller = new AbortController();
		const started = Date.now();
		const running = h.runner.run(spec("/nowhere"), controller.signal);
		// A real timer on purpose: the run is parked in the script's 60 s sleep, and only the abort may end it.
		setTimeout(() => controller.abort(), 30);
		const result = await running;
		expect(result.aborted).toBe("signal");
		expect(result.payload).toBeUndefined();
		expect(Date.now() - started).toBeLessThan(5000);
	});

	test("a yield may be an object or a string", async () => {
		const h = harness(`
version: 1
slots:
  - match: {task: T1, slot: implementer, attempt: 1}
    steps: [{yield: {verdict: pass, notes: object, checks_run: []}}]
  - match: {task: T1, slot: implementer, attempt: 2}
    steps: [{yield: '{"verdict": "pass", "notes": "string", "checks_run": []}'}]
  - match: {task: T1, slot: implementer, attempt: 3}
    steps: [{yield_error: "schema mismatch"}]
  - match: {task: T1, slot: implementer, attempt: 4}
    steps: [{throw: "the environment broke"}]
  - match: {task: T1, slot: implementer, attempt: 5}
    steps: []
`);
		const object = await h.runner.run(spec("/nowhere"), signal());
		const string = await h.runner.run(spec("/nowhere"), signal());
		expect(typeof object.payload).toBe("object");
		expect(typeof string.payload).toBe("string");
		expect(parseVerdict("implementer", object.payload)).toMatchObject({ ok: true, value: { notes: "object" } });
		expect(parseVerdict("implementer", string.payload)).toMatchObject({ ok: true, value: { notes: "string" } });
		expect(await h.runner.run(spec("/nowhere"), signal())).toMatchObject({ payload: undefined, error: "schema mismatch" });
		await expect(h.runner.run(spec("/nowhere"), signal())).rejects.toThrow("the environment broke");
		// No yield at all: the run ends with no payload, which the scheduler counts as an invalid attempt.
		expect((await h.runner.run(spec("/nowhere"), signal())).payload).toBeUndefined();
	});

	test("a session with no rule rejects the prompt", async () => {
		const h = harness("version: 1\nslots: []\n");
		await expect(h.runner.run(spec("/nowhere"), signal())).rejects.toThrow("no scripted slot for T1 implementer #1");
		expect(events(h.log, "scripted-session")).toEqual([]);
	});

	test("unused rules are reported", async () => {
		const h = harness(`
version: 1
slots:
  - match: {task: T1, slot: implementer}
    steps: [{yield: {verdict: pass, notes: ok, checks_run: []}}]
  - match: {task: T9, slot: code_review, attempt: 2}
    steps: []
`);
		await h.runner.run(spec("/nowhere"), signal());
		expect(h.scripted.unused()).toEqual([1]);
		h.scripted.finish();
		expect(events(h.log, "scripted-slots-unused")).toEqual([
			{ kind: "event", at: "2026-11-05T00:00:00.000Z", event: "scripted-slots-unused", detail: '#1 {"task":"T9","slot":"code_review","attempt":2}' },
		]);

		const used = harness("version: 1\nslots:\n  - {match: {task: T1, slot: implementer}, steps: [{yield: {verdict: pass, notes: ok, checks_run: []}}]}\n");
		await used.runner.run(spec("/nowhere"), signal());
		used.scripted.finish();
		expect(events(used.log, "scripted-slots-unused")).toEqual([]);
	});
});

describe("the script format", () => {
	test("a script that does not follow the format is refused with the first problem", () => {
		const bad: Array<[string, string]> = [
			["slots: []", "version must be 1"],
			["version: 1\nslots: nope", "slots must be a list"],
			["version: 1\nslots: [{steps: []}]", "match mapping"],
			["version: 1\nslots: [{match: {task: T1, slot: wizard}, steps: []}]", "match.slot must be one of"],
			["version: 1\nslots: [{match: {task: T1, slot: implementer, attempt: 0}, steps: []}]", "attempt"],
			["version: 1\nslots: [{match: {task: T1, slot: implementer}, steps: [{sleep: -1}]}]", "sleep"],
			["version: 1\nslots: [{match: {task: T1, slot: implementer}, steps: [{teleport: 1}]}]", 'unknown step "teleport"'],
			["version: 1\nslots: [{match: {task: T1, slot: implementer}, steps: [{sleep: 1, yield: 1}]}]", "exactly one of"],
			["{ not yaml", "not valid YAML"],
		];
		for (const [text, message] of bad) expect(() => parseSlotScript(text)).toThrow(message);
		expect(() => parseSlotScript("slots: []")).toThrow(ScriptError);
	});
});
