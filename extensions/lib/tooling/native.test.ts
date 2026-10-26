import { afterEach, expect, test } from "bun:test";
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { applyConfig, inspectConfig } from "./config";
import {
	CLANGD_RELEASE,
	CODELLDB_RELEASE,
	type NativeRelease,
	RUST_ANALYZER_RELEASE,
	codelldbEntry,
	nativeInstallRequest,
	planCpp,
	planRust,
} from "./native";
import { createRuntime, sha256Hex } from "./runtime";
import type {
	BlockedPlan,
	FixtureCase,
	InstallPlan,
	InstallRequest,
	IntegrationPlan,
	LanguagePlan,
	PlanContext,
	PlatformInput,
	ProfileId,
	ReusePlan,
	Runtime,
} from "./types";

// ── Sandbox ─────────────────────────────────────────────────────────────────────────────────────

const LINUX: PlatformInput = { platform: "linux", arch: "x64", osRelease: "ID=ubuntu\n", musl: false };

interface Box {
	root: string;
	home: string;
	agentDir: string;
	cwd: string;
	/** Directory holding the fake SDK executables (the whole PATH unless `path` was given). */
	bin: string;
	path: string;
	runtime: Runtime;
}

interface BoxOptions {
	platform?: PlatformInput;
	fetch?: typeof fetch;
	/** Replaces PATH (default: only the sandbox `bin`). */
	path?: string;
	/** PATH is a `tools` directory inside the user's project. */
	projectTools?: boolean;
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
	const searchPath = options.projectTools === true ? path.join(cwd, "tools") : (options.path ?? bin);
	const runtime = createRuntime({
		agentDir,
		cwd,
		env: { PATH: searchPath, HOME: home },
		platform: options.platform ?? LINUX,
		...(options.fetch === undefined ? {} : { fetch: options.fetch }),
	});
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
}

/** Fake cargo/rustc that answer `--version` and `--print sysroot`; `rust-src` exists only on request. */
function installRust(box: Box, options: RustOptions = {}): void {
	const sysroot = path.join(box.root, "sysroot");
	fs.mkdirSync(sysroot, { recursive: true });
	if (options.rustSrc !== false) {
		const lib = path.join(sysroot, "lib", "rustlib", "src", "rust", "library", "std", "src", "lib.rs");
		fs.mkdirSync(path.dirname(lib), { recursive: true });
		fs.writeFileSync(lib, "// std\n");
	}
	writeTool(box.bin, "rustc", `case "$1" in --print) echo "${sysroot}" ;; *) echo "${options.rustc ?? "rustc 1.82.0 (f6e511eec 2024-10-15)"}" ;; esac`);
	writeTool(box.bin, "cargo", `echo "${options.cargo ?? "cargo 1.82.0 (8f40fc59f 2024-08-21)"}"`);
}

function installCompilers(box: Box, dir = box.bin, which: readonly string[] = ["cc", "c++"]): void {
	for (const name of which) writeTool(dir, name, `echo "${name} (fake) 13.2.0"`);
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
	if (plan.status !== "blocked") throw new Error(`expected a blocked plan, got ${plan.status}`);
	return plan;
}

function fixtureOf(plan: LanguagePlan, id: string): FixtureCase {
	const found = plan.fixtures.find(fixture => fixture.id === id);
	if (found === undefined) throw new Error(`no ${id} fixture`);
	return found;
}

function fileOf(fixture: FixtureCase, name: string): string {
	const file = fixture.files.find(candidate => candidate.path === name);
	if (file === undefined) throw new Error(`fixture ${fixture.id} has no ${name}`);
	return file.content;
}

/** The text of a 1-based line. */
function lineAt(content: string, line: number): string {
	return content.split("\n")[line - 1] ?? "";
}

// ── Pinned manifest ─────────────────────────────────────────────────────────────────────────────

const RA = "https://github.com/rust-lang/rust-analyzer/releases/download/2026-10-19/";
const CLANGD = "https://github.com/clangd/clangd/releases/download/23.1.0/";
const LLDB = "https://github.com/vadimcn/codelldb/releases/download/v1.12.3/";
const MAC_CLANGD = { file: "clangd-mac-23.1.0.zip", sha256: "1082e6638223b785ca2daf0939f13afcd0bb95c84ee9a4bbaff4745365159253" };

