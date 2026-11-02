import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { inspectConfig } from "./config";
import { bunDebuggerRequest, planGo, planJavascript, planPython, typescriptServerOperations } from "./managed";
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

/**
 * A fake `bun`: answers its own version for `--version`, and `serverVersion` when asked for the version of a script it
 * was told to run (`bun --bun <script> --version`), which is how the language server is probed. Every call is logged to
 * `marker` when given.
 */
function bunSdk(b: Box, options: { version?: string; serverVersion?: string; marker?: string } = {}): string {
	return script(
		path.join(b.bin, "bun"),
		[
			...(options.marker === undefined ? [] : [`echo "$*" >> "${options.marker}"`]),
			'case "$*" in',
			`"--bun "*" --version") echo "${options.serverVersion ?? "6.0.2"}" ;;`,
			`*) echo "${options.version ?? "1.4.4"}" ;;`,
			"esac",
		].join("\n"),
	);
}

/** Node, Bun and an npm-style TypeScript 6 SDK: everything the JavaScript group needs. */
function javascriptToolchain(b: Box, tscVersion = "6.0.3"): { bun: string; tsc: string; lib: string } {
	tool(b, "node", "v24.22.0");
	const bun = bunSdk(b);
	return { bun, ...typescript(b, tscVersion) };
}

test(
	"an existing TypeScript 7 uses its native server: no install, no npm, and a missing Bun blocks only the debugger",
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
		expect(dap.result.detail).toContain("bun >= 1.4.4");
		expect("companions" in dap).toBe(false);
	},
	SLOW,
);

test(
	"TypeScript 5 blocks only the language server; the debugger and every fixture use its compiler",
	async () => {
		const old = box();
		tool(old, "node", "v22.22.2");
		bunSdk(old);
		const oldSdk = typescript(old, "5.9.3");
		const plan = await planJavascript(await contextFor(old));
		const lsp = blockedOf(plan.lsp);
		expect(lsp.result.status).toBe("needs-sdk");
		expect(lsp.result.detail).toContain("5.9.3");
		expect(lsp.result.detail).toContain("typescript@6");
		expect(installOf(plan.dap).install.tool).toBe("js-debug");
		expect(plan.fixtures.map(item => item.id)).toEqual(["javascript", "typescript", "bun"]);
		expect(fixture(plan, "typescript").build?.[0]?.command).toBe(oldSdk.tsc);
	},
	SLOW,
);

test(
	"Bun 1.4.4 is the boundary for the language server and for both debuggers, and a missing Bun is never installed",
	async () => {
		const below = box();
		tool(below, "node", "v24.22.0");
		bunSdk(below, { version: "1.4.3" });
		typescript(below, "6.0.3");
		const blockedPlan = await planJavascript(await contextFor(below));
		for (const integration of [blockedPlan.lsp, blockedPlan.dap]) {
			const plan = blockedOf(integration);
			expect(plan.result.status).toBe("needs-sdk");
			expect(plan.result.detail).toContain("1.4.4");
			expect(plan.result.detail).toContain("1.4.3");
		}
		expect(blockedPlan.dap.notes.join(" ")).toContain("Both debuggers run on Bun");

		const exact = box();
		tool(exact, "node", "v24.22.0");
		bunSdk(exact, { version: "1.4.4" });
		typescript(exact, "6.0.3");
		const okPlan = await planJavascript(await contextFor(exact));
		expect(okPlan.lsp.status).toBe("install");
		expect(okPlan.dap.status).toBe("install");

		const absent = box();
		tool(absent, "node", "v24.22.0");
		typescript(absent, "6.0.3");
		const none = await planJavascript(await contextFor(absent));
		expect(blockedOf(none.lsp).prerequisites.map(item => [item.name, item.satisfied])).toEqual([
			["bun", false],
			["typescript", true],
		]);
		expect(blockedOf(none.dap).result.status).toBe("needs-sdk");
	},
	SLOW,
);

