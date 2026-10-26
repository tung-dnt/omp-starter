// Managed language tools: JavaScript/TypeScript, Python and Go (design C1/C2).
//
// Each `plan*` function decides, without side effects, what one language group needs: it inspects
// effective omp configuration statically, runs only bounded version probes from owned temporary
// directories, and returns exact pins, install operations, proposed config entries and the
// disposable fixtures the verifier later exercises. Nothing is installed or written here: the
// returned `InstallPlan`s run through `Runtime.install` only after the user confirmed them, and
// SDKs (Node, TypeScript, CPython, Go) are prerequisites that are reported, never installed.
//
// Detection order for every integration: effective configured entry -> approved project-local tool
// -> compatible tool on PATH -> pinned user-local install. LSP and DAP plans never depend on each
// other, so one can be ready while the other is blocked.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { effectiveEntry } from "./config";
import { errorMessage, INSTALL_MANIFEST_FILE, isExecutableFile, isRecord, RuntimeError, sha256Hex } from "./runtime";
import type {
	Artifact,
	BlockedPlan,
	Command,
	ConfigEntry,
	ConfigSnapshot,
	FixtureCase,
	InstallPlan,
	InstallRequest,
	IntegrationKind,
	IntegrationPlan,
	JsonObject,
	LanguagePlan,
	PlanContext,
	PlatformDetection,
	Prerequisite,
	ProfileId,
	ReusePlan,
	Runtime,
	ToolDescription,
	ToolStatus,
} from "./types";
import { INSTALL_DIR_TOKEN } from "./types";

// ── Pins (reviewed 2026-10-26) ──────────────────────────────────────────────────────────────────

const REVIEWED = "2026-10-26";

/** typescript-language-server has no runtime dependencies, so its lock holds this one package and never a TypeScript compiler. */
const TLS_VERSION = "6.0.2";
const TLS_PACKAGE_JSON = `${JSON.stringify(
	{ name: "omp-starter-typescript-language-server", version: "0.0.0", private: true, dependencies: { "typescript-language-server": TLS_VERSION } },
	null,
	2,
)}\n`;

const JS_DEBUG_VERSION = "1.140.0";
const JS_DEBUG_ARTIFACT: Artifact = {
	url: `https://github.com/microsoft/vscode-js-debug/releases/download/v${JS_DEBUG_VERSION}/js-debug-dap-v${JS_DEBUG_VERSION}.tar.gz`,
	version: `v${JS_DEBUG_VERSION}`,
	sha256: "27dab92937ec1ab35821ae955aac867544fe06a1b6307229049f2d789af10968",
	format: "tar.gz",
	provenance: "GitHub release asset digest (microsoft/vscode-js-debug); the release publishes no signature or checksum file",
	reviewed: REVIEWED,
};
/** The server file inside the archive. It is data for `node` (mode 0644), never an executable. */
const JS_DEBUG_SERVER = "js-debug/src/dapDebugServer.js";

const PYLSP_VERSION = "1.15.0";
const DEBUGPY_VERSION = "1.8.22";

const GOPLS_VERSION = "v0.24.0";
const DELVE_VERSION = "1.27.2";

function delveArtifact(platform: string, sha256: string): Artifact {
	return {
		url: `https://github.com/go-delve/delve/releases/download/v${DELVE_VERSION}/dlv_${DELVE_VERSION}_${platform}.tar.gz`,
		version: `v${DELVE_VERSION}`,
		sha256,
		format: "tar.gz",
		provenance: "GitHub release asset digest (go-delve/delve); cosign signatures are published but not verified here",
		reviewed: REVIEWED,
	};
}

const DELVE_ARTIFACTS: Readonly<Record<ProfileId, Artifact>> = {
	"linux-x64": delveArtifact("linux_amd64", "30783eb68dc1598d965491cc97762270cd63ce13f09d0cac22faa7e3eafc1b9c"),
	"darwin-x64": delveArtifact("darwin_amd64", "66992990307bd0328994960df0cbfa34ecfb16e9cd32f5cf6c83c34912e59cc3"),
	"darwin-arm64": delveArtifact("darwin_arm64", "c32fc68e11ff3820ba267ab12c96fa68e3804319f807fc5db4fba3b9d868df26"),
};

// ── Versions ────────────────────────────────────────────────────────────────────────────────────

interface Version {
	readonly major: number;
	readonly minor: number;
	readonly patch: number;
}

function version(major: number, minor: number, patch: number): Version {
	return { major, minor, patch };
}

/** First `x.y[.z]` in the text: `v24.22.0`, `Version 5.9.3`, `go version go1.27.2 linux/amd64`, `Version: 1.27.2`. */
function parseVersion(output: string): Version | undefined {
	const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(output);
	return match === null ? undefined : version(Number(match[1]), Number(match[2]), Number(match[3] ?? 0));
}

function atLeast(actual: Version, minimum: Version): boolean {
	if (actual.major !== minimum.major) return actual.major > minimum.major;
	if (actual.minor !== minimum.minor) return actual.minor > minimum.minor;
	return actual.patch >= minimum.patch;
}

function show(value: Version): string {
	return `${value.major}.${value.minor}.${value.patch}`;
}

const NODE_MINIMUM = version(22, 22, 2);
const NPM_MINIMUM = version(7, 0, 0);
const GO_MINIMUM = version(1, 27, 0);
const PYTHON_MINIMUM = version(3, 10, 0);
const PYTHON_MAXIMUM_MINOR = 14;
const PYTHON_RANGE = `${PYTHON_MINIMUM.major}.${PYTHON_MINIMUM.minor}-3.${PYTHON_MAXIMUM_MINOR}`;

// ── Plan context ────────────────────────────────────────────────────────────────────────────────

/** Version probes are quick; the 300 second SDK ceiling would only hide a hung tool. */
const VERSION_TIMEOUT_MS = 30_000;
const VERSION_OUTPUT_BYTES = 64 * 1024;
const DETAIL_CHARS = 600;

export interface ManagedPlanOptions {
	/**
	 * Absolute paths of project-local executables the user approved to run, exactly as an earlier plan listed them in
	 * `projectLocalExecutables`. Anything not listed is never executed: it is only disclosed.
	 */
	readonly approvedProjectLocal?: readonly string[];
}

interface Ctx {
	readonly runtime: Runtime;
	readonly config: ConfigSnapshot;
	readonly approved: ReadonlySet<string>;
	/** Project-local executables that exist and would need approval; becomes `LanguagePlan.projectLocalExecutables`. */
	readonly disclosed: Set<string>;
}

function makeCtx(context: PlanContext, options: ManagedPlanOptions): Ctx {
	return {
		runtime: context.runtime,
		config: context.config,
		approved: new Set((options.approvedProjectLocal ?? []).map(entry => path.resolve(entry))),
		disclosed: new Set(),
	};
}

