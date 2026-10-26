// Rust and C/C++ language plans (design C1/C2): rust-analyzer, clangd and one shared CodeLLDB.
//
// Planning has no side effects beyond bounded `--version`-style probes of tools that already exist.
// Nothing is installed or written here: an `InstallPlan` is executed by `Runtime.install` (pinned,
// SHA-256-checked, atomic, idempotent) and its `entries` are merged by `applyConfig`, both only after
// the user confirmed the plan. Existing SDKs (cargo, rustc, rust-src, C/C++ compilers) are prerequisites
// that are reported, never installed: no rustup component/toolchain command and no package manager runs.
//
// Pins: every platform asset below was reviewed against the official GitHub release on 2026-10-26 and is
// identified by its published SHA-256. No upstream signature verification is claimed.
import * as fs from "node:fs";
import * as path from "node:path";
import { effectiveEntry, resolveEntryCommand } from "./config";
import { errorMessage, isWithin } from "./runtime";
import type {
	Artifact,
	BlockedPlan,
	ConfigEntry,
	ConfigKind,
	ConfigSnapshot,
	DapAdapterSettings,
	EffectiveEntry,
	FixtureCase,
	FixtureFile,
	InstallRequest,
	IntegrationPlan,
	LanguagePlan,
	LspServerSettings,
	PlanContext,
	Platform,
	Prerequisite,
	ProfileId,
	ResolvedCommand,
	Runtime,
	ToolDescription,
	ToolLaunch,
	ToolResult,
} from "./types";

// ── Pinned releases ─────────────────────────────────────────────────────────────────────────────

const REVIEWED = "2026-10-26";
const PROVENANCE = "GitHub release asset SHA-256 digest (official release; no upstream signature verified)";

/** One platform asset and the install-relative executable it provides. */
export interface NativePin {
	readonly artifact: Artifact;
	readonly executable: string;
}

/** A tool pinned to one exact version with a reviewed asset for every supported profile. */
export interface NativeRelease {
	/** Install-directory tool name (`<agentDir>/tooling/<tool>/<version>/<platform>/`). */
	readonly tool: string;
	readonly version: string;
	readonly pins: Readonly<Record<ProfileId, NativePin>>;
}

function artifact(url: string, version: string, sha256: string, format: Artifact["format"], extra: Pick<Artifact, "fileName" | "executable"> = {}): Artifact {
	return { url, version, sha256, format, provenance: PROVENANCE, reviewed: REVIEWED, ...extra };
}

const RUST_ANALYZER_BASE = "https://github.com/rust-lang/rust-analyzer/releases/download/2026-10-19/";
const CLANGD_BASE = "https://github.com/clangd/clangd/releases/download/23.1.0/";
const CODELLDB_BASE = "https://github.com/vadimcn/codelldb/releases/download/v1.12.3/";

function rustAnalyzerPin(file: string, sha256: string): NativePin {
	return {
		artifact: artifact(`${RUST_ANALYZER_BASE}${file}`, "2026-10-19", sha256, "gzip", { fileName: "rust-analyzer", executable: true }),
		executable: "rust-analyzer",
	};
}

function clangdPin(file: string, sha256: string): NativePin {
	return { artifact: artifact(`${CLANGD_BASE}${file}`, "23.1.0", sha256, "zip"), executable: "clangd_23.1.0/bin/clangd" };
}

function codelldbPin(file: string, sha256: string): NativePin {
	return { artifact: artifact(`${CODELLDB_BASE}${file}`, "1.12.3", sha256, "zip"), executable: "extension/adapter/codelldb" };
}

export const RUST_ANALYZER_RELEASE: NativeRelease = {
	tool: "rust-analyzer",
	version: "2026-10-19",
	pins: {
		"linux-x64": rustAnalyzerPin("rust-analyzer-x86_64-unknown-linux-gnu.gz", "8fde1c9dae81459f98e99eedae3654846a9166abea686306c26e57773be558da"),
		"darwin-arm64": rustAnalyzerPin("rust-analyzer-aarch64-apple-darwin.gz", "eedad08a96f7bf92afd0890463787337d17591ea2e3df216033c6bc3ccc9d802"),
		"darwin-x64": rustAnalyzerPin("rust-analyzer-x86_64-apple-darwin.gz", "bdfd46e82731a8d3502d852d28b6462c1f1c13eed0b3e76bbcf1ba839028249c"),
	},
};

/** The macOS archive is universal, so both Mac profiles pin the same asset. */
export const CLANGD_RELEASE: NativeRelease = {
	tool: "clangd",
	version: "23.1.0",
	pins: {
		"linux-x64": clangdPin("clangd-linux-23.1.0.zip", "e53b1a96196095faedb7642cf64964f7fb9ad4a0c1f00dd2c172a3d9dcbafdfd"),
		"darwin-arm64": clangdPin("clangd-mac-23.1.0.zip", "1082e6638223b785ca2daf0939f13afcd0bb95c84ee9a4bbaff4745365159253"),
		"darwin-x64": clangdPin("clangd-mac-23.1.0.zip", "1082e6638223b785ca2daf0939f13afcd0bb95c84ee9a4bbaff4745365159253"),
	},
};

