// Isolated real-protocol verification (design C2/C3).
//
// `verifyLanguage` proves one language group by driving omp's OWN public `lsp` and `debug` tools (through
// the helper extension in `verifier-extension.ts`) against disposable fixtures, in a separate omp RPC process
// that has no credentials, no user configuration and no model turn. There is no LSP or DAP client here.
//
// Everything runs in a verifier-owned system-temp tree: fixture, HOME, agent/XDG directories and settings
// are private, nothing of the user's (auth, settings, plugins, MCP, hooks) is read or copied, and no process
// is ever started in the user's project. The project is only consulted statically: its configuration
// snapshot decides whether the approved entries are shadowed or disabled, and its path decides whether an
// executable is project-local and so needs an exact grant from the caller.
//
// Statuses are honest and independent per integration (C3). Only a fixture that was built, run and observed
// to give the exact expected definition / stop / value, torn down with no surviving process, is `ready`.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { effectiveEntry } from "./config";
import { createRuntime, errorMessage, isExecutableFile, isRecord, isWithin, PROTOCOL_TIMEOUT_MS, projectLocalBinDirs, removeTree, RuntimeError } from "./runtime";
import type {
	Command,
	ConfigEntryValue,
	ConfigSnapshot,
	DapExpectation,
	ExitStatus,
	FixtureCase,
	FixtureFile,
	IntegrationKind,
	InstallPlan,
	IntegrationResult,
	JsonObject,
	JsonValue,
	LanguageId,
	LanguagePlan,
	LspExpectation,
	OwnedProcess,
	ReusePlan,
	Runtime,
	ToolResult,
	ToolStatus,
	WorkDir,
} from "./types";
import { LANGUAGE_IDS } from "./types";
import { CASE_VARIABLE, type DapObservation, type LspObservation, type Observation, parseObservation, VERIFY_COMMAND } from "./verifier-extension";

// ── Contract ────────────────────────────────────────────────────────────────────────────────────

/** Every fixture a language group must prove. A missing, extra or duplicated one is not a smaller check, it is no check. */
export const REQUIRED_VARIANTS: Readonly<Record<LanguageId, readonly string[]>> = {
	javascript: ["javascript", "typescript"],
	python: ["python"],
	go: ["go"],
	rust: ["rust"],
	cpp: ["c", "cpp"],
};

/**
 * Settings the verifier's omp runs with. Nested mappings are required (a flat dotted key is ignored by omp).
 * The verifier reads them back with `omp config list` and refuses to continue unless omp reports exactly these values.
 */
export const ISOLATION_SETTINGS = {
	lsp: { shared: false },
	mcp: { enableProjectConfig: false },
	startup: { checkUpdate: false, setupWizard: false },
	marketplace: { autoUpdate: "off" },
	skills: { enabled: false },
	dev: { autoqa: false },
	telemetry: { otlpExportEnabled: false },
	recap: { enabled: false },
	providers: { cacheWarming: "off" },
	eval: { autoProvision: false },
} as const;

/** A catalog selector that lets omp start without credentials. No request is made: the helper command never starts a turn. */
const STARTUP_MODEL = "openai-codex/gpt-6.1-sol";
const PRESERVE_ASLR = "settings set target.disable-aslr false";
const KINDS: readonly IntegrationKind[] = ["lsp", "dap"];
const DETAIL_CHARS = 600;
const MAX_FRAME_CHARS = 1024 * 1024;
const STDERR_TAIL = 2000;
const MAX_FRAMES = 5000;

/** Built-in language servers that also claim a group's file types, switched off in the fixture so none of them can stand in for the one under test. */
const LSP_COMPETITORS: Readonly<Record<LanguageId, readonly string[]>> = {
	javascript: ["typescript-language-server", "typescript-native", "denols", "biome", "eslint", "tailwindcss"],
	python: ["pylsp", "pyright", "basedpyright", "ty", "ruff"],
	go: ["gopls"],
	rust: ["rust-analyzer"],
	cpp: ["clangd"],
};

export interface VerifyLimits {
	/** One fixture build command (contract ceiling: 300 s). */
	readonly buildMs: number;
	/** One protocol call (contract ceiling: 30 s). */
	readonly callMs: number;
	/** omp start to its ready frame, and the settings check. */
	readonly startMs: number;
	/** Readiness-polling window of each of the LSP and debugger phases. */
	readonly readinessMs: number;
	/** The whole helper command. */
	readonly helperMs: number;
	/** Cooperative shutdown before the TERM-to-KILL sweep. */
	readonly shutdownMs: number;
}

export const DEFAULT_LIMITS: VerifyLimits = {
	buildMs: 300_000,
	callMs: PROTOCOL_TIMEOUT_MS,
	startMs: 60_000,
	readinessMs: 90_000,
	helperMs: 300_000,
	shutdownMs: 5_000,
};

export interface VerifyContext {
	/** Absolute omp executable (the one running the wizard). It is only ever started in the private tree. */
	readonly ompPath: string;
	/** The user's project: used for static path checks only. Nothing is started, read or written there. */
	readonly cwd: string;
	/** Static inspection of the original project's LSP/DAP configuration. */
	readonly config: ConfigSnapshot;
	/** The user explicitly agreed to build disposable fixtures with their existing SDKs and run the approved tools there. */
	readonly consent: boolean;
	/**
	 * Absolute project-local executables the user approved, exactly as disclosed. Never inferred from a plan:
	 * a first plan discloses unapproved paths and a re-plan may omit an approved one.
	 */
	readonly approvedProjectLocal?: readonly string[];
	readonly signal?: AbortSignal;
	/** Parent environment for PATH and SDK homes (default `process.env`). Nothing else is inherited. */
	readonly env?: Readonly<Record<string, string | undefined>>;
	/** Preferred base for the private tree (default: the system temp directory). */
	readonly tempRoot?: string;
	/** Lower the contract ceilings (never raise them). */
	readonly limits?: Partial<VerifyLimits>;
	readonly onProgress?: (message: string) => void;
}

export interface StageReport {
	readonly status: ToolStatus;
	readonly detail: string;
	/** What the fixture required, and what was observed instead: structured, bounded, never raw source. */
	readonly expected?: JsonObject;
	readonly observed?: JsonObject;
}

export interface FixtureReport {
	readonly fixture: string;
	readonly lsp?: StageReport;
	readonly dap?: StageReport;
}

/** The C3 pair plus the per-fixture evidence behind it. Persist `lsp` and `dap` only. */
export type Verification = IntegrationResult & { readonly observations: readonly FixtureReport[] };

// ── Small helpers ───────────────────────────────────────────────────────────────────────────────