function bound(message: string): string {
	const flat = message.replace(/\s+/g, " ").trim();
	return flat.length > DETAIL_CHARS ? `${flat.slice(0, DETAIL_CHARS - 3)}...` : flat;
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function describeTool(name: string, toolVersion: string | undefined, sources: string[], destination?: string): ToolDescription {
	return {
		name,
		...(toolVersion === undefined ? {} : { version: toolVersion }),
		sources,
		...(destination === undefined ? {} : { destination }),
	};
}

// ── Probing ─────────────────────────────────────────────────────────────────────────────────────

type Probe =
	| { readonly ok: true; readonly version: Version }
	| { readonly ok: false; readonly reason: "unapproved" | "failed"; readonly detail: string };

function unapprovedProbe(executable: string): Probe {
	return { ok: false, reason: "unapproved", detail: `${executable} is inside your project and needs your approval before it can run` };
}

/**
 * Runs one version probe by absolute path from an owned temporary directory. A project-local executable is only
 * executed after the user approved that exact path; otherwise it is disclosed and nothing runs.
 */
async function probeVersion(ctx: Ctx, executable: string, args: readonly string[], projectLocal: boolean): Promise<Probe> {
	const approved = ctx.approved.has(path.resolve(executable));
	if (projectLocal && !approved) {
		ctx.disclosed.add(executable);
		return unapprovedProbe(executable);
	}
	try {
		const result = await ctx.runtime.probe(executable, args, {
			timeoutMs: VERSION_TIMEOUT_MS,
			maxOutputBytes: VERSION_OUTPUT_BYTES,
			approvedProjectLocal: approved,
		});
		const parsed = parseVersion(`${result.stdout}\n${result.stderr}`);
		return parsed === undefined ? { ok: false, reason: "failed", detail: `${executable} did not report a version` } : { ok: true, version: parsed };
	} catch (error) {
		if (error instanceof RuntimeError && error.code === "unapproved") {
			ctx.disclosed.add(executable);
			return unapprovedProbe(executable);
		}
		return { ok: false, reason: "failed", detail: bound(errorMessage(error)) };
	}
}

// ── SDK prerequisites (detected, never installed) ───────────────────────────────────────────────

interface SdkSpec {
	readonly name: string;
	readonly requirement: string;
	readonly names: readonly string[];
	readonly args: readonly string[];
	readonly accepts: (found: Version) => boolean;
	readonly remediation: string;
}

interface Sdk {
	readonly prerequisite: Prerequisite;
	readonly path?: string;
	/** Present whenever the executable ran, including when it is too old; the caller classifies it. */
	readonly version?: Version;
}

const NODE_SDK: SdkSpec = {
	name: "node",
	requirement: `Node.js >= ${show(NODE_MINIMUM)}`,
	names: ["node"],
	args: ["--version"],
	accepts: found => atLeast(found, NODE_MINIMUM),
	remediation: `Install Node.js ${show(NODE_MINIMUM)} or newer yourself (nodejs.org or your version manager); this tool never installs runtimes.`,
};

const NPM_SDK: SdkSpec = {
	name: "npm",
	requirement: `npm >= ${show(NPM_MINIMUM)} (reads the committed lockfile)`,
	names: ["npm"],
	args: ["--version"],
	accepts: found => atLeast(found, NPM_MINIMUM),
	remediation: "Install npm yourself; Debian and Ubuntu split it from the nodejs package.",
};

const TSC_SDK: SdkSpec = {
	name: "typescript",
	requirement: "an existing TypeScript 6 or 7 SDK (`tsc` on PATH, outside your project)",
	names: ["tsc"],
	args: ["--version"],
	accepts: found => found.major >= 6,
	remediation: "Install TypeScript 6 or 7 yourself (for example `npm install -g typescript@6`); this tool never installs a TypeScript compiler.",
};

const GO_SDK: SdkSpec = {
	name: "go",
	requirement: `Go >= ${show(GO_MINIMUM)} (toolchain downloads stay disabled with GOTOOLCHAIN=local)`,
	names: ["go"],
	args: ["version"],
	accepts: found => atLeast(found, GO_MINIMUM),
	remediation: `Install Go ${show(GO_MINIMUM)} or newer yourself (go.dev/dl); this tool never installs or upgrades Go.`,
};

/**
 * First executable on PATH that runs and reports a compatible version. A PATH entry inside the project is not an SDK
 * for user-level setup, so it is skipped rather than executed.
 */
async function detectSdk(ctx: Ctx, spec: SdkSpec): Promise<Sdk> {
	let tooOld: { path: string; version: Version } | undefined;
	let failure: string | undefined;
	let skipped: string | undefined;
	const seen = new Set<string>();
	for (const name of spec.names) {
		const found = ctx.runtime.resolveExecutable(name);
		if (found === undefined || seen.has(found.path)) continue;
		seen.add(found.path);
		if (found.origin === "project-local") {
			skipped ??= found.path;
			continue;
		}
		const probed = await probeVersion(ctx, found.path, spec.args, false);
		if (!probed.ok) {
			failure ??= `${found.path}: ${probed.detail}`;
			continue;
		}
		if (spec.accepts(probed.version)) {
			return {
				prerequisite: { name: spec.name, requirement: spec.requirement, satisfied: true, found: { path: found.path, version: show(probed.version) } },
				path: found.path,
				version: probed.version,
			};
		}
		tooOld ??= { path: found.path, version: probed.version };
	}
	const remediation = [
		failure === undefined ? undefined : `A ${spec.name} was found but could not report its version (${failure}).`,
		skipped === undefined ? undefined : `${skipped} is inside your project and was not used.`,
		spec.remediation,
	]
		.filter((line): line is string => line !== undefined)
		.join(" ");
	return {
		prerequisite: {
			name: spec.name,
			requirement: spec.requirement,
			satisfied: false,
			...(tooOld === undefined ? {} : { found: { path: tooOld.path, version: show(tooOld.version) } }),
			remediation,
		},
		...(tooOld === undefined ? {} : { path: tooOld.path, version: tooOld.version }),
	};
}

function blocked(
	kind: IntegrationKind,
	tool: ToolDescription,
	prerequisites: readonly Prerequisite[],
	status: ToolStatus,
	detail: string,
	notes: readonly string[],
): BlockedPlan {
	return { status: "blocked", kind, tool, prerequisites, notes: [...notes], result: { status, detail: bound(detail) } };
}

function blockedBy(kind: IntegrationKind, tool: ToolDescription, prerequisites: readonly Prerequisite[], unmet: Prerequisite, notes: readonly string[]): BlockedPlan {
	const found = unmet.found === undefined ? "" : ` Found ${unmet.found.path}${unmet.found.version === undefined ? "" : ` (${unmet.found.version})`}.`;
	return blocked(kind, tool, prerequisites, "needs-sdk", `${unmet.name}: ${unmet.requirement} is not met.${found} ${unmet.remediation ?? ""}`, notes);
}

function unsupportedPlatform(
	kind: IntegrationKind,
	tool: ToolDescription,
	prerequisites: readonly Prerequisite[],
	notes: readonly string[],
	platform: PlatformDetection,
): BlockedPlan {
	const reason = platform.supported ? "This platform has no pinned asset." : platform.reason;
	return blocked(kind, tool, prerequisites, "unsupported", `${reason} Managed installs exist only for macOS (x64, arm64) and Debian/Ubuntu Linux x64.`, notes);
}

// ── Existing tools: configured -> project-local -> PATH ─────────────────────────────────────────

interface ToolSpec {
	/** omp config key. */
	readonly key: string;
	readonly names: readonly string[];
	/** Arguments omp's default entry launches the tool with. */
	readonly args: readonly string[];
	/** Version argv for a launch with the given arguments (a configured entry may launch through `-m` or a script). */
	readonly versionArgs: (launchArgs: readonly string[]) => string[];
	/** Why an existing version is not compatible, or undefined when it is. */
	readonly check: (found: Version) => string | undefined;
	/** The tool cannot report a version; only the fixture verification can confirm it. */
	readonly versionless?: boolean;
}

const TLS_SPEC: ToolSpec = {
	key: "typescript-language-server",
	names: ["typescript-language-server"],
	args: ["--stdio"],
	versionArgs: launchArgs => (launchArgs[0] !== undefined && !launchArgs[0].startsWith("-") ? [launchArgs[0], "--version"] : ["--version"]),
	check: found => (found.major === 6 && atLeast(found, version(6, 0, 2)) ? undefined : "is not 6.0.2 or a newer 6.x, the TypeScript 6 line"),
};

const TS_NATIVE_SPEC: ToolSpec = {
	key: "typescript-native",
	names: ["tsc"],
	args: ["--lsp", "--stdio"],
	versionArgs: () => ["--version"],
	check: found => (found.major >= 7 ? undefined : "is not TypeScript 7 or newer, so it has no native language server"),
};

const PYLSP_SPEC: ToolSpec = {
	key: "pylsp",
	names: ["pylsp"],
	args: [],
	versionArgs: launchArgs => (launchArgs[0] === "-m" ? [...launchArgs, "--version"] : ["--version"]),
	check: found => (found.major === 1 && atLeast(found, version(1, 15, 0)) ? undefined : `is not python-lsp-server ${PYLSP_VERSION} or a newer 1.x`),
};

const DEBUGPY_SPEC: ToolSpec = {
	key: "debugpy",
	names: [],
	args: ["-m", "debugpy.adapter"],
	versionArgs: launchArgs => (launchArgs[0] === "-m" ? ["-m", "debugpy", "--version"] : ["--version"]),
	check: found => (found.major === 1 && atLeast(found, version(1, 8, 22)) ? undefined : `is not debugpy ${DEBUGPY_VERSION} or a newer 1.x`),
};

const GOPLS_SPEC: ToolSpec = {
	key: "gopls",
	names: ["gopls"],
	args: ["serve"],
	versionArgs: () => ["version"],
	check: found => (found.major === 0 && atLeast(found, version(0, 24, 0)) ? undefined : `is not gopls ${GOPLS_VERSION} or a newer 0.x`),
};

const DLV_SPEC: ToolSpec = {
	key: "dlv",
	names: ["dlv"],
	args: ["dap"],
	versionArgs: () => ["version"],
	check: found => (found.major === 1 && atLeast(found, version(1, 27, 2)) ? undefined : `is not Delve ${DELVE_VERSION} or a newer 1.x`),
};

const JS_DEBUG_SPEC: ToolSpec = {
	key: "js-debug-adapter",
	names: [],
	args: [],
	versionArgs: () => [],
	check: () => undefined,
	versionless: true,
};

interface Found {
	readonly source: ReusePlan["source"];
	readonly path: string;
	readonly version?: Version;
	readonly launch: Command;
}

type Inventory =
	| { readonly kind: "reuse"; readonly found: Found; readonly notes: string[] }
	| { readonly kind: "blocked"; readonly status: ToolStatus; readonly detail: string; readonly notes: string[] }
	| { readonly kind: "none"; readonly notes: string[] };

/** Configuration omp may also read but whose enablement cannot be established statically; it is never effective, yet it can shadow or conflict. */
function unknownSources(ctx: Ctx, kind: IntegrationKind, key: string): string[] {
	return ctx.config.sources
		.filter(source => source.kind === kind && source.enablement === "unknown" && source.entries.has(key))
		.map(
			source =>
				`${source.path} also defines ${key}, but whether omp reads it cannot be established statically. It is not treated as effective and could still shadow or conflict with a new entry.`,
		);
}

/** The user's own effective entry decides: it is reused when compatible and otherwise reported, never replaced or shadowed. */
async function inspectConfigured(ctx: Ctx, kind: IntegrationKind, spec: ToolSpec): Promise<Inventory> {
	const effective = effectiveEntry(ctx.config, kind, spec.key);
	const notes = unknownSources(ctx, kind, spec.key);
	if (effective === undefined) return { kind: "none", notes };
	const where = effective.source.path;
	if (effective.disabled) {
		return { kind: "blocked", status: "failed", detail: `${spec.key} is disabled in ${where}. Enable or remove that entry yourself; nothing was changed.`, notes };
	}
	if (effective.command === undefined) {
		const command = typeof effective.value.command === "string" ? effective.value.command : "(none)";
		return {
			kind: "blocked",
			status: "failed",
			detail: `${where} defines ${spec.key} with command ${JSON.stringify(bound(command))}, which does not resolve to an executable. Fix or remove that entry yourself; nothing was changed.`,
			notes,
		};
	}
	const launch: Command = { command: effective.command.path, args: stringArray(effective.value.args) };
	const local = effective.projectSupplied || effective.command.origin === "project-local";
	if (local && !ctx.approved.has(path.resolve(launch.command))) {
		ctx.disclosed.add(launch.command);
		return {
			kind: "blocked",
			status: "unverified",
			detail: `${spec.key} comes from project configuration (${where}) and would run ${launch.command}. It was not executed; approve that path to check it.`,
			notes,
		};
	}
	const found: Found = { source: "configured", path: launch.command, launch };
	if (spec.versionless === true) {
		notes.push(`${spec.key} is configured in ${where}. It reports no version, so only the fixture verification can confirm it works.`);
		return { kind: "reuse", found, notes };
	}
	const probed = await probeVersion(ctx, launch.command, spec.versionArgs(launch.args), local);
	if (!probed.ok) {
		return {
			kind: "blocked",
			status: probed.reason === "unapproved" ? "unverified" : "failed",
			detail: `${spec.key} configured in ${where} could not be checked: ${probed.detail}. Nothing was replaced.`,
			notes,
		};
	}
	const reason = spec.check(probed.version);
	if (reason !== undefined) {
		return {
			kind: "blocked",
			status: "unsupported",
			detail: `${spec.key} configured in ${where} is ${show(probed.version)} and ${reason}. Update or remove that entry yourself; it is never replaced implicitly.`,
			notes,
		};
	}
	return { kind: "reuse", found: { ...found, version: probed.version }, notes };
}

/**
 * Approved project-local tool first (omp itself prefers it inside the project), then a compatible PATH tool.
 * Incompatible or unusable ones are disclosed in `notes` and never replaced.
 */
async function discoverExisting(ctx: Ctx, spec: ToolSpec, notes: string[]): Promise<Found | undefined> {
	const candidates: { path: string; local: boolean }[] = [];
	for (const projectLocal of [true, false]) {
		for (const name of spec.names) {
			const found = ctx.runtime.resolveExecutable(name, { projectLocal });
			if (found !== undefined) candidates.push({ path: found.path, local: found.origin === "project-local" });
		}
	}
	candidates.sort((a, b) => Number(b.local) - Number(a.local));
	const seen = new Set<string>();
	for (const candidate of candidates) {
		if (seen.has(candidate.path)) continue;
		seen.add(candidate.path);
		const probed = await probeVersion(ctx, candidate.path, spec.versionArgs(spec.args), candidate.local);
		if (!probed.ok) {
			notes.push(
				probed.reason === "unapproved"
					? `${candidate.path} is a project-local ${spec.key} and was not run; approve that path to use it.`
					: `Existing ${candidate.path} could not be used (${probed.detail}).`,
			);
			continue;
		}
		const reason = spec.check(probed.version);
		if (reason !== undefined) {
			notes.push(`Existing ${candidate.path} is ${show(probed.version)}, which ${reason}; it is left untouched.`);
			continue;
		}
		return { source: candidate.local ? "project-local" : "path", path: candidate.path, version: probed.version, launch: { command: candidate.path, args: [...spec.args] } };
	}
	return undefined;
}

/** A compatible tool exists, so nothing is installed. Configured and project-local tools already resolve in omp, so they add no entries. */
function reusePlan(kind: IntegrationKind, name: string, found: Found, prerequisites: readonly Prerequisite[], notes: readonly string[], entries: readonly ConfigEntry[]): ReusePlan {
	return {
		status: "reuse",
		kind,
		tool: describeTool(name, found.version === undefined ? undefined : show(found.version), [found.path]),
		prerequisites,
		notes: [...notes],
		launch: found.launch,
		source: found.source,
		entries: found.source === "configured" || found.source === "project-local" ? [] : [...entries],
	};
}

/** Maps a configured outcome to a plan; `none` means the caller continues with discovery and installation. */
function configuredPlan(kind: IntegrationKind, name: string, inventory: Inventory, prerequisites: readonly Prerequisite[]): IntegrationPlan | undefined {
	if (inventory.kind === "blocked") return blocked(kind, describeTool(name, undefined, []), prerequisites, inventory.status, inventory.detail, inventory.notes);
	if (inventory.kind === "reuse") return reusePlan(kind, name, inventory.found, prerequisites, inventory.notes, []);
	return undefined;
}

// ── Managed installs ────────────────────────────────────────────────────────────────────────────

function readCommitted(file: string): string {
	return fs.readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");
}

/** A previously published install of this tool and version is reused without running anything; the runtime revalidates it on use. */
function alreadyInstalled(destination: string, request: InstallRequest, dataFiles: readonly string[] = []): boolean {
	try {
		const manifest: unknown = JSON.parse(fs.readFileSync(path.join(destination, INSTALL_MANIFEST_FILE), "utf8"));
		if (!isRecord(manifest) || manifest.tool !== request.tool || manifest.version !== request.version) return false;
	} catch {
		return false;
	}
	return (
		(request.executables ?? []).every(file => isExecutableFile(path.join(destination, file))) && dataFiles.every(file => fs.existsSync(path.join(destination, file)))
	);
}

function installOrReuse(
	kind: IntegrationKind,
	tool: ToolDescription,
	request: InstallRequest,
	launch: Command,
	entries: readonly ConfigEntry[],
	prerequisites: readonly Prerequisite[],
	notes: readonly string[],
	dataFiles: readonly string[] = [],
): IntegrationPlan {
	const destination = tool.destination as string;
	if (alreadyInstalled(destination, request, dataFiles)) {
		return {
			status: "reuse",
			kind,
			tool,
			prerequisites,
			notes: [...notes, `${request.tool} ${request.version} is already installed at ${destination}.`],
			launch,
			source: "managed",
			entries: [...entries],
		};
	}
	const plan: InstallPlan = { status: "install", kind, tool, prerequisites, notes: [...notes], install: request, launch, entries: [...entries] };
	return plan;
}

// ── JavaScript / TypeScript ─────────────────────────────────────────────────────────────────────

const JS_FILE_TYPES = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
const JS_ROOT_MARKERS = ["package.json", "tsconfig.json", "jsconfig.json"];
const TLS_INIT_OPTIONS: JsonObject = {
	hostInfo: "omp-coding-agent",
	preferences: {
		includeInlayParameterNameHints: "all",
		includeInlayVariableTypeHints: true,
		includeInlayFunctionParameterTypeHints: true,
	},
};

/** `<typescript>/lib` next to a `tsc` that is a regular npm install: where tsserver.js lives. */
function tsserverLibrary(tsc: string): string | undefined {
	try {
		const lib = path.resolve(path.dirname(fs.realpathSync(tsc)), "..", "lib");
		return fs.existsSync(path.join(lib, "tsserver.js")) ? lib : undefined;
	} catch {
		return undefined;
	}
}

function tlsEntry(command: string, tsserverPath: string): ConfigEntry {
	return {
		kind: "lsp",
		key: TLS_SPEC.key,
		value: {
			command,
			args: [...TLS_SPEC.args],
			fileTypes: [...JS_FILE_TYPES],
			rootMarkers: [...JS_ROOT_MARKERS],
			// `fallbackPath`, not `path`: a project's own TypeScript still wins when it has one.
			initOptions: { ...TLS_INIT_OPTIONS, tsserver: { fallbackPath: tsserverPath } },
		},
	};
}

interface JsLsp {
	readonly plan: IntegrationPlan;
	/** The configured server expected to answer the fixture's definition lookup. */
	readonly server: string;
}

async function javascriptLsp(ctx: Ctx, node: Sdk, ts: Sdk): Promise<JsLsp> {
	const name = "typescript-language-server";
	const notes: string[] = [];
	for (const spec of [TLS_SPEC, TS_NATIVE_SPEC]) {
		const configured = await inspectConfigured(ctx, "lsp", spec);
		const plan = configuredPlan("lsp", spec === TLS_SPEC ? name : "typescript-native", configured, [ts.prerequisite]);
		if (plan !== undefined) return { plan, server: spec.key };
		notes.push(...configured.notes);
	}
	const tool = describeTool(name, TLS_VERSION, [`https://registry.npmjs.org/${name}/${TLS_VERSION}`]);
	const server = TLS_SPEC.key;
	if (ts.version === undefined || ts.version.major < 6) return { plan: blockedBy("lsp", tool, [ts.prerequisite], ts.prerequisite, notes), server };
	if (ts.version.major >= 7) {
		const found: Found = { source: "path", path: ts.path as string, version: ts.version, launch: { command: ts.path as string, args: [...TS_NATIVE_SPEC.args] } };
		const nativeNotes = [...notes, "TypeScript 7 serves LSP natively (`tsc --lsp --stdio`): no language server and no compiler are installed."];
		return { plan: reusePlan("lsp", "typescript-native (tsc --lsp)", found, [ts.prerequisite], nativeNotes, []), server: TS_NATIVE_SPEC.key };
	}

	// TypeScript 6: typescript-language-server 6.x drives the existing tsserver.
	const prerequisites = [node.prerequisite, ts.prerequisite];
	if (!node.prerequisite.satisfied) return { plan: blockedBy("lsp", tool, prerequisites, node.prerequisite, notes), server };
	const library = tsserverLibrary(ts.path as string);
	if (library === undefined) {
		const detail = `Could not find lib/tsserver.js next to ${ts.path}. Use a regular npm installation of TypeScript 6 (for example \`npm install -g typescript@6\`).`;
		return { plan: blocked("lsp", tool, prerequisites, "needs-sdk", detail, notes), server };
	}
	const existing = await discoverExisting(ctx, TLS_SPEC, notes);
	if (existing !== undefined) return { plan: reusePlan("lsp", name, existing, prerequisites, notes, [tlsEntry(existing.path, library)]), server };

	const npm = await detectSdk(ctx, NPM_SDK);
	const installPrerequisites = [...prerequisites, npm.prerequisite];
	if (!npm.prerequisite.satisfied) return { plan: blockedBy("lsp", tool, installPrerequisites, npm.prerequisite, notes), server };
	if (!ctx.runtime.platform.supported) return { plan: unsupportedPlatform("lsp", tool, installPrerequisites, notes, ctx.runtime.platform), server };
	const binary = "node_modules/.bin/typescript-language-server";
	const request: InstallRequest = {
		tool: name,
		version: TLS_VERSION,
		operations: [
			{ type: "write-file", path: "package.json", content: TLS_PACKAGE_JSON },
			{ type: "write-file", path: "package-lock.json", content: readCommitted("typescript-package-lock.json") },
			// The committed lock pins integrity and scripts stay off. `npm` resolves on PATH at run time, so the recipe survives Node upgrades.
			{ type: "run", command: "npm", args: ["ci", "--ignore-scripts", "--no-audit", "--no-fund"] },
		],
		executables: [binary],
	};
	const destination = ctx.runtime.installDirectory(name, TLS_VERSION);
	const command = path.join(destination, binary);
	const plan = installOrReuse(
		"lsp",
		{ ...tool, destination },
		request,
		{ command, args: [...TLS_SPEC.args] },
		[tlsEntry(command, library)],
		installPrerequisites,
		[...notes, "Only typescript-language-server is installed; it drives your existing TypeScript SDK's tsserver."],
	);
	return { plan, server };
}

async function javascriptDap(ctx: Ctx, node: Sdk, compiler: string | undefined): Promise<IntegrationPlan> {
	const name = "vscode-js-debug";
	const notes = ["js-debug accepts DAP clients on a short-lived loopback TCP port (127.0.0.1) for the length of a session; other users on a shared machine could reach it meanwhile."];
	if (compiler === undefined) {
		notes.push("No TypeScript compiler (tsc) is available, so only plain JavaScript debugging is exercised; source-mapped TypeScript debugging is not verified.");
	}
	const prerequisites = [node.prerequisite];
	const configured = await inspectConfigured(ctx, "dap", JS_DEBUG_SPEC);
	const configuredResult = configuredPlan("dap", name, configured, prerequisites);
	if (configuredResult !== undefined) return { ...configuredResult, notes: [...configuredResult.notes, ...notes] };
	const carried = [...configured.notes, ...notes];
	const tool = describeTool(name, `v${JS_DEBUG_VERSION}`, [JS_DEBUG_ARTIFACT.url, `sha256:${JS_DEBUG_ARTIFACT.sha256}`]);
	if (!node.prerequisite.satisfied) return blockedBy("dap", tool, prerequisites, node.prerequisite, carried);
	if (!ctx.runtime.platform.supported) return unsupportedPlatform("dap", tool, prerequisites, carried, ctx.runtime.platform);
	const request: InstallRequest = { tool: "js-debug", version: JS_DEBUG_VERSION, operations: [{ type: "artifact", artifact: JS_DEBUG_ARTIFACT }] };
	const destination = ctx.runtime.installDirectory(request.tool, request.version);
	const server = path.join(destination, JS_DEBUG_SERVER);
	const args = [server, "${port}", "127.0.0.1"];
	return installOrReuse(
		"dap",
		{ ...tool, destination },
		request,
		{ command: node.path as string, args },
		[{ kind: "dap", key: JS_DEBUG_SPEC.key, value: { command: node.path as string, args: [...args], connectMode: "tcp" } }],
		prerequisites,
		carried,
		[JS_DEBUG_SERVER],
	);
}

export async function planJavascript(context: PlanContext, options: ManagedPlanOptions = {}): Promise<LanguagePlan> {
	const ctx = makeCtx(context, options);
	const node = await detectSdk(ctx, NODE_SDK);
	const ts = await detectSdk(ctx, TSC_SDK);
	// Any `tsc` that runs can compile the fixture, even one too old for the language server.
	const compiler = ts.version === undefined ? undefined : ts.path;
	const lsp = await javascriptLsp(ctx, node, ts);
	const dap = await javascriptDap(ctx, node, compiler);
	return { language: "javascript", lsp: lsp.plan, dap, fixtures: javascriptFixtures(lsp.server, compiler), projectLocalExecutables: [...ctx.disclosed].sort() };
}

// ── Python ──────────────────────────────────────────────────────────────────────────────────────

const PYTHON_FILE_TYPES = [".py"];
const PYTHON_ROOT_MARKERS = ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "Pipfile"];
const PYTHON_NAMES = ["python3", "python3.14", "python3.13", "python3.12", "python3.11", "python3.10", "python"];
const PYTHON_VERSION_SNIPPET = 'import sys; print("%d.%d.%d" % sys.version_info[:3])';

