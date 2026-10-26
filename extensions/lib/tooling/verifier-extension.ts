// Fixture-verification helper (design C2): an omp extension that only the verifier's private omp RPC
// process ever loads (`omp -e <this file>` with every other extension, skill, rule and tool disabled).
// It registers exactly one slash command. The command never starts an agent turn and never calls a
// provider: it drives omp's own public `LspTool` and `DebugTool` against one disposable fixture and
// writes what it observed as JSON for the verifier to judge.
//
// Nothing here is an LSP or DAP client. Every protocol exchange goes through the SDK tools exported by
// `pi.pi`, exactly as the model-facing tools do, so a pass proves omp's own integration works.
//
// This file must stay self-contained: the verifier copies it next to nothing, so it imports only
// Node built-ins (the SDK import is type-only and erased). It also holds the shared case/observation
// contract that `verify.ts` imports.
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// ── Contract shared with verify.ts ──────────────────────────────────────────────────────────────

/** The one slash command this extension registers. */
export const VERIFY_COMMAND = "starter-verify-fixture";
/** Environment variable carrying the absolute path of the case file. */
export const CASE_VARIABLE = "OMP_STARTER_VERIFY_CASE";
export const OBSERVATION_SCHEMA = 1;

const MAX_FILE_BYTES = 256 * 1024;
const MAX_TEXT = 400;
const MAX_ITEMS = 32;
const POLL_MS = 400;
/** Time `set_breakpoint` is repeated while the adapter still reports the breakpoint unbound (source maps resolve asynchronously). */
const BIND_WINDOW_MS = 10_000;
/** Resumes allowed before a stop that is not the breakpoint (entry stops, pauses) is reported as a failure. */
const MAX_RESUMES = 6;
const MAX_SCOPES = 6;

export interface LspSpec {
	readonly server: string;
	readonly file: string;
	readonly line: number;
	readonly symbol: string;
	readonly definition: { readonly file: string; readonly line: number };
}

export interface DapSpec {
	readonly adapter: string;
	readonly program: string;
	readonly cwd?: string;
	readonly args?: readonly string[];
	readonly breakpoint: { readonly file: string; readonly line: number };
	readonly variable: { readonly name: string; readonly value: string };
}

/** What the verifier asks the helper to observe for one fixture. Paths in `lsp`/`dap` are fixture-relative. */
export interface CaseSpec {
	readonly schema: 1;
	readonly fixture: string;
	/** Real path of the fixture directory (the helper's working directory). */
	readonly cwd: string;
	/** Where the observation JSON is written (outside the fixture). */
	readonly observation: string;
	readonly home: string;
	readonly agentDir: string;
	/** Per protocol call ceiling, in seconds (the SDK tools accept 5..300). */
	readonly callSeconds: number;
	/** Aggregate readiness-polling window for each of the LSP and DAP phases. */
	readonly readinessMs: number;
	readonly lsp?: LspSpec;
	readonly dap?: DapSpec;
}

export interface LocationObservation {
	/** Fixture-relative POSIX path; a location outside the fixture keeps its `..` prefix and so never matches. */
	readonly file: string;
	/** 1-based line. */
	readonly line: number;
}

export interface LspObservation {
	readonly status: "observed" | "error";
	readonly detail?: string;
	/** `details.serverName` of the answering server. */
	readonly server?: string;
	readonly attempts: number;
	readonly locations: readonly LocationObservation[];
	readonly elapsedMs: number;
}

export interface StopObservation {
	readonly file: string;
	readonly line: number;
	readonly frameName?: string;
}

export interface DapObservation {
	readonly status: "observed" | "error";
	readonly detail?: string;
	/** `details.adapter` of the launch result: the adapter omp actually used. */
	readonly adapter?: string;
	readonly breakpoint?: { readonly file: string; readonly line: number; readonly verified: boolean };
	readonly stop?: StopObservation;
	readonly variable?: { readonly name: string; readonly value: string; readonly scope: string };
	/** The debug session was terminated without error. */
	readonly terminated: boolean;
	/** Sessions still listed after termination; anything but 0 means the debugger was not torn down. */
	readonly sessionsAfter?: number;
	readonly elapsedMs: number;
}

