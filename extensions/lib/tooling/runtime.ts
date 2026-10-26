// Safe user-local tooling runtime (design C1).
//
// Everything that can touch the user's machine on behalf of guided tooling goes through here:
// argv-only bounded subprocesses with owned process trees, an allowlisted child environment,
// pinned HTTPS downloads, in-process archive validation/extraction, and atomic, exclusive,
// immutable publication under `<agentDir>/tooling`. Bun/Node built-ins only: no archive or
// process packages, no shell, no system `unzip`.
import * as cp from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Readable, Writable } from "node:stream";
import * as zlib from "node:zlib";
import { INSTALL_DIR_TOKEN } from "./types";
import type {
	ArchiveEntry,
	ArchiveFormat,
	ArchiveLimits,
	ArchiveListing,
	Artifact,
	ArtifactRecord,
	CleanupResult,
	ExitStatus,
	InstallManifest,
	InstallOperation,
	InstallOptions,
	InstallRequest,
	InstallResult,
	OwnedProcess,
	Platform,
	PlatformDetection,
	PlatformInput,
	ProbeOptions,
	ProfileId,
	ResolveOptions,
	ResolvedExecutable,
	RunOptions,
	RunResult,
	Runtime,
	RuntimeErrorCode,
	RuntimeOptions,
	SpawnOptions,
	SurvivingProcess,
	WorkDir,
} from "./types";

// ── Contract constants ──────────────────────────────────────────────────────────────────────────

/** Ceiling for installer operations and for SDK probes/builds. */
export const INSTALL_TIMEOUT_MS = 300_000;
export const PROBE_TIMEOUT_MS = 300_000;
/** Ceiling for protocol (LSP/DAP) requests; consumed by the verifier. */
export const PROTOCOL_TIMEOUT_MS = 30_000;
/** Grace between SIGTERM and SIGKILL. */
export const KILL_GRACE_MS = 2_000;
export const ARCHIVE_LIMITS: ArchiveLimits = {
	compressedBytes: 200 * 1024 * 1024,
	expandedBytes: 1024 * 1024 * 1024,
	entries: 20_000,
};
/** Environment variable that marks every process the runtime starts (and so its descendants). */
export const MARKER_VARIABLE = "OMP_STARTER_TOOLING_OWNER";
export const INSTALL_MANIFEST_FILE = ".omp-starter-install.json";

/** The POSIX null device: pip and git read it as "no configuration file". Spelled out because `os.devnull` (wrong case) is undefined and would silently drop the setting. */
const NULL_DEVICE = "/dev/null";
const DEFAULT_OUTPUT_BYTES = 1024 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const TAIL_BYTES = 4096;
const ERROR_TAIL_CHARS = 600;
const POLL_MS = 25;
const KILL_WAIT_MS = 2_000;
const STREAM_DRAIN_MS = 1_000;
const MAX_REDIRECTS = 5;
const STALE_LOCK_MS = 10_000;
/** GitHub release hosts; a host matches when equal or a subdomain. */
const DEFAULT_ALLOWED_HOSTS: readonly string[] = ["github.com", "githubusercontent.com"];

// ── Errors and small helpers ────────────────────────────────────────────────────────────────────

export class RuntimeError extends Error {
	readonly code: RuntimeErrorCode;

	constructor(code: RuntimeErrorCode, message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "RuntimeError";
		this.code = code;
	}
}

function sleep(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function errnoOf(error: unknown): string | undefined {
	if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") return error.code;
	return undefined;
}

/** The one shared object guard: narrows to a record whose fields stay `unknown`. */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function quote(text: string): string {
	return JSON.stringify(text.length > 120 ? `${text.slice(0, 117)}...` : text);
}

/** Hides credentials embedded in URLs before text reaches an error message. */
export function redact(text: string): string {
	return text.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/gi, "$1***@");
}

export function sha256Hex(data: string | Uint8Array): string {
	return crypto.createHash("sha256").update(data).digest("hex");
}

export function isWithin(root: string, target: string): boolean {
	const relative = path.relative(root, target);
	if (relative === "") return true;
	if (path.isAbsolute(relative)) return false;
	return relative !== ".." && !relative.startsWith(`..${path.sep}`);
}

function realpathOrSelf(target: string): string {
	try {
		return fs.realpathSync(target);
	} catch {
		return path.resolve(target);
	}
}

function isDirectory(target: string): boolean {
	try {
		return fs.statSync(target).isDirectory();
	} catch {
		return false;
	}
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;

function assertSegment(label: string, value: unknown): asserts value is string {
	if (typeof value !== "string" || !SEGMENT.test(value)) {
		throw new RuntimeError(
			"invalid-argument",
			`${label} must match [A-Za-z0-9][A-Za-z0-9._+-]* and contain no path separators (got ${quote(String(value))})`,
		);
	}
}

function assertEnvOverride(env: Readonly<Record<string, string>> | undefined): void {
	for (const [name, value] of Object.entries(env ?? {})) {
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || typeof value !== "string" || value.includes("\0")) {
			throw new RuntimeError("invalid-argument", `invalid environment variable ${quote(name)}`);
		}
		if (name === MARKER_VARIABLE) {
			throw new RuntimeError("invalid-argument", `${MARKER_VARIABLE} is reserved for process ownership`);
		}
	}
}

function validateArgv(command: string, args: readonly string[]): void {
	if (typeof command !== "string" || command === "" || command.includes("\0")) {
		throw new RuntimeError("invalid-argument", "command must be a non-empty string without NUL bytes");
	}
	if (!Array.isArray(args) || args.some(arg => typeof arg !== "string" || arg.includes("\0"))) {
		throw new RuntimeError("invalid-argument", "args must be an array of strings without NUL bytes");
	}
}

function resolveTimeout(timeoutMs: number | undefined): number {
	if (timeoutMs === undefined) return INSTALL_TIMEOUT_MS;
	if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > INSTALL_TIMEOUT_MS) {
		throw new RuntimeError("invalid-argument", `timeoutMs must be between 1 and ${INSTALL_TIMEOUT_MS}`);
	}
	return Math.floor(timeoutMs);
}

/** A short, secret-free label for error messages: executable name plus leading sub-commands only. */
function describeCommand(command: string, args: readonly string[]): string {
	const subcommands: string[] = [];
	for (const arg of args) {
		if (subcommands.length >= 2 || !/^[a-z][a-z0-9:-]*$/.test(arg)) break;
		subcommands.push(arg);
	}
	return [path.basename(command), ...subcommands].join(" ");
}

function tailMessage(text: string): string {
	const cleaned = redact(text).trim();
	if (cleaned === "") return "";
	return cleaned.length > ERROR_TAIL_CHARS ? `...${cleaned.slice(-ERROR_TAIL_CHARS)}` : cleaned;
}

// ── Platform profiles ───────────────────────────────────────────────────────────────────────────

export function hostPlatformInput(): PlatformInput {
	let osRelease: string | undefined;
	let musl = false;
	if (process.platform === "linux") {
		try {
			osRelease = fs.readFileSync("/etc/os-release", "utf8");
		} catch {
			osRelease = undefined;
		}
		try {
			musl = fs.readdirSync("/lib").some(name => name.startsWith("ld-musl-"));
		} catch {
			musl = false;
		}
	}
	return { platform: process.platform, arch: process.arch, osRelease, musl };
}