interface Interpreter {
	/** Bare name the install recipe runs, so it survives the interpreter moving on PATH. */
	readonly name: string;
	readonly path: string;
	readonly version: Version;
	readonly local: boolean;
}

interface Interpreters {
	/** A CPython outside the project with venv and ensurepip: the managed venv is created from it. */
	readonly base?: Interpreter;
	/** What Jedi and the debuggee use: an approved project interpreter, otherwise `base`. */
	readonly target?: Interpreter;
	readonly prerequisite: Prerequisite;
	readonly notes: string[];
}

function pythonInRange(found: Version): boolean {
	return found.major === 3 && atLeast(found, PYTHON_MINIMUM) && found.minor <= PYTHON_MAXIMUM_MINOR;
}

async function canCreateVenv(ctx: Ctx, python: string): Promise<boolean> {
	try {
		await ctx.runtime.probe(python, ["-c", "import ensurepip, venv"], { timeoutMs: VERSION_TIMEOUT_MS, maxOutputBytes: VERSION_OUTPUT_BYTES });
		return true;
	} catch {
		return false;
	}
}

async function findInterpreters(ctx: Ctx): Promise<Interpreters> {
	const requirement = `CPython ${PYTHON_RANGE} with venv and ensurepip`;
	const notes: string[] = [];
	const seen = new Set<string>();
	let outOfRange: Interpreter | undefined;
	let withoutVenv: Interpreter | undefined;
	let failure: string | undefined;
	let base: Interpreter | undefined;
	for (const name of PYTHON_NAMES) {
		const found = ctx.runtime.resolveExecutable(name);
		if (found === undefined) continue;
		const real = fs.existsSync(found.path) ? fs.realpathSync(found.path) : found.path;
		if (seen.has(real)) continue;
		seen.add(real);
		if (found.origin === "project-local") {
			notes.push(`${found.path} is on PATH but inside your project; the managed environment is not created from it.`);
			continue;
		}
		const probed = await probeVersion(ctx, found.path, ["-c", PYTHON_VERSION_SNIPPET], false);
		if (!probed.ok) {
			failure ??= `${found.path}: ${probed.detail}`;
			continue;
		}
		const interpreter: Interpreter = { name, path: found.path, version: probed.version, local: false };
		if (!pythonInRange(probed.version)) {
			outOfRange ??= interpreter;
		} else if (!(await canCreateVenv(ctx, found.path))) {
			withoutVenv ??= interpreter;
		} else {
			base = interpreter;
			break;
		}
	}

	let target = base;
	const project = ctx.runtime.resolveExecutable("python", { projectLocal: true });
	if (project !== undefined && project.origin === "project-local") {
		const probed = await probeVersion(ctx, project.path, ["-c", PYTHON_VERSION_SNIPPET], true);
		if (!probed.ok) {
			notes.push(
				probed.reason === "unapproved"
					? `Project interpreter ${project.path} was not run; approve that path to point Jedi and the debugger at it instead of ${base?.path ?? "a base interpreter"}.`
					: `Project interpreter ${project.path} could not be used (${probed.detail}).`,
			);
		} else if (pythonInRange(probed.version)) {
			target = { name: "python", path: project.path, version: probed.version, local: true };
		} else {
			notes.push(`Project interpreter ${project.path} is ${show(probed.version)}, outside ${PYTHON_RANGE}; it is not used as the analysis and debug target.`);
		}
	}

	const targetPart = target === undefined ? {} : { target };
	if (base !== undefined) {
		return { base, ...targetPart, notes, prerequisite: { name: "python", requirement, satisfied: true, found: { path: base.path, version: show(base.version) } } };
	}
	const closest = withoutVenv ?? outOfRange;
	let remediation: string;
	if (withoutVenv !== undefined) {
		remediation = `${withoutVenv.path} cannot create environments (venv/ensurepip missing). Install the OS package yourself (Debian/Ubuntu: sudo apt install python3-venv); this tool never runs sudo.`;
	} else if (outOfRange !== undefined) {
		remediation = `${outOfRange.path} is ${show(outOfRange.version)}. Install a CPython in ${PYTHON_RANGE} yourself; this tool never installs Python.`;
	} else {
		remediation = `${failure === undefined ? "" : `A python was found but could not run (${failure}). `}Install CPython ${PYTHON_RANGE} yourself; this tool never installs Python.`;
	}
	return {
		...targetPart,
		notes,
		prerequisite: {
			name: "python",
			requirement,
			satisfied: false,
			...(closest === undefined ? {} : { found: { path: closest.path, version: show(closest.version) } }),
			remediation,
		},
	};
}