const PINS: ReadonlyArray<{ release: NativeRelease; profile: ProfileId; url: string; sha256: string; format: "gzip" | "zip" }> = [
	{ release: RUST_ANALYZER_RELEASE, profile: "linux-x64", url: `${RA}rust-analyzer-x86_64-unknown-linux-gnu.gz`, sha256: "8fde1c9dae81459f98e99eedae3654846a9166abea686306c26e57773be558da", format: "gzip" },
	{ release: RUST_ANALYZER_RELEASE, profile: "darwin-arm64", url: `${RA}rust-analyzer-aarch64-apple-darwin.gz`, sha256: "eedad08a96f7bf92afd0890463787337d17591ea2e3df216033c6bc3ccc9d802", format: "gzip" },
	{ release: RUST_ANALYZER_RELEASE, profile: "darwin-x64", url: `${RA}rust-analyzer-x86_64-apple-darwin.gz`, sha256: "bdfd46e82731a8d3502d852d28b6462c1f1c13eed0b3e76bbcf1ba839028249c", format: "gzip" },
	{ release: CLANGD_RELEASE, profile: "linux-x64", url: `${CLANGD}clangd-linux-23.1.0.zip`, sha256: "e53b1a96196095faedb7642cf64964f7fb9ad4a0c1f00dd2c172a3d9dcbafdfd", format: "zip" },
	{ release: CLANGD_RELEASE, profile: "darwin-arm64", url: `${CLANGD}${MAC_CLANGD.file}`, sha256: MAC_CLANGD.sha256, format: "zip" },
	{ release: CLANGD_RELEASE, profile: "darwin-x64", url: `${CLANGD}${MAC_CLANGD.file}`, sha256: MAC_CLANGD.sha256, format: "zip" },
	{ release: CODELLDB_RELEASE, profile: "linux-x64", url: `${LLDB}codelldb-linux-x64.vsix`, sha256: "1cd7f386598022b51a5b93b9ffa23e812b23f519cfe1833384ec4bef4bfd1be1", format: "zip" },
	{ release: CODELLDB_RELEASE, profile: "darwin-arm64", url: `${LLDB}codelldb-darwin-arm64.vsix`, sha256: "2f114a990e1b368dd1dbd33c80c0e719767af2d228391ec0df0571c957f9ac91", format: "zip" },
	{ release: CODELLDB_RELEASE, profile: "darwin-x64", url: `${LLDB}codelldb-darwin-x64.vsix`, sha256: "e25cc716b94c62c07fec268ff2785d2b797245b160502baef8b9c970a0c4d8e8", format: "zip" },
];

test("every approved platform has the reviewed asset URL, SHA-256 and format", () => {
	expect(PINS).toHaveLength(9);
	for (const expected of PINS) {
		const { artifact, executable } = expected.release.pins[expected.profile];
		expect(artifact.url).toBe(expected.url);
		expect(artifact.sha256).toBe(expected.sha256);
		expect(artifact.format).toBe(expected.format);
		expect(artifact.version).toBe(expected.release.version);
		expect(artifact.reviewed).toBe("2026-10-26");
		expect(artifact.provenance).toContain("GitHub release");
		expect(artifact.provenance).toContain("no upstream signature");
		expect(new URL(artifact.url).protocol).toBe("https:");
		expect(new URL(artifact.url).hostname).toBe("github.com");
		expect(executable.startsWith("/") || executable.includes("..")).toBe(false);
	}
	expect(RUST_ANALYZER_RELEASE.version).toBe("2026-10-19");
	expect(CLANGD_RELEASE.version).toBe("23.1.0");
	expect(CODELLDB_RELEASE.version).toBe("1.12.3");
});

test("install requests carry exactly one pinned artifact and the launch target the plans use", () => {
	for (const { release, profile } of PINS) {
		const request = nativeInstallRequest(release, profile);
		const pin = release.pins[profile];
		expect(request).toMatchObject({ tool: release.tool, version: release.version, platform: profile, executables: [pin.executable] });
		expect(request.operations).toEqual([{ type: "artifact", artifact: pin.artifact }]);
		// A copy: mutating a request cannot alter the pinned manifest.
		const operation = request.operations[0];
		if (operation?.type !== "artifact") throw new Error("expected an artifact operation");
		expect(operation.artifact).not.toBe(pin.artifact);
	}
	const gz = nativeInstallRequest(RUST_ANALYZER_RELEASE, "linux-x64").operations[0];
	expect(gz?.type === "artifact" && gz.artifact).toMatchObject({ format: "gzip", fileName: "rust-analyzer", executable: true });
	expect(nativeInstallRequest(CLANGD_RELEASE, "linux-x64").executables).toEqual(["clangd_23.1.0/bin/clangd"]);
	expect(nativeInstallRequest(CODELLDB_RELEASE, "darwin-x64").executables).toEqual(["extension/adapter/codelldb"]);
});

// ── Corrupt and substituted assets go through the real runtime ──────────────────────────────────

function fetchOf(responses: Readonly<Record<string, Uint8Array>>): typeof fetch {
	const handler = async (input: string | URL | Request): Promise<Response> => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const body = responses[url];
		if (body === undefined) return new Response("not found", { status: 404 });
		return new Response(new Uint8Array(body));
	};
	return handler as typeof fetch;
}

interface ZipFile {
	name: string;
	data?: string;
	mode?: number;
}

/** A small stored (uncompressed) ZIP: directories end with `/`, files carry a Unix mode. */
function zipOf(files: readonly ZipFile[]): Buffer {
	const body: Buffer[] = [];
	const directory: Buffer[] = [];
	let offset = 0;
	for (const file of files) {
		const isDirectory = file.name.endsWith("/");
		const raw = Buffer.from(file.data ?? "");
		const name = Buffer.from(file.name);
		const crc = zlib.crc32(raw);
		const mode = file.mode ?? (isDirectory ? 0o755 : 0o644);
		const unixType = isDirectory ? 0o040000 : 0o100000;
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(raw.length, 18);
		local.writeUInt32LE(raw.length, 22);
		local.writeUInt16LE(name.length, 26);
		const entry = Buffer.alloc(46);
		entry.writeUInt32LE(0x02014b50, 0);
		entry.writeUInt16LE((3 << 8) | 20, 4);
		entry.writeUInt16LE(20, 6);
		entry.writeUInt32LE(crc, 16);
		entry.writeUInt32LE(raw.length, 20);
		entry.writeUInt32LE(raw.length, 24);
		entry.writeUInt16LE(name.length, 28);
		entry.writeUInt32LE(((unixType | mode) << 16) >>> 0, 38);
		entry.writeUInt32LE(offset, 42);
		body.push(local, name, raw);
		directory.push(entry, name);
		offset += local.length + name.length + raw.length;
	}
	const central = Buffer.concat(directory);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(files.length, 8);
	end.writeUInt16LE(files.length, 10);
	end.writeUInt32LE(central.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...body, central, end]);
}