function osReleaseIds(text: string): Set<string> {
	const ids = new Set<string>();
	for (const line of text.split("\n")) {
		const match = /^(ID|ID_LIKE)=(.*)$/.exec(line.trim());
		if (!match) continue;
		for (const id of match[2]!.replace(/^["']|["']$/g, "").split(/\s+/)) {
			if (id !== "") ids.add(id.toLowerCase());
		}
	}
	return ids;
}

/** macOS x64/arm64 and Ubuntu/Debian glibc Linux x64 are supported; everything else is reported unsupported. */
export function detectPlatform(input: PlatformInput = hostPlatformInput()): PlatformDetection {
	const unsupported = (reason: string): PlatformDetection => ({ supported: false, reason });
	if (input.platform === "darwin") {
		if (input.arch === "arm64" || input.arch === "x64") {
			const platform: Platform = { os: "darwin", arch: input.arch, id: input.arch === "arm64" ? "darwin-arm64" : "darwin-x64" };
			return { supported: true, platform };
		}
		return unsupported(`macOS ${input.arch} is not supported; supported are Apple Silicon (arm64) and Intel (x64)`);
	}
	if (input.platform === "linux") {
		if (input.arch !== "x64") {
			return unsupported(`Linux ${input.arch} is not supported; only Ubuntu/Debian glibc x64 is`);
		}
		if (input.musl === true) {
			return unsupported("musl libc (for example Alpine) is not supported; only Ubuntu/Debian glibc x64 is");
		}
		if (input.osRelease === undefined) {
			return unsupported("the Linux distribution could not be determined (/etc/os-release is unreadable); only Ubuntu/Debian glibc x64 is supported");
		}
		const ids = osReleaseIds(input.osRelease);
		if (!ids.has("debian") && !ids.has("ubuntu")) {
			return unsupported(`this Linux distribution (${[...ids].join(", ") || "unknown"}) is outside the supported Ubuntu/Debian glibc x64 baseline`);
		}
		return { supported: true, platform: { os: "linux", arch: "x64", id: "linux-x64" } };
	}
	return unsupported(`${input.platform} ${input.arch} is not supported; supported are macOS (x64/arm64) and Ubuntu/Debian glibc Linux x64`);
}

// ── Child environment ───────────────────────────────────────────────────────────────────────────

export interface ScratchDirs {
	readonly home: string;
	readonly config: string;
	readonly cache: string;
	readonly data: string;
	readonly state: string;
	readonly tmp: string;
}

/**
 * The only parent variables a child inherits: approved proxy/certificate settings and explicit SDK
 * locations that select (never download) an installed toolchain. Provider tokens, MCP config,
 * npm hooks, NODE_OPTIONS, project GOFLAGS and Python startup variables are never inherited.
 */
const PASS_THROUGH: readonly string[] = [
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"NO_PROXY",
	"ALL_PROXY",
	"http_proxy",
	"https_proxy",
	"no_proxy",
	"all_proxy",
	"SSL_CERT_FILE",
	"SSL_CERT_DIR",
	"NODE_EXTRA_CA_CERTS",
	"REQUESTS_CA_BUNDLE",
	"CURL_CA_BUNDLE",
	"GOROOT",
	"RUSTUP_HOME",
	"CARGO_HOME",
	"RUSTUP_TOOLCHAIN",
	"DEVELOPER_DIR",
	"SDKROOT",
];

export interface ChildEnvOptions {
	parent: Readonly<Record<string, string | undefined>>;
	scratch: ScratchDirs;
	marker: string;
	/** SDK homes derived from the real home directory (see `detectSdkHomes`); parent values win. */
	sdkHomes?: Readonly<Record<string, string>>;
	override?: Readonly<Record<string, string>>;
}

/** Absolute, de-duplicated PATH entries; relative and empty entries would resolve inside the child's cwd. */
export function absolutePathDirs(value: string | undefined): string[] {
	const seen = new Set<string>();
	const dirs: string[] = [];
	for (const dir of (value ?? "").split(path.delimiter)) {
		if (dir === "" || !path.isAbsolute(dir) || seen.has(dir)) continue;
		seen.add(dir);
		dirs.push(dir);
	}
	return dirs;
}

/** rustup/cargo keep their toolchains under HOME; with a private HOME they must be pointed at the real ones. */
export function detectSdkHomes(
	parent: Readonly<Record<string, string | undefined>>,
	home: string,
): Record<string, string> {
	const homes: Record<string, string> = {};
	for (const [name, directory] of [
		["RUSTUP_HOME", ".rustup"],
		["CARGO_HOME", ".cargo"],
	] as const) {
		if (parent[name] !== undefined && parent[name] !== "") continue;
		const candidate = path.join(home, directory);
		if (isDirectory(candidate)) homes[name] = candidate;
	}
	return homes;
}

export function buildChildEnv(options: ChildEnvOptions): Record<string, string> {
	const { parent, scratch } = options;
	assertEnvOverride(options.override);
	const env: Record<string, string> = {};
	const pathDirs = absolutePathDirs(parent.PATH);
	env.PATH = pathDirs.length > 0 ? pathDirs.join(path.delimiter) : "/usr/local/bin:/usr/bin:/bin";
	for (const name of PASS_THROUGH) {
		const value = parent[name];
		if (value !== undefined && value !== "") env[name] = value;
	}
	for (const [name, value] of Object.entries(options.sdkHomes ?? {})) {
		if (env[name] === undefined) env[name] = value;
	}
	Object.assign(env, {
		HOME: scratch.home,
		XDG_CONFIG_HOME: scratch.config,
		XDG_CACHE_HOME: scratch.cache,
		XDG_DATA_HOME: scratch.data,
		XDG_STATE_HOME: scratch.state,
		TMPDIR: scratch.tmp,
		LC_ALL: "C",
		LANG: "C",
		TERM: "dumb",
		NO_COLOR: "1",
		// npm: empty user/global config, private cache, lifecycle scripts off. The lock file's integrity checks stay on.
		npm_config_userconfig: path.join(scratch.config, "npmrc"),
		npm_config_globalconfig: path.join(scratch.config, "npmrc-global"),
		npm_config_cache: path.join(scratch.cache, "npm"),
		npm_config_ignore_scripts: "true",
		npm_config_update_notifier: "false",
		// pip: no user config or startup hooks; callers pass --isolated and hash-locked requirements.
		PIP_CONFIG_FILE: NULL_DEVICE,
		PIP_CACHE_DIR: path.join(scratch.cache, "pip"),
		PIP_DISABLE_PIP_VERSION_CHECK: "1",
		PIP_NO_INPUT: "1",
		PYTHONNOUSERSITE: "1",
		PYTHONSAFEPATH: "1",
		// Go: no env file, no toolchain downloads, public proxy and checksum database, empty private/insecure overrides.
		GOENV: "off",
		GOTOOLCHAIN: "local",
		GOFLAGS: "",
		GOWORK: "off",
		GOPROXY: "https://proxy.golang.org",
		GOSUMDB: "sum.golang.org",
		GONOSUMDB: "",
		GONOPROXY: "",
		GOPRIVATE: "",
		GOINSECURE: "",
		GOMODCACHE: path.join(scratch.cache, "go-mod"),
		GOCACHE: path.join(scratch.cache, "go-build"),
		GOPATH: path.join(scratch.data, "go"),
		// Rust: never let rustup fetch a toolchain.
		RUSTUP_AUTO_INSTALL: "0",
		CARGO_TERM_COLOR: "never",
		GIT_TERMINAL_PROMPT: "0",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: NULL_DEVICE,
	});
	Object.assign(env, options.override ?? {});
	env[MARKER_VARIABLE] = options.marker;
	return env;
}

// ── Executable lookup (static, never executes anything) ─────────────────────────────────────────

export function isExecutableFile(file: string): boolean {
	try {
		if (!fs.statSync(file).isFile()) return false;
		fs.accessSync(file, fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

export function findExecutable(name: string, dirs: readonly string[]): string | undefined {
	for (const dir of dirs) {
		const candidate = path.join(dir, name);
		if (isExecutableFile(candidate)) return candidate;
	}
	return undefined;
}

/** omp's root-marker check: one directory level, `*` wildcards match within a name. */
export function hasRootMarkers(cwd: string, markers: readonly string[]): boolean {
	let entries: string[] | undefined;
	for (const marker of markers) {
		if (marker.includes("*")) {
			if (entries === undefined) {
				try {
					entries = fs.readdirSync(cwd);
				} catch {
					entries = [];
				}
			}
			const pattern = new RegExp(`^${marker.split("*").map(escapeRegExp).join("[^/]*")}$`);
			if (entries.some(entry => pattern.test(entry))) return true;
			continue;
		}
		if (fs.existsSync(path.join(cwd, marker))) return true;
	}
	return false;
}

const PYTHON_ROOT_MARKERS = [
	"pyproject.toml",
	"ty.toml",
	"requirements.txt",
	"setup.py",
	"setup.cfg",
	"Pipfile",
	"pyrightconfig.json",
	"ruff.toml",
	".ruff.toml",
];

/** omp's project-local bin directories, checked before PATH when the root marker exists in the cwd. */
const LOCAL_BIN_RULES: readonly { readonly markers: readonly string[]; readonly binDir: string }[] = [
	{ markers: ["package.json", "package-lock.json", "yarn.lock", "pnpm-lock.yaml"], binDir: "node_modules/.bin" },
	{ markers: PYTHON_ROOT_MARKERS, binDir: ".venv/bin" },
	{ markers: PYTHON_ROOT_MARKERS, binDir: "venv/bin" },
	{ markers: PYTHON_ROOT_MARKERS, binDir: ".env/bin" },
	{ markers: ["Gemfile", "Gemfile.lock"], binDir: "vendor/bundle/bin" },
	{ markers: ["Gemfile", "Gemfile.lock"], binDir: "bin" },
	{ markers: ["go.mod", "go.sum", "go.work"], binDir: "bin" },
];

export function projectLocalBinDirs(cwd: string): string[] {
	const dirs: string[] = [];
	for (const rule of LOCAL_BIN_RULES) {
		if (!hasRootMarkers(cwd, rule.markers)) continue;
		const dir = path.join(cwd, rule.binDir);
		if (!dirs.includes(dir)) dirs.push(dir);
	}
	return dirs;
}

// ── Process table and ownership ─────────────────────────────────────────────────────────────────

interface ProcessEntry {
	readonly pid: number;
	readonly ppid: number;
	readonly pgid: number;
	/** Start identity: Linux boot id + /proc starttime, macOS `ps` lstart. Distinguishes PID reuse. */
	readonly startId: string;
	readonly zombie: boolean;
	/** Value of the ownership marker variable, when the process (or an ancestor's environment) carries one. */
	readonly marker?: string;
}

let cachedBootId: string | undefined;

function bootId(): string {
	if (cachedBootId === undefined) {
		try {
			cachedBootId = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
		} catch {
			cachedBootId = "unknown-boot";
		}
	}
	return cachedBootId;
}

function parseLinuxStat(pid: number, text: string): ProcessEntry | undefined {
	const close = text.lastIndexOf(")");
	if (close < 0) return undefined;
	const fields = text.slice(close + 2).split(" ");
	const state = fields[0];
	const ppid = Number(fields[1]);
	const pgid = Number(fields[2]);
	const start = fields[19];
	if (!state || !Number.isInteger(ppid) || !Number.isInteger(pgid) || !start) return undefined;
	return { pid, ppid, pgid, startId: `${bootId()}:${start}`, zombie: state === "Z" || state === "X" };
}

function readLinuxMarker(pid: number): string | undefined {
	let environ: Buffer;
	try {
		environ = fs.readFileSync(`/proc/${pid}/environ`);
	} catch {
		return undefined;
	}
	const needle = Buffer.from(`${MARKER_VARIABLE}=`);
	let from = 0;
	for (;;) {
		const at = environ.indexOf(needle, from);
		if (at < 0) return undefined;
		if (at === 0 || environ[at - 1] === 0) {
			const end = environ.indexOf(0, at);
			return environ.toString("utf8", at + needle.length, end < 0 ? environ.length : end);
		}
		from = at + 1;
	}
}

function readLinuxProcessTable(withMarkers: boolean): ProcessEntry[] {
	let names: string[];
	try {
		names = fs.readdirSync("/proc");
	} catch {
		return [];
	}
	const entries: ProcessEntry[] = [];
	for (const name of names) {
		if (!/^\d+$/.test(name)) continue;
		const pid = Number(name);
		let text: string;
		try {
			text = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
		} catch {
			continue;
		}
		const entry = parseLinuxStat(pid, text);
		if (!entry) continue;
		const marker = withMarkers && !entry.zombie ? readLinuxMarker(pid) : undefined;
		entries.push(marker === undefined ? entry : { ...entry, marker });
	}
	return entries;
}

function execPs(args: string[]): Promise<string> {
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	cp.execFile(
		"/bin/ps",
		args,
		{ encoding: "utf8", maxBuffer: 256 * 1024 * 1024, env: { PATH: "/usr/bin:/bin", LC_ALL: "C" } },
		(error, stdout) => (error ? reject(error) : resolve(stdout)),
	);
	return promise;
}

async function readDarwinProcessTable(withMarkers: boolean): Promise<ProcessEntry[]> {
	const listing = await execPs(["-axww", "-o", "pid=", "-o", "ppid=", "-o", "pgid=", "-o", "stat=", "-o", "lstart="]);
	const markers = new Map<number, string>();
	if (withMarkers) {
		let environment = "";
		try {
			environment = await execPs(["-axww", "-E", "-o", "pid=", "-o", "command="]);
		} catch {
			environment = "";
		}
		const pattern = new RegExp(`^\\s*(\\d+)\\s.*\\b${MARKER_VARIABLE}=([A-Za-z0-9._-]+)`);
		for (const line of environment.split("\n")) {
			const match = pattern.exec(line);
			if (match) markers.set(Number(match[1]), match[2]!);
		}
	}
	const entries: ProcessEntry[] = [];
	for (const line of listing.split("\n")) {
		const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
		if (!match) continue;
		const pid = Number(match[1]);
		const marker = markers.get(pid);
		const entry: ProcessEntry = {
			pid,
			ppid: Number(match[2]),
			pgid: Number(match[3]),
			startId: match[5]!,
			zombie: match[4]!.startsWith("Z"),
		};
		entries.push(marker === undefined ? entry : { ...entry, marker });
	}
	return entries;
}

async function readProcessTable(withMarkers: boolean): Promise<ProcessEntry[]> {
	if (process.platform === "linux") return readLinuxProcessTable(withMarkers);
	if (process.platform === "darwin") return readDarwinProcessTable(withMarkers);
	throw new RuntimeError("unsupported-platform", `process supervision is not available on ${process.platform}`);
}

/** Identity of one process right now, or undefined when it does not exist. */
function readProcessSync(pid: number): { startId: string; zombie: boolean } | undefined {
	if (process.platform === "linux") {
		try {
			const entry = parseLinuxStat(pid, fs.readFileSync(`/proc/${pid}/stat`, "utf8"));
			return entry === undefined ? undefined : { startId: entry.startId, zombie: entry.zombie };
		} catch {
			return undefined;
		}
	}
	if (process.platform === "darwin") {
		try {
			const out = cp
				.execFileSync("/bin/ps", ["-o", "stat=", "-o", "lstart=", "-p", String(pid)], {
					encoding: "utf8",
					env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
					stdio: ["ignore", "pipe", "ignore"],
				})
				.trim();
			const match = /^(\S+)\s+(.+)$/.exec(out);
			return match ? { startId: match[2]!, zombie: match[1]!.startsWith("Z") } : undefined;
		} catch {
			return undefined;
		}
	}
	return undefined;
}

interface OwnerMatch {
	/** Process group leader / root of the spawn (undefined when the spawn never started). */
	rootPid?: number;
	rootStartId?: string;
	/** Exact marker value of one spawn. */
	marker?: string;
	/** Marker prefix of a whole runtime. */
	markerPrefix?: string;
}

/**
 * Owned processes: carrying the marker (survives double-fork and setsid), the verified root, its
 * process group (a PID cannot be reused while its group has members), and every descendant of an
 * owned process. Never matched by executable name or path.
 */
function selectOwned(table: readonly ProcessEntry[], match: OwnerMatch): ProcessEntry[] {
	const byPid = new Map<number, ProcessEntry>();
	for (const entry of table) byPid.set(entry.pid, entry);
	const owned = new Map<number, ProcessEntry>();
	const add = (entry: ProcessEntry): void => {
		if (entry.pid > 1 && entry.pid !== process.pid) owned.set(entry.pid, entry);
	};
	for (const entry of table) {
		if (entry.marker === undefined) continue;
		if (match.marker !== undefined ? entry.marker === match.marker : match.markerPrefix !== undefined && entry.marker.startsWith(match.markerPrefix)) {
			add(entry);
		}
	}
	if (match.rootPid !== undefined) {
		const root = byPid.get(match.rootPid);
		const rootAlive =
			root !== undefined &&
			(match.rootStartId !== undefined
				? root.startId === match.rootStartId
				: root.marker !== undefined && root.marker === match.marker);
		if (root !== undefined && rootAlive) add(root);
		for (const entry of table) {
			if (entry.pgid !== match.rootPid) continue;
			if (entry.pid === match.rootPid && !rootAlive) continue;
			add(entry);
		}
	}
	let grew = true;
	while (grew) {
		grew = false;
		for (const entry of table) {
			if (!owned.has(entry.pid) && owned.has(entry.ppid)) {
				add(entry);
				if (owned.has(entry.pid)) grew = true;
			}
		}
	}
	return [...owned.values()];
}

function entryKey(entry: ProcessEntry): string {
	return `${entry.pid}:${entry.startId}`;
}

function stillSameProcess(entry: ProcessEntry): boolean {
	if (process.platform !== "linux") return true;
	const current = readProcessSync(entry.pid);
	return current !== undefined && current.startId === entry.startId;
}

function signalEntries(entries: readonly ProcessEntry[], match: OwnerMatch, signal: "SIGTERM" | "SIGKILL"): void {
	const groupAlive = match.rootPid !== undefined && entries.some(entry => entry.pgid === match.rootPid);
	if (groupAlive && match.rootPid !== undefined) {
		try {
			process.kill(-match.rootPid, signal);
		} catch {
			// The group is already gone.
		}
	}
	for (const entry of entries) {
		if (match.rootPid !== undefined && entry.pgid === match.rootPid) continue;
		if (!stillSameProcess(entry)) continue;
		try {
			process.kill(entry.pid, signal);
		} catch {
			// The process is already gone.
		}
	}
}

/** SIGTERM owned processes, wait at most `graceMs`, SIGKILL the survivors, report any that remain. */
async function terminateOwned(match: OwnerMatch, graceMs: number): Promise<CleanupResult> {
	const scan = async (): Promise<ProcessEntry[]> =>
		selectOwned(await readProcessTable(true), match).filter(entry => !entry.zombie);
	const observed = new Set<string>();
	const termed = new Set<string>();
	let live = await scan();
	if (live.length === 0) return { terminated: 0, survivors: [] };
	for (const entry of live) observed.add(entryKey(entry));
	signalEntries(live, match, "SIGTERM");
	for (const entry of live) termed.add(entryKey(entry));
	const graceEnd = Date.now() + graceMs;
	while (live.length > 0 && Date.now() < graceEnd) {
		await sleep(POLL_MS);
		live = await scan();
		const fresh = live.filter(entry => !termed.has(entryKey(entry)));
		for (const entry of live) observed.add(entryKey(entry));
		if (fresh.length > 0) {
			signalEntries(fresh, { ...match, rootPid: undefined }, "SIGTERM");
			for (const entry of fresh) termed.add(entryKey(entry));
		}
	}
	if (live.length > 0) {
		signalEntries(live, match, "SIGKILL");
		const killEnd = Date.now() + KILL_WAIT_MS;
		while (live.length > 0 && Date.now() < killEnd) {
			await sleep(POLL_MS);
			live = await scan();
			for (const entry of live) observed.add(entryKey(entry));
			if (live.length > 0) signalEntries(live, match, "SIGKILL");
		}
	}
	const survivors: SurvivingProcess[] = live.map(entry => ({ pid: entry.pid, ppid: entry.ppid }));
	return { terminated: observed.size - survivors.length, survivors };
}

function isOwnerAlive(owner: { pid: number; startId?: string }): boolean {
	const info = readProcessSync(owner.pid);
	if (info === undefined || info.zombie) return false;
	return owner.startId === undefined || info.startId === owner.startId;
}

// ── Filesystem primitives ───────────────────────────────────────────────────────────────────────

export interface ToolingRoots {
	/** Real path of `<agentDir>/tooling`. */
	readonly root: string;
	readonly work: string;
	readonly staging: string;
	readonly locks: string;
}

async function ensurePrivateDir(dir: string, label: string): Promise<void> {
	try {
		await fsp.mkdir(dir, { mode: 0o700 });
	} catch (error) {
		if (errnoOf(error) !== "EEXIST") {
			throw new RuntimeError("destination", `cannot create ${label} ${dir}: ${errorMessage(error)}`, { cause: error });
		}
	}
	const stat = await fsp.lstat(dir);
	if (stat.isSymbolicLink() || !stat.isDirectory()) {
		throw new RuntimeError("destination", `${label} ${dir} must be a real directory, not a symbolic link or file`);
	}
	const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
	if (uid !== undefined && stat.uid !== uid) {
		throw new RuntimeError("destination", `${label} ${dir} is not owned by the current user`);
	}
	if ((stat.mode & 0o022) !== 0) {
		throw new RuntimeError("destination", `${label} ${dir} is writable by other users; run chmod go-w on it`);
	}
}

/** Creates (when needed) and validates the user-owned, private `<agentDir>/tooling` tree. */
export async function ensureToolingRoots(agentDir: string): Promise<ToolingRoots> {
	const resolved = path.resolve(agentDir);
	try {
		await fsp.mkdir(resolved, { recursive: true });
	} catch (error) {
		throw new RuntimeError("destination", `cannot create the omp agent directory ${resolved}: ${errorMessage(error)}`, { cause: error });
	}
	const real = await fsp.realpath(resolved);
	const root = path.join(real, "tooling");
	await ensurePrivateDir(root, "tooling directory");
	const work = path.join(root, ".work");
	const staging = path.join(root, ".staging");
	const locks = path.join(root, ".locks");
	for (const dir of [work, staging, locks]) await ensurePrivateDir(dir, "tooling directory");
	return { root, work, staging, locks };
}

async function makeWritable(target: string): Promise<void> {
	let stat: fs.Stats;
	try {
		stat = await fsp.lstat(target);
	} catch {
		return;
	}
	if (!stat.isDirectory()) return;
	await fsp.chmod(target, 0o700).catch(() => undefined);
	let names: string[];
	try {
		names = await fsp.readdir(target);
	} catch {
		return;
	}
	for (const name of names) await makeWritable(path.join(target, name));
}

/** Recursive delete that also handles read-only trees (Go's module cache). Symbolic links are never followed. */
export async function removeTree(target: string): Promise<void> {
	await makeWritable(target);
	await fsp.rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
}

async function writeOwner(dir: string): Promise<void> {
	const owner = { pid: process.pid, startId: readProcessSync(process.pid)?.startId, createdAt: new Date().toISOString() };
	await fsp.writeFile(path.join(dir, "owner.json"), `${JSON.stringify(owner)}\n`, { mode: 0o600 });
}

async function readOwner(dir: string): Promise<{ pid: number; startId?: string } | undefined> {
	try {
		const parsed: unknown = JSON.parse(await fsp.readFile(path.join(dir, "owner.json"), "utf8"));
		if (typeof parsed !== "object" || parsed === null || !("pid" in parsed)) return undefined;
		if (typeof parsed.pid !== "number" || !Number.isInteger(parsed.pid)) return undefined;
		const startId = "startId" in parsed && typeof parsed.startId === "string" ? parsed.startId : undefined;
		return { pid: parsed.pid, startId };
	} catch {
		return undefined;
	}
}

/** Removes scratch/staging directories whose owning process is gone (crashed or killed runs). */
async function sweepStale(base: string): Promise<void> {
	let names: string[];
	try {
		names = await fsp.readdir(base);
	} catch {
		return;
	}
	for (const name of names) {
		const dir = path.join(base, name);
		const owner = await readOwner(dir);
		if (owner === undefined || isOwnerAlive(owner)) continue;
		await removeTree(dir).catch(() => undefined);
	}
}

export interface LockHandle {
	release(): Promise<void>;
}

async function lockIsStale(lockDir: string): Promise<boolean> {
	const owner = await readOwner(lockDir);
	if (owner !== undefined) return !isOwnerAlive(owner);
	try {
		const stat = await fsp.stat(lockDir);
		return Date.now() - stat.mtimeMs > STALE_LOCK_MS;
	} catch {
		return true;
	}
}

/**
 * Exclusive ownership through an atomic `mkdir`. A live owner (including this process) makes the
 * competing run fail clearly; a lock whose owner process is gone is reclaimed once.
 */
export async function acquireLock(lockDir: string, what: string): Promise<LockHandle> {
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			await fsp.mkdir(lockDir, { mode: 0o700 });
		} catch (error) {
			if (errnoOf(error) !== "EEXIST") {
				throw new RuntimeError("destination", `cannot create lock ${lockDir}: ${errorMessage(error)}`, { cause: error });
			}
			if (attempt === 0 && (await lockIsStale(lockDir))) {
				await removeTree(lockDir).catch(() => undefined);
				continue;
			}
			throw new RuntimeError(
				"busy",
				`${what} is already in progress in another run (lock ${lockDir}). Wait for it to finish; if no such run exists, remove that directory and retry.`,
			);
		}
		await writeOwner(lockDir);
		return { release: () => removeTree(lockDir).catch(() => undefined) };
	}
	throw new RuntimeError("busy", `${what} is already in progress in another run (lock ${lockDir}).`);
}

/** Writes a sibling temporary file, fsyncs it and renames it over `file`. */
export async function writeFileAtomic(file: string, content: string, mode: number): Promise<void> {
	const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`);
	const fd = fs.openSync(tmp, "wx", mode);
	try {
		fs.writeFileSync(fd, content);
		fs.fsyncSync(fd);
	} catch (error) {
		fs.closeSync(fd);
		fs.rmSync(tmp, { force: true });
		throw error;
	}
	fs.closeSync(fd);
	try {
		fs.renameSync(tmp, file);
	} catch (error) {
		fs.rmSync(tmp, { force: true });
		throw error;
	}
}

/** Resolves a relative path inside `root` without escaping it and without passing through symbolic links. */
function resolveInside(root: string, relative: string, label: string): string {
	if (typeof relative !== "string" || relative === "" || relative.includes("\0") || relative.includes("\\") || path.isAbsolute(relative)) {
		throw new RuntimeError("invalid-argument", `${label} must be a relative path inside the install directory (got ${quote(String(relative))})`);
	}
	const parts = relative.split("/").filter(part => part !== "" && part !== ".");
	if (parts.includes("..")) {
		throw new RuntimeError("invalid-argument", `${label} must not contain '..' (got ${quote(relative)})`);
	}
	let current = root;
	for (const part of parts) {
		current = path.join(current, part);
		let stat: fs.Stats | undefined;
		try {
			stat = fs.lstatSync(current);
		} catch {
			stat = undefined;
		}
		if (stat?.isSymbolicLink()) {
			throw new RuntimeError("invalid-argument", `${label} passes through a symbolic link (${quote(relative)})`);
		}
	}
	return current;
}

// ── Archives: in-process metadata validation and extraction ─────────────────────────────────────

function archiveError(message: string): RuntimeError {
	return new RuntimeError("archive", message);
}

interface RawEntry {
	path: string;
	type: "file" | "directory" | "symlink";
	size: number;
	mode: number;
	target?: string;
}

/**
 * Normalizes an archive member name to a relative POSIX path. Returns "" for the archive root
 * (`./`). Rejects absolute names, drive letters, backslashes, NUL/control characters and `..`.
 */
function normalizeEntryPath(raw: string): string {
	if (raw === "" || raw.includes("\0") || raw.includes("\\")) {
		throw archiveError(`unsafe entry name ${quote(raw)}`);
	}
	if (raw.startsWith("/") || /^[A-Za-z]:/.test(raw)) {
		throw archiveError(`absolute entry name ${quote(raw)} is not allowed`);
	}
	const parts: string[] = [];
	for (const part of raw.split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") throw archiveError(`path traversal in entry name ${quote(raw)}`);
		// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are exactly what is rejected
		if (/[\x00-\x1f\x7f]/.test(part)) throw archiveError(`control character in entry name ${quote(raw)}`);
		if (Buffer.byteLength(part) > 255) throw archiveError(`entry name component too long in ${quote(raw)}`);
		parts.push(part);
	}
	const normalized = parts.join("/");
	if (Buffer.byteLength(normalized) > 4096) throw archiveError(`entry name too long: ${quote(raw)}`);
	return normalized;
}

function lexicalLinkTarget(linkPath: string, target: string): { ok: true; resolved: string[] } | { ok: false; reason: string } {
	if (target === "" || target.includes("\0") || target.includes("\\") || target.startsWith("/") || /^[A-Za-z]:/.test(target)) {
		return { ok: false, reason: "must be a relative path inside the archive" };
	}
	const parts = target.split("/").filter(part => part !== "" && part !== ".");
	let firstName = parts.findIndex(part => part !== "..");
	if (firstName === -1) firstName = parts.length;
	if (parts.slice(firstName).includes("..")) return { ok: false, reason: "uses '..' after a path component" };
	// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are exactly what is rejected
	if (parts.some(part => /[\x00-\x1f\x7f]/.test(part))) return { ok: false, reason: "contains control characters" };
	const base = linkPath.split("/").slice(0, -1);
	if (firstName > base.length) return { ok: false, reason: "escapes the extraction directory" };
	return { ok: true, resolved: [...base.slice(0, base.length - firstName), ...parts.slice(firstName)] };
}

function validateSymlink(entry: RawEntry, byPath: ReadonlyMap<string, RawEntry>, dirs: ReadonlySet<string>): void {
	const target = entry.target ?? "";
	const fail = (reason: string): never => {
		throw archiveError(`symbolic link ${quote(entry.path)} -> ${quote(target)} ${reason}`);
	};
	const first = lexicalLinkTarget(entry.path, target);
	if (!first.ok) return fail(first.reason);
	const resolved = first.resolved;
	// Lexical resolution equals physical resolution only when no component on the way is itself a link.
	for (let depth = 1; depth < resolved.length; depth++) {
		if (byPath.get(resolved.slice(0, depth).join("/"))?.type === "symlink") fail("passes through another symbolic link");
	}
	const resolvedPath = resolved.join("/");
	if (resolved.length > 0 && !byPath.has(resolvedPath) && !dirs.has(resolvedPath)) {
		fail("points to a path that is not part of the archive");
	}
	let current = resolvedPath;
	for (let hops = 0; ; hops++) {
		const next = byPath.get(current);
		if (next === undefined || next.type !== "symlink") break;
		if (hops >= 8) fail("is part of a symbolic link chain that is too long or loops");
		const step = lexicalLinkTarget(next.path, next.target ?? "");
		if (!step.ok) break;
		current = step.resolved.join("/");
	}
}

function sanitizeMode(type: RawEntry["type"], mode: number): number {
	if (type === "directory") return 0o755;
	if (type === "symlink") return 0o777;
	return (mode & 0o111) !== 0 ? 0o755 : 0o644;
}

/** Whole-archive validation over collected metadata; nothing is extracted before it passes. */
function validateEntries(raw: readonly RawEntry[], limits: ArchiveLimits): ArchiveEntry[] {
	if (raw.length === 0) throw archiveError("archive contains no entries");
	if (raw.length > limits.entries) {
		throw archiveError(`archive has ${raw.length} entries; the limit is ${limits.entries}`);
	}
	const byPath = new Map<string, RawEntry>();
	const folded = new Map<string, string>();
	const dirs = new Set<string>();
	let expanded = 0;
	const register = (entryPath: string): void => {
		const key = entryPath.normalize("NFC").toLowerCase();
		const previous = folded.get(key);
		if (previous !== undefined && previous !== entryPath) {
			throw archiveError(`entries ${quote(previous)} and ${quote(entryPath)} collide on case-insensitive file systems`);
		}
		folded.set(key, entryPath);
	};
	for (const entry of raw) {
		if (byPath.has(entry.path)) throw archiveError(`duplicate entry ${quote(entry.path)}`);
		const segments = entry.path.split("/");
		for (let depth = 1; depth < segments.length; depth++) {
			const ancestor = segments.slice(0, depth).join("/");
			const existing = byPath.get(ancestor);
			if (existing !== undefined && existing.type !== "directory") {
				throw archiveError(`entry ${quote(entry.path)} lies inside non-directory entry ${quote(ancestor)}`);
			}
			register(ancestor);
			dirs.add(ancestor);
		}
		register(entry.path);
		if (entry.type !== "directory" && dirs.has(entry.path)) {
			throw archiveError(`entry ${quote(entry.path)} is both a file or link and a directory`);
		}
		byPath.set(entry.path, entry);
		if (entry.type === "directory") dirs.add(entry.path);
		if (entry.type === "file") {
			expanded += entry.size;
			if (expanded > limits.expandedBytes) {
				throw archiveError(`archive expands beyond the ${limits.expandedBytes} byte limit`);
			}
		}
	}
	for (const entry of raw) {
		if (entry.type === "symlink") validateSymlink(entry, byPath, dirs);
	}
	return raw.map(entry => ({
		path: entry.path,
		type: entry.type,
		size: entry.type === "file" ? entry.size : 0,
		mode: sanitizeMode(entry.type, entry.mode),
		...(entry.target === undefined ? {} : { target: entry.target }),
	}));
}

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c >>> 0;
	}
	return table;
})();

function crc32Update(crc: number, chunk: Uint8Array): number {
	let c = crc ^ 0xffffffff;
	for (let i = 0; i < chunk.length; i++) c = CRC_TABLE[(c ^ chunk[i]!) & 0xff]! ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

async function readAt(handle: fsp.FileHandle, position: number, length: number): Promise<Buffer> {
	const buffer = Buffer.alloc(length);
	let offset = 0;
	while (offset < length) {
		const { bytesRead } = await handle.read(buffer, offset, length - offset, position + offset);
		if (bytesRead === 0) throw archiveError("unexpected end of archive");
		offset += bytesRead;
	}
	return buffer;
}

async function writeAll(handle: fsp.FileHandle, data: Uint8Array): Promise<void> {
	let offset = 0;
	while (offset < data.length) {
		const { bytesWritten } = await handle.write(data, offset, data.length - offset);
		offset += bytesWritten;
	}
}

function readSafeUint64(buffer: Buffer, at: number): number {
	const value = buffer.readBigUInt64LE(at);
	if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw archiveError("ZIP value is out of range");
	return Number(value);
}

// ZIP ----------------------------------------------------------------------------------------------

const ZIP_LOCAL = 0x04034b50;
const ZIP_DIRECTORY = 0x02014b50;
const ZIP_EOCD = 0x06054b50;
const ZIP64_EOCD = 0x06064b50;
const ZIP64_LOCATOR = 0x07064b50;

interface ZipRecord extends RawEntry {
	method: number;
	crc: number;
	compressedSize: number;
	localOffset: number;
	dataOffset: number;
	nameBytes: Buffer;
}

async function locateZipDirectory(
	handle: fsp.FileHandle,
	fileSize: number,
	limits: ArchiveLimits,
): Promise<{ offset: number; size: number; count: number }> {
	if (fileSize < 22) throw archiveError("not a ZIP archive (too small)");
	const tailSize = Math.min(fileSize, 22 + 0xffff);
	const tailStart = fileSize - tailSize;
	const tail = await readAt(handle, tailStart, tailSize);
	let at = -1;
	for (let i = tail.length - 22; i >= 0; i--) {
		if (tail.readUInt32LE(i) !== ZIP_EOCD) continue;
		if (i + 22 + tail.readUInt16LE(i + 20) === tail.length) {
			at = i;
			break;
		}
	}
	if (at < 0) throw archiveError("not a ZIP archive (end-of-central-directory record not found)");
	const eocdPosition = tailStart + at;
	const disk = tail.readUInt16LE(at + 4);
	const directoryDisk = tail.readUInt16LE(at + 6);
	const entriesOnDisk = tail.readUInt16LE(at + 8);
	let count = tail.readUInt16LE(at + 10);
	let size = tail.readUInt32LE(at + 12);
	let offset = tail.readUInt32LE(at + 16);
	let boundary = eocdPosition;
	if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff || disk === 0xffff) {
		if (eocdPosition < 20) throw archiveError("corrupt ZIP64 locator");
		const locator = await readAt(handle, eocdPosition - 20, 20);
		if (locator.readUInt32LE(0) !== ZIP64_LOCATOR) throw archiveError("corrupt ZIP64 locator");
		const zip64Position = readSafeUint64(locator, 8);
		const record = await readAt(handle, zip64Position, 56);
		if (record.readUInt32LE(0) !== ZIP64_EOCD) throw archiveError("corrupt ZIP64 end-of-central-directory record");
		if (record.readUInt32LE(16) !== 0 || record.readUInt32LE(20) !== 0) {
			throw archiveError("multi-disk ZIP archives are not supported");
		}
		count = readSafeUint64(record, 32);
		if (readSafeUint64(record, 24) !== count) throw archiveError("multi-disk ZIP archives are not supported");
		size = readSafeUint64(record, 40);
		offset = readSafeUint64(record, 48);
		boundary = zip64Position;
	} else if (disk !== 0 || directoryDisk !== 0 || entriesOnDisk !== count) {
		throw archiveError("multi-disk ZIP archives are not supported");
	}
	if (count > limits.entries) throw archiveError(`archive has ${count} entries; the limit is ${limits.entries}`);
	if (size > 64 * 1024 * 1024 || offset + size > boundary) throw archiveError("corrupt ZIP central directory location");
	return { offset, size, count };
}

function applyZip64Extra(
	extra: Buffer,
	need: { size: boolean; compressed: boolean; offset: boolean },
	values: { size: number; compressedSize: number; localOffset: number },
): void {
	let position = 0;
	while (position + 4 <= extra.length) {
		const id = extra.readUInt16LE(position);
		const length = extra.readUInt16LE(position + 2);
		const body = position + 4;
		if (body + length > extra.length) break;
		if (id === 0x0001) {
			let at = body;
			const take = (): number => {
				if (at + 8 > body + length) throw archiveError("corrupt ZIP64 extra field");
				const value = readSafeUint64(extra, at);
				at += 8;
				return value;
			};
			if (need.size) values.size = take();
			if (need.compressed) values.compressedSize = take();
			if (need.offset) values.localOffset = take();
			return;
		}
		position = body + length;
	}
	if (need.size || need.compressed || need.offset) throw archiveError("missing ZIP64 extra field");
}

async function readZipBytes(handle: fsp.FileHandle, record: ZipRecord): Promise<Buffer> {
	const compressed = await readAt(handle, record.dataOffset, record.compressedSize);
	if (record.method === 0) return compressed;
	try {
		return zlib.inflateRawSync(compressed);
	} catch (error) {
		throw archiveError(`corrupt compressed data for ${quote(record.path)}: ${errorMessage(error)}`);
	}
}

async function inspectZip(file: string, fileSize: number, limits: ArchiveLimits): Promise<{ entries: ArchiveEntry[]; records: ZipRecord[] }> {
	const handle = await fsp.open(file, "r");
	try {
		const location = await locateZipDirectory(handle, fileSize, limits);
		const directory = await readAt(handle, location.offset, location.size);
		const records: ZipRecord[] = [];
		let position = 0;
		for (let index = 0; index < location.count; index++) {
			if (position + 46 > directory.length || directory.readUInt32LE(position) !== ZIP_DIRECTORY) {
				throw archiveError("corrupt ZIP central directory");
			}
			const madeBy = directory.readUInt16LE(position + 4);
			const flags = directory.readUInt16LE(position + 8);
			const method = directory.readUInt16LE(position + 10);
			const crc = directory.readUInt32LE(position + 16);
			const values = {
				compressedSize: directory.readUInt32LE(position + 20),
				size: directory.readUInt32LE(position + 24),
				localOffset: directory.readUInt32LE(position + 42),
			};
			const nameLength = directory.readUInt16LE(position + 28);
			const extraLength = directory.readUInt16LE(position + 30);
			const commentLength = directory.readUInt16LE(position + 32);
			const diskStart = directory.readUInt16LE(position + 34);
			const externalAttributes = directory.readUInt32LE(position + 38);
			const nameStart = position + 46;
			const next = nameStart + nameLength + extraLength + commentLength;
			if (next > directory.length) throw archiveError("corrupt ZIP central directory");
			const nameBytes = directory.subarray(nameStart, nameStart + nameLength);
			const extra = directory.subarray(nameStart + nameLength, nameStart + nameLength + extraLength);
			position = next;
			if (diskStart !== 0 && diskStart !== 0xffff) throw archiveError("multi-disk ZIP archives are not supported");
			const need = {
				size: values.size === 0xffffffff,
				compressed: values.compressedSize === 0xffffffff,
				offset: values.localOffset === 0xffffffff,
			};
			if (need.size || need.compressed || need.offset) applyZip64Extra(extra, need, values);
			const rawName = nameBytes.toString("utf8");
			if ((flags & 0x1) !== 0 || (flags & 0x40) !== 0) {
				throw archiveError(`entry ${quote(rawName)} is encrypted; encrypted ZIP entries are not supported`);
			}
			const nameIsDirectory = rawName.endsWith("/");
			const unixMode = madeBy >> 8 === 3 ? (externalAttributes >>> 16) & 0xffff : 0;
			const fileType = unixMode & 0o170000;
			let type: RawEntry["type"];
			if (fileType === 0 || fileType === 0o100000) type = nameIsDirectory ? "directory" : "file";
			else if (fileType === 0o040000) type = "directory";
			else if (fileType === 0o120000) type = "symlink";
			else throw archiveError(`entry ${quote(rawName)} is a device, FIFO or socket, which is not allowed`);
			if (nameIsDirectory && type !== "directory") {
				throw archiveError(`entry ${quote(rawName)} ends with '/' but is not a directory`);
			}
			const normalized = normalizeEntryPath(rawName);
			if (normalized === "") {
				if (type === "directory") continue;
				throw archiveError(`unsafe entry name ${quote(rawName)}`);
			}
			if (type !== "directory") {
				if (method !== 0 && method !== 8) {
					throw archiveError(`entry ${quote(rawName)} uses unsupported compression method ${method}`);
				}
				if (method === 0 && values.compressedSize !== values.size) {
					throw archiveError(`entry ${quote(rawName)} is stored but its sizes disagree`);
				}
				if (method === 8 && values.compressedSize === 0) {
					throw archiveError(`entry ${quote(rawName)} has no compressed data`);
				}
				if (type === "symlink" && (values.size > 4096 || values.compressedSize > 8192)) {
					throw archiveError(`symbolic link ${quote(rawName)} has an oversized target`);
				}
			}
			records.push({
				path: normalized,
				type,
				size: type === "directory" ? 0 : values.size,
				mode: unixMode & 0o777,
				method,
				crc,
				compressedSize: type === "directory" ? 0 : values.compressedSize,
				localOffset: values.localOffset,
				dataOffset: 0,
				nameBytes,
			});
		}
		if (position !== directory.length) throw archiveError("unexpected data after the ZIP central directory entries");
		for (const record of records) {
			if (record.localOffset + 30 > location.offset) throw archiveError("corrupt ZIP local header offset");
			const local = await readAt(handle, record.localOffset, 30);
			if (local.readUInt32LE(0) !== ZIP_LOCAL) throw archiveError("corrupt ZIP local header");
			const localNameLength = local.readUInt16LE(26);
			const localExtraLength = local.readUInt16LE(28);
			const localName = await readAt(handle, record.localOffset + 30, localNameLength);
			if (!localName.equals(record.nameBytes)) {
				throw archiveError(`ZIP local and central headers disagree for ${quote(record.path)}`);
			}
			if (record.type !== "directory" && local.readUInt16LE(8) !== record.method) {
				throw archiveError(`ZIP local and central headers disagree for ${quote(record.path)}`);
			}
			record.dataOffset = record.localOffset + 30 + localNameLength + localExtraLength;
			if (record.dataOffset + record.compressedSize > location.offset) {
				throw archiveError(`ZIP entry ${quote(record.path)} overlaps the central directory`);
			}
		}
		const byOffset = [...records].sort((a, b) => a.localOffset - b.localOffset);
		for (let i = 0; i + 1 < byOffset.length; i++) {
			if (byOffset[i]!.dataOffset + byOffset[i]!.compressedSize > byOffset[i + 1]!.localOffset) {
				throw archiveError("ZIP entries overlap");
			}
		}
		for (const record of records) {
			if (record.type !== "symlink") continue;
			const bytes = await readZipBytes(handle, record);
			if (bytes.length !== record.size || bytes.length === 0 || bytes.length > 4096) {
				throw archiveError(`symbolic link ${quote(record.path)} has an invalid target`);
			}
			record.target = bytes.toString("utf8");
		}
		return { entries: validateEntries(records, limits), records };
	} finally {
		await handle.close();
	}
}

async function* zipEntryChunks(file: string, record: ZipRecord): AsyncGenerator<Buffer> {
	if (record.compressedSize === 0) return;
	const source = fs.createReadStream(file, { start: record.dataOffset, end: record.dataOffset + record.compressedSize - 1 });
	if (record.method === 0) {
		try {
			for await (const chunk of source) yield chunk;
		} finally {
			source.destroy();
		}
		return;
	}
	const inflate = zlib.createInflateRaw();
	source.on("error", error => inflate.destroy(error));
	source.pipe(inflate);
	try {
		for await (const chunk of inflate) yield chunk;
	} catch (error) {
		throw archiveError(`corrupt compressed data for ${quote(record.path)}: ${errorMessage(error)}`);
	} finally {
		source.destroy();
		inflate.destroy();
	}
}

// gzip / tar ---------------------------------------------------------------------------------------

async function* gunzipChunks(file: string, maxBytes: number): AsyncGenerator<Buffer> {
	const gunzip = zlib.createGunzip();
	const source = fs.createReadStream(file);
	source.on("error", error => gunzip.destroy(error));
	source.pipe(gunzip);
	let total = 0;
	try {
		for await (const chunk of gunzip) {
			const buffer: Buffer = chunk;
			total += buffer.length;
			if (total > maxBytes) throw archiveError(`archive expands beyond the ${maxBytes} byte limit`);
			yield buffer;
		}
	} catch (error) {
		if (error instanceof RuntimeError) throw error;
		throw archiveError(`corrupt or truncated gzip data: ${errorMessage(error)}`);
	} finally {
		source.destroy();
		gunzip.destroy();
	}
}

class ChunkReader {
	private readonly source: AsyncIterator<Buffer>;
	private buffer: Buffer = Buffer.alloc(0);
	private done = false;

	constructor(source: AsyncIterable<Buffer>) {
		this.source = source[Symbol.asyncIterator]();
	}

	private async more(): Promise<boolean> {
		if (this.done) return false;
		const next = await this.source.next();
		if (next.done) {
			this.done = true;
			return false;
		}
		this.buffer = this.buffer.length === 0 ? next.value : Buffer.concat([this.buffer, next.value]);
		return true;
	}

	/** Exactly `length` bytes, or undefined at a clean end of the stream. A partial read is an error. */
	async read(length: number): Promise<Buffer | undefined> {
		while (this.buffer.length < length) {
			if (!(await this.more())) {
				if (this.buffer.length === 0) return undefined;
				throw archiveError("archive is truncated");
			}
		}
		const out = this.buffer.subarray(0, length);
		this.buffer = this.buffer.subarray(length);
		return out;
	}

	/** Up to `max` bytes (at least one). */
	async take(max: number): Promise<Buffer> {
		if (this.buffer.length === 0 && !(await this.more())) throw archiveError("archive is truncated");
		const length = Math.min(max, this.buffer.length);
		const out = this.buffer.subarray(0, length);
		this.buffer = this.buffer.subarray(length);
		return out;
	}

	async skip(length: number): Promise<void> {
		let remaining = length;
		while (remaining > 0) remaining -= (await this.take(remaining)).length;
	}

	/** Consumes the rest of the stream so gzip integrity is checked to the end. */
	async drain(): Promise<void> {
		this.buffer = Buffer.alloc(0);
		while (await this.more()) this.buffer = Buffer.alloc(0);
	}

	/** Releases the underlying generator (and its file and zlib streams) when iteration stops early. */
	async close(): Promise<void> {
		await this.source.return?.();
	}
}

interface TarHeader {
	path: string;
	typeflag: string;
	size: number;
	mode: number;
	linkname: string;
}

function tarString(block: Buffer, offset: number, length: number): string {
	const end = block.indexOf(0, offset);
	const stop = end < 0 || end > offset + length ? offset + length : end;
	return block.toString("utf8", offset, stop);
}

function tarNumber(block: Buffer, offset: number, length: number): number {
	const first = block[offset]!;
	if ((first & 0x80) !== 0) {
		if ((first & 0x40) !== 0) throw archiveError("corrupt tar header (negative number)");
		let value = first & 0x3f;
		for (let i = 1; i < length; i++) {
			value = value * 256 + block[offset + i]!;
			if (value > Number.MAX_SAFE_INTEGER) throw archiveError("corrupt tar header (number out of range)");
		}
		return value;
	}
	const text = (block.toString("latin1", offset, offset + length).split("\0")[0] ?? "").trim();
	if (text === "") return 0;
	if (!/^[0-7]+$/.test(text)) throw archiveError("corrupt tar header (invalid number)");
	return Number.parseInt(text, 8);
}

function parseTarBlock(block: Buffer): TarHeader {
	const stored = tarNumber(block, 148, 8);
	let unsigned = 0;
	let signed = 0;
	for (let i = 0; i < 512; i++) {
		const byte = i >= 148 && i < 156 ? 0x20 : block[i]!;
		unsigned += byte;
		signed += byte > 127 ? byte - 256 : byte;
	}
	if (stored !== unsigned && stored !== signed) throw archiveError("corrupt tar header (checksum mismatch)");
	const name = tarString(block, 0, 100);
	const prefix = block.toString("latin1", 257, 263) === "ustar\0" ? tarString(block, 345, 155) : "";
	return {
		path: prefix === "" ? name : `${prefix}/${name}`,
		typeflag: block[156] === 0 ? "0" : String.fromCharCode(block[156]!),
		size: tarNumber(block, 124, 12),
		mode: tarNumber(block, 100, 8),
		linkname: tarString(block, 157, 100),
	};
}

function parsePax(data: Buffer): Record<string, string> {
	const records: Record<string, string> = {};
	let position = 0;
	while (position < data.length) {
		const space = data.indexOf(0x20, position);
		if (space < 0) throw archiveError("corrupt tar extended header");
		const length = Number.parseInt(data.toString("latin1", position, space), 10);
		if (!Number.isInteger(length) || length <= space - position + 1 || position + length > data.length) {
			throw archiveError("corrupt tar extended header");
		}
		const record = data.toString("utf8", space + 1, position + length - 1);
		const equals = record.indexOf("=");
		if (equals > 0) records[record.slice(0, equals)] = record.slice(equals + 1);
		position += length;
	}
	return records;
}

async function readMetaBody(reader: ChunkReader, size: number): Promise<Buffer> {
	if (size > 1024 * 1024) throw archiveError("tar extended header is too large");
	const body = size === 0 ? Buffer.alloc(0) : await reader.read(size);
	if (body === undefined) throw archiveError("archive is truncated");
	const padding = (512 - (size % 512)) % 512;
	if (padding > 0) await reader.skip(padding);
	return body;
}

interface TarItem {
	path: string;
	type: RawEntry["type"] | "hardlink" | "symlink" | "other";
	typeflag: string;
	size: number;
	mode: number;
	linkname: string;
	body(): AsyncGenerator<Buffer>;
}

async function* tarEntries(chunks: AsyncIterable<Buffer>, limits: ArchiveLimits): AsyncGenerator<TarItem> {
	const reader = new ChunkReader(chunks);
	try {
		yield* readTarEntries(reader, limits);
	} finally {
		await reader.close();
	}
}

async function* readTarEntries(reader: ChunkReader, limits: ArchiveLimits): AsyncGenerator<TarItem> {
	let longName: string | undefined;
	let pax: Record<string, string> = {};
	let zeroBlocks = 0;
	let count = 0;
	for (;;) {
		const block = await reader.read(512);
		if (block === undefined) break;
		if (block.every(byte => byte === 0)) {
			zeroBlocks++;
			if (zeroBlocks >= 2) break;
			continue;
		}
		zeroBlocks = 0;
		const header = parseTarBlock(block);
		if (header.typeflag === "x") {
			pax = { ...pax, ...parsePax(await readMetaBody(reader, header.size)) };
			continue;
		}
		if (header.typeflag === "g") {
			const global = parsePax(await readMetaBody(reader, header.size));
			if ("path" in global || "size" in global) throw archiveError("global tar extended headers that set path or size are not supported");
			continue;
		}
		if (header.typeflag === "L") {
			longName = (await readMetaBody(reader, header.size)).toString("utf8").split("\0")[0];
			continue;
		}
		if (header.typeflag === "K") {
			await readMetaBody(reader, header.size);
			continue;
		}
		count++;
		if (count > limits.entries) throw archiveError(`archive has more than ${limits.entries} entries`);
		const size = pax.size !== undefined ? Number.parseInt(pax.size, 10) : header.size;
		if (!Number.isInteger(size) || size < 0) throw archiveError("corrupt tar extended header (size)");
		const entryPath = pax.path ?? longName ?? header.path;
		longName = undefined;
		pax = {};
		let type: TarItem["type"];
		switch (header.typeflag) {
			case "0":
				type = entryPath.endsWith("/") ? "directory" : "file";
				break;
			case "5":
				type = "directory";
				break;
			case "1":
				type = "hardlink";
				break;
			case "2":
				type = "symlink";
				break;
			default:
				type = "other";
		}
		let remaining = size;
		const padding = (512 - (size % 512)) % 512;
		const item: TarItem = {
			path: entryPath,
			type,
			typeflag: header.typeflag,
			size,
			mode: header.mode,
			linkname: header.linkname,
			async *body() {
				while (remaining > 0) {
					const chunk = await reader.take(remaining);
					remaining -= chunk.length;
					yield chunk;
				}
			},
		};
		yield item;
		while (remaining > 0) remaining -= (await reader.take(remaining)).length;
		if (padding > 0 && size > 0) await reader.skip(padding);
	}
	if (count === 0) throw archiveError("archive contains no entries");
	await reader.drain();
}

function tarRawEntry(item: TarItem): RawEntry | undefined {
	if (item.type === "hardlink" || item.type === "symlink" || item.type === "other") {
		const kind = item.type === "hardlink" ? "a hard link" : item.type === "symlink" ? "a symbolic link" : `of unsupported type ${quote(item.typeflag)}`;
		throw archiveError(`tar entry ${quote(item.path)} is ${kind}; only regular files and directories are allowed in tar archives`);
	}
	const normalized = normalizeEntryPath(item.path);
	if (normalized === "") {
		if (item.type === "directory") return undefined;
		throw archiveError(`unsafe entry name ${quote(item.path)}`);
	}
	return { path: normalized, type: item.type, size: item.type === "file" ? item.size : 0, mode: item.mode & 0o777 };
}

async function inspectTar(file: string, limits: ArchiveLimits): Promise<ArchiveEntry[]> {
	const raw: RawEntry[] = [];
	for await (const item of tarEntries(gunzipChunks(file, limits.expandedBytes + 64 * 1024 * 1024), limits)) {
		const entry = tarRawEntry(item);
		if (entry !== undefined) raw.push(entry);
	}
	return validateEntries(raw, limits);
}

async function inspectGzip(file: string, limits: ArchiveLimits, options: ArchiveOptions): Promise<ArchiveEntry[]> {
	const name = options.fileName;
	if (name === undefined || name.includes("/") || normalizeEntryPath(name) !== name) {
		throw new RuntimeError("invalid-argument", "gzip artifacts need a single-segment fileName");
	}
	let total = 0;
	for await (const chunk of gunzipChunks(file, limits.expandedBytes)) total += chunk.length;
	return validateEntries([{ path: name, type: "file", size: total, mode: options.executable === true ? 0o755 : 0o644 }], limits);
}

// Entry points -------------------------------------------------------------------------------------

export interface ArchiveOptions {
	/** `gzip` only: the single extracted file's name. */
	fileName?: string;
	/** `gzip` only: extract it executable. */
	executable?: boolean;
}

export interface ExtractOptions extends ArchiveOptions {
	limits?: ArchiveLimits;
}

interface Inspection {
	listing: ArchiveListing;
	zip?: ZipRecord[];
}

async function inspect(file: string, format: ArchiveFormat, limits: ArchiveLimits, options: ArchiveOptions): Promise<Inspection> {
	let stat: fs.Stats;
	try {
		stat = await fsp.stat(file);
	} catch (error) {
		throw archiveError(`cannot read archive ${file}: ${errorMessage(error)}`);
	}
	if (!stat.isFile()) throw archiveError(`${file} is not a regular file`);
	if (stat.size > limits.compressedBytes) {
		throw archiveError(`archive is ${stat.size} bytes; the limit is ${limits.compressedBytes}`);
	}
	let entries: ArchiveEntry[];
	let zip: ZipRecord[] | undefined;
	switch (format) {
		case "zip": {
			const result = await inspectZip(file, stat.size, limits);
			entries = result.entries;
			zip = result.records;
			break;
		}
		case "tar.gz":
			entries = await inspectTar(file, limits);
			break;
		case "gzip":
			entries = await inspectGzip(file, limits, options);
			break;
		default:
			throw new RuntimeError("invalid-argument", `unsupported archive format ${quote(String(format))}`);
	}
	const expandedBytes = entries.reduce((sum, entry) => sum + entry.size, 0);
	return { listing: { format, entries, compressedBytes: stat.size, expandedBytes }, zip };
}

/**
 * Reads and validates archive metadata without extracting anything: entry count, byte limits,
 * traversal/absolute names, links, special files, duplicate and case-colliding names.
 */
export async function inspectArchive(
	file: string,
	format: ArchiveFormat,
	limits: ArchiveLimits = ARCHIVE_LIMITS,
	options: ArchiveOptions = {},
): Promise<ArchiveListing> {
	return (await inspect(file, format, limits, options)).listing;
}

async function writeEntryFile(
	target: string,
	mode: number,
	chunks: AsyncIterable<Buffer>,
	expectedSize: number,
	expectedCrc?: number,
): Promise<void> {
	await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o755 });
	const handle = await fsp.open(target, "wx", 0o600);
	let written = 0;
	let crc = 0;
	try {
		for await (const chunk of chunks) {
			written += chunk.length;
			if (written > expectedSize) throw archiveError(`entry ${quote(path.basename(target))} expands beyond its declared size`);
			crc = crc32Update(crc, chunk);
			await writeAll(handle, chunk);
		}
		if (written !== expectedSize) throw archiveError(`entry ${quote(path.basename(target))} is shorter than its declared size`);
		if (expectedCrc !== undefined && crc !== expectedCrc) throw archiveError(`entry ${quote(path.basename(target))} failed its CRC-32 check`);
	} finally {
		await handle.close();
	}
	await fsp.chmod(target, mode);
}

function entryTarget(destination: string, entryPath: string): string {
	const target = path.join(destination, ...entryPath.split("/"));
	if (target === destination || !isWithin(destination, target)) {
		throw archiveError(`entry ${quote(entryPath)} resolves outside the extraction directory`);
	}
	return target;
}

async function extractZipRecords(file: string, records: readonly ZipRecord[], destination: string): Promise<void> {
	for (const record of records) {
		if (record.type === "directory") await fsp.mkdir(entryTarget(destination, record.path), { recursive: true, mode: 0o755 });
	}
	for (const record of records) {
		if (record.type !== "file") continue;
		await writeEntryFile(entryTarget(destination, record.path), sanitizeMode("file", record.mode), zipEntryChunks(file, record), record.size, record.crc);
	}
	for (const record of records) {
		if (record.type !== "symlink" || record.target === undefined) continue;
		const target = entryTarget(destination, record.path);
		await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o755 });
		await fsp.symlink(record.target, target);
	}
}

async function extractTarEntries(file: string, listing: ArchiveListing, destination: string, limits: ArchiveLimits): Promise<void> {
	let index = 0;
	for await (const item of tarEntries(gunzipChunks(file, limits.expandedBytes + 64 * 1024 * 1024), limits)) {
		const entry = tarRawEntry(item);
		if (entry === undefined) continue;
		const expected = listing.entries[index++];
		if (expected === undefined || expected.path !== entry.path || expected.type !== entry.type || expected.size !== entry.size) {
			throw archiveError("archive changed between validation and extraction");
		}
		const target = entryTarget(destination, entry.path);
		if (entry.type === "directory") {
			await fsp.mkdir(target, { recursive: true, mode: 0o755 });
		} else {
			await writeEntryFile(target, expected.mode, item.body(), entry.size);
		}
	}
	if (index !== listing.entries.length) throw archiveError("archive changed between validation and extraction");
}

/**
 * Validates the whole archive first, then extracts into an empty `destination` (created if
 * missing). Regular files are created exclusively (never through a link), symlinks last.
 */
export async function extractArchive(
	file: string,
	format: ArchiveFormat,
	destination: string,
	options: ExtractOptions = {},
): Promise<ArchiveListing> {
	const limits = options.limits ?? ARCHIVE_LIMITS;
	const inspection = await inspect(file, format, limits, options);
	const target = path.resolve(destination);
	await fsp.mkdir(target, { recursive: true, mode: 0o755 });
	if ((await fsp.readdir(target)).length > 0) {
		throw new RuntimeError("invalid-argument", `archive destination ${target} must be empty`);
	}
	switch (format) {
		case "zip":
			await extractZipRecords(file, inspection.zip ?? [], target);
			break;
		case "tar.gz":
			await extractTarEntries(file, inspection.listing, target, limits);
			break;
		case "gzip": {
			const entry = inspection.listing.entries[0]!;
			await writeEntryFile(entryTarget(target, entry.path), entry.mode, gunzipChunks(file, limits.expandedBytes), entry.size);
			break;
		}
	}
	return inspection.listing;
}

// ── Downloads ───────────────────────────────────────────────────────────────────────────────────

function assertAllowedUrl(url: URL, hosts: readonly string[]): void {
	if (url.protocol !== "https:") {
		throw new RuntimeError("download", `refusing non-HTTPS download (${url.protocol}//${url.hostname})`);
	}
	if (url.username !== "" || url.password !== "" || url.port !== "") {
		throw new RuntimeError("download", `refusing download URL with credentials or a custom port (${url.hostname})`);
	}
	const host = url.hostname.toLowerCase();
	if (!hosts.some(allowed => host === allowed || host.endsWith(`.${allowed}`))) {
		throw new RuntimeError("download", `host ${host} is not an approved download host`);
	}
}

function validateArtifact(artifact: Artifact): void {
	if (typeof artifact !== "object" || artifact === null) throw new RuntimeError("invalid-argument", "artifact must be an object");
	let url: URL;
	try {
		url = new URL(artifact.url);
	} catch {
		throw new RuntimeError("invalid-argument", `artifact url is not a valid URL: ${quote(String(artifact.url))}`);
	}
	if (url.protocol !== "https:") throw new RuntimeError("invalid-argument", "artifact url must use https");
	if (typeof artifact.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(artifact.sha256)) {
		throw new RuntimeError("invalid-argument", "artifact sha256 must be 64 lower-case hex characters");
	}
	if (artifact.format !== "zip" && artifact.format !== "tar.gz" && artifact.format !== "gzip") {
		throw new RuntimeError("invalid-argument", `artifact format must be zip, tar.gz or gzip (got ${quote(String(artifact.format))})`);
	}
	if (typeof artifact.version !== "string" || artifact.version === "") throw new RuntimeError("invalid-argument", "artifact version is required");
	if (typeof artifact.provenance !== "string" || artifact.provenance === "") throw new RuntimeError("invalid-argument", "artifact provenance is required");
	if (typeof artifact.reviewed !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(artifact.reviewed)) {
		throw new RuntimeError("invalid-argument", "artifact reviewed must be an ISO date (YYYY-MM-DD)");
	}
	if (artifact.format === "gzip" && (artifact.fileName === undefined || artifact.fileName.includes("/"))) {
		throw new RuntimeError("invalid-argument", "gzip artifacts need a single-segment fileName");
	}
}

interface DownloadOptions {
	fetchImpl: typeof fetch;
	hosts: readonly string[];
	signal: AbortSignal | undefined;
	maxBytes: number;
	timeoutMs: number;
}

/** Streams the pinned artifact to `destination`, enforcing HTTPS/host rules, the size cap and the SHA-256 pin. */
async function downloadArtifact(artifact: Artifact, destination: string, options: DownloadOptions): Promise<number> {
	const controller = new AbortController();
	const stopped: { reason?: "timeout" | "aborted" } = {};
	const stop = (why: "timeout" | "aborted"): void => {
		stopped.reason ??= why;
		controller.abort();
	};
	const timer = setTimeout(() => stop("timeout"), options.timeoutMs);
	const onAbort = (): void => stop("aborted");
	if (options.signal?.aborted) stop("aborted");
	else options.signal?.addEventListener("abort", onAbort, { once: true });
	try {
		let url = new URL(artifact.url);
		let response: Response | undefined;
		for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
			assertAllowedUrl(url, options.hosts);
			const current = await options.fetchImpl(url.toString(), {
				redirect: "manual",
				signal: controller.signal,
				headers: { accept: "application/octet-stream", "accept-encoding": "identity", "user-agent": "omp-starter-tooling" },
			});
			if (current.status >= 300 && current.status < 400) {
				const location = current.headers.get("location");
				await current.body?.cancel().catch(() => undefined);
				if (location === null || hop === MAX_REDIRECTS) {
					throw new RuntimeError("download", `download of ${url.hostname} redirected too many times or without a location`);
				}
				url = new URL(location, url);
				continue;
			}
			response = current;
			break;
		}
		if (response === undefined) throw new RuntimeError("download", "download did not produce a response");
		if (response.status !== 200 || response.body === null) {
			await response.body?.cancel().catch(() => undefined);
			throw new RuntimeError("download", `download from ${url.hostname} failed with HTTP ${response.status}`);
		}
		const declared = Number(response.headers.get("content-length"));
		if (Number.isFinite(declared) && declared > options.maxBytes) {
			await response.body.cancel().catch(() => undefined);
			throw new RuntimeError("download", `download is ${declared} bytes; the limit is ${options.maxBytes}`);
		}
		const reader = response.body.getReader();
		const hash = crypto.createHash("sha256");
		const handle = await fsp.open(destination, "wx", 0o600);
		let total = 0;
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				total += value.byteLength;
				if (total > options.maxBytes) {
					await reader.cancel().catch(() => undefined);
					throw new RuntimeError("download", `download exceeds the ${options.maxBytes} byte limit`);
				}
				hash.update(value);
				await writeAll(handle, value);
			}
		} finally {
			await handle.close();
		}
		const actual = hash.digest("hex");
		if (actual !== artifact.sha256) {
			throw new RuntimeError(
				"integrity",
				`SHA-256 mismatch for ${url.hostname}${url.pathname}: expected ${artifact.sha256}, got ${actual}. Nothing was extracted or installed.`,
			);
		}
		return total;
	} catch (error) {
		await fsp.rm(destination, { force: true }).catch(() => undefined);
		if (stopped.reason === "timeout") throw new RuntimeError("timeout", `download timed out after ${Math.round(options.timeoutMs / 1000)}s`);
		if (stopped.reason === "aborted") throw new RuntimeError("aborted", "download was cancelled");
		if (error instanceof RuntimeError) throw error;
		throw new RuntimeError("download", `download failed: ${redact(errorMessage(error))}`, { cause: error });
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", onAbort);
	}
}