function pylspEntry(command: string, args: readonly string[], target: Interpreter | undefined): ConfigEntry {
	return {
		kind: "lsp",
		key: PYLSP_SPEC.key,
		value: {
			command,
			args: [...args],
			fileTypes: [...PYTHON_FILE_TYPES],
			rootMarkers: [...PYTHON_ROOT_MARKERS],
			// Jedi resolves imports with the approved original interpreter, not with the managed venv that runs pylsp.
			...(target === undefined ? {} : { settings: { pylsp: { plugins: { jedi: { environment: target.path } } } } }),
		},
	};
}

function debugpyEntry(command: string, target: Interpreter | undefined): ConfigEntry {
	return {
		kind: "dap",
		key: DEBUGPY_SPEC.key,
		value: {
			command,
			args: [...DEBUGPY_SPEC.args],
			// The adapter runs in the managed venv; the debuggee runs under the approved original interpreter.
			...(target === undefined ? {} : { launchDefaults: { python: [target.path] } }),
		},
	};
}

/** One venv serves both integrations; both plans carry this identical request, so the second install is a no-op reuse. */
function pythonInstallRequest(base: Interpreter): InstallRequest {
	const lock = readCommitted("python-requirements.lock");
	return {
		tool: "python-tools",
		version: `pylsp${PYLSP_VERSION}-debugpy${DEBUGPY_VERSION}-py${base.version.major}.${base.version.minor}-${sha256Hex(lock).slice(0, 8)}`,
		operations: [
			{ type: "write-file", path: "requirements.lock", content: lock },
			{ type: "run", command: base.name, args: ["-m", "venv", `${INSTALL_DIR_TOKEN}/venv`] },
			{
				type: "run",
				command: `${INSTALL_DIR_TOKEN}/venv/bin/python`,
				args: [
					"-m",
					"pip",
					"install",
					"--isolated",
					"--disable-pip-version-check",
					"--no-input",
					"--only-binary=:all:",
					"--require-hashes",
					"--no-deps",
					"-r",
					"requirements.lock",
				],
			},
			{ type: "run", command: `${INSTALL_DIR_TOKEN}/venv/bin/python`, args: ["-m", "pip", "check"] },
		],
		executables: ["venv/bin/python"],
	};
}