function clip(text: string, max = DETAIL_CHARS): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}

function realpathOrSelf(target: string): string {
	try {
		return fs.realpathSync(target);
	} catch {
		return path.resolve(target);
	}
}

function result(status: ToolStatus, detail: string, launch?: Command): ToolResult {
	return { status, detail: clip(detail), ...(launch === undefined ? {} : { command: { command: launch.command, args: [...launch.args] } }) };
}

/** A fixture-wide stop with the honest status to report. */
class Stop extends Error {
	constructor(
		readonly status: ToolStatus,
		message: string,
	) {
		super(message);
	}
}

function toStop(error: unknown): Stop {
	if (error instanceof Stop) return error;
	if (error instanceof RuntimeError) {
		if (error.code === "aborted") return new Stop("unverified", "verification was cancelled");
		if (error.code === "unapproved") return new Stop("unverified", error.message);
		if (error.code === "executable-not-found") return new Stop("missing", error.message);
	}
	return new Stop("failed", errorMessage(error));
}

function limitsFor(context: VerifyContext): VerifyLimits {
	const entries = Object.entries(DEFAULT_LIMITS).map(([name, ceiling]) => {
		const wanted = context.limits?.[name as keyof VerifyLimits];
		return [name, typeof wanted === "number" && Number.isFinite(wanted) ? Math.max(1, Math.min(ceiling, Math.floor(wanted))) : ceiling];
	});
	return Object.fromEntries(entries) as unknown as VerifyLimits;
}

function flatten(value: Record<string, unknown>, prefix = ""): [string, unknown][] {
	return Object.entries(value).flatMap(([key, member]): [string, unknown][] => (isRecord(member) ? flatten(member, `${prefix}${key}.`) : [[`${prefix}${key}`, member]]));
}

// ── Static checks: plan shape, variants, consent ────────────────────────────────────────────────

function fixtureProblem(fixture: FixtureCase): string | undefined {
	if (!isRecord(fixture) || typeof fixture.id !== "string" || !Array.isArray(fixture.files) || !isRecord(fixture.lsp) || !isRecord(fixture.dap)) return "a fixture is malformed";
	const content = new Map<string, string>();
	for (const file of fixture.files) {
		if (!isRecord(file) || typeof file.path !== "string" || typeof file.content !== "string") return `fixture ${fixture.id} has a malformed file`;
		content.set(file.path, file.content);
	}
	const at = (file: unknown, row: unknown): boolean =>
		typeof file === "string" && Number.isInteger(row) && (row as number) >= 1 && (row as number) <= (content.get(file)?.split("\n").length ?? 0);
	const { lsp, dap } = fixture;
	if (typeof lsp.server !== "string" || typeof lsp.symbol !== "string" || !at(lsp.file, lsp.line) || !isRecord(lsp.definition) || !at(lsp.definition.file, lsp.definition.line)) {
		return `fixture ${fixture.id} has an unusable definition expectation`;
	}
	if (typeof dap.adapter !== "string" || typeof dap.program !== "string" || !isRecord(dap.breakpoint) || !at(dap.breakpoint.file, dap.breakpoint.line)) {
		return `fixture ${fixture.id} has an unusable breakpoint expectation`;
	}
	if (!isRecord(dap.variable) || typeof dap.variable.name !== "string" || typeof dap.variable.value !== "string") return `fixture ${fixture.id} has no variable expectation`;
	for (const step of fixture.build ?? []) {
		if (!isRecord(step) || typeof step.command !== "string" || !Array.isArray(step.args)) return `fixture ${fixture.id} has a malformed build step`;
	}
	return undefined;
}

function planProblem(plan: LanguagePlan): string | undefined {
	if (!isRecord(plan) || !LANGUAGE_IDS.includes(plan.language) || !isRecord(plan.lsp) || !isRecord(plan.dap) || !Array.isArray(plan.fixtures)) return "the plan is malformed";
	return undefined;
}

function variantsProblem(plan: LanguagePlan): string | undefined {
	const required = REQUIRED_VARIANTS[plan.language];
	const ids = plan.fixtures.map(fixture => (isRecord(fixture) ? String(fixture.id) : ""));
	const missing = required.filter(id => !ids.includes(id));
	const unexpected = ids.filter((id, index) => !required.includes(id) || ids.indexOf(id) !== index);
	if (missing.length > 0 || unexpected.length > 0) {
		const parts = [`required variants: ${required.join(", ")}`, ...(missing.length > 0 ? [`missing: ${missing.join(", ")}`] : []), ...(unexpected.length > 0 ? [`unexpected or duplicated: ${unexpected.join(", ")}`] : [])];
		return `${parts.join("; ")}. Every variant must pass, so nothing was run.`;
	}
	for (const fixture of plan.fixtures) {
		const problem = fixtureProblem(fixture);
		if (problem !== undefined) return problem;
	}
	return undefined;
}

// ── Project-local policy ────────────────────────────────────────────────────────────────────────

interface Policy {
	/** Exact absolute paths the caller approved. */
	readonly grants: ReadonlySet<string>;
	readonly isProjectLocal: (file: string) => boolean;
}

function makePolicy(context: VerifyContext): Policy {
	const project = realpathOrSelf(context.cwd);
	const roots = context.config.context;
	// A project that contains the home or agent directory is too broad to say that a path inside it is "the project's" (same rule as the runtime).
	const broad = isWithin(project, realpathOrSelf(roots.home)) || isWithin(project, realpathOrSelf(roots.agentDir));
	const bins = projectLocalBinDirs(project).map(realpathOrSelf);
	return {
		grants: new Set((context.approvedProjectLocal ?? []).filter(item => typeof item === "string" && path.isAbsolute(item)).map(item => path.resolve(item))),
		isProjectLocal: file => {
			const lexical = path.resolve(file);
			const real = realpathOrSelf(lexical);
			return bins.some(dir => isWithin(dir, lexical) || isWithin(dir, real)) || (!broad && isWithin(project, real));
		},
	};
}

/** `<typescript>/lib` for a `tsc` that is a regular npm install: where tsserver.js lives. */
function tsserverLibrary(tsc: string): string | undefined {
	try {
		const lib = path.resolve(path.dirname(fs.realpathSync(tsc)), "..", "lib");
		return fs.existsSync(path.join(lib, "tsserver.js")) ? lib : undefined;
	} catch {
		return undefined;
	}
}

// ── Fixture-safe configuration ──────────────────────────────────────────────────────────────────
//
// The disposable fixture only ever receives configuration that cannot execute or read the user's application.
// Known SDK bindings (a TypeScript SDK's tsserver, the approved interpreter, our preserve-ASLR command) pass;
// hooks, linked projects, env, preloads, other init commands and every unrecognised field make the integration
// `unverified`. They are never copied and never silently dropped.