// ── Owned processes ─────────────────────────────────────────────────────────────────────────────

class OwnedProcessImpl implements OwnedProcess {
	readonly pid: number;
	readonly marker: string;
	readonly stdin: Writable | null;
	readonly stdout: Readable | null;
	readonly stderr: Readable | null;
	readonly exited: Promise<ExitStatus>;
	readonly startId: string | undefined;
	hasExited = false;
	private inflight: Promise<CleanupResult> | undefined;

	constructor(
		child: cp.ChildProcess,
		marker: string,
		startId: string | undefined,
		private readonly sweep: (self: OwnedProcessImpl) => Promise<CleanupResult>,
	) {
		this.pid = child.pid ?? 0;
		this.marker = marker;
		this.stdin = child.stdin;
		this.stdout = child.stdout;
		this.stderr = child.stderr;
		this.startId = startId;
		const { promise, resolve } = Promise.withResolvers<ExitStatus>();
		this.exited = promise;
		child.on("error", error => {
			this.hasExited = true;
			resolve({ code: null, signal: null, error: errorMessage(error) });
		});
		child.once("exit", (code, signal) => {
			this.hasExited = true;
			resolve({ code, signal });
		});
	}

	terminate(): Promise<CleanupResult> {
		if (this.inflight === undefined) {
			this.inflight = this.sweep(this).finally(() => {
				this.inflight = undefined;
			});
		}
		return this.inflight;
	}
}

