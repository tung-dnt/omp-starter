import { afterEach, expect, test } from "bun:test";
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { applyConfig, inspectConfig } from "./config";
import { CLANGD_RELEASE, CODELLDB_RELEASE, RUST_ANALYZER_RELEASE, nativeInstallRequest, planCpp, planRust } from "./native";
import { createRuntime } from "./runtime";
import type { BlockedPlan, FixtureCase, InstallPlan, IntegrationPlan, PlanContext, PlatformInput, ProfileId, ReusePlan, Runtime } from "./types";

// ── Sandbox ─────────────────────────────────────────────────────────────────────────────────────

const LINUX: PlatformInput = { platform: "linux", arch: "x64", osRelease: "ID=ubuntu\n", musl: false };

interface Box {
	root: string;
	home: string;
	agentDir: string;
	cwd: string;
	/** Directory holding the fake SDK executables; it is the whole PATH unless `path` says otherwise. */
	bin: string;
	path: string;
	runtime: Runtime;
}

interface BoxOptions {
	platform?: PlatformInput;
	/** Builds PATH from the sandbox directories. */
	path?: (dirs: { bin: string; cwd: string }) => string;
}

const boxes: Box[] = [];

afterEach(async () => {
	for (const box of boxes.splice(0)) {
		await box.runtime.dispose().catch(() => undefined);
		fs.rmSync(box.root, { recursive: true, force: true });
	}
});

/** A private home, native agent directory, project and PATH; nothing here touches the real user configuration or tools. */
function sandbox(options: BoxOptions = {}): Box {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "omp-native-test-")));
	const home = path.join(root, "home");
	const agentDir = path.join(home, ".omp", "agent");
	const cwd = path.join(root, "project");
	const bin = path.join(root, "bin");
	for (const dir of [agentDir, cwd, bin]) fs.mkdirSync(dir, { recursive: true });
	const searchPath = options.path?.({ bin, cwd }) ?? bin;
	const runtime = createRuntime({ agentDir, cwd, env: { PATH: searchPath, HOME: home }, platform: options.platform ?? LINUX });
	const box: Box = { root, home, agentDir, cwd, bin, path: searchPath, runtime };
	boxes.push(box);
	return box;
}

function writeTool(dir: string, name: string, body: string): string {
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, name);
	fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
	return file;
}

