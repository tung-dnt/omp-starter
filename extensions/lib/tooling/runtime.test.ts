import { afterEach, expect, test } from "bun:test";
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";
import {
	absolutePathDirs,
	acquireLock,
	ARCHIVE_LIMITS,
	buildChildEnv,
	createRuntime,
	detectPlatform,
	ensureToolingRoots,
	extractArchive,
	inspectArchive,
	INSTALL_MANIFEST_FILE,
	MARKER_VARIABLE,
	removeTree,
	RuntimeError,
	sha256Hex,
	writeFileAtomic,
} from "./runtime";
import type { ArchiveLimits, Artifact, InstallRequest, PlatformInput, Runtime, RuntimeOptions } from "./types";

// ── Harness ─────────────────────────────────────────────────────────────────────────────────────

const cleanups: (() => Promise<unknown> | unknown)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface Box {
	root: string;
	agentDir: string;
	project: string;
	home: string;
	tooling: string;
}

/** Private agent directory, project and home. Registered first, so it is removed after the runtimes. */
function box(): Box {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "omp-runtime-test-")));
	cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
	const result = {
		root,
		agentDir: path.join(root, "agent"),
		project: path.join(root, "project"),
		home: path.join(root, "home"),
		tooling: path.join(root, "agent", "tooling"),
	};
	fs.mkdirSync(result.project, { recursive: true });
	fs.mkdirSync(result.home, { recursive: true });
	return result;
}

const UBUNTU: PlatformInput = { platform: "linux", arch: "x64", osRelease: "ID=ubuntu\nID_LIKE=debian\n" };

function runtimeFor(b: Box, extra: Partial<RuntimeOptions> = {}): Runtime {
	const runtime = createRuntime({
		agentDir: b.agentDir,
		cwd: b.project,
		env: { PATH: process.env.PATH, HOME: b.home },
		platform: UBUNTU,
		...extra,
	});
	cleanups.push(() => runtime.dispose());
	return runtime;
}

async function failure(promise: Promise<unknown>): Promise<RuntimeError> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof RuntimeError) return error;
		throw error;
	}
	throw new Error("expected the operation to fail");
}

/**
 * Polls state that a real child process sets (here: its pid file). There is no promise or event to await
 * for a grandchild's readiness, and the behaviour under test is itself wall-clock bound (timeouts, the
 * two second kill grace), so fake timers cannot drive it. Used only to wait for that readiness.
 */
async function eventually(check: () => boolean, ms = 8000): Promise<boolean> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (check()) return true;
		await Bun.sleep(25);
	}
	return check();
}

/** A zombie counts as gone: it is dead and only waiting to be reaped. */
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
	const stat = cp.spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
	return stat !== "" && !stat.startsWith("Z");
}

function pidsIn(file: string): number[] {
	try {
		return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(Number);
	} catch {
		return [];
	}
}

function deadPid(): number {
	const child = cp.spawnSync(process.execPath, ["-e", "0"]);
	if (child.pid === undefined) throw new Error("could not start a throwaway process");
	return child.pid;
}

function executable(file: string, content = "#!/bin/sh\nexit 0\n"): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
	fs.chmodSync(file, 0o755);
}

const HANG = [
	'const { spawn } = require("node:child_process");',
	'const fs = require("node:fs");',
	'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });',
	'fs.writeFileSync(process.argv[2], process.pid + "\\n" + child.pid);',
	'process.stdout.write("ready\\n");',
	"setInterval(() => {}, 1000);",
].join("\n");

const DAEMONIZE = [
	'const { spawn } = require("node:child_process");',
	'const fs = require("node:fs");',
	'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });',
	'fs.writeFileSync(process.argv[2], process.pid + "\\n" + child.pid);',
	"child.unref();",
	"process.exit(0);",
].join("\n");

const IGNORE_TERM = 'trap "" TERM\necho $$ > "$1"\nwhile :; do sleep 1; done\n';

async function scriptDir(runtime: Runtime, files: Record<string, string>): Promise<{ dir: string; file: (name: string) => string }> {
	const work = await runtime.workDir("scripts");
	for (const [name, source] of Object.entries(files)) fs.writeFileSync(path.join(work.path, name), source);
	return { dir: work.path, file: name => path.join(work.path, name) };
}

// ── Platform profiles ───────────────────────────────────────────────────────────────────────────

test("only macOS x64/arm64 and Ubuntu/Debian glibc x64 are supported", () => {
	const supported: [PlatformInput, string][] = [
		[{ platform: "darwin", arch: "arm64" }, "darwin-arm64"],
		[{ platform: "darwin", arch: "x64" }, "darwin-x64"],
		[{ platform: "linux", arch: "x64", osRelease: "ID=ubuntu\nID_LIKE=debian\n" }, "linux-x64"],
		[{ platform: "linux", arch: "x64", osRelease: 'ID="debian"\n' }, "linux-x64"],
		[{ platform: "linux", arch: "x64", osRelease: 'ID=linuxmint\nID_LIKE="ubuntu debian"\n' }, "linux-x64"],
	];
	for (const [input, id] of supported) expect(detectPlatform(input)).toMatchObject({ supported: true, platform: { id } });

	const unsupported: [PlatformInput, RegExp][] = [
		[{ platform: "linux", arch: "x64", osRelease: "ID=fedora\n" }, /outside the supported/],
		[{ platform: "linux", arch: "x64", osRelease: "ID=ubuntu\n", musl: true }, /musl/],
		[{ platform: "linux", arch: "arm64", osRelease: "ID=ubuntu\n" }, /arm64/],
		[{ platform: "linux", arch: "x64" }, /could not be determined/],
		[{ platform: "darwin", arch: "ia32" }, /ia32/],
		[{ platform: "win32", arch: "x64" }, /not supported/],
	];
	for (const [input, reason] of unsupported) {
		const detection = detectPlatform(input);
		expect(detection.supported).toBe(false);
		expect(detection.supported ? "" : detection.reason).toMatch(reason);
	}
});

// ── Child environment ───────────────────────────────────────────────────────────────────────────