/** Bounded capture: keeps the leading `max` bytes plus a small rolling tail for error messages. */
class Collector {
	truncated = false;
	private readonly head: Buffer[] = [];
	private headBytes = 0;
	private tail: Buffer = Buffer.alloc(0);

	constructor(private readonly max: number) {}

	push(chunk: Buffer | string): void {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		if (this.headBytes < this.max) {
			const room = this.max - this.headBytes;
			if (buffer.length <= room) {
				this.head.push(buffer);
				this.headBytes += buffer.length;
			} else {
				this.head.push(buffer.subarray(0, room));
				this.headBytes = this.max;
				this.truncated = true;
			}
		} else {
			this.truncated = true;
		}
		this.tail = Buffer.concat([this.tail, buffer]);
		if (this.tail.length > TAIL_BYTES * 2) this.tail = this.tail.subarray(this.tail.length - TAIL_BYTES);
	}

	text(): string {
		return Buffer.concat(this.head).toString("utf8");
	}

	tailText(): string {
		return this.tail.subarray(-TAIL_BYTES).toString("utf8");
	}
}

function streamEnded(stream: Readable | null, ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	if (stream === null || stream.destroyed || stream.readableEnded) {
		resolve();
		return promise;
	}
	const done = (): void => {
		clearTimeout(timer);
		stream.off("end", done);
		stream.off("close", done);
		stream.off("error", done);
		resolve();
	};
	const timer = setTimeout(done, ms);
	stream.once("end", done);
	stream.once("close", done);
	stream.once("error", done);
	return promise;
}