function put(file: string, content: object): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(content, null, 2)}\n`);
}

interface RustOptions {
	rustc?: string;
	cargo?: string;
	rustSrc?: boolean;
	dir?: string;
}

/** Fake cargo/rustc that answer `--version` and `--print sysroot`; `rust-src` exists only on request. */
function installRust(box: Box, options: RustOptions = {}): void {
	const dir = options.dir ?? box.bin;
	const sysroot = path.join(box.root, "sysroot");
	fs.mkdirSync(sysroot, { recursive: true });
	if (options.rustSrc !== false) {
		const lib = path.join(sysroot, "lib", "rustlib", "src", "rust", "library", "std", "src", "lib.rs");
		fs.mkdirSync(path.dirname(lib), { recursive: true });
		fs.writeFileSync(lib, "// std\n");
	}
	writeTool(dir, "rustc", `case "$1" in --print) echo "${sysroot}" ;; *) echo "${options.rustc ?? "rustc 1.82.0 (f6e511eec 2024-10-15)"}" ;; esac`);
	writeTool(dir, "cargo", `echo "${options.cargo ?? "cargo 1.82.0 (8f40fc59f 2024-08-21)"}"`);
}

function installCompilers(box: Box, which: readonly string[] = ["cc", "c++"]): void {
	for (const name of which) writeTool(box.bin, name, `echo "${name} (fake) 13.2.0"`);
}

async function context(box: Box): Promise<PlanContext> {
	const config = await inspectConfig({ cwd: box.cwd, agentDir: box.agentDir, home: box.home, env: { PATH: box.path }, pluginDirs: [] });
	return { runtime: box.runtime, config };
}

function installOf(plan: IntegrationPlan): InstallPlan {
	if (plan.status !== "install") throw new Error(`expected an install plan, got ${plan.status}: ${JSON.stringify(plan)}`);
	return plan;
}

function reuseOf(plan: IntegrationPlan): ReusePlan {
	if (plan.status !== "reuse") throw new Error(`expected a reuse plan, got ${plan.status}: ${JSON.stringify(plan)}`);
	return plan;
}

function blockedOf(plan: IntegrationPlan): BlockedPlan {
	if (plan.status !== "blocked") throw new Error(`expected a blocked plan, got ${plan.status}: ${JSON.stringify(plan)}`);
	return plan;
}

const ranBy = (marker: string): string => `touch "${marker}"; echo "tool 1.0.0"`;

// ── Host and SDK prerequisites ──────────────────────────────────────────────────────────────────

test("an unsupported host blocks every integration as unsupported and plans no install", async () => {
	const hosts: Array<[string, PlatformInput]> = [
		["Linux arm64", { platform: "linux", arch: "arm64", osRelease: "ID=ubuntu\n" }],
		["Alpine musl", { platform: "linux", arch: "x64", osRelease: "ID=alpine\n", musl: true }],
		["Fedora", { platform: "linux", arch: "x64", osRelease: "ID=fedora\n", musl: false }],
		["FreeBSD", { platform: "freebsd", arch: "x64" }],
	];
	for (const [label, platform] of hosts) {
		const box = sandbox({ platform });
		installRust(box);
		installCompilers(box);
		for (const plan of [await planRust(await context(box)), await planCpp(await context(box))]) {
			for (const integration of [plan.lsp, plan.dap]) expect(blockedOf(integration).result.status, label).toBe("unsupported");
		}
	}
});

test("without a Rust toolchain both Rust integrations need the SDK", async () => {
	const box = sandbox();
	const plan = await planRust(await context(box));
	for (const integration of [plan.lsp, plan.dap]) {
		const blocked = blockedOf(integration);
		expect(blocked.result.status).toBe("needs-sdk");
		expect(blocked.prerequisites.filter(item => !item.satisfied).map(item => item.name)).toEqual(expect.arrayContaining(["cargo", "rustc"]));
	}
	expect(plan.projectLocalExecutables).toEqual([]);
});

test("a missing rust-src blocks only the language server; the debugger stays plannable", async () => {
	const box = sandbox();
	installRust(box, { rustSrc: false });
	const plan = await planRust(await context(box));
	const lsp = blockedOf(plan.lsp);
	expect(lsp.result.status).toBe("needs-sdk");
	expect(lsp.prerequisites.find(item => item.name === "rust-src")?.satisfied).toBe(false);
	expect(lsp.prerequisites.find(item => item.name === "rustc")?.satisfied).toBe(true);
	expect(installOf(plan.dap).install.tool).toBe("codelldb");
});

test("a toolchain older than edition 2021 is not accepted", async () => {
	const box = sandbox();
	installRust(box, { rustc: "rustc 1.50.0 (cb75ad5db 2021-02-10)", cargo: "cargo 1.50.0 (f04e7fab7 2021-02-04)" });
	const plan = await planRust(await context(box));
	for (const integration of [plan.lsp, plan.dap]) {
		const blocked = blockedOf(integration);
		expect(blocked.result.status).toBe("needs-sdk");
		expect(blocked.prerequisites.find(item => item.name === "rustc")).toMatchObject({ satisfied: false, found: { version: "1.50.0" } });
	}
});

test("a toolchain that exists only inside the project is never run", async () => {
	const box = sandbox({ path: ({ cwd }) => path.join(cwd, "tools") });
	const marker = path.join(box.root, "ran");
	writeTool(path.join(box.cwd, "tools"), "rustc", ranBy(marker));
	writeTool(path.join(box.cwd, "tools"), "cargo", ranBy(marker));
	const plan = await planRust(await context(box));
	expect(blockedOf(plan.lsp).result.status).toBe("needs-sdk");
	expect(fs.existsSync(marker)).toBe(false);
});

test("C/C++ needs both compilers and a compiler that does not run does not count", async () => {
	const none = sandbox();
	for (const integration of [(await planCpp(await context(none))).lsp, (await planCpp(await context(none))).dap]) {
		const blocked = blockedOf(integration);
		expect(blocked.result.status).toBe("needs-sdk");
		expect(blocked.prerequisites.map(item => [item.name, item.satisfied])).toEqual([
			["cc", false],
			["c++", false],
		]);
	}

	const lone = sandbox();
	installCompilers(lone, ["gcc"]);
	const missing = blockedOf((await planCpp(await context(lone))).lsp);
	expect(missing.prerequisites.map(item => [item.name, item.satisfied])).toEqual([
		["cc", true],
		["c++", false],
	]);

	const broken = sandbox();
	installCompilers(broken, ["c++"]);
	writeTool(broken.bin, "cc", "echo broken >&2; exit 4");
	const cc = blockedOf((await planCpp(await context(broken))).dap).prerequisites.find(item => item.name === "cc");
	expect(cc?.satisfied).toBe(false);
});

// ── Install plans ───────────────────────────────────────────────────────────────────────────────

test("planning installs nothing, writes nothing in the project, and launches exactly what the runtime would publish", async () => {
	const box = sandbox();
	installRust(box);
	installCompilers(box);
	const before = fs.readdirSync(box.cwd);
	const rust = await planRust(await context(box));
	const cpp = await planCpp(await context(box));
	for (const integration of [rust.lsp, rust.dap, cpp.lsp, cpp.dap]) {
		const plan = installOf(integration);
		const executable = plan.install.executables?.[0] ?? "";
		expect(plan.launch.command).toBe(path.join(box.runtime.installDirectory(plan.install.tool, plan.install.version, "linux-x64"), ...executable.split("/")));
		expect(plan.entries).toHaveLength(1);
		expect(plan.entries[0]?.value.command).toBe(plan.launch.command);
		expect(fs.existsSync(plan.tool.destination ?? "")).toBe(false);
	}
	expect(fs.readdirSync(box.cwd)).toEqual(before);
	expect(fs.existsSync(path.join(box.agentDir, "tooling", "codelldb"))).toBe(false);
});

test("the install request follows the host profile", async () => {
	for (const profile of ["darwin-arm64", "darwin-x64"] as const satisfies readonly ProfileId[]) {
		const box = sandbox({ platform: { platform: "darwin", arch: profile === "darwin-arm64" ? "arm64" : "x64" } });
		installRust(box);
		installCompilers(box);
		const rust = await planRust(await context(box));
		const cpp = await planCpp(await context(box));
		expect(installOf(rust.lsp).install).toEqual(nativeInstallRequest(RUST_ANALYZER_RELEASE, profile));
		expect(installOf(cpp.lsp).install).toEqual(nativeInstallRequest(CLANGD_RELEASE, profile));
		expect(installOf(rust.dap).install).toEqual(nativeInstallRequest(CODELLDB_RELEASE, profile));
		expect(installOf(cpp.dap).install.platform).toBe(profile);
	}
});

test("Rust and C/C++ share one CodeLLDB install and one stdio entry with no listener", async () => {
	const box = sandbox();
	installRust(box);
	installCompilers(box);
	const rust = installOf((await planRust(await context(box))).dap);
	const cpp = installOf((await planCpp(await context(box))).dap);
	expect(rust.install).toEqual(cpp.install);
	expect(rust.launch).toEqual(cpp.launch);
	expect(rust.entries).toEqual(cpp.entries);
	expect(rust.launch.args).toEqual([]);
	expect(rust.entries[0]).toMatchObject({ kind: "dap", key: "codelldb", value: { args: [], connectMode: "stdio" } });
	expect(JSON.stringify([rust.install, rust.launch, rust.entries])).not.toMatch(/--port|--connect|"tcp"|"socket"/);
});

// ── Reuse of existing tools ─────────────────────────────────────────────────────────────────────

test("a working rust-analyzer or clangd on PATH is reused with nothing to install or write", async () => {
	const box = sandbox();
	installRust(box);
	installCompilers(box);
	const ra = writeTool(box.bin, "rust-analyzer", 'echo "rust-analyzer 1.82.0 (f6e511e 2024-10-15)"');
	const clangd = writeTool(box.bin, "clangd", 'echo "clangd version 19.1.0"');
	const rust = reuseOf((await planRust(await context(box))).lsp);
	const cpp = reuseOf((await planCpp(await context(box))).lsp);
	expect(rust).toMatchObject({ source: "path", entries: [], launch: { command: ra }, tool: { version: "1.82.0" } });
	expect(cpp).toMatchObject({ source: "path", entries: [], launch: { command: clangd }, tool: { version: "19.1.0" } });
	// The debugger is independent: a reusable server does not make CodeLLDB appear.
	expect(installOf((await planRust(await context(box))).dap).install.tool).toBe("codelldb");
});

test("a PATH tool that omp's project-local lookup would shadow is pinned by absolute path", async () => {
	const box = sandbox();
	installCompilers(box);
	const onPath = writeTool(box.bin, "clangd", 'echo "clangd version 19.1.0"');
	fs.writeFileSync(path.join(box.cwd, "package.json"), "{}\n");
	writeTool(path.join(box.cwd, "node_modules", ".bin"), "clangd", 'echo "project clangd"');
	const lsp = reuseOf((await planCpp(await context(box))).lsp);
	expect(lsp.source).toBe("path");
	expect(lsp.entries).toEqual([expect.objectContaining({ kind: "lsp", key: "clangd", value: expect.objectContaining({ command: onPath }) })]);
});

test("a PATH tool that does not run is skipped and the pinned release is planned", async () => {
	const box = sandbox();
	installRust(box);
	const proxy = writeTool(box.bin, "rust-analyzer", 'echo "error: unknown binary" >&2; exit 1');
	const lsp = installOf((await planRust(await context(box))).lsp);
	expect(lsp.launch.command).not.toBe(proxy);
});

test("an existing codelldb on PATH is reused with an explicit stdio entry instead of a duplicate install", async () => {
	const box = sandbox();
	installRust(box);
	installCompilers(box);
	const existing = writeTool(box.bin, "codelldb", 'echo "usage: codelldb"');
	for (const plan of [await planRust(await context(box)), await planCpp(await context(box))]) {
		const dap = reuseOf(plan.dap);
		expect(dap).toMatchObject({ source: "path", launch: { command: existing, args: [] } });
		// omp's built-in entry would add --port 0; the approved override pins args [] and stdio.
		expect(dap.entries).toEqual([expect.objectContaining({ kind: "dap", key: "codelldb", value: expect.objectContaining({ command: existing, args: [], connectMode: "stdio" }) })]);
	}

	const broken = sandbox();
	installCompilers(broken);
	writeTool(broken.bin, "codelldb", "exit 3");
	expect(installOf((await planCpp(await context(broken))).dap).install.tool).toBe("codelldb");
});

test("a codelldb that lives in the project is neither run nor written into user configuration", async () => {
	const box = sandbox({ path: ({ bin, cwd }) => `${bin}:${path.join(cwd, "tools")}` });
	installCompilers(box);
	const marker = path.join(box.root, "ran");
	const local = writeTool(path.join(box.cwd, "tools"), "codelldb", ranBy(marker));
	const dap = installOf((await planCpp(await context(box))).dap);
	expect(dap.launch.command).not.toBe(local);
	expect(fs.existsSync(marker)).toBe(false);
});

test("a configured, working entry is reused unchanged and keeps its own arguments", async () => {
	const box = sandbox();
	installCompilers(box);
	const mine = writeTool(path.join(box.root, "mine"), "clangd", 'echo "clangd version 18.1.8"');
	put(path.join(box.agentDir, "lsp.json"), { servers: { clangd: { command: mine, args: ["--background-index=false"], fileTypes: [".c", ".cpp", ".h"] } } });
	const lsp = reuseOf((await planCpp(await context(box))).lsp);
	expect(lsp).toMatchObject({ source: "configured", entries: [], launch: { command: mine, args: ["--background-index=false"] }, tool: { version: "18.1.8" } });
});

test("existing configuration that cannot work is reported and never replaced", async () => {
	const missing = sandbox();
	installCompilers(missing);
	put(path.join(missing.agentDir, "lsp.json"), { servers: { clangd: { command: "/nonexistent/clangd" } } });
	expect(blockedOf((await planCpp(await context(missing))).lsp).result.status).toBe("failed");

	const disabled = sandbox();
	installRust(disabled);
	put(path.join(disabled.agentDir, "lsp.json"), { servers: { "rust-analyzer": { disabled: true } } });
	expect(blockedOf((await planRust(await context(disabled))).lsp).result.status).toBe("failed");

	const narrow = sandbox();
	installCompilers(narrow);
	const c = writeTool(path.join(narrow.root, "mine"), "clangd", 'echo "clangd version 18.1.8"');
	put(path.join(narrow.agentDir, "lsp.json"), { servers: { clangd: { command: c, fileTypes: [".c"] } } });
	expect(blockedOf((await planCpp(await context(narrow))).lsp).result.status).toBe("failed");

	const broken = sandbox();
	installCompilers(broken);
	const dead = writeTool(path.join(broken.root, "mine"), "clangd", "exit 9");
	put(path.join(broken.agentDir, "lsp.json"), { servers: { clangd: { command: dead } } });
	expect(blockedOf((await planCpp(await context(broken))).lsp).result.status).toBe("failed");
});

// ── codelldb transport in existing configuration ────────────────────────────────────────────────

function dapBox(entry: (command: string) => object): { box: Box; command: string } {
	const box = sandbox();
	installCompilers(box);
	const command = writeTool(path.join(box.root, "mine"), "codelldb", 'echo "usage: codelldb"');
	put(path.join(box.agentDir, "dap.json"), { adapters: { codelldb: entry(command) } });
	return { box, command };
}

test("a configured codelldb with omitted connectMode and empty args is valid stdio and is reused", async () => {
	for (const entry of [(command: string) => ({ command, args: [] }), (command: string) => ({ command, args: [], connectMode: "stdio" })]) {
		const { box, command } = dapBox(entry);
		const dap = reuseOf((await planCpp(await context(box))).dap);
		expect(dap).toMatchObject({ source: "configured", entries: [], launch: { command, args: [] } });
	}
});

test("a configured codelldb that would listen on a port or inherits omp's --port 0 is never accepted", async () => {
	const unsafe: Array<(command: string) => object> = [
		// Omitted args inherit the built-in `--port 0`, which opens a TCP listener while omp talks stdio.
		command => ({ command }),
		command => ({ command, connectMode: "stdio" }),
		command => ({ command, args: ["--port", "0"], connectMode: "stdio" }),
		command => ({ command, args: ["--port=0"] }),
		command => ({ command, args: [], connectMode: "socket" }),
		command => ({ command, args: [], connectMode: "tcp" }),
	];
	for (const entry of unsafe) {
		const { box } = dapBox(entry);
		const plan = await planCpp(await context(box));
		expect(blockedOf(plan.dap).result.status).toBe("failed");
		// The language server is unaffected by the debugger conflict.
		expect(installOf(plan.lsp).install.tool).toBe("clangd");
	}
});

// ── Project-supplied configuration and programs: disclosed, never run while planning ────────────

test("a project-supplied entry that is compatible is reused unverified and disclosed, without running it", async () => {
	const box = sandbox();
	installRust(box);
	installCompilers(box);
	const marker = path.join(box.root, "ran");
	const hook = writeTool(box.cwd, "my-ra", ranBy(marker));
	put(path.join(box.cwd, ".omp", "lsp.json"), { servers: { "rust-analyzer": { command: hook } } });
	const outside = writeTool(path.join(box.root, "elsewhere"), "codelldb", ranBy(marker));
	put(path.join(box.cwd, ".omp", "dap.json"), { adapters: { codelldb: { command: outside, args: [], connectMode: "stdio" } } });

	const rust = await planRust(await context(box));
	expect(reuseOf(rust.lsp)).toMatchObject({ source: "project-local", entries: [], launch: { command: hook } });
	expect(reuseOf(rust.dap)).toMatchObject({ source: "project-local", entries: [], launch: { command: outside, args: [] } });
	// Both are disclosed so the wizard can ask before verification runs them.
	expect(rust.projectLocalExecutables).toEqual([hook, outside]);
	expect(fs.existsSync(marker)).toBe(false);
});

test("a project-supplied entry that conflicts is blocked rather than every project origin", async () => {
	const narrow = sandbox();
	installCompilers(narrow);
	const hook = writeTool(narrow.cwd, "my-clangd", "exit 0");
	put(path.join(narrow.cwd, ".omp", "lsp.json"), { servers: { clangd: { command: hook, fileTypes: [".c"] } } });
	expect(blockedOf((await planCpp(await context(narrow))).lsp).result.status).toBe("failed");

	const socket = sandbox();
	installCompilers(socket);
	const adapter = writeTool(socket.cwd, "my-lldb", "exit 0");
	put(path.join(socket.cwd, ".omp", "dap.json"), { adapters: { codelldb: { command: adapter, args: ["--port", "0"] } } });
	const plan = await planCpp(await context(socket));
	expect(blockedOf(plan.dap).result.status).toBe("failed");
	expect(plan.projectLocalExecutables).toEqual([]);
});

test("a user entry whose program lives in the project and a project-local PATH tool are deferred, not probed", async () => {
	const box = sandbox({ path: ({ bin, cwd }) => `${bin}:${path.join(cwd, "tools")}` });
	installRust(box);
	installCompilers(box);
	const marker = path.join(box.root, "ran");
	const inProject = writeTool(path.join(box.cwd, "vendor"), "clangd", ranBy(marker));
	put(path.join(box.agentDir, "lsp.json"), { servers: { clangd: { command: inProject } } });
	const ra = writeTool(path.join(box.cwd, "tools"), "rust-analyzer", ranBy(marker));

	const cpp = await planCpp(await context(box));
	expect(reuseOf(cpp.lsp)).toMatchObject({ source: "project-local", entries: [], launch: { command: inProject } });
	expect(cpp.projectLocalExecutables).toEqual([inProject]);
	const rust = await planRust(await context(box));
	expect(reuseOf(rust.lsp)).toMatchObject({ source: "project-local", entries: [], launch: { command: ra } });
	expect(rust.projectLocalExecutables).toEqual([ra]);
	expect(fs.existsSync(marker)).toBe(false);
});

// ── Shared adapter across languages and foreign configuration ───────────────────────────────────

test("an applied managed install is reused by the other language, so the adapter exists once", async () => {
	const box = sandbox();
	installRust(box);
	installCompilers(box);
	const rust = await planRust(await context(box));
	const lsp = installOf(rust.lsp);
	const dap = installOf(rust.dap);
	// What a confirmed install would have published, then what the confirmed config merge writes.
	writeTool(path.dirname(lsp.launch.command), path.basename(lsp.launch.command), 'echo "rust-analyzer 2026-10-19"');
	writeTool(path.dirname(dap.launch.command), path.basename(dap.launch.command), 'echo "usage: codelldb"');
	const applied = await applyConfig(await inspectConfig({ cwd: box.cwd, agentDir: box.agentDir, home: box.home, env: { PATH: box.path }, pluginDirs: [] }), {
		entries: [...lsp.entries, ...dap.entries],
	});
	expect(applied.outcomes.map(outcome => outcome.status)).toEqual(["applied", "applied"]);

	const cpp = await planCpp(await context(box));
	expect(reuseOf(cpp.dap)).toMatchObject({ source: "managed", entries: [], launch: dap.launch });
	expect(installOf(cpp.lsp).install.tool).toBe("clangd");
	expect(reuseOf((await planRust(await context(box))).lsp)).toMatchObject({ source: "managed", entries: [], launch: { command: lsp.launch.command } });
});

test("a config file omp may also read is disclosed because it can never make the entry ready", async () => {
	const box = sandbox();
	installCompilers(box);
	const foreign = path.join(box.home, ".claude", "lsp.json");
	put(foreign, { servers: { clangd: { command: "other-clangd" } } });
	const lsp = installOf((await planCpp(await context(box))).lsp);
	expect(lsp.notes.some(note => note.includes(foreign))).toBe(true);
});

// ── Real compiler regression: fixtures build, and the compilation database is valid for odd paths ─

const hasCompilers = Bun.which("cc") !== null && Bun.which("c++") !== null && fs.existsSync("/bin/sh");

function materialize(fixture: FixtureCase, dir: string): void {
	for (const file of fixture.files) {
		const target = path.join(dir, ...file.path.split("/"));
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, file.content, { mode: file.executable === true ? 0o755 : 0o644 });
	}
}

test.skipIf(!hasCompilers)("the C and C++ fixtures build with the host compilers and record a valid compile_commands.json for a path with a space and a quote", async () => {
	const box = sandbox({ path: () => process.env.PATH ?? "" });
	const cpp = await planCpp(await context(box));
	expect(cpp.fixtures.map(fixture => fixture.id)).toEqual(["c", "cpp"]);
	for (const fixture of cpp.fixtures) {
		const dir = path.join(box.root, `fix ${fixture.id} "q"`);
		fs.mkdirSync(dir);
		materialize(fixture, dir);
		for (const step of fixture.build ?? []) {
			const result = cp.spawnSync(step.command, [...step.args], { cwd: dir, encoding: "utf8", timeout: 120_000, env: { PATH: process.env.PATH ?? "" } });
			if (result.status !== 0) throw new Error(`${step.label} failed (${result.status}): ${result.stderr}`);
		}
		const database: unknown = JSON.parse(fs.readFileSync(path.join(dir, "compile_commands.json"), "utf8"));
		const [entry] = database as Array<{ directory: string; arguments: string[]; file: string }>;
		expect(entry?.directory).toBe(fs.realpathSync(dir));
		expect(entry?.file).toBe(fixture.lsp.file);
		expect(path.isAbsolute(entry?.arguments[0] ?? "")).toBe(true);
		// The binary the debugger will launch exists and exits 0 only when answer is 42.
		expect(cp.spawnSync(path.join(dir, fixture.dap.program), { timeout: 30_000 }).status).toBe(0);
	}
}, 60_000); // Real compiler startup on a cold Intel Mac can exceed Bun's default five-second deadline.
