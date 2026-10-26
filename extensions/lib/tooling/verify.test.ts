import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { inspectConfig } from "./config";
import type { FixtureCase, IntegrationKind, LanguagePlan, ReusePlan, ToolStatus } from "./types";
import { REQUIRED_VARIANTS, type VerifyContext, verifyLanguage } from "./verify";
import { type Clock, locationsFromText, observeBreakpoint, observeDefinition, parseObservation, type PhaseContext, type ToolLike } from "./verifier-extension";

// ── Harness ─────────────────────────────────────────────────────────────────────────────────────
//
// `verifyLanguage` runs for real: the real runtime, real private directories, real settings files and a real
// omp-shaped child process. Only the omp executable is replaced by a small program that speaks omp's RPC
// protocol and answers what the isolated omp would. It derives its answers from what it is given (its flags,
// its environment, the case file the verifier wrote), so a verifier that forgot an isolation flag, leaked
// the environment or judged carelessly fails here. Whether the real SDK tools work is the real-smoke proof.

const cleanups: (() => Promise<unknown> | unknown)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface Box {
	root: string;
	project: string;
	home: string;
	agentDir: string;
	bin: string;
	tools: string;
	/** Base for the verifier's private trees, so a leftover directory is observable. */
	temp: string;
}

function box(): Box {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "omp-verify-test-")));
	cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
	const b: Box = {
		root,
		project: path.join(root, "project"),
		home: path.join(root, "home"),
		agentDir: path.join(root, "home", ".omp", "agent"),
		bin: path.join(root, "bin"),
		tools: path.join(root, "tools"),
		temp: path.join(root, "temp"),
	};
	for (const dir of [b.project, b.agentDir, b.bin, b.tools, b.temp]) fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(b.project, "package.json"), "{}\n");
	return b;
}

function script(file: string, body: string): string {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
	return file;
}

/**
 * Polls state that real child processes set (their pid files, their exit). There is no promise or event to
 * await for a grandchild's start or death, and the behaviour under test is itself wall-clock bound (kill
 * grace, timeouts), so fake timers cannot drive it. Used only to wait for that readiness.
 */
async function eventually(check: () => boolean, ms = 8000): Promise<boolean> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (check()) return true;
		await Bun.sleep(25);
	}
	return check();
}

function isAlive(pid: number): boolean {
	if (process.platform === "linux") {
		try {
			const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
			const state = stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3);
			return state !== "Z" && state !== "X";
		} catch {
			return false;
		}
	}
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

interface Scenario {
	record: string;
	mode?: "observe" | "agent" | "hang" | "exit" | "garbage" | "empty";
	patch?: { lsp?: Record<string, unknown>; dap?: Record<string, unknown>; root?: Record<string, unknown> };
	ignoreSettings?: boolean;
	skills?: boolean;
	promptError?: boolean;
	sdkMissing?: string[];
	pids?: string;
}

