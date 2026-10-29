#!/usr/bin/env bun
// Strict end-to-end smoke for guided language tooling (`/starter tools`).
//
//   bun scripts/tooling-smoke.ts                  all five groups, seven fixture variants (JS and mapped TS, Python, Go, Rust, C and C++)
//   bun scripts/tooling-smoke.ts --typescript7    separate follow-up: JavaScript/TypeScript only, with an existing TypeScript 7 `tsc`
//   options: --report=<file> writes the JSON evidence, --keep keeps the private tree (it holds the installed tools)
//
// There is no stand-in anywhere in this file. The production `/starter` command is registered from
// extensions/setup.ts and its `tools` handler runs against a scripted terminal UI, so the real wizard installs the
// pinned tools, drives omp's own `lsp` and `debug` tools against disposable fixtures and writes the real
// configuration. A second pass then calls the production planners and `verifyLanguage` to read back the concrete
// observations: the resolved definition, the breakpoint stop and the `answer` value for every fixture.
//
// Everything runs in a child process whose HOME, XDG and agent directories are private, because the product's
// state and snapshot modules read HOME once at import time. The child starts from an allowlisted environment
// (no tokens); only the SDK locations that must stay real (PATH, RUSTUP_HOME and CARGO_HOME captured before HOME
// is replaced, GOROOT, proxy and certificate settings) are passed on. SDKs are never installed here: a missing or
// unsuitable SDK makes the product report `needs-sdk` and this script exit nonzero.
//
// The parent judges the raw evidence itself; a child that reports success proves nothing.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import type { ToolingState } from "../extensions/lib/state";
import type { LanguageId, ToolResult } from "../extensions/lib/tooling/types";
import type { FixtureReport } from "../extensions/lib/tooling/verify";

// ── Contract ────────────────────────────────────────────────────────────────────────────────────

type Mode = "full" | "typescript7";

const ALL_GROUPS: readonly LanguageId[] = ["javascript", "python", "go", "rust", "cpp"];
/** The fixture variants every group must prove. A missing, extra or duplicated one is not a smaller check, it is no check. */
const VARIANTS: Readonly<Record<LanguageId, readonly string[]>> = {
	javascript: ["javascript", "typescript"],
	python: ["python"],
	go: ["go"],
	rust: ["rust"],
	cpp: ["c", "cpp"],
};
const LABELS: Readonly<Record<LanguageId, string>> = {
	javascript: "JavaScript / TypeScript",
	python: "Python",
	go: "Go",
	rust: "Rust",
	cpp: "C / C++",
};
const GROUPS: Readonly<Record<Mode, readonly LanguageId[]>> = { full: ALL_GROUPS, typescript7: ["javascript"] };
const TSC_MAJOR: Readonly<Record<Mode, number>> = { full: 6, typescript7: 7 };

const CHILD_TIMEOUT_MS = 55 * 60_000;
const PROBE_TIMEOUT_MS = 30_000;
const NOTIFICATION_CHARS = 6_000;
const CUSTOM_LSP = "smoke-custom-ls";
const CUSTOM_DAP = "smoke-custom-dap";
const VERIFY_PREFIX = "omp-starter-verify-";
const CREDENTIAL_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|COOKIE)/i;

/** The only parent variables the child sees besides PATH: proxy and certificate settings and explicit SDK locations. */
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
	"RUSTUP_TOOLCHAIN",
	"DEVELOPER_DIR",
	"SDKROOT",
	"BUN_INSTALL",
];

// ── Evidence ────────────────────────────────────────────────────────────────────────────────────

interface Notification {
	readonly type: string;
	readonly message: string;
}

interface RunEvidence {
	readonly label: string;
	readonly languages: readonly LanguageId[];
	readonly prompts: string[];
	readonly notifications: Notification[];
	readonly statusTexts: string[];
	/** Prompts the scripted UI did not expect; each one is a failure. */
	readonly unexpected: string[];
	listenersRegistered: number;
	listenersRemoved: number;
	cancelTriggered: boolean;
	statusCleared: boolean;
	durationMs: number;
	/** The handler's own "Installed this run" line, when it printed one. */
	installed?: string;
	tooling?: ToolingState;
	stateProblems: string[];
}

interface FilesEvidence {
	/** Every key of the state file except `tooling`. */
	readonly stateOther: Record<string, unknown> | null;
	readonly lspServers: Record<string, unknown> | null;
	readonly dapAdapters: Record<string, unknown> | null;
	readonly lspSha256: string | null;
	readonly dapSha256: string | null;
}

interface GroupEvidence {
	readonly language: LanguageId;
	readonly plan: { readonly lsp: string; readonly dap: string; readonly fixtures: readonly string[] };
	readonly lsp: ToolResult;
	readonly dap: ToolResult;
	readonly observations: readonly FixtureReport[];
}

interface ChildReport {
	schema: 1;
	mode: Mode;
	isolation: {
		root: string;
		home: string;
		homeIsPrivate: boolean;
		stateFile: string;
		agentDir: string;
		project: string;
		ompPath: string | null;
		credentialVariables: string[];
	};
	productLanguageIds: string[];
	productVariants: Record<string, string[]>;
	commandRegistered: boolean;
	toolingExistedBeforeFirstRun: boolean;
	seeds: { state: Record<string, unknown>; lsp: Record<string, unknown>; dap: Record<string, unknown> };
	runs: Partial<Record<"first" | "second" | "cancelled", RunEvidence>>;
	files: Partial<Record<"afterFirst" | "afterSecond" | "afterCancelled", FilesEvidence>>;
	toolingFingerprint: Partial<Record<"afterFirst" | "afterSecond", string | null>>;
	groups: Partial<Record<LanguageId, GroupEvidence>>;
	leftoverVerifierTrees: string[];
	fatal: string[];
}