test("the child environment is an allowlist with private locations and the ownership marker", () => {
	const scratch = { home: "/s/home", config: "/s/config", cache: "/s/cache", data: "/s/data", state: "/s/state", tmp: "/s/tmp" };

	const env = buildChildEnv({
		parent: { PATH: "relative/bin::/usr/bin:/bin:/usr/bin", ANTHROPIC_API_KEY: "secret", HTTP_PROXY: "http://proxy.example:3128", CARGO_HOME: "/explicit/cargo" },
		scratch,
		marker: "runtime.1",
		sdkHomes: { CARGO_HOME: "/derived/cargo", RUSTUP_HOME: "/derived/rustup" },
		override: { EXTRA: "1" },
	});

	expect(env.PATH).toBe("/usr/bin:/bin");
	expect(env.ANTHROPIC_API_KEY).toBeUndefined();
	expect(env.HTTP_PROXY).toBe("http://proxy.example:3128");
	expect(env.CARGO_HOME).toBe("/explicit/cargo");
	expect(env.RUSTUP_HOME).toBe("/derived/rustup");
	expect(env.EXTRA).toBe("1");
	expect(env.HOME).toBe("/s/home");
	expect(env.XDG_CACHE_HOME).toBe("/s/cache");
	expect(env[MARKER_VARIABLE]).toBe("runtime.1");
	expect(env.PIP_CONFIG_FILE).toBe("/dev/null");
	expect(env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
	// An undefined value is dropped when spawning and silently loses its isolation setting, so none may exist.
	expect(Object.entries(env).filter(([, value]) => typeof value !== "string")).toEqual([]);
	expect(() => buildChildEnv({ parent: {}, scratch, marker: "m", override: { [MARKER_VARIABLE]: "evil" } })).toThrow("reserved");
	expect(() => buildChildEnv({ parent: {}, scratch, marker: "m", override: { "A=B": "x" } })).toThrow("invalid environment variable");
});

test("real children get a private home, no inherited secrets and no hidden SDK downloads", async () => {
	const b = box();
	const parent = {
		PATH: process.env.PATH,
		HOME: "/home/real-user",
		ANTHROPIC_API_KEY: "sk-ant-secret",
		OPENAI_API_KEY: "sk-openai-secret",
		GITHUB_TOKEN: "ghp_secret",
		MCP_SERVERS: '{"x":1}',
		NODE_OPTIONS: "--require /tmp/hook.js",
		npm_config_registry: "https://registry.evil.example",
		npm_config_userconfig: "/home/real-user/.npmrc",
		GOFLAGS: "-mod=mod",
		GOPROXY: "https://evil.example",
		GOPRIVATE: "*.corp",
		GONOSUMDB: "*",
		PYTHONSTARTUP: "/tmp/startup.py",
		PYTHONPATH: "/tmp/py",
		HTTPS_PROXY: "http://proxy.example:3128",
		SSL_CERT_FILE: "/etc/ssl/corp.pem",
		GOROOT: "/opt/go",
		RUSTUP_TOOLCHAIN: "stable",
	};
	const runtime = runtimeFor(b, { env: parent });
	const { dir, file } = await scriptDir(runtime, { "env.cjs": "console.log(JSON.stringify({ env: process.env, cwd: process.cwd() }));\n" });

	const result = await runtime.run(process.execPath, [file("env.cjs")], { cwd: dir, timeoutMs: 20_000 });
	const seen: { env: Record<string, string | undefined>; cwd: string } = JSON.parse(result.stdout);

	for (const name of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GITHUB_TOKEN", "MCP_SERVERS", "NODE_OPTIONS", "npm_config_registry", "PYTHONSTARTUP", "PYTHONPATH"]) {
		expect(seen.env[name]).toBeUndefined();
	}
	expect(seen.cwd).toBe(dir);
	expect(seen.env.HOME?.startsWith(path.join(b.tooling, ".work"))).toBe(true);
	expect(fs.readFileSync(seen.env.npm_config_userconfig ?? "", "utf8")).toBe("");
	expect(seen.env.PATH).toBe(absolutePathDirs(parent.PATH).join(path.delimiter));
	expect(seen.env[MARKER_VARIABLE]).toBeDefined();
	expect(seen.env).toMatchObject({
		GOFLAGS: "",
		GOPROXY: "https://proxy.golang.org",
		GOSUMDB: "sum.golang.org",
		GOPRIVATE: "",
		GONOSUMDB: "",
		GOENV: "off",
		GOTOOLCHAIN: "local",
		GOWORK: "off",
		RUSTUP_AUTO_INSTALL: "0",
		PIP_CONFIG_FILE: "/dev/null",
		GIT_CONFIG_GLOBAL: "/dev/null",
		PYTHONNOUSERSITE: "1",
		npm_config_ignore_scripts: "true",
		HTTPS_PROXY: "http://proxy.example:3128",
		SSL_CERT_FILE: "/etc/ssl/corp.pem",
		GOROOT: "/opt/go",
		RUSTUP_TOOLCHAIN: "stable",
	});
}, 30_000);

// ── Executable lookup and approved probes ───────────────────────────────────────────────────────

test("lookup ignores relative and empty PATH entries and rejects names with separators", () => {
	const b = box();
	const bin = path.join(b.root, "bin");
	executable(path.join(bin, "tool"));
	executable(path.join(b.project, "tool"));
	const runtime = runtimeFor(b, { env: { PATH: [".", "", "relative", bin].join(path.delimiter) } });

	expect(runtime.resolveExecutable("tool")).toEqual({ path: path.join(bin, "tool"), origin: "path" });
	expect(runtime.resolveExecutable("nothing-here")).toBeUndefined();
	expect(() => runtime.resolveExecutable("a/b")).toThrow();
});

test("project-local executables are disclosed and need approval before they run", async () => {
	const b = box();
	fs.writeFileSync(path.join(b.project, "package.json"), "{}\n");
	const local = path.join(b.project, "node_modules", ".bin", "tool");
	executable(local, "#!/bin/sh\necho local-tool\n");
	const runtime = runtimeFor(b, { env: { PATH: "/usr/bin:/bin" } });

	expect(runtime.resolveExecutable("tool")).toBeUndefined();
	expect(runtime.resolveExecutable("tool", { projectLocal: true })).toEqual({ path: local, origin: "project-local" });
	expect((await failure(runtime.probe(local, []))).code).toBe("unapproved");
	expect((await runtime.probe(local, [], { approvedProjectLocal: true })).stdout).toBe("local-tool\n");

	const onPath = runtimeFor(b, { env: { PATH: `${path.dirname(local)}:/usr/bin:/bin` } });
	expect(onPath.resolveExecutable("tool")?.origin).toBe("project-local");
	const refused = await failure(onPath.run("tool", [], { cwd: (await onPath.workDir("x")).path }));
	expect(refused.code).toBe("unapproved");
}, 30_000);

test("a probe runs from a fresh owned directory outside the project with the SDK-safe environment", async () => {
	const b = box();
	const runtime = runtimeFor(b);
	const { file } = await scriptDir(runtime, { "where.cjs": "console.log(JSON.stringify({ cwd: process.cwd(), env: process.env }));\n" });

	const result = await runtime.probe(process.execPath, [file("where.cjs")]);
	const seen: { cwd: string; env: Record<string, string | undefined> } = JSON.parse(result.stdout);

	expect(seen.cwd.startsWith(path.join(b.tooling, ".work"))).toBe(true);
	expect(seen.cwd).not.toBe(b.project);
	expect(seen.env.GOTOOLCHAIN).toBe("local");
	expect(seen.env.RUSTUP_AUTO_INSTALL).toBe("0");
	expect(fs.existsSync(seen.cwd)).toBe(false);
	expect((await failure(runtime.probe("tool", []))).code).toBe("invalid-argument");
}, 30_000);

// ── run(): argv, bounds and refusals ────────────────────────────────────────────────────────────

test("arguments reach the program literally and no shell ever interprets them", async () => {
	const b = box();
	const runtime = runtimeFor(b);
	const { dir, file } = await scriptDir(runtime, { "argv.cjs": "console.log(JSON.stringify(process.argv.slice(2)));\n" });
	const args = ["$(touch pwned)", "; echo hi", "a b", "'quoted'", "`id`", "*"];

	const result = await runtime.run(process.execPath, [file("argv.cjs"), ...args], { cwd: dir });

	expect(JSON.parse(result.stdout)).toEqual(args);
	expect(fs.existsSync(path.join(dir, "pwned"))).toBe(false);
	expect(result.stderr).toBe("");
}, 30_000);

test("a failing command throws an actionable error with a redacted stderr tail", async () => {
	const b = box();
	const runtime = runtimeFor(b);
	const { dir, file } = await scriptDir(runtime, {
		"fail.cjs": "console.error('boom: https://user:hunter2@registry.example/pkg failed'); process.exit(3);\n",
	});

	const error = await failure(runtime.run(process.execPath, [file("fail.cjs")], { cwd: dir }));

	expect(error.code).toBe("exit");
	expect(error.message).toContain("code 3");
	expect(error.message).toContain("boom:");
	expect(error.message).not.toContain("hunter2");
}, 30_000);

test("captured output is bounded and flagged instead of buffered without limit", async () => {
	const b = box();
	const runtime = runtimeFor(b);
	const { dir, file } = await scriptDir(runtime, { "noise.cjs": 'process.stdout.write("x".repeat(3 * 1024 * 1024));\n' });

	const result = await runtime.run(process.execPath, [file("noise.cjs")], { cwd: dir, maxOutputBytes: 4096 });

	expect(result.stdout).toHaveLength(4096);
	expect(result.stdoutTruncated).toBe(true);
	expect(result.stderrTruncated).toBe(false);
}, 30_000);

test("commands never run in the user's project or any directory the runtime does not own", async () => {
	const b = box();
	const runtime = runtimeFor(b);
	const cases = [b.project, b.home, os.tmpdir(), "relative/dir", path.join(b.root, "missing")];

	for (const cwd of cases) {
		expect((await failure(runtime.run(process.execPath, ["--version"], { cwd }))).code).toBe("cwd");
	}
}, 30_000);

test("invalid arguments are rejected before anything is started", async () => {
	const b = box();
	const runtime = runtimeFor(b);
	const work = await runtime.workDir("args");
	const run = (command: string, args: string[], extra: Partial<Parameters<Runtime["run"]>[2]> = {}) =>
		failure(runtime.run(command, args, { cwd: work.path, ...extra }));

	expect((await run(process.execPath, [], { timeoutMs: 0 })).code).toBe("invalid-argument");
	expect((await run(process.execPath, [], { timeoutMs: 300_001 })).code).toBe("invalid-argument");
	expect((await run(process.execPath, [], { timeoutMs: Number.NaN })).code).toBe("invalid-argument");
	expect((await run(process.execPath, [], { maxOutputBytes: 0 })).code).toBe("invalid-argument");
	expect((await run(process.execPath, [], { env: { [MARKER_VARIABLE]: "x" } })).code).toBe("invalid-argument");
	expect((await run(process.execPath, ["a\0b"])).code).toBe("invalid-argument");
	expect((await run("./relative-tool", [])).code).toBe("invalid-argument");
	const missing = await run("definitely-not-installed-xyz", []);
	expect(missing.code).toBe("executable-not-found");
	expect(missing.message).toContain("never installs");
}, 30_000);

// ── Process ownership and cleanup (real processes) ──────────────────────────────────────────────

test("a timeout stops the whole tree including a detached descendant", async () => {
	const b = box();
	const runtime = runtimeFor(b);
	const { dir, file } = await scriptDir(runtime, { "hang.cjs": HANG });
	const pidFile = path.join(dir, "pids");

	const error = await failure(runtime.run(process.execPath, [file("hang.cjs"), pidFile], { cwd: dir, timeoutMs: 2500 }));

	expect(error.code).toBe("timeout");
	const pids = pidsIn(pidFile);
	expect(pids).toHaveLength(2);
	for (const pid of pids) expect(isAlive(pid)).toBe(false);
}, 30_000);

test("aborting a command stops its tree and reports cancellation", async () => {
	const b = box();
	const runtime = runtimeFor(b);
	const { dir, file } = await scriptDir(runtime, { "hang.cjs": HANG });
	const pidFile = path.join(dir, "pids");
	const controller = new AbortController();

	const outcome = failure(runtime.run(process.execPath, [file("hang.cjs"), pidFile], { cwd: dir, signal: controller.signal }));
	expect(await eventually(() => pidsIn(pidFile).length === 2)).toBe(true);
	controller.abort();

	expect((await outcome).code).toBe("aborted");
	for (const pid of pidsIn(pidFile)) expect(isAlive(pid)).toBe(false);
}, 30_000);

test("aborting the runtime's own signal cancels every command and refuses new ones", async () => {
	const b = box();
	const controller = new AbortController();
	const runtime = runtimeFor(b, { signal: controller.signal });
	const { dir, file } = await scriptDir(runtime, { "hang.cjs": HANG });
	const pidFile = path.join(dir, "pids");

	const outcome = failure(runtime.run(process.execPath, [file("hang.cjs"), pidFile], { cwd: dir }));
	expect(await eventually(() => pidsIn(pidFile).length === 2)).toBe(true);
	controller.abort();

	expect((await outcome).code).toBe("aborted");
	for (const pid of pidsIn(pidFile)) expect(isAlive(pid)).toBe(false);
	expect((await failure(runtime.run(process.execPath, ["--version"], { cwd: dir }))).code).toBe("aborted");
}, 30_000);

test("a process that ignores SIGTERM is killed after the two second grace period", async () => {
	const b = box();
	const runtime = runtimeFor(b);
	const { dir, file } = await scriptDir(runtime, { "ignore.sh": IGNORE_TERM });
	const pidFile = path.join(dir, "pid");
	const started = Date.now();

	const error = await failure(runtime.run("/bin/sh", [file("ignore.sh"), pidFile], { cwd: dir, timeoutMs: 800 }));

	expect(error.code).toBe("timeout");
	expect(Date.now() - started).toBeGreaterThanOrEqual(2500);
	expect(pidsIn(pidFile)).toHaveLength(1);
	expect(isAlive(pidsIn(pidFile)[0]!)).toBe(false);
}, 30_000);

test("a daemonized descendant that outlives a successful command is found by its marker and stopped", async () => {
	const b = box();
	const runtime = runtimeFor(b);
	const { dir, file } = await scriptDir(runtime, { "daemonize.cjs": DAEMONIZE });
	const pidFile = path.join(dir, "pids");

	await runtime.run(process.execPath, [file("daemonize.cjs"), pidFile], { cwd: dir, timeoutMs: 20_000 });

	const [, daemon] = pidsIn(pidFile);
	expect(daemon).toBeGreaterThan(0);
	expect(isAlive(daemon!)).toBe(false);
}, 30_000);

test("spawn exposes the protocol streams and terminate cleans the owned tree", async () => {
	const b = box();
	const runtime = runtimeFor(b);
	const { dir, file } = await scriptDir(runtime, {
		"upper.cjs": 'process.stdin.setEncoding("utf8");\nprocess.stdin.on("data", chunk => process.stdout.write(chunk.toUpperCase()));\n',
	});
	const proc = await runtime.spawn(process.execPath, [file("upper.cjs")], { cwd: dir, stdin: "pipe" });
	const echoed = Promise.withResolvers<void>();
	let output = "";
	proc.stdout?.on("data", chunk => {
		output += chunk.toString();
		if (output.includes("HELLO")) echoed.resolve();
	});

	proc.stdin?.write("hello\n");
	await echoed.promise;
	const cleanup = await proc.terminate();

	expect(output).toBe("HELLO\n");
	expect(cleanup.survivors).toEqual([]);
	expect(proc.marker.length).toBeGreaterThan(0);
	expect(isAlive(proc.pid)).toBe(false);
}, 30_000);

test("dispose terminates processes started with spawn, removes scratch state and refuses further work", async () => {
	const b = box();
	const runtime = runtimeFor(b);
	const { dir, file } = await scriptDir(runtime, { "hang.cjs": HANG });
	const pidFile = path.join(dir, "pids");
	const proc = await runtime.spawn(process.execPath, [file("hang.cjs"), pidFile], { cwd: dir });
	const ready = Promise.withResolvers<void>();
	proc.stdout?.on("data", chunk => {
		if (chunk.toString().includes("ready")) ready.resolve();
	});
	await ready.promise;

	const result = await runtime.dispose();

	expect(result.survivors).toEqual([]);
	for (const pid of pidsIn(pidFile)) expect(isAlive(pid)).toBe(false);
	expect((await proc.exited).error).toBeUndefined();
	expect(fs.readdirSync(path.join(b.tooling, ".work"))).toEqual([]);
	expect((await failure(runtime.run(process.execPath, ["--version"], { cwd: dir }))).code).toBe("disposed");
	expect(await runtime.dispose()).toEqual(result);
}, 30_000);

// ── Filesystem primitives ───────────────────────────────────────────────────────────────────────

test("removeTree deletes read-only trees such as a Go module cache", async () => {
	const b = box();
	const tree = path.join(b.root, "modcache");
	fs.mkdirSync(path.join(tree, "pkg", "sub"), { recursive: true });
	fs.writeFileSync(path.join(tree, "pkg", "sub", "file.go"), "package sub\n");
	fs.chmodSync(path.join(tree, "pkg", "sub", "file.go"), 0o444);
	for (const dir of [path.join(tree, "pkg", "sub"), path.join(tree, "pkg"), tree]) fs.chmodSync(dir, 0o555);

	await removeTree(tree);

	expect(fs.existsSync(tree)).toBe(false);
});

test("atomic writes replace the file whole and leave no temporary files, even on failure", async () => {
	const b = box();
	const file = path.join(b.root, "out.json");
	fs.writeFileSync(file, "old");

	await writeFileAtomic(file, "new content", 0o600);
	await expect(writeFileAtomic(path.join(b.root, "missing", "out.json"), "x", 0o600)).rejects.toThrow();

	expect(fs.readFileSync(file, "utf8")).toBe("new content");
	expect(fs.statSync(file).mode & 0o077).toBe(0);
	expect(fs.readdirSync(b.root).filter(name => name.endsWith(".tmp"))).toEqual([]);
});

test("locks are exclusive for a live owner and reclaimed once the owner is gone", async () => {
	const b = box();
	const roots = await ensureToolingRoots(b.agentDir);
	const lockDir = path.join(roots.locks, "demo.lock");

	const held = await acquireLock(lockDir, "demo work");
	expect((await failure(acquireLock(lockDir, "demo work"))).code).toBe("busy");
	await held.release();
	expect(fs.existsSync(lockDir)).toBe(false);

	fs.mkdirSync(lockDir);
	fs.writeFileSync(path.join(lockDir, "owner.json"), JSON.stringify({ pid: deadPid() }));
	const reclaimed = await acquireLock(lockDir, "demo work");
	expect(JSON.parse(fs.readFileSync(path.join(lockDir, "owner.json"), "utf8")).pid).toBe(process.pid);
	await reclaimed.release();

	fs.mkdirSync(lockDir);
	expect((await failure(acquireLock(lockDir, "demo work"))).code).toBe("busy");
	const old = new Date(Date.now() - 60_000);
	fs.utimesSync(lockDir, old, old);
	await (await acquireLock(lockDir, "demo work")).release();
});

test("the tooling root must be a private real directory", async () => {
	const symlinked = box();
	fs.mkdirSync(path.join(symlinked.root, "elsewhere"));
	fs.mkdirSync(symlinked.agentDir, { recursive: true });
	fs.symlinkSync(path.join(symlinked.root, "elsewhere"), symlinked.tooling);
	expect((await failure(runtimeFor(symlinked).workDir("x"))).code).toBe("destination");

	const writable = box();
	fs.mkdirSync(writable.tooling, { recursive: true });
	fs.chmodSync(writable.tooling, 0o777);
	const error = await failure(runtimeFor(writable).workDir("x"));
	expect(error.code).toBe("destination");
	expect(error.message).toContain("writable by other users");
});

test("work directories are owned and removable, scratch state disappears on dispose, and dead runs are swept", async () => {
	const b = box();
	const roots = await ensureToolingRoots(b.agentDir);
	const dead = deadPid();
	for (const base of [roots.work, roots.staging]) {
		fs.mkdirSync(path.join(base, "crashed-run"));
		fs.writeFileSync(path.join(base, "crashed-run", "leftover"), "x");
		fs.writeFileSync(path.join(base, "crashed-run", "owner.json"), JSON.stringify({ pid: dead }));
		fs.mkdirSync(path.join(base, "live-run"));
		fs.writeFileSync(path.join(base, "live-run", "owner.json"), JSON.stringify({ pid: process.pid }));
	}
	const runtime = runtimeFor(b);

	const work = await runtime.workDir("my probe!");
	fs.writeFileSync(path.join(work.path, "f"), "x");

	expect(work.path.startsWith(roots.work)).toBe(true);
	expect(path.basename(work.path).startsWith("my-probe-")).toBe(true);
	for (const base of [roots.work, roots.staging]) {
		expect(fs.existsSync(path.join(base, "crashed-run"))).toBe(false);
		expect(fs.existsSync(path.join(base, "live-run"))).toBe(true);
	}
	await work.remove();
	expect(fs.existsSync(work.path)).toBe(false);

	await runtime.dispose();
	expect(fs.readdirSync(roots.work)).toEqual(["live-run"]);
});

// ── Archive builders ────────────────────────────────────────────────────────────────────────────

interface ZipSpec {
	name: string;
	data?: string | Buffer;
	type?: "file" | "directory" | "symlink";
	mode?: number;
	method?: number;
	flags?: number;
	madeBy?: number;
	unixType?: number;
	localName?: string;
	declaredSize?: number;
	crc?: number;
	offset?: number;
	storedOverride?: Buffer;
}

function zipOf(specs: readonly ZipSpec[]): Buffer {
	const body: Buffer[] = [];
	const directory: Buffer[] = [];
	let offset = 0;
	for (const spec of specs) {
		const type = spec.type ?? (spec.name.endsWith("/") ? "directory" : "file");
		const raw = type === "directory" ? Buffer.alloc(0) : Buffer.from(spec.data ?? "");
		const method = type === "directory" ? 0 : (spec.method ?? 8);
		const stored = spec.storedOverride ?? (method === 8 ? zlib.deflateRawSync(raw) : raw);
		const name = Buffer.from(spec.name);
		const localName = Buffer.from(spec.localName ?? spec.name);
		const crc = spec.crc ?? zlib.crc32(raw);
		const flags = spec.flags ?? 0;
		const unixType = spec.unixType ?? (type === "directory" ? 0o040000 : type === "symlink" ? 0o120000 : 0o100000);
		const mode = spec.mode ?? (type === "directory" ? 0o755 : type === "symlink" ? 0o777 : 0o644);
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(flags, 6);
		local.writeUInt16LE(method, 8);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(stored.length, 18);
		local.writeUInt32LE(raw.length, 22);
		local.writeUInt16LE(localName.length, 26);
		const entry = Buffer.alloc(46);
		entry.writeUInt32LE(0x02014b50, 0);
		entry.writeUInt16LE(spec.madeBy ?? (3 << 8) | 20, 4);
		entry.writeUInt16LE(20, 6);
		entry.writeUInt16LE(flags, 8);
		entry.writeUInt16LE(method, 10);
		entry.writeUInt32LE(crc, 16);
		entry.writeUInt32LE(stored.length, 20);
		entry.writeUInt32LE(spec.declaredSize ?? raw.length, 24);
		entry.writeUInt16LE(name.length, 28);
		entry.writeUInt32LE(((unixType | mode) << 16) >>> 0, 38);
		entry.writeUInt32LE(spec.offset ?? offset, 42);
		body.push(local, localName, stored);
		directory.push(entry, name);
		offset += local.length + localName.length + stored.length;
	}
	const central = Buffer.concat(directory);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(specs.length, 8);
	end.writeUInt16LE(specs.length, 10);
	end.writeUInt32LE(central.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...body, central, end]);
}