/** Shared by the Rust and C/C++ plans: one immutable install, one config entry. */
export const CODELLDB_RELEASE: NativeRelease = {
	tool: "codelldb",
	version: "1.12.3",
	pins: {
		"linux-x64": codelldbPin("codelldb-linux-x64.vsix", "1cd7f386598022b51a5b93b9ffa23e812b23f519cfe1833384ec4bef4bfd1be1"),
		"darwin-arm64": codelldbPin("codelldb-darwin-arm64.vsix", "2f114a990e1b368dd1dbd33c80c0e719767af2d228391ec0df0571c957f9ac91"),
		"darwin-x64": codelldbPin("codelldb-darwin-x64.vsix", "e25cc716b94c62c07fec268ff2785d2b797245b160502baef8b9c970a0c4d8e8"),
	},
};

/** The exact immutable-install request for one release on one profile. Equal inputs give equal requests, so publication is idempotent. */
export function nativeInstallRequest(release: NativeRelease, profile: ProfileId): InstallRequest {
	const { artifact: pinned, executable } = release.pins[profile];
	return {
		tool: release.tool,
		version: release.version,
		platform: profile,
		operations: [{ type: "artifact", artifact: { ...pinned } }],
		executables: [executable],
	};
}

// ── Config entries ──────────────────────────────────────────────────────────────────────────────

/** omp's built-in rust-analyzer entry with only `command` replaced, so approving it changes where the server runs and nothing else. */
export function rustAnalyzerEntry(command: string): ConfigEntry {
	return { kind: "lsp", key: "rust-analyzer", value: rustAnalyzerValue(command) };
}

/** omp's built-in clangd entry with only `command` replaced. */
export function clangdEntry(command: string): ConfigEntry {
	return { kind: "lsp", key: "clangd", value: clangdValue(command) };
}

const RUST_ANALYZER_ARGS: readonly string[] = [];
const RUST_FILE_TYPES: readonly string[] = [".rs"];
const RUST_ROOT_MARKERS: readonly string[] = ["Cargo.toml", "rust-analyzer.toml"];
const CLANGD_ARGS: readonly string[] = ["--background-index", "--clang-tidy", "--header-insertion=iwyu"];
const CPP_FILE_TYPES: readonly string[] = [".c", ".cpp", ".cc", ".cxx", ".h", ".hpp", ".hxx", ".cu", ".cuh", ".m", ".mm"];
const CPP_ROOT_MARKERS: readonly string[] = ["compile_commands.json", "CMakeLists.txt", ".clangd", ".clang-format", "Makefile"];

function rustAnalyzerValue(command: string): LspServerSettings {
	return {
		command,
		args: [...RUST_ANALYZER_ARGS],
		fileTypes: [...RUST_FILE_TYPES],
		rootMarkers: [...RUST_ROOT_MARKERS],
		initOptions: {},
		settings: { "rust-analyzer": { checkOnSave: false } },
	};
}

function clangdValue(command: string): LspServerSettings {
	return { command, args: [...CLANGD_ARGS], fileTypes: [...CPP_FILE_TYPES], rootMarkers: [...CPP_ROOT_MARKERS] };
}

/**
 * omp's built-in codelldb entry with an absolute adapter path and the verified transport. CodeLLDB
 * v1.12.3's launcher selects stdio when neither `--port` nor `--connect` is given, so `args` is empty and
 * `connectMode` is `stdio`: omp's default `--port 0` flag and its TCP listener are deliberately not used.
 * `launchDefaults` extend omp's own with `terminal: "console"` (no external terminal) and an lldb init command
 * that keeps ASLR enabled (`disable-aslr false`), so debugging needs no permission to change address-space
 * randomisation (verified by a no-credentials public-SDK smoke on Linux; no macOS claim).
 * The same entry serves Rust and C/C++.
 */
export function codelldbEntry(command: string): ConfigEntry {
	const value: DapAdapterSettings = {
		command,
		args: [],
		languages: ["c", "cpp", "rust", "zig"],
		fileTypes: [".c", ".cc", ".cpp", ".cxx", ".rs", ".zig"],
		rootMarkers: ["Cargo.toml", "CMakeLists.txt", "Makefile", "compile_commands.json", "build.zig"],
		launchDefaults: { request: "launch", stopOnEntry: true, terminal: "console", initCommands: ["settings set target.disable-aslr false"] },
		attachDefaults: { request: "attach" },
		connectMode: "stdio",
	};
	return { kind: "dap", key: "codelldb", value };
}