interface Safety {
	readonly policy: Policy;
	/** `<typescript>/lib` of the plan's TypeScript SDK when its executable is usable (outside the project, or exactly granted). */
	readonly tsLibrary: string | undefined;
	readonly problems: string[];
}

type Rule = (value: unknown, safety: Safety) => JsonValue | undefined;
type Shape = Rule | { readonly [field: string]: Shape };

const bool: Rule = value => (typeof value === "boolean" ? value : undefined);
const text: Rule = value => (typeof value === "string" && value.length <= 256 && !value.includes("\0") ? value : undefined);
const finite: Rule = value => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
const strings: Rule = value => (Array.isArray(value) && value.every(item => typeof item === "string" && item !== "" && !item.includes("\0")) ? [...(value as string[])] : undefined);
const oneOf =
	(...allowed: string[]): Rule =>
	value =>
		typeof value === "string" && allowed.includes(value) ? value : undefined;
const primitives: Rule = value =>
	isRecord(value) && Object.values(value).every(member => ["string", "number", "boolean"].includes(typeof member)) ? ({ ...value } as JsonObject) : undefined;
const numbers: Rule = value => (isRecord(value) && Object.values(value).every(member => typeof member === "number" && Number.isFinite(member)) ? ({ ...value } as JsonObject) : undefined);
const booleans: Rule = value => (isRecord(value) && Object.values(value).every(member => typeof member === "boolean") ? ({ ...value } as JsonObject) : undefined);
const preserveAslr: Rule = value => (Array.isArray(value) && value.length === 1 && value[0] === PRESERVE_ASLR ? [PRESERVE_ASLR] : undefined);
/** A path to an existing SDK: fine when it is outside the project, otherwise only when exactly granted. */
const sdkPath: Rule = (value, safety) =>
	typeof value === "string" && path.isAbsolute(value) && (!safety.policy.isProjectLocal(value) || safety.policy.grants.has(path.resolve(value))) ? value : undefined;
const sdkPaths: Rule = (value, safety) => (Array.isArray(value) && value.length > 0 && value.every(item => sdkPath(item, safety) !== undefined) ? [...(value as string[])] : typeof value === "string" ? sdkPath(value, safety) : undefined);
/** tsserver location: any path outside the project, or the library of the TypeScript SDK the user granted. */
const tsserverPath: Rule = (value, safety) => {
	if (typeof value !== "string" || !path.isAbsolute(value)) return undefined;
	if (!safety.policy.isProjectLocal(value)) return value;
	return safety.tsLibrary !== undefined && (value === safety.tsLibrary || value === path.join(safety.tsLibrary, "tsserver.js")) ? value : undefined;
};

const LSP_SHAPE: Shape = {
	fileTypes: strings,
	rootMarkers: strings,
	languageId: text,
	isLinter: bool,
	warmupTimeoutMs: finite,
	capabilities: booleans,
	workspaceReadyTimings: numbers,
	initOptions: { hostInfo: text, preferences: primitives, tsserver: { path: tsserverPath, fallbackPath: tsserverPath } },
	settings: { "rust-analyzer": { checkOnSave: bool }, pylsp: { plugins: { jedi: { environment: sdkPath } } } },
};

const DAP_SHAPE: Shape = {
	languages: strings,
	fileTypes: strings,
	rootMarkers: strings,
	connectMode: oneOf("stdio", "socket", "tcp"),
	acceptsDirectoryProgram: bool,
	launchDefaults: {
		request: oneOf("launch"),
		type: oneOf("pwa-node"),
		mode: oneOf("debug", "exec"),
		terminal: oneOf("console"),
		stopOnEntry: bool,
		justMyCode: bool,
		stopAtBeginningOfMainSubprogram: bool,
		python: sdkPaths,
		initCommands: preserveAslr,
	},
};

function check(value: unknown, shape: Shape, trail: string, safety: Safety): JsonValue | undefined {
	if (typeof shape === "function") {
		const accepted = shape(value, safety);
		if (accepted === undefined) safety.problems.push(trail);
		return accepted;
	}
	if (!isRecord(value)) {
		safety.problems.push(trail);
		return undefined;
	}
	const accepted: JsonObject = {};
	for (const [field, member] of Object.entries(value)) {
		const inner = shape[field];
		if (inner === undefined) {
			safety.problems.push(`${trail}.${field}`);
			continue;
		}
		const checked = check(member, inner, `${trail}.${field}`, safety);
		if (checked !== undefined) accepted[field] = checked;
	}
	return accepted;
}

/** What omp merges for a key: the proposal over the effective entry, DAP `launchDefaults` one level deep. */
function mergeEntry(kind: IntegrationKind, base: ConfigEntryValue | undefined, over: ConfigEntryValue | undefined): Record<string, unknown> {
	const merged: Record<string, unknown> = { ...base, ...over };
	if (kind === "dap" && (isRecord(base?.launchDefaults) || isRecord(over?.launchDefaults))) {
		merged.launchDefaults = { ...(isRecord(base?.launchDefaults) ? base.launchDefaults : {}), ...(isRecord(over?.launchDefaults) ? over.launchDefaults : {}) };
	}
	return merged;
}

// ── Integration setup (static; nothing runs) ────────────────────────────────────────────────────

interface Setup {
	readonly launch: Command;
	/** Entry value per server/adapter key the fixtures use. */
	readonly entries: ReadonlyMap<string, JsonObject>;
}

interface Static {
	readonly config: ConfigSnapshot;
	readonly policy: Policy;
}

function samePath(a: string, b: string): boolean {
	return path.resolve(a) === path.resolve(b) || realpathOrSelf(a) === realpathOrSelf(b);
}