interface TarSpec {
	name: string;
	data?: string | Buffer;
	typeflag?: string;
	mode?: number;
	linkname?: string;
	prefix?: string;
	pax?: Record<string, string>;
	badChecksum?: boolean;
	size?: number;
}

function octal(value: number, width: number): string {
	return `${value.toString(8).padStart(width - 1, "0")}\0`;
}

function tarHeader(fields: { name: string; typeflag: string; size: number; mode: number; linkname?: string; prefix?: string; badChecksum?: boolean }): Buffer {
	const block = Buffer.alloc(512);
	block.write(fields.name, 0, 100, "utf8");
	block.write(octal(fields.mode, 8), 100, 8, "latin1");
	block.write(octal(0, 8), 108, 8, "latin1");
	block.write(octal(0, 8), 116, 8, "latin1");
	block.write(octal(fields.size, 12), 124, 12, "latin1");
	block.write(octal(0, 12), 136, 12, "latin1");
	block.fill(0x20, 148, 156);
	block.write(fields.typeflag, 156, 1, "latin1");
	block.write(fields.linkname ?? "", 157, 100, "utf8");
	block.write("ustar\0", 257, 6, "latin1");
	block.write("00", 263, 2, "latin1");
	block.write(fields.prefix ?? "", 345, 155, "utf8");
	let sum = 0;
	for (const byte of block) sum += byte;
	block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "latin1");
	if (fields.badChecksum) block[0] = block[0]! ^ 0x01;
	return block;
}