test(
	"Node 22.22.2 is the boundary for the programs js-debug debugs, and a missing Node does not touch the language server",
	async () => {
		const below = box();
		tool(below, "node", "v22.22.1");
		bunSdk(below);
		typescript(below, "6.0.3");
		const plan = await planJavascript(await contextFor(below));
		expect(plan.lsp.status).toBe("install");
		const dap = blockedOf(plan.dap);
		expect(dap.result.status).toBe("needs-sdk");
		expect(dap.result.detail).toContain("22.22.2");
		expect(dap.result.detail).toContain("22.22.1");

		const exact = box();
		tool(exact, "node", "v22.22.2");
		bunSdk(exact);
		typescript(exact, "6.0.3");
		expect((await planJavascript(await contextFor(exact))).dap.status).toBe("install");
	},
	SLOW,
);

test(
	"the language server installs from the committed Bun lock and runs its own script on Bun, never through the Node shebang",
	async () => {
		const b = box();
		const sdk = javascriptToolchain(b);
		const runtime = runtimeFor(b);
		const plan = installOf((await planJavascript(await contextFor(b, runtime))).lsp);

		const destination = runtime.installDirectory("typescript-language-server", "6.0.2");
		const cli = path.join(destination, "node_modules", "typescript-language-server", "lib", "cli.mjs");
		expect(plan.launch).toEqual({ command: sdk.bun, args: ["--bun", cli, "--stdio"] });
		expect(plan.entries[0]).toMatchObject({ key: "typescript-language-server", value: { command: sdk.bun, args: ["--bun", cli, "--stdio"], initOptions: { tsserver: { fallbackPath: sdk.lib } } } });
		expect(plan.prerequisites.map(item => item.name)).toEqual(["bun", "typescript"]);

		const runs = plan.install.operations.filter(operation => operation.type === "run");
		expect(runs[0]).toMatchObject({ command: "bun", args: ["install", "--frozen-lockfile", "--ignore-scripts"] });
		const written = plan.install.operations.filter(operation => operation.type === "write-file").map(operation => operation.path);
		expect(written).toEqual(["package.json", "bun.lock"]);
		// No npm process and no package-lock.json anywhere in the recipe.
		expect(JSON.stringify(plan.install.operations)).not.toContain("npm");
		expect(JSON.stringify(plan.install.operations)).not.toContain("package-lock");
	},
	SLOW,
);

test(
	"a lock file that does not pin the server is refused before anything runs, so a missing lock never means an unpinned install",
	() => {
		expect(() => typescriptServerOperations("")).toThrow("refusing an unpinned install");
		expect(() => typescriptServerOperations('{ "packages": { "typescript-language-server": ["typescript-language-server@5.1.3", "", {}, "sha512-AAAA"] } }')).toThrow("unpinned");
		const withoutIntegrity = '{ "packages": { "typescript-language-server": ["typescript-language-server@6.0.2", "", {}] } }';
		expect(() => typescriptServerOperations(withoutIntegrity)).toThrow("integrity");
		const committed = fs.readFileSync(new URL("./typescript-bun.lock", import.meta.url), "utf8");
		expect(typescriptServerOperations(committed).map(operation => operation.type)).toEqual(["write-file", "write-file", "run", "run"]);
	},
	SLOW,
);

test(
	"the language server recipe installs through the runtime, and an installed version other than the pinned one fails it before anything is published",
	async () => {
		// A `bun` whose `install` lays down the server at a version the test chooses; every other call (the version check runs `bun --bun -e`) is the real Bun.
		for (const [installed, ok] of [
			["6.0.2", true],
			["6.0.3", false],
		] as const) {
			const room = box();
			tool(room, "node", "v24.22.0");
			typescript(room, "6.0.3");
			// The private PATH holds no coreutils, so the fake lays the files down with the real Bun.
			const lay =
				'const fs = require("node:fs");' +
				'fs.mkdirSync("node_modules/typescript-language-server", { recursive: true });' +
				'fs.mkdirSync("node_modules/.bin", { recursive: true });' +
				`fs.writeFileSync("node_modules/typescript-language-server/package.json", JSON.stringify({ version: "${installed}" }));` +
				'fs.writeFileSync("node_modules/typescript-language-server/cli.mjs", "#!/bin/sh\\n", { mode: 0o755 });' +
				'fs.symlinkSync("../typescript-language-server/cli.mjs", "node_modules/.bin/typescript-language-server");';
			script(
				path.join(room.bin, "bun"),
				[
					'if [ "$1" = "install" ]; then',
					'  [ -f bun.lock ] && [ -f package.json ] || { echo "no lock" >&2; exit 1; }',
					`  exec "${process.execPath}" -e '${lay}'`,
					"fi",
					`exec "${process.execPath}" "$@"`,
				].join("\n"),
			);
			const runtime = runtimeFor(room);
			await ensureToolingRoots(room.agentDir);
			const plan = installOf((await planJavascript(await contextFor(room, runtime))).lsp);
			if (ok) {
				expect((await runtime.install(plan.install)).status).toBe("installed");
			} else {
				const failure = await installError(runtime, plan);
				expect(failure.code).toBe("exit");
				expect(failure.message).toContain("6.0.3 was installed");
				expect(fs.existsSync(runtime.installDirectory("typescript-language-server", "6.0.2"))).toBe(false);
			}
		}
	},
	SLOW,
);