const FAKE = [
	'const fs = require("node:fs");',
	'const cp = require("node:child_process");',
	"const scenario = __SCENARIO__;",
	"const argv = process.argv.slice(2);",
	'fs.appendFileSync(scenario.record, JSON.stringify({ kind: argv[0] === "config" ? "config" : "rpc", argv, cwd: process.cwd(), env: process.env }) + "\\n");',
	"function flat(value, prefix, out) {",
	"  for (const key of Object.keys(value)) {",
	"    const member = value[key];",
	'    if (member !== null && typeof member === "object") flat(member, prefix + key + ".", out);',
	"    else out[prefix + key] = member;",
	"  }",
	"  return out;",
	"}",
	'if (argv[0] === "config") {',
	"  const listing = {};",
	"  if (!scenario.ignoreSettings && process.env.PI_CONFIG_FILES) {",
	'    const applied = flat(JSON.parse(fs.readFileSync(process.env.PI_CONFIG_FILES, "utf8")), "", {});',
	'    for (const key of Object.keys(applied)) listing[key] = { value: applied[key], type: "x", description: "" };',
	"  }",
	'  process.stdout.write(JSON.stringify(listing) + "\\n", () => process.exit(0));',
	"} else {",
	'  const send = (frame) => process.stdout.write(JSON.stringify(frame) + "\\n");',
	'  send({ type: "ready", protocolVersion: 1 });',
	'  const commands = [{ name: "settings", source: "builtin" }, { name: "starter-verify-fixture", source: "extension" }];',
	'  if (argv.indexOf("--no-skills") < 0 || scenario.skills) commands.push({ name: "skill:anything", source: "skill" });',
	"  const apply = (target, patch) => {",
	"    Object.assign(target, patch);",
	"    for (const key of Object.keys(patch || {})) if (patch[key] === null) delete target[key];",
	"    return target;",
	"  };",
	"  const observation = (spec) => {",
	"    const patch = scenario.patch || {};",
	"    const obs = {",
	"      schema: 1,",
	"      fixture: spec.fixture,",
	"      sdk: scenario.sdkMissing ? { ok: false, missing: scenario.sdkMissing } : { ok: true },",
	"      environment: { cwd: fs.realpathSync(process.cwd()), home: process.env.HOME, agentDir: process.env.PI_CODING_AGENT_DIR },",
	"      complete: true,",
	"    };",
	"    if (spec.lsp) {",
	'      obs.lsp = apply({ status: "observed", server: spec.lsp.server, attempts: 1, locations: [{ file: spec.lsp.definition.file, line: spec.lsp.definition.line }], elapsedMs: 1 }, patch.lsp);',
	"    }",
	"    if (spec.dap) {",
	"      obs.dap = apply({",
	'        status: "observed",',
	"        adapter: spec.dap.adapter,",
	"        breakpoint: { file: spec.dap.breakpoint.file, line: spec.dap.breakpoint.line, verified: true },",
	"        stop: { file: spec.dap.breakpoint.file, line: spec.dap.breakpoint.line },",
	'        variable: { name: spec.dap.variable.name, value: spec.dap.variable.value, scope: "Locals" },',
	"        terminated: true,",
	"        sessionsAfter: 0,",
	"        elapsedMs: 1,",
	"      }, patch.dap);",
	"    }",
	"    return apply(obs, patch.root);",
	"  };",
	"  const handle = (message) => {",
	'    if (message.type === "get_available_commands") return send({ id: message.id, type: "response", command: message.type, success: true, data: { commands } });',
	'    if (message.type !== "prompt") return;',
	'    if (scenario.promptError) return send({ id: message.id, type: "response", command: "prompt", success: false, error: "no such command" });',
	'    send({ id: message.id, type: "response", command: "prompt", success: true });',
	'    if (scenario.mode === "agent") return send({ type: "agent_start" });',
	'    if (scenario.mode === "exit") process.exit(3);',
	'    if (scenario.mode === "hang") {',
	'      const child = cp.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });',
	'      fs.writeFileSync(scenario.pids, process.pid + "\\n" + child.pid + "\\n");',
	"      return;",
	"    }",
	'    const spec = JSON.parse(fs.readFileSync(process.env.OMP_STARTER_VERIFY_CASE, "utf8"));',
	'    if (scenario.mode === "garbage") fs.writeFileSync(spec.observation, "{not json");',
	'    else if (scenario.mode !== "empty") fs.writeFileSync(spec.observation, JSON.stringify(observation(spec)));',
	'    send({ type: "prompt_result", id: message.id, agentInvoked: false, status: "completed", sessionSettled: true });',
	"  };",
	'  let buffer = "";',
	'  process.stdin.on("data", (chunk) => {',
	"    buffer += chunk;",
	'    for (let at = buffer.indexOf("\\n"); at >= 0; at = buffer.indexOf("\\n")) {',
	"      const line = buffer.slice(0, at);",
	"      buffer = buffer.slice(at + 1);",
	"      if (line.trim()) handle(JSON.parse(line));",
	"    }",
	"  });",
	'  process.stdin.on("end", () => {',
	'    if (scenario.mode !== "hang") process.exit(0);',
	"  });",
	"  setInterval(() => {}, 1000);",
	"}",
].join("\n");

let fakes = 0;

/** An executable that behaves like the isolated omp described by `scenario`. */
function fakeOmp(b: Box, scenario: Omit<Scenario, "record">): { omp: string; record: string } {
	fakes += 1;
	const record = path.join(b.tools, `record-${fakes}.jsonl`);
	const program = path.join(b.tools, `fake-${fakes}.cjs`);
	fs.writeFileSync(program, FAKE.replace("__SCENARIO__", () => JSON.stringify({ ...scenario, record })));
	return { omp: script(path.join(b.tools, `omp-${fakes}`), `exec "${process.execPath}" "${program}" "$@"`), record };
}

interface Invocation {
	kind: "config" | "rpc";
	argv: string[];
	cwd: string;
	env: Record<string, string>;
}

function invocations(record: string): Invocation[] {
	if (!fs.existsSync(record)) return [];
	return fs
		.readFileSync(record, "utf8")
		.split("\n")
		.filter(Boolean)
		.map(line => JSON.parse(line) as Invocation);
}

function fixture(id: string, overrides: Partial<FixtureCase> = {}): FixtureCase {
	return {
		id,
		label: `${id} fixture`,
		files: [
			{ path: "main.src", content: "call()\n" },
			{ path: "util.src", content: "define\nanswer = 42\n" },
		],
		lsp: { server: "srv", file: "main.src", line: 1, symbol: "call", definition: { file: "util.src", line: 1 } },
		dap: { adapter: "adp", program: "main.src", breakpoint: { file: "util.src", line: 2 }, variable: { name: "answer", value: "42" } },
		...overrides,
	};
}

function reuse(kind: IntegrationKind, launch: string, extra: Partial<ReusePlan> = {}): ReusePlan {
	return { kind, status: "reuse", source: "path", launch: { command: launch, args: ["--stdio"] }, tool: { name: "tool", sources: [] }, prerequisites: [], notes: [], entries: [], ...extra };
}

function blocked(kind: IntegrationKind, status: ToolStatus, detail: string): LanguagePlan["lsp"] {
	return { kind, status: "blocked", tool: { name: "tool", sources: [] }, prerequisites: [], notes: [], result: { status, detail } };
}