const DARWIN_DEVELOPER_STUBS: Readonly<Record<string, true>> = {
	git: true,
	python3: true,
	pip3: true,
	clang: true,
	"clang++": true,
	cc: true,
	"c++": true,
	gcc: true,
	"g++": true,
	make: true,
	ld: true,
	ar: true,
	nm: true,
	lldb: true,
	swift: true,
	swiftc: true,
	xcrun: true,
};

// ── Runtime ─────────────────────────────────────────────────────────────────────────────────────

interface Scratch extends ScratchDirs {
	readonly root: string;
	readonly workRoot: string;
}

interface InstallContext {
	readonly payload: string;
	readonly downloads: string;
	readonly signal: AbortSignal | undefined;
	progress(message: string): void;
}

function validateInstallRequest(request: InstallRequest): void {
	assertSegment("tool", request.tool);
	assertSegment("version", request.version);
	if (!Array.isArray(request.operations) || request.operations.length === 0) {
		throw new RuntimeError("invalid-argument", "an install needs at least one operation");
	}
	for (const operation of request.operations) {
		switch (operation.type) {
			case "artifact":
				validateArtifact(operation.artifact);
				break;
			case "write-file":
				if (typeof operation.path !== "string" || typeof operation.content !== "string") {
					throw new RuntimeError("invalid-argument", "write-file needs a path and string content");
				}
				if (operation.path === INSTALL_MANIFEST_FILE) {
					throw new RuntimeError("invalid-argument", `${INSTALL_MANIFEST_FILE} is reserved`);
				}
				break;
			case "run":
				validateArgv(operation.command, operation.args);
				assertEnvOverride(operation.env);
				if (operation.timeoutMs !== undefined) resolveTimeout(operation.timeoutMs);
				break;
			default: {
				const received: unknown = operation;
				const kind = typeof received === "object" && received !== null && "type" in received ? String(received.type) : typeof received;
				throw new RuntimeError("invalid-argument", `unknown install operation ${quote(kind)}`);
			}
		}
	}
	for (const executable of request.executables ?? []) {
		if (typeof executable !== "string" || executable === "") {
			throw new RuntimeError("invalid-argument", "executables must be install-relative paths");
		}
	}
}