test(
	"an installed typescript-language-server is reused only when it is 6.0.2 or newer 6.x, and an old one is left alone",
	async () => {
		const good = box();
		const sdk = javascriptToolchain(good);
		const server = tool(good, "typescript-language-server", "6.0.4");
		const reused = reuseOf((await planJavascript(await contextFor(good))).lsp);
		expect(reused.source).toBe("path");
		// A native tool is reused as it is; only Node scripts are re-launched on Bun.
		expect(reused.launch.command).toBe(server);
		expect(reused.tool.version).toBe("6.0.4");
		expect(reused.entries[0]).toMatchObject({ key: "typescript-language-server", value: { command: server, initOptions: { tsserver: { fallbackPath: sdk.lib } } } });

		const old = box();
		javascriptToolchain(old);
		tool(old, "typescript-language-server", "5.1.3");
		const plan = installOf((await planJavascript(await contextFor(old))).lsp);
		expect(plan.install.version).toBe("6.0.2");
		expect(plan.notes.join(" ")).toContain("5.1.3");
	},
	SLOW,
);

test(
	"an installed Node-script typescript-language-server on PATH is reused as `bun --bun <script>`, checked the same way",
	async () => {
		const b = box();
		const marker = path.join(b.root, "node-ran");
		tool(b, "node", "v24.22.0");
		// If this shim ran on Node through its shebang, it would leave the marker.
		const real = script(path.join(b.root, "global", "lib", "cli.mjs"), `echo ran >> "${marker}"\necho 6.0.4`);
		fs.writeFileSync(real, `#!/usr/bin/env node\necho ran >> "${marker}"\n`, { mode: 0o755 });
		fs.symlinkSync(real, path.join(b.bin, "typescript-language-server"));
		const bunPath = bunSdk(b, { serverVersion: "6.0.4" });
		const sdk = typescript(b, "6.0.3");

		const reused = reuseOf((await planJavascript(await contextFor(b))).lsp);
		expect(reused.source).toBe("path");
		expect(reused.launch).toEqual({ command: bunPath, args: ["--bun", real, "--stdio"] });
		expect(reused.tool.version).toBe("6.0.4");
		expect(reused.entries[0]).toMatchObject({ value: { command: bunPath, args: ["--bun", real, "--stdio"], initOptions: { tsserver: { fallbackPath: sdk.lib } } } });
		expect(fs.existsSync(marker)).toBe(false);
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
		// The plan says that an entry which does not go through Bun may still run on Node.
		expect(reused.notes.join(" ")).toContain("may run on Node");

		const disabled = box();
		lspConfig(path.join(disabled.agentDir, "lsp.json"), "typescript-language-server", { command: tool(disabled, "my-tls", "6.1.0"), disabled: true, fileTypes: [".ts"], rootMarkers: ["package.json"] });
		const off = blockedOf((await planJavascript(await contextFor(disabled))).lsp);
		expect(off.result.status).toBe("failed");

		const unresolved = box();
		lspConfig(path.join(unresolved.agentDir, "lsp.json"), "typescript-language-server", { command: "/nonexistent/tls", fileTypes: [".ts"], rootMarkers: ["package.json"] });
		const missing = blockedOf((await planJavascript(await contextFor(unresolved))).lsp);
		expect(missing.result.status).toBe("failed");

		const stale = box();
		lspConfig(path.join(stale.agentDir, "lsp.json"), "typescript-language-server", { command: tool(stale, "my-tls", "5.1.3"), fileTypes: [".ts"], rootMarkers: ["package.json"] });
		const old = blockedOf((await planJavascript(await contextFor(stale))).lsp);
		expect(old.result.status).toBe("unsupported");
		expect(old.result.detail).toContain("5.1.3");
	},
	SLOW,
);