function padded(data: Buffer): Buffer {
	const remainder = data.length % 512;
	return remainder === 0 ? data : Buffer.concat([data, Buffer.alloc(512 - remainder)]);
}

function paxRecord(key: string, value: string): Buffer {
	const body = ` ${key}=${value}\n`;
	let length = Buffer.byteLength(body) + 1;
	while (String(length).length + Buffer.byteLength(body) !== length) length = String(length).length + Buffer.byteLength(body);
	return Buffer.from(`${length}${body}`);
}

function tarOf(specs: readonly TarSpec[], options: { terminator?: boolean } = {}): Buffer {
	const parts: Buffer[] = [];
	for (const spec of specs) {
		const data = Buffer.from(spec.data ?? "");
		if (spec.pax !== undefined) {
			const records = Buffer.concat(Object.entries(spec.pax).map(([key, value]) => paxRecord(key, value)));
			parts.push(tarHeader({ name: "PaxHeader/x", typeflag: "x", size: records.length, mode: 0o644 }), padded(records));
		}
		parts.push(
			tarHeader({
				name: spec.name,
				typeflag: spec.typeflag ?? "0",
				size: spec.size ?? data.length,
				mode: spec.mode ?? 0o644,
				linkname: spec.linkname,
				prefix: spec.prefix,
				badChecksum: spec.badChecksum,
			}),
			padded(data),
		);
	}
	if (options.terminator !== false) parts.push(Buffer.alloc(1024));
	return Buffer.concat(parts);
}

function tarGz(specs: readonly TarSpec[], options: { terminator?: boolean } = {}): Buffer {
	return zlib.gzipSync(tarOf(specs, options));
}

function stage(b: Box, name: string, bytes: Buffer): string {
	const file = path.join(b.root, name);
	fs.writeFileSync(file, bytes);
	return file;
}