const PROFILE_IDS: readonly ProfileId[] = ["darwin-arm64", "darwin-x64", "linux-x64"];

function isArtifactRecord(value: unknown): value is ArtifactRecord {
	if (typeof value !== "object" || value === null) return false;
	const fields = new Map(Object.entries(value));
	return ["url", "version", "sha256", "format", "provenance", "reviewed"].every(name => typeof fields.get(name) === "string");
}

/** Validates a manifest read from disk; anything that is not exactly the shape this runtime writes is rejected. */
function parseManifest(text: string): InstallManifest | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) return undefined;
	const fields = new Map(Object.entries(parsed));
	const tool = fields.get("tool");
	const version = fields.get("version");
	const digest = fields.get("digest");
	const installedAt = fields.get("installedAt");
	const artifacts = fields.get("artifacts");
	const executables = fields.get("executables");
	const platform = PROFILE_IDS.find(id => id === fields.get("platform"));
	if (fields.get("schema") !== 1 || typeof tool !== "string" || typeof version !== "string" || typeof digest !== "string") return undefined;
	if (typeof installedAt !== "string" || platform === undefined) return undefined;
	if (!Array.isArray(artifacts) || !artifacts.every(isArtifactRecord)) return undefined;
	if (!Array.isArray(executables) || !executables.every((item): item is string => typeof item === "string")) return undefined;
	return { schema: 1, tool, version, platform, digest, artifacts, executables, installedAt };
}