function plan(b: Box, language: LanguagePlan["language"], overrides: Partial<LanguagePlan> = {}): LanguagePlan {
	const tool = script(path.join(b.tools, "server"), "exit 0");
	return {
		language,
		lsp: reuse("lsp", tool),
		dap: reuse("dap", tool),
		fixtures: REQUIRED_VARIANTS[language].map(id => fixture(id)),
		projectLocalExecutables: [],
		...overrides,
	};
}

async function contextFor(b: Box, omp: string, extra: Partial<VerifyContext> = {}): Promise<VerifyContext> {
	const config = await inspectConfig({ cwd: b.project, agentDir: b.agentDir, home: b.home, env: { PATH: b.bin }, pluginDirs: [], foreignUserSources: { claude: false, codex: false, gemini: false } });
	return {
		ompPath: omp,
		cwd: b.project,
		config,
		consent: true,
		env: { PATH: b.bin, HOME: b.home, OPENAI_API_KEY: "sk-secret", ANTHROPIC_API_KEY: "sk-ant-secret" },
		tempRoot: b.temp,
		limits: { startMs: 20_000, readinessMs: 5_000, helperMs: 20_000, shutdownMs: 1_000 },
		...extra,
	};
}

const SLOW = 60_000;

// ── Success is earned ───────────────────────────────────────────────────────────────────────────


test("the verifier's omp runs with a private home, no inherited credentials and no ambient discovery", async () => {
	const b = box();
	const { omp, record } = fakeOmp(b, {});
	await verifyLanguage(plan(b, "go"), await contextFor(b, omp));

	const runs = invocations(record);
	expect(runs.map(item => item.kind)).toEqual(["config", "rpc"]);
	for (const run of runs) {
		expect(run.env.OPENAI_API_KEY).toBeUndefined();
		expect(run.env.ANTHROPIC_API_KEY).toBeUndefined();
		expect(run.env.HOME?.startsWith(`${b.temp}${path.sep}`)).toBe(true);
		expect(run.env.HOME).not.toBe(b.home);
		expect(run.env.PI_CODING_AGENT_DIR?.startsWith(run.env.HOME as string)).toBe(true);
		expect(run.cwd.startsWith(`${b.temp}${path.sep}`)).toBe(true);
	}
	expect(runs[1]?.argv).not.toContain("--api-key");
}, SLOW);

test("private TMPDIR leaves room for js-debug Unix sockets on all supported platforms", async () => {
	const b = box();
	const { omp, record } = fakeOmp(b, {});
	await verifyLanguage(plan(b, "javascript"), await contextFor(b, omp, { tempRoot: undefined }));
	const run = invocations(record).find(invocation => invocation.kind === "rpc");
	if (!run?.env.TMPDIR) throw new Error("helper temporary directory was not recorded");
	// Darwin's sun_path is 104 bytes; reserve js-debug's real name including a long Linux PID.
	const socket = path.join(run.env.TMPDIR, "node-cdp.4194304-01234567-0.sock");
	expect(Buffer.byteLength(socket)).toBeLessThan(104);
}, SLOW);

test("every required variant is verified, each in its own fixture directory", async () => {
	const b = box();
	const { omp, record } = fakeOmp(b, {});
	const outcome = await verifyLanguage(plan(b, "cpp"), await contextFor(b, omp));

	expect(outcome.observations.map(item => item.fixture)).toEqual(["c", "cpp"]);
	expect(outcome.lsp.status).toBe("ready");
	const dirs = invocations(record).filter(item => item.kind === "rpc").map(item => item.cwd);
	expect(new Set(dirs).size).toBe(2);
}, SLOW);

// ── Wrong observations are failures, and LSP and DAP are judged independently ───────────────────

const WRONG: [string, { lsp?: Record<string, unknown>; dap?: Record<string, unknown> }, IntegrationKind][] = [
	["a definition in the wrong file", { lsp: { locations: [{ file: "main.src", line: 1 }] } }, "lsp"],
	["a definition on the wrong line", { lsp: { locations: [{ file: "util.src", line: 3 }] } }, "lsp"],
	["no definition at all", { lsp: { locations: [] } }, "lsp"],
	["an unrelated language server answering", { lsp: { server: "pyright" } }, "lsp"],
	["a language server that reported an error", { lsp: { status: "error", detail: "initialize failed" } }, "lsp"],
	["a stop on the wrong line", { dap: { stop: { file: "util.src", line: 1 } } }, "dap"],
	["a stop in the wrong file", { dap: { stop: { file: "main.src", line: 2 } } }, "dap"],
	["the wrong variable value", { dap: { variable: { name: "answer", value: "41", scope: "Locals" } } }, "dap"],
	["a missing variable", { dap: { variable: null } }, "dap"],
	["an unrelated debugger adapter", { dap: { adapter: "gdb" } }, "dap"],
	["a debug session that was not terminated", { dap: { terminated: false } }, "dap"],
	["a debugger that is still listed after termination", { dap: { sessionsAfter: 1 } }, "dap"],
	["a debugger run that reported an error", { dap: { status: "error", detail: "adapter exited" } }, "dap"],
];

for (const [label, patch, failing] of WRONG) {
	test(`${label} fails only the integration it concerns`, async () => {
		const b = box();
		const { omp } = fakeOmp(b, { patch });
		const outcome = await verifyLanguage(plan(b, "python"), await contextFor(b, omp));
		const other: IntegrationKind = failing === "lsp" ? "dap" : "lsp";

		expect(outcome[failing].status).toBe("failed");
		expect(outcome[other].status).toBe("ready");
		expect(fs.readdirSync(b.temp)).toEqual([]);
	}, SLOW);
}

