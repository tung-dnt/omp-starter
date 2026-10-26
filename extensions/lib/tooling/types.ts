// Shared contracts for guided language tooling (design C1/C2).
//
// `runtime.ts` implements the safe process/download/install runtime and `config.ts` the static
// LSP/DAP configuration inspection plus conflict-aware merge. Language plans, the verifier and
// the wizard depend only on the types in this file. Nothing here needs an omp SDK, a provider
// login or credentials, and nothing is installed or executed until a confirmed plan says so.
import type { Readable, Writable } from "node:stream";

export const LANGUAGE_IDS = ["javascript", "python", "go", "rust", "cpp"] as const;
export type LanguageId = (typeof LANGUAGE_IDS)[number];

/** The two independently verified integrations: language server (`lsp.json`) and debug adapter (`dap.json`). */
export type IntegrationKind = "lsp" | "dap";

/** Supported OS/architecture profiles. Anything else is reported as unsupported, never installed for. */
export type ProfileId = "darwin-arm64" | "darwin-x64" | "linux-x64";

export interface Platform {
	readonly os: "darwin" | "linux";
	readonly arch: "arm64" | "x64";
	readonly id: ProfileId;
}

export type PlatformDetection =
	| { readonly supported: true; readonly platform: Platform }
	| { readonly supported: false; readonly reason: string };

/** Raw host facts; injectable so platform rules are testable on any machine. */
export interface PlatformInput {
	/** `process.platform` value. */
	readonly platform: string;
	/** `process.arch` value. */
	readonly arch: string;
	/** Contents of `/etc/os-release` (Linux only); absent when unreadable. */
	readonly osRelease?: string;
	/** True when the Linux libc is musl rather than glibc. */
	readonly musl?: boolean;
}

/** An argv command. Never interpreted by a shell. */
export interface Command {
	command: string;
	args: string[];
}

/** How omp launches a language server or debug adapter. */
export type ToolLaunch = Command;

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

// ── Outcomes (shared with the persisted state in C3) ────────────────────────────────────────────

export type ToolStatus = "ready" | "unverified" | "missing" | "needs-sdk" | "unsupported" | "failed" | "skipped";

export interface ToolResult {
	status: ToolStatus;
	/** Bounded, user-facing explanation. Never contains secrets, raw source or unbounded subprocess output. */
	detail: string;
	command?: Command;
}

/** LSP and DAP outcomes stay independent: one passing never labels the other ready. */
export interface IntegrationResult {
	lsp: ToolResult;
	dap: ToolResult;
}

// ── Runtime (C1) ────────────────────────────────────────────────────────────────────────────────

export type RuntimeErrorCode =
	| "invalid-argument"
	| "unsupported-platform"
	| "disposed"
	| "aborted"
	| "timeout"
	| "spawn"
	| "executable-not-found"
	| "unapproved"
	| "cwd"
	| "exit"
	| "cleanup-failed"
	| "destination"
	| "collision"
	| "busy"
	| "download"
	| "integrity"
	| "archive"
	| "install";

export interface RunOptions {
	/** Directory the command runs in. Must be a runtime-owned directory (see `Runtime.workDir`); the user's project is refused. */
	cwd: string;
	/** Variables layered over the allowlisted child environment. The ownership marker cannot be overridden. */
	env?: Readonly<Record<string, string>>;
	signal?: AbortSignal;
	/** 1..300000 milliseconds; defaults to the 300 second ceiling. */
	timeoutMs?: number;
	/** Per-stream capture cap in bytes (default 1 MiB). Output past the cap is dropped and flagged, not buffered. */
	maxOutputBytes?: number;
	/** Allow executing a project-local executable (inside the user's project) after the user was shown its path. */
	approvedProjectLocal?: boolean;
}

export interface RunResult {
	readonly stdout: string;
	readonly stderr: string;
	/** True when the stream exceeded `maxOutputBytes`; the captured text is its leading part. */
	readonly stdoutTruncated: boolean;
	readonly stderrTruncated: boolean;
	readonly durationMs: number;
}

export interface SpawnOptions {
	cwd: string;
	env?: Readonly<Record<string, string>>;
	signal?: AbortSignal;
	/** `"pipe"` exposes `stdin` for protocol traffic; default `"ignore"`. */
	stdin?: "ignore" | "pipe";
	approvedProjectLocal?: boolean;
}