// ── Probing existing tools ──────────────────────────────────────────────────────────────────────

const PROBE_MS = 30_000;
const DETAIL_CHARS = 240;

function brief(text: string): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > DETAIL_CHARS ? `${flat.slice(0, DETAIL_CHARS - 3)}...` : flat;
}

type Probed = { readonly ok: true; readonly output: string } | { readonly ok: false; readonly detail: string };

/** Runs an approved absolute executable from an owned scratch directory; any failure is a bounded detail, never a throw. */
async function probe(runtime: Runtime, executable: string, args: readonly string[]): Promise<Probed> {
	try {
		const result = await runtime.probe(executable, args, { timeoutMs: PROBE_MS, maxOutputBytes: 64 * 1024 });
		const output = result.stdout.trim() === "" ? result.stderr.trim() : result.stdout.trim();
		return { ok: true, output };
	} catch (error) {
		return { ok: false, detail: brief(errorMessage(error)) };
	}
}

function firstLine(text: string): string {
	return brief(text.split("\n")[0] ?? "");
}

function versionOf(text: string): string | undefined {
	return /\d+\.\d+(?:\.\d+)?/.exec(text)?.[0];
}

function atLeast(version: string | undefined, minimum: readonly [number, number]): boolean {
	if (version === undefined) return false;
	const parts = version.split(".").map(Number);
	const major = parts[0] ?? 0;
	const minor = parts[1] ?? 0;
	return major > minimum[0] || (major === minimum[0] && minor >= minimum[1]);
}

interface Found {
	readonly path: string;
	readonly output: string;
	readonly version: string | undefined;
}

/**
 * First of `names` that exists on PATH (outside the user's project) and runs. The `probe` outcome of
 * every candidate that did not work is kept so the remediation can say why.
 */
async function findWorking(runtime: Runtime, names: readonly string[], args: readonly string[]): Promise<{ found?: Found; problems: string[] }> {
	const problems: string[] = [];
	for (const name of names) {
		const resolved = runtime.resolveExecutable(name);
		if (resolved === undefined) continue;
		if (resolved.origin === "project-local") {
			problems.push(`${name} at ${resolved.path} is inside your project and is never run without your explicit approval`);
			continue;
		}
		const probed = await probe(runtime, resolved.path, args);
		if (!probed.ok) {
			problems.push(`${name} at ${resolved.path} did not run: ${probed.detail}`);
			continue;
		}
		return { found: { path: resolved.path, output: probed.output, version: versionOf(firstLine(probed.output)) }, problems };
	}
	return { problems };
}

function satisfied(name: string, requirement: string, found: Found): Prerequisite {
	const version = found.version ?? (firstLine(found.output) || undefined);
	return { name, requirement, satisfied: true, found: { path: found.path, ...(version === undefined ? {} : { version }) } };
}

function unsatisfied(name: string, requirement: string, remediation: string, problems: readonly string[] = []): Prerequisite {
	return { name, requirement, satisfied: false, remediation: [...problems, remediation].join(" ") };
}

const RUST_INSTALL_HINT = "Install a Rust toolchain yourself (for example with rustup from https://rustup.rs); this tool never installs SDKs.";

interface RustSdk {
	readonly cargo: Prerequisite;
	readonly rustc: Prerequisite;
	readonly rustSrc: Prerequisite;
}

/** Edition 2021 needs Cargo and rustc 1.56 or newer; rust-analyzer additionally wants the `rust-src` component for the standard library. */
async function inspectRust(runtime: Runtime): Promise<RustSdk> {
	const cargoRequirement = "cargo >= 1.56 (Rust edition 2021)";
	const rustcRequirement = "rustc >= 1.56 (Rust edition 2021)";
	const srcRequirement = "the rust-src component of the active toolchain";
	const cargoProbe = await findWorking(runtime, ["cargo"], ["--version"]);
	const rustcProbe = await findWorking(runtime, ["rustc"], ["--version"]);
	const cargo = judgeRust("cargo", cargoRequirement, cargoProbe, "Update it yourself (for example `rustup update stable`).");
	const rustc = judgeRust("rustc", rustcRequirement, rustcProbe, "Update it yourself (for example `rustup update stable`).");
	if (!rustc.satisfied || rustcProbe.found === undefined) {
		return { cargo, rustc, rustSrc: unsatisfied("rust-src", srcRequirement, "rustc is not usable, so rust-src cannot be located.") };
	}
	const sysroot = await probe(runtime, rustcProbe.found.path, ["--print", "sysroot"]);
	const root = sysroot.ok ? firstLine(sysroot.output) : "";
	if (!sysroot.ok || !path.isAbsolute(root)) {
		const why = sysroot.ok ? "rustc did not print an absolute sysroot." : sysroot.detail;
		return { cargo, rustc, rustSrc: unsatisfied("rust-src", srcRequirement, `The toolchain sysroot could not be read (${why}).`) };
	}
	const library = path.join(root, "lib", "rustlib", "src", "rust", "library");
	const marker = path.join(library, "std", "src", "lib.rs");
	if (!fs.existsSync(marker)) {
		return {
			cargo,
			rustc,
			rustSrc: unsatisfied("rust-src", srcRequirement, `${library} is missing. Add the component yourself (for example \`rustup component add rust-src\`); this tool never changes toolchains.`),
		};
	}
	return { cargo, rustc, rustSrc: { name: "rust-src", requirement: srcRequirement, satisfied: true, found: { path: library } } };
}