/** The same request with the pinned digest swapped for the digest of a locally built stand-in, so the runtime path can run offline. */
function substituted(request: InstallRequest, payload: Uint8Array): { request: InstallRequest; url: string } {
	const operation = request.operations[0];
	if (operation?.type !== "artifact") throw new Error("expected an artifact operation");
	return {
		request: { ...request, operations: [{ ...operation, artifact: { ...operation.artifact, sha256: sha256Hex(payload) } }] },
		url: operation.artifact.url,
	};
}

test("a corrupt or substituted asset is rejected by the runtime and nothing is published", async () => {
	const corrupt = new Uint8Array([1, 2, 3, 4]);
	const urls = PINS.filter(pin => pin.profile === "linux-x64").map(pin => pin.url);
	const box = sandbox({ fetch: fetchOf(Object.fromEntries(urls.map(url => [url, corrupt]))) });
	for (const release of [RUST_ANALYZER_RELEASE, CLANGD_RELEASE, CODELLDB_RELEASE]) {
		await expect(box.runtime.install(nativeInstallRequest(release, "linux-x64"))).rejects.toMatchObject({ code: "integrity" });
		expect(fs.existsSync(box.runtime.installDirectory(release.tool, release.version, "linux-x64"))).toBe(false);
	}
});

test("the launch paths in the plans are exactly where the runtime publishes each executable, and a second install reuses it", async () => {
	const binary = "#!/bin/sh\necho stand-in\n";
	const stand = {
		rust: zlib.gzipSync(binary),
		clangd: zipOf([{ name: "clangd_23.1.0/" }, { name: "clangd_23.1.0/bin/" }, { name: "clangd_23.1.0/bin/clangd", data: binary, mode: 0o755 }]),
		codelldb: zipOf([{ name: "extension/" }, { name: "extension/adapter/" }, { name: "extension/adapter/codelldb", data: binary, mode: 0o755 }]),
	};
	const url = (release: NativeRelease): string => release.pins["linux-x64"].artifact.url;
	const box = sandbox({
		fetch: fetchOf({ [url(RUST_ANALYZER_RELEASE)]: stand.rust, [url(CLANGD_RELEASE)]: stand.clangd, [url(CODELLDB_RELEASE)]: stand.codelldb }),
	});
	installRust(box);
	installCompilers(box);
	const rust = await planRust(await context(box));
	const cpp = await planCpp(await context(box));
	const plans = [
		{ plan: installOf(rust.lsp), payload: stand.rust },
		{ plan: installOf(cpp.lsp), payload: stand.clangd },
		{ plan: installOf(rust.dap), payload: stand.codelldb },
		{ plan: installOf(cpp.dap), payload: stand.codelldb },
	];
	for (const { plan, payload } of plans) {
		const swap = substituted(plan.install, payload);
		const result = await box.runtime.install(swap.request);
		// Both languages' CodeLLDB plans name one directory: the second install finds the first one.
		expect(["installed", "reused"]).toContain(result.status);
		expect(result.destination).toBe(plan.tool.destination);
		// The launch command the plan will configure is the executable the runtime just published.
		expect(plan.launch.command).toBe(path.join(result.destination, ...(swap.request.executables?.[0] ?? "").split("/")));
		expect(fs.statSync(plan.launch.command).mode & 0o111).not.toBe(0);
		expect((await box.runtime.install(swap.request)).status).toBe("reused");
	}
});

// ── Unsupported hosts ───────────────────────────────────────────────────────────────────────────

test("an unsupported host is reported for every integration and nothing is planned for install", async () => {
	const hosts: Array<[string, PlatformInput, RegExp]> = [
		["Linux arm64", { platform: "linux", arch: "arm64", osRelease: "ID=ubuntu\n" }, /arm64/],
		["Alpine musl", { platform: "linux", arch: "x64", osRelease: "ID=alpine\n", musl: true }, /musl/],
		["Fedora", { platform: "linux", arch: "x64", osRelease: "ID=fedora\n", musl: false }, /fedora/],
		["FreeBSD", { platform: "freebsd", arch: "x64" }, /freebsd/],
	];
	for (const [label, platform, reason] of hosts) {
		const box = sandbox({ platform });
		installRust(box);
		installCompilers(box);
		for (const plan of [await planRust(await context(box)), await planCpp(await context(box))]) {
			for (const integration of [plan.lsp, plan.dap]) {
				const blocked = blockedOf(integration);
				expect(blocked.result.status, label).toBe("unsupported");
				expect(blocked.result.detail, label).toMatch(reason);
			}
		}
	}
});

// ── Missing prerequisites ───────────────────────────────────────────────────────────────────────