export interface ProbeOptions {
	env?: Readonly<Record<string, string>>;
	signal?: AbortSignal;
	timeoutMs?: number;
	maxOutputBytes?: number;
	approvedProjectLocal?: boolean;
}

export interface ExitStatus {
	readonly code: number | null;
	readonly signal: string | null;
	/** Set when the process could not be started at all. */
	readonly error?: string;
}

export interface SurvivingProcess {
	readonly pid: number;
	readonly ppid: number;
}

export interface CleanupResult {
	/** Owned processes that were signalled and are gone. */
	readonly terminated: number;
	/** Owned processes still alive after TERM, the 2 second grace period and KILL. A non-empty list is a failed cleanup. */
	readonly survivors: readonly SurvivingProcess[];
}

/**
 * A child started by the runtime. Every spawn carries an ownership marker in its environment and a
 * recorded PID/start identity, so cleanup finds exactly its own processes, including detached
 * descendants, and never matches by executable name. Cooperative shutdown (DAP `terminate`, LSP
 * `shutdown`) is the caller's job and happens before `terminate()`.
 */
export interface OwnedProcess {
	/** 0 when the process could not be started (see `exited`). */
	readonly pid: number;
	readonly marker: string;
	readonly stdin: Writable | null;
	readonly stdout: Readable | null;
	readonly stderr: Readable | null;
	/** Never rejects; a start failure resolves with `error` set. */
	readonly exited: Promise<ExitStatus>;
	/** SIGTERM to owned processes, wait at most the grace period (2 s), then SIGKILL survivors. Idempotent. */
	terminate(): Promise<CleanupResult>;
}

export interface ResolveOptions {
	/** Also look in omp's project-local bin directories (`node_modules/.bin`, `.venv/bin`, ...) before PATH. Default false. */
	projectLocal?: boolean;
}

export interface ResolvedExecutable {
	readonly path: string;
	readonly origin: "path" | "project-local";
}

/** A runtime-owned temporary directory; removed by `remove()` and, at the latest, by `Runtime.dispose()`. */
export interface WorkDir {
	readonly path: string;
	remove(): Promise<void>;
}

export type ArchiveFormat = "zip" | "tar.gz" | "gzip";

export interface ArchiveLimits {
	/** Maximum archive file size in bytes. */
	readonly compressedBytes: number;
	/** Maximum total expanded bytes of all regular files. */
	readonly expandedBytes: number;
	/** Maximum number of entries (files, directories, symlinks). */
	readonly entries: number;
}

export interface ArchiveEntry {
	/** Normalized relative POSIX path. */
	readonly path: string;
	readonly type: "file" | "directory" | "symlink";
	/** Expanded size for files; 0 otherwise. */
	readonly size: number;
	/** Sanitized permission bits: files 0755 when any execute bit was set else 0644, directories 0755. */
	readonly mode: number;
	/** Symlink target (relative, resolving inside the extraction root). */
	readonly target?: string;
}

export interface ArchiveListing {
	readonly format: ArchiveFormat;
	readonly entries: readonly ArchiveEntry[];
	readonly compressedBytes: number;
	readonly expandedBytes: number;
}

/** A pinned download. Only official HTTPS artifacts whose SHA-256 was reviewed are installable. */
export interface Artifact {
	/** `https:` URL on an approved host (GitHub release hosts by default). */
	readonly url: string;
	readonly version: string;
	/** Lower-case hex SHA-256 of the downloaded file, validated before any extraction. */
	readonly sha256: string;
	readonly format: ArchiveFormat;
	/** Where the digest came from (for example "GitHub release asset digest"). */
	readonly provenance: string;
	/** ISO date (YYYY-MM-DD) on which the pin was reviewed. */
	readonly reviewed: string;
	/** `gzip` only: name of the single extracted file. */
	readonly fileName?: string;
	/** `gzip` only: extract the file executable (0755) instead of 0644. */
	readonly executable?: boolean;
}

export type ArtifactRecord = Pick<Artifact, "url" | "version" | "sha256" | "format" | "provenance" | "reviewed">;

/** Placeholder replaced by the absolute path of the directory that becomes the install destination. */
export const INSTALL_DIR_TOKEN = "@INSTALL_DIR@";

/** Download, verify, validate and safely extract a pinned archive into `into` (relative to the install directory). */
export interface ArtifactOperation {
	readonly type: "artifact";
	readonly artifact: Artifact;
	readonly into?: string;
}