interface Probe {
	readonly name: string;
	readonly command: string;
	readonly ok: boolean;
	readonly output: string;
}

// ── Small helpers ───────────────────────────────────────────────────────────────────────────────

function log(message: string): void {
	process.stderr.write(`[smoke ${new Date().toISOString().slice(11, 19)}] ${message}\n`);
}

function describeError(error: unknown): string {
	return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

function sha256(data: string | Buffer): string {
	return crypto.createHash("sha256").update(data).digest("hex");
}

function isDirectory(target: string): boolean {
	try {
		return fs.statSync(target).isDirectory();
	} catch {
		return false;
	}
}

function readJsonFile(file: string): { value: Record<string, unknown> | null; sha: string | null } {
	let text: string;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch {
		return { value: null, sha: null };
	}
	try {
		const parsed: unknown = JSON.parse(text);
		return { value: typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null, sha: sha256(text) };
	} catch {
		return { value: null, sha: sha256(text) };
	}
}

function member(value: Record<string, unknown> | null, key: string): Record<string, unknown> | null {
	const found = value?.[key];
	return typeof found === "object" && found !== null && !Array.isArray(found) ? (found as Record<string, unknown>) : null;
}

/** Recursive delete that also handles read-only trees (Go module cache, immutable tool publications). Links are never followed. */
function removeTree(target: string): void {
	const makeWritable = (entry: string): void => {
		let stat: fs.Stats;
		try {
			stat = fs.lstatSync(entry);
		} catch {
			return;
		}
		if (!stat.isDirectory()) return;
		try {
			fs.chmodSync(entry, 0o700);
			for (const name of fs.readdirSync(entry)) makeWritable(path.join(entry, name));
		} catch {
			// removal below reports what could not be cleaned
		}
	};
	makeWritable(target);
	fs.rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
}

function argValue(args: readonly string[], name: string): string | undefined {
	const prefix = `--${name}=`;
	return args.find(arg => arg.startsWith(prefix))?.slice(prefix.length);
}

// ── Child: the production wizard, driven through the registered command ─────────────────────────

interface StarterCommand {
	handler(args: string, ctx: unknown): Promise<void>;
}

interface ScriptedOptions {
	readonly languages: readonly LanguageId[];
	readonly cancelWhenVerifying: boolean;
}

function clipMessage(text: string): string {
	return text.length > NOTIFICATION_CHARS ? `${text.slice(0, NOTIFICATION_CHARS)}...` : text;
}

/** Terminal UI scripted like a user who agrees to everything the wizard asks for the selected languages. */
function scriptedUi(options: ScriptedOptions, evidence: RunEvidence) {
	let terminalInput: ((data: string) => { consume?: boolean } | undefined) | undefined;
	const wanted = new Set(options.languages.map(id => LABELS[id]));
	let rounds = 0;
	return {
		notify(message: string, type: "info" | "warning" | "error" = "info"): void {
			evidence.notifications.push({ type, message: clipMessage(message) });
		},
		async confirm(title: string, message: string): Promise<boolean> {
			evidence.prompts.push(`confirm: ${title}`);
			if (title === "Language tooling (optional)" || title === "Install, verify and apply?") return true;
			// The smoke project is an empty directory: nothing project-local may be offered, and none may be approved.
			evidence.unexpected.push(`confirm "${title}": ${clipMessage(message).slice(0, 200)}`);
			return false;
		},
		async select(title: string, choices: string[]): Promise<string | undefined> {
			evidence.prompts.push(`select: ${title}`);
			if (!title.includes("pick a language")) {
				evidence.unexpected.push(`select "${title}"`);
				return undefined;
			}
			rounds += 1;
			if (rounds > 12) {
				evidence.unexpected.push("the language picker did not settle");
				return undefined;
			}
			for (const label of Object.values(LABELS)) {
				if (!choices.some(choice => choice.endsWith(label))) evidence.unexpected.push(`the picker does not offer ${label}`);
			}
			const next = choices.find(choice => choice.startsWith("[ ] ") && wanted.has(choice.slice(4)));
			if (next !== undefined) return next;
			const proceed = choices.find(choice => choice.startsWith("Continue with "));
			if (proceed === undefined) evidence.unexpected.push("the picker has no Continue option for the selection");
			return proceed;
		},
		async input(title: string): Promise<string | undefined> {
			evidence.unexpected.push(`input "${title}"`);
			return undefined;
		},
		setStatus(_key: string, text: string | undefined): void {
			evidence.statusCleared = text === undefined;
			if (text === undefined) return;
			evidence.statusTexts.push(text.length > 200 ? `${text.slice(0, 200)}...` : text);
			// A real Esc, delivered through the wizard's own terminal-input hook while verification is running.
			if (options.cancelWhenVerifying && !evidence.cancelTriggered && text.startsWith("Verifying") && terminalInput !== undefined) {
				evidence.cancelTriggered = true;
				terminalInput("\x1b");
			}
		},
		onTerminalInput(handler: (data: string) => { consume?: boolean } | undefined): () => void {
			evidence.listenersRegistered += 1;
			terminalInput = handler;
			return () => {
				evidence.listenersRemoved += 1;
				if (terminalInput === handler) terminalInput = undefined;
			};
		},
	};
}

/** Path, type and identity of the installed tools down to depth 3; deeper files (bytecode caches) may legitimately change. */
function toolingFingerprint(agentDir: string): string | null {
	const root = path.join(agentDir, "tooling");
	if (!isDirectory(root)) return null;
	const lines: string[] = [];
	const walk = (dir: string, depth: number): void => {
		for (const name of fs.readdirSync(dir).sort()) {
			if (depth === 0 && name.startsWith(".")) continue;
			const entry = path.join(dir, name);
			const stat = fs.lstatSync(entry);
			const relative = path.relative(root, entry);
			if (stat.isSymbolicLink()) lines.push(`${relative}|link|${fs.readlinkSync(entry)}`);
			else if (stat.isDirectory()) {
				lines.push(`${relative}|dir|${stat.ino}`);
				if (depth < 2) walk(entry, depth + 1);
			} else lines.push(`${relative}|file|${stat.ino}|${stat.size}|${stat.mtimeMs}`);
		}
	};
	walk(root, 0);
	return sha256(lines.join("\n"));
}

function filesEvidence(stateFile: string, agentDir: string): FilesEvidence {
	const state = readJsonFile(stateFile);
	const lsp = readJsonFile(path.join(agentDir, "lsp.json"));
	const dap = readJsonFile(path.join(agentDir, "dap.json"));
	const { tooling: _tooling, ...other } = state.value ?? {};
	return {
		stateOther: state.value === null ? null : other,
		lspServers: member(lsp.value, "servers"),
		dapAdapters: member(dap.value, "adapters"),
		lspSha256: lsp.sha,
		dapSha256: dap.sha,
	};
}

function listVerifierTrees(): Set<string> {
	try {
		return new Set(fs.readdirSync("/tmp").filter(name => name.startsWith(VERIFY_PREFIX)));
	} catch {
		return new Set();
	}
}

async function childMain(args: readonly string[]): Promise<void> {
	const root = argValue(args, "root");
	const mode = argValue(args, "mode") as Mode | undefined;
	if (root === undefined || (mode !== "full" && mode !== "typescript7")) throw new Error("--child needs --root and --mode");
	const report: ChildReport = {
		schema: 1,
		mode,
		isolation: { root, home: os.homedir(), homeIsPrivate: false, stateFile: "", agentDir: "", project: path.join(root, "project"), ompPath: null, credentialVariables: [] },
		productLanguageIds: [],
		productVariants: {},
		commandRegistered: false,
		toolingExistedBeforeFirstRun: false,
		seeds: { state: {}, lsp: {}, dap: {} },
		runs: {},
		files: {},
		toolingFingerprint: {},
		groups: {},
		leftoverVerifierTrees: [],
		fatal: [],
	};
	try {
		await runChild(report, root, mode);
	} catch (error) {
		report.fatal.push(describeError(error));
	} finally {
		fs.writeFileSync(path.join(root, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
	}
}

async function runChild(report: ChildReport, root: string, mode: Mode): Promise<void> {
	const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
	const load = (relative: string): Promise<any> => import(pathToFileURL(path.join(repo, relative)).href);
	const languages = GROUPS[mode];
	const project = report.isolation.project;
	const realRoot = fs.realpathSync(root);

	report.isolation.credentialVariables = Object.keys(process.env).filter(name => CREDENTIAL_NAME.test(name));
	// Everything below imports modules that read HOME once. They must see the private one.
	const state = await load("extensions/lib/state.ts");
	report.isolation.stateFile = state.STATE_FILE;
	report.isolation.homeIsPrivate = fs.realpathSync(os.homedir()) === path.join(realRoot, "home") && fs.realpathSync(path.dirname(path.dirname(path.dirname(state.STATE_FILE)))) === path.join(realRoot, "home");
	if (!report.isolation.homeIsPrivate) throw new Error(`HOME ${os.homedir()} is not the private home; refusing to touch anything`);

	const productTooling = await load("extensions/lib/tooling.ts");
	const types = await load("extensions/lib/tooling/types.ts");
	const verify = await load("extensions/lib/tooling/verify.ts");
	const configModule = await load("extensions/lib/tooling/config.ts");
	const managed = await load("extensions/lib/tooling/managed.ts");
	const native = await load("extensions/lib/tooling/native.ts");
	const runtimeModule = await load("extensions/lib/tooling/runtime.ts");
	const setup = await load("extensions/setup.ts");
	report.productLanguageIds = [...types.LANGUAGE_IDS];
	report.productVariants = Object.fromEntries(Object.entries(verify.REQUIRED_VARIANTS).map(([id, ids]) => [id, [...(ids as string[])]]));

	// The production environment resolution: the native agent directory and the omp executable the wizard will drive.
	const environment: { agentDir: string; ompPath: string | undefined } = await productTooling.resolveToolingEnvironment(project);
	const { agentDir, ompPath } = environment;
	report.isolation.agentDir = agentDir;
	report.isolation.ompPath = ompPath ?? null;
	if (path.relative(path.join(realRoot, "home"), path.resolve(agentDir)).startsWith("..")) throw new Error(`the native agent directory ${agentDir} is outside the private home`);
	if (ompPath === undefined) throw new Error("no omp executable was found on PATH, so the wizard cannot drive the real tools");

	// The registered command, exactly as omp registers it. Nothing but `tools` is invoked, and pi.exec is never expected.
	const commands = new Map<string, StarterCommand>();
	const pi = {
		on: (): void => undefined,
		registerCommand: (name: string, definition: StarterCommand): void => void commands.set(name, definition),
		exec: async (): Promise<never> => {
			throw new Error("pi.exec is not expected while running /starter tools");
		},
	};
	setup.default(pi);
	const starter = commands.get("starter");
	report.commandRegistered = starter !== undefined;
	if (starter === undefined) throw new Error("extensions/setup.ts did not register /starter");

	// Seeds that must survive: unrelated state keys and user-owned LSP/DAP entries.
	fs.mkdirSync(agentDir, { recursive: true });
	report.seeds.state = { agentSkills: "skipped", models: "done", "x-smoke-custom": { keep: [1, 2, 3], nested: { a: true } } };
	report.seeds.lsp = { command: "/usr/bin/true", fileTypes: [".smoke"], rootMarkers: ["smoke.marker"] };
	report.seeds.dap = { command: "/usr/bin/true", args: [], fileTypes: [".smoke"] };
	fs.writeFileSync(state.STATE_FILE, `${JSON.stringify(report.seeds.state, null, 2)}\n`);
	fs.writeFileSync(path.join(agentDir, "lsp.json"), `${JSON.stringify({ servers: { [CUSTOM_LSP]: report.seeds.lsp } }, null, 2)}\n`);
	fs.writeFileSync(path.join(agentDir, "dap.json"), `${JSON.stringify({ adapters: { [CUSTOM_DAP]: report.seeds.dap } }, null, 2)}\n`);
	report.toolingExistedBeforeFirstRun = isDirectory(path.join(agentDir, "tooling"));
	const verifiersBefore = listVerifierTrees();

	const runCommand = async (label: "first" | "second" | "cancelled", cancelWhenVerifying: boolean): Promise<void> => {
		const evidence: RunEvidence = {
			label,
			languages,
			prompts: [],
			notifications: [],
			statusTexts: [],
			unexpected: [],
			listenersRegistered: 0,
			listenersRemoved: 0,
			cancelTriggered: false,
			statusCleared: false,
			durationMs: 0,
			stateProblems: [],
		};
		report.runs[label] = evidence;
		const started = Date.now();
		log(`/starter tools (${label}): ${languages.join(", ")}`);
		const ui = scriptedUi({ languages, cancelWhenVerifying }, evidence);
		await starter.handler("tools", { ui, cwd: project, hasUI: true, mode: "tui" });
		evidence.durationMs = Date.now() - started;
		const summary = evidence.notifications.map(item => item.message).find(message => message.startsWith("Language tooling:"));
		evidence.installed = summary?.split("\n").find(line => line.startsWith("Installed this run"));
		const read = state.readTooling(state.STATE_FILE);
		evidence.tooling = read.tooling;
		evidence.stateProblems = read.problems;
		for (const line of summary?.split("\n") ?? []) log(`  ${line}`);
	};

	await runCommand("first", false);
	report.files.afterFirst = filesEvidence(state.STATE_FILE, agentDir);
	report.toolingFingerprint.afterFirst = toolingFingerprint(agentDir);

	await runCommand("second", false);
	report.files.afterSecond = filesEvidence(state.STATE_FILE, agentDir);
	report.toolingFingerprint.afterSecond = toolingFingerprint(agentDir);

	await runCommand("cancelled", true);
	report.files.afterCancelled = filesEvidence(state.STATE_FILE, agentDir);

	// Concrete observations from the production planners and verifier, against the tools the command just installed.
	for (const language of languages) {
		log(`observing ${language}`);
		const runtime = runtimeModule.createRuntime({ agentDir, cwd: project, env: process.env });
		try {
			const snapshot = await configModule.inspectConfig({ cwd: project, agentDir });
			const context = { runtime, config: snapshot };
			const options = { approvedProjectLocal: [] as string[] };
			const plan = await (language === "javascript"
				? managed.planJavascript(context, options)
				: language === "python"
					? managed.planPython(context, options)
					: language === "go"
						? managed.planGo(context, options)
						: language === "rust"
							? native.planRust(context)
							: native.planCpp(context));
			const verification = await verify.verifyLanguage(plan, {
				ompPath,
				cwd: project,
				config: snapshot,
				consent: true,
				approvedProjectLocal: [],
				env: process.env,
				onProgress: (message: string) => log(`  ${message}`),
			});
			report.groups[language] = {
				language,
				plan: { lsp: plan.lsp.status, dap: plan.dap.status, fixtures: plan.fixtures.map((fixture: { id: string }) => fixture.id) },
				lsp: verification.lsp,
				dap: verification.dap,
				observations: verification.observations,
			};
		} catch (error) {
			report.fatal.push(`${language}: ${describeError(error)}`);
		} finally {
			await runtime.dispose();
		}
	}

	report.leftoverVerifierTrees = [...listVerifierTrees()].filter(name => !verifiersBefore.has(name));
}

// ── Parent: judging the evidence ────────────────────────────────────────────────────────────────

function ids(values: readonly string[]): string {
	return [...values].sort().join(",");
}

function stageProblems(prefix: string, stage: { status?: string; expected?: Record<string, unknown>; observed?: Record<string, unknown> } | undefined, kind: "lsp" | "dap"): string[] {
	if (stage === undefined) return [`${prefix}: no ${kind} observation`];
	const found: string[] = [];
	if (stage.status !== "ready") found.push(`${prefix}: ${kind} is ${stage.status ?? "missing"}, not ready`);
	const { expected, observed } = stage;
	if (expected === undefined || observed === undefined) return [...found, `${prefix}: ${kind} carries no expected/observed evidence`];
	if (kind === "lsp") {
		const definitions = observed.definitions;
		if (typeof expected.server !== "string" || observed.server !== expected.server) found.push(`${prefix}: lsp answered by ${String(observed.server)}, expected ${String(expected.server)}`);
		if (typeof expected.definition !== "string" || !Array.isArray(definitions) || !definitions.includes(expected.definition)) {
			found.push(`${prefix}: lsp definitions ${JSON.stringify(definitions)} do not contain ${String(expected.definition)}`);
		}
		return found;
	}
	if (typeof expected.adapter !== "string" || observed.adapter !== expected.adapter) found.push(`${prefix}: dap adapter ${String(observed.adapter)}, expected ${String(expected.adapter)}`);
	if (typeof expected.stop !== "string" || observed.stop !== expected.stop) found.push(`${prefix}: dap stopped at ${String(observed.stop)}, expected the breakpoint ${String(expected.stop)}`);
	if (expected.variable !== "answer=42" || observed.variable !== "answer=42") found.push(`${prefix}: dap read ${String(observed.variable)}, expected answer=42`);
	if (observed.terminated !== true || observed.sessionsAfter !== 0) found.push(`${prefix}: the debug session was not torn down (terminated=${String(observed.terminated)}, sessionsAfter=${String(observed.sessionsAfter)})`);
	return found;
}

function runProblems(name: string, run: RunEvidence | undefined, groups: readonly LanguageId[], expectation: "done" | "incomplete"): string[] {
	if (run === undefined) return [`${name}: the /starter tools run produced no evidence`];
	const found: string[] = [];
	for (const item of run.unexpected) found.push(`${name}: unexpected prompt ${item}`);
	for (const item of run.notifications) if (item.type === "error") found.push(`${name}: error notification: ${item.message.slice(0, 300)}`);
	for (const problem of run.stateProblems) found.push(`${name}: saved tooling state is invalid: ${problem}`);
	if (run.listenersRegistered === 0 || run.listenersRegistered !== run.listenersRemoved) found.push(`${name}: terminal-input listeners registered ${run.listenersRegistered}, removed ${run.listenersRemoved}`);
	if (!run.statusCleared) found.push(`${name}: the status line was left set`);
	const tooling = run.tooling;
	if (tooling === undefined) return [...found, `${name}: no tooling state was saved`];
	if (tooling.status !== expectation) found.push(`${name}: tooling status is ${tooling.status}, expected ${expectation}`);
	if (ids(tooling.selected) !== ids(groups)) found.push(`${name}: selected [${tooling.selected.join(",")}], expected [${groups.join(",")}]`);
	for (const group of groups) {
		const record = tooling.results[group];
		for (const kind of ["lsp", "dap"] as const) {
			const result = record?.[kind];
			if (result?.status !== "ready") found.push(`${name}: ${group} ${kind} is ${result?.status ?? "absent"}: ${result?.detail ?? "no result"}`);
		}
	}
	return found;
}

function preservationProblems(name: string, files: FilesEvidence | undefined, seeds: ChildReport["seeds"]): string[] {
	if (files === undefined) return [`${name}: no file evidence`];
	const found: string[] = [];
	if (files.stateOther === null || !isDeepStrictEqual(files.stateOther, seeds.state)) found.push(`${name}: unrelated omp-starter.json keys changed`);
	if (files.lspServers === null || !isDeepStrictEqual(files.lspServers[CUSTOM_LSP], seeds.lsp)) found.push(`${name}: the user's custom lsp.json entry was not preserved`);
	if (files.dapAdapters === null || !isDeepStrictEqual(files.dapAdapters[CUSTOM_DAP], seeds.dap)) found.push(`${name}: the user's custom dap.json entry was not preserved`);
	return found;
}

function validate(report: ChildReport, mode: Mode): string[] {
	const found: string[] = [...report.fatal.map(item => `child failed: ${item.split("\n")[0]}`)];
	const groups = GROUPS[mode];
	if (report.schema !== 1 || report.mode !== mode) found.push("the child report has the wrong schema or mode");
	if (!report.isolation.homeIsPrivate) found.push("the child did not run with a private HOME");
	if (report.isolation.credentialVariables.length > 0) found.push(`credential-like variables reached the child: ${report.isolation.credentialVariables.join(", ")}`);
	if (ids(report.productLanguageIds) !== ids(ALL_GROUPS)) found.push(`the product offers [${report.productLanguageIds.join(",")}], this smoke covers [${ALL_GROUPS.join(",")}]`);
	for (const group of ALL_GROUPS) {
		if (ids(report.productVariants[group] ?? []) !== ids(VARIANTS[group])) found.push(`the product requires variants [${(report.productVariants[group] ?? []).join(",")}] for ${group}, this smoke expects [${VARIANTS[group].join(",")}]`);
	}
	if (!report.commandRegistered) found.push("the /starter command was not registered");
	if (report.toolingExistedBeforeFirstRun) found.push("the private home already held installed tools, so the first run is not a fresh install");

	found.push(...runProblems("first run", report.runs.first, groups, "done"));
	if (report.runs.first !== undefined && report.runs.first.installed === undefined) found.push("first run: nothing was installed (no \"Installed this run\" line), so fresh installation was not exercised");
	found.push(...runProblems("second run", report.runs.second, groups, "done"));
	if (report.runs.second?.installed !== undefined) found.push(`second run: installed tools again instead of reusing them (${report.runs.second.installed})`);
	if (report.toolingFingerprint.afterFirst === null || report.toolingFingerprint.afterFirst === undefined) found.push("no installed-tool fingerprint after the first run");
	else if (report.toolingFingerprint.afterFirst !== report.toolingFingerprint.afterSecond) found.push("the installed tool directories changed during the second run: tools were not reused as installed");
	if (report.files.afterFirst?.lspSha256 !== report.files.afterSecond?.lspSha256 || report.files.afterFirst?.dapSha256 !== report.files.afterSecond?.dapSha256) {
		found.push("the second run rewrote lsp.json or dap.json although every entry was already applied");
	}

	const cancelled = report.runs.cancelled;
	// A cancelled rerun keeps what earlier runs proved but is itself incomplete, and every owned resource is released.
	found.push(...runProblems("cancelled run", cancelled, groups, "incomplete"));
	if (cancelled !== undefined) {
		if (!cancelled.cancelTriggered) found.push("cancelled run: Esc was never delivered, so cancellation was not exercised");
		if (!cancelled.notifications.some(item => item.message.includes("cancelled"))) found.push("cancelled run: the summary does not disclose the cancellation");
	}
	found.push(...preservationProblems("after first run", report.files.afterFirst, report.seeds));
	found.push(...preservationProblems("after second run", report.files.afterSecond, report.seeds));
	found.push(...preservationProblems("after cancelled run", report.files.afterCancelled, report.seeds));
	if (report.leftoverVerifierTrees.length > 0) found.push(`verifier trees left behind in /tmp: ${report.leftoverVerifierTrees.join(", ")}`);

	let variants = 0;
	for (const group of groups) {
		const evidence = report.groups[group];
		if (evidence === undefined) {
			found.push(`${group}: no verification evidence`);
			continue;
		}
		for (const kind of ["lsp", "dap"] as const) {
			if (evidence.plan[kind] !== "reuse") found.push(`${group}: the ${kind} plan is "${evidence.plan[kind]}" after the installs; installed tools must be reused`);
			if (evidence[kind].status !== "ready") found.push(`${group}: ${kind} is ${evidence[kind].status}: ${evidence[kind].detail}`);
		}
		const seen = evidence.observations.map(item => item.fixture);
		if (ids(seen) !== ids(VARIANTS[group]) || new Set(seen).size !== seen.length) found.push(`${group}: verified fixtures [${seen.join(",")}], required [${VARIANTS[group].join(",")}]`);
		if (ids(evidence.plan.fixtures) !== ids(VARIANTS[group])) found.push(`${group}: planned fixtures [${evidence.plan.fixtures.join(",")}], required [${VARIANTS[group].join(",")}]`);
		for (const fixture of evidence.observations) {
			variants += 1;
			found.push(...stageProblems(`${group}/${fixture.fixture}`, fixture.lsp, "lsp"));
			found.push(...stageProblems(`${group}/${fixture.fixture}`, fixture.dap, "dap"));
		}
	}
	const required = groups.reduce((total, group) => total + VARIANTS[group].length, 0);
	if (variants !== required) found.push(`${variants} fixture variants were observed, ${required} are required`);
	for (const group of Object.keys(report.groups)) if (!groups.includes(group as LanguageId)) found.push(`unexpected group ${group} in the evidence`);
	return found;
}

// ── Parent: orchestration ───────────────────────────────────────────────────────────────────────

function probe(name: string, command: string, args: readonly string[], env: NodeJS.ProcessEnv, cwd: string): Probe {
	const result = spawnSync(command, [...args], { env, cwd, encoding: "utf8", timeout: PROBE_TIMEOUT_MS, maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
	const text = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim().split("\n")[0] ?? "";
	return { name, command: [command, ...args].join(" "), ok: result.status === 0 && result.error === undefined, output: text.slice(0, 200) };
}

/** Existing SDKs and tools exactly as the product will see them. Nothing is installed; a missing one is a failure. */
function inspectToolchain(mode: Mode, env: NodeJS.ProcessEnv, cwd: string): { probes: Probe[]; problems: string[] } {
	const probes: Probe[] = [
		probe("omp", "omp", ["--version"], env, cwd),
		probe("node", "node", ["--version"], env, cwd),
		probe("npm", "npm", ["--version"], env, cwd),
		probe("tsc", "tsc", ["--version"], env, cwd),
	];
	const problems: string[] = [];
	const required = new Set(["omp", "node", "npm", "tsc"]);
	if (mode === "full") {
		probes.push(
			probe("python3", "python3", ["--version"], env, cwd),
			probe("python venv/ensurepip", "python3", ["-c", "import ensurepip, venv; print('ensurepip and venv available')"], env, cwd),
			probe("go", "go", ["version"], env, cwd),
			probe("rustc", "rustc", ["--version"], env, cwd),
			probe("cargo", "cargo", ["--version"], env, cwd),
			probe("rustc sysroot", "rustc", ["--print", "sysroot"], env, cwd),
			probe("cc", "cc", ["--version"], env, cwd),
			probe("c++", "c++", ["--version"], env, cwd),
		);
		for (const name of ["python3", "python venv/ensurepip", "go", "rustc", "cargo", "rustc sysroot", "cc", "c++"]) required.add(name);
	}
	for (const item of probes) {
		if (required.has(item.name) && !item.ok) problems.push(`required prerequisite "${item.name}" is unavailable (${item.command}): ${item.output || "no output"}`);
	}
	const sysroot = probes.find(item => item.name === "rustc sysroot");
	if (sysroot?.ok === true && !isDirectory(path.join(sysroot.output, "lib", "rustlib", "src"))) {
		problems.push(`the Rust toolchain at ${sysroot.output} has no rust-src component (rustup component add rust-src)`);
	}
	const tsc = probes.find(item => item.name === "tsc");
	if (tsc?.ok === true && !new RegExp(`^Version ${TSC_MAJOR[mode]}\\.`).test(tsc.output)) {
		problems.push(mode === "full" ? `the full matrix requires TypeScript 6, found "${tsc.output}"; the TypeScript 7 check is the separate --typescript7 run` : `--typescript7 requires an existing TypeScript 7 tsc, found "${tsc.output}"`);
	}
	return { probes, problems };
}

function configFingerprint(home: string): Record<string, string | null> {
	const result: Record<string, string | null> = {};
	for (const name of ["omp-starter.json", "lsp.json", "dap.json", "config.yml"]) {
		try {
			result[name] = sha256(fs.readFileSync(path.join(home, ".omp", "agent", name)));
		} catch {
			result[name] = null;
		}
	}
	try {
		const stat = fs.lstatSync(path.join(home, ".omp", "agent", "tooling"));
		result.tooling = `${stat.ino}:${stat.mtimeMs}`;
	} catch {
		result.tooling = null;
	}
	return result;
}

function childEnvironment(root: string, originalHome: string): { env: NodeJS.ProcessEnv; sdkHomes: Record<string, string> } {
	const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin" };
	for (const name of PASS_THROUGH) {
		const value = process.env[name];
		if (value !== undefined && value !== "") env[name] = value;
	}
	// rustup and cargo keep toolchains under HOME. Capture the real homes before HOME is replaced so the proxies still find the installed SDK.
	const sdkHomes: Record<string, string> = {};
	for (const [name, directory] of [
		["RUSTUP_HOME", ".rustup"],
		["CARGO_HOME", ".cargo"],
	] as const) {
		const configured = process.env[name];
		const found = configured !== undefined && configured !== "" ? configured : isDirectory(path.join(originalHome, directory)) ? path.join(originalHome, directory) : undefined;
		if (found !== undefined) {
			env[name] = found;
			sdkHomes[name] = found;
		}
	}
	Object.assign(env, {
		HOME: path.join(root, "home"),
		XDG_CONFIG_HOME: path.join(root, "xdg", "config"),
		XDG_CACHE_HOME: path.join(root, "xdg", "cache"),
		XDG_DATA_HOME: path.join(root, "xdg", "data"),
		XDG_STATE_HOME: path.join(root, "xdg", "state"),
		TERM: "dumb",
		NO_COLOR: "1",
		GOTOOLCHAIN: "local",
		RUSTUP_AUTO_INSTALL: "0",
		GIT_TERMINAL_PROMPT: "0",
	});
	return { env, sdkHomes };
}

function groupAlive(pid: number): boolean {
	try {
		process.kill(-pid, 0);
		return true;
	} catch (error) {
		return typeof error === "object" && error !== null && "code" in error && error.code === "EPERM";
	}
}

function killGroup(pid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(-pid, signal);
	} catch {
		// already gone
	}
}

async function runChildProcess(script: string, root: string, mode: Mode, env: NodeJS.ProcessEnv): Promise<{ exit: string; timedOut: boolean; stray: boolean }> {
	const child: ChildProcess = spawn(process.execPath, [script, "--child", `--root=${root}`, `--mode=${mode}`], {
		cwd: path.join(root, "project"),
		env,
		detached: true,
		stdio: ["ignore", "inherit", "inherit"],
	});
	const pid = child.pid;
	if (pid === undefined) throw new Error("the smoke child process did not start");
	let timedOut = false;
	const abort = (signal: NodeJS.Signals): void => {
		killGroup(pid, "SIGTERM");
		setTimeout(() => killGroup(pid, "SIGKILL"), 5_000).unref();
		log(`${signal} received: stopping the smoke child`);
	};
	const onInterrupt = (): void => abort("SIGINT");
	process.once("SIGINT", onInterrupt);
	process.once("SIGTERM", onInterrupt);
	const timer = setTimeout(() => {
		timedOut = true;
		log(`the smoke child exceeded ${CHILD_TIMEOUT_MS / 60_000} minutes; stopping it`);
		killGroup(pid, "SIGTERM");
		setTimeout(() => killGroup(pid, "SIGKILL"), 5_000).unref();
	}, CHILD_TIMEOUT_MS);
	const settled = Promise.withResolvers<string>();
	child.once("error", error => settled.resolve(`spawn error: ${error.message}`));
	child.once("exit", (code, signal) => settled.resolve(signal !== null ? `signal ${signal}` : `code ${code}`));
	const exit = await settled.promise;
	clearTimeout(timer);
	process.off("SIGINT", onInterrupt);
	process.off("SIGTERM", onInterrupt);
	// Anything still alive in the child's process group survived the product's own cleanup.
	await Bun.sleep(500);
	const stray = groupAlive(pid);
	if (stray) killGroup(pid, "SIGKILL");
	return { exit, timedOut, stray };
}

function summarize(report: ChildReport | undefined, mode: Mode): string[] {
	const lines: string[] = [];
	for (const group of GROUPS[mode]) {
		const evidence = report?.groups[group];
		if (evidence === undefined) {
			lines.push(`${LABELS[group]}: no evidence`);
			continue;
		}
		lines.push(`${LABELS[group]}: lsp ${evidence.lsp.status}, dap ${evidence.dap.status}`);
		for (const fixture of evidence.observations) {
			lines.push(`  ${fixture.fixture} lsp ${fixture.lsp?.status ?? "-"}: ${fixture.lsp?.detail ?? "no observation"}`);
			lines.push(`  ${fixture.fixture} dap ${fixture.dap?.status ?? "-"}: ${fixture.dap?.detail ?? "no observation"}`);
		}
	}
	return lines;
}

async function parentMain(args: readonly string[]): Promise<number> {
	if (args.includes("--help") || args.includes("-h")) {
		process.stdout.write("usage: bun scripts/tooling-smoke.ts [--typescript7] [--report=<file>] [--keep]\n");
		return 0;
	}
	if (process.versions.bun === undefined) {
		process.stderr.write("tooling-smoke must run under Bun: bun scripts/tooling-smoke.ts\n");
		return 1;
	}
	const mode: Mode = args.includes("--typescript7") ? "typescript7" : "full";
	const reportFile = argValue(args, "report");
	const keep = args.includes("--keep");
	const originalHome = os.homedir();
	const script = fileURLToPath(import.meta.url);
	const base = fs.existsSync("/tmp") ? "/tmp" : os.tmpdir();
	// Short on purpose: debugger sockets live below the private tree.
	const root = fs.realpathSync(fs.mkdtempSync(path.join(base, "omp-starter-smoke-")));
	for (const directory of ["home", "project", "xdg/config", "xdg/cache", "xdg/data", "xdg/state"]) fs.mkdirSync(path.join(root, directory), { recursive: true, mode: 0o700 });
	fs.chmodSync(root, 0o700);

	const problems: string[] = [];
	let childReport: ChildReport | undefined;
	let exit = "not started";
	try {
		const { env, sdkHomes } = childEnvironment(root, originalHome);
		log(`mode ${mode}; private tree ${root}`);
		log(`SDK homes kept real: ${Object.entries(sdkHomes).map(([name, value]) => `${name}=${value}`).join(" ") || "none"}`);
		const toolchain = inspectToolchain(mode, env, path.join(root, "project"));
		for (const item of toolchain.probes) log(`${item.ok ? "ok  " : "FAIL"} ${item.name}: ${item.output}`);
		problems.push(...toolchain.problems);

		const before = configFingerprint(originalHome);
		const outcome = await runChildProcess(script, root, mode, env);
		const after = configFingerprint(originalHome);
		exit = outcome.exit;
		if (outcome.timedOut) problems.push("the smoke child timed out");
		if (outcome.stray) problems.push("processes owned by the smoke child survived its exit (they were killed)");
		if (outcome.exit !== "code 0") problems.push(`the smoke child ended with ${outcome.exit}`);
		if (!isDeepStrictEqual(before, after)) problems.push(`the original user configuration under ${originalHome}/.omp/agent was modified`);

		try {
			childReport = JSON.parse(fs.readFileSync(path.join(root, "report.json"), "utf8")) as ChildReport;
			problems.push(...validate(childReport, mode));
		} catch (error) {
			problems.push(`no readable child report: ${error instanceof Error ? error.message : String(error)}`);
		}

		if (reportFile !== undefined) {
			const final = { schema: 1, mode, generatedAt: new Date().toISOString(), platform: { os: process.platform, arch: process.arch, bun: process.versions.bun }, toolchain: toolchain.probes, sdkHomes, childExit: exit, passed: problems.length === 0, problems, evidence: childReport ?? null };
			fs.mkdirSync(path.dirname(path.resolve(reportFile)), { recursive: true });
			fs.writeFileSync(reportFile, `${JSON.stringify(final, null, 2)}\n`);
		}
	} finally {
		if (keep) log(`kept ${root}`);
		else {
			try {
				removeTree(root);
			} catch (error) {
				problems.push(`the private tree ${root} could not be removed: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}

	const lines = summarize(childReport, mode);
	process.stdout.write(`${lines.join("\n")}\n`);
	if (problems.length > 0) {
		process.stdout.write(`\nFAILED (${mode}): ${problems.length} problem(s)\n${problems.map(item => `- ${item}`).join("\n")}\n`);
		return 1;
	}
	const variants = GROUPS[mode].reduce((total, group) => total + VARIANTS[group].length, 0);
	process.stdout.write(`\nPASSED (${mode}): ${GROUPS[mode].length} group(s), ${variants} fixture variant(s); every LSP and DAP ready with observed definition, breakpoint stop and answer=42\n`);
	return 0;
}

const argv = process.argv.slice(2);
if (argv.includes("--child")) {
	await childMain(argv);
} else {
	process.exitCode = await parentMain(argv);
}