function buildSetup(kind: IntegrationKind, plan: LanguagePlan, integration: ReusePlan | InstallPlan, scope: Static): { readonly setup: Setup } | { readonly result: ToolResult } {
	const { config, policy } = scope;
	const launch = integration.launch;
	const refuse = (status: ToolStatus, detail: string): { result: ToolResult } => ({ result: result(status, detail, launch) });
	if (!isRecord(launch) || typeof launch.command !== "string" || !path.isAbsolute(launch.command) || !Array.isArray(launch.args) || launch.args.some(arg => typeof arg !== "string" || arg.includes("\0"))) {
		return { result: result("unverified", "the plan has no absolute launch command to verify") };
	}
	if (!isExecutableFile(launch.command)) return refuse("missing", `${launch.command} is not an executable file. Install or repair it first; nothing was run.`);
	if (config.unresolved.some(issue => issue.kind === kind)) {
		return refuse("unverified", `omp reads ${kind === "lsp" ? "language server" : "debug adapter"} configuration that could not be inspected (${config.unresolved.filter(issue => issue.kind === kind).map(issue => issue.path).join(", ")}), so shadowing cannot be ruled out.`);
	}
	if (launch.args.some(arg => path.isAbsolute(arg.slice(arg.indexOf("=") + 1)) && policy.isProjectLocal(arg.slice(arg.indexOf("=") + 1)))) {
		return refuse("unverified", "a launch argument points into your project; it is never read by the disposable check.");
	}
	let projectSupplied = integration.status === "reuse" && integration.source === "project-local";
	const tsc = plan.lsp.prerequisites.find(item => item.name === "typescript")?.found?.path;
	const tsUsable = tsc !== undefined && (!policy.isProjectLocal(tsc) || policy.grants.has(path.resolve(tsc)));
	const safety: Safety = { policy, tsLibrary: tsc !== undefined && tsUsable ? tsserverLibrary(tsc) : undefined, problems: [] };
	const entries = new Map<string, JsonObject>();
	const keys = new Set(plan.fixtures.map(fixture => (kind === "lsp" ? fixture.lsp.server : fixture.dap.adapter)));
	for (const key of keys) {
		const proposals = integration.entries.filter(entry => entry.kind === kind);
		const proposal = proposals.find(entry => entry.key === key);
		if (proposals.length > 0 && proposal === undefined) return refuse("unverified", `the plan proposes ${proposals.map(entry => entry.key).join(", ")} but its fixtures exercise ${key}.`);
		const unknown = config.sources.filter(source => source.kind === kind && source.enablement === "unknown" && source.entries.has(key));
		if (unknown.length > 0) return refuse("unverified", `${unknown.map(source => source.path).join(", ")} may also define ${key}; whether omp reads it cannot be determined statically, so shadowing cannot be ruled out.`);
		const effective = effectiveEntry(config, kind, key);
		if (effective !== undefined) {
			if (effective.disabled) return refuse("failed", `${key} is disabled in ${effective.source.path}; the verified entry would not run. Re-enable or remove it yourself.`);
			if (effective.command !== undefined && !samePath(effective.command.path, launch.command)) {
				return refuse("failed", `omp would run ${effective.command.path} for ${key} (configured in ${effective.source.path}), not the verified ${launch.command}; the check does not apply to it.`);
			}
			if (Array.isArray(effective.value.args) && (effective.value.args.length !== launch.args.length || effective.value.args.some((arg, index) => arg !== launch.args[index]))) {
				return refuse("failed", `${key} is configured in ${effective.source.path} with different arguments than the verified launch; the check does not apply to it.`);
			}
			projectSupplied ||= effective.projectSupplied;
		}
		const { command: _command, args: _args, disabled: _disabled, attachDefaults: _attach, ...merged } = mergeEntry(kind, effective?.value, proposal?.value);
		const accepted = check(merged, kind === "lsp" ? LSP_SHAPE : DAP_SHAPE, key, safety);
		if (safety.problems.length > 0 || !isRecord(accepted)) {
			return refuse("unverified", `${key} carries settings the disposable check never copies because they could read or run your application (${safety.problems.slice(0, 6).join(", ")}). Nothing was dropped silently: this integration stays unverified.`);
		}
		const value: JsonObject = { ...accepted, command: launch.command, args: [...launch.args] };
		if (kind === "dap") value.launchDefaults = { ...(isRecord(accepted.launchDefaults) ? accepted.launchDefaults : {}), stopOnEntry: true };
		const tsserver = isRecord(accepted.initOptions) && isRecord(accepted.initOptions.tsserver) ? accepted.initOptions.tsserver : {};
		if (key === "typescript-language-server" && tsserver.path === undefined && tsserver.fallbackPath === undefined) {
			if (tsc !== undefined && !tsUsable) return refuse("unverified", `the TypeScript SDK ${tsc} is inside your project and was not approved, so ${key} cannot be checked.`);
			if (safety.tsLibrary === undefined) return refuse("needs-sdk", `${key} needs a TypeScript SDK with lib/tsserver.js next to its tsc; none was found.`);
			value.initOptions = { ...(isRecord(accepted.initOptions) ? accepted.initOptions : {}), tsserver: { ...tsserver, fallbackPath: safety.tsLibrary } };
		}
		entries.set(key, value);
	}
	if ((projectSupplied || policy.isProjectLocal(launch.command)) && !policy.grants.has(path.resolve(launch.command))) {
		return refuse("unverified", `${launch.command} comes from your project. It was not run; approve that exact path to verify it.`);
	}
	return { setup: { launch, entries } };
}

// ── Private tree, files and environment ─────────────────────────────────────────────────────────

interface Dirs {
	readonly fixture: string;
	readonly home: string;
	readonly out: string;
}

interface Run {
	readonly runtime: Runtime;
	readonly context: VerifyContext;
	readonly limits: VerifyLimits;
	readonly policy: Policy;
	/** The helper's private copy and the natives directory shared by this call's omp processes. */
	readonly helper: string;
	readonly natives: string;
	readonly language: LanguageId;
}

function createRoot(context: VerifyContext): { readonly root: string } | { readonly problem: string } {
	const own = context.config.context;
	const user = [context.cwd, own.home, own.agentDir, own.nativeDir, own.claudeDir, os.homedir()].map(realpathOrSelf);
	for (const candidate of [context.tempRoot, os.tmpdir(), "/tmp"]) {
		if (candidate === undefined) continue;
		const base = realpathOrSelf(candidate);
		if (!fs.existsSync(base) || user.some(dir => isWithin(dir, base))) continue;
		const root = fs.mkdtempSync(path.join(base, "omp-starter-verify-"));
		fs.chmodSync(root, 0o700);
		return { root: fs.realpathSync(root) };
	}
	return { problem: "no temporary directory outside your home, project and omp configuration is available for the private verification tree" };
}

function writeFixtureFiles(root: string, files: readonly FixtureFile[]): void {
	for (const file of files) {
		const target = path.resolve(root, file.path);
		if (path.isAbsolute(file.path) || file.path.includes("\0") || target === root || !isWithin(root, target)) {
			throw new Stop("unverified", `fixture file ${JSON.stringify(clip(file.path, 80))} leaves the fixture directory`);
		}
		fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
		fs.writeFileSync(target, file.content, { mode: file.executable === true ? 0o700 : 0o600 });
	}
}

/** Executes through the runtime, passing project approval only for a project-local executable the caller granted exactly. */
function approval(policy: Policy, executable: string): boolean {
	if (!policy.isProjectLocal(executable)) return false;
	if (!policy.grants.has(path.resolve(executable))) throw new Stop("unverified", `${executable} is inside your project and was not approved; it was not run.`);
	return true;
}