test(
	"a configured server that launches through Bun is probed with its own script, not with `bun --version`, and needs no Node note",
	async () => {
		const b = box();
		const marker = path.join(b.root, "bun-calls");
		const bunPath = bunSdk(b, { serverVersion: "6.0.7", marker });
		const cli = put(path.join(b.root, "tls", "cli.mjs"), "// server\n");
		lspConfig(path.join(b.agentDir, "lsp.json"), "typescript-language-server", { command: bunPath, args: ["--bun", cli, "--stdio"], fileTypes: [".ts"], rootMarkers: ["package.json"] });

		const reused = reuseOf((await planJavascript(await contextFor(b))).lsp);
		expect(reused.tool.version).toBe("6.0.7");
		expect(reused.notes.join(" ")).not.toContain("may run on Node");
		expect(fs.readFileSync(marker, "utf8")).toContain(`--bun ${cli} --version`);
	},
	SLOW,
);

test(
	"a project-local server is never executed before approval, and only that approved path runs afterwards",
	async () => {
		const b = box();
		javascriptToolchain(b);
		put(path.join(b.project, "package.json"), { name: "app" });
		const marker = path.join(b.root, "ran-local-tls");
		const local = printer(path.join(b.project, "node_modules", ".bin", "typescript-language-server"), "6.0.2", marker);

		const before = await planJavascript(await contextFor(b));
		expect(fs.existsSync(marker)).toBe(false);
		expect(before.projectLocalExecutables).toEqual([local]);
		expect(before.lsp.status).toBe("install");

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
	"a Bun project's own node_modules/.bin is found through bun.lock and still needs approval before it runs",
	async () => {
		const b = box();
		javascriptToolchain(b);
		put(path.join(b.project, "bun.lock"), "{}\n");
		const marker = path.join(b.root, "ran-bun-project-tls");
		const local = printer(path.join(b.project, "node_modules", ".bin", "typescript-language-server"), "6.0.2", marker);

		const plan = await planJavascript(await contextFor(b));
		expect(plan.projectLocalExecutables).toEqual([local]);
		expect(fs.existsSync(marker)).toBe(false);
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
		javascriptToolchain(b);
		lspConfig(path.join(b.home, ".claude", "lsp.json"), "typescript-language-server", { command: "foreign-tls", fileTypes: [".ts"], rootMarkers: ["package.json"] });
		const plan = installOf((await planJavascript(await contextFor(b))).lsp);
		expect(plan.notes.join(" ")).toContain(path.join(b.home, ".claude", "lsp.json"));
	},
	SLOW,
);

test(
	"js-debug's adapter is launched on Bun while the programs it debugs stay on Node, and both debuggers carry root markers",
	async () => {
		const b = box();
		const sdk = javascriptToolchain(b);
		const runtime = runtimeFor(b);
		const dap = installOf((await planJavascript(await contextFor(b, runtime))).dap);

		const server = path.join(runtime.installDirectory("js-debug", "1.140.0"), "js-debug", "src", "dapDebugServer.js");
		expect(dap.launch).toEqual({ command: sdk.bun, args: ["--bun", server, "${port}", "127.0.0.1"] });
		expect(dap.entries.find(entry => entry.key === "js-debug-adapter")).toEqual({
			kind: "dap",
			key: "js-debug-adapter",
			value: { command: sdk.bun, args: ["--bun", server, "${port}", "127.0.0.1"], connectMode: "tcp", rootMarkers: ["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "package.json"] },
		});
		expect(dap.prerequisites.map(item => [item.name, item.satisfied])).toEqual([
			["node", true],
			["bun", true],
			["typescript", true],
		]);
	},
	SLOW,
);

test(
	"the Bun debugger is a companion exactly when Bun exists: pinned vendored source, stdio launch, Bun root markers and the granted runtime",
	async () => {
		const b = box();
		const sdk = javascriptToolchain(b);
		const runtime = runtimeFor(b);
		const plan = await planJavascript(await contextFor(b, runtime));
		const dap = installOf(plan.dap);

		const destination = runtime.installDirectory("bun-dap", "38afee6c");
		const entry = path.join(destination, "stdio-adapter.ts");
		expect(dap.companions).toHaveLength(1);
		const companion = dap.companions?.[0];
		expect(companion?.key).toBe("bun-debug-adapter");
		expect(companion?.launch).toEqual({ command: sdk.bun, args: [entry] });
		expect(companion?.tool.destination).toBe(destination);
		expect(companion?.tool.sources.join(" ")).toContain("38afee6c84fcf48c0edb2466aa4b27d287a59c30");
		expect(dap.entries.find(item => item.key === "bun-debug-adapter")).toEqual({
			kind: "dap",
			key: "bun-debug-adapter",
			value: {
				command: sdk.bun,
				args: [entry],
				connectMode: "stdio",
				rootMarkers: ["bun.lock", "bun.lockb", "bunfig.toml"],
				launchDefaults: { type: "bun", request: "launch", runtime: sdk.bun, stopOnEntry: true },
			},
		});
		expect(fixture(plan, "bun").dap).toMatchObject({ adapter: "bun-debug-adapter", program: "main.ts", variable: { name: "answer", value: "42" } });
		expect(fixture(plan, "bun").files.map(file => file.path)).toContain("bun.lock");

		// The recipe: the vendored files, then a frozen install from the vendored lock; the entry point must be executable.
		const request = companion?.install;
		expect(request).toMatchObject({ tool: "bun-dap", version: "38afee6c", executables: ["stdio-adapter.ts"] });
		const files = request?.operations.filter(operation => operation.type === "write-file") ?? [];
		expect(files.map(operation => operation.path)).toEqual(expect.arrayContaining(["stdio-adapter.ts", "package.json", "bun.lock", "bun-debug-adapter-protocol/src/debugger/adapter.ts", "bun-inspector-protocol/src/inspector/websocket.ts"]));
		expect(files.find(operation => operation.path === "stdio-adapter.ts")).toMatchObject({ executable: true });
		expect(files.some(operation => operation.path.endsWith(".d.ts") || operation.path.endsWith("protocol.json"))).toBe(false);
		expect(request?.operations.at(-1)).toEqual({ type: "run", command: "bun", args: ["install", "--frozen-lockfile", "--ignore-scripts"] });

		// Without Bun the Bun debugger is not offered at all.
		const noBun = box();
		tool(noBun, "node", "v24.22.0");
		typescript(noBun, "6.0.3");
		const blockedDap = blockedOf((await planJavascript(await contextFor(noBun))).dap);
		expect("companions" in blockedDap).toBe(false);
	},
	SLOW,
);

test(
	"a vendored Bun debugger without its lock file is refused before anything is installed",
	() => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "omp-bun-dap-test-"));
		cleanups.push(() => fs.rmSync(directory, { recursive: true, force: true }));
		put(path.join(directory, "stdio-adapter.ts"), "// adapter\n");
		put(path.join(directory, "package.json"), { name: "x" });
		expect(() => bunDebuggerRequest(directory)).toThrow("bun.lock");
		put(path.join(directory, "bun.lock"), "{}\n");
		put(path.join(directory, "node_modules", "ws", "index.js"), "// never copied\n");
		const operations = bunDebuggerRequest(directory).operations.filter(operation => operation.type === "write-file").map(operation => operation.path);
		expect(operations).toEqual(["bun.lock", "package.json", "stdio-adapter.ts"]);
	},
	SLOW,
);