export interface Observation {
	readonly schema: 1;
	readonly fixture: string;
	/** `ok: false` lists the public SDK exports this omp does not provide. */
	readonly sdk: { readonly ok: true } | { readonly ok: false; readonly missing: readonly string[] };
	/** What the helper process itself runs under; the verifier checks it against the private paths it created. */
	readonly environment: { readonly cwd: string; readonly home: string; readonly agentDir: string };
	readonly lsp?: LspObservation;
	readonly dap?: DapObservation;
	/** The command finished every phase it was asked for. */
	readonly complete: boolean;
}

/** This module is loaded standalone from a private copy, so it cannot import the shared guard; this is its one object guard. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clip(text: string, max = MAX_TEXT): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function string(value: unknown, max = 1024): string | undefined {
	return typeof value === "string" && value.length <= max && !value.includes("\0") ? value : undefined;
}

function line(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 10_000_000 ? value : undefined;
}

function relativeFile(value: unknown): string | undefined {
	const file = string(value, 512);
	if (file === undefined || file === "" || path.isAbsolute(file) || file.split(/[\\/]/).includes("..")) return undefined;
	return file;
}

/** A fixture-relative path may also be the fixture root itself (`.`), for a Go package directory. */
function relativeTarget(value: unknown): string | undefined {
	return value === "." ? "." : relativeFile(value);
}

export function parseCaseSpec(text: string): CaseSpec {
	const parsed: unknown = JSON.parse(text);
	if (!isRecord(parsed) || parsed.schema !== OBSERVATION_SCHEMA) throw new Error("not a version 1 case");
	const fixture = string(parsed.fixture, 64);
	const cwd = string(parsed.cwd);
	const observation = string(parsed.observation);
	const home = string(parsed.home);
	const agentDir = string(parsed.agentDir);
	const callSeconds = parsed.callSeconds;
	const readinessMs = parsed.readinessMs;
	if (fixture === undefined || cwd === undefined || observation === undefined || home === undefined || agentDir === undefined) {
		throw new Error("case is missing a field");
	}
	for (const absolute of [cwd, observation, home, agentDir]) {
		if (!path.isAbsolute(absolute)) throw new Error("case paths must be absolute");
	}
	if (typeof callSeconds !== "number" || !Number.isInteger(callSeconds) || callSeconds < 5 || callSeconds > 300) throw new Error("callSeconds must be 5..300");
	if (typeof readinessMs !== "number" || !Number.isInteger(readinessMs) || readinessMs < 1 || readinessMs > 600_000) throw new Error("readinessMs must be 1..600000");
	let lsp: LspSpec | undefined;
	if (parsed.lsp !== undefined) {
		const raw = parsed.lsp;
		if (!isRecord(raw) || !isRecord(raw.definition)) throw new Error("lsp is malformed");
		const server = string(raw.server, 128);
		const file = relativeFile(raw.file);
		const symbol = string(raw.symbol, 256);
		const at = line(raw.line);
		const definitionFile = relativeFile(raw.definition.file);
		const definitionLine = line(raw.definition.line);
		if (server === undefined || file === undefined || symbol === undefined || symbol === "" || at === undefined || definitionFile === undefined || definitionLine === undefined) {
			throw new Error("lsp is malformed");
		}
		lsp = { server, file, line: at, symbol, definition: { file: definitionFile, line: definitionLine } };
	}
	let dap: DapSpec | undefined;
	if (parsed.dap !== undefined) {
		const raw = parsed.dap;
		if (!isRecord(raw) || !isRecord(raw.breakpoint) || !isRecord(raw.variable)) throw new Error("dap is malformed");
		const adapter = string(raw.adapter, 128);
		const program = relativeTarget(raw.program);
		const breakpointFile = relativeFile(raw.breakpoint.file);
		const breakpointLine = line(raw.breakpoint.line);
		const name = string(raw.variable.name, 128);
		const value = string(raw.variable.value, 256);
		const cwdRelative = raw.cwd === undefined ? undefined : relativeTarget(raw.cwd);
		if (adapter === undefined || program === undefined || breakpointFile === undefined || breakpointLine === undefined || name === undefined || value === undefined) {
			throw new Error("dap is malformed");
		}
		if (raw.cwd !== undefined && cwdRelative === undefined) throw new Error("dap cwd is malformed");
		let args: string[] | undefined;
		if (raw.args !== undefined) {
			if (!Array.isArray(raw.args) || raw.args.length > MAX_ITEMS || !raw.args.every(item => string(item, 512) !== undefined)) throw new Error("dap args are malformed");
			args = [...(raw.args as string[])];
		}
		dap = {
			adapter,
			program,
			...(cwdRelative === undefined ? {} : { cwd: cwdRelative }),
			...(args === undefined ? {} : { args }),
			breakpoint: { file: breakpointFile, line: breakpointLine },
			variable: { name, value },
		};
	}
	return { schema: 1, fixture, cwd, observation, home, agentDir, callSeconds, readinessMs, ...(lsp === undefined ? {} : { lsp }), ...(dap === undefined ? {} : { dap }) };
}