function pythonNotes(target: Interpreter | undefined, notes: readonly string[]): string[] {
	const shared = "python-lsp-server and debugpy share one private venv built from your Python; nothing is installed into your Python or your project.";
	return target === undefined ? [...notes, shared] : [...notes, shared, `Jedi and debugged programs use ${target.path}.`];
}

async function pythonLsp(ctx: Ctx, interpreters: Interpreters): Promise<IntegrationPlan> {
	const name = "python-lsp-server";
	const { base, target } = interpreters;
	const prerequisites = [interpreters.prerequisite];
	const configured = await inspectConfigured(ctx, "lsp", PYLSP_SPEC);
	const configuredResult = configuredPlan("lsp", name, configured, prerequisites);
	if (configuredResult !== undefined) return configuredResult;
	const notes = [...interpreters.notes, ...configured.notes];
	const existing = await discoverExisting(ctx, PYLSP_SPEC, notes);
	if (existing !== undefined) return reusePlan("lsp", name, existing, prerequisites, pythonNotes(target, notes), [pylspEntry(existing.path, [], target)]);
	const tool = describeTool(name, PYLSP_VERSION, [`https://pypi.org/project/python-lsp-server/${PYLSP_VERSION}/`, "hash-locked binary wheels (python-requirements.lock)"]);
	if (base === undefined) return blockedBy("lsp", tool, prerequisites, interpreters.prerequisite, notes);
	if (!ctx.runtime.platform.supported) return unsupportedPlatform("lsp", tool, prerequisites, notes, ctx.runtime.platform);
	const request = pythonInstallRequest(base);
	const destination = ctx.runtime.installDirectory(request.tool, request.version);
	const python = path.join(destination, "venv", "bin", "python");
	return installOrReuse(
		"lsp",
		{ ...tool, destination },
		request,
		{ command: python, args: ["-m", "pylsp"] },
		[pylspEntry(python, ["-m", "pylsp"], target)],
		prerequisites,
		pythonNotes(target, notes),
	);
}