test("without a Rust toolchain both Rust integrations ask for the SDK and run nothing", async () => {
	const box = sandbox();
	const plan = await planRust(await context(box));
	for (const integration of [plan.lsp, plan.dap]) {
		const blocked = blockedOf(integration);
		expect(blocked.result.status).toBe("needs-sdk");
		expect(blocked.result.detail).toContain("rustc");
		expect(blocked.prerequisites.filter(item => !item.satisfied).map(item => item.name)).toEqual(expect.arrayContaining(["cargo", "rustc"]));
		expect(blocked.prerequisites.find(item => item.name === "cargo")?.remediation).toContain("never installs SDKs");
	}
	expect(blockedOf(plan.lsp).prerequisites.map(item => item.name)).toEqual(["cargo", "rustc", "rust-src"]);
	expect(blockedOf(plan.dap).prerequisites.map(item => item.name)).toEqual(["cargo", "rustc"]);
	expect(plan.projectLocalExecutables).toEqual([]);
});

test("a missing rust-src blocks only the language server; the debugger stays independently plannable", async () => {
	const box = sandbox();
	installRust(box, { rustSrc: false });
	const plan = await planRust(await context(box));
	const lsp = blockedOf(plan.lsp);
	expect(lsp.result.status).toBe("needs-sdk");
	const rustSrc = lsp.prerequisites.find(item => item.name === "rust-src");
	expect(rustSrc).toMatchObject({ satisfied: false });
	expect(rustSrc?.remediation).toContain("rustup component add rust-src");
	expect(rustSrc?.remediation).toContain("never changes toolchains");
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

test("a Rust toolchain that is only a project-local executable is never run", async () => {
	const box = sandbox({ projectTools: true });
	const marker = path.join(box.root, "ran");
	writeTool(path.join(box.cwd, "tools"), "rustc", `touch "${marker}"; echo "rustc 1.82.0"`);
	writeTool(path.join(box.cwd, "tools"), "cargo", `touch "${marker}"; echo "cargo 1.82.0"`);
	const plan = await planRust(await context(box));
	const blocked = blockedOf(plan.lsp);
	expect(blocked.result.status).toBe("needs-sdk");
	expect(blocked.prerequisites.find(item => item.name === "rustc")?.remediation).toContain("inside your project");
	expect(fs.existsSync(marker)).toBe(false);
});

test("C/C++ needs both compilers; a lone C compiler blocks both integrations and names the missing one", async () => {
	const none = sandbox();
	const absent = await planCpp(await context(none));
	for (const integration of [absent.lsp, absent.dap]) {
		const blocked = blockedOf(integration);
		expect(blocked.result.status).toBe("needs-sdk");
		expect(blocked.prerequisites.map(item => item.name)).toEqual(["cc", "c++"]);
		expect(blocked.prerequisites.every(item => !item.satisfied && (item.remediation ?? "").includes("never installs SDKs"))).toBe(true);
	}

	const lone = sandbox();
	installCompilers(lone, lone.bin, ["gcc"]);
	const plan = await planCpp(await context(lone));
	const blocked = blockedOf(plan.lsp);
	expect(blocked.prerequisites.find(item => item.name === "cc")).toMatchObject({ satisfied: true });
	expect(blocked.prerequisites.find(item => item.name === "c++")).toMatchObject({ satisfied: false });
	expect(blocked.result.detail).toContain("c++");
});

test("a compiler that is present but does not run is reported with the reason", async () => {
	const box = sandbox();
	installCompilers(box, box.bin, ["c++"]);
	writeTool(box.bin, "cc", "echo broken >&2; exit 4");
	const plan = await planCpp(await context(box));
	const cc = blockedOf(plan.dap).prerequisites.find(item => item.name === "cc");
	expect(cc?.satisfied).toBe(false);
	expect(cc?.remediation).toContain("did not run");
});

// ── Install plans ───────────────────────────────────────────────────────────────────────────────

test("Rust with an SDK and no tools plans pinned installs with absolute launch paths and omp's own settings", async () => {
	const box = sandbox();
	installRust(box);
	const before = fs.readdirSync(box.cwd);
	const plan = await planRust(await context(box));
	const lsp = installOf(plan.lsp);
	const dap = installOf(plan.dap);

	expect(lsp.install).toEqual(nativeInstallRequest(RUST_ANALYZER_RELEASE, "linux-x64"));
	expect(lsp.launch).toEqual({ command: path.join(box.runtime.installDirectory("rust-analyzer", "2026-10-19", "linux-x64"), "rust-analyzer"), args: [] });
	expect(lsp.tool).toMatchObject({ name: "rust-analyzer", version: "2026-10-19", sources: [`${RA}rust-analyzer-x86_64-unknown-linux-gnu.gz`] });
	expect(lsp.tool.destination).toBe(box.runtime.installDirectory("rust-analyzer", "2026-10-19", "linux-x64"));
	expect(lsp.entries).toEqual([
		{
			kind: "lsp",
			key: "rust-analyzer",
			value: {
				command: lsp.launch.command,
				args: [],
				fileTypes: [".rs"],
				rootMarkers: ["Cargo.toml", "rust-analyzer.toml"],
				initOptions: {},
				settings: { "rust-analyzer": { checkOnSave: false } },
			},
		},
	]);
	expect(lsp.prerequisites.map(item => [item.name, item.satisfied])).toEqual([
		["cargo", true],
		["rustc", true],
		["rust-src", true],
	]);
	expect(lsp.notes.join("\n")).toContain("8fde1c9dae81459f98e99eedae3654846a9166abea686306c26e57773be558da");

	expect(dap.install).toEqual(nativeInstallRequest(CODELLDB_RELEASE, "linux-x64"));
	// Planning is pure: nothing was installed, written or created in the project.
	expect(fs.existsSync(dap.tool.destination ?? "")).toBe(false);
	expect(fs.readdirSync(box.cwd)).toEqual(before);
	expect(plan.language).toBe("rust");
	expect(plan.projectLocalExecutables).toEqual([]);
});

test("C/C++ with compilers plans a pinned clangd and the same shared CodeLLDB", async () => {
	const box = sandbox();
	installCompilers(box);
	const plan = await planCpp(await context(box));
	const lsp = installOf(plan.lsp);
	expect(lsp.install).toEqual(nativeInstallRequest(CLANGD_RELEASE, "linux-x64"));
	expect(lsp.launch).toEqual({
		command: path.join(box.runtime.installDirectory("clangd", "23.1.0", "linux-x64"), "clangd_23.1.0", "bin", "clangd"),
		args: ["--background-index", "--clang-tidy", "--header-insertion=iwyu"],
	});
	expect(lsp.entries).toHaveLength(1);
	expect(lsp.entries[0]).toMatchObject({
		kind: "lsp",
		key: "clangd",
		value: { command: lsp.launch.command, args: lsp.launch.args, fileTypes: expect.arrayContaining([".c", ".cpp", ".h", ".hpp"]), rootMarkers: expect.arrayContaining(["compile_commands.json"]) },
	});
	expect(lsp.notes.join("\n")).toContain("compile_commands.json");
	expect(plan.language).toBe("cpp");
	expect(plan.fixtures.map(fixture => fixture.id)).toEqual(["c", "cpp"]);
});

test("macOS profiles pin the Mac assets, and Intel and Apple Silicon share the universal clangd archive", async () => {
	for (const profile of ["darwin-arm64", "darwin-x64"] as const) {
		const arch = profile === "darwin-arm64" ? "arm64" : "x64";
		const box = sandbox({ platform: { platform: "darwin", arch } });
		installRust(box);
		installCompilers(box);
		const rust = await planRust(await context(box));
		const cpp = await planCpp(await context(box));
		expect(installOf(rust.lsp).install).toEqual(nativeInstallRequest(RUST_ANALYZER_RELEASE, profile));
		expect(installOf(cpp.lsp).install).toEqual(nativeInstallRequest(CLANGD_RELEASE, profile));
		expect(installOf(rust.dap).install).toEqual(nativeInstallRequest(CODELLDB_RELEASE, profile));
		expect(installOf(cpp.dap).install).toEqual(nativeInstallRequest(CODELLDB_RELEASE, profile));
		const clangd = installOf(cpp.lsp);
		expect(clangd.launch.command).toBe(path.join(box.runtime.installDirectory("clangd", "23.1.0", profile), "clangd_23.1.0", "bin", "clangd"));
		const operation = clangd.install.operations[0];
		expect(operation?.type === "artifact" && operation.artifact.url).toBe(`${CLANGD}${MAC_CLANGD.file}`);
	}
});

// ── Shared CodeLLDB ─────────────────────────────────────────────────────────────────────────────

test("Rust and C/C++ share one CodeLLDB install and one stdio entry without --port or any listener", async () => {
	const box = sandbox();
	installRust(box);
	installCompilers(box);
	const rust = installOf((await planRust(await context(box))).dap);
	const cpp = installOf((await planCpp(await context(box))).dap);

	expect(rust.install).toEqual(cpp.install);
	expect(rust.launch).toEqual(cpp.launch);
	expect(rust.entries).toEqual(cpp.entries);
	expect(rust.tool.destination).toBe(box.runtime.installDirectory("codelldb", "1.12.3", "linux-x64"));
	expect(rust.launch).toEqual({ command: path.join(rust.tool.destination ?? "", "extension", "adapter", "codelldb"), args: [] });
	expect(rust.entries).toEqual([codelldbEntry(rust.launch.command)]);

	const entry = rust.entries[0];
	expect(entry?.kind).toBe("dap");
	expect(entry?.value).toMatchObject({
		args: [],
		connectMode: "stdio",
		launchDefaults: { request: "launch", stopOnEntry: true, terminal: "console", initCommands: ["settings set target.disable-aslr false"] },
		attachDefaults: { request: "attach" },
	});
	expect(entry?.value.languages).toEqual(expect.arrayContaining(["c", "cpp", "rust"]));
	const serialized = JSON.stringify([rust.install, rust.launch, rust.entries]);
	expect(serialized).not.toContain("--port");
	expect(serialized).not.toContain("--connect");
	expect(serialized).not.toContain("tcp");
	expect(serialized).not.toContain("socket");
	expect(rust.notes.join("\n")).toContain("stdio");
	expect(rust.notes.join("\n")).toContain("ptrace");
});

test("a codelldb on PATH is not substituted for the pinned stdio build", async () => {
	const box = sandbox();
	installCompilers(box);
	const stranger = writeTool(box.bin, "codelldb", 'echo "some other codelldb"');
	const dap = installOf((await planCpp(await context(box))).dap);
	expect(dap.launch.command).not.toBe(stranger);
	expect(dap.notes.join("\n")).toContain(stranger);
	expect(dap.notes.join("\n")).toContain("not used");
});

// ── Reuse ───────────────────────────────────────────────────────────────────────────────────────

test("a working rust-analyzer or clangd on PATH is reused with nothing to install or write", async () => {
	const box = sandbox();
	installRust(box);
	installCompilers(box);
	const ra = writeTool(box.bin, "rust-analyzer", 'echo "rust-analyzer 1.82.0 (f6e511e 2024-10-15)"');
	const clangd = writeTool(box.bin, "clangd", 'echo "clangd version 19.1.0"');
	const rust = reuseOf((await planRust(await context(box))).lsp);
	const cpp = reuseOf((await planCpp(await context(box))).lsp);

	expect(rust).toMatchObject({ source: "path", entries: [], launch: { command: ra, args: [] }, tool: { name: "rust-analyzer", version: "1.82.0" } });
	expect(cpp).toMatchObject({ source: "path", entries: [], launch: { command: clangd }, tool: { name: "clangd", version: "19.1.0" } });
	expect(rust.notes.join("\n")).toContain("nothing is installed");
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
	expect(lsp.launch.command).toBe(onPath);
	expect(lsp.entries).toHaveLength(1);
	expect(lsp.entries[0]).toMatchObject({ kind: "lsp", key: "clangd", value: { command: onPath } });
	expect(lsp.notes.join("\n")).toContain("node_modules/.bin/clangd");
});

test("a PATH tool that does not run is skipped with a disclosure and the pinned release is planned", async () => {
	const box = sandbox();
	installRust(box);
	// For example rustup's proxy when the component is not installed.
	const proxy = writeTool(box.bin, "rust-analyzer", 'echo "error: unknown binary" >&2; exit 1');
	const lsp = installOf((await planRust(await context(box))).lsp);
	expect(lsp.launch.command).not.toBe(proxy);
	expect(lsp.notes.join("\n")).toContain("did not run");
	expect(lsp.notes.join("\n")).toContain(proxy);
});

test("a configured, working entry is reused unchanged and keeps its own arguments", async () => {
	const box = sandbox();
	installCompilers(box);
	const mine = writeTool(path.join(box.root, "mine"), "clangd", 'echo "clangd version 18.1.8"');
	put(path.join(box.agentDir, "lsp.json"), { servers: { clangd: { command: mine, args: ["--background-index=false"], fileTypes: [".c", ".cpp", ".h"] } } });
	const lsp = reuseOf((await planCpp(await context(box))).lsp);
	expect(lsp).toMatchObject({ source: "configured", entries: [], launch: { command: mine, args: ["--background-index=false"] }, tool: { version: "18.1.8" } });
});

test("existing configuration that cannot be reused is reported and never replaced or bypassed", async () => {
	const missing = sandbox();
	installCompilers(missing);
	put(path.join(missing.agentDir, "lsp.json"), { servers: { clangd: { command: "/nonexistent/clangd" } } });
	const gone = blockedOf((await planCpp(await context(missing))).lsp);
	expect(gone.result.status).toBe("failed");
	expect(gone.result.detail).toContain("does not resolve");

	const disabled = sandbox();
	installRust(disabled);
	put(path.join(disabled.agentDir, "lsp.json"), { servers: { "rust-analyzer": { disabled: true } } });
	const off = blockedOf((await planRust(await context(disabled))).lsp);
	expect(off.result.status).toBe("failed");
	expect(off.result.detail).toContain("disabled");

	const narrow = sandbox();
	installCompilers(narrow);
	const c = writeTool(path.join(narrow.root, "mine"), "clangd", 'echo "clangd version 18.1.8"');
	put(path.join(narrow.agentDir, "lsp.json"), { servers: { clangd: { command: c, fileTypes: [".c"] } } });
	const partial = blockedOf((await planCpp(await context(narrow))).lsp);
	expect(partial.result.status).toBe("failed");
	expect(partial.result.detail).toContain(".cpp");

	const broken = sandbox();
	installCompilers(broken);
	const dead = writeTool(path.join(broken.root, "mine"), "clangd", "exit 9");
	put(path.join(broken.agentDir, "lsp.json"), { servers: { clangd: { command: dead } } });
	const crashed = blockedOf((await planCpp(await context(broken))).lsp);
	expect(crashed.result.status).toBe("failed");
	expect(crashed.result.detail).toContain("did not run");
});

test("a project-supplied entry is neither run nor replaced", async () => {
	const box = sandbox();
	installRust(box);
	const marker = path.join(box.root, "ran");
	const hook = writeTool(box.cwd, "evil", `touch "${marker}"`);
	put(path.join(box.cwd, ".omp", "lsp.json"), { servers: { "rust-analyzer": { command: hook } } });
	const lsp = blockedOf((await planRust(await context(box))).lsp);
	expect(lsp.result.status).toBe("failed");
	expect(lsp.result.detail).toContain("Project configuration");
	expect(fs.existsSync(marker)).toBe(false);
});

test("a configured codelldb must already use the verified stdio transport", async () => {
	const socket = sandbox();
	installCompilers(socket);
	const fake = writeTool(path.join(socket.root, "mine"), "codelldb", 'echo "usage: codelldb"');
	put(path.join(socket.agentDir, "dap.json"), { adapters: { codelldb: { command: fake, args: ["--port", "0"], connectMode: "socket" } } });
	const refused = blockedOf((await planCpp(await context(socket))).dap);
	expect(refused.result.status).toBe("failed");
	expect(refused.result.detail).toContain("stdio");
	// The language server is unaffected by the debugger conflict.
	expect(installOf((await planCpp(await context(socket))).lsp).install.tool).toBe("clangd");

	const listening = sandbox();
	installCompilers(listening);
	const fake2 = writeTool(path.join(listening.root, "mine"), "codelldb", 'echo "usage: codelldb"');
	put(path.join(listening.agentDir, "dap.json"), { adapters: { codelldb: { command: fake2, args: ["--port", "0"], connectMode: "stdio" } } });
	expect(blockedOf((await planCpp(await context(listening))).dap).result.status).toBe("failed");

	const implicit = sandbox();
	installCompilers(implicit);
	const fake3 = writeTool(path.join(implicit.root, "mine"), "codelldb", 'echo "usage: codelldb"');
	put(path.join(implicit.agentDir, "dap.json"), { adapters: { codelldb: { command: fake3 } } });
	expect(blockedOf((await planCpp(await context(implicit))).dap).result.status).toBe("failed");

	const good = sandbox();
	installCompilers(good);
	const fake4 = writeTool(path.join(good.root, "mine"), "codelldb", 'echo "usage: codelldb"');
	put(path.join(good.agentDir, "dap.json"), { adapters: { codelldb: { command: fake4, args: [], connectMode: "stdio" } } });
	expect(reuseOf((await planCpp(await context(good))).dap)).toMatchObject({ source: "configured", entries: [], launch: { command: fake4, args: [] } });
});

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
	const shared = reuseOf(cpp.dap);
	expect(shared).toMatchObject({ source: "managed", entries: [], launch: dap.launch });
	expect(installOf(cpp.lsp).install.tool).toBe("clangd");
	expect(reuseOf((await planRust(await context(box))).lsp)).toMatchObject({ source: "managed", entries: [], launch: { command: lsp.launch.command } });
	expect(reuseOf((await planRust(await context(box))).dap)).toMatchObject({ source: "managed", launch: dap.launch });
});