function parseLocation(value: unknown): LocationObservation | undefined {
	if (!isRecord(value)) return undefined;
	const file = string(value.file, 512);
	const at = line(value.line);
	return file === undefined || at === undefined ? undefined : { file, line: at };
}

function parseLsp(value: unknown): LspObservation | undefined {
	if (!isRecord(value)) return undefined;
	const status = value.status;
	const attempts = value.attempts;
	const elapsedMs = value.elapsedMs;
	if ((status !== "observed" && status !== "error") || typeof attempts !== "number" || typeof elapsedMs !== "number") return undefined;
	if (!Array.isArray(value.locations) || value.locations.length > MAX_ITEMS) return undefined;
	const locations: LocationObservation[] = [];
	for (const item of value.locations) {
		const parsed = parseLocation(item);
		if (parsed === undefined) return undefined;
		locations.push(parsed);
	}
	const detail = value.detail === undefined ? undefined : string(value.detail);
	const server = value.server === undefined ? undefined : string(value.server, 128);
	if ((value.detail !== undefined && detail === undefined) || (value.server !== undefined && server === undefined)) return undefined;
	return { status, attempts, elapsedMs, locations, ...(detail === undefined ? {} : { detail }), ...(server === undefined ? {} : { server }) };
}

function parseDap(value: unknown): DapObservation | undefined {
	if (!isRecord(value)) return undefined;
	const status = value.status;
	if ((status !== "observed" && status !== "error") || typeof value.terminated !== "boolean" || typeof value.elapsedMs !== "number") return undefined;
	const detail = value.detail === undefined ? undefined : string(value.detail);
	const adapter = value.adapter === undefined ? undefined : string(value.adapter, 128);
	if ((value.detail !== undefined && detail === undefined) || (value.adapter !== undefined && adapter === undefined)) return undefined;
	let breakpoint: DapObservation["breakpoint"];
	if (value.breakpoint !== undefined) {
		const raw = value.breakpoint;
		const file = isRecord(raw) ? string(raw.file, 512) : undefined;
		const at = isRecord(raw) ? line(raw.line) : undefined;
		if (!isRecord(raw) || file === undefined || at === undefined || typeof raw.verified !== "boolean") return undefined;
		breakpoint = { file, line: at, verified: raw.verified };
	}
	let stop: StopObservation | undefined;
	if (value.stop !== undefined) {
		const raw = value.stop;
		const file = isRecord(raw) ? string(raw.file, 512) : undefined;
		const at = isRecord(raw) ? line(raw.line) : undefined;
		const frameName = isRecord(raw) && raw.frameName !== undefined ? string(raw.frameName, 256) : undefined;
		if (!isRecord(raw) || file === undefined || at === undefined || (raw.frameName !== undefined && frameName === undefined)) return undefined;
		stop = { file, line: at, ...(frameName === undefined ? {} : { frameName }) };
	}
	let variable: DapObservation["variable"];
	if (value.variable !== undefined) {
		const raw = value.variable;
		const name = isRecord(raw) ? string(raw.name, 128) : undefined;
		const text = isRecord(raw) ? string(raw.value, 512) : undefined;
		const scope = isRecord(raw) ? string(raw.scope, 128) : undefined;
		if (!isRecord(raw) || name === undefined || text === undefined || scope === undefined) return undefined;
		variable = { name, value: text, scope };
	}
	const sessionsAfter = value.sessionsAfter;
	if (sessionsAfter !== undefined && (typeof sessionsAfter !== "number" || !Number.isInteger(sessionsAfter) || sessionsAfter < 0)) return undefined;
	return {
		status,
		terminated: value.terminated,
		elapsedMs: value.elapsedMs,
		...(detail === undefined ? {} : { detail }),
		...(adapter === undefined ? {} : { adapter }),
		...(breakpoint === undefined ? {} : { breakpoint }),
		...(stop === undefined ? {} : { stop }),
		...(variable === undefined ? {} : { variable }),
		...(sessionsAfter === undefined ? {} : { sessionsAfter: sessionsAfter as number }),
	};
}