test(
	"an already configured js-debug is reused, the Bun debugger is still added next to it, and a configured Bun debugger is reused too",
	async () => {
		const b = box();
		const sdk = javascriptToolchain(b);
		const adapter = tool(b, "my-js-debug", "1.0.0");
		put(path.join(b.agentDir, "dap.json"), { adapters: { "js-debug-adapter": { command: adapter, connectMode: "tcp" } } });
		const dap = reuseOf((await planJavascript(await contextFor(b))).dap);
		expect(dap.source).toBe("configured");
		expect(dap.entries.map(entry => entry.key)).toEqual(["bun-debug-adapter"]);
		expect(dap.companions?.[0]?.install?.tool).toBe("bun-dap");
		expect(dap.companions?.[0]?.launch.command).toBe(sdk.bun);

		const both = box();
		javascriptToolchain(both);
		const mine = tool(both, "my-bun-dap", "1.0.0");
		put(path.join(both.agentDir, "dap.json"), { adapters: { "js-debug-adapter": { command: tool(both, "my-js-debug", "1.0.0"), connectMode: "tcp" }, "bun-debug-adapter": { command: mine, connectMode: "stdio" } } });
		const reused = reuseOf((await planJavascript(await contextFor(both))).dap);
		expect(reused.entries).toEqual([]);
		expect(reused.companions).toEqual([expect.objectContaining({ key: "bun-debug-adapter", launch: { command: mine, args: [] } })]);
		expect(reused.companions?.[0]?.install).toBeUndefined();
	},
	SLOW,
);