const GOOD_ZIP = zipOf([
	{ name: "bin/", type: "directory" },
	{ name: "bin/tool", data: "#!/bin/sh\necho tool\n", mode: 0o755 },
	{ name: "lib/libtool.so.1", data: "library bytes" },
	{ name: "lib/libtool.so", type: "symlink", data: "libtool.so.1" },
	{ name: "README.md", data: "docs", mode: 0o4644 },
]);

const GOOD_TAR = tarGz([
	{ name: "./", typeflag: "5", mode: 0o755 },
	{ name: "pkg/", typeflag: "5", mode: 0o755 },
	{ name: "pkg/run.sh", data: "#!/bin/sh\necho run\n", mode: 0o4755 },
	{ name: "pkg/data.txt", data: "data", mode: 0o664 },
]);

// ── ZIP / VSIX ──────────────────────────────────────────────────────────────────────────────────

test("zip metadata is listed with sanitized modes and safe relative symlinks", async () => {
	const b = box();

	const listing = await inspectArchive(stage(b, "ok.zip", GOOD_ZIP), "zip");

	expect(listing.entries.map(entry => [entry.path, entry.type, entry.mode])).toEqual([
		["bin", "directory", 0o755],
		["bin/tool", "file", 0o755],
		["lib/libtool.so.1", "file", 0o644],
		["lib/libtool.so", "symlink", 0o777],
		["README.md", "file", 0o644],
	]);
	expect(listing.entries.find(entry => entry.path === "lib/libtool.so")?.target).toBe("libtool.so.1");
	expect(listing.expandedBytes).toBeGreaterThan(0);
});

test("zip extraction keeps executable modes, strips setuid and creates symlinks last", async () => {
	const b = box();
	const dest = path.join(b.root, "out");

	await extractArchive(stage(b, "ok.zip", GOOD_ZIP), "zip", dest);

	expect(fs.readFileSync(path.join(dest, "bin", "tool"), "utf8")).toBe("#!/bin/sh\necho tool\n");
	expect(fs.statSync(path.join(dest, "bin", "tool")).mode & 0o7777).toBe(0o755);
	expect(fs.statSync(path.join(dest, "README.md")).mode & 0o7777).toBe(0o644);
	expect(fs.lstatSync(path.join(dest, "lib", "libtool.so")).isSymbolicLink()).toBe(true);
	expect(fs.readlinkSync(path.join(dest, "lib", "libtool.so"))).toBe("libtool.so.1");
	expect(fs.readFileSync(path.join(dest, "lib", "libtool.so"), "utf8")).toBe("library bytes");
});

const ZIP_ATTACKS: [string, Buffer, RegExp][] = [
	["path traversal", zipOf([{ name: "../evil.txt", data: "x" }]), /path traversal/],
	["nested path traversal", zipOf([{ name: "a/../../evil.txt", data: "x" }]), /path traversal/],
	["an absolute path", zipOf([{ name: "/etc/evil", data: "x" }]), /absolute/],
	["a drive-letter path", zipOf([{ name: "C:/evil", data: "x" }]), /absolute/],
	["a backslash path", zipOf([{ name: "..\\evil", data: "x" }]), /unsafe entry name/],
	["a NUL byte in a name", zipOf([{ name: "a\0b", data: "x" }]), /unsafe entry name/],
	["a control character in a name", zipOf([{ name: "a\nb", data: "x" }]), /control character/],
	["a symlink escaping the root", zipOf([{ name: "escape", type: "symlink", data: "../outside" }]), /escapes the extraction directory/],
	["an absolute symlink", zipOf([{ name: "abs", type: "symlink", data: "/etc/passwd" }]), /must be a relative path/],
	[
		"a symlink chain that climbs out with a later ..",
		zipOf([{ name: "d/", type: "directory" }, { name: "d/l1", type: "symlink", data: ".." }, { name: "d/l2", type: "symlink", data: "l1/.." }]),
		/after a path component/,
	],
	[
		"a symlink resolved through another symlink",
		zipOf([
			{ name: "real/", type: "directory" },
			{ name: "real/file", data: "x" },
			{ name: "alias", type: "symlink", data: "real" },
			{ name: "viaalias", type: "symlink", data: "alias/file" },
		]),
		/passes through another symbolic link/,
	],
	["a dangling symlink", zipOf([{ name: "dangling", type: "symlink", data: "nothing-here" }]), /not part of the archive/],
	["a symlink loop", zipOf([{ name: "a", type: "symlink", data: "b" }, { name: "b", type: "symlink", data: "a" }]), /loops/],
	["a self-referencing symlink", zipOf([{ name: "self", type: "symlink", data: "self" }]), /loops/],
	["a FIFO", zipOf([{ name: "fifo", unixType: 0o010000 }]), /device, FIFO or socket/],
	["a character device", zipOf([{ name: "tty", unixType: 0o020000 }]), /device, FIFO or socket/],
	["a block device", zipOf([{ name: "disk", unixType: 0o060000 }]), /device, FIFO or socket/],
	["a socket", zipOf([{ name: "sock", unixType: 0o140000 }]), /device, FIFO or socket/],
	["duplicate names", zipOf([{ name: "a", data: "1" }, { name: "a", data: "2" }]), /duplicate/],
	["case-colliding names", zipOf([{ name: "File.txt", data: "1" }, { name: "file.txt", data: "2" }]), /collide/],
	["case-colliding implied directories", zipOf([{ name: "Dir/a", data: "1" }, { name: "dir/b", data: "2" }]), /collide/],
	["an entry inside a file", zipOf([{ name: "a", data: "1" }, { name: "a/b", data: "2" }]), /inside non-directory entry/],
	["a file that is also a directory", zipOf([{ name: "a/b", data: "2" }, { name: "a", data: "1" }]), /both a file or link and a directory/],
	["an encrypted entry", zipOf([{ name: "secret", data: "x", flags: 1 }]), /encrypted/],
	["an unsupported compression method", zipOf([{ name: "a", data: "x", method: 12 }]), /unsupported compression method 12/],
	["disagreeing local and central names", zipOf([{ name: "a", data: "x", localName: "b" }]), /disagree/],
	["overlapping entries", zipOf([{ name: "a", data: "AAAA" }, { name: "a", data: "AAAA", offset: 0 }]), /overlap/],
	["text that is not a zip", Buffer.from("this is plainly not a zip file at all"), /not a ZIP archive/],
	["a file that is too small", Buffer.from("PK"), /too small/],
	["a zip cut off before its directory", GOOD_ZIP.subarray(0, GOOD_ZIP.length - 30), /not a ZIP archive/],
];

for (const [name, bytes, pattern] of ZIP_ATTACKS) {
	test(`zip with ${name} is rejected before anything is extracted`, async () => {
		const b = box();
		const file = stage(b, "attack.zip", bytes);
		const dest = path.join(b.root, "out");

		const inspected = await failure(inspectArchive(file, "zip"));
		const extracted = await failure(extractArchive(file, "zip", dest));

		expect(inspected.code).toBe("archive");
		expect(inspected.message).toMatch(pattern);
		expect(extracted.code).toBe("archive");
		expect(fs.existsSync(dest)).toBe(false);
	});
}

const ZIP_DATA_FAULTS: [string, Buffer, RegExp][] = [
	["data larger than its declared size", zipOf([{ name: "big.txt", data: "0123456789", declaredSize: 3 }]), /beyond its declared size/],
	["data smaller than its declared size", zipOf([{ name: "short.txt", data: "0123456789", declaredSize: 50 }]), /shorter than its declared size/],
	["a wrong CRC-32", zipOf([{ name: "crc.txt", data: "hello", crc: 0x12345678 }]), /CRC-32/],
	["corrupt deflate data", zipOf([{ name: "bad.txt", data: "x", storedOverride: Buffer.from("definitely not deflate") }]), /corrupt compressed data/],
];

for (const [name, bytes, pattern] of ZIP_DATA_FAULTS) {
	test(`zip with ${name} fails during extraction, never silently`, async () => {
		const b = box();

		const error = await failure(extractArchive(stage(b, "fault.zip", bytes), "zip", path.join(b.root, "out")));

		expect(error.code).toBe("archive");
		expect(error.message).toMatch(pattern);
	});
}