test("a wrong definition reports what was expected and what was seen", async () => {
	const b = box();
	const { omp } = fakeOmp(b, { patch: { lsp: { locations: [{ file: "util.src", line: 3 }] } } });
	const outcome = await verifyLanguage(plan(b, "python"), await contextFor(b, omp));

	expect(outcome.lsp.detail).toContain("util.src:3");
	expect(outcome.lsp.detail).toContain("util.src:1");
	expect(outcome.observations[0]?.lsp?.observed).toEqual({ server: "srv", definitions: ["util.src:3"] });
}, SLOW);

test("an observation from a helper that did not run in the private tree is rejected", async () => {
	const b = box();
	const { omp } = fakeOmp(b, { patch: { root: { environment: { cwd: b.project, home: b.home, agentDir: b.agentDir } } } });
	const outcome = await verifyLanguage(plan(b, "python"), await contextFor(b, omp));

	expect(outcome.lsp.status).toBe("failed");
	expect(outcome.dap.status).toBe("failed");
	expect(outcome.lsp.detail).toContain("isolation");
}, SLOW);

// ── Malformed, failed and hanging helpers are never ready ───────────────────────────────────────

const BROKEN: [string, Omit<Scenario, "record">, ToolStatus][] = [
	["invalid observation JSON", { mode: "garbage" }, "failed"],
	["no observation", { mode: "empty" }, "failed"],
	["an observation with an unexpected schema", { patch: { root: { schema: 2 } } }, "failed"],
	["an observation without an SDK verdict", { patch: { root: { sdk: "yes" } } }, "failed"],
	["a helper command that omp refused", { promptError: true }, "failed"],
	["a helper that exited", { mode: "exit" }, "failed"],
	["agent activity", { mode: "agent" }, "failed"],
	["an omp without the public SDK exports", { sdkMissing: ["pi.pi.LspTool"] }, "unverified"],
	["an omp that did not apply the isolated settings", { ignoreSettings: true }, "unverified"],
	["an omp that exposed skills", { skills: true }, "failed"],
];

for (const [label, scenario, status] of BROKEN) {
	test(`${label} is ${status}, never ready, and leaves nothing behind`, async () => {
		const b = box();
		const { omp } = fakeOmp(b, scenario);
		const outcome = await verifyLanguage(plan(b, "python"), await contextFor(b, omp));

		expect(outcome.lsp.status).toBe(status);
		expect(outcome.dap.status).toBe(status);
		expect(fs.readdirSync(b.temp)).toEqual([]);
	}, SLOW);
}

test("an omp that ignores the isolated settings is never started as the RPC helper", async () => {
	const b = box();
	const { omp, record } = fakeOmp(b, { ignoreSettings: true });
	const outcome = await verifyLanguage(plan(b, "python"), await contextFor(b, omp));

	expect(outcome.lsp.detail).toContain("isolated settings");
	expect(invocations(record).map(item => item.kind)).toEqual(["config"]);
}, SLOW);

test("a missing SDK export tells the user to upgrade omp", async () => {
	const b = box();
	const { omp } = fakeOmp(b, { sdkMissing: ["pi.pi.DebugTool"] });
	const outcome = await verifyLanguage(plan(b, "python"), await contextFor(b, omp));

	expect(outcome.dap.detail).toContain("pi.pi.DebugTool");
	expect(outcome.dap.detail).toContain("Upgrade omp");
}, SLOW);

test("a hanging helper times out, is stopped with its detached descendant, and its tree is removed", async () => {
	const b = box();
	const pids = path.join(b.tools, "pids");
	const { omp } = fakeOmp(b, { mode: "hang", pids });
	const outcome = await verifyLanguage(plan(b, "python"), await contextFor(b, omp, { limits: { startMs: 20_000, readinessMs: 1_000, helperMs: 2_000, shutdownMs: 300 } }));

	expect(outcome.lsp.status).toBe("failed");
	expect(outcome.lsp.detail).toContain("timed out");
	expect(outcome.dap.status).toBe("failed");
	const alive = fs.readFileSync(pids, "utf8").split("\n").filter(Boolean).map(Number);
	expect(alive).toHaveLength(2);
	for (const pid of alive) expect(await eventually(() => !isAlive(pid))).toBe(true);
	expect(fs.readdirSync(b.temp)).toEqual([]);
}, SLOW);

test("cancellation stops the helper tree and reports an unverified, cancelled result", async () => {
	const b = box();
	const pids = path.join(b.tools, "pids");
	const { omp } = fakeOmp(b, { mode: "hang", pids });
	const controller = new AbortController();
	const running = verifyLanguage(plan(b, "python"), await contextFor(b, omp, { signal: controller.signal }));

	expect(await eventually(() => fs.existsSync(pids) && fs.readFileSync(pids, "utf8").split("\n").filter(Boolean).length === 2)).toBe(true);
	controller.abort();
	const outcome = await running;

	expect(outcome.lsp.status).toBe("unverified");
	expect(outcome.lsp.detail).toContain("cancelled");
	for (const pid of fs.readFileSync(pids, "utf8").split("\n").filter(Boolean).map(Number)) expect(await eventually(() => !isAlive(pid))).toBe(true);
	expect(fs.readdirSync(b.temp)).toEqual([]);
}, SLOW);