async function pythonDap(ctx: Ctx, interpreters: Interpreters): Promise<IntegrationPlan> {
	const name = "debugpy";
	const { base, target } = interpreters;
	const prerequisites = [interpreters.prerequisite];
	const configured = await inspectConfigured(ctx, "dap", DEBUGPY_SPEC);
	const configuredResult = configuredPlan("dap", name, configured, prerequisites);
	if (configuredResult !== undefined) return configuredResult;
	const notes = [...interpreters.notes, ...configured.notes];
	// An interpreter that already has a compatible debugpy is reused, so the debuggee needs no `python` override.
	for (const interpreter of new Set([target, base])) {
		if (interpreter === undefined) continue;
		const probed = await probeVersion(ctx, interpreter.path, ["-m", "debugpy", "--version"], interpreter.local);
		if (!probed.ok) continue;
		const reason = DEBUGPY_SPEC.check(probed.version);
		if (reason !== undefined) {
			notes.push(`Existing debugpy ${show(probed.version)} in ${interpreter.path} ${reason}; it is left untouched.`);
			continue;
		}
		const found: Found = {
			source: interpreter.local ? "project-local" : "path",
			path: interpreter.path,
			version: probed.version,
			launch: { command: interpreter.path, args: [...DEBUGPY_SPEC.args] },
		};
		return reusePlan("dap", name, found, prerequisites, notes, [debugpyEntry(interpreter.path, undefined)]);
	}
	const tool = describeTool(name, DEBUGPY_VERSION, [`https://pypi.org/project/debugpy/${DEBUGPY_VERSION}/`, "hash-locked binary wheels (python-requirements.lock)"]);
	if (base === undefined) return blockedBy("dap", tool, prerequisites, interpreters.prerequisite, notes);
	if (!ctx.runtime.platform.supported) return unsupportedPlatform("dap", tool, prerequisites, notes, ctx.runtime.platform);
	const request = pythonInstallRequest(base);
	const destination = ctx.runtime.installDirectory(request.tool, request.version);
	const python = path.join(destination, "venv", "bin", "python");
	return installOrReuse(
		"dap",
		{ ...tool, destination },
		request,
		{ command: python, args: [...DEBUGPY_SPEC.args] },
		[debugpyEntry(python, target)],
		prerequisites,
		pythonNotes(target, [...notes, "Debugging can stop at a debugger permission prompt or a blocked ptrace in locked-down containers; that is reported, not bypassed."]),
	);
}