/** Strict validation of an observation read from disk: anything that is not exactly this shape is rejected, never repaired. */
export function parseObservation(text: string): { readonly ok: true; readonly value: Observation } | { readonly ok: false; readonly reason: string } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { ok: false, reason: "the observation is not valid JSON" };
	}
	if (!isRecord(parsed) || parsed.schema !== OBSERVATION_SCHEMA) return { ok: false, reason: "the observation has an unexpected schema" };
	const fixture = string(parsed.fixture, 64);
	if (fixture === undefined || typeof parsed.complete !== "boolean") return { ok: false, reason: "the observation is missing fields" };
	const environment = parsed.environment;
	const cwd = isRecord(environment) ? string(environment.cwd) : undefined;
	const home = isRecord(environment) ? string(environment.home) : undefined;
	const agentDir = isRecord(environment) ? string(environment.agentDir) : undefined;
	if (cwd === undefined || home === undefined || agentDir === undefined) return { ok: false, reason: "the observation has no environment" };
	let sdk: Observation["sdk"];
	const rawSdk = parsed.sdk;
	if (isRecord(rawSdk) && rawSdk.ok === true) {
		sdk = { ok: true };
	} else if (isRecord(rawSdk) && rawSdk.ok === false && Array.isArray(rawSdk.missing) && rawSdk.missing.length <= MAX_ITEMS && rawSdk.missing.every(item => string(item, 256) !== undefined)) {
		sdk = { ok: false, missing: [...(rawSdk.missing as string[])] };
	} else {
		return { ok: false, reason: "the observation has no SDK verdict" };
	}
	const lsp = parsed.lsp === undefined ? undefined : parseLsp(parsed.lsp);
	if (parsed.lsp !== undefined && lsp === undefined) return { ok: false, reason: "the LSP observation is malformed" };
	const dap = parsed.dap === undefined ? undefined : parseDap(parsed.dap);
	if (parsed.dap !== undefined && dap === undefined) return { ok: false, reason: "the debugger observation is malformed" };
	return {
		ok: true,
		value: { schema: 1, fixture, sdk, environment: { cwd, home, agentDir }, complete: parsed.complete, ...(lsp === undefined ? {} : { lsp }), ...(dap === undefined ? {} : { dap }) },
	};
}

// ── Public SDK surface (structural; nothing is imported from the SDK at runtime) ────────────────

export interface ToolResultLike {
	readonly content?: readonly { readonly type?: string; readonly text?: string }[];
	readonly details?: unknown;
}

export interface ToolLike {
	execute(toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResultLike>;
}

export interface CaseTools {
	readonly lsp: ToolLike;
	readonly debug: ToolLike;
}

export interface Clock {
	now(): number;
	sleep(ms: number): Promise<void>;
}

export const realClock: Clock = {
	now: () => Date.now(),
	sleep: ms => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, ms);
		return promise;
	},
};

export interface PhaseContext {
	/** Real path of the fixture directory. */
	readonly cwd: string;
	readonly clock: Clock;
	readonly callSeconds: number;
	readonly readinessMs: number;
	readonly signal?: AbortSignal;
}

function textOf(result: ToolResultLike): string {
	const block = result.content?.find(entry => entry.type === "text" && typeof entry.text === "string");
	return block?.text ?? "";
}

function detailsOf(result: ToolResultLike): Record<string, unknown> {
	return isRecord(result.details) ? result.details : {};
}

/** Seconds for one call: never above the ceiling, never below the SDK's 5 second floor, and never past what is left of a window. */
function callBudget(remainingMs: number, ceilingSeconds: number): number {
	return Math.min(ceilingSeconds, Math.max(5, Math.ceil(remainingMs / 1000)));
}

function realpathOrSelf(target: string): string {
	try {
		return fs.realpathSync(target);
	} catch {
		return path.resolve(target);
	}
}

/** Fixture-relative POSIX form of an absolute path. */
function relativeToFixture(cwd: string, absolute: string): string {
	return path.relative(cwd, realpathOrSelf(absolute)).split(path.sep).join("/");
}

// ── LSP: cross-file definition ──────────────────────────────────────────────────────────────────