/** One signal that aborts when any of the given signals does. */
function linkSignals(signals: readonly (AbortSignal | undefined)[]): { signal: AbortSignal; release(): void } {
	const controller = new AbortController();
	const abort = (): void => controller.abort();
	const active = signals.filter((signal): signal is AbortSignal => signal !== undefined);
	for (const signal of active) {
		if (signal.aborted) controller.abort();
		else signal.addEventListener("abort", abort, { once: true });
	}
	return {
		signal: controller.signal,
		release: () => {
			for (const signal of active) signal.removeEventListener("abort", abort);
		},
	};
}

class RuntimeImpl implements Runtime {
	readonly agentDir: string;
	readonly cwd: string;
	readonly toolingRoot: string;
	readonly platform: PlatformDetection;
	private readonly signal: AbortSignal | undefined;
	private readonly parentEnv: Readonly<Record<string, string | undefined>>;
	private readonly fetchImpl: typeof fetch;
	private readonly hosts: readonly string[];
	private readonly graceMs: number;
	private readonly limits: ArchiveLimits;
	private readonly sdkHomes: Record<string, string>;
	private readonly id = crypto.randomBytes(6).toString("hex");
	private readonly spawns = new Set<OwnedProcessImpl>();
	private spawnSeq = 0;
	private disposed = false;
	private disposing: Promise<CleanupResult> | undefined;
	private rootsPromise: Promise<ToolingRoots> | undefined;
	private scratchPromise: Promise<Scratch> | undefined;
	private roots: ToolingRoots | undefined;
	private developerTools: boolean | undefined;
	private exitHook: (() => void) | undefined;
	private abortListener: (() => void) | undefined;

	constructor(options: RuntimeOptions) {
		this.agentDir = path.resolve(options.agentDir);
		this.cwd = path.resolve(options.cwd);
		this.toolingRoot = path.join(this.agentDir, "tooling");
		this.platform = detectPlatform(options.platform);
		this.signal = options.signal;
		this.parentEnv = options.env ?? process.env;
		this.fetchImpl = options.fetch ?? fetch;
		this.hosts = (options.allowedHosts ?? DEFAULT_ALLOWED_HOSTS).map(host => host.toLowerCase());
		this.graceMs = options.killGraceMs ?? KILL_GRACE_MS;
		this.limits = options.archiveLimits ?? ARCHIVE_LIMITS;
		this.sdkHomes = detectSdkHomes(this.parentEnv, this.parentEnv.HOME ?? os.homedir());
		if (this.signal !== undefined && !this.signal.aborted) {
			this.abortListener = () => {
				for (const proc of this.spawns) void proc.terminate().catch(() => undefined);
			};
			this.signal.addEventListener("abort", this.abortListener, { once: true });
		}
	}

	// Guards ------------------------------------------------------------------------------------

	private assertUsable(signal?: AbortSignal): void {
		if (this.disposed) throw new RuntimeError("disposed", "the tooling runtime has been disposed");
		if (this.signal?.aborted || signal?.aborted) throw new RuntimeError("aborted", "the operation was cancelled");
	}

	private requirePlatform(): Platform {
		if (!this.platform.supported) throw new RuntimeError("unsupported-platform", this.platform.reason);
		return this.platform.platform;
	}

	private requirePosix(): void {
		if (process.platform !== "linux" && process.platform !== "darwin") {
			throw new RuntimeError("unsupported-platform", `running tooling commands is not supported on ${process.platform}`);
		}
	}

	private async ensureRoots(): Promise<ToolingRoots> {
		this.assertUsable();
		this.rootsPromise ??= ensureToolingRoots(this.agentDir).then(roots => {
			this.roots = roots;
			return roots;
		});
		return this.rootsPromise;
	}

	private async ensureScratch(): Promise<Scratch> {
		this.scratchPromise ??= (async () => {
			const roots = await this.ensureRoots();
			await sweepStale(roots.work);
			await sweepStale(roots.staging);
			const root = path.join(roots.work, this.id);
			await fsp.mkdir(root, { mode: 0o700 });
			await writeOwner(root);
			const dirs = {
				home: path.join(root, "home"),
				config: path.join(root, "config"),
				cache: path.join(root, "cache"),
				data: path.join(root, "data"),
				state: path.join(root, "state"),
				tmp: path.join(root, "tmp"),
			};
			const workRoot = path.join(root, "work");
			for (const dir of [...Object.values(dirs), workRoot]) await fsp.mkdir(dir, { mode: 0o700 });
			await fsp.writeFile(path.join(dirs.config, "npmrc"), "", { mode: 0o600 });
			await fsp.writeFile(path.join(dirs.config, "npmrc-global"), "", { mode: 0o600 });
			return { ...dirs, root, workRoot };
		})();
		return this.scratchPromise;
	}

	/** Commands run only in runtime-owned work or staging directories; never in the user's project. */
	private assertOwnedCwd(cwd: string): string {
		if (typeof cwd !== "string" || !path.isAbsolute(cwd)) {
			throw new RuntimeError("cwd", "cwd must be an absolute path to a runtime-owned directory");
		}
		let real: string;
		try {
			real = fs.realpathSync(cwd);
		} catch {
			throw new RuntimeError("cwd", `cwd ${cwd} does not exist`);
		}
		const roots = this.roots;
		if (roots === undefined || !(isWithin(roots.work, real) || isWithin(roots.staging, real))) {
			throw new RuntimeError(
				"cwd",
				`refusing to run in ${cwd}: commands run only in runtime-owned work or staging directories, never in the user's project`,
			);
		}
		return real;
	}

	private isProjectLocal(lexical: string, real: string): boolean {
		const cwdReal = realpathOrSelf(this.cwd);
		const bins = projectLocalBinDirs(this.cwd).map(realpathOrSelf);
		if (bins.some(dir => isWithin(dir, lexical) || isWithin(dir, real))) return true;
		const home = realpathOrSelf(this.parentEnv.HOME ?? os.homedir());
		const broad = isWithin(cwdReal, home) || isWithin(cwdReal, realpathOrSelf(this.agentDir));
		return !broad && isWithin(cwdReal, real);
	}