export async function planPython(context: PlanContext, options: ManagedPlanOptions = {}): Promise<LanguagePlan> {
	const ctx = makeCtx(context, options);
	const interpreters = await findInterpreters(ctx);
	const lsp = await pythonLsp(ctx, interpreters);
	const dap = await pythonDap(ctx, interpreters);
	return { language: "python", lsp, dap, fixtures: pythonFixtures(), projectLocalExecutables: [...ctx.disclosed].sort() };
}

// ── Go ──────────────────────────────────────────────────────────────────────────────────────────

const GO_FILE_TYPES = [".go", ".mod", ".sum"];
const GO_ROOT_MARKERS = ["go.mod", "go.work", "go.sum"];

async function goLsp(ctx: Ctx, go: Sdk): Promise<IntegrationPlan> {
	const name = "gopls";
	const prerequisites = [go.prerequisite];
	const configured = await inspectConfigured(ctx, "lsp", GOPLS_SPEC);
	const configuredResult = configuredPlan("lsp", name, configured, prerequisites);
	if (configuredResult !== undefined) return configuredResult;
	const notes = [...configured.notes];
	const tool = describeTool(name, GOPLS_VERSION, [`https://proxy.golang.org/golang.org/x/tools/gopls/@v/${GOPLS_VERSION}.mod`, "module checksums verified against sum.golang.org"]);
	if (!go.prerequisite.satisfied) return blockedBy("lsp", tool, prerequisites, go.prerequisite, notes);
	const existing = await discoverExisting(ctx, GOPLS_SPEC, notes);
	if (existing !== undefined) return reusePlan("lsp", name, existing, prerequisites, notes, []);
	if (!ctx.runtime.platform.supported) return unsupportedPlatform("lsp", tool, prerequisites, notes, ctx.runtime.platform);
	const goVersion = go.version as Version;
	const request: InstallRequest = {
		tool: name,
		// gopls is built by the installed Go, so a different Go minor gets its own destination.
		version: `${GOPLS_VERSION}-go${goVersion.major}.${goVersion.minor}`,
		operations: [
			{
				type: "run",
				// `go` resolves on PATH at run time; the runtime forces GOTOOLCHAIN=local, a private module cache and the public checksum database.
				command: "go",
				args: ["install", `golang.org/x/tools/gopls@${GOPLS_VERSION}`],
				env: { GOBIN: `${INSTALL_DIR_TOKEN}/bin` },
			},
		],
		executables: ["bin/gopls"],
	};
	const destination = ctx.runtime.installDirectory(request.tool, request.version);
	const command = path.join(destination, "bin", "gopls");
	return installOrReuse(
		"lsp",
		{ ...tool, destination },
		request,
		{ command, args: [...GOPLS_SPEC.args] },
		[{ kind: "lsp", key: GOPLS_SPEC.key, value: { command, args: [...GOPLS_SPEC.args], fileTypes: [...GO_FILE_TYPES], rootMarkers: [...GO_ROOT_MARKERS] } }],
		prerequisites,
		[...notes, "gopls is compiled by your Go (GOTOOLCHAIN=local, so no Go toolchain is ever downloaded) with an isolated module cache; a cold build can take a few minutes."],
	);
}