/**
 * Locations in the text of a raw `textDocument/definition` result. The SDK renders `<server> ← <method>:`
 * on the first line and the JSON result after it; `details` carries no locations. A `Location`, a list of
 * them, `LocationLink`s or `null` are all valid answers. Anything else is malformed, never "no definition".
 */
export function locationsFromText(text: string, cwd: string): { readonly ok: true; readonly locations: LocationObservation[] } | { readonly ok: false; readonly reason: string } {
	const newline = text.indexOf("\n");
	const body = newline < 0 ? text : text.slice(newline + 1);
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return { ok: false, reason: "the language server's answer is not JSON" };
	}
	const items: unknown[] = parsed === null ? [] : Array.isArray(parsed) ? parsed : [parsed];
	if (items.length > 200) return { ok: false, reason: "the language server returned an implausible number of locations" };
	const locations: LocationObservation[] = [];
	for (const item of items) {
		if (!isRecord(item)) return { ok: false, reason: "a returned location is not an object" };
		const uri = item.uri ?? item.targetUri;
		const range = item.range ?? item.targetSelectionRange ?? item.targetRange;
		const start = isRecord(range) && isRecord(range.start) ? range.start.line : undefined;
		if (typeof uri !== "string" || typeof start !== "number" || !Number.isInteger(start) || start < 0) {
			return { ok: false, reason: "a returned location has no usable uri and range" };
		}
		let absolute: string;
		try {
			absolute = fileURLToPath(uri);
		} catch {
			return { ok: false, reason: "a returned location is not a file URI" };
		}
		locations.push({ file: clip(relativeToFixture(cwd, absolute), 400), line: start + 1 });
	}
	return { ok: true, locations };
}

/** Answers that only mean "not ready yet": a server still loading its project. */
const LSP_RETRY = /content modified|server cancelled|request cancelled|cancelled|not ready|still (?:loading|indexing)|workspace (?:is )?(?:loading|not)|timed out|aborted/i;

export async function observeDefinition(spec: LspSpec, tools: ToolLike, context: PhaseContext): Promise<LspObservation> {
	const started = context.clock.now();
	const deadline = started + context.readinessMs;
	const file = path.join(context.cwd, spec.file);
	let attempts = 0;
	let server: string | undefined;
	let last = "the server returned no definition yet";
	const finish = (status: LspObservation["status"], detail: string | undefined, locations: LocationObservation[]): LspObservation => ({
		status,
		attempts,
		locations,
		elapsedMs: context.clock.now() - started,
		...(detail === undefined ? {} : { detail: clip(detail) }),
		...(server === undefined ? {} : { server }),
	});
	for (;;) {
		if (context.signal?.aborted) return finish("error", "cancelled", []);
		const remaining = deadline - context.clock.now();
		if (attempts > 0 && remaining <= 0) break;
		attempts += 1;
		let result: ToolResultLike;
		try {
			result = await tools.execute(
				`verify-lsp-${attempts}`,
				{ action: "request", file, line: spec.line, symbol: spec.symbol, query: "textDocument/definition", timeout: callBudget(remaining, context.callSeconds) },
				context.signal,
			);
		} catch (error) {
			const message = messageOf(error);
			if (context.signal?.aborted || !LSP_RETRY.test(message)) return finish("error", message, []);
			last = message;
			await context.clock.sleep(POLL_MS);
			continue;
		}
		const details = detailsOf(result);
		if (typeof details.serverName === "string") server = clip(details.serverName, 128);
		const text = textOf(result);
		if (details.success !== true) {
			if (!LSP_RETRY.test(text)) return finish("error", text === "" ? "the lsp tool reported failure" : text, []);
			last = text;
			await context.clock.sleep(POLL_MS);
			continue;
		}
		const parsed = locationsFromText(text, context.cwd);
		if (!parsed.ok) return finish("error", parsed.reason, []);
		if (parsed.locations.length > 0) return finish("observed", undefined, parsed.locations);
		await context.clock.sleep(POLL_MS);
	}
	return finish("error", `no definition within ${context.readinessMs}ms: ${last}`, []);
}

// ── DAP: breakpoint, stack, variable ────────────────────────────────────────────────────────────

type SessionWait = "stopped" | "ended" | "timeout";

function frameOf(details: Record<string, unknown>): Record<string, unknown> | undefined {
	const frames = details.stackFrames;
	const first: unknown = Array.isArray(frames) ? frames[0] : undefined;
	return isRecord(first) ? first : undefined;
}