	private async developerToolsPresent(): Promise<boolean> {
		if (this.developerTools !== undefined) return this.developerTools;
		const { promise, resolve } = Promise.withResolvers<boolean>();
		cp.execFile("/usr/bin/xcode-select", ["-p"], { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } }, (error, stdout) => {
			resolve(!error && stdout.trim() !== "" && isDirectory(stdout.trim()));
		});
		this.developerTools = await promise;
		return this.developerTools;
	}

	/** Resolves and vets the executable: absolute, runnable, approved if project-local, no macOS developer-tools stub. */
	private async prepareExecutable(command: string, approvedProjectLocal: boolean): Promise<string> {
		let executable: string;
		if (command.includes("/")) {
			if (!path.isAbsolute(command)) {
				throw new RuntimeError("invalid-argument", `executable ${quote(command)} must be a bare name or an absolute path`);
			}
			executable = command;
		} else {
			const found = this.resolveExecutable(command);
			if (found === undefined) {
				throw new RuntimeError("executable-not-found", `${command} was not found on PATH. Install it yourself, then retry; this tool never installs SDKs.`);
			}
			executable = found.path;
		}
		if (!isExecutableFile(executable)) {
			throw new RuntimeError("executable-not-found", `${executable} is not an executable file`);
		}
		if (this.isProjectLocal(executable, realpathOrSelf(executable)) && !approvedProjectLocal) {
			throw new RuntimeError(
				"unapproved",
				`refusing to execute project-local ${executable}: it lives in the project, so running it needs your explicit approval`,
			);
		}
		if (
			process.platform === "darwin" &&
			path.dirname(executable) === "/usr/bin" &&
			Object.hasOwn(DARWIN_DEVELOPER_STUBS, path.basename(executable)) &&
			!(await this.developerToolsPresent())
		) {
			throw new RuntimeError(
				"executable-not-found",
				`${executable} is a macOS developer-tools stub and the Command Line Tools are not installed. Run xcode-select --install yourself; this tool never installs SDKs.`,
			);
		}
		return executable;
	}

	// Public API --------------------------------------------------------------------------------

	installDirectory(tool: string, version: string, platform?: ProfileId): string {
		assertSegment("tool", tool);
		assertSegment("version", version);
		const id = platform ?? this.requirePlatform().id;
		return path.join(this.toolingRoot, tool, version, id);
	}

	resolveExecutable(name: string, options: ResolveOptions = {}): ResolvedExecutable | undefined {
		if (typeof name !== "string" || name === "" || name.includes("/") || name.includes("\0")) {
			throw new RuntimeError("invalid-argument", `executable name ${quote(String(name))} must be a bare name`);
		}
		const classify = (file: string): ResolvedExecutable => ({
			path: file,
			origin: this.isProjectLocal(file, realpathOrSelf(file)) ? "project-local" : "path",
		});
		if (options.projectLocal === true) {
			for (const dir of projectLocalBinDirs(this.cwd)) {
				const found = findExecutable(name, [dir]);
				if (found !== undefined) return { path: found, origin: "project-local" };
			}
		}
		const found = findExecutable(name, absolutePathDirs(this.parentEnv.PATH));
		return found === undefined ? undefined : classify(found);
	}

	async workDir(label: string): Promise<WorkDir> {
		this.assertUsable();
		this.requirePosix();
		const scratch = await this.ensureScratch();
		const safe = String(label).replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[-.]+/, "").slice(0, 40) || "work";
		const created = await fsp.mkdtemp(path.join(scratch.workRoot, `${safe}-`));
		await fsp.chmod(created, 0o700);
		const real = await fsp.realpath(created);
		return {
			path: real,
			remove: async () => {
				if (real !== scratch.workRoot && isWithin(scratch.workRoot, real)) await removeTree(real);
			},
		};
	}

	async spawn(command: string, args: readonly string[], options: SpawnOptions): Promise<OwnedProcess> {
		return this.start(command, args, options);
	}

	private async start(command: string, args: readonly string[], options: SpawnOptions): Promise<OwnedProcessImpl> {
		this.assertUsable(options.signal);
		this.requirePosix();
		validateArgv(command, args);
		assertEnvOverride(options.env);
		const scratch = await this.ensureScratch();
		const cwd = this.assertOwnedCwd(options.cwd);
		const executable = await this.prepareExecutable(command, options.approvedProjectLocal === true);
		this.assertUsable(options.signal);
		const marker = `${this.id}.${++this.spawnSeq}`;
		const env = buildChildEnv({ parent: this.parentEnv, scratch, marker, sdkHomes: this.sdkHomes, override: options.env });
		let child: cp.ChildProcess;
		try {
			child = cp.spawn(executable, [...args], {
				cwd,
				env,
				stdio: [options.stdin === "pipe" ? "pipe" : "ignore", "pipe", "pipe"],
				detached: true,
				windowsHide: true,
			});
		} catch (error) {
			throw new RuntimeError("spawn", `could not start ${path.basename(executable)}: ${redact(errorMessage(error))}`, { cause: error });
		}
		child.stdin?.on("error", () => undefined);
		child.stdout?.on("error", () => undefined);
		child.stderr?.on("error", () => undefined);
		const startId = child.pid === undefined ? undefined : readProcessSync(child.pid)?.startId;
		const proc = new OwnedProcessImpl(child, marker, startId, self => this.sweepOwned(self));
		this.spawns.add(proc);
		this.installExitHook();
		return proc;
	}

	private sweepOwned(proc: OwnedProcessImpl): Promise<CleanupResult> {
		return terminateOwned(
			{ rootPid: proc.pid > 0 ? proc.pid : undefined, rootStartId: proc.startId, marker: proc.marker },
			this.graceMs,
		);
	}

	private installExitHook(): void {
		if (this.exitHook !== undefined) return;
		// Last resort when the host exits without disposing: detached groups would otherwise outlive it.
		this.exitHook = () => {
			for (const proc of this.spawns) {
				if (proc.hasExited || proc.pid <= 0) continue;
				try {
					process.kill(-proc.pid, "SIGKILL");
				} catch {
					// Already gone.
				}
			}
		};
		process.once("exit", this.exitHook);
	}

	async run(command: string, args: readonly string[], options: RunOptions): Promise<RunResult> {
		const timeoutMs = resolveTimeout(options.timeoutMs);
		const maxOutput = options.maxOutputBytes ?? DEFAULT_OUTPUT_BYTES;
		if (!Number.isInteger(maxOutput) || maxOutput < 1 || maxOutput > MAX_OUTPUT_BYTES) {
			throw new RuntimeError("invalid-argument", `maxOutputBytes must be between 1 and ${MAX_OUTPUT_BYTES}`);
		}
		const started = Date.now();
		const label = describeCommand(command, args);
		const proc = await this.start(command, args, { cwd: options.cwd, env: options.env, signal: options.signal, approvedProjectLocal: options.approvedProjectLocal });
		const stdout = new Collector(maxOutput);
		const stderr = new Collector(maxOutput);
		proc.stdout?.on("data", chunk => stdout.push(chunk));
		proc.stderr?.on("data", chunk => stderr.push(chunk));
		const state: { reason?: "timeout" | "aborted"; stopping?: Promise<CleanupResult> } = {};
		const stop = (why: "timeout" | "aborted"): void => {
			if (state.reason !== undefined) return;
			state.reason = why;
			state.stopping = proc.terminate();
		};
		const signals = [options.signal, this.signal].filter((signal): signal is AbortSignal => signal !== undefined);
		const onAbort = (): void => stop("aborted");
		for (const signal of signals) signal.addEventListener("abort", onAbort, { once: true });
		const timer = setTimeout(() => stop("timeout"), timeoutMs);
		if (signals.some(signal => signal.aborted)) stop("aborted");
		try {
			const status = await proc.exited;
			if (state.stopping !== undefined) await state.stopping;
			const cleanup = await proc.terminate();
			await Promise.all([streamEnded(proc.stdout, STREAM_DRAIN_MS), streamEnded(proc.stderr, STREAM_DRAIN_MS)]);
			proc.stdout?.destroy();
			proc.stderr?.destroy();
			if (status.error !== undefined) {
				throw new RuntimeError("spawn", `could not start ${label}: ${redact(status.error)}`);
			}
			if (cleanup.survivors.length > 0) {
				const pids = cleanup.survivors.slice(0, 5).map(survivor => survivor.pid).join(", ");
				throw new RuntimeError(
					"cleanup-failed",
					`${label} left process(es) that could not be stopped (pid ${pids}). Stop them manually, for example with kill -9.`,
				);
			}
			const outputTail = tailMessage(stderr.tailText() || stdout.tailText());
			if (state.reason === "timeout") {
				throw new RuntimeError("timeout", `${label} timed out after ${Math.round(timeoutMs / 1000)}s and was stopped${outputTail ? `: ${outputTail}` : ""}`);
			}
			if (state.reason === "aborted" || this.disposed) {
				throw new RuntimeError("aborted", `${label} was cancelled`);
			}
			if (status.code !== 0) {
				const how = status.signal !== null ? `signal ${status.signal}` : `code ${status.code}`;
				throw new RuntimeError("exit", `${label} exited with ${how}${outputTail ? `: ${outputTail}` : ""}`);
			}
			return {
				stdout: stdout.text(),
				stderr: stderr.text(),
				stdoutTruncated: stdout.truncated,
				stderrTruncated: stderr.truncated,
				durationMs: Date.now() - started,
			};
		} finally {
			clearTimeout(timer);
			for (const signal of signals) signal.removeEventListener("abort", onAbort);
			this.spawns.delete(proc);
		}
	}

	async probe(executable: string, args: readonly string[], options: ProbeOptions = {}): Promise<RunResult> {
		if (typeof executable !== "string" || !path.isAbsolute(executable)) {
			throw new RuntimeError("invalid-argument", `probes run an absolute executable path (got ${quote(String(executable))})`);
		}
		const work = await this.workDir("probe");
		try {
			return await this.run(executable, args, { ...options, cwd: work.path, timeoutMs: options.timeoutMs ?? PROBE_TIMEOUT_MS });
		} finally {
			await work.remove().catch(() => undefined);
		}
	}

	// Installs ----------------------------------------------------------------------------------

	async install(request: InstallRequest, options: InstallOptions = {}): Promise<InstallResult> {
		this.assertUsable(options.signal);
		this.requirePosix();
		const platform = this.requirePlatform();
		validateInstallRequest(request);
		if (request.platform !== undefined && request.platform !== platform.id) {
			throw new RuntimeError("invalid-argument", `this host is ${platform.id}; cannot install for ${request.platform}`);
		}
		const linked = linkSignals([options.signal, this.signal]);
		try {
			return await this.installPinned(request, platform.id, options.onProgress ?? (() => undefined), linked.signal);
		} finally {
			linked.release();
		}
	}

	private async installPinned(
		request: InstallRequest,
		platform: ProfileId,
		progress: (message: string) => void,
		signal: AbortSignal,
	): Promise<InstallResult> {
		const roots = await this.ensureRoots();
		await this.ensureScratch();
		const digest = sha256Hex(
			JSON.stringify({ tool: request.tool, version: request.version, platform, operations: request.operations, executables: request.executables ?? [] }),
		);
		const destination = path.join(roots.root, request.tool, request.version, platform);
		const lexicalDestination = this.installDirectory(request.tool, request.version, platform);
		const lock = await acquireLock(
			path.join(roots.locks, `${request.tool}-${request.version}-${platform}.lock`),
			`installing ${request.tool} ${request.version}`,
		);
		try {
			const existing = await this.reusable(destination, digest, request, platform);
			if (existing !== undefined) {
				progress(`${request.tool} ${request.version} is already installed`);
				return { status: "reused", destination: lexicalDestination, manifest: existing };
			}
			const stagingDir = path.join(roots.staging, `${request.tool}-${crypto.randomBytes(6).toString("hex")}`);
			await fsp.mkdir(stagingDir, { mode: 0o700 });
			try {
				await writeOwner(stagingDir);
				const payload = path.join(stagingDir, "payload");
				const downloads = path.join(stagingDir, "downloads");
				await fsp.mkdir(payload, { mode: 0o755 });
				await fsp.mkdir(downloads, { mode: 0o700 });
				const context: InstallContext = { payload, downloads, signal, progress };
				const artifacts: ArtifactRecord[] = [];
				for (const [index, operation] of request.operations.entries()) {
					this.assertUsable(signal);
					await this.executeOperation(operation, index, context);
					if (operation.type === "artifact") {
						const { url, version, sha256, format, provenance, reviewed } = operation.artifact;
						artifacts.push({ url, version, sha256, format, provenance, reviewed });
					}
				}
				this.assertUsable(signal);
				for (const executable of request.executables ?? []) {
					if (!isExecutableFile(resolveInside(payload, executable, "executable"))) {
						throw new RuntimeError(
							"install",
							`${request.tool} ${request.version} is incomplete: ${quote(executable)} is missing or not executable after installation, so nothing was published`,
						);
					}
				}
				const manifest: InstallManifest = {
					schema: 1,
					tool: request.tool,
					version: request.version,
					platform,
					digest,
					artifacts,
					executables: request.executables ?? [],
					installedAt: new Date().toISOString(),
				};
				try {
					await fsp.writeFile(path.join(payload, INSTALL_MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o644 });
				} catch (error) {
					if (errnoOf(error) === "EEXIST") throw new RuntimeError("install", `the install contains a reserved file named ${INSTALL_MANIFEST_FILE}`);
					throw error;
				}
				progress(`Publishing ${request.tool} ${request.version}`);
				await this.publish(payload, destination);
				return { status: "installed", destination: lexicalDestination, manifest };
			} finally {
				await removeTree(stagingDir).catch(() => undefined);
			}
		} finally {
			await lock.release();
		}
	}

	/** Returns the manifest of an identical published install, undefined when nothing exists; anything else is a collision. */
	private async reusable(
		destination: string,
		digest: string,
		request: InstallRequest,
		platform: ProfileId,
	): Promise<InstallManifest | undefined> {
		const stat = await fsp.lstat(destination).catch((error: unknown) => {
			if (errnoOf(error) === "ENOENT") return undefined;
			throw new RuntimeError("destination", `cannot inspect ${destination}: ${errorMessage(error)}`, { cause: error });
		});
		if (stat === undefined) return undefined;
		const hint = `Nothing was replaced. Remove ${destination} yourself to reinstall.`;
		if (stat.isSymbolicLink() || !stat.isDirectory()) {
			throw new RuntimeError("collision", `${destination} exists and is not a plain directory. ${hint}`);
		}
		const manifest = parseManifest(await fsp.readFile(path.join(destination, INSTALL_MANIFEST_FILE), "utf8").catch(() => ""));
		if (manifest === undefined) {
			throw new RuntimeError("collision", `${destination} exists but is not a complete install created by this tool. ${hint}`);
		}
		if (manifest.digest !== digest || manifest.tool !== request.tool || manifest.version !== request.version || manifest.platform !== platform) {
			throw new RuntimeError("collision", `${destination} holds a different install of ${request.tool} ${request.version} (different sources or recipe). ${hint}`);
		}
		for (const executable of manifest.executables) {
			if (!isExecutableFile(path.join(destination, ...executable.split("/")))) {
				throw new RuntimeError("collision", `${destination} is incomplete: ${quote(executable)} is missing. ${hint}`);
			}
		}
		return manifest;
	}

	/** Atomic publication: a same-filesystem rename of the finished payload; an existing destination is never replaced. */
	private async publish(payload: string, destination: string): Promise<void> {
		await fsp.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
		const present = await fsp.lstat(destination).then(
			() => true,
			(error: unknown) => {
				if (errnoOf(error) === "ENOENT") return false;
				throw new RuntimeError("destination", `cannot inspect ${destination}: ${errorMessage(error)}`, { cause: error });
			},
		);
		if (present) throw new RuntimeError("collision", `${destination} appeared while installing; nothing was replaced`);
		try {
			await fsp.rename(payload, destination);
		} catch (error) {
			if (errnoOf(error) === "EXDEV") {
				throw new RuntimeError("destination", `the tooling directory spans file systems, so ${destination} cannot be published atomically`, { cause: error });
			}
			throw new RuntimeError("install", `could not publish ${destination}: ${errorMessage(error)}`, { cause: error });
		}
	}

	private async executeOperation(operation: InstallOperation, index: number, context: InstallContext): Promise<void> {
		const substitute = (value: string): string => value.split(INSTALL_DIR_TOKEN).join(context.payload);
		switch (operation.type) {
			case "artifact": {
				const { artifact } = operation;
				context.progress(`Downloading ${path.basename(new URL(artifact.url).pathname)} (${artifact.version})`);
				const extension = artifact.format === "gzip" ? "gz" : artifact.format;
				const archive = path.join(context.downloads, `${index}-${crypto.randomBytes(4).toString("hex")}.${extension}`);
				await downloadArtifact(artifact, archive, {
					fetchImpl: this.fetchImpl,
					hosts: this.hosts,
					signal: context.signal,
					maxBytes: this.limits.compressedBytes,
					timeoutMs: INSTALL_TIMEOUT_MS,
				});
				context.progress("Verifying and extracting archive");
				const into = resolveInside(context.payload, operation.into ?? ".", "artifact destination");
				await extractArchive(archive, artifact.format, into, { limits: this.limits, fileName: artifact.fileName, executable: artifact.executable });
				await fsp.rm(archive, { force: true });
				return;
			}
			case "write-file": {
				const target = resolveInside(context.payload, operation.path, "write-file path");
				await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o755 });
				await fsp.writeFile(target, operation.content, { flag: "wx", mode: operation.executable === true ? 0o755 : 0o644 });
				return;
			}
			case "run": {
				const cwd = resolveInside(context.payload, operation.cwd ?? ".", "run cwd");
				const env: Record<string, string> = {};
				for (const [name, value] of Object.entries(operation.env ?? {})) env[name] = substitute(value);
				context.progress(`Running ${describeCommand(operation.command, operation.args)}`);
				await this.run(substitute(operation.command), operation.args.map(substitute), {
					cwd,
					env,
					signal: context.signal,
					timeoutMs: operation.timeoutMs ?? INSTALL_TIMEOUT_MS,
				});
				return;
			}
		}
	}

	// Disposal ----------------------------------------------------------------------------------

	dispose(): Promise<CleanupResult> {
		this.disposing ??= this.shutdown();
		return this.disposing;
	}

	private async shutdown(): Promise<CleanupResult> {
		this.disposed = true;
		if (this.abortListener !== undefined) this.signal?.removeEventListener("abort", this.abortListener);
		let terminated = 0;
		const survivors: SurvivingProcess[] = [];
		for (const proc of [...this.spawns]) {
			const result = await proc.terminate();
			terminated += result.terminated;
			survivors.push(...result.survivors);
		}
		this.spawns.clear();
		if (this.exitHook !== undefined) process.off("exit", this.exitHook);
		this.exitHook = undefined;
		if (this.scratchPromise !== undefined) {
			let scratch: Scratch | undefined;
			try {
				scratch = await this.scratchPromise;
			} catch {
				scratch = undefined;
			}
			if (scratch !== undefined) {
				try {
					const stragglers = await terminateOwned({ markerPrefix: `${this.id}.` }, this.graceMs);
					terminated += stragglers.terminated;
					survivors.push(...stragglers.survivors);
				} catch {
					// Process supervision unavailable: nothing was spawned on this platform.
				}
				await removeTree(scratch.root).catch(() => undefined);
			}
		}
		return { terminated, survivors };
	}
}

export function createRuntime(options: RuntimeOptions): Runtime {
	return new RuntimeImpl(options);
}
