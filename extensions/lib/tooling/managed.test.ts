import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { inspectConfig } from "./config";
import { planGo, planJavascript, planPython } from "./managed";
import { createRuntime, INSTALL_MANIFEST_FILE, RuntimeError } from "./runtime";
import type {
	Artifact,
	BlockedPlan,
	FixtureCase,
	InstallOperation,
	InstallPlan,
	IntegrationPlan,
	LanguagePlan,
	PlanContext,
	PlatformInput,
	ReusePlan,
	RunOperation,
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

function committed(name: string): string {
	return fs.readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");
}

function writtenContent(operation: InstallOperation | undefined): string {
	if (operation?.type !== "write-file") throw new Error("expected a write-file operation");
	return operation.content;
}

function runOf(operation: InstallOperation | undefined): RunOperation {
	if (operation?.type !== "run") throw new Error("expected a run operation");
	return operation;
}

function artifactOf(operation: InstallOperation | undefined): Artifact {
	if (operation?.type !== "artifact") throw new Error("expected an artifact operation");
	return operation.artifact;
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

const HEX64 = /^[0-9a-f]{64}$/;

// ── JavaScript / TypeScript ─────────────────────────────────────────────────────────────────────

test(
	"TypeScript 6 installs only typescript-language-server from the committed npm lock, pointed at the existing tsserver",
	async () => {
		const b = box();
		const node = tool(b, "node", "v24.22.0");
		tool(b, "npm", "10.9.2");
		const sdk = typescript(b, "6.0.3");
		const plan = await planJavascript(await contextFor(b));

		const lsp = installOf(plan.lsp);
		const destination = path.join(b.agentDir, "tooling", "typescript-language-server", "6.0.2", "linux-x64");
		expect(lsp.install.tool).toBe("typescript-language-server");
		expect(lsp.install.version).toBe("6.0.2");
		expect(lsp.tool.destination).toBe(destination);
		expect(lsp.install.executables).toEqual(["node_modules/.bin/typescript-language-server"]);

		const lock = committed("typescript-package-lock.json");
		const [manifest, lockfile, run] = lsp.install.operations;
		expect(manifest).toMatchObject({ type: "write-file", path: "package.json" });
		expect(lockfile).toEqual({ type: "write-file", path: "package-lock.json", content: lock });
		expect(run).toEqual({ type: "run", command: "npm", args: ["ci", "--ignore-scripts", "--no-audit", "--no-fund"] });
		expect(lsp.install.operations.some(operation => operation.type === "artifact")).toBe(false);

		// The lock holds exactly one package with a registry integrity hash, and never the TypeScript compiler.
		const parsed = JSON.parse(lock);
		expect(parsed.lockfileVersion).toBe(3);
		expect(Object.keys(parsed.packages)).toEqual(["", "node_modules/typescript-language-server"]);
		expect(parsed.packages["node_modules/typescript-language-server"]).toMatchObject({ version: "6.0.2" });
		expect(parsed.packages["node_modules/typescript-language-server"].integrity).toMatch(/^sha512-/);
		const packageJson = JSON.parse(writtenContent(manifest));
		expect(packageJson.dependencies).toEqual(parsed.packages[""].dependencies);
		expect(packageJson.dependencies).toEqual({ "typescript-language-server": "6.0.2" });

		const command = path.join(destination, "node_modules", ".bin", "typescript-language-server");
		expect(lsp.launch).toEqual({ command, args: ["--stdio"] });
		expect(lsp.entries).toHaveLength(1);
		expect(lsp.entries[0]).toMatchObject({
			kind: "lsp",
			key: "typescript-language-server",
			value: { command, args: ["--stdio"], initOptions: { tsserver: { fallbackPath: sdk.lib } } },
		});
		expect(lsp.prerequisites.map(item => [item.name, item.satisfied])).toEqual([
			["node", true],
			["typescript", true],
			["npm", true],
		]);

		// js-debug: the pinned release asset, run by node with an explicit loopback TCP port; the server is data, not an executable.
		const dap = installOf(plan.dap);
		const server = path.join(b.agentDir, "tooling", "js-debug", "1.140.0", "linux-x64", "js-debug", "src", "dapDebugServer.js");
		expect(dap.install.operations).toHaveLength(1);
		expect(dap.install.operations[0]).toMatchObject({
			type: "artifact",
			artifact: {
				url: "https://github.com/microsoft/vscode-js-debug/releases/download/v1.140.0/js-debug-dap-v1.140.0.tar.gz",
				sha256: "27dab92937ec1ab35821ae955aac867544fe06a1b6307229049f2d789af10968",
				format: "tar.gz",
			},
		});
		expect(dap.install.executables ?? []).toEqual([]);
		expect(dap.launch).toEqual({ command: node, args: [server, "${port}", "127.0.0.1"] });
		expect(dap.entries).toEqual([{ kind: "dap", key: "js-debug-adapter", value: { command: node, args: [server, "${port}", "127.0.0.1"], connectMode: "tcp" } }]);
		expect(dap.prerequisites.map(item => item.name)).toEqual(["node"]);
		expect(dap.notes.join(" ")).toContain("loopback");

		expect(plan.projectLocalExecutables).toEqual([]);
		expect(plan.fixtures.map(item => item.id)).toEqual(["javascript", "typescript"]);
		expect(fixture(plan, "javascript").lsp.server).toBe("typescript-language-server");
		const mapped = fixture(plan, "typescript");
		expect(mapped.build).toEqual([{ label: "compile TypeScript with source maps", command: sdk.tsc, args: ["-p", "."] }]);
		expect(mapped.dap).toMatchObject({ adapter: "js-debug-adapter", program: "dist/main.js", breakpoint: { file: "main.ts" } });
	},
	SLOW,
);

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
	"TypeScript 5 or no TypeScript blocks only the language server; the debugger and the JavaScript fixture are unaffected",
	async () => {
		const old = box();
		tool(old, "node", "v22.22.2");
		const oldSdk = typescript(old, "5.9.3");
		const oldPlan = await planJavascript(await contextFor(old));
		const oldLsp = blockedOf(oldPlan.lsp);
		expect(oldLsp.result.status).toBe("needs-sdk");
		expect(oldLsp.result.detail).toContain("5.9.3");
		expect(oldLsp.result.detail).toContain("typescript@6");
		expect(installOf(oldPlan.dap).install.tool).toBe("js-debug");
		// A 5.x `tsc` still compiles the fixture, so source-mapped debugging stays covered.
		expect(fixture(oldPlan, "typescript").build?.[0]?.command).toBe(oldSdk.tsc);

		const none = box();
		tool(none, "node", "v22.22.2");
		const nonePlan = await planJavascript(await contextFor(none));
		const noneLsp = blockedOf(nonePlan.lsp);
		expect(noneLsp.result.status).toBe("needs-sdk");
		expect(noneLsp.result.detail).toContain("never installs a TypeScript compiler");
		expect(installOf(nonePlan.dap).install.tool).toBe("js-debug");
		expect(nonePlan.fixtures.map(item => item.id)).toEqual(["javascript"]);
		expect(installOf(nonePlan.dap).notes.join(" ")).toContain("source-mapped TypeScript debugging is not verified");
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
	"a published js-debug install is reused without installing again",
	async () => {
		const b = box();
		tool(b, "node", "v24.22.0");
		const runtime = runtimeFor(b);
		const destination = runtime.installDirectory("js-debug", "1.140.0");
		put(path.join(destination, "js-debug", "src", "dapDebugServer.js"), "// server\n");
		put(path.join(destination, INSTALL_MANIFEST_FILE), { schema: 1, tool: "js-debug", version: "1.140.0", platform: "linux-x64" });
		const dap = reuseOf((await planJavascript(await contextFor(b, runtime))).dap);
		expect(dap.source).toBe("managed");
		expect(dap.entries).toHaveLength(1);
	},
	SLOW,
);

test(
	"the pinned js-debug digest is enforced by the real installer: a tampered download publishes nothing",
	async () => {
		const b = box();
		tool(b, "node", "v24.22.0");
		const runtime = runtimeFor(b, UBUNTU, { fetch: async () => new Response("not the pinned release bytes") });
		const dap = installOf((await planJavascript(await contextFor(b, runtime))).dap);

		const failure = await installError(runtime, dap);
		expect(failure.code).toBe("integrity");
		expect(failure.message).toContain("27dab92937ec1ab35821ae955aac867544fe06a1b6307229049f2d789af10968");
		expect(fs.existsSync(dap.tool.destination as string)).toBe(false);
	},
	SLOW,
);

// ── Python ──────────────────────────────────────────────────────────────────────────────────────

test(
	"Python builds one private venv from the hash-locked wheels and targets the original interpreter",
	async () => {
		const b = box();
		const original = python(path.join(b.bin, "python3"));
		const plan = await planPython(await contextFor(b));

		const lsp = installOf(plan.lsp);
		const dap = installOf(plan.dap);
		// One request serves both integrations, so the second install is a reuse of the first.
		expect(dap.install).toEqual(lsp.install);
		expect(lsp.install.tool).toBe("python-tools");
		expect(lsp.install.version).toMatch(/^pylsp1\.15\.0-debugpy1\.8\.22-py3\.12-[0-9a-f]{8}$/);
		const lock = committed("python-requirements.lock");
		const [writeLock, venv, pip, check] = lsp.install.operations;
		expect(writeLock).toEqual({ type: "write-file", path: "requirements.lock", content: lock });
		expect(venv).toEqual({ type: "run", command: "python3", args: ["-m", "venv", "@INSTALL_DIR@/venv"] });
		expect(pip).toMatchObject({ type: "run", command: "@INSTALL_DIR@/venv/bin/python" });
		const pipArgs = runOf(pip).args;
		for (const flag of ["--isolated", "--only-binary=:all:", "--require-hashes", "--no-deps", "--no-input"]) expect(pipArgs).toContain(flag);
		expect(pipArgs.slice(-2)).toEqual(["-r", "requirements.lock"]);
		expect(check).toEqual({ type: "run", command: "@INSTALL_DIR@/venv/bin/python", args: ["-m", "pip", "check"] });
		expect(lsp.install.executables).toEqual(["venv/bin/python"]);

		// -m launches survive the relocated venv; console-script shebangs would not.
		const venvPython = path.join(lsp.tool.destination as string, "venv", "bin", "python");
		expect(lsp.launch).toEqual({ command: venvPython, args: ["-m", "pylsp"] });
		expect(dap.launch).toEqual({ command: venvPython, args: ["-m", "debugpy.adapter"] });
		expect(lsp.entries[0]).toMatchObject({
			kind: "lsp",
			key: "pylsp",
			value: { command: venvPython, args: ["-m", "pylsp"], settings: { pylsp: { plugins: { jedi: { environment: original } } } } },
		});
		expect(dap.entries[0]).toMatchObject({
			kind: "dap",
			key: "debugpy",
			value: { command: venvPython, args: ["-m", "debugpy.adapter"], launchDefaults: { python: [original] } },
		});
		expect(lsp.prerequisites.map(item => item.name)).toEqual(["python"]);
		expect(plan.fixtures.map(item => item.id)).toEqual(["python"]);
	},
	SLOW,
);

test("the committed Python lock is fully pinned with hashes for every requirement", () => {
	const lock = committed("python-requirements.lock");
	const blocks = lock.split(/\n(?=\S)/).filter(block => /^[A-Za-z0-9._-]+==/.test(block));
	const names = blocks.map(block => /^([A-Za-z0-9._-]+)==/.exec(block)?.[1] ?? "");
	// Every declared dependency of python-lsp-server stays, including the ones a lean install would drop.
	for (const required of ["python-lsp-server", "python-lsp-jsonrpc", "jedi", "parso", "pluggy", "docstring-to-markdown", "ujson", "black", "debugpy"]) {
		expect(names).toContain(required);
	}
	expect(lock).toContain("python-lsp-server==1.15.0");
	expect(lock).toContain("debugpy==1.8.22");
	expect(lock).toContain("ujson==5.11.0");
	for (const block of blocks) {
		const hashes = [...block.matchAll(/--hash=sha256:([0-9a-f]+)/g)].map(match => match[1] ?? "");
		expect(hashes.length).toBeGreaterThan(0);
		for (const hash of hashes) expect(hash).toMatch(HEX64);
	}
	// No unpinned, URL, path or editable requirement can slip into a --require-hashes install.
	expect(lock).not.toMatch(/^\s*(-e|--index-url|--extra-index-url|git\+|https?:)/m);
	// Version-conditional requirements keep their markers: a lean single-interpreter lock would drop them.
	expect(lock).toContain("importlib-metadata==9.0.1 ; python_full_version < '3.11'");
	expect(lock).toContain("importlib-metadata==10.1.0 ; python_full_version >= '3.11'");
});

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
	"Go installs gopls with the existing Go (local toolchain only) and Delve from the pinned platform asset",
	async () => {
		const b = box();
		const go = tool(b, "go", "go version go1.27.2 linux/amd64");
		const plan = await planGo(await contextFor(b));

		const lsp = installOf(plan.lsp);
		expect(lsp.install.tool).toBe("gopls");
		expect(lsp.install.version).toBe("v0.24.0-go1.27");
		expect(lsp.install.operations).toEqual([
			{ type: "run", command: "go", args: ["install", "golang.org/x/tools/gopls@v0.24.0"], env: { GOBIN: "@INSTALL_DIR@/bin" } },
		]);
		// The recipe sets no toolchain, checksum or proxy override: the runtime forces GOTOOLCHAIN=local, GOSUMDB and a private module cache.
		expect(Object.keys(runOf(lsp.install.operations[0]).env ?? {})).toEqual(["GOBIN"]);
		expect(lsp.install.executables).toEqual(["bin/gopls"]);
		const gopls = path.join(lsp.tool.destination as string, "bin", "gopls");
		expect(lsp.launch).toEqual({ command: gopls, args: ["serve"] });
		expect(lsp.entries[0]).toMatchObject({ kind: "lsp", key: "gopls", value: { command: gopls, args: ["serve"], rootMarkers: ["go.mod", "go.work", "go.sum"] } });
		expect(lsp.prerequisites[0]).toMatchObject({ name: "go", satisfied: true, found: { path: go, version: "1.27.2" } });

		const dap = installOf(plan.dap);
		expect(dap.install.tool).toBe("delve");
		expect(dap.install.version).toBe("1.27.2");
		expect(dap.install.operations).toEqual([
			{
				type: "artifact",
				artifact: expect.objectContaining({
					url: "https://github.com/go-delve/delve/releases/download/v1.27.2/dlv_1.27.2_linux_amd64.tar.gz",
					sha256: "30783eb68dc1598d965491cc97762270cd63ce13f09d0cac22faa7e3eafc1b9c",
					format: "tar.gz",
					reviewed: "2026-10-26",
				}),
			},
		]);
		expect(dap.install.executables).toEqual(["dlv"]);
		const dlv = path.join(dap.tool.destination as string, "dlv");
		expect(dap.launch).toEqual({ command: dlv, args: ["dap"] });
		expect(dap.entries).toEqual([{ kind: "dap", key: "dlv", value: { command: dlv, args: ["dap"], connectMode: "socket", acceptsDirectoryProgram: true } }]);

		const go1 = fixture(plan, "go");
		expect(go1.build).toEqual([{ label: "compile the package", command: go, args: ["build", "./..."] }]);
		expect(go1.dap).toMatchObject({ adapter: "dlv", program: "." });
	},
	SLOW,
);

test(
	"Delve picks the release asset and digest for each supported platform",
	async () => {
		const expected: [PlatformInput, string, string][] = [
			[UBUNTU, "linux_amd64", "30783eb68dc1598d965491cc97762270cd63ce13f09d0cac22faa7e3eafc1b9c"],
			[{ platform: "darwin", arch: "x64" }, "darwin_amd64", "66992990307bd0328994960df0cbfa34ecfb16e9cd32f5cf6c83c34912e59cc3"],
			[{ platform: "darwin", arch: "arm64" }, "darwin_arm64", "c32fc68e11ff3820ba267ab12c96fa68e3804319f807fc5db4fba3b9d868df26"],
		];
		for (const [platform, asset, sha256] of expected) {
			const b = box();
			tool(b, "go", "go version go1.27.2 linux/amd64");
			const dap = installOf((await planGo(await contextFor(b, runtimeFor(b, platform)))).dap);
			const artifact = artifactOf(dap.install.operations[0]);
			expect(artifact.url).toBe(`https://github.com/go-delve/delve/releases/download/v1.27.2/dlv_1.27.2_${asset}.tar.gz`);
			expect(artifact.sha256).toBe(sha256);
			expect(dap.notes.join(" ")).toContain(platform.platform === "darwin" ? "Command Line Tools" : "ptrace");
		}
	},
	SLOW,
);

test(
	"an unsupported platform gets no managed install for any group",
	async () => {
		const b = box();
		tool(b, "go", "go version go1.27.2 linux/amd64");
		tool(b, "node", "v24.22.0");
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

// ── Pins and fixtures ───────────────────────────────────────────────────────────────────────────

test(
	"every pinned asset is an HTTPS GitHub release asset with a SHA-256 digest, a review date and provenance",
	async () => {
		const artifacts: { url: string; sha256: string; reviewed: string; provenance: string; version: string }[] = [];
		for (const platform of [UBUNTU, { platform: "darwin", arch: "x64" }, { platform: "darwin", arch: "arm64" }] satisfies PlatformInput[]) {
			const b = box();
			tool(b, "go", "go version go1.27.2 linux/amd64");
			tool(b, "node", "v24.22.0");
			const runtime = runtimeFor(b, platform);
			for (const plan of [(await planGo(await contextFor(b, runtime))).dap, (await planJavascript(await contextFor(b, runtime))).dap]) {
				for (const operation of installOf(plan).install.operations) {
					if (operation.type === "artifact") artifacts.push(operation.artifact);
				}
			}
		}
		expect(artifacts).toHaveLength(6);
		for (const artifact of artifacts) {
			const url = new URL(artifact.url);
			expect(url.protocol).toBe("https:");
			expect(url.hostname).toBe("github.com");
			expect(url.pathname).toMatch(/\/releases\/download\/v\d+\.\d+\.\d+\//);
			expect(artifact.sha256).toMatch(HEX64);
			expect(artifact.reviewed).toBe("2026-10-26");
			expect(artifact.provenance.length).toBeGreaterThan(10);
			expect(artifact.version).toMatch(/^v\d+\.\d+\.\d+$/);
		}
	},
	SLOW,
);

test(
	"each fixture is self-consistent: references, definitions, breakpoints and the debugged variable match the files",
	async () => {
		const b = box();
		tool(b, "node", "v24.22.0");
		tool(b, "npm", "10.9.2");
		typescript(b, "6.0.3");
		tool(b, "go", "go version go1.27.2 linux/amd64");
		python(path.join(b.bin, "python3"));
		const context = await contextFor(b);
		const plans = [await planJavascript(context), await planPython(context), await planGo(context)];
		const fixtures = plans.flatMap(plan => plan.fixtures);
		expect(fixtures.map(item => item.id)).toEqual(["javascript", "typescript", "python", "go"]);
		expect(plans.map(plan => plan.language)).toEqual(["javascript", "python", "go"]);

		for (const item of fixtures) {
			const lines = (file: string): string[] => {
				const found = item.files.find(candidate => candidate.path === file);
				if (found === undefined) throw new Error(`${item.id}: ${file} is not a fixture file`);
				return found.content.split("\n");
			};
			const paths = item.files.map(file => file.path);
			expect(new Set(paths).size).toBe(paths.length);
			for (const file of item.files) expect(path.isAbsolute(file.path) || file.path.includes("..")).toBe(false);

			// LSP: the 1-based line holds the symbol; the definition line is the declaration in the other file.
			expect(lines(item.lsp.file)[item.lsp.line - 1]).toContain(item.lsp.symbol);
			expect(item.lsp.definition.file).not.toBe(item.lsp.file);
			expect(lines(item.lsp.definition.file)[item.lsp.definition.line - 1]).toMatch(new RegExp(`(function|def|func) ${item.lsp.symbol}\\(`));

			// DAP: the breakpoint is the line that returns the variable, which an earlier line assigned `6 * 7`.
			const body = lines(item.dap.breakpoint.file);
			expect(item.dap.variable).toEqual({ name: "answer", value: "42" });
			expect(body[item.dap.breakpoint.line - 1]).toContain("return answer");
			expect(body.slice(0, item.dap.breakpoint.line - 1).join("\n")).toMatch(/answer\s*(:=|=)|const answer/);
			expect(item.files.some(file => file.content.includes("compute(6, 7)"))).toBe(true);
			// A launch target is a fixture file, a built output, or the package directory itself.
			expect(paths.includes(item.dap.program) || item.build !== undefined || item.dap.program === ".").toBe(true);
		}

		// Structured fixture files are valid JSON.
		for (const file of fixtures.flatMap(item => item.files).filter(entry => entry.path.endsWith(".json"))) JSON.parse(file.content);

		// JS and mapped TS both debug in a source file and through js-debug; the TS fixture debugs the .ts through its compiled output.
		const mapped = fixtures.find(item => item.id === "typescript");
		expect(mapped?.dap.breakpoint.file).toBe("main.ts");
		expect(mapped?.dap.program).toBe("dist/main.js");
		expect(mapped?.files.find(file => file.path === "tsconfig.json")?.content).toContain('"sourceMap": true');
		// The Python debug target must not import a sibling module: the verifier sets PYTHONSAFEPATH.
		const pythonFixture = fixtures.find(item => item.id === "python");
		expect(pythonFixture?.files.find(file => file.path === "fixture_debug.py")?.content).not.toMatch(/\bimport\b/);
		expect(pythonFixture?.dap.adapter).toBe("debugpy");
		expect(pythonFixture?.lsp.server).toBe("pylsp");
		expect(fixtures.find(item => item.id === "go")?.lsp.server).toBe("gopls");
	},
	SLOW,
);