export async function observeBreakpoint(spec: DapSpec, tools: ToolLike, context: PhaseContext): Promise<DapObservation> {
	const started = context.clock.now();
	const program = path.resolve(context.cwd, spec.program);
	const launchCwd = path.resolve(context.cwd, spec.cwd ?? ".");
	const breakpointFile = path.join(context.cwd, spec.breakpoint.file);
	let sequence = 0;
	let launched = false;
	let detail: string | undefined;
	let adapter: string | undefined;
	let breakpoint: DapObservation["breakpoint"];
	let stop: StopObservation | undefined;
	let variable: DapObservation["variable"];
	let terminated = false;
	let sessionsAfter: number | undefined;

	const call = async (action: string, params: Record<string, unknown> = {}, budgetMs?: number): Promise<{ readonly details: Record<string, unknown>; readonly text: string }> => {
		sequence += 1;
		const result = await tools.execute(
			`verify-dap-${sequence}-${action}`,
			{ action, ...params, timeout: callBudget(budgetMs ?? context.callSeconds * 1000, context.callSeconds) },
			context.signal,
		);
		return { details: detailsOf(result), text: textOf(result) };
	};
	const aborted = (): boolean => context.signal?.aborted === true;

	/** Polls the debugger's real session list (no DAP traffic) until a session is stopped, every session ended, or the window closes. */
	const awaitSessions = async (deadline: number): Promise<SessionWait> => {
		for (;;) {
			if (aborted()) throw new Error("cancelled");
			const sessions = (await call("sessions")).details.sessions;
			const list = Array.isArray(sessions) ? sessions.filter(isRecord) : [];
			if (list.some(entry => entry.status === "stopped")) return "stopped";
			if (list.length === 0 || list.every(entry => entry.status === "terminated")) return "ended";
			if (context.clock.now() >= deadline) return "timeout";
			await context.clock.sleep(POLL_MS);
		}
	};

	/** Resumes the debuggee and waits, by polling real session state, for the next stop. */
	const resume = async (deadline: number): Promise<SessionWait> => {
		for (;;) {
			if (aborted()) throw new Error("cancelled");
			const remaining = deadline - context.clock.now();
			if (remaining <= 0) return "timeout";
			let state: unknown;
			try {
				state = (await call("continue", {}, remaining)).details.state;
			} catch (error) {
				// A JavaScript debuggee is a child session that may not exist yet: the root reports no threads until it does.
				if (/reported no threads/i.test(messageOf(error))) {
					await context.clock.sleep(POLL_MS);
					continue;
				}
				throw error;
			}
			if (state === "terminated") return "ended";
			if (state === "stopped") return "stopped";
			return awaitSessions(deadline);
		}
	};

	const locate = async (): Promise<{ readonly stop: StopObservation; readonly frameId?: number }> => {
		const frame = frameOf((await call("stack_trace", { levels: 1 })).details);
		const source = frame !== undefined && isRecord(frame.source) ? frame.source.path : undefined;
		const at = frame === undefined ? undefined : line(frame.line);
		if (frame === undefined || typeof source !== "string" || at === undefined) throw new Error("the stopped frame has no source location");
		const name = typeof frame.name === "string" ? clip(frame.name, 200) : undefined;
		return {
			stop: { file: clip(relativeToFixture(context.cwd, source), 400), line: at, ...(name === undefined ? {} : { frameName: name }) },
			...(typeof frame.id === "number" ? { frameId: frame.id } : {}),
		};
	};

	try {
		const launch = await call("launch", { adapter: spec.adapter, program, cwd: launchCwd, ...(spec.args === undefined ? {} : { args: [...spec.args] }) });
		launched = true;
		if (typeof launch.details.adapter === "string") adapter = clip(launch.details.adapter, 128);
		const deadline = context.clock.now() + context.readinessMs;

		// The launch snapshot is not proof of a stop: a Go package is still building, a JavaScript child session may not exist yet.
		const snapshot = launch.details.snapshot;
		if (!(isRecord(snapshot) && snapshot.status === "stopped")) {
			const waited = await awaitSessions(deadline);
			if (waited === "ended") throw new Error("the program ended before the debugger stopped");
			if (waited === "timeout") throw new Error(`the debugger did not stop within ${context.readinessMs}ms`);
		}

		// Set the breakpoint while stopped. Repeating the request reports a source-mapped breakpoint once the adapter has bound it.
		const bindDeadline = Math.min(deadline, context.clock.now() + BIND_WINDOW_MS);
		let verified = false;
		for (;;) {
			const set = await call("set_breakpoint", { file: breakpointFile, line: spec.breakpoint.line });
			const list = Array.isArray(set.details.breakpoints) ? set.details.breakpoints.filter(isRecord) : [];
			const ours = list.find(entry => entry.line === spec.breakpoint.line);
			verified = ours?.verified === true;
			if (verified || context.clock.now() >= bindDeadline || aborted()) break;
			await context.clock.sleep(POLL_MS);
		}
		breakpoint = { file: spec.breakpoint.file, line: spec.breakpoint.line, verified };

		let frameId: number | undefined;
		for (let round = 0; round < MAX_RESUMES; round++) {
			const waited = await resume(deadline);
			if (waited === "ended") throw new Error("the program ended before it reached the breakpoint");
			if (waited === "timeout") throw new Error(`the debugger did not stop at the breakpoint within ${context.readinessMs}ms`);
			const located = await locate();
			stop = located.stop;
			frameId = located.frameId;
			if (stop.file === spec.breakpoint.file && stop.line === spec.breakpoint.line) break;
		}
		if (stop === undefined || stop.file !== spec.breakpoint.file || stop.line !== spec.breakpoint.line) {
			throw new Error(`stopped at ${stop === undefined ? "nowhere" : `${stop.file}:${stop.line}`} instead of ${spec.breakpoint.file}:${spec.breakpoint.line}`);
		}

		const scopes = (await call("scopes", frameId === undefined ? {} : { frame_id: frameId })).details.scopes;
		const ordered = (Array.isArray(scopes) ? scopes.filter(isRecord) : []).sort((a, b) => Number(a.expensive === true) - Number(b.expensive === true)).slice(0, MAX_SCOPES);
		for (const scope of ordered) {
			const reference = scope.variablesReference;
			if (typeof reference !== "number" || reference <= 0) continue;
			const values = (await call("variables", { scope_id: reference })).details.variables;
			const found = (Array.isArray(values) ? values.filter(isRecord) : []).find(entry => entry.name === spec.variable.name);
			if (found !== undefined) {
				variable = {
					name: spec.variable.name,
					value: clip(String(found.value), 256),
					scope: clip(typeof scope.name === "string" ? scope.name : "scope", 128),
				};
				break;
			}
		}
		if (variable === undefined) throw new Error(`variable ${spec.variable.name} was not found in any scope of the stopped frame`);
	} catch (error) {
		detail = clip(messageOf(error));
	} finally {
		if (launched) {
			try {
				await call("terminate");
				terminated = true;
			} catch (error) {
				detail ??= `the debug session did not terminate: ${clip(messageOf(error))}`;
			}
			try {
				const sessions = (await call("sessions")).details.sessions;
				sessionsAfter = Array.isArray(sessions) ? sessions.length : undefined;
			} catch {
				sessionsAfter = undefined;
			}
		}
	}
	const complete = detail === undefined && variable !== undefined;
	return {
		status: complete ? "observed" : "error",
		terminated,
		elapsedMs: context.clock.now() - started,
		...(detail === undefined ? {} : { detail }),
		...(adapter === undefined ? {} : { adapter }),
		...(breakpoint === undefined ? {} : { breakpoint }),
		...(stop === undefined ? {} : { stop }),
		...(variable === undefined ? {} : { variable }),
		...(sessionsAfter === undefined ? {} : { sessionsAfter }),
	};
}