function judgeRust(name: string, requirement: string, result: { found?: Found; problems: string[] }, upgrade: string): Prerequisite {
	if (result.found === undefined) return unsatisfied(name, requirement, RUST_INSTALL_HINT, result.problems);
	if (!atLeast(result.found.version, [1, 56])) {
		return {
			name,
			requirement,
			satisfied: false,
			found: { path: result.found.path, ...(result.found.version === undefined ? {} : { version: result.found.version }) },
			remediation: `${name} ${result.found.version ?? "of unknown version"} is older than 1.56, which edition 2021 needs. ${upgrade}`,
		};
	}
	return satisfied(name, requirement, result.found);
}

interface CompilerSdk {
	readonly c: Prerequisite;
	readonly cpp: Prerequisite;
}

async function inspectCompiler(runtime: Runtime, name: string, candidates: readonly string[], requirement: string): Promise<Prerequisite> {
	const result = await findWorking(runtime, candidates, ["--version"]);
	if (result.found !== undefined) return satisfied(name, requirement, result.found);
	const hint = runtime.platform.supported && runtime.platform.platform.os === "darwin" ? "Run `xcode-select --install` yourself." : "Install a compiler yourself (for example `sudo apt install build-essential` on Debian or Ubuntu).";
	return unsatisfied(name, requirement, `${hint} This tool never installs SDKs.`, result.problems);
}

/** Existing C and C++ compilers; clangd needs their headers and the fixtures are built with them. */
async function inspectCompilers(runtime: Runtime): Promise<CompilerSdk> {
	return {
		c: await inspectCompiler(runtime, "cc", ["cc", "gcc", "clang"], "a C compiler (cc, gcc or clang)"),
		cpp: await inspectCompiler(runtime, "c++", ["c++", "g++", "clang++"], "a C++ compiler (c++, g++ or clang++)"),
	};
}

// ── Plan assembly ───────────────────────────────────────────────────────────────────────────────

function describe(runtime: Runtime, release: NativeRelease, name: string): ToolDescription {
	const platform = runtime.platform.supported ? runtime.platform.platform : undefined;
	if (platform === undefined) return { name, version: release.version, sources: [] };
	return {
		name,
		version: release.version,
		sources: [release.pins[platform.id].artifact.url],
		destination: runtime.installDirectory(release.tool, release.version, platform.id),
	};
}

function blocked(kind: ConfigKind, tool: ToolDescription, prerequisites: readonly Prerequisite[], status: ToolResult["status"], detail: string, notes: readonly string[] = []): BlockedPlan {
	return { kind, tool, prerequisites, notes, status: "blocked", result: { status, detail: brief(detail) } };
}

type Gate = { readonly stopped: BlockedPlan } | { readonly platform: Platform };

/** Stops a plan when the host is unsupported or an SDK prerequisite is missing; otherwise yields the profile to install for. */
function gate(runtime: Runtime, kind: ConfigKind, tool: ToolDescription, prerequisites: readonly Prerequisite[]): Gate {
	const detected = runtime.platform;
	if (!detected.supported) return { stopped: blocked(kind, tool, prerequisites, "unsupported", detected.reason) };
	const missing = prerequisites.filter(item => !item.satisfied);
	if (missing.length > 0) {
		const names = missing.map(item => item.name).join(", ");
		const detail = `Missing or unusable: ${names}. ${missing.map(item => item.remediation ?? "").join(" ")}`;
		return { stopped: blocked(kind, tool, prerequisites, "needs-sdk", detail) };
	}
	return { platform: detected.platform };
}

