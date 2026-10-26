import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { inspectConfig } from "./config";
import { planGo, planJavascript, planPython } from "./managed";
import { createRuntime, ensureToolingRoots, INSTALL_MANIFEST_FILE, RuntimeError } from "./runtime";
import type {
	BlockedPlan,
	FixtureCase,
	InstallPlan,
	IntegrationPlan,
	LanguagePlan,
	PlanContext,
	PlatformInput,
	ReusePlan,
	Runtime,
} from "./types";

// ── Harness ─────────────────────────────────────────────────────────────────────────────────────
//
// SDKs and tools are tiny `#!/bin/sh` programs on a private PATH that print what the real tool prints
// for a version query. The plans run through the real runtime (real bounded probes from owned
// directories) and the real config inspection; only the machine's installed software is replaced,
// so absence and version boundaries are deterministic on any host.

const SLOW = 30_000;
const UBUNTU: PlatformInput = { platform: "linux", arch: "x64", osRelease: "ID=ubuntu\nID_LIKE=debian\n" };

const cleanups: (() => Promise<unknown> | unknown)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface Box {
	root: string;
	/** The only PATH directory: nothing from the real machine is visible. */
	bin: string;
	project: string;
	home: string;
	agentDir: string;
}

function box(): Box {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "omp-managed-test-")));
	cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
	const result = {
		root,
		bin: path.join(root, "bin"),
		project: path.join(root, "project"),
		home: path.join(root, "home"),
		agentDir: path.join(root, "home", ".omp", "agent"),
	};
	for (const dir of [result.bin, result.project, result.agentDir]) fs.mkdirSync(dir, { recursive: true });
	return result;
}

function script(file: string, body: string): string {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
	return file;
}

/** A program that prints `output` for any arguments, and appends to `marker` when it is executed at all. */
function printer(file: string, output: string, marker?: string): string {
	const lines = output.split("\n").map(line => `echo "${line}"`);
	return script(file, [...(marker === undefined ? [] : [`echo ran >> "${marker}"`]), ...lines].join("\n"));
}

function tool(b: Box, name: string, output: string): string {
	return printer(path.join(b.bin, name), output);
}

/** An npm-style TypeScript install (`<pkg>/bin/tsc`, `<pkg>/lib/tsserver.js`) linked into PATH like `npm install -g`. */
function typescript(b: Box, versionText: string): { tsc: string; lib: string } {
	const pkg = path.join(b.root, "ts-sdk", "lib", "node_modules", "typescript");
	printer(path.join(pkg, "bin", "tsc"), `Version ${versionText}`);
	fs.mkdirSync(path.join(pkg, "lib"), { recursive: true });
	fs.writeFileSync(path.join(pkg, "lib", "tsserver.js"), "");
	fs.symlinkSync(path.join(pkg, "bin", "tsc"), path.join(b.bin, "tsc"));
	return { tsc: path.join(b.bin, "tsc"), lib: path.join(pkg, "lib") };
}

interface PythonOptions {
	version?: string;
	venv?: boolean;
	debugpy?: string;
	marker?: string;
}

function python(file: string, options: PythonOptions = {}): string {
	return script(
		file,
		[
			...(options.marker === undefined ? [] : [`echo ran >> "${options.marker}"`]),
			'case "$*" in',
			`*version_info*) echo ${options.version ?? "3.12.3"} ;;`,
			`*"import ensurepip"*) exit ${options.venv === false ? 1 : 0} ;;`,
			`*"-m debugpy --version"*) ${options.debugpy === undefined ? "exit 1" : `echo "debugpy ${options.debugpy}"`} ;;`,
			"*) exit 0 ;;",
			"esac",
		].join("\n"),
	);
}

function runtimeFor(b: Box, platform: PlatformInput = UBUNTU, extra: { fetch?: typeof fetch } = {}): Runtime {
	const runtime = createRuntime({ agentDir: b.agentDir, cwd: b.project, env: { PATH: b.bin, HOME: b.home }, platform, ...extra });
	cleanups.push(() => runtime.dispose());
	return runtime;
}