test("a config file omp may also read is disclosed because it can never make the entry ready", async () => {
	const box = sandbox();
	installCompilers(box);
	const foreign = path.join(box.home, ".claude", "lsp.json");
	put(foreign, { servers: { clangd: { command: "other-clangd" } } });
	const lsp = installOf((await planCpp(await context(box))).lsp);
	expect(lsp.notes.join("\n")).toContain(foreign);
	expect(lsp.notes.join("\n")).toContain("cannot be determined");
});

// ── Fixtures ────────────────────────────────────────────────────────────────────────────────────

async function readyPlans(box: Box): Promise<{ rust: LanguagePlan; cpp: LanguagePlan }> {
	return { rust: await planRust(await context(box)), cpp: await planCpp(await context(box)) };
}

test("the Rust fixture is a no-dependency Cargo package with a real cross-file definition and the answer-42 stop", async () => {
	const box = sandbox();
	installRust(box);
	installCompilers(box);
	const { rust } = await readyPlans(box);
	expect(rust.fixtures).toHaveLength(1);
	const fixture = fixtureOf(rust, "rust");

	const cargoToml = fileOf(fixture, "Cargo.toml");
	expect(cargoToml).toContain('edition = "2021"');
	expect(cargoToml).toContain("opt-level = 0");
	expect(cargoToml).toContain("debug = true");
	expect(cargoToml).toMatch(/\[dependencies\]\n\n/);

	expect(fixture.lsp.server).toBe("rust-analyzer");
	expect(fixture.lsp.file).toBe("src/main.rs");
	expect(lineAt(fileOf(fixture, fixture.lsp.file), fixture.lsp.line)).toContain(fixture.lsp.symbol);
	expect(lineAt(fileOf(fixture, fixture.lsp.file), fixture.lsp.line)).toContain("util::compute_answer(6, 7)");
	// The definition lives in a different file than the reference.
	expect(fixture.lsp.definition.file).toBe("src/util.rs");
	expect(fixture.lsp.definition.file).not.toBe(fixture.lsp.file);
	expect(lineAt(fileOf(fixture, fixture.lsp.definition.file), fixture.lsp.definition.line)).toContain("pub fn compute_answer(a: i32, b: i32)");

	expect(fixture.dap).toMatchObject({ adapter: "codelldb", program: "target/debug/answer-rust", variable: { name: "answer", value: "42" } });
	// The breakpoint is the line after `answer` is assigned, in the function reached from main.
	expect(fixture.dap.breakpoint.file).toBe("src/util.rs");
	expect(lineAt(fileOf(fixture, "src/util.rs"), fixture.dap.breakpoint.line)).toContain("return answer;");
	expect(lineAt(fileOf(fixture, "src/util.rs"), fixture.dap.breakpoint.line - 1)).toContain("let answer = a * b;");

	const cargo = box.runtime.resolveExecutable("cargo")?.path;
	expect(fixture.build).toEqual([expect.objectContaining({ command: cargo, args: ["build", "--offline"] })]);
});