function stringList(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** Config files omp might also read for this key (foreign/plugin layers of unknown enablement). They can never make the entry ready. */
function unverifiedNotes(config: ConfigSnapshot, kind: ConfigKind, key: string): string[] {
	const paths = config.sources.filter(source => source.kind === kind && source.enablement === "unknown" && source.entries.has(key)).map(source => source.path);
	if (paths.length === 0) return [];
	return [`${paths.join(", ")} may also define ${kind === "lsp" ? "language server" : "debug adapter"} \`${key}\`; omp's use of them cannot be determined here, so the integration is ready only once the config check confirms the approved entry.`];
}

function pinNote(release: NativeRelease, pin: NativePin): string {
	return `Pinned ${release.tool} ${release.version}: ${pin.artifact.url} (SHA-256 ${pin.artifact.sha256}, GitHub release digest reviewed ${pin.artifact.reviewed}; no upstream signature verification is claimed).`;
}

type Configured = { readonly problem: string } | { readonly entry: EffectiveEntry; readonly command: ResolvedCommand };

/**
 * The tool an existing effective entry selects, or why it cannot be used as it is. Undefined when no entry
 * chooses a tool, so a plain install may be proposed (the config merge still refuses real conflicts).
 * Nothing here ever replaces, shadows or runs a project-supplied entry.
 */
function selectConfigured(effective: EffectiveEntry | undefined, key: string): Configured | undefined {
	if (effective === undefined) return undefined;
	const where = effective.source.path;
	if (effective.disabled) return { problem: `\`${key}\` is disabled in ${where}. Re-enable it yourself; this setup never overrides an explicit disable.` };
	if (typeof effective.value.command !== "string") return undefined;
	if (effective.projectSupplied) {
		return {
			problem: `Project configuration (${where}) defines \`${key}\` and takes precedence over user-level config, so it is neither run nor replaced by this setup. Remove or align that entry, or work from another project.`,
		};
	}
	const command = effective.command;
	if (command === undefined) {
		return { problem: `The command \`${effective.value.command}\` configured for \`${key}\` in ${where} does not resolve to an executable. Fix or remove that entry yourself; it is not replaced.` };
	}
	if (command.origin === "project-local") {
		return { problem: `The command configured for \`${key}\` in ${where} resolves to ${command.path} inside your project; running it needs your explicit approval and this setup does not run it.` };
	}
	return { entry: effective, command };
}

// ── Language servers ────────────────────────────────────────────────────────────────────────────

interface LspSpec {
	readonly key: string;
	readonly release: NativeRelease;
	readonly args: readonly string[];
	/** File types a reused entry must still cover (when it lists any). */
	readonly mustCover: readonly string[];
	readonly entry: (command: string) => ConfigEntry;
	readonly notes: readonly string[];
}

async function planLsp(context: PlanContext, spec: LspSpec, prerequisites: readonly Prerequisite[]): Promise<IntegrationPlan> {
	const { runtime, config } = context;
	const tool = describe(runtime, spec.release, spec.key);
	const gated = gate(runtime, "lsp", tool, prerequisites);
	if ("stopped" in gated) return gated.stopped;
	const notes = [...spec.notes, ...unverifiedNotes(config, "lsp", spec.key)];

	const configured = selectConfigured(effectiveEntry(config, "lsp", spec.key), spec.key);
	if (configured !== undefined) {
		if ("problem" in configured) return blocked("lsp", tool, prerequisites, "failed", configured.problem, notes);
		const { entry, command } = configured;
		const fileTypes = entry.value.fileTypes;
		const missing = Array.isArray(fileTypes) ? spec.mustCover.filter(type => !fileTypes.includes(type)) : [];
		if (missing.length > 0) {
			return blocked("lsp", tool, prerequisites, "failed", `\`${spec.key}\` in ${entry.source.path} does not cover ${missing.join(", ")}; it is not replaced. Align its fileTypes or remove the entry yourself.`, notes);
		}
		const probed = await probe(runtime, command.path, ["--version"]);
		if (!probed.ok) {
			return blocked("lsp", tool, prerequisites, "failed", `The configured ${spec.key} at ${command.path} did not run (${probed.detail}); it is not replaced. Fix or remove that entry yourself.`, notes);
		}
		const managed = isWithin(runtime.toolingRoot, command.path);
		const version = versionOf(firstLine(probed.output));
		return {
			kind: "lsp",
			status: "reuse",
			source: managed ? "managed" : "configured",
			launch: { command: command.path, args: stringList(entry.value.args) },
			tool: { name: spec.key, ...(version === undefined ? {} : { version }), sources: [] },
			prerequisites,
			entries: [],
			notes: [...notes, `Using the ${managed ? "managed" : "already configured"} ${spec.key} at ${command.path}; its configuration is left unchanged.`],
		};
	}

	const onPath = runtime.resolveExecutable(spec.key);
	const pathNotes: string[] = [];
	if (onPath?.origin === "path") {
		const probed = await probe(runtime, onPath.path, ["--version"]);
		if (probed.ok) {
			// omp resolves its built-in command through project-local bin directories first; pin the PATH tool when that would differ.
			const resolvedByOmp = resolveEntryCommand("lsp", spec.key, config.context);
			const needsEntry = resolvedByOmp?.path !== onPath.path;
			const version = versionOf(firstLine(probed.output));
			return {
				kind: "lsp",
				status: "reuse",
				source: "path",
				launch: { command: onPath.path, args: [...spec.args] },
				tool: { name: spec.key, ...(version === undefined ? {} : { version }), sources: [] },
				prerequisites,
				entries: needsEntry ? [spec.entry(onPath.path)] : [],
				notes: [
					...notes,
					`Using the existing ${spec.key} at ${onPath.path}; nothing is installed.`,
					...(needsEntry ? [`omp would otherwise resolve \`${spec.key}\` to ${resolvedByOmp?.path ?? "a different executable"}, so the entry pins this absolute path.`] : []),
				],
			};
		}
		pathNotes.push(`The ${spec.key} on PATH (${onPath.path}) did not run (${probed.detail}); the pinned release is installed instead.`);
	} else if (onPath !== undefined) {
		pathNotes.push(`The ${spec.key} at ${onPath.path} is inside your project and is never run without your explicit approval; the pinned release is installed instead.`);
	}

	const pin = spec.release.pins[gated.platform.id];
	const launch: ToolLaunch = { command: path.join(runtime.installDirectory(spec.release.tool, spec.release.version, gated.platform.id), pin.executable), args: [...spec.args] };
	return {
		kind: "lsp",
		status: "install",
		install: nativeInstallRequest(spec.release, gated.platform.id),
		launch,
		tool,
		prerequisites,
		entries: [spec.entry(launch.command)],
		notes: [...notes, ...pathNotes, pinNote(spec.release, pin)],
	};
}

// ── Shared debugger ─────────────────────────────────────────────────────────────────────────────

const CODELLDB_NOTES: readonly string[] = [
	"CodeLLDB is one shared, immutable install used by Rust and C/C++. It talks to omp over stdio (no --port, no TCP listener).",
	"Debugging needs OS permission: on Linux ptrace of your own processes (kernel.yama.ptrace_scope), on macOS Developer Tools access. When the OS denies it the debugger is reported not ready; nothing is changed on your behalf.",
];

async function planCodeLldb(context: PlanContext, prerequisites: readonly Prerequisite[]): Promise<IntegrationPlan> {
	const { runtime, config } = context;
	const tool = describe(runtime, CODELLDB_RELEASE, "codelldb");
	const gated = gate(runtime, "dap", tool, prerequisites);
	if ("stopped" in gated) return gated.stopped;
	const notes = [...CODELLDB_NOTES, ...unverifiedNotes(config, "dap", "codelldb")];

	const configured = selectConfigured(effectiveEntry(config, "dap", "codelldb"), "codelldb");
	if (configured !== undefined) {
		if ("problem" in configured) return blocked("dap", tool, prerequisites, "failed", configured.problem, notes);
		const { entry, command } = configured;
		const args = stringList(entry.value.args);
		const listens = args.some(arg => arg === "--port" || arg.startsWith("--port=") || arg === "--connect" || arg.startsWith("--connect="));
		if (entry.value.connectMode !== "stdio" || listens) {
			return blocked(
				"dap",
				tool,
				prerequisites,
				"failed",
				`\`codelldb\` in ${entry.source.path} does not use the verified stdio mode (connectMode "stdio" without --port/--connect); it is not replaced and no other debugger is substituted. Align or remove that entry yourself.`,
				notes,
			);
		}
		const probed = await probe(runtime, command.path, ["--help"]);
		if (!probed.ok) {
			return blocked("dap", tool, prerequisites, "failed", `The configured codelldb at ${command.path} did not run (${probed.detail}); it is not replaced. Fix or remove that entry yourself.`, notes);
		}
		const managed = isWithin(runtime.toolingRoot, command.path);
		return {
			kind: "dap",
			status: "reuse",
			source: managed ? "managed" : "configured",
			launch: { command: command.path, args },
			tool: { name: "codelldb", sources: [] },
			prerequisites,
			entries: [],
			notes: [...notes, `Using the ${managed ? "managed" : "already configured"} codelldb at ${command.path} in stdio mode; its configuration is left unchanged.`],
		};
	}

	// A codelldb on PATH is not reused: omp's default for it listens on a TCP port, and its version and transport cannot be verified.
	const onPath = runtime.resolveExecutable("codelldb");
	const pathNotes = onPath === undefined ? [] : [`The codelldb at ${onPath.path} is not used: its version and transport cannot be verified, and no unrelated debugger stands in for the pinned one.`];
	const pin = CODELLDB_RELEASE.pins[gated.platform.id];
	const destination = runtime.installDirectory(CODELLDB_RELEASE.tool, CODELLDB_RELEASE.version, gated.platform.id);
	const launch: ToolLaunch = { command: path.join(destination, pin.executable), args: [] };
	const present = fs.existsSync(destination) ? [`${destination} already exists; the runtime reuses it only if it is the identical verified install, and never replaces it.`] : [];
	return {
		kind: "dap",
		status: "install",
		install: nativeInstallRequest(CODELLDB_RELEASE, gated.platform.id),
		launch,
		tool,
		prerequisites,
		entries: [codelldbEntry(launch.command)],
		notes: [...notes, ...pathNotes, ...present, pinNote(CODELLDB_RELEASE, pin)],
	};
}

// ── Fixtures ────────────────────────────────────────────────────────────────────────────────────

function lines(...rows: string[]): string {
	return `${rows.join("\n")}\n`;
}

/** 1-based line of the `occurrence`th line of `content` containing `needle`; a missing needle is a programming error. */
function lineOf(content: string, needle: string, occurrence = 1): number {
	let seen = 0;
	const rows = content.split("\n");
	for (const [index, row] of rows.entries()) {
		if (!row.includes(needle)) continue;
		seen += 1;
		if (seen === occurrence) return index + 1;
	}
	throw new Error(`fixture line containing ${JSON.stringify(needle)} (#${occurrence}) not found`);
}

const UTIL_FILE = "src/util.rs";
const MAIN_FILE = "src/main.rs";
const RUST_UTIL = lines("pub fn compute_answer(a: i32, b: i32) -> i32 {", "    let answer = a * b;", "    return answer;", "}");
const RUST_MAIN = lines("mod util;", "", "fn main() {", "    std::process::exit(if util::compute_answer(6, 7) == 42 { 0 } else { 1 });", "}");
const CARGO_TOML = lines(
	"[package]",
	'name = "answer-rust"',
	'version = "0.1.0"',
	'edition = "2021"',
	"",
	"[dependencies]",
	"",
	"[profile.dev]",
	"opt-level = 0",
	"debug = true",
);

/** Rust: a no-dependency Cargo package whose `main` calls a function defined in a second module file. */
function rustFixture(cargo: string): FixtureCase {
	return {
		id: "rust",
		label: "Rust (Cargo package, debug build)",
		files: [
			{ path: "Cargo.toml", content: CARGO_TOML },
			{ path: MAIN_FILE, content: RUST_MAIN },
			{ path: UTIL_FILE, content: RUST_UTIL },
		],
		build: [{ label: "cargo build (dev profile, debug info, no optimisation, offline)", command: cargo, args: ["build", "--offline"] }],
		lsp: {
			server: "rust-analyzer",
			file: MAIN_FILE,
			line: lineOf(RUST_MAIN, "compute_answer"),
			symbol: "compute_answer",
			definition: { file: UTIL_FILE, line: lineOf(RUST_UTIL, "compute_answer") },
		},
		dap: {
			adapter: "codelldb",
			program: "target/debug/answer-rust",
			breakpoint: { file: UTIL_FILE, line: lineOf(RUST_UTIL, "return answer") },
			variable: { name: "answer", value: "42" },
		},
	};
}

/**
 * Compiles the one translation unit with debug info and no optimisation, then writes
 * compile_commands.json from the exact commands used. clangd needs an absolute `directory`, which is only
 * known inside the disposable fixture, so the file is generated there instead of being committed.
 */
function buildScript(source: string, binary: string, flags: readonly string[]): string {
	const options = [...flags, "-g", "-O0", "-fno-inline"].join(" ");
	const recorded = [...flags, "-g", "-O0", "-fno-inline", "-c", source, "-o", "main.o"].map(item => JSON.stringify(item)).join(", ");
	return `${[
		"#!/bin/sh",
		"# Fixture build: debug info, no optimisation, plus the matching compile_commands.json.",
		"set -eu",
		'compiler=$1',
		'here=$(pwd -P)',
		"newline='",
		"'",
		'case $here$compiler in',
		'  *"$newline"*) echo "refusing a path that contains a line break" >&2; exit 1 ;;',
		"esac",
		String.raw`escape() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }`,
		`"$compiler" ${options} -c ${source} -o main.o`,
		`"$compiler" ${options} main.o -o ${binary}`,
		String.raw`printf '[\n  {\n    "directory": "%s",\n    "arguments": ["%s", ${recorded}],\n    "file": ${JSON.stringify(source)}\n  }\n]\n' "$(escape "$here")" "$(escape "$compiler")" > compile_commands.json`,
	].join("\n")}\n`;
}