async function build(run: Run, fixture: FixtureCase, fixtureDir: string): Promise<void> {
	for (const step of fixture.build ?? []) {
		const cwd = path.resolve(fixtureDir, step.cwd ?? ".");
		if (!isWithin(fixtureDir, cwd)) throw new Stop("unverified", "a build step leaves the fixture directory");
		const executable = path.isAbsolute(step.command) ? step.command : run.runtime.resolveExecutable(step.command)?.path;
		if (executable === undefined) throw new Stop("missing", `${step.command} was not found on PATH, so ${fixture.id} could not be built. This tool never installs SDKs.`);
		const approved = approval(run.policy, executable);
		try {
			await run.runtime.run(step.command, step.args, {
				cwd,
				...(step.env === undefined ? {} : { env: step.env }),
				...(run.context.signal === undefined ? {} : { signal: run.context.signal }),
				timeoutMs: Math.min(step.timeoutMs ?? run.limits.buildMs, run.limits.buildMs),
				...(approved ? { approvedProjectLocal: true } : {}),
			});
		} catch (error) {
			const stop = toStop(error);
			throw stop.status === "failed" ? new Stop("failed", `fixture build failed (${step.label}): ${stop.message}`) : stop;
		}
	}
}

function helperEnvironment(run: Run, dirs: Dirs): Record<string, string> {
	return {
		HOME: dirs.home,
		XDG_CONFIG_HOME: path.join(dirs.home, ".config"),
		XDG_CACHE_HOME: path.join(dirs.home, ".cache"),
		XDG_DATA_HOME: path.join(dirs.home, ".local", "share"),
		XDG_STATE_HOME: path.join(dirs.home, ".local", "state"),
		TMPDIR: path.join(dirs.home, "tmp"),
		PI_CONFIG_DIR: ".omp",
		PI_CODING_AGENT_DIR: path.join(dirs.home, ".omp", "agent"),
		PI_CONFIG_FILES: path.join(dirs.out, "isolation.yml"),
		PI_NATIVES_DIR: run.natives,
		PI_DISABLE_LSPMUX: "1",
		PI_NO_TITLE: "1",
		OMP_SKIP_SETUP: "1",
		PI_AUTO_QA: "0",
		OTEL_SDK_DISABLED: "true",
		[CASE_VARIABLE]: path.join(dirs.out, "case.json"),
	};
}

function writeIsolation(run: Run, fixture: FixtureCase, dirs: Dirs, setups: Partial<Record<IntegrationKind, Setup>>): void {
	for (const dir of ["tmp", ".config", ".cache", ".local/share", ".local/state", ".omp/agent"]) fs.mkdirSync(path.join(dirs.home, dir), { recursive: true, mode: 0o700 });
	// JSON is valid YAML; the nested mapping is what omp requires.
	const settings = `${JSON.stringify(ISOLATION_SETTINGS, null, 2)}\n`;
	fs.writeFileSync(path.join(dirs.home, ".omp", "agent", "config.yml"), settings, { mode: 0o600 });
	fs.writeFileSync(path.join(dirs.out, "isolation.yml"), settings, { mode: 0o600 });
	fs.mkdirSync(path.join(dirs.fixture, ".omp"), { recursive: true, mode: 0o700 });
	if (setups.lsp !== undefined) {
		const key = fixture.lsp.server;
		const disabled = Object.fromEntries(LSP_COMPETITORS[run.language].filter(name => name !== key).map(name => [name, { disabled: true }]));
		fs.writeFileSync(path.join(dirs.fixture, ".omp", "lsp.json"), JSON.stringify({ servers: { ...disabled, [key]: setups.lsp.entries.get(key) } }), { mode: 0o600 });
	}
	if (setups.dap !== undefined) {
		const key = fixture.dap.adapter;
		fs.writeFileSync(path.join(dirs.fixture, ".omp", "dap.json"), JSON.stringify({ adapters: { [key]: setups.dap.entries.get(key) } }), { mode: 0o600 });
	}
	const request = {
		schema: 1,
		fixture: fixture.id,
		cwd: dirs.fixture,
		observation: path.join(dirs.out, "observation.json"),
		home: dirs.home,
		agentDir: path.join(dirs.home, ".omp", "agent"),
		callSeconds: Math.min(300, Math.max(5, Math.ceil(run.limits.callMs / 1000))),
		readinessMs: run.limits.readinessMs,
		...(setups.lsp === undefined ? {} : { lsp: fixture.lsp }),
		...(setups.dap === undefined ? {} : { dap: fixture.dap }),
	};
	fs.writeFileSync(path.join(dirs.out, "case.json"), JSON.stringify(request), { mode: 0o600 });
}

/** The verifier's own omp must report exactly the isolation settings; anything else means it would run with ambient behavior. */
async function confirmSettings(run: Run, dirs: Dirs, env: Record<string, string>): Promise<void> {
	let listing: unknown;
	try {
		const output = await run.runtime.run(run.context.ompPath, ["config", "list", "--json"], {
			cwd: dirs.fixture,
			env,
			timeoutMs: run.limits.startMs,
			maxOutputBytes: 8 * 1024 * 1024,
			...(run.context.signal === undefined ? {} : { signal: run.context.signal }),
			...(approval(run.policy, run.context.ompPath) ? { approvedProjectLocal: true } : {}),
		});
		listing = JSON.parse(output.stdout);
	} catch (error) {
		const stop = toStop(error);
		throw stop.status === "unverified" ? stop : new Stop("unverified", `omp could not report its effective settings (${stop.message}), so isolation cannot be confirmed.`);
	}
	const wrong = flatten(ISOLATION_SETTINGS)
		.filter(([key, expected]) => !(isRecord(listing) && isRecord(listing[key]) && listing[key].value === expected))
		.map(([key]) => key);
	if (wrong.length > 0) throw new Stop("unverified", `this omp did not apply the isolated settings (${wrong.join(", ")}); it is not verified until it does. Upgrade omp to the tested version.`);
}

// ── The helper process ──────────────────────────────────────────────────────────────────────────

/** Newline-delimited JSON frames from omp's RPC stdout, with bounded memory and a watch for any agent activity. */
class Channel {
	readonly frames: Record<string, unknown>[] = [];
	violation: string | undefined;
	stderr = "";
	exited: ExitStatus | undefined;
	private wake: (() => void) | undefined;