test("C and C++ are distinct fixtures with their own sources, compiler, flags and expectations", async () => {
	const box = sandbox();
	installRust(box);
	installCompilers(box);
	const { cpp } = await readyPlans(box);
	const c = fixtureOf(cpp, "c");
	const cxx = fixtureOf(cpp, "cpp");
	const cc = box.runtime.resolveExecutable("cc")?.path;
	const cxxPath = box.runtime.resolveExecutable("c++")?.path;

	for (const [fixture, source, header, program, compiler] of [
		[c, "main.c", "answer.h", "answer-c", cc],
		[cxx, "main.cpp", "answer.hpp", "answer-cpp", cxxPath],
	] as const) {
		expect(fixture.lsp.server).toBe("clangd");
		expect(fixture.lsp.file).toBe(source);
		expect(lineAt(fileOf(fixture, source), fixture.lsp.line)).toContain("compute_answer(6, 7)");
		expect(fixture.lsp.definition.file).toBe(header);
		expect(fixture.lsp.definition.file).not.toBe(fixture.lsp.file);
		expect(lineAt(fileOf(fixture, header), fixture.lsp.definition.line)).toContain("compute_answer(int a, int b)");
		expect(fixture.dap).toMatchObject({ adapter: "codelldb", program, variable: { name: "answer", value: "42" } });
		// The breakpoint is the line after `answer` is assigned, inside the header function reached from main.
		expect(fixture.dap.breakpoint.file).toBe(header);
		expect(lineAt(fileOf(fixture, header), fixture.dap.breakpoint.line)).toContain("return answer;");
		expect(lineAt(fileOf(fixture, header), fixture.dap.breakpoint.line - 1)).toContain("answer = a * b");
		expect(fixture.build).toEqual([expect.objectContaining({ command: "/bin/sh", args: ["build.sh", compiler] })]);
		const script = fileOf(fixture, "build.sh");
		expect(script).toContain("-g -O0 -fno-inline");
		expect(script).toContain("compile_commands.json");
		expect(fixture.files.find(file => file.path === "build.sh")?.executable).toBe(true);
	}
	// Language-specific: a C++ class and standard flag versus a plain C function.
	expect(fileOf(cxx, "answer.hpp")).toContain("class Calculator");
	expect(fileOf(c, "answer.h")).toContain("static inline int compute_answer(int a, int b)");
	expect(fileOf(cxx, "build.sh")).toContain("-std=c++17");
	expect(fileOf(c, "build.sh")).not.toContain("-std=");
	expect(fixtureOf(cpp, "c").files.map(file => file.path)).not.toEqual(fixtureOf(cpp, "cpp").files.map(file => file.path));
});