test(
	"an existing install directory is never short-circuited: the plan stays an install and the runtime validates the recipe",
	async () => {
		const b = box();
		javascriptToolchain(b);
		const runtime = runtimeFor(b);
		await ensureToolingRoots(b.agentDir);
		const destination = runtime.installDirectory("js-debug", "1.140.0");
		put(path.join(destination, "js-debug", "src", "dapDebugServer.js"), "// server\n");
		// Same tool and version, but not a manifest this runtime wrote for this recipe.
		put(path.join(destination, INSTALL_MANIFEST_FILE), { schema: 1, tool: "js-debug", version: "1.140.0", platform: "linux-x64" });

		const dap = installOf((await planJavascript(await contextFor(b, runtime))).dap);
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
		bunSdk(b);
		const plan = await planJavascript(await contextFor(b));
		// Every approved variant stays in the plan; the group is not silently narrowed to JavaScript.
		expect(plan.fixtures.map(item => item.id)).toEqual(["javascript", "typescript", "bun"]);
		const dap = blockedOf(plan.dap);
		expect(dap.result.status).toBe("needs-sdk");
		expect(dap.prerequisites.map(item => [item.name, item.satisfied])).toEqual([
			["node", true],
			["bun", true],
			["typescript", false],
		]);
		expect(blockedOf(plan.lsp).result.status).toBe("needs-sdk");

		// An effective configured js-debug adapter does not turn the same gap into a ready integration.
		const configured = box();
		tool(configured, "node", "v24.22.0");
		bunSdk(configured);
		const adapter = tool(configured, "my-js-debug", "1.0.0");
		put(path.join(configured.agentDir, "dap.json"), { adapters: { "js-debug-adapter": { command: adapter, connectMode: "tcp" } } });
		const reused = await planJavascript(await contextFor(configured));
		expect(blockedOf(reused.dap).result.status).toBe("needs-sdk");
		expect(reused.fixtures.map(item => item.id)).toEqual(["javascript", "typescript", "bun"]);
	},
	SLOW,
);

test(
	"an approved project-local TypeScript is used in place and a withheld one is only disclosed",
	async () => {
		const b = box();
		tool(b, "node", "v24.22.0");
		bunSdk(b);
		put(path.join(b.project, "package.json"), { name: "app" });
		const marker = path.join(b.root, "ran-project-tsc");
		const local = printer(path.join(b.project, "node_modules", ".bin", "tsc"), "Version 6.0.3", marker);

		const before = await planJavascript(await contextFor(b));
		expect(fs.existsSync(marker)).toBe(false);
		expect(before.projectLocalExecutables).toEqual([local]);
		expect(blockedOf(before.lsp).result.status).toBe("needs-sdk");
		expect(blockedOf(before.dap).result.status).toBe("needs-sdk");
		expect(blockedOf(before.dap).prerequisites[2]?.remediation).toContain("approve that path");

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
		bunSdk(b);
		typescript(b, "6.0.3");
		python(path.join(b.bin, "python3"));
		const runtime = runtimeFor(b, { platform: "freebsd", arch: "x64" });
		const go = await planGo(await contextFor(b, runtime));
		const py = await planPython(await contextFor(b, runtime));
		const js = await planJavascript(await contextFor(b, runtime));
		for (const integration of [go.lsp, go.dap, py.lsp, py.dap, js.lsp, js.dap]) {
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