test("zip limits on entries, expanded bytes and archive size are enforced", async () => {
	const b = box();
	const file = stage(b, "limits.zip", zipOf([{ name: "a", data: "0123456789" }, { name: "b", data: "x" }, { name: "c", data: "y" }]));
	const roomy: ArchiveLimits = { compressedBytes: 1e9, expandedBytes: 1e9, entries: 100 };

	expect((await failure(inspectArchive(file, "zip", { ...roomy, entries: 2 }))).message).toMatch(/entries; the limit is 2/);
	expect((await failure(inspectArchive(file, "zip", { ...roomy, expandedBytes: 5 }))).message).toMatch(/expands beyond/);
	expect((await failure(inspectArchive(file, "zip", { ...roomy, compressedBytes: 10 }))).message).toMatch(/limit is 10/);
	expect((await inspectArchive(file, "zip", roomy)).entries).toHaveLength(3);
	expect(ARCHIVE_LIMITS).toEqual({ compressedBytes: 200 * 1024 * 1024, expandedBytes: 1024 * 1024 * 1024, entries: 20_000 });
});

test("extraction refuses a destination that already holds files", async () => {
	const b = box();
	const dest = path.join(b.root, "out");
	fs.mkdirSync(dest);
	fs.writeFileSync(path.join(dest, "existing"), "keep");

	const error = await failure(extractArchive(stage(b, "ok.zip", GOOD_ZIP), "zip", dest));

	expect(error.code).toBe("invalid-argument");
	expect(fs.readdirSync(dest)).toEqual(["existing"]);
});

// ── tar.gz and single-file gzip ─────────────────────────────────────────────────────────────────

test("tar.gz lists regular files and directories (including a GNU ./ root) and extracts them", async () => {
	const b = box();
	const file = stage(b, "ok.tar.gz", GOOD_TAR);
	const dest = path.join(b.root, "out");

	const listing = await inspectArchive(file, "tar.gz");
	await extractArchive(file, "tar.gz", dest);

	expect(listing.entries.map(entry => [entry.path, entry.type, entry.mode])).toEqual([
		["pkg", "directory", 0o755],
		["pkg/run.sh", "file", 0o755],
		["pkg/data.txt", "file", 0o644],
	]);
	expect(fs.readFileSync(path.join(dest, "pkg", "run.sh"), "utf8")).toBe("#!/bin/sh\necho run\n");
	expect(fs.statSync(path.join(dest, "pkg", "run.sh")).mode & 0o7777).toBe(0o755);
	expect(fs.statSync(path.join(dest, "pkg", "data.txt")).mode & 0o7777).toBe(0o644);
});

test("tar.gz honours pax long paths and ustar prefixes", async () => {
	const b = box();
	const long = `${"d".repeat(60)}/${"e".repeat(60)}/${"f".repeat(60)}/file.txt`;
	const file = stage(
		b,
		"long.tar.gz",
		tarGz([
			{ name: "PLACEHOLDER", data: "long", pax: { path: long } },
			{ name: "file.txt", prefix: "some/dir", data: "prefixed" },
		]),
	);
	const dest = path.join(b.root, "out");

	const listing = await extractArchive(file, "tar.gz", dest);

	expect(listing.entries.map(entry => entry.path)).toEqual([long, "some/dir/file.txt"]);
	expect(fs.readFileSync(path.join(dest, ...long.split("/")), "utf8")).toBe("long");
	expect(fs.readFileSync(path.join(dest, "some", "dir", "file.txt"), "utf8")).toBe("prefixed");
});

const TAR_ATTACKS: [string, Buffer, RegExp][] = [
	["a symbolic link", tarGz([{ name: "link", typeflag: "2", linkname: "target" }]), /symbolic link/],
	["a hard link", tarGz([{ name: "hard", typeflag: "1", linkname: "other" }]), /hard link/],
	["a FIFO", tarGz([{ name: "fifo", typeflag: "6" }]), /unsupported type/],
	["a character device", tarGz([{ name: "tty", typeflag: "3" }]), /unsupported type/],
	["path traversal", tarGz([{ name: "../evil", data: "x" }]), /path traversal/],
	["an absolute path", tarGz([{ name: "/etc/evil", data: "x" }]), /absolute/],
	["duplicate names", tarGz([{ name: "a", data: "1" }, { name: "a", data: "2" }]), /duplicate/],
	["case-colliding names", tarGz([{ name: "A", data: "1" }, { name: "a", data: "2" }]), /collide/],
	["a corrupt header checksum", tarGz([{ name: "a", data: "1", badChecksum: true }]), /checksum/],
	["no entries", zlib.gzipSync(Buffer.alloc(1024)), /no entries/],
	["a body cut short", tarGz([{ name: "a", data: "hello", size: 5000 }], { terminator: false }), /truncated/],
	["data that is not gzip", Buffer.from("plain text, definitely not gzip"), /corrupt or truncated gzip/],
	["a gzip stream cut off", GOOD_TAR.subarray(0, GOOD_TAR.length - 12), /corrupt or truncated gzip/],
];

for (const [name, bytes, pattern] of TAR_ATTACKS) {
	test(`tar.gz with ${name} is rejected before anything is extracted`, async () => {
		const b = box();
		const file = stage(b, "attack.tar.gz", bytes);
		const dest = path.join(b.root, "out");

		const inspected = await failure(inspectArchive(file, "tar.gz"));
		const extracted = await failure(extractArchive(file, "tar.gz", dest));

		expect(inspected.code).toBe("archive");
		expect(inspected.message).toMatch(pattern);
		expect(extracted.code).toBe("archive");
		expect(fs.existsSync(dest)).toBe(false);
	});
}

test("tar.gz enforces the expanded-size limit", async () => {
	const b = box();
	const file = stage(b, "big.tar.gz", tarGz([{ name: "a", data: "four" }]));

	const error = await failure(inspectArchive(file, "tar.gz", { compressedBytes: 1e9, expandedBytes: 3, entries: 10 }));

	expect(error.message).toMatch(/expands beyond/);
});

test("a single-file gzip extracts under the pinned name with the requested mode", async () => {
	const b = box();
	const file = stage(b, "analyzer.gz", zlib.gzipSync(Buffer.from("#!/bin/sh\necho analyzer\n")));

	const listing = await extractArchive(file, "gzip", path.join(b.root, "bin"), { fileName: "rust-analyzer", executable: true });
	await extractArchive(file, "gzip", path.join(b.root, "plain"), { fileName: "data" });

	expect(listing.entries).toEqual([{ path: "rust-analyzer", type: "file", size: 24, mode: 0o755 }]);
	expect(fs.readFileSync(path.join(b.root, "bin", "rust-analyzer"), "utf8")).toBe("#!/bin/sh\necho analyzer\n");
	expect(fs.statSync(path.join(b.root, "bin", "rust-analyzer")).mode & 0o777).toBe(0o755);
	expect(fs.statSync(path.join(b.root, "plain", "data")).mode & 0o777).toBe(0o644);
});

test("a single-file gzip needs a plain file name, caps expansion and rejects corruption", async () => {
	const b = box();
	const file = stage(b, "x.gz", zlib.gzipSync(Buffer.alloc(5 * 1024 * 1024)));

	expect((await failure(inspectArchive(file, "gzip"))).code).toBe("invalid-argument");
	expect((await failure(inspectArchive(file, "gzip", ARCHIVE_LIMITS, { fileName: "a/b" }))).code).toBe("invalid-argument");
	const bomb = await failure(inspectArchive(file, "gzip", { compressedBytes: 1e9, expandedBytes: 1024 * 1024, entries: 10 }, { fileName: "x" }));
	expect(bomb.message).toMatch(/expands beyond/);
	const corrupt = await failure(inspectArchive(stage(b, "bad.gz", Buffer.from("not gzip")), "gzip", ARCHIVE_LIMITS, { fileName: "x" }));
	expect(corrupt.message).toMatch(/corrupt or truncated gzip/);
});

// ── Pinned, integrity-checked installs ──────────────────────────────────────────────────────────

const ZIP_URL = "https://github.com/example/tool/releases/download/v1.0.0/tool-linux.zip";

type Route = () => Response | Promise<Response>;

function serve(routes: Record<string, Route>): { fetch: typeof fetch; calls: string[] } {
	const calls: string[] = [];
	const handler = async (input: string | URL | Request): Promise<Response> => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		calls.push(url);
		const route = routes[url];
		return route === undefined ? new Response("not found", { status: 404 }) : route();
	};
	return { fetch: handler as typeof fetch, calls };
}