// ── The command ─────────────────────────────────────────────────────────────────────────────────

export interface CaseRun {
	/** Undefined when this omp lacks the public SDK exports (see `missing`). */
	readonly tools: CaseTools | undefined;
	readonly missing: readonly string[];
	readonly environment: Observation["environment"];
	readonly clock: Clock;
	readonly write: (observation: Observation) => void;
	readonly signal?: AbortSignal;
}

/**
 * Runs the requested phases and writes the observation after each one, so a later hang or crash never
 * loses an earlier result. LSP and debugger phases are independent: one failing does not skip the other.
 */
export async function runCase(spec: CaseSpec, run: CaseRun): Promise<Observation> {
	const base = { schema: 1 as const, fixture: spec.fixture, environment: run.environment };
	if (run.tools === undefined) {
		const finished: Observation = { ...base, sdk: { ok: false, missing: [...run.missing] }, complete: true };
		run.write(finished);
		return finished;
	}
	let observation: Observation = { ...base, sdk: { ok: true }, complete: false };
	run.write(observation);
	// A helper that is not running where the verifier put it must not touch anything: report where it is and stop.
	const isolated = run.environment.cwd === spec.cwd && run.environment.home === spec.home && run.environment.agentDir === spec.agentDir;
	if (!isolated) {
		observation = { ...observation, complete: true };
		run.write(observation);
		return observation;
	}
	const context: PhaseContext = { cwd: spec.cwd, clock: run.clock, callSeconds: spec.callSeconds, readinessMs: spec.readinessMs, ...(run.signal === undefined ? {} : { signal: run.signal }) };
	if (spec.lsp !== undefined) {
		const lsp = await observeDefinition(spec.lsp, run.tools.lsp, context).catch(
			(error: unknown): LspObservation => ({ status: "error", detail: clip(messageOf(error)), attempts: 0, locations: [], elapsedMs: 0 }),
		);
		observation = { ...observation, lsp };
		run.write(observation);
	}
	if (spec.dap !== undefined) {
		const dap = await observeBreakpoint(spec.dap, run.tools.debug, context).catch(
			(error: unknown): DapObservation => ({ status: "error", detail: clip(messageOf(error)), terminated: false, elapsedMs: 0 }),
		);
		observation = { ...observation, dap };
		run.write(observation);
	}
	observation = { ...observation, complete: true };
	run.write(observation);
	return observation;
}