// ── Variants, blocked plans and consent ─────────────────────────────────────────────────────────

test("a subset, empty or padded list of fixtures is not a verification of the group", async () => {
	const b = box();
	const { omp, record } = fakeOmp(b, {});
	const context = await contextFor(b, omp);
	const cases: LanguagePlan[] = [
		plan(b, "javascript", { fixtures: [fixture("javascript")] }),
		plan(b, "javascript", { fixtures: [fixture("typescript")] }),
		plan(b, "cpp", { fixtures: [fixture("c")] }),
		plan(b, "python", { fixtures: [] }),
		plan(b, "go", { fixtures: [fixture("go"), fixture("go")] }),
		plan(b, "rust", { fixtures: [fixture("rust"), fixture("extra")] }),
	];
	for (const candidate of cases) {
		const outcome = await verifyLanguage(candidate, context);
		expect(outcome.lsp.status).toBe("unverified");
		expect(outcome.dap.status).toBe("unverified");
		expect(outcome.lsp.detail).toContain("variants");
	}
	expect(invocations(record)).toEqual([]);
	expect(REQUIRED_VARIANTS.javascript).toEqual(["javascript", "typescript"]);
	expect(REQUIRED_VARIANTS.cpp).toEqual(["c", "cpp"]);
}, SLOW);

test("an expectation that points outside its own fixture is refused before anything runs", async () => {
	const b = box();
	const { omp, record } = fakeOmp(b, {});
	const broken = fixture("python", { lsp: { server: "srv", file: "main.src", line: 1, symbol: "call", definition: { file: "util.src", line: 99 } } });
	const outcome = await verifyLanguage(plan(b, "python", { fixtures: [broken] }), await contextFor(b, omp));

	expect(outcome.lsp.status).toBe("unverified");
	expect(invocations(record)).toEqual([]);
}, SLOW);

test("a blocked integration keeps the planner's status while the other is still verified", async () => {
	const b = box();
	const { omp } = fakeOmp(b, {});
	const tool = path.join(b.tools, "server");
	script(tool, "exit 0");
	const outcome = await verifyLanguage(plan(b, "python", { lsp: blocked("lsp", "needs-sdk", "Python is missing") }), await contextFor(b, omp));

	expect(outcome.lsp.status).toBe("needs-sdk");
	expect(outcome.lsp.detail).toContain("Python is missing");
	expect(outcome.dap.status).toBe("ready");
}, SLOW);

test("when both integrations are blocked nothing is created or run", async () => {
	const b = box();
	const { omp, record } = fakeOmp(b, {});
	const outcome = await verifyLanguage(plan(b, "rust", { lsp: blocked("lsp", "unsupported", "no"), dap: blocked("dap", "failed", "gone") }), await contextFor(b, omp));

	expect([outcome.lsp.status, outcome.dap.status]).toEqual(["unsupported", "failed"]);
	expect(invocations(record)).toEqual([]);
	expect(fs.readdirSync(b.temp)).toEqual([]);
}, SLOW);

test("without explicit consent nothing is built, started or created", async () => {
	const b = box();
	const { omp, record } = fakeOmp(b, {});
	const outcome = await verifyLanguage(plan(b, "python"), await contextFor(b, omp, { consent: false }));

	expect(outcome.lsp.status).toBe("unverified");
	expect(outcome.dap.status).toBe("unverified");
	expect(invocations(record)).toEqual([]);
	expect(fs.readdirSync(b.temp)).toEqual([]);
}, SLOW);

test("an installed tool that is not there is missing, not ready", async () => {
	const b = box();
	const { omp, record } = fakeOmp(b, {});
	const outcome = await verifyLanguage(plan(b, "python", { lsp: reuse("lsp", path.join(b.tools, "not-installed")) }), await contextFor(b, omp));

	expect(outcome.lsp.status).toBe("missing");
	expect(outcome.dap.status).toBe("ready");
	expect(invocations(record).length).toBeGreaterThan(0);
}, SLOW);

// ── Project-local executables need an exact grant from the caller ───────────────────────────────

test("a project-local tool is not run on the strength of the plan's own disclosure", async () => {
	const b = box();
	const local = script(path.join(b.project, "node_modules", ".bin", "server"), "exit 0");
	const { omp, record } = fakeOmp(b, {});
	const candidate = plan(b, "python", { lsp: reuse("lsp", local, { source: "project-local" }), projectLocalExecutables: [local] });

	const none = await verifyLanguage(candidate, await contextFor(b, omp));
	const elsewhere = await verifyLanguage(candidate, await contextFor(b, omp, { approvedProjectLocal: [path.join(b.project, "node_modules", ".bin", "other")] }));

	for (const outcome of [none, elsewhere]) {
		expect(outcome.lsp.status).toBe("unverified");
		expect(outcome.lsp.detail).toContain("approve");
		expect(outcome.dap.status).toBe("ready");
	}
	// Only the second integration ever reached the helper; the project-local server was never part of a fixture.
	for (const run of invocations(record)) expect(run.cwd.startsWith(b.project)).toBe(false);
}, SLOW);