	constructor(private readonly proc: OwnedProcess) {
		let pending = "";
		proc.stdout?.on("data", (chunk: Buffer | string) => {
			pending += chunk.toString();
			for (let at = pending.indexOf("\n"); at >= 0; at = pending.indexOf("\n")) {
				this.accept(pending.slice(0, at));
				pending = pending.slice(at + 1);
			}
			if (pending.length > MAX_FRAME_CHARS) {
				this.violation ??= "omp wrote an oversized frame";
				pending = "";
			}
			this.notify();
		});
		proc.stderr?.on("data", (chunk: Buffer | string) => {
			this.stderr = (this.stderr + chunk.toString()).slice(-STDERR_TAIL);
		});
		void proc.exited.then(status => {
			this.exited = status;
			this.notify();
		});
	}

	private accept(line: string): void {
		let frame: unknown;
		try {
			frame = JSON.parse(line);
		} catch {
			return;
		}
		if (!isRecord(frame)) return;
		if (frame.type === "agent_start" || (frame.type === "prompt_result" && frame.agentInvoked === true)) this.violation ??= "omp started an agent turn, which the verifier never allows";
		if (this.frames.length < MAX_FRAMES) this.frames.push(frame);
		else this.violation ??= "omp wrote too many frames";
	}

	private notify(): void {
		const wake = this.wake;
		this.wake = undefined;
		wake?.();
	}

	private changed(ms: number): Promise<void> {
		const { promise, resolve } = Promise.withResolvers<void>();
		const timer = setTimeout(resolve, ms);
		this.wake = () => {
			clearTimeout(timer);
			resolve();
		};
		return promise;
	}

	send(command: Record<string, unknown>): void {
		this.proc.stdin?.write(`${JSON.stringify(command)}\n`);
	}

	/** `finished` lets the wait end on a fact other than a frame (the helper's completed observation), so no frame ordering is relied on. */
	async expect(match: (frame: Record<string, unknown>) => boolean, timeoutMs: number, what: string, signal: AbortSignal | undefined, finished?: () => boolean): Promise<Record<string, unknown>> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			if (this.violation !== undefined) throw new Stop("failed", this.violation);
			const hit = this.frames.find(match);
			if (hit !== undefined) return hit;
			if (finished?.() === true) return { type: "observation" };
			if (signal?.aborted === true) throw new Stop("unverified", "verification was cancelled");
			if (this.exited !== undefined) {
				const how = this.exited.error ?? (this.exited.signal !== null ? `signal ${this.exited.signal}` : `code ${this.exited.code}`);
				throw new Stop("failed", `omp exited (${how}) before ${what}${this.stderr === "" ? "" : `: ${clip(this.stderr, 300)}`}`);
			}
			const remaining = deadline - Date.now();
			if (remaining <= 0) throw new Stop("failed", `timed out after ${Math.ceil(timeoutMs / 1000)}s waiting for ${what}`);
			await this.changed(Math.min(remaining, 250));
		}
	}
}

/** Confirms the helper command is registered once and that no skills or MCP prompts were exposed (omp's own built-in commands are not the verifier's business). */
function assertHelperOnly(frame: Record<string, unknown>): void {
	const commands = isRecord(frame.data) && Array.isArray(frame.data.commands) ? frame.data.commands.filter(isRecord) : undefined;
	if (frame.success !== true || commands === undefined) throw new Stop("failed", "omp did not list its commands, so a helper-only start cannot be confirmed");
	const own = commands.filter(command => command.name === VERIFY_COMMAND && command.source === "extension");
	if (own.length !== 1) throw new Stop("failed", "omp did not load the verifier helper extension");
	const foreign = commands.filter(command => ["skill", "mcp_prompt"].includes(String(command.source))).map(command => String(command.name));
	if (foreign.length > 0) throw new Stop("failed", `omp exposed skills or MCP prompts (${foreign.slice(0, 5).join(", ")}); isolation failed`);
}

/** Closes stdin so omp can shut down on its own, then sweeps the whole owned tree. Returns what could not be cleaned up. */
async function shutdown(proc: OwnedProcess, limits: VerifyLimits): Promise<string | undefined> {
	try {
		proc.stdin?.end();
	} catch {
		// Already closed.
	}
	const { promise, resolve } = Promise.withResolvers<void>();
	const timer = setTimeout(resolve, limits.shutdownMs);
	void proc.exited.then(() => resolve());
	await promise;
	clearTimeout(timer);
	try {
		const cleanup = await proc.terminate();
		return cleanup.survivors.length > 0 ? `process(es) ${cleanup.survivors.map(survivor => survivor.pid).join(", ")} could not be stopped` : undefined;
	} catch (error) {
		return `it could not be verified that the helper stopped: ${errorMessage(error)}`;
	}
}

function readObservation(file: string): { readonly value?: Observation; readonly problem?: string } {
	let content: string;
	try {
		const stat = fs.statSync(file);
		if (!stat.isFile() || stat.size > 256 * 1024) return { problem: "the helper's observation is not a small regular file" };
		content = fs.readFileSync(file, "utf8");
	} catch {
		return { problem: "the helper wrote no observation" };
	}
	const parsed = parseObservation(content);
	return parsed.ok ? { value: parsed.value } : { problem: parsed.reason };
}

// ── Judging observations against expectations ───────────────────────────────────────────────────

function stage(status: ToolStatus, detail: string, expected?: JsonObject, observed?: JsonObject): StageReport {
	return { status, detail: clip(detail, 400), ...(expected === undefined ? {} : { expected }), ...(observed === undefined ? {} : { observed }) };
}

function judgeLsp(observation: LspObservation, expectation: LspExpectation): StageReport {
	const wanted = `${expectation.definition.file}:${expectation.definition.line}`;
	const expected = { server: expectation.server, definition: wanted };
	const found = observation.locations.slice(0, 5).map(location => `${location.file}:${location.line}`);
	const observed = { server: observation.server ?? null, definitions: found };
	if (observation.status !== "observed") return stage("failed", `the lsp tool gave no usable answer for ${expectation.symbol}: ${observation.detail ?? "no detail"}`, expected, observed);
	if (observation.server !== expectation.server) {
		return stage("failed", `${expectation.symbol} was answered by ${observation.server ?? "an unknown server"}, not ${expectation.server}; an unrelated server cannot vouch for this integration`, expected, observed);
	}
	if (!observation.locations.some(location => location.file === expectation.definition.file && location.line === expectation.definition.line)) {
		return stage("failed", `${expectation.symbol} resolved to ${found.join(", ") || "nothing"}, expected ${wanted}`, expected, observed);
	}
	return stage("ready", `${expectation.symbol} resolves to ${wanted} through ${expectation.server}`, expected, observed);
}