/** Materialize committed content (for example a lock file) inside the install directory. */
export interface WriteFileOperation {
	readonly type: "write-file";
	readonly path: string;
	readonly content: string;
	readonly executable?: boolean;
}

/**
 * Run an argv command with the allowlisted installer environment. `command`, `args` and `env`
 * values may contain `INSTALL_DIR_TOKEN`. `cwd` is relative to the install directory.
 */
export interface RunOperation {
	readonly type: "run";
	readonly command: string;
	readonly args: readonly string[];
	readonly cwd?: string;
	readonly env?: Readonly<Record<string, string>>;
	/** 1..300000 milliseconds; defaults to the 300 second installer ceiling. */
	readonly timeoutMs?: number;
}

export type InstallOperation = ArtifactOperation | WriteFileOperation | RunOperation;

/** An immutable, versioned user-local install: `<agentDir>/tooling/<tool>/<version>/<platform>/`. */
export interface InstallRequest {
	/** Tool identifier (`[A-Za-z0-9][A-Za-z0-9._+-]*`), for example `gopls` or `codelldb`. */
	readonly tool: string;
	/** Exact pinned version. */
	readonly version: string;
	readonly operations: readonly InstallOperation[];
	/** Install-relative executable files that must exist (and be executable) before the install is published. */
	readonly executables?: readonly string[];
	/** Defaults to the host profile. */
	readonly platform?: ProfileId;
}

export interface InstallManifest {
	readonly schema: 1;
	readonly tool: string;
	readonly version: string;
	readonly platform: ProfileId;
	/** SHA-256 of the canonical request; a different recipe for the same version never silently reuses the directory. */
	readonly digest: string;
	readonly artifacts: readonly ArtifactRecord[];
	readonly executables: readonly string[];
	readonly installedAt: string;
}

export interface InstallResult {
	/** `reused` means an identical install was already published and nothing ran. */
	readonly status: "installed" | "reused";
	readonly destination: string;
	readonly manifest: InstallManifest;
}

export interface InstallOptions {
	signal?: AbortSignal;
	/** Receives short progress messages for the wizard's status line. */
	onProgress?: (message: string) => void;
}

export interface RuntimeOptions {
	/** The active native omp agent directory. Installs go to `<agentDir>/tooling/...` and nowhere else. */
	agentDir: string;
	/** The user's project directory. Used for static inspection only: never as a child's working directory. */
	cwd: string;
	/** Aborting cancels every operation and terminates all owned processes. */
	signal?: AbortSignal;
	/** Parent environment the allowlist is applied to (default `process.env`). */
	env?: Readonly<Record<string, string | undefined>>;
	/** Network transport (default global `fetch`); injectable at this boundary for offline tests. */
	fetch?: typeof fetch;
	/** Hosts artifacts may be fetched from, redirects included. Default: GitHub release hosts. */
	allowedHosts?: readonly string[];
	/** TERM-to-KILL grace period in milliseconds (default and contract value: 2000). */
	killGraceMs?: number;
	/** Platform facts (default: the host). */
	platform?: PlatformInput;
	/** Archive limits (default: 200 MiB compressed, 1 GiB expanded, 20,000 entries). */
	archiveLimits?: ArchiveLimits;
}

export interface Runtime {
	readonly agentDir: string;
	readonly cwd: string;
	/** `<agentDir>/tooling`. Created on first use. */
	readonly toolingRoot: string;
	readonly platform: PlatformDetection;
	/** Destination directory for a versioned install; pure path arithmetic, nothing is created. */
	installDirectory(tool: string, version: string, platform?: ProfileId): string;
	/** Static lookup (no execution). Bare names only; relative PATH entries are ignored. */
	resolveExecutable(name: string, options?: ResolveOptions): ResolvedExecutable | undefined;
	/**
	 * Run an approved executable/version probe by absolute path from a fresh owned temporary cwd with
	 * the allowlisted environment (GOTOOLCHAIN=local, RUSTUP_AUTO_INSTALL=0, ...). Never runs in the user's project.
	 */
	probe(executable: string, args: readonly string[], options?: ProbeOptions): Promise<RunResult>;
	/** Run an argv command to completion; throws a `RuntimeError` on non-zero exit, timeout, cancellation or failed cleanup. */
	run(command: string, args: readonly string[], options: RunOptions): Promise<RunResult>;
	/** Start a long-lived owned child (for example an omp RPC helper) whose whole tree the runtime can terminate. */
	spawn(command: string, args: readonly string[], options: SpawnOptions): Promise<OwnedProcess>;
	workDir(label: string): Promise<WorkDir>;
	/** Pinned, integrity-checked, atomically published user-local install. Never replaces an existing directory. */
	install(request: InstallRequest, options?: InstallOptions): Promise<InstallResult>;
	/** Terminate every owned process and remove every owned directory. Idempotent. */
	dispose(): Promise<CleanupResult>;
}