const C_HEADER = lines(
	"#ifndef ANSWER_H",
	"#define ANSWER_H",
	"",
	"static inline int compute_answer(int a, int b) {",
	"    int answer = a * b;",
	"    return answer;",
	"}",
	"",
	"#endif",
);
const C_MAIN = lines('#include "answer.h"', "", "int main(void) {", "    return compute_answer(6, 7) == 42 ? 0 : 1;", "}");
const CPP_HEADER = lines(
	"#pragma once",
	"",
	"namespace fixture {",
	"",
	"class Calculator {",
	"public:",
	"    int compute_answer(int a, int b) const {",
	"        const int answer = a * b;",
	"        return answer;",
	"    }",
	"};",
	"",
	"}  // namespace fixture",
);
const CPP_MAIN = lines('#include "answer.hpp"', "", "int main() {", "    const fixture::Calculator calculator;", "    return calculator.compute_answer(6, 7) == 42 ? 0 : 1;", "}");

interface NativeUnit {
	readonly id: string;
	readonly label: string;
	readonly header: FixtureFile;
	readonly source: FixtureFile;
	readonly binary: string;
	readonly flags: readonly string[];
	readonly compiler: string;
}

/** C and C++ are separate fixtures with their own sources, compiler and compilation database. */
function nativeFixture(unit: NativeUnit): FixtureCase {
	return {
		id: unit.id,
		label: unit.label,
		files: [unit.header, unit.source, { path: "build.sh", content: buildScript(unit.source.path, unit.binary, unit.flags), executable: true }],
		build: [{ label: `compile ${unit.source.path} (debug info, no optimisation) and record compile_commands.json`, command: "/bin/sh", args: ["build.sh", unit.compiler] }],
		lsp: {
			server: "clangd",
			file: unit.source.path,
			line: lineOf(unit.source.content, "compute_answer"),
			symbol: "compute_answer",
			definition: { file: unit.header.path, line: lineOf(unit.header.content, "compute_answer") },
		},
		dap: {
			adapter: "codelldb",
			program: unit.binary,
			breakpoint: { file: unit.header.path, line: lineOf(unit.header.content, "return answer") },
			variable: { name: "answer", value: "42" },
		},
	};
}