function judgeDap(observation: DapObservation, expectation: DapExpectation): StageReport {
	const wanted = `${expectation.breakpoint.file}:${expectation.breakpoint.line}`;
	const expected = { adapter: expectation.adapter, stop: wanted, variable: `${expectation.variable.name}=${expectation.variable.value}` };
	const observed = {
		adapter: observation.adapter ?? null,
		stop: observation.stop === undefined ? null : `${observation.stop.file}:${observation.stop.line}`,
		variable: observation.variable === undefined ? null : `${observation.variable.name}=${observation.variable.value}`,
		terminated: observation.terminated,
		sessionsAfter: observation.sessionsAfter ?? null,
	};
	if (observation.status !== "observed") return stage("failed", `the debugger check did not complete: ${observation.detail ?? "no detail"}`, expected, observed);
	if (observation.adapter !== expectation.adapter) return stage("failed", `omp launched ${observation.adapter ?? "an unknown adapter"}, not ${expectation.adapter}`, expected, observed);
	if (observation.stop?.file !== expectation.breakpoint.file || observation.stop.line !== expectation.breakpoint.line) {
		return stage("failed", `the debugger stopped at ${observed.stop ?? "no location"}, expected the breakpoint at ${wanted}`, expected, observed);
	}
	if (observation.variable?.name !== expectation.variable.name || observation.variable.value !== expectation.variable.value) {
		return stage("failed", `${expectation.variable.name} was ${observation.variable?.value ?? "not found"}, expected ${expectation.variable.value}`, expected, observed);
	}
	if (!observation.terminated || observation.sessionsAfter !== 0) return stage("failed", "the debug session was not torn down cleanly", expected, observed);
	return stage("ready", `stopped at ${wanted} through ${expectation.adapter} and read ${expectation.variable.name}=${expectation.variable.value}`, expected, observed);
}

function judgeFixture(fixture: FixtureCase, setups: Partial<Record<IntegrationKind, Setup>>, observation: Observation, dirs: Dirs, gap: Stop | undefined): FixtureReport {
	const lost = (): StageReport => (gap === undefined ? stage("failed", "the helper reported no result for this phase") : stage(gap.status, gap.message));
	if (!observation.sdk.ok) {
		const detail = `this omp does not provide the public SDK exports the verifier needs (${observation.sdk.missing.join(", ")}). Upgrade omp to the tested version, then verify again.`;
		return { fixture: fixture.id, ...(setups.lsp === undefined ? {} : { lsp: stage("unverified", detail) }), ...(setups.dap === undefined ? {} : { dap: stage("unverified", detail) }) };
	}
	const { cwd, home, agentDir } = observation.environment;
	if (cwd !== dirs.fixture || home !== dirs.home || agentDir !== path.join(dirs.home, ".omp", "agent")) {
		const detail = `the helper ran in ${clip(cwd, 120)} with HOME ${clip(home, 120)} instead of the private tree; isolation failed`;
		return { fixture: fixture.id, ...(setups.lsp === undefined ? {} : { lsp: stage("failed", detail) }), ...(setups.dap === undefined ? {} : { dap: stage("failed", detail) }) };
	}
	return {
		fixture: fixture.id,
		...(setups.lsp === undefined ? {} : { lsp: observation.lsp === undefined ? lost() : judgeLsp(observation.lsp, fixture.lsp) }),
		...(setups.dap === undefined ? {} : { dap: observation.dap === undefined ? lost() : judgeDap(observation.dap, fixture.dap) }),
	};
}

// ── One fixture ─────────────────────────────────────────────────────────────────────────────────

async function runFixture(run: Run, fixture: FixtureCase, setups: Partial<Record<IntegrationKind, Setup>>): Promise<{ readonly report: FixtureReport; readonly cleanup?: string }> {
	const { runtime, context, limits } = run;
	const directories: WorkDir[] = [];
	let cleanup: string | undefined;
	try {
		const fixtureDir = await runtime.workDir(`fixture-${fixture.id}`);
		const homeDir = await runtime.workDir(`home-${fixture.id}`);
		const outDir = await runtime.workDir(`out-${fixture.id}`);
		directories.push(fixtureDir, homeDir, outDir);
		const dirs: Dirs = { fixture: fixtureDir.path, home: homeDir.path, out: outDir.path };
		writeFixtureFiles(dirs.fixture, fixture.files);
		await build(run, fixture, dirs.fixture);
		writeIsolation(run, fixture, dirs, setups);
		const env = helperEnvironment(run, dirs);
		await confirmSettings(run, dirs, env);

		const args = ["--model", STARTUP_MODEL, "--mode", "rpc", "--no-ui", "--no-session", "--no-extensions", "--no-skills", "--no-rules", "--no-tools", "-e", run.helper];
		const proc = await runtime.spawn(context.ompPath, args, {
			cwd: dirs.fixture,
			env,
			stdin: "pipe",
			...(context.signal === undefined ? {} : { signal: context.signal }),
			...(approval(run.policy, context.ompPath) ? { approvedProjectLocal: true } : {}),
		});
		let gap: Stop | undefined;
		let report: FixtureReport | undefined;
		try {
			const channel = new Channel(proc);
			await channel.expect(frame => frame.type === "ready", limits.startMs, "omp to start", context.signal);
			channel.send({ id: "commands", type: "get_available_commands" });
			assertHelperOnly(await channel.expect(frame => frame.type === "response" && frame.id === "commands", limits.callMs, "omp's command list", context.signal));
			channel.send({ id: "verify", type: "prompt", message: `/${VERIFY_COMMAND}` });
			try {
				// Completion is the helper's finished observation or the prompt_result; a failed response means omp refused the command.
				const observationFile = path.join(dirs.out, "observation.json");
				const done = await channel.expect(
					frame => frame.id === "verify" && (frame.type === "prompt_result" || (frame.type === "response" && frame.success === false)),
					limits.helperMs,
					"the helper command",
					context.signal,
					() => readObservation(observationFile).value?.complete === true,
				);
				const reason = isRecord(done.error) ? String(done.error.message) : typeof done.error === "string" ? done.error : "";
				if (done.type === "response" || done.status === "error") gap = new Stop("failed", `the helper command failed${reason === "" ? "" : `: ${clip(reason, 200)}`}`);
			} catch (error) {
				gap = toStop(error);
			}
			if (channel.violation !== undefined) throw new Stop("failed", channel.violation);
			const read = readObservation(path.join(dirs.out, "observation.json"));
			if (read.value === undefined) throw gap ?? new Stop("failed", read.problem ?? "the helper wrote no observation");
			report = judgeFixture(fixture, setups, read.value, dirs, gap);
		} finally {
			cleanup = await shutdown(proc, limits);
		}
		return { report: report as FixtureReport, ...(cleanup === undefined ? {} : { cleanup }) };
	} catch (error) {
		const stop = toStop(error);
		const failed = stage(stop.status, stop.message);
		return { report: { fixture: fixture.id, ...(setups.lsp === undefined ? {} : { lsp: failed }), ...(setups.dap === undefined ? {} : { dap: failed }) }, ...(cleanup === undefined ? {} : { cleanup }) };
	} finally {
		await Promise.all(directories.map(directory => directory.remove().catch(() => undefined)));
	}
}