// ── Configuration (C2) ──────────────────────────────────────────────────────────────────────────

export type ConfigKind = IntegrationKind;

/** omp server settings (`lsp.json`). Unknown fields pass through untouched. */
export interface LspServerSettings {
	command: string;
	args?: string[];
	fileTypes?: string[];
	rootMarkers?: string[];
	languageId?: string;
	initOptions?: JsonObject;
	settings?: JsonObject;
	disabled?: boolean;
	[field: string]: JsonValue | undefined;
}

/** omp debug adapter settings (`dap.json`). Unknown fields pass through untouched. */
export interface DapAdapterSettings {
	command: string;
	args?: string[];
	languages?: string[];
	fileTypes?: string[];
	rootMarkers?: string[];
	launchDefaults?: JsonObject;
	attachDefaults?: JsonObject;
	connectMode?: "stdio" | "socket" | "tcp";
	acceptsDirectoryProgram?: boolean;
	[field: string]: JsonValue | undefined;
}

/** One proposed entry: its integration kind, canonical key (for example `gopls`, `codelldb`) and exact value. */
export type ConfigEntry =
	| { readonly kind: "lsp"; readonly key: string; readonly value: LspServerSettings }
	| { readonly kind: "dap"; readonly key: string; readonly value: DapAdapterSettings };

/** Entries the user confirmed. Nothing outside the proposal is ever written. */
export interface ConfigProposal {
	readonly entries: readonly ConfigEntry[];
}

export type ForeignProvider = "claude" | "codex" | "gemini";

export interface ConfigContext {
	/** The user's project directory (omp's working directory). Project sources are read statically from here, never from ancestors. */
	readonly cwd: string;
	/** Directory omp reads user-level `lsp.*`/`dap.*` from (`~/.omp/agent` by default). It is the only place written. */
	readonly agentDir: string;
	/** Home directory (default `os.homedir()`). */
	readonly home?: string;
	/** Environment; only `CLAUDE_CONFIG_DIR` and `PATH` are read (default `process.env`). */
	readonly env?: Readonly<Record<string, string | undefined>>;
	/**
	 * Which foreign user config directories omp has opted in. omp keeps that in its own settings, which this
	 * module does not read, so an unlisted provider is treated as possibly effective rather than ignored.
	 */
	readonly foreignUserSources?: Readonly<Partial<Record<ForeignProvider, boolean>>>;
}

export interface ResolvedConfigContext extends ConfigContext {
	readonly home: string;
	readonly claudeDir: string;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly foreignUserSources: Readonly<Partial<Record<ForeignProvider, boolean>>>;
}

/** Where a config file sits in omp's precedence ladder. */
export type ConfigScope = "cwd-root" | "project-dir" | "native-user" | "foreign-user" | "home";

export type ConfigSourceState = "ok" | "invalid" | "unreadable" | "not-regular" | "too-large";

export type ConfigEntryValue = Readonly<Record<string, unknown>>;

/** One existing candidate config file. */
export interface ConfigSource {
	readonly kind: ConfigKind;
	readonly path: string;
	/** Resolved path (symlinks followed); undefined when it cannot be resolved. */
	readonly realPath?: string;
	readonly scope: ConfigScope;
	/** `omp` for native locations, otherwise the foreign provider; undefined for cwd-root and home. */
	readonly provider?: "omp" | ForeignProvider;
	readonly format: "json" | "yaml";
	/** Precedence rank; the higher rank wins, exactly as in omp. */
	readonly rank: number;
	/** False for a foreign source the caller said omp has not opted in; it is listed but inert. */
	readonly enabled: boolean;
	readonly symlink: boolean;
	readonly state: ConfigSourceState;
	readonly detail?: string;
	readonly shape?: "wrapped" | "flat";
	/** SHA-256 of the file bytes (absent when unreadable). */
	readonly sha256?: string;
	/** Server/adapter key to its raw entry, for entries that are objects. Empty unless `state` is `ok`. */
	readonly entries: ReadonlyMap<string, ConfigEntryValue>;
}