async function contextFor(b: Box, runtime: Runtime = runtimeFor(b)): Promise<PlanContext> {
	const config = await inspectConfig({ cwd: b.project, agentDir: b.agentDir, home: b.home, env: { PATH: b.bin }, pluginDirs: [] });
	return { runtime, config };
}

function put(file: string, content: string | object): string {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`);
	return file;
}

function lspConfig(file: string, key: string, value: object): string {
	return put(file, { servers: { [key]: value } });
}

function installOf(plan: IntegrationPlan): InstallPlan {
	if (plan.status !== "install") throw new Error(`expected an install plan, got ${plan.status}: ${JSON.stringify(plan.status === "blocked" ? plan.result : plan.notes)}`);
	return plan;
}

function reuseOf(plan: IntegrationPlan): ReusePlan {
	if (plan.status !== "reuse") throw new Error(`expected a reuse plan, got ${plan.status}: ${JSON.stringify(plan.status === "blocked" ? plan.result : plan.notes)}`);
	return plan;
}

function blockedOf(plan: IntegrationPlan): BlockedPlan {
	if (plan.status !== "blocked") throw new Error(`expected a blocked plan, got ${plan.status}`);
	return plan;
}

function fixture(plan: LanguagePlan, id: string): FixtureCase {
	const found = plan.fixtures.find(candidate => candidate.id === id);
	if (found === undefined) throw new Error(`no fixture ${id}; have ${plan.fixtures.map(candidate => candidate.id).join(", ")}`);
	return found;
}


async function installError(runtime: Runtime, plan: InstallPlan): Promise<RuntimeError> {
	try {
		await runtime.install(plan.install);
	} catch (error) {
		if (error instanceof RuntimeError) return error;
		throw error;
	}
	throw new Error("expected the install to fail");
}

// ── JavaScript / TypeScript ─────────────────────────────────────────────────────────────────────


test(
	"an existing TypeScript 7 uses its native server: no install, no npm, and a missing Node blocks only the debugger",
	async () => {
		const b = box();
		const sdk = typescript(b, "7.0.2");
		const plan = await planJavascript(await contextFor(b));

		const lsp = reuseOf(plan.lsp);
		expect(lsp.source).toBe("path");
		expect(lsp.launch).toEqual({ command: sdk.tsc, args: ["--lsp", "--stdio"] });
		expect(lsp.entries).toEqual([]);
		expect(lsp.prerequisites.map(item => item.name)).toEqual(["typescript"]);
		expect(fixture(plan, "javascript").lsp.server).toBe("typescript-native");
		expect(fixture(plan, "typescript").lsp.server).toBe("typescript-native");

		const dap = blockedOf(plan.dap);
		expect(dap.result.status).toBe("needs-sdk");
		expect(dap.result.detail).toContain("22.22.2");
	},
	SLOW,
);

test(
	"TypeScript 5 blocks only the language server; the debugger and both fixtures use its compiler",
	async () => {
		const old = box();
		tool(old, "node", "v22.22.2");
		const oldSdk = typescript(old, "5.9.3");
		const plan = await planJavascript(await contextFor(old));
		const lsp = blockedOf(plan.lsp);
		expect(lsp.result.status).toBe("needs-sdk");
		expect(lsp.result.detail).toContain("5.9.3");
		expect(lsp.result.detail).toContain("typescript@6");
		expect(installOf(plan.dap).install.tool).toBe("js-debug");
		expect(plan.fixtures.map(item => item.id)).toEqual(["javascript", "typescript"]);
		expect(fixture(plan, "typescript").build?.[0]?.command).toBe(oldSdk.tsc);
	},
	SLOW,
);

test(
	"Node 22.22.2 is the boundary for both JavaScript integrations",
	async () => {
		const below = box();
		tool(below, "node", "v22.22.1");
		tool(below, "npm", "10.9.2");
		typescript(below, "6.0.3");
		const blockedPlan = await planJavascript(await contextFor(below));
		for (const integration of [blockedPlan.lsp, blockedPlan.dap]) {
			const plan = blockedOf(integration);
			expect(plan.result.status).toBe("needs-sdk");
			expect(plan.result.detail).toContain("22.22.2");
			expect(plan.result.detail).toContain("22.22.1");
		}

		const exact = box();
		tool(exact, "node", "v22.22.2");
		tool(exact, "npm", "10.9.2");
		typescript(exact, "6.0.3");
		const okPlan = await planJavascript(await contextFor(exact));
		expect(okPlan.lsp.status).toBe("install");
		expect(okPlan.dap.status).toBe("install");
	},
	SLOW,
);

test(
	"an installed typescript-language-server is reused only when it is 6.0.2 or newer 6.x, and an old one is left alone",
	async () => {
		const good = box();
		tool(good, "node", "v24.22.0");
		const sdk = typescript(good, "6.0.3");
		const server = tool(good, "typescript-language-server", "6.0.4");
		const reused = reuseOf((await planJavascript(await contextFor(good))).lsp);
		expect(reused.source).toBe("path");
		expect(reused.launch.command).toBe(server);
		expect(reused.tool.version).toBe("6.0.4");
		expect(reused.entries[0]).toMatchObject({ key: "typescript-language-server", value: { command: server, initOptions: { tsserver: { fallbackPath: sdk.lib } } } });

		const old = box();
		tool(old, "node", "v24.22.0");
		tool(old, "npm", "10.9.2");
		typescript(old, "6.0.3");
		tool(old, "typescript-language-server", "5.1.3");
		const plan = installOf((await planJavascript(await contextFor(old))).lsp);
		expect(plan.install.version).toBe("6.0.2");
		expect(plan.notes.join(" ")).toContain("5.1.3");
		expect(plan.notes.join(" ")).toContain("left untouched");
	},
	SLOW,
);

test(
	"an effective configured server is reused or reported, never replaced or shadowed",
	async () => {
		// Reused even though no TypeScript SDK exists: the user's own entry decides.
		const reuse = box();
		const server = tool(reuse, "my-tls", "6.1.0");
		lspConfig(path.join(reuse.agentDir, "lsp.json"), "typescript-language-server", { command: server, fileTypes: [".ts"], rootMarkers: ["package.json"] });
		const reused = reuseOf((await planJavascript(await contextFor(reuse))).lsp);
		expect(reused.source).toBe("configured");
		expect(reused.entries).toEqual([]);
		expect(reused.launch.command).toBe(server);

		const disabled = box();
		lspConfig(path.join(disabled.agentDir, "lsp.json"), "typescript-language-server", { command: tool(disabled, "my-tls", "6.1.0"), disabled: true, fileTypes: [".ts"], rootMarkers: ["package.json"] });
		const off = blockedOf((await planJavascript(await contextFor(disabled))).lsp);
		expect(off.result.status).toBe("failed");
		expect(off.result.detail).toContain("disabled");

		const unresolved = box();
		lspConfig(path.join(unresolved.agentDir, "lsp.json"), "typescript-language-server", { command: "/nonexistent/tls", fileTypes: [".ts"], rootMarkers: ["package.json"] });
		const missing = blockedOf((await planJavascript(await contextFor(unresolved))).lsp);
		expect(missing.result.status).toBe("failed");
		expect(missing.result.detail).toContain("does not resolve");

		const stale = box();
		lspConfig(path.join(stale.agentDir, "lsp.json"), "typescript-language-server", { command: tool(stale, "my-tls", "5.1.3"), fileTypes: [".ts"], rootMarkers: ["package.json"] });
		const old = blockedOf((await planJavascript(await contextFor(stale))).lsp);
		expect(old.result.status).toBe("unsupported");
		expect(old.result.detail).toContain("5.1.3");
		expect(old.result.detail).toContain("never replaced");
	},
	SLOW,
);

test(
	"a project-local server is never executed before approval, and only that approved path runs afterwards",
	async () => {
		const b = box();
		tool(b, "node", "v24.22.0");
		tool(b, "npm", "10.9.2");
		typescript(b, "6.0.3");
		put(path.join(b.project, "package.json"), { name: "app" });
		const marker = path.join(b.root, "ran-local-tls");
		const local = printer(path.join(b.project, "node_modules", ".bin", "typescript-language-server"), "6.0.2", marker);

		const before = await planJavascript(await contextFor(b));
		expect(fs.existsSync(marker)).toBe(false);
		expect(before.projectLocalExecutables).toEqual([local]);
		const fallback = installOf(before.lsp);
		expect(fallback.notes.join(" ")).toContain("approve that path");

		const after = await planJavascript(await contextFor(b), { approvedProjectLocal: [local] });
		expect(fs.existsSync(marker)).toBe(true);
		const reused = reuseOf(after.lsp);
		expect(reused.source).toBe("project-local");
		expect(reused.launch.command).toBe(local);
		// omp already resolves project bin directories itself, so nothing is written to the user's configuration.
		expect(reused.entries).toEqual([]);
	},
	SLOW,
);

test(
	"a server defined by project configuration is only checked after its path is approved",
	async () => {
		const b = box();
		const marker = path.join(b.root, "ran-project-tls");
		const server = printer(path.join(b.bin, "project-tls"), "6.0.2", marker);
		lspConfig(path.join(b.project, ".omp", "lsp.json"), "typescript-language-server", { command: server, fileTypes: [".ts"], rootMarkers: ["package.json"] });

		const before = blockedOf((await planJavascript(await contextFor(b))).lsp);
		expect(before.result.status).toBe("unverified");
		expect(before.result.detail).toContain("project configuration");
		expect(fs.existsSync(marker)).toBe(false);

		const plan = await planJavascript(await contextFor(b), { approvedProjectLocal: [server] });
		expect(plan.projectLocalExecutables).toEqual([]);
		expect(fs.existsSync(marker)).toBe(true);
		expect(reuseOf(plan.lsp).source).toBe("configured");
	},
	SLOW,
);

test(
	"configuration that omp may read but this tool cannot confirm is disclosed and never counted as effective",
	async () => {
		const b = box();
		tool(b, "node", "v24.22.0");
		tool(b, "npm", "10.9.2");
		typescript(b, "6.0.3");
		lspConfig(path.join(b.home, ".claude", "lsp.json"), "typescript-language-server", { command: "foreign-tls", fileTypes: [".ts"], rootMarkers: ["package.json"] });
		const plan = installOf((await planJavascript(await contextFor(b))).lsp);
		expect(plan.notes.join(" ")).toContain("cannot be established statically");
		expect(plan.notes.join(" ")).toContain(path.join(b.home, ".claude", "lsp.json"));
	},
	SLOW,
);

test(
	"an existing install directory is never short-circuited: the plan stays an install and the runtime validates the recipe",
	async () => {
		const b = box();
		tool(b, "node", "v24.22.0");
		typescript(b, "6.0.3");
		const runtime = runtimeFor(b);
		await ensureToolingRoots(b.agentDir);
		const destination = runtime.installDirectory("js-debug", "1.140.0");
		put(path.join(destination, "js-debug", "src", "dapDebugServer.js"), "// server\n");
		// Same tool and version, but not a manifest this runtime wrote for this recipe.
		put(path.join(destination, INSTALL_MANIFEST_FILE), { schema: 1, tool: "js-debug", version: "1.140.0", platform: "linux-x64" });

		const dap = installOf((await planJavascript(await contextFor(b, runtime))).dap);
		expect(dap.notes.join(" ")).toContain("validated and reused");
		const failure = await installError(runtime, dap);
		expect(failure.code).toBe("collision");
		expect(fs.existsSync(path.join(destination, "js-debug", "src", "dapDebugServer.js"))).toBe(true);
	},
	SLOW,
);

test(
	"without any tsc the mapped-TypeScript variant cannot run, so JavaScript/TypeScript debugging is blocked, never ready",
	async () => {
		const b = box();
		tool(b, "node", "v24.22.0");
		tool(b, "npm", "10.9.2");
		const plan = await planJavascript(await contextFor(b));
		// Both approved variants stay in the plan; the group is not silently narrowed to JavaScript.
		expect(plan.fixtures.map(item => item.id)).toEqual(["javascript", "typescript"]);
		const dap = blockedOf(plan.dap);
		expect(dap.result.status).toBe("needs-sdk");
		expect(dap.result.detail).toContain("source-mapped TypeScript");
		expect(dap.prerequisites.map(item => [item.name, item.satisfied])).toEqual([
			["node", true],
			["typescript", false],
		]);
		expect(blockedOf(plan.lsp).result.status).toBe("needs-sdk");

		// An effective configured js-debug adapter does not turn the same gap into a ready integration.
		const configured = box();
		tool(configured, "node", "v24.22.0");
		const adapter = tool(configured, "my-js-debug", "1.0.0");
		put(path.join(configured.agentDir, "dap.json"), { adapters: { "js-debug-adapter": { command: adapter, connectMode: "tcp" } } });
		const reused = await planJavascript(await contextFor(configured));
		expect(blockedOf(reused.dap).result.status).toBe("needs-sdk");
		expect(reused.fixtures.map(item => item.id)).toEqual(["javascript", "typescript"]);
	},
	SLOW,
);

test(
	"an approved project-local TypeScript is used in place and a withheld one is only disclosed",
	async () => {
		const b = box();
		tool(b, "node", "v24.22.0");
		tool(b, "npm", "10.9.2");
		put(path.join(b.project, "package.json"), { name: "app" });
		const marker = path.join(b.root, "ran-project-tsc");
		const local = printer(path.join(b.project, "node_modules", ".bin", "tsc"), "Version 6.0.3", marker);

		const before = await planJavascript(await contextFor(b));
		expect(fs.existsSync(marker)).toBe(false);
		expect(before.projectLocalExecutables).toEqual([local]);
		expect(blockedOf(before.lsp).result.status).toBe("needs-sdk");
		expect(blockedOf(before.dap).result.status).toBe("needs-sdk");
		expect(blockedOf(before.dap).prerequisites[1]?.remediation).toContain("approve that path");

		const after = await planJavascript(await contextFor(b), { approvedProjectLocal: [local] });
		expect(fs.existsSync(marker)).toBe(true);
		expect(after.projectLocalExecutables).toEqual([]);
		const lsp = installOf(after.lsp);
		expect(lsp.install.tool).toBe("typescript-language-server");
		// The language server finds the workspace's own tsserver; no path into the project is written to user config.
		expect(JSON.stringify(lsp.entries)).not.toContain("fallbackPath");
		expect(installOf(after.dap).install.tool).toBe("js-debug");
		expect(fixture(after, "typescript").build?.[0]?.command).toBe(local);
	},
	SLOW,
);

test(
	"an approved TypeScript 7 project-local compiler serves LSP natively without writing config",
	async () => {
		const b = box();
		put(path.join(b.project, "package.json"), { name: "app" });
		const local = printer(path.join(b.project, "node_modules", ".bin", "tsc"), "Version 7.0.2");
		const plan = await planJavascript(await contextFor(b), { approvedProjectLocal: [local] });
		const lsp = reuseOf(plan.lsp);
		expect([lsp.source, lsp.launch.command, lsp.entries]).toEqual(["project-local", local, []]);
	},
	SLOW,
);

// ── Python ──────────────────────────────────────────────────────────────────────────────────────


test(
	"only CPython 3.10 to 3.14 qualifies; anything else blocks both Python integrations with remediation",
	async () => {
		const cases: [string, boolean][] = [
			["3.9.18", false],
			["3.10.0", true],
			["3.14.1", true],
			["3.15.0", false],
		];
		for (const [found, ok] of cases) {
			const b = box();
			python(path.join(b.bin, "python3"), { version: found });
			const plan = await planPython(await contextFor(b));
			if (ok) {
				expect(plan.lsp.status).toBe("install");
				expect(plan.dap.status).toBe("install");
				expect(installOf(plan.lsp).install.version).toContain(`-py${found.split(".").slice(0, 2).join(".")}-`);
			} else {
				for (const integration of [plan.lsp, plan.dap]) {
					const blocked = blockedOf(integration);
					expect(blocked.result.status).toBe("needs-sdk");
					expect(blocked.result.detail).toContain(found);
					expect(blocked.result.detail).toContain("3.10-3.14");
				}
			}
		}
	},
	SLOW,
);

test(
	"a Python without venv/ensurepip, or no Python at all, blocks with manual remediation and never installs it",
	async () => {
		const noVenv = box();
		python(path.join(noVenv.bin, "python3"), { venv: false });
		const plan = await planPython(await contextFor(noVenv));
		for (const integration of [plan.lsp, plan.dap]) {
			const blocked = blockedOf(integration);
			expect(blocked.result.status).toBe("needs-sdk");
			expect(blocked.result.detail).toContain("python3-venv");
		}
		expect(plan.fixtures).toHaveLength(1);

		const none = box();
		const empty = await planPython(await contextFor(none));
		expect(blockedOf(empty.lsp).result.detail).toContain("never installs Python");
		expect(blockedOf(empty.dap).prerequisites[0]?.satisfied).toBe(false);
	},
	SLOW,
);

test(
	"an approved project interpreter becomes the Jedi and debug target while the venv is still built from the base Python",
	async () => {
		const b = box();
		const base = python(path.join(b.bin, "python3"));
		put(path.join(b.project, "pyproject.toml"), "[project]\nname = 'app'\n");
		const marker = path.join(b.root, "ran-project-python");
		const projectPython = python(path.join(b.project, ".venv", "bin", "python"), { version: "3.13.1", marker });

		const before = await planPython(await contextFor(b));
		expect(fs.existsSync(marker)).toBe(false);
		expect(before.projectLocalExecutables).toEqual([projectPython]);
		expect(installOf(before.lsp).entries[0]).toMatchObject({ value: { settings: { pylsp: { plugins: { jedi: { environment: base } } } } } });
		expect(installOf(before.lsp).notes.join(" ")).toContain("approve that path");

		const after = await planPython(await contextFor(b), { approvedProjectLocal: [projectPython] });
		expect(fs.existsSync(marker)).toBe(true);
		expect(after.projectLocalExecutables).toEqual([]);
		const lsp = installOf(after.lsp);
		const dap = installOf(after.dap);
		expect(lsp.entries[0]).toMatchObject({ value: { settings: { pylsp: { plugins: { jedi: { environment: projectPython } } } } } });
		expect(dap.entries[0]).toMatchObject({ value: { launchDefaults: { python: [projectPython] } } });
		// The base is what creates the venv; a project environment is never an installation base.
		expect(lsp.install.operations[1]).toMatchObject({ command: "python3" });
		expect(lsp.install.version).toContain("-py3.12-");
	},
	SLOW,
);

test(
	"an existing python-lsp-server is reused only from 1.15.0, and an existing debugpy only from 1.8.22",
	async () => {
		const reuse = box();
		const original = python(path.join(reuse.bin, "python3"), { debugpy: "1.8.23" });
		const pylsp = tool(reuse, "pylsp", "pylsp v1.15.1");
		const plan = await planPython(await contextFor(reuse));
		const lsp = reuseOf(plan.lsp);
		expect(lsp.source).toBe("path");
		expect(lsp.launch.command).toBe(pylsp);
		expect(lsp.entries[0]).toMatchObject({ value: { command: pylsp, settings: { pylsp: { plugins: { jedi: { environment: original } } } } } });
		const dap = reuseOf(plan.dap);
		expect(dap.source).toBe("path");
		expect(dap.launch).toEqual({ command: original, args: ["-m", "debugpy.adapter"] });
		expect(dap.entries[0]).toMatchObject({ value: { command: original, args: ["-m", "debugpy.adapter"] } });
		expect(JSON.stringify(dap.entries[0])).not.toContain("launchDefaults");

		const stale = box();
		python(path.join(stale.bin, "python3"), { debugpy: "1.8.21" });
		tool(stale, "pylsp", "pylsp v1.12.2");
		const old = await planPython(await contextFor(stale));
		const oldLsp = installOf(old.lsp);
		expect(oldLsp.notes.join(" ")).toContain("1.12.2");
		expect(installOf(old.dap).notes.join(" ")).toContain("1.8.21");
	},
	SLOW,
);

// ── Go ──────────────────────────────────────────────────────────────────────────────────────────


test(
	"an unsupported platform gets no managed install for any group",
	async () => {
		const b = box();
		tool(b, "go", "go version go1.27.2 linux/amd64");
		tool(b, "node", "v24.22.0");
		typescript(b, "6.0.3");
		python(path.join(b.bin, "python3"));
		const runtime = runtimeFor(b, { platform: "freebsd", arch: "x64" });
		const go = await planGo(await contextFor(b, runtime));
		const py = await planPython(await contextFor(b, runtime));
		const js = await planJavascript(await contextFor(b, runtime));
		for (const integration of [go.lsp, go.dap, py.lsp, py.dap, js.dap]) {
			expect(blockedOf(integration).result.status).toBe("unsupported");
		}
	},
	SLOW,
);

test(
	"Go 1.27.0 is the boundary and an older Go blocks both integrations without toolchain downloads",
	async () => {
		const old = box();
		tool(old, "go", "go version go1.26.9 linux/amd64");
		const blockedPlan = await planGo(await contextFor(old));
		for (const integration of [blockedPlan.lsp, blockedPlan.dap]) {
			const plan = blockedOf(integration);
			expect(plan.result.status).toBe("needs-sdk");
			expect(plan.result.detail).toContain("1.26.9");
			expect(plan.result.detail).toContain("never installs or upgrades Go");
		}

		const exact = box();
		tool(exact, "go", "go version go1.27.0 linux/amd64");
		const okPlan = await planGo(await contextFor(exact));
		expect(installOf(okPlan.lsp).install.version).toBe("v0.24.0-go1.27");
		expect(okPlan.dap.status).toBe("install");

		const absent = box();
		const none = await planGo(await contextFor(absent));
		expect(blockedOf(none.lsp).result.status).toBe("needs-sdk");
		expect(blockedOf(none.dap).prerequisites[0]?.satisfied).toBe(false);
	},
	SLOW,
);

test(
	"existing gopls and dlv are reused only when compatible and are otherwise left untouched",
	async () => {
		const reuse = box();
		tool(reuse, "go", "go version go1.27.2 linux/amd64");
		const gopls = tool(reuse, "gopls", "golang.org/x/tools/gopls v0.24.1");
		const dlv = tool(reuse, "dlv", "Delve Debugger\nVersion: 1.27.2\nBuild: release");
		const plan = await planGo(await contextFor(reuse));
		const lsp = reuseOf(plan.lsp);
		const dap = reuseOf(plan.dap);
		expect([lsp.source, lsp.launch.command, lsp.entries]).toEqual(["path", gopls, []]);
		expect([dap.source, dap.launch.command, dap.entries]).toEqual(["path", dlv, []]);

		const stale = box();
		tool(stale, "go", "go version go1.27.2 linux/amd64");
		tool(stale, "gopls", "golang.org/x/tools/gopls v0.23.0");
		tool(stale, "dlv", "Delve Debugger\nVersion: 1.26.0");
		const old = await planGo(await contextFor(stale));
		expect(installOf(old.lsp).notes.join(" ")).toContain("0.23.0");
		expect(installOf(old.dap).notes.join(" ")).toContain("1.26.0");
	},
	SLOW,
);


test("configured protocol arguments inherit when omitted but an explicit empty override is preserved", async () => {
	const b = box();
	tool(b, "node", "v24.22.0");
	typescript(b, "6.0.3");
	const server = tool(b, "typescript-language-server", "6.0.2");
	const configFile = path.join(b.agentDir, "lsp.json");
	lspConfig(configFile, "typescript-language-server", { command: server });
	const inheritedBytes = fs.readFileSync(configFile, "utf8");
	const inherited = await planJavascript(await contextFor(b));
	expect(reuseOf(inherited.lsp).launch.args).toEqual(["--stdio"]);
	expect(fs.readFileSync(configFile, "utf8")).toBe(inheritedBytes);

	lspConfig(configFile, "typescript-language-server", { command: server, args: [] });
	const explicitBytes = fs.readFileSync(configFile, "utf8");
	const explicit = await planJavascript(await contextFor(b));
	expect(reuseOf(explicit.lsp).launch.args).toEqual([]);
	expect(fs.readFileSync(configFile, "utf8")).toBe(explicitBytes);
}, SLOW);