function artifactOf(bytes: Buffer, overrides: Partial<Artifact> = {}): Artifact {
	return {
		url: ZIP_URL,
		version: "1.0.0",
		sha256: sha256Hex(bytes),
		format: "zip",
		provenance: "test fixture digest",
		reviewed: "2026-10-26",
		...overrides,
	};
}

function requestOf(artifact: Artifact, extra: Partial<InstallRequest> = {}): InstallRequest {
	return { tool: "tool", version: "1.0.0", operations: [{ type: "artifact", artifact }], executables: ["bin/tool"], ...extra };
}

function leftovers(b: Box): { staging: string[]; locks: string[] } {
	return { staging: fs.readdirSync(path.join(b.tooling, ".staging")), locks: fs.readdirSync(path.join(b.tooling, ".locks")) };
}

test("an install is verified, extracted in staging and published atomically with a manifest", async () => {
	const b = box();
	const served = serve({ [ZIP_URL]: () => new Response(GOOD_ZIP) });
	const runtime = runtimeFor(b, { fetch: served.fetch });
	const messages: string[] = [];

	const result = await runtime.install(requestOf(artifactOf(GOOD_ZIP)), { onProgress: message => messages.push(message) });

	const dest = path.join(b.tooling, "tool", "1.0.0", "linux-x64");
	expect(result).toMatchObject({ status: "installed", destination: dest });
	expect(result.destination).toBe(runtime.installDirectory("tool", "1.0.0"));
	expect(fs.statSync(path.join(dest, "bin", "tool")).mode & 0o111).not.toBe(0);
	expect(fs.readlinkSync(path.join(dest, "lib", "libtool.so"))).toBe("libtool.so.1");
	expect(fs.statSync(path.join(dest, "README.md")).mode & 0o7000).toBe(0);
	const manifest = JSON.parse(fs.readFileSync(path.join(dest, INSTALL_MANIFEST_FILE), "utf8"));
	expect(manifest).toMatchObject({
		schema: 1,
		tool: "tool",
		version: "1.0.0",
		platform: "linux-x64",
		executables: ["bin/tool"],
		artifacts: [{ url: ZIP_URL, sha256: sha256Hex(GOOD_ZIP), provenance: "test fixture digest", reviewed: "2026-10-26", format: "zip" }],
	});
	expect(leftovers(b)).toEqual({ staging: [], locks: [] });
	expect(served.calls).toEqual([ZIP_URL]);
	expect(messages.some(message => message.startsWith("Downloading"))).toBe(true);
	expect(messages.some(message => message.startsWith("Publishing"))).toBe(true);
}, 30_000);

test("installing the same pinned recipe again reuses the install without any network", async () => {
	const b = box();
	const served = serve({ [ZIP_URL]: () => new Response(GOOD_ZIP) });
	const runtime = runtimeFor(b, { fetch: served.fetch });
	const request = requestOf(artifactOf(GOOD_ZIP));

	const first = await runtime.install(request);
	const second = await runtime.install(request);

	expect(second.status).toBe("reused");
	expect(second.manifest).toEqual(first.manifest);
	expect(served.calls).toHaveLength(1);
}, 30_000);

test("a different recipe for an existing version is a collision and nothing is replaced", async () => {
	const b = box();
	const served = serve({ [ZIP_URL]: () => new Response(GOOD_ZIP) });
	const runtime = runtimeFor(b, { fetch: served.fetch });
	await runtime.install(requestOf(artifactOf(GOOD_ZIP)));
	const other = zipOf([{ name: "bin/tool", data: "#!/bin/sh\necho other\n", mode: 0o755 }]);

	const error = await failure(runtime.install(requestOf(artifactOf(other))));

	expect(error.code).toBe("collision");
	expect(error.message).toContain("Nothing was replaced");
	expect(fs.readFileSync(path.join(b.tooling, "tool", "1.0.0", "linux-x64", "bin", "tool"), "utf8")).toContain("echo tool");
	expect(served.calls).toHaveLength(1);
}, 30_000);

test("an existing directory that is not a complete install is never replaced", async () => {
	const b = box();
	const dest = path.join(b.tooling, "tool", "1.0.0", "linux-x64");
	fs.mkdirSync(dest, { recursive: true, mode: 0o700 });
	fs.writeFileSync(path.join(dest, "mine.txt"), "user data");
	const served = serve({ [ZIP_URL]: () => new Response(GOOD_ZIP) });
	const runtime = runtimeFor(b, { fetch: served.fetch });

	const error = await failure(runtime.install(requestOf(artifactOf(GOOD_ZIP))));

	expect(error.code).toBe("collision");
	expect(fs.readFileSync(path.join(dest, "mine.txt"), "utf8")).toBe("user data");
	expect(served.calls).toEqual([]);
}, 30_000);

test("a SHA-256 mismatch publishes nothing and cleans up", async () => {
	const b = box();
	const served = serve({ [ZIP_URL]: () => new Response(GOOD_ZIP) });
	const runtime = runtimeFor(b, { fetch: served.fetch });

	const error = await failure(runtime.install(requestOf(artifactOf(GOOD_ZIP, { sha256: "0".repeat(64) }))));

	expect(error.code).toBe("integrity");
	expect(error.message).toContain(sha256Hex(GOOD_ZIP));
	expect(fs.existsSync(path.join(b.tooling, "tool"))).toBe(false);
	expect(leftovers(b)).toEqual({ staging: [], locks: [] });
}, 30_000);

test("redirects are followed only to approved HTTPS hosts and signed URLs never reach error messages", async () => {
	const b = box();
	const signed = "https://objects.githubusercontent.com/blob/tool.zip?sig=secret-signature";
	const served = serve({
		[ZIP_URL]: () => new Response(null, { status: 302, headers: { location: signed } }),
		[signed]: () => new Response(GOOD_ZIP),
	});
	const runtime = runtimeFor(b, { fetch: served.fetch });

	const result = await runtime.install(requestOf(artifactOf(GOOD_ZIP)));
	expect(result.status).toBe("installed");
	expect(served.calls).toEqual([ZIP_URL, signed]);

	for (const [target, pattern] of [
		["https://evil.example/tool.zip?sig=secret-signature", /not an approved download host/],
		["http://github.com/example/tool.zip", /non-HTTPS/],
		["https://user:pass@github.com/example/tool.zip", /credentials/],
	] as const) {
		const other = box();
		const hostile = serve({ [ZIP_URL]: () => new Response(null, { status: 302, headers: { location: target } }) });
		const error = await failure(runtimeFor(other, { fetch: hostile.fetch }).install(requestOf(artifactOf(GOOD_ZIP))));
		expect(error.code).toBe("download");
		expect(error.message).toMatch(pattern);
		expect(error.message).not.toContain("secret-signature");
		expect(error.message).not.toContain("pass@");
		expect(hostile.calls).toEqual([ZIP_URL]);
	}
}, 30_000);

test("unapproved hosts, plain http and malformed pins are rejected before any request", async () => {
	const b = box();
	const served = serve({});
	const runtime = runtimeFor(b, { fetch: served.fetch });

	const host = await failure(runtime.install(requestOf(artifactOf(GOOD_ZIP, { url: "https://example.com/tool.zip" }))));
	expect(host.code).toBe("download");
	for (const overrides of [
		{ url: "http://github.com/example/tool.zip" },
		{ url: "not a url" },
		{ sha256: "ABC" },
		{ format: "rar" as never },
		{ reviewed: "yesterday" },
		{ provenance: "" },
	]) {
		expect((await failure(runtime.install(requestOf(artifactOf(GOOD_ZIP, overrides))))).code).toBe("invalid-argument");
	}
	expect(served.calls).toEqual([]);
}, 30_000);

test("downloads are capped by size whether or not the server declares a length", async () => {
	const b = box();
	const served = serve({ [ZIP_URL]: () => new Response(GOOD_ZIP) });
	const runtime = runtimeFor(b, { fetch: served.fetch, archiveLimits: { compressedBytes: 64, expandedBytes: 1e6, entries: 100 } });

	const error = await failure(runtime.install(requestOf(artifactOf(GOOD_ZIP))));

	expect(error.code).toBe("download");
	expect(error.message).toMatch(/limit/);
	const chunked = serve({
		[ZIP_URL]: () =>
			new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(new Uint8Array(40));
						controller.enqueue(new Uint8Array(40));
						controller.close();
					},
				}),
			),
	});
	const streaming = await failure(runtimeFor(box(), { fetch: chunked.fetch, archiveLimits: { compressedBytes: 64, expandedBytes: 1e6, entries: 100 } }).install(requestOf(artifactOf(GOOD_ZIP))));
	expect(streaming.message).toMatch(/limit/);
}, 30_000);