/** The native JSON file entries are merged into. */
export interface ConfigTarget {
	readonly kind: ConfigKind;
	/** An existing native JSON variant, or the new `<agentDir>/lsp.json` / `dap.json`. */
	readonly path: string;
	readonly exists: boolean;
	readonly sha256?: string;
	readonly shape: "wrapped" | "flat" | "new";
	readonly rank: number;
	/** Set when the file must not be touched; entries for this kind are then refused. */
	readonly problem?: { readonly code: "invalid" | "symlink" | "not-regular" | "unreadable"; readonly detail: string };
}

export interface ConfigIssue {
	readonly kind: ConfigKind;
	readonly path: string;
	readonly detail: string;
}

export interface ConfigSnapshot {
	readonly context: ResolvedConfigContext;
	/** Existing candidate files, highest precedence first. */
	readonly sources: readonly ConfigSource[];
	readonly targets: Readonly<Record<ConfigKind, ConfigTarget>>;
	/** Files omp ignores (invalid, unreadable, not regular files). Informational unless they are the target. */
	readonly issues: readonly ConfigIssue[];
	/** Files that could not be inspected although omp would read them (for example YAML without a parser, or oversized files): shadowing cannot be ruled out. */
	readonly unresolved: readonly ConfigIssue[];
	/** Disclosures about what the static inspection does not cover. */
	readonly notes: readonly string[];
	/** Content fingerprint of every candidate path; `applyConfig` refuses to write if it changed. */
	readonly digest: string;
}

export interface ResolvedCommand {
	readonly path: string;
	readonly origin: "absolute" | "project-local" | "path";
}

/** What omp would use for a key, computed statically (no program is started). */
export interface EffectiveEntry {
	readonly kind: ConfigKind;
	readonly key: string;
	/** Shallow merge of every enabled layer in omp's order (omp's built-in defaults are not included). */
	readonly value: ConfigEntryValue;
	readonly layers: readonly { readonly source: ConfigSource; readonly value: ConfigEntryValue }[];
	/** Highest-precedence source defining the key. */
	readonly source: ConfigSource;
	/** True when any layer comes from the project (cwd root or project config directory): executing it needs consent. */
	readonly projectSupplied: boolean;
	readonly disabled: boolean;
	/** Executable omp would resolve for `value.command`; undefined when it does not resolve. */
	readonly command?: ResolvedCommand;
}

export type ApplyStatus = "applied" | "unchanged" | "conflict" | "failed";

export interface RootMatch {
	readonly cwd: string;
	readonly markers: readonly string[];
	/** omp starts a language server only when the working directory itself holds a root marker (parents are not searched). */
	readonly matches: boolean;
}

export interface ApplyOutcome {
	readonly kind: ConfigKind;
	readonly key: string;
	/** `applied` and `unchanged` both mean the approved entry is effective; `conflict` and `failed` mean it is not. */
	readonly status: ApplyStatus;
	/** Actionable explanation; never replaces or hides existing configuration. */
	readonly detail: string;
	/** Native file written or inspected. */
	readonly path?: string;
	/** Other config files involved in a conflict. */
	readonly conflictsWith?: readonly string[];
	/** Language servers only, for `applied` and `unchanged` entries whose root markers are known. */
	readonly rootMatch?: RootMatch;
}

export interface ApplyResult {
	readonly outcomes: readonly ApplyOutcome[];
	/** Fresh inspection after the merge; pass it to the next `applyConfig`. */
	readonly snapshot: ConfigSnapshot;
}

// ── Language plans (C1/C2) ──────────────────────────────────────────────────────────────────────

/** An existing SDK, interpreter or utility a tool needs. Prerequisites are reported, never installed. */
export interface Prerequisite {
	/** For example `node`, `go`, `cargo`, `cc`. */
	readonly name: string;
	/** Human requirement, for example "Node.js >= 22.22.2". */
	readonly requirement: string;
	readonly satisfied: boolean;
	readonly found?: { readonly path: string; readonly version?: string };
	/** Manual OS-level action for the user; the runtime never runs it. */
	readonly remediation?: string;
}