test("an exactly granted project-local tool is verified", async () => {
	const b = box();
	const local = script(path.join(b.project, "node_modules", ".bin", "server"), "exit 0");
	const { omp } = fakeOmp(b, {});
	const candidate = plan(b, "python", { lsp: reuse("lsp", local, { source: "project-local" }) });
	const outcome = await verifyLanguage(candidate, await contextFor(b, omp, { approvedProjectLocal: [local] }));

	expect(outcome.lsp.status).toBe("ready");
}, SLOW);

test("a project-local build tool runs only when it was granted exactly", async () => {
	const b = box();
	const marker = path.join(b.tools, "built");
	const compiler = script(path.join(b.project, "tools", "compile"), `echo ran >> "${marker}"`);
	const { omp } = fakeOmp(b, {});
	const building = fixture("python", { build: [{ label: "compile", command: compiler, args: [] }] });
	const candidate = plan(b, "python", { fixtures: [building] });

	const refused = await verifyLanguage(candidate, await contextFor(b, omp));
	expect(refused.lsp.status).toBe("unverified");
	expect(fs.existsSync(marker)).toBe(false);

	const granted = await verifyLanguage(candidate, await contextFor(b, omp, { approvedProjectLocal: [compiler] }));
	expect(granted.lsp.status).toBe("ready");
	expect(fs.existsSync(marker)).toBe(true);
}, SLOW);

test("a failing fixture build fails both integrations and runs no helper", async () => {
	const b = box();
	const compiler = script(path.join(b.tools, "compile"), "echo broken >&2; exit 1");
	const { omp, record } = fakeOmp(b, {});
	const candidate = plan(b, "python", { fixtures: [fixture("python", { build: [{ label: "compile", command: compiler, args: [] }] })] });
	const outcome = await verifyLanguage(candidate, await contextFor(b, omp));

	expect(outcome.lsp.status).toBe("failed");
	expect(outcome.lsp.detail).toContain("fixture build failed");
	expect(outcome.dap.status).toBe("failed");
	expect(invocations(record)).toEqual([]);
}, SLOW);

// ── The original project's configuration is judged statically ───────────────────────────────────

function nativeConfig(b: Box, file: string, value: unknown): void {
	fs.writeFileSync(path.join(b.agentDir, file), JSON.stringify(value));
}

test("a disabled or shadowing effective entry is not ready even though the fixture would pass", async () => {
	const b = box();
	const tool = path.join(b.tools, "server");
	script(tool, "exit 0");
	const other = script(path.join(b.tools, "other"), "exit 0");
	const { omp } = fakeOmp(b, {});

	nativeConfig(b, "lsp.json", { servers: { srv: { command: tool, disabled: true } } });
	const disabled = await verifyLanguage(plan(b, "python"), await contextFor(b, omp));
	expect(disabled.lsp.status).toBe("failed");
	expect(disabled.lsp.detail).toContain("disabled");
	expect(disabled.dap.status).toBe("ready");

	nativeConfig(b, "lsp.json", { servers: { srv: { command: other } } });
	const shadowed = await verifyLanguage(plan(b, "python"), await contextFor(b, omp));
	expect(shadowed.lsp.status).toBe("failed");
	expect(shadowed.lsp.detail).toContain("not the verified");
}, SLOW);

test("application-specific settings are never copied into the fixture and keep the integration unverified", async () => {
	const b = box();
	const tool = path.join(b.tools, "server");
	script(tool, "exit 0");
	const { omp, record } = fakeOmp(b, {});

	nativeConfig(b, "lsp.json", { servers: { srv: { command: tool, args: ["--stdio"], initOptions: { linkedProjects: ["/home/me/app/Cargo.toml"] } } } });
	nativeConfig(b, "dap.json", { adapters: { adp: { command: tool, args: ["--stdio"], launchDefaults: { env: { APP_TOKEN: "x" }, initCommands: ["command script import /home/me/hook.py"] } } } });
	const outcome = await verifyLanguage(plan(b, "python"), await contextFor(b, omp));

	expect(outcome.lsp.status).toBe("unverified");
	expect(outcome.lsp.detail).toContain("linkedProjects");
	expect(outcome.dap.status).toBe("unverified");
	expect(outcome.dap.detail).toContain("initCommands");
	expect(invocations(record)).toEqual([]);
}, SLOW);

test("known fixture-safe SDK bindings and the preserve-ASLR command are accepted", async () => {
	const b = box();
	const tool = path.join(b.tools, "server");
	script(tool, "exit 0");
	const { omp } = fakeOmp(b, {});

	nativeConfig(b, "dap.json", {
		adapters: { adp: { command: tool, args: ["--stdio"], connectMode: "stdio", launchDefaults: { request: "launch", stopOnEntry: true, terminal: "console", initCommands: ["settings set target.disable-aslr false"] } } },
	});
	const outcome = await verifyLanguage(plan(b, "python"), await contextFor(b, omp));

	expect(outcome.dap.status).toBe("ready");
}, SLOW);

// ── Helper-side observation logic (the public SDK tools replaced by scripted ones) ──────────────

const FIXTURE = "/virtual/fixture";