test("an unsupported platform is reported before any request or install", async () => {
	const b = box();
	const served = serve({ [ZIP_URL]: () => new Response(GOOD_ZIP) });
	const runtime = runtimeFor(b, { fetch: served.fetch, platform: { platform: "linux", arch: "arm64", osRelease: "ID=ubuntu\n" } });

	const error = await failure(runtime.install(requestOf(artifactOf(GOOD_ZIP))));

	expect(runtime.platform.supported).toBe(false);
	expect(error.code).toBe("unsupported-platform");
	expect(() => runtime.installDirectory("tool", "1.0.0")).toThrow();
	expect(runtime.installDirectory("tool", "1.0.0", "linux-x64")).toBe(path.join(b.tooling, "tool", "1.0.0", "linux-x64"));
	expect(served.calls).toEqual([]);
	expect(fs.existsSync(b.tooling)).toBe(false);
});

test("tool and version names cannot escape the tooling directory", async () => {
	const b = box();
	const runtime = runtimeFor(b, { fetch: serve({}).fetch });

	for (const [tool, version] of [
		["../evil", "1.0.0"],
		["a/b", "1.0.0"],
		["tool", ".."],
		["tool", "1/../../x"],
		["", "1.0.0"],
		[".hidden", "1.0.0"],
	]) {
		expect((await failure(runtime.install({ tool, version, operations: [{ type: "write-file", path: "f", content: "x" }] }))).code).toBe("invalid-argument");
	}
	expect(fs.existsSync(path.join(b.root, "evil"))).toBe(false);
});

test("a competing install of the same tool fails clearly instead of sharing partial output", async () => {
	const b = box();
	const started = Promise.withResolvers<void>();
	const gate = Promise.withResolvers<void>();
	const served = serve({
		[ZIP_URL]: async () => {
			started.resolve();
			await gate.promise;
			return new Response(GOOD_ZIP);
		},
	});
	const runtime = runtimeFor(b, { fetch: served.fetch });
	const request = requestOf(artifactOf(GOOD_ZIP));

	const first = runtime.install(request);
	await started.promise;
	const competing = await failure(runtime.install(request));
	gate.resolve();
	const done = await first;

	expect(competing.code).toBe("busy");
	expect(done.status).toBe("installed");
	expect(leftovers(b)).toEqual({ staging: [], locks: [] });
}, 30_000);

test("a lock left by a dead run is reclaimed and a live owner blocks the install", async () => {
	const b = box();
	const served = serve({ [ZIP_URL]: () => new Response(GOOD_ZIP) });
	const runtime = runtimeFor(b, { fetch: served.fetch });
	const request = requestOf(artifactOf(GOOD_ZIP));
	const roots = await ensureToolingRoots(b.agentDir);
	const lockDir = path.join(roots.locks, "tool-1.0.0-linux-x64.lock");
	fs.mkdirSync(lockDir);
	fs.writeFileSync(path.join(lockDir, "owner.json"), JSON.stringify({ pid: process.pid }));

	expect((await failure(runtime.install(request))).code).toBe("busy");
	expect(served.calls).toEqual([]);

	fs.writeFileSync(path.join(lockDir, "owner.json"), JSON.stringify({ pid: deadPid() }));
	expect((await runtime.install(request)).status).toBe("installed");
}, 30_000);

test("staged commands run in the install directory with the isolated environment before atomic publication", async () => {
	const b = box();
	const runtime = runtimeFor(b);
	const maker = [
		'const fs = require("node:fs");',
		'const path = require("node:path");',
		"const dir = process.argv[2];",
		'fs.mkdirSync(path.join(dir, "bin"), { recursive: true });',
		'fs.writeFileSync(path.join(dir, "bin", "tool"), "#!/bin/sh\\necho staged\\n");',
		'fs.chmodSync(path.join(dir, "bin", "tool"), 0o755);',
		'fs.writeFileSync(path.join(dir, "env.json"), JSON.stringify({ toolchain: process.env.GOTOOLCHAIN, home: process.env.HOME, extra: process.env.EXTRA, cwd: process.cwd() }));',
	].join("\n");

	const result = await runtime.install({
		tool: "staged",
		version: "2.0.0",
		operations: [
			{ type: "write-file", path: "make.cjs", content: maker },
			{ type: "run", command: process.execPath, args: ["@INSTALL_DIR@/make.cjs", "@INSTALL_DIR@"], env: { EXTRA: "@INSTALL_DIR@/extra" } },
		],
		executables: ["bin/tool"],
	});

	const seen = JSON.parse(fs.readFileSync(path.join(result.destination, "env.json"), "utf8"));
	expect(result.status).toBe("installed");
	expect(seen.toolchain).toBe("local");
	expect(seen.home.startsWith(path.join(b.tooling, ".work"))).toBe(true);
	expect(seen.extra.endsWith(`${path.sep}payload${path.sep}extra`)).toBe(true);
	expect(seen.cwd.startsWith(path.join(b.tooling, ".staging"))).toBe(true);
	expect(leftovers(b)).toEqual({ staging: [], locks: [] });
}, 30_000);

test("a failing staged command publishes nothing", async () => {
	const b = box();
	const runtime = runtimeFor(b);

	const error = await failure(
		runtime.install({
			tool: "broken",
			version: "1.0.0",
			operations: [
				{ type: "write-file", path: "note.txt", content: "x" },
				{ type: "run", command: process.execPath, args: ["-e", "process.exit(3)"] },
			],
		}),
	);

	expect(error.code).toBe("exit");
	expect(fs.existsSync(path.join(b.tooling, "broken"))).toBe(false);
	expect(leftovers(b)).toEqual({ staging: [], locks: [] });
}, 30_000);

test("missing executables, reserved names and escaping paths block publication", async () => {
	const b = box();
	const served = serve({ [ZIP_URL]: () => new Response(GOOD_ZIP) });
	const runtime = runtimeFor(b, { fetch: served.fetch });

	const missing = await failure(runtime.install(requestOf(artifactOf(GOOD_ZIP), { executables: ["bin/missing"] })));
	expect(missing.code).toBe("install");
	expect(missing.message).toContain("incomplete");

	const reservedZip = zipOf([{ name: INSTALL_MANIFEST_FILE, data: "{}" }, { name: "bin/tool", data: "x", mode: 0o755 }]);
	const reserved = serve({ [ZIP_URL]: () => new Response(reservedZip) });
	const hostile = await failure(runtimeFor(box(), { fetch: reserved.fetch }).install(requestOf(artifactOf(reservedZip))));
	expect(hostile.code).toBe("install");
	expect(hostile.message).toContain("reserved");

	for (const operation of [
		{ type: "write-file" as const, path: "../outside.txt", content: "x" },
		{ type: "write-file" as const, path: "/abs.txt", content: "x" },
		{ type: "run" as const, command: process.execPath, args: [], cwd: ".." },
	]) {
		expect((await failure(runtime.install({ tool: "escape", version: "1.0.0", operations: [operation] }))).code).toBe("invalid-argument");
	}
	expect(fs.existsSync(path.join(b.tooling, "tool"))).toBe(false);
	expect(fs.existsSync(path.join(b.tooling, "escape"))).toBe(false);
	expect(fs.existsSync(path.join(b.root, "outside.txt"))).toBe(false);
}, 30_000);

test("cancelling an install mid-download stops cleanly and leaves no staging, lock or published files", async () => {
	const b = box();
	const controller = new AbortController();
	const started = Promise.withResolvers<void>();
	const hanging = ((_input: unknown, init?: RequestInit) => {
		const pending = Promise.withResolvers<Response>();
		init?.signal?.addEventListener("abort", () => pending.reject(new Error("aborted")));
		started.resolve();
		return pending.promise;
	}) as typeof fetch;
	const runtime = runtimeFor(b, { fetch: hanging });

	const outcome = failure(runtime.install(requestOf(artifactOf(GOOD_ZIP)), { signal: controller.signal }));
	await started.promise;
	controller.abort();

	expect((await outcome).code).toBe("aborted");
	expect(fs.existsSync(path.join(b.tooling, "tool"))).toBe(false);
	expect(leftovers(b)).toEqual({ staging: [], locks: [] });
}, 30_000);