export interface ToolDescription {
	readonly name: string;
	readonly version?: string;
	/** Upstream sources shown at consent: release URLs, registry coordinates. */
	readonly sources: readonly string[];
	/** Absolute destination when something will be installed. */
	readonly destination?: string;
}

export interface PlanContext {
	readonly runtime: Runtime;
	readonly config: ConfigSnapshot;
}

interface IntegrationPlanBase {
	readonly kind: IntegrationKind;
	readonly tool: ToolDescription;
	readonly prerequisites: readonly Prerequisite[];
	/** Bounded user-facing disclosures (shared adapters, loopback ports, root-marker limits). */
	readonly notes: readonly string[];
}

/** A compatible tool is already available: nothing is installed, and `entries` is empty unless config must still be added. */
export interface ReusePlan extends IntegrationPlanBase {
	readonly status: "reuse";
	readonly launch: ToolLaunch;
	readonly source: "configured" | "project-local" | "path" | "managed";
	readonly entries: readonly ConfigEntry[];
}

/** Install the pinned tool user-locally, then merge `entries`. Executes only after the plan is confirmed. */
export interface InstallPlan extends IntegrationPlanBase {
	readonly status: "install";
	readonly install: InstallRequest;
	readonly launch: ToolLaunch;
	readonly entries: readonly ConfigEntry[];
}

/** Not installable here: missing SDK, unsupported profile, conflicting configuration, or similar. */
export interface BlockedPlan extends IntegrationPlanBase {
	readonly status: "blocked";
	readonly result: ToolResult;
}

export type IntegrationPlan = ReusePlan | InstallPlan | BlockedPlan;

export interface FixtureFile {
	/** Fixture-relative path. */
	readonly path: string;
	readonly content: string;
	readonly executable?: boolean;
}

/** A compile/materialization step run inside the disposable fixture directory with the existing SDK. */
export interface FixtureCommand {
	readonly label: string;
	readonly command: string;
	readonly args: readonly string[];
	/** Fixture-relative working directory (default: the fixture root). */
	readonly cwd?: string;
	readonly env?: Readonly<Record<string, string>>;
	readonly timeoutMs?: number;
}

/**
 * Cross-file definition lookup through omp's `lsp` tool (`action: "definition"`). That tool takes a
 * file, a 1-based line and a `symbol` that locates the column on the line; it has no character
 * parameter and no server parameter, and for project-aware servers it rejects a `line` without `symbol`.
 */
export interface LspExpectation {
	/**
	 * Key of the configured server expected to answer. The `lsp` tool routes by file type and cannot be
	 * told which server to use, so verifiers check which server answered (for example the server name in
	 * the result details) instead of passing this to the tool.
	 */
	readonly server: string;
	/** Fixture-relative file holding the reference to resolve. */
	readonly file: string;
	/** 1-based line of the reference. */
	readonly line: number;
	/**
	 * Text on `line` that locates the column: a bare identifier matches on identifier boundaries and
	 * anything else as a substring. `name#N` selects the Nth (1-based) occurrence on that line.
	 */
	readonly symbol: string;
	/** Where the definition must resolve; `line` is 1-based. */
	readonly definition: { readonly file: string; readonly line: number };
}

/** Launch, stop at a breakpoint, read `variable` from a real scope, terminate. Lines are 1-based. */
export interface DapExpectation {
	/** Adapter key to select explicitly, so an unrelated debugger cannot mask a failed integration. */
	readonly adapter: string;
	/** Fixture-relative launch target (a file, a compiled binary or a package directory). */
	readonly program: string;
	readonly cwd?: string;
	readonly args?: readonly string[];
	readonly breakpoint: { readonly file: string; readonly line: number };
	readonly variable: { readonly name: string; readonly value: string };
}

/** One disposable fixture with both expectations (for example `javascript`, `typescript`, `c`, `cpp`). */
export interface FixtureCase {
	readonly id: string;
	readonly label: string;
	readonly files: readonly FixtureFile[];
	readonly build?: readonly FixtureCommand[];
	readonly lsp: LspExpectation;
	readonly dap: DapExpectation;
}

/** What one language group will do, decided without side effects. Consent happens before anything executes. */
export interface LanguagePlan {
	readonly language: LanguageId;
	readonly lsp: IntegrationPlan;
	readonly dap: IntegrationPlan;
	readonly fixtures: readonly FixtureCase[];
	/** Project-local executable paths that would run if the user approves them; disclosed before any run. */
	readonly projectLocalExecutables: readonly string[];
}