function cFixture(compiler: string): FixtureCase {
	return nativeFixture({
		id: "c",
		label: "C (one translation unit, header-defined function)",
		header: { path: "answer.h", content: C_HEADER },
		source: { path: "main.c", content: C_MAIN },
		binary: "answer-c",
		flags: [],
		compiler,
	});
}

function cppFixture(compiler: string): FixtureCase {
	return nativeFixture({
		id: "cpp",
		label: "C++ (one translation unit, class member defined in a header)",
		header: { path: "answer.hpp", content: CPP_HEADER },
		source: { path: "main.cpp", content: CPP_MAIN },
		binary: "answer-cpp",
		flags: ["-std=c++17"],
		compiler,
	});
}

// ── Entry points ────────────────────────────────────────────────────────────────────────────────

const RUST_LSP: LspSpec = {
	key: "rust-analyzer",
	release: RUST_ANALYZER_RELEASE,
	args: RUST_ANALYZER_ARGS,
	mustCover: RUST_FILE_TYPES,
	entry: rustAnalyzerEntry,
	notes: ["omp starts rust-analyzer only when the working directory itself contains Cargo.toml or rust-analyzer.toml; parent directories are not searched."],
};

const CPP_LSP: LspSpec = {
	key: "clangd",
	release: CLANGD_RELEASE,
	args: CLANGD_ARGS,
	mustCover: [".c", ".cpp"],
	entry: clangdEntry,
	notes: [
		"One clangd serves C and C++. It needs a compile_commands.json (or the other root markers) in the working directory itself, produced by your build system; this setup never creates one in your project.",
	],
};