async function goDap(ctx: Ctx, go: Sdk): Promise<IntegrationPlan> {
	const name = "delve";
	const prerequisites = [go.prerequisite];
	const platform = ctx.runtime.platform;
	const platformNote =
		platform.supported && platform.platform.os === "darwin"
			? "On macOS Delve needs Apple's Command Line Tools (`xcode-select --install`) and Developer Mode or an authorization prompt per run; this tool runs neither."
			: "Debugging needs ptrace permission; locked-down containers can refuse it, which is reported rather than bypassed.";
	const configured = await inspectConfigured(ctx, "dap", DLV_SPEC);
	const configuredResult = configuredPlan("dap", name, configured, prerequisites);
	if (configuredResult !== undefined) return { ...configuredResult, notes: [...configuredResult.notes, platformNote] };
	const notes = [...configured.notes, platformNote];
	const asset = platform.supported ? DELVE_ARTIFACTS[platform.platform.id] : undefined;
	const tool = describeTool(name, `v${DELVE_VERSION}`, asset === undefined ? [`https://github.com/go-delve/delve/releases/tag/v${DELVE_VERSION}`] : [asset.url, `sha256:${asset.sha256}`]);
	if (!go.prerequisite.satisfied) return blockedBy("dap", tool, prerequisites, go.prerequisite, notes);
	const existing = await discoverExisting(ctx, DLV_SPEC, notes);
	if (existing !== undefined) return reusePlan("dap", name, existing, prerequisites, notes, []);
	if (!platform.supported || asset === undefined) return unsupportedPlatform("dap", tool, prerequisites, notes, platform);
	const request: InstallRequest = { tool: name, version: DELVE_VERSION, operations: [{ type: "artifact", artifact: asset }], executables: ["dlv"] };
	const destination = ctx.runtime.installDirectory(request.tool, request.version);
	const command = path.join(destination, "dlv");
	return installOrReuse(
		"dap",
		{ ...tool, destination },
		request,
		{ command, args: [...DLV_SPEC.args] },
		[{ kind: "dap", key: DLV_SPEC.key, value: { command, args: [...DLV_SPEC.args], connectMode: "socket", acceptsDirectoryProgram: true } }],
		prerequisites,
		notes,
	);
}

export async function planGo(context: PlanContext, options: ManagedPlanOptions = {}): Promise<LanguagePlan> {
	const ctx = makeCtx(context, options);
	const go = await detectSdk(ctx, GO_SDK);
	const lsp = await goLsp(ctx, go);
	const dap = await goDap(ctx, go);
	return { language: "go", lsp, dap, fixtures: goFixtures(go.path), projectLocalExecutables: [...ctx.disclosed].sort() };
}

// ── Fixtures ────────────────────────────────────────────────────────────────────────────────────
//
// Every fixture computes `answer = 6 * 7` in `compute`, breaks on the line that returns it, and has a
// cross-file reference to `greet`/`Greet` for the definition lookup. Lines are 1-based; the tests
// check each expectation against the fixture text.

function text(...lines: string[]): string {
	return `${lines.join("\n")}\n`;
}

function javascriptFixtures(server: string, compiler: string | undefined): FixtureCase[] {
	const plain: FixtureCase = {
		id: "javascript",
		label: "JavaScript (ES modules on Node)",
		files: [
			{ path: "package.json", content: text("{", '  "name": "omp-fixture-js",', '  "private": true,', '  "type": "module"', "}") },
			{ path: "util.js", content: text("export function greet(name) {", '  return "hello " + name;', "}") },
			{
				path: "main.js",
				content: text(
					'import { greet } from "./util.js";',
					"",
					"function compute(a, b) {",
					"  const answer = a * b;",
					"  return answer;",
					"}",
					"",
					'console.log(greet("omp"), compute(6, 7));',
				),
			},
		],
		lsp: { server, file: "main.js", line: 8, symbol: "greet", definition: { file: "util.js", line: 1 } },
		dap: { adapter: "js-debug-adapter", program: "main.js", breakpoint: { file: "main.js", line: 5 }, variable: { name: "answer", value: "42" } },
	};
	if (compiler === undefined) return [plain];
	const tsconfig = {
		compilerOptions: {
			target: "ES2022",
			module: "nodenext",
			moduleResolution: "nodenext",
			lib: ["ES2022", "DOM"],
			types: [],
			strict: true,
			skipLibCheck: true,
			sourceMap: true,
			rootDir: ".",
			outDir: "dist",
		},
		include: ["*.ts"],
	};
	const mapped: FixtureCase = {
		id: "typescript",
		label: "TypeScript (compiled with source maps, debugged in the .ts source)",
		files: [
			{ path: "package.json", content: text("{", '  "name": "omp-fixture-ts",', '  "private": true', "}") },
			{ path: "tsconfig.json", content: `${JSON.stringify(tsconfig, null, 2)}\n` },
			{ path: "util.ts", content: text("export function greet(name: string): string {", '  return "hello " + name;', "}") },
			{
				path: "main.ts",
				content: text(
					'import { greet } from "./util";',
					"",
					"function compute(a: number, b: number): number {",
					"  const answer: number = a * b;",
					"  return answer;",
					"}",
					"",
					'console.log(greet("omp"), compute(6, 7));',
				),
			},
		],
		// The existing SDK compiles the fixture; no TypeScript compiler is installed.
		build: [{ label: "compile TypeScript with source maps", command: compiler, args: ["-p", "."] }],
		lsp: { server, file: "main.ts", line: 8, symbol: "greet", definition: { file: "util.ts", line: 1 } },
		dap: { adapter: "js-debug-adapter", program: "dist/main.js", breakpoint: { file: "main.ts", line: 5 }, variable: { name: "answer", value: "42" } },
	};
	return [plain, mapped];
}

function pythonFixtures(): FixtureCase[] {
	return [
		{
			id: "python",
			label: "Python (approved original interpreter)",
			files: [
				{ path: "pyproject.toml", content: text("[project]", 'name = "omp-fixture-python"', 'version = "0.0.0"') },
				{ path: "util.py", content: text("def greet(name):", '    return "hello " + name') },
				{ path: "main.py", content: text("from util import greet", "", 'print(greet("omp"))') },
				// The debug target is self-contained: the verifier's environment sets PYTHONSAFEPATH, which keeps the script directory off sys.path.
				{
					path: "fixture_debug.py",
					content: text("def compute(a, b):", "    answer = a * b", "    return answer", "", "", 'if __name__ == "__main__":', "    compute(6, 7)"),
				},
			],
			lsp: { server: "pylsp", file: "main.py", line: 3, symbol: "greet", definition: { file: "util.py", line: 1 } },
			dap: { adapter: "debugpy", program: "fixture_debug.py", breakpoint: { file: "fixture_debug.py", line: 3 }, variable: { name: "answer", value: "42" } },
		},
	];
}

function goFixtures(go: string | undefined): FixtureCase[] {
	return [
		{
			id: "go",
			label: "Go (package directory)",
			files: [
				{ path: "go.mod", content: text("module example.com/ompfixture", "", "go 1.21") },
				{ path: "util.go", content: text("package main", "", "func Greet(name string) string {", '\treturn "hello " + name', "}") },
				{
					path: "main.go",
					content: text(
						"package main",
						"",
						'import "fmt"',
						"",
						"func compute(a, b int) int {",
						"\tanswer := a * b",
						"\treturn answer",
						"}",
						"",
						"func main() {",
						'\tfmt.Println(Greet("omp"), compute(6, 7))',
						"}",
					),
				},
			],
			// The existing Go compiles the package first (GOTOOLCHAIN=local); without a Go the plans are blocked anyway.
			...(go === undefined ? {} : { build: [{ label: "compile the package", command: go, args: ["build", "./..."] }] }),
			lsp: { server: "gopls", file: "main.go", line: 11, symbol: "Greet", definition: { file: "util.go", line: 3 } },
			dap: { adapter: "dlv", program: ".", breakpoint: { file: "main.go", line: 7 }, variable: { name: "answer", value: "42" } },
		},
	];
}