const hasCompilers = Bun.which("cc") !== null && Bun.which("c++") !== null && fs.existsSync("/bin/sh");

function materialize(fixture: FixtureCase, dir: string): void {
	for (const file of fixture.files) {
		const target = path.join(dir, ...file.path.split("/"));
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, file.content, { mode: file.executable === true ? 0o755 : 0o644 });
	}
}

function build(fixture: FixtureCase, dir: string): void {
	for (const step of fixture.build ?? []) {
		const result = cp.spawnSync(step.command, [...step.args], { cwd: path.join(dir, step.cwd ?? "."), encoding: "utf8", timeout: 120_000, env: { PATH: process.env.PATH ?? "" } });
		if (result.status !== 0) throw new Error(`${step.label} failed (${result.status}): ${result.stderr}${result.error ?? ""}`);
	}
}

test.skipIf(!hasCompilers)("the C and C++ fixtures really build on this host and record a valid compile_commands.json with an absolute directory", async () => {
	const box = sandbox({ path: process.env.PATH ?? "" });
	const { cpp } = await readyPlans(box);
	expect(cpp.lsp.status === "blocked" || cpp.dap.status === "blocked").toBe(false);
	for (const fixture of cpp.fixtures) {
		// A directory with a space and a quote proves the generated JSON is escaped.
		const dir = path.join(box.root, `fix ${fixture.id} "q"`);
		fs.mkdirSync(dir);
		materialize(fixture, dir);
		build(fixture, dir);

		const database: unknown = JSON.parse(fs.readFileSync(path.join(dir, "compile_commands.json"), "utf8"));
		expect(Array.isArray(database)).toBe(true);
		const [entry] = database as Array<{ directory: string; arguments: string[]; file: string }>;
		expect(entry?.directory).toBe(fs.realpathSync(dir));
		expect(path.isAbsolute(entry?.directory ?? "")).toBe(true);
		expect(entry?.file).toBe(fixture.lsp.file);
		expect(entry?.arguments.slice(1)).toEqual(expect.arrayContaining(["-g", "-O0", "-c", fixture.lsp.file, "-o", "main.o"]));
		expect(path.isAbsolute(entry?.arguments[0] ?? "")).toBe(true);
		if (fixture.id === "cpp") expect(entry?.arguments).toContain("-std=c++17");

		// The binary exists and exits 0 only when answer == 42.
		const program = path.join(dir, fixture.dap.program);
		expect(fs.statSync(program).mode & 0o111).not.toBe(0);
		expect(cp.spawnSync(program, { timeout: 30_000 }).status).toBe(0);
	}
});

test.skipIf(Bun.which("cargo") === null || Bun.which("rustc") === null)("the Rust fixture builds offline with a real toolchain and exits 0 only when answer is 42", async () => {
	const box = sandbox({ path: process.env.PATH ?? "" });
	const rust = await planRust(await context(box));
	const fixture = fixtureOf(rust, "rust");
	const dir = path.join(box.root, "fix-rust");
	fs.mkdirSync(dir);
	materialize(fixture, dir);
	build(fixture, dir);
	expect(cp.spawnSync(path.join(dir, fixture.dap.program), { timeout: 30_000 }).status).toBe(0);
});