function pathOf(prerequisite: Prerequisite, fallback: string): string {
	return prerequisite.found?.path ?? fallback;
}

/** Rust: rust-analyzer (reused when present, else pinned) and the shared CodeLLDB, both over the existing toolchain. */
export async function planRust(context: PlanContext): Promise<LanguagePlan> {
	const sdk = await inspectRust(context.runtime);
	const lsp = await planLsp(context, RUST_LSP, [sdk.cargo, sdk.rustc, sdk.rustSrc]);
	// rust-src only helps the language server; debugging a compiled fixture needs just cargo and rustc.
	const dap = await planCodeLldb(context, [sdk.cargo, sdk.rustc]);
	return { language: "rust", lsp, dap, fixtures: [rustFixture(pathOf(sdk.cargo, "cargo"))], projectLocalExecutables: [] };
}

/** C/C++: clangd (reused when present, else pinned) and the shared CodeLLDB, with separate C and C++ fixtures. */
export async function planCpp(context: PlanContext): Promise<LanguagePlan> {
	const sdk = await inspectCompilers(context.runtime);
	const lsp = await planLsp(context, CPP_LSP, [sdk.c, sdk.cpp]);
	const dap = await planCodeLldb(context, [sdk.c, sdk.cpp]);
	return {
		language: "cpp",
		lsp,
		dap,
		fixtures: [cFixture(pathOf(sdk.c, "cc")), cppFixture(pathOf(sdk.cpp, "c++"))],
		projectLocalExecutables: [],
	};
}