// ── Entry point ─────────────────────────────────────────────────────────────────────────────────

const SEVERITY: readonly ToolStatus[] = ["failed", "unverified", "missing", "needs-sdk", "unsupported", "skipped", "ready"];

function combine(reports: readonly FixtureReport[], kind: IntegrationKind, launch: Command): ToolResult {
	const stages = reports.flatMap(report => (report[kind] === undefined ? [] : [{ fixture: report.fixture, stage: report[kind] as StageReport }]));
	if (stages.length === 0) return result("unverified", "nothing was verified", launch);
	const worst = [...stages].sort((a, b) => SEVERITY.indexOf(a.stage.status) - SEVERITY.indexOf(b.stage.status))[0] as (typeof stages)[number];
	if (worst.stage.status !== "ready") return result(worst.stage.status, `${worst.fixture}: ${worst.stage.detail}`, launch);
	return result("ready", stages.map(item => `${item.fixture}: ${item.stage.detail}`).join("; "), launch);
}

/** Cleanup that cannot be shown to be complete is never a pass. */
function afterCleanup(value: ToolResult, problem: string | undefined): ToolResult {
	if (problem === undefined) return value;
	return { ...value, status: value.status === "ready" ? "failed" : value.status, detail: clip(`${value.detail} Cleanup could not be confirmed: ${problem}`) };
}

export async function verifyLanguage(plan: LanguagePlan, context: VerifyContext): Promise<Verification> {
	const results: Partial<Record<IntegrationKind, ToolResult>> = {};
	const finish = (observations: readonly FixtureReport[] = []): Verification => ({
		lsp: results.lsp ?? result("unverified", "nothing was verified"),
		dap: results.dap ?? result("unverified", "nothing was verified"),
		observations,
	});
	const problem = planProblem(plan);
	if (problem !== undefined) {
		for (const kind of KINDS) results[kind] = result("unverified", problem);
		return finish();
	}
	// A blocked integration keeps the planner's own status; it can never become ready here.
	const active: IntegrationKind[] = [];
	for (const kind of KINDS) {
		const integration = plan[kind];
		if (integration.status === "blocked") {
			results[kind] = integration.result.status === "ready" ? result("unverified", integration.result.detail) : result(integration.result.status, integration.result.detail, integration.result.command);
		} else {
			active.push(kind);
		}
	}
	if (active.length === 0) return finish();
	const stopAll = (status: ToolStatus, detail: string): Verification => {
		for (const kind of active) results[kind] = result(status, detail);
		return finish();
	};
	if (context.consent !== true) return stopAll("unverified", "Verification builds disposable fixtures with your existing SDKs and runs the approved tools in them. It starts only after you confirm; nothing was run.");
	const variants = variantsProblem(plan);
	if (variants !== undefined) return stopAll("unverified", variants);

	const scope: Static = { config: context.config, policy: makePolicy(context) };
	const setups: Partial<Record<IntegrationKind, Setup>> = {};
	for (const kind of active) {
		const integration = plan[kind] as ReusePlan | InstallPlan;
		const built = buildSetup(kind, plan, integration, scope);
		if ("result" in built) results[kind] = built.result;
		else setups[kind] = built.setup;
	}
	const runnable = active.filter(kind => setups[kind] !== undefined);
	if (runnable.length === 0) return finish();
	if (typeof context.ompPath !== "string" || !path.isAbsolute(context.ompPath) || !isExecutableFile(context.ompPath)) {
		for (const kind of runnable) results[kind] = result("unverified", "the omp executable could not be found, so the real tools cannot be driven.", setups[kind]?.launch);
		return finish();
	}
	const created = createRoot(context);
	if ("problem" in created) {
		for (const kind of runnable) results[kind] = result("unverified", created.problem, setups[kind]?.launch);
		return finish();
	}

	const limits = limitsFor(context);
	const runtime = createRuntime({
		// The runtime owns the private tree. It keeps the real project as its cwd only to recognise project-local executables.
		agentDir: path.join(created.root, "agent"),
		cwd: context.cwd,
		env: context.env ?? process.env,
		...(context.signal === undefined ? {} : { signal: context.signal }),
	});
	const reports: FixtureReport[] = [];
	let cleanup: string | undefined;
	try {
		const natives = path.join(created.root, "natives");
		fs.mkdirSync(natives, { mode: 0o700 });
		const helperDir = await runtime.workDir("helper");
		const helper = path.join(helperDir.path, "verifier-extension.ts");
		fs.copyFileSync(fileURLToPath(new URL("./verifier-extension.ts", import.meta.url)), helper);
		const run: Run = { runtime, context, limits, policy: scope.policy, helper, natives, language: plan.language };
		for (const fixture of plan.fixtures) {
			if (context.signal?.aborted === true) {
				reports.push({ fixture: fixture.id, ...(setups.lsp === undefined ? {} : { lsp: stage("unverified", "verification was cancelled") }), ...(setups.dap === undefined ? {} : { dap: stage("unverified", "verification was cancelled") }) });
				continue;
			}
			context.onProgress?.(`Verifying ${plan.language}: ${fixture.label}`);
			const outcome = await runFixture(run, fixture, setups);
			reports.push(outcome.report);
			cleanup ??= outcome.cleanup;
		}
	} catch (error) {
		const stop = toStop(error);
		for (const kind of runnable) results[kind] = result(stop.status, stop.message, setups[kind]?.launch);
	} finally {
		try {
			const swept = await runtime.dispose();
			if (swept.survivors.length > 0) cleanup ??= `process(es) ${swept.survivors.map(survivor => survivor.pid).join(", ")} could not be stopped`;
		} catch (error) {
			cleanup ??= errorMessage(error);
		}
		if (cleanup === undefined) {
			try {
				await removeTree(created.root);
			} catch (error) {
				cleanup = `the private directory ${created.root} could not be removed: ${errorMessage(error)}`;
			}
		}
	}
	for (const kind of runnable) {
		const launch = setups[kind]?.launch as Command;
		if (results[kind] === undefined) results[kind] = combine(reports, kind, launch);
		results[kind] = afterCleanup(results[kind] as ToolResult, cleanup);
	}
	return finish(reports);
}