function clock(): Clock {
	let now = 0;
	return {
		now: () => now,
		sleep: async (ms: number) => {
			now += ms;
		},
	};
}

function phase(extra: Partial<PhaseContext> = {}): PhaseContext {
	return { cwd: FIXTURE, clock: clock(), callSeconds: 30, readinessMs: 3_000, ...extra };
}

function lspAnswer(server: string, result: unknown, success = true): { content: { type: string; text: string }[]; details: Record<string, unknown> } {
	const text = typeof result === "string" ? result : `${server} \u2190 textDocument/definition:\n${JSON.stringify(result)}`;
	return { content: [{ type: "text", text }], details: { action: "request", success, serverName: server } };
}

function location(file: string, line: number): Record<string, unknown> {
	return { uri: `file://${FIXTURE}/${file}`, range: { start: { line: line - 1, character: 0 }, end: { line: line - 1, character: 4 } } };
}

function scripted(answers: (() => unknown)[]): { tool: ToolLike; calls: Record<string, unknown>[] } {
	const calls: Record<string, unknown>[] = [];
	return {
		calls,
		tool: {
			async execute(_id, params) {
				calls.push(params);
				const next = answers.shift();
				if (next === undefined) throw new Error("no scripted answer left");
				return next() as never;
			},
		},
	};
}

const SPEC = { server: "srv", file: "main.src", line: 1, symbol: "call", definition: { file: "util.src", line: 1 } };

test("definition locations are read from Location, LocationLink, list and null answers", () => {
	const header = "srv \u2190 textDocument/definition:\n";
	const link = { targetUri: `file://${FIXTURE}/util.src`, targetSelectionRange: { start: { line: 4, character: 0 }, end: { line: 4, character: 3 } }, targetRange: { start: { line: 3, character: 0 }, end: { line: 6, character: 0 } } };

	expect(locationsFromText(header + JSON.stringify(location("util.src", 1)), FIXTURE)).toEqual({ ok: true, locations: [{ file: "util.src", line: 1 }] });
	expect(locationsFromText(header + JSON.stringify([link]), FIXTURE)).toEqual({ ok: true, locations: [{ file: "util.src", line: 5 }] });
	expect(locationsFromText(`${header}null`, FIXTURE)).toEqual({ ok: true, locations: [] });
	expect(locationsFromText(header + JSON.stringify({ uri: "file:///elsewhere/x.src", range: { start: { line: 0, character: 0 } } }), FIXTURE)).toMatchObject({ ok: true, locations: [{ file: expect.stringContaining("..") }] });
	expect(locationsFromText(`${header}not json`, FIXTURE).ok).toBe(false);
	expect(locationsFromText(header + JSON.stringify(["x"]), FIXTURE).ok).toBe(false);
	expect(locationsFromText(header + JSON.stringify({ uri: "http://example.com/x", range: { start: { line: 0 } } }), FIXTURE).ok).toBe(false);
});

test("definition polling waits for a server that is still loading, then reads the real answer", async () => {
	const { tool, calls } = scripted([() => lspAnswer("srv", null), () => lspAnswer("srv", "LSP error from srv on textDocument/definition: content modified", false), () => lspAnswer("srv", location("util.src", 1))]);
	const observation = await observeDefinition(SPEC, tool, phase());

	expect(observation).toMatchObject({ status: "observed", server: "srv", attempts: 3, locations: [{ file: "util.src", line: 1 }] });
	expect(calls[0]).toMatchObject({ action: "request", query: "textDocument/definition", line: 1, symbol: "call", file: `${FIXTURE}/main.src` });
});

test("definition polling stops at a real failure and is bounded when nothing ever answers", async () => {
	const failing = scripted([() => lspAnswer("srv", "No language server found for this file", false)]);
	expect(await observeDefinition(SPEC, failing.tool, phase())).toMatchObject({ status: "error", attempts: 1, detail: expect.stringContaining("No language server") });

	const silent = scripted(Array.from({ length: 50 }, () => () => lspAnswer("srv", null)));
	const bounded = await observeDefinition(SPEC, silent.tool, phase());
	expect(bounded.status).toBe("error");
	expect(bounded.detail).toContain("3000ms");
	expect(silent.calls.length).toBeLessThan(20);
});

const DAP_SPEC = { adapter: "adp", program: "main.src", breakpoint: { file: "util.src", line: 2 }, variable: { name: "answer", value: "42" } };