function readBounded(file: string): string {
	const stat = fs.statSync(file);
	if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error("the case file is not a small regular file");
	return fs.readFileSync(file, "utf8");
}

function writeAtomic(file: string, content: string): void {
	const temporary = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(temporary, content, { mode: 0o600 });
	fs.renameSync(temporary, file);
}

type Constructor = new (session: unknown) => ToolLike;

/** Feature-detects the public exports on `pi.pi` and builds the two tools over one fixture session; never touches any other debugger. */
async function loadTools(pi: unknown, cwd: string): Promise<{ readonly tools?: CaseTools; readonly missing: readonly string[] }> {
	const exported: unknown = isRecord(pi) ? pi.pi : undefined;
	if (!isRecord(exported)) return { missing: ["pi.pi"] };
	const missing: string[] = [];
	const Settings = exported.Settings as { init?: (options: { cwd: string }) => Promise<unknown> } | undefined;
	const LspTool = exported.LspTool;
	const DebugTool = exported.DebugTool;
	if (typeof Settings?.init !== "function") missing.push("pi.pi.Settings.init");
	if (typeof LspTool !== "function") missing.push("pi.pi.LspTool");
	if (typeof DebugTool !== "function") missing.push("pi.pi.DebugTool");
	if (missing.length > 0 || typeof Settings?.init !== "function") return { missing };
	try {
		const settings = await Settings.init({ cwd });
		const session = { cwd, hasUI: false, settings, enableLsp: true };
		return { missing: [], tools: { lsp: new (LspTool as Constructor)(session), debug: new (DebugTool as Constructor)(session) } };
	} catch (error) {
		return { missing: [`pi.pi.Settings.init failed: ${clip(messageOf(error), 200)}`] };
	}
}

async function handle(pi: unknown, workingDirectory: string): Promise<void> {
	const casePath = process.env[CASE_VARIABLE];
	if (casePath === undefined || casePath === "") return;
	let spec: CaseSpec;
	try {
		spec = parseCaseSpec(readBounded(casePath));
	} catch {
		return;
	}
	const cwd = realpathOrSelf(workingDirectory);
	const loaded = await loadTools(pi, cwd);
	await runCase(spec, {
		tools: loaded.tools,
		missing: loaded.missing,
		environment: { cwd, home: process.env.HOME ?? "", agentDir: process.env.PI_CODING_AGENT_DIR ?? "" },
		clock: realClock,
		write: observation => writeAtomic(spec.observation, `${JSON.stringify(observation)}\n`),
	});
}

export default function verifier(pi: ExtensionAPI): void {
	pi.registerCommand(VERIFY_COMMAND, {
		description: "Observe one disposable fixture through omp's public LSP and debugger tools (starter tooling verifier; never starts a model turn)",
		handler: async (_args: string, ctx: { cwd: string }) => {
			await handle(pi, ctx.cwd);
		},
	});
}