/** A scripted debugger that reports real session state: it needs polling before it stops, and may stop at the program entry first. */
function debugger_(options: { entryStop?: boolean; endsEarly?: boolean; stopsNever?: boolean; variables?: unknown[]; terminateFails?: boolean } = {}): { tool: ToolLike; calls: string[] } {
	const debuggee = { state: "running" as "running" | "stopped" | "gone", polls: 0, line: 1, resumes: 0, traces: 0 };
	const calls: string[] = [];
	const handlers: Record<string, (params: Record<string, unknown>) => Record<string, unknown>> = {
		launch: () => ({ adapter: "adp", snapshot: { status: options.entryStop ? "stopped" : "running" } }),
		sessions: () => {
			if (options.endsEarly) return { sessions: [] };
			if (debuggee.state === "running" && !options.stopsNever && ++debuggee.polls >= 2) debuggee.state = "stopped";
			return { sessions: debuggee.state === "gone" ? [] : [{ status: debuggee.state }] };
		},
		set_breakpoint: () => ({ breakpoints: [{ line: 2, verified: true }] }),
		continue: () => {
			debuggee.resumes += 1;
			if (options.entryStop) return { state: "stopped", timedOut: false };
			// A JavaScript debuggee is a child session: the root has no threads until it exists.
			if (debuggee.resumes === 1) throw new Error("Debugger reported no threads.");
			debuggee.state = "running";
			debuggee.polls = 0;
			debuggee.line = 2;
			return { state: "running", timedOut: false };
		},
		stack_trace: () => {
			debuggee.traces += 1;
			const line = options.entryStop ? (debuggee.traces === 1 ? 1 : 2) : debuggee.line;
			return { stackFrames: [{ id: 7, name: "compute", source: { path: `${FIXTURE}/util.src` }, line }] };
		},
		scopes: () => ({ scopes: [{ name: "Globals", variablesReference: 9, expensive: true }, { name: "Locals", variablesReference: 5, expensive: false }] }),
		variables: params => ({ variables: params.scope_id === 5 ? (options.variables ?? [{ name: "answer", value: "42" }]) : [{ name: "other", value: "1" }] }),
		terminate: () => {
			if (options.terminateFails) throw new Error("adapter did not answer");
			debuggee.state = "gone";
			return {};
		},
	};
	return {
		calls,
		tool: {
			async execute(_id, params) {
				const action = String(params.action);
				calls.push(action);
				const handler = handlers[action];
				if (handler === undefined) throw new Error(`unexpected ${action}`);
				return { content: [{ type: "text", text: "" }], details: handler(params) };
			},
		},
	};
}

test("the debugger check polls real session state, resumes past the entry stop, and reads the variable from a scope", async () => {
	const { tool, calls } = debugger_();
	const observation = await observeBreakpoint(DAP_SPEC, tool, phase());

	expect(observation).toMatchObject({
		status: "observed",
		adapter: "adp",
		breakpoint: { file: "util.src", line: 2, verified: true },
		stop: { file: "util.src", line: 2, frameName: "compute" },
		variable: { name: "answer", value: "42", scope: "Locals" },
		terminated: true,
		sessionsAfter: 0,
	});
	expect(calls.filter(call => call === "sessions").length).toBeGreaterThan(2);
	expect(calls.at(-2)).toBe("terminate");
});

test("a debuggee stopped at its entry is resumed until the breakpoint, not trusted at the first stop", async () => {
	const { tool, calls } = debugger_({ entryStop: true });
	const observation = await observeBreakpoint(DAP_SPEC, tool, phase());

	expect(observation).toMatchObject({ status: "observed", stop: { file: "util.src", line: 2 }, variable: { value: "42" } });
	expect(calls.filter(call => call === "continue")).toHaveLength(2);
});

test("a variable that is absent from every scope is an error, and the session is still torn down", async () => {
	const absent = await observeBreakpoint(DAP_SPEC, debugger_({ variables: [{ name: "x", value: "1" }] }).tool, phase());

	expect(absent.status).toBe("error");
	expect(absent.detail).toContain("answer");
	expect(absent.terminated).toBe(true);
});

test("a program that ends before the debugger stops is reported, and the session is still torn down", async () => {
	const { tool, calls } = debugger_({ endsEarly: true });
	const observation = await observeBreakpoint(DAP_SPEC, tool, phase());

	expect(observation.status).toBe("error");
	expect(observation.detail).toContain("ended");
	expect(calls).toContain("terminate");
	expect(observation.terminated).toBe(true);
});

test("a debuggee that never stops is given a bounded window, not an endless wait", async () => {
	const { tool, calls } = debugger_({ stopsNever: true });
	const observation = await observeBreakpoint(DAP_SPEC, tool, phase());

	expect(observation.status).toBe("error");
	expect(observation.detail).toContain("did not stop");
	expect(calls.length).toBeLessThan(40);
});

test("a debug session that cannot be terminated is never reported as torn down", async () => {
	const observation = await observeBreakpoint(DAP_SPEC, debugger_({ terminateFails: true }).tool, phase());

	expect(observation.terminated).toBe(false);
	expect(observation.status).toBe("error");
});

test("observations are validated strictly", () => {
	const good = { schema: 1, fixture: "python", sdk: { ok: true }, environment: { cwd: "/a", home: "/b", agentDir: "/c" }, complete: true, lsp: { status: "observed", attempts: 1, elapsedMs: 3, server: "srv", locations: [{ file: "util.src", line: 1 }] } };

	expect(parseObservation(JSON.stringify(good)).ok).toBe(true);
	for (const broken of [
		{ ...good, schema: 2 },
		{ ...good, complete: "yes" },
		{ ...good, lsp: { ...good.lsp, locations: [{ file: "util.src", line: 0 }] } },
		{ ...good, lsp: { ...good.lsp, status: "maybe" } },
		{ ...good, environment: { cwd: "/a" } },
		{ ...good, dap: { status: "observed", terminated: true } },
	]) {
		expect(parseObservation(JSON.stringify(broken)).ok).toBe(false);
	}
	expect(parseObservation("{").ok).toBe(false);
});
