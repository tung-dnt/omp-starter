// Static LSP/DAP configuration inspection and conflict-aware merge (design C2).
//
// Inspection never starts a program. It reads omp's documented config locations (`lsp.*` and
// `dap.*`; JSON or YAML; flat or wrapped) from the project, the native agent directory, foreign
// user directories and the home directory, and ranks them exactly as omp merges them. Applying a
// confirmed proposal merges only the approved entries into native JSON, keeping its flat/wrapped
// shape and every unrelated key, and refuses (rather than replaces, shadows or bypasses) anything
// that conflicts. YAML files and foreign configs are never touched.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	absolutePathDirs,
	acquireLock,
	ensureToolingRoots,
	errnoOf,
	errorMessage,
	findExecutable,
	hasRootMarkers,
	isExecutableFile,
	isRecord,
	type LockHandle,
	projectLocalBinDirs,
	RuntimeError,
	sha256Hex,
	writeFileAtomic,
} from "./runtime";
import type {
	ApplyOutcome,
	ApplyResult,
	ApplyStatus,
	ConfigContext,
	ConfigEntry,
	ConfigEntryValue,
	ConfigIssue,
	ConfigKind,
	ConfigProposal,
	ConfigScope,
	ConfigSnapshot,
	ConfigSource,
	ConfigSourceState,
	ConfigTarget,
	EffectiveEntry,
	ForeignProvider,
	JsonObject,
	JsonValue,
	ResolvedCommand,
	ResolvedConfigContext,
	RootMatch,
} from "./types";

const MAX_CONFIG_BYTES = 1024 * 1024;
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** Names omp's loaders treat specially at the top level of a file. */
const RESERVED_KEYS: Readonly<Record<string, true>> = { servers: true, adapters: true, idleTimeoutMs: true };
/** DAP merges these two fields one level deep instead of replacing them. */
const DEFAULTS_FIELDS: Readonly<Record<string, true>> = { launchDefaults: true, attachDefaults: true };
const SCOPE_LABEL: Readonly<Record<ConfigScope, string>> = {
	"cwd-root": "project config",
	"project-dir": "project config",
	"native-user": "user config",
	"foreign-user": "another tool's user config",
	home: "home directory config",
};

type YamlParser = (text: string) => unknown;

interface Candidate {
	readonly kind: ConfigKind;
	readonly path: string;
	readonly scope: ConfigScope;
	readonly provider?: "omp" | ForeignProvider;
	readonly format: "json" | "yaml";
	readonly rank: number;
	readonly enabled: boolean;
}

interface Inspected {
	readonly source?: ConfigSource;
	readonly fingerprint: string;
	/** omp would read this file but it could not be inspected here. */
	readonly blind?: boolean;
}

interface Layer {
	readonly source: ConfigSource;
	readonly value: ConfigEntryValue;
}

function brief(text: string): string {
	return text.length > 200 ? `${text.slice(0, 197)}...` : text;
}

function kindLabel(kind: ConfigKind): string {
	return kind === "lsp" ? "language server" : "debug adapter";
}

function wrapperKey(kind: ConfigKind): string {
	return kind === "lsp" ? "servers" : "adapters";
}

function realpathOrUndefined(target: string): string | undefined {
	try {
		return fs.realpathSync(target);
	} catch {
		return undefined;
	}
}

function identityOf(source: ConfigSource): string {
	return source.realPath ?? source.path;
}

function describeSource(source: ConfigSource): string {
	return `${source.path} (${SCOPE_LABEL[source.scope]})`;
}

function yamlParser(): YamlParser | undefined {
	if (typeof Bun === "undefined" || !("YAML" in Bun)) return undefined;
	return text => Bun.YAML.parse(text);
}

// ── Context and candidate files ─────────────────────────────────────────────────────────────────

function resolveContext(context: ConfigContext): ResolvedConfigContext {
	const env = context.env ?? process.env;
	const home = path.resolve(context.home ?? os.homedir());
	const cwd = path.resolve(context.cwd);
	const claudeOverride = env.CLAUDE_CONFIG_DIR?.trim();
	return {
		cwd,
		agentDir: path.resolve(context.agentDir),
		home,
		env,
		claudeDir: claudeOverride ? path.resolve(cwd, claudeOverride) : path.join(home, ".claude"),
		foreignUserSources: context.foreignUserSources ?? {},
	};
}

/** Candidate files for one kind, highest precedence first, in omp's own order. */
function listCandidates(kind: ConfigKind, context: ResolvedConfigContext): Candidate[] {
	const names = [`${kind}.json`, `.${kind}.json`, `${kind}.yaml`, `.${kind}.yaml`, `${kind}.yml`, `.${kind}.yml`];
	const ordered: Omit<Candidate, "rank">[] = [];
	const addDir = (dir: string, scope: ConfigScope, provider: Candidate["provider"], enabled = true): void => {
		for (const name of names) {
			ordered.push({ kind, path: path.join(dir, name), scope, provider, format: name.endsWith(".json") ? "json" : "yaml", enabled });
		}
	};
	const foreignEnabled = (provider: ForeignProvider): boolean => context.foreignUserSources[provider] ?? true;
	addDir(context.cwd, "cwd-root", undefined);
	for (const [dir, provider] of [
		[".omp", "omp"],
		[".claude", "claude"],
		[".codex", "codex"],
		[".gemini", "gemini"],
	] as const) {
		addDir(path.join(context.cwd, dir), "project-dir", provider);
	}
	addDir(context.agentDir, "native-user", "omp");
	addDir(context.claudeDir, "foreign-user", "claude", foreignEnabled("claude"));
	addDir(path.join(context.home, ".codex"), "foreign-user", "codex", foreignEnabled("codex"));
	addDir(path.join(context.home, ".gemini"), "foreign-user", "gemini", foreignEnabled("gemini"));
	addDir(context.home, "home", undefined);
	return ordered.map((candidate, index) => ({ ...candidate, rank: ordered.length - index }));
}

/** omp accepts a `servers`/`adapters` wrapper or a flat map; the wrapper wins when it is an object. */
function normalizeDocument(
	kind: ConfigKind,
	value: unknown,
): { shape: "wrapped" | "flat"; entries: Map<string, ConfigEntryValue> } | string {
	if (!isRecord(value)) return "the top level must be an object";
	const key = wrapperKey(kind);
	let members: Record<string, unknown>;
	let shape: "wrapped" | "flat";
	if (Object.hasOwn(value, key)) {
		const wrapper = value[key];
		if (!isRecord(wrapper)) return `\`${key}\` must be an object`;
		members = wrapper;
		shape = "wrapped";
	} else {
		members = Object.fromEntries(Object.entries(value).filter(([name]) => !(kind === "lsp" && name === "idleTimeoutMs")));
		shape = Object.keys(members).length > 0 ? "flat" : "wrapped";
	}
	const entries = new Map<string, ConfigEntryValue>();
	for (const [name, entry] of Object.entries(members)) {
		if (isRecord(entry)) entries.set(name, entry);
	}
	return { shape, entries };
}

function describeCandidate(
	candidate: Candidate,
	symlink: boolean,
	state: ConfigSourceState,
	extra: Partial<Pick<ConfigSource, "detail" | "sha256" | "shape" | "entries">> = {},
): Inspected {
	const source: ConfigSource = {
		kind: candidate.kind,
		path: candidate.path,
		realPath: realpathOrUndefined(candidate.path),
		scope: candidate.scope,
		provider: candidate.provider,
		format: candidate.format,
		rank: candidate.rank,
		enabled: candidate.enabled,
		symlink,
		state,
		entries: new Map(),
		...extra,
	};
	return { source, fingerprint: [candidate.path, state, symlink ? "link" : "file", extra.sha256 ?? "-"].join("\t") };
}

function inspectCandidate(candidate: Candidate, parseYaml: YamlParser | undefined): Inspected {
	let link: fs.Stats;
	try {
		link = fs.lstatSync(candidate.path);
	} catch (error) {
		const code = errnoOf(error);
		if (code === "ENOENT" || code === "ENOTDIR") return { fingerprint: `${candidate.path}\tabsent` };
		return describeCandidate(candidate, false, "unreadable", { detail: `cannot inspect: ${brief(errorMessage(error))}` });
	}
	const symlink = link.isSymbolicLink();
	let stat = link;
	if (symlink) {
		try {
			stat = fs.statSync(candidate.path);
		} catch {
			return describeCandidate(candidate, true, "unreadable", { detail: "dangling or unreadable symbolic link" });
		}
	}
	if (!stat.isFile()) return describeCandidate(candidate, symlink, "not-regular", { detail: "not a regular file" });
	if (stat.size > MAX_CONFIG_BYTES) {
		return { ...describeCandidate(candidate, symlink, "too-large", { detail: `larger than ${MAX_CONFIG_BYTES} bytes and not inspected` }), blind: true };
	}
	let bytes: Buffer;
	try {
		bytes = fs.readFileSync(candidate.path);
	} catch (error) {
		return describeCandidate(candidate, symlink, "unreadable", { detail: `cannot read: ${brief(errorMessage(error))}` });
	}
	const sha256 = sha256Hex(bytes);
	let value: unknown;
	try {
		if (candidate.format === "json") {
			value = JSON.parse(bytes.toString("utf8"));
		} else if (parseYaml === undefined) {
			return { ...describeCandidate(candidate, symlink, "unreadable", { detail: "YAML support (Bun.YAML) is unavailable, so this file was not inspected", sha256 }), blind: true };
		} else {
			value = parseYaml(bytes.toString("utf8"));
		}
	} catch (error) {
		return describeCandidate(candidate, symlink, "invalid", { detail: `not valid ${candidate.format.toUpperCase()}: ${brief(errorMessage(error))}`, sha256 });
	}
	const normalized = normalizeDocument(candidate.kind, value);
	if (typeof normalized === "string") return describeCandidate(candidate, symlink, "invalid", { detail: normalized, sha256 });
	return describeCandidate(candidate, symlink, "ok", { sha256, shape: normalized.shape, entries: normalized.entries });
}

function targetProblem(source: ConfigSource): ConfigTarget["problem"] {
	if (source.symlink) {
		const to = source.realPath === undefined ? "" : ` to ${source.realPath}`;
		return { code: "symlink", detail: `${source.path} is a symbolic link${to} and is never replaced. Edit the link target yourself, or replace the link with a regular file, then retry.` };
	}
	if (source.state === "invalid") {
		return { code: "invalid", detail: `${source.path} is not usable (${source.detail}); it was not modified. Fix or move it, then retry.` };
	}
	if (source.state === "not-regular") return { code: "not-regular", detail: `${source.path} is not a regular file; it was not modified.` };
	if (source.state !== "ok") return { code: "unreadable", detail: `${source.path} could not be read (${source.detail ?? source.state}); it was not modified.` };
	return undefined;
}

/** The native JSON file entries are merged into: an existing variant (highest precedence first) or a new `<kind>.json`. */
function computeTarget(kind: ConfigKind, candidates: readonly Candidate[], sources: readonly ConfigSource[]): ConfigTarget {
	const nativeJson = candidates.filter(candidate => candidate.scope === "native-user" && candidate.format === "json");
	for (const candidate of nativeJson) {
		const source = sources.find(item => item.path === candidate.path);
		if (source === undefined) continue;
		const problem = targetProblem(source);
		return {
			kind,
			path: source.path,
			exists: true,
			sha256: source.sha256,
			shape: source.shape ?? "wrapped",
			rank: source.rank,
			...(problem === undefined ? {} : { problem }),
		};
	}
	const first = nativeJson[0]!;
	return { kind, path: first.path, exists: false, shape: "new", rank: first.rank };
}

interface KindInspection {
	sources: ConfigSource[];
	target: ConfigTarget;
	issues: ConfigIssue[];
	unresolved: ConfigIssue[];
	fingerprints: string[];
}

function inspectKind(kind: ConfigKind, context: ResolvedConfigContext, parseYaml: YamlParser | undefined): KindInspection {
	const candidates = listCandidates(kind, context);
	const sources: ConfigSource[] = [];
	const issues: ConfigIssue[] = [];
	const unresolved: ConfigIssue[] = [];
	const fingerprints: string[] = [];
	for (const candidate of candidates) {
		const inspected = inspectCandidate(candidate, parseYaml);
		fingerprints.push(inspected.fingerprint);
		if (inspected.source === undefined) continue;
		sources.push(inspected.source);
		if (inspected.source.state === "ok") continue;
		const issue: ConfigIssue = { kind, path: inspected.source.path, detail: inspected.source.detail ?? inspected.source.state };
		issues.push(issue);
		if (inspected.blind === true) unresolved.push(issue);
	}
	return { sources, target: computeTarget(kind, candidates, sources), issues, unresolved, fingerprints };
}

/** Reads every omp config location for LSP and DAP without executing anything. */
export async function inspectConfig(context: ConfigContext): Promise<ConfigSnapshot> {
	const resolved = resolveContext(context);
	const parseYaml = yamlParser();
	const lsp = inspectKind("lsp", resolved, parseYaml);
	const dap = inspectKind("dap", resolved, parseYaml);
	const sources = [...lsp.sources, ...dap.sources];
	const notes = [
		"Plugin-provided LSP/DAP configuration is not inspected.",
		"omp's built-in server and adapter definitions are the base layer; they are not listed here.",
	];
	for (const source of sources) {
		const provider = source.provider;
		if (source.scope !== "foreign-user" || provider === undefined || provider === "omp") continue;
		if (source.state !== "ok" || source.entries.size === 0 || resolved.foreignUserSources[provider] !== undefined) continue;
		notes.push(`${source.path} is another tool's user config. omp reads it only when that provider is enabled, which was not provided, so it is treated as possibly effective.`);
	}
	return {
		context: resolved,
		sources,
		targets: { lsp: lsp.target, dap: dap.target },
		issues: [...lsp.issues, ...dap.issues],
		unresolved: [...lsp.unresolved, ...dap.unresolved],
		notes,
		digest: sha256Hex([...lsp.fingerprints, ...dap.fingerprints].join("\n")),
	};
}

// ── Effective configuration ─────────────────────────────────────────────────────────────────────

/** Enabled sources defining `key`, lowest precedence first; a file reachable through several locations counts once. */
function layersFor(snapshot: ConfigSnapshot, kind: ConfigKind, key: string): Layer[] {
	const layers: Layer[] = [];
	const seen = new Set<string>();
	for (const source of snapshot.sources) {
		if (source.kind !== kind || source.state !== "ok" || !source.enabled) continue;
		const value = source.entries.get(key);
		if (value === undefined || seen.has(identityOf(source))) continue;
		seen.add(identityOf(source));
		layers.push({ source, value });
	}
	return layers.reverse();
}

function mergeLayer(kind: ConfigKind, base: ConfigEntryValue, layer: ConfigEntryValue): ConfigEntryValue {
	const merged: Record<string, unknown> = { ...base, ...layer };
	if (kind !== "dap") return merged;
	for (const field of Object.keys(DEFAULTS_FIELDS)) {
		const lower = base[field];
		const upper = layer[field];
		if (isRecord(lower) || isRecord(upper)) merged[field] = { ...(isRecord(lower) ? lower : {}), ...(isRecord(upper) ? upper : {}) };
	}
	return merged;
}

function mergeLayers(kind: ConfigKind, layers: readonly Layer[]): ConfigEntryValue {
	let merged: ConfigEntryValue = {};
	for (const layer of layers) merged = mergeLayer(kind, merged, layer.value);
	return merged;
}

/** The executable omp would resolve for a configured command, found by static lookup only. */
export function resolveEntryCommand(kind: ConfigKind, command: string, context: ResolvedConfigContext): ResolvedCommand | undefined {
	if (path.isAbsolute(command)) return isExecutableFile(command) ? { path: command, origin: "absolute" } : undefined;
	if (command.includes("/")) {
		if (kind === "dap" && (command.startsWith("./") || command.startsWith("../"))) {
			const resolved = path.resolve(context.cwd, command);
			return isExecutableFile(resolved) ? { path: resolved, origin: "project-local" } : undefined;
		}
		return undefined;
	}
	for (const dir of projectLocalBinDirs(context.cwd)) {
		const local = findExecutable(command, [dir]);
		if (local !== undefined) return { path: local, origin: "project-local" };
	}
	const found = findExecutable(command, absolutePathDirs(context.env.PATH));
	return found === undefined ? undefined : { path: found, origin: "path" };
}

/** What omp would use for `key`, computed statically; undefined when no enabled source defines it. */
export function effectiveEntry(snapshot: ConfigSnapshot, kind: ConfigKind, key: string): EffectiveEntry | undefined {
	const layers = layersFor(snapshot, kind, key);
	const top = layers[layers.length - 1];
	if (top === undefined) return undefined;
	const value = mergeLayers(kind, layers);
	const command = typeof value.command === "string" ? resolveEntryCommand(kind, value.command, snapshot.context) : undefined;
	return {
		kind,
		key,
		value,
		layers,
		source: top.source,
		projectSupplied: layers.some(layer => layer.source.scope === "cwd-root" || layer.source.scope === "project-dir"),
		disabled: value.disabled === true,
		...(command === undefined ? {} : { command }),
	};
}

// ── Proposal validation ─────────────────────────────────────────────────────────────────────────

type Sanitized = { ok: true; value: JsonValue } | { ok: false; reason: string };

/** Deep-copies a value into plain JSON, dropping `undefined` fields and rejecting anything JSON cannot represent. */
function sanitize(value: unknown, depth = 0): Sanitized {
	if (depth > 24) return { ok: false, reason: "nesting is too deep" };
	if (value === null || typeof value === "boolean" || typeof value === "string") return { ok: true, value };
	if (typeof value === "number") {
		return Number.isFinite(value) ? { ok: true, value } : { ok: false, reason: "numbers must be finite" };
	}
	if (Array.isArray(value)) {
		const items: JsonValue[] = [];
		for (const item of value) {
			const inner = sanitize(item, depth + 1);
			if (!inner.ok) return inner;
			items.push(inner.value);
		}
		return { ok: true, value: items };
	}
	if (typeof value === "object") {
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) return { ok: false, reason: "only plain objects are allowed" };
		const copy: JsonObject = {};
		for (const [name, member] of Object.entries(value)) {
			if (member === undefined) continue;
			const inner = sanitize(member, depth + 1);
			if (!inner.ok) return inner;
			Object.defineProperty(copy, name, { value: inner.value, enumerable: true, writable: true, configurable: true });
		}
		return { ok: true, value: copy };
	}
	return { ok: false, reason: `unsupported value of type ${typeof value}` };
}

/** The exact JSON object to write for a proposed entry, or the reason it is invalid. */
function normalizeEntry(entry: ConfigEntry): { ok: true; intended: JsonObject } | { ok: false; reason: string } {
	if (entry.kind !== "lsp" && entry.kind !== "dap") return { ok: false, reason: "kind must be lsp or dap" };
	if (typeof entry.key !== "string" || !KEY_PATTERN.test(entry.key) || Object.hasOwn(RESERVED_KEYS, entry.key)) {
		return { ok: false, reason: `key ${JSON.stringify(entry.key)} is not a valid server/adapter name` };
	}
	const copy = sanitize(entry.value);
	if (!copy.ok) return { ok: false, reason: `value is not plain JSON: ${copy.reason}` };
	const intended = copy.value;
	if (!isRecord(intended)) return { ok: false, reason: "value must be an object" };
	if (typeof intended.command !== "string" || intended.command === "" || intended.command.includes("\0")) {
		return { ok: false, reason: "value.command must be a non-empty string" };
	}
	for (const field of ["args", "fileTypes", "rootMarkers", "languages"]) {
		const list = intended[field];
		if (Object.hasOwn(intended, field) && !(Array.isArray(list) && list.every(item => typeof item === "string"))) {
			return { ok: false, reason: `value.${field} must be an array of strings` };
		}
	}
	if (Object.hasOwn(intended, "disabled") && typeof intended.disabled !== "boolean") return { ok: false, reason: "value.disabled must be a boolean" };
	if (Object.hasOwn(intended, "connectMode") && !(intended.connectMode === "stdio" || intended.connectMode === "socket" || intended.connectMode === "tcp")) {
		return { ok: false, reason: "value.connectMode must be stdio, socket or tcp" };
	}
	return { ok: true, intended };
}

// ── Conflict rules ──────────────────────────────────────────────────────────────────────────────

/** True when `existing` would change what the approved `intended` value means for this field. */
function fieldConflict(kind: ConfigKind, field: string, existing: unknown, intended: unknown): boolean {
	if (kind === "dap" && Object.hasOwn(DEFAULTS_FIELDS, field) && isRecord(existing) && isRecord(intended)) {
		return Object.entries(intended).some(([name, wanted]) => Object.hasOwn(existing, name) && !isDeepStrictEqual(existing[name], wanted));
	}
	return !isDeepStrictEqual(existing, intended);
}

/** True when every approved field is already present with the approved value and the entry is not disabled. */
function satisfies(kind: ConfigKind, current: ConfigEntryValue, intended: JsonObject): boolean {
	if (current.disabled === true && intended.disabled !== true) return false;
	for (const [field, wanted] of Object.entries(intended)) {
		if (!Object.hasOwn(current, field)) return false;
		const existing = current[field];
		if (kind === "dap" && Object.hasOwn(DEFAULTS_FIELDS, field) && isRecord(existing) && isRecord(wanted)) {
			if (Object.entries(wanted).some(([name, value]) => !Object.hasOwn(existing, name) || !isDeepStrictEqual(existing[name], value))) return false;
			continue;
		}
		if (!isDeepStrictEqual(existing, wanted)) return false;
	}
	return true;
}

interface Evaluation {
	readonly status: "write" | ApplyStatus;
	readonly detail: string;
	readonly path?: string;
	readonly conflictsWith?: readonly string[];
}

function conflictFor(layer: Layer, detail: string): Evaluation {
	return { status: "conflict", detail, path: layer.source.path, conflictsWith: [layer.source.path] };
}

function differingField(kind: ConfigKind, layer: Layer, intended: JsonObject): string | undefined {
	return Object.keys(intended).find(field => Object.hasOwn(layer.value, field) && fieldConflict(kind, field, layer.value[field], intended[field]));
}

/** Decides what applying `intended` would do, without touching any file. */
function evaluate(snapshot: ConfigSnapshot, entry: ConfigEntry, intended: JsonObject): Evaluation {
	const { kind, key } = entry;
	const label = `${kindLabel(kind)} \`${key}\``;
	const target = snapshot.targets[kind];
	if (target.problem !== undefined) {
		return { status: target.problem.code === "symlink" || target.problem.code === "not-regular" ? "conflict" : "failed", detail: target.problem.detail, path: target.path };
	}
	const blind = snapshot.unresolved.filter(issue => issue.kind === kind);
	if (blind.length > 0) {
		const paths = blind.map(issue => issue.path);
		return { status: "conflict", detail: `cannot rule out that ${paths.join(", ")} define ${label}: ${blind[0]!.detail}. Nothing was changed.`, conflictsWith: paths };
	}
	const targetIdentity = realpathOrUndefined(target.path) ?? target.path;
	const layers = layersFor(snapshot, kind, key);
	const own = layers.find(layer => identityOf(layer.source) === targetIdentity);
	const others = layers.filter(layer => layer !== own);
	const higher = others.filter(layer => layer.source.rank > target.rank);
	const lower = others.filter(layer => layer.source.rank < target.rank);
	for (const layer of higher) {
		if (layer.value.disabled === true) {
			return conflictFor(layer, `${describeSource(layer.source)} disables ${label} and takes precedence over the user-level config. Remove that setting or work from another project, then retry; nothing was changed.`);
		}
		const field = differingField(kind, layer, intended);
		if (field !== undefined) {
			return conflictFor(layer, `${describeSource(layer.source)} defines ${label} with a different \`${field}\` and takes precedence over the user-level config, so the approved entry would not be used. Remove or align that entry, then retry; nothing was changed.`);
		}
	}
	if (own !== undefined) {
		if (!satisfies(kind, own.value, intended)) {
			return { status: "conflict", detail: `${target.path} already defines ${label} differently; it was not replaced. Edit or remove it yourself, or keep the existing tool.`, path: target.path, conflictsWith: [target.path] };
		}
		return { status: "unchanged", detail: `${label} is already configured as approved in ${target.path}; nothing was written.`, path: target.path };
	}
	for (const layer of lower) {
		const field = differingField(kind, layer, intended);
		if (field !== undefined) {
			return conflictFor(layer, `${describeSource(layer.source)} already configures ${label} with a different \`${field}\`; adding the managed tool would replace or bypass it, so nothing was changed. Keep using that tool or remove its entry yourself.`);
		}
		if (layer.value.disabled === true && intended.disabled !== false) {
			return conflictFor(layer, `${describeSource(layer.source)} disables ${label}; the managed tool would stay disabled. Remove that setting yourself, then retry; nothing was changed.`);
		}
	}
	const top = layers[layers.length - 1];
	if (top !== undefined && satisfies(kind, mergeLayers(kind, layers), intended)) {
		return { status: "unchanged", detail: `${label} is already configured as approved (${describeSource(top.source)}); nothing was written.`, path: top.source.path };
	}
	return { status: "write", detail: "", path: target.path };
}

// ── Writing ─────────────────────────────────────────────────────────────────────────────────────

interface Pending {
	readonly index: number;
	readonly entry: ConfigEntry;
	readonly intended: JsonObject;
}

type WriteResult = { ok: true } | { ok: false; detail: string };

function readNow(file: string): { exists: boolean; sha256?: string; text: string; mode: number } {
	let stat: fs.Stats;
	try {
		stat = fs.lstatSync(file);
	} catch (error) {
		if (errnoOf(error) === "ENOENT") return { exists: false, text: "", mode: 0o666 };
		throw error;
	}
	if (!stat.isFile()) throw new Error(`${file} is no longer a regular file`);
	const bytes = fs.readFileSync(file);
	return { exists: true, sha256: sha256Hex(bytes), text: bytes.toString("utf8"), mode: stat.mode & 0o777 };
}

/** Reuses the file's own indentation (tab, or the first indented line's width) so the diff stays minimal. */
function detectIndent(text: string): string | number {
	const match = /^([ \t]+)\S/m.exec(text);
	if (match === null) return 2;
	return match[1]!.startsWith("\t") ? "\t" : Math.min(match[1]!.length, 10);
}

/** Adds entries keeping the file's shape: into the wrapper when there is one, flat when flat entries exist, else a new wrapper. */
function insertEntries(kind: ConfigKind, doc: Record<string, unknown>, pending: readonly Pending[]): void {
	const key = wrapperKey(kind);
	const wrapper = Object.hasOwn(doc, key) ? doc[key] : undefined;
	if (isRecord(wrapper)) {
		for (const item of pending) Object.defineProperty(wrapper, item.entry.key, { value: item.intended, enumerable: true, writable: true, configurable: true });
		return;
	}
	const flat = Object.keys(doc).some(name => !(kind === "lsp" && name === "idleTimeoutMs"));
	if (flat) {
		for (const item of pending) Object.defineProperty(doc, item.entry.key, { value: item.intended, enumerable: true, writable: true, configurable: true });
		return;
	}
	const created: Record<string, unknown> = {};
	for (const item of pending) Object.defineProperty(created, item.entry.key, { value: item.intended, enumerable: true, writable: true, configurable: true });
	doc[key] = created;
}

/** One exclusive, compare-and-swap update of a native file: reread, merge, atomic replace. */
async function writeKind(snapshot: ConfigSnapshot, kind: ConfigKind, pending: readonly Pending[]): Promise<WriteResult> {
	const target = snapshot.targets[kind];
	const changed: WriteResult = {
		ok: false,
		detail: `${target.path} changed since it was inspected (another program edited it); nothing was written. Re-run to pick up the new content.`,
	};
	let lock: LockHandle;
	try {
		const roots = await ensureToolingRoots(snapshot.context.agentDir);
		lock = await acquireLock(path.join(roots.locks, `config-${kind}.lock`), `updating ${path.basename(target.path)}`);
	} catch (error) {
		return { ok: false, detail: error instanceof RuntimeError ? error.message : `cannot prepare ${target.path}: ${brief(errorMessage(error))}` };
	}
	try {
		const current = readNow(target.path);
		if (current.exists !== target.exists || current.sha256 !== target.sha256) return changed;
		let doc: Record<string, unknown> = {};
		let indent: string | number = 2;
		let newline = true;
		if (current.exists) {
			const parsed: unknown = JSON.parse(current.text);
			if (!isRecord(parsed)) return { ok: false, detail: `${target.path} is no longer a JSON object; nothing was written.` };
			doc = parsed;
			indent = detectIndent(current.text);
			newline = current.text.endsWith("\n");
		}
		insertEntries(kind, doc, pending);
		const serialized = `${JSON.stringify(doc, null, indent)}${newline ? "\n" : ""}`;
		const again = readNow(target.path);
		if (again.exists !== current.exists || again.sha256 !== current.sha256) return changed;
		fs.mkdirSync(path.dirname(target.path), { recursive: true });
		await writeFileAtomic(target.path, serialized, current.mode);
		if (current.exists) fs.chmodSync(target.path, current.mode);
		return { ok: true };
	} catch (error) {
		return { ok: false, detail: `could not update ${target.path}: ${brief(errorMessage(error))}; it was not replaced.` };
	} finally {
		await lock.release();
	}
}

// ── Apply ───────────────────────────────────────────────────────────────────────────────────────

/** After the merge: confirm the approved entry is the one omp will use, and disclose the cwd-only root-marker rule. */
function confirm(snapshot: ConfigSnapshot, outcome: ApplyOutcome, intended: JsonObject): ApplyOutcome {
	const effective = effectiveEntry(snapshot, outcome.kind, outcome.key);
	if (effective === undefined || effective.disabled || !satisfies(outcome.kind, effective.value, intended)) {
		return { ...outcome, status: "failed", detail: `${kindLabel(outcome.kind)} \`${outcome.key}\` is not effective after the update; treat the integration as not ready and inspect the configuration files.` };
	}
	if (outcome.kind !== "lsp") return outcome;
	const markers = Array.isArray(effective.value.rootMarkers) ? effective.value.rootMarkers.filter((item): item is string => typeof item === "string") : [];
	if (markers.length === 0) return outcome;
	const rootMatch: RootMatch = { cwd: snapshot.context.cwd, markers, matches: hasRootMarkers(snapshot.context.cwd, markers) };
	const note = rootMatch.matches
		? ` It is effective for ${rootMatch.cwd}.`
		: ` omp starts it only from a directory holding one of ${markers.join(", ")}; ${rootMatch.cwd} has none, and parent directories are not searched.`;
	return { ...outcome, detail: `${outcome.detail}${note}`, rootMatch };
}

/**
 * Merges the confirmed entries into the user's native `lsp.json`/`dap.json`. Entries that would
 * replace, shadow or bypass anything are refused individually; the rest are written in one atomic
 * replacement per file. Pass the returned `snapshot` to the next call.
 */
export async function applyConfig(snapshot: ConfigSnapshot, proposal: ConfigProposal): Promise<ApplyResult> {
	const fresh = await inspectConfig(snapshot.context);
	const changed = fresh.digest !== snapshot.digest;
	const outcomes: (ApplyOutcome | undefined)[] = [];
	const intendedByIndex = new Map<number, JsonObject>();
	const writes: Record<ConfigKind, Pending[]> = { lsp: [], dap: [] };
	const seen = new Set<string>();
	for (const [index, entry] of proposal.entries.entries()) {
		const base = { kind: entry.kind, key: entry.key };
		const normalized = normalizeEntry(entry);
		if (!normalized.ok) {
			outcomes[index] = { ...base, status: "failed", detail: `invalid proposal entry: ${normalized.reason}` };
			continue;
		}
		const identity = `${entry.kind}:${entry.key}`;
		if (seen.has(identity)) {
			outcomes[index] = { ...base, status: "failed", detail: `${identity} appears more than once in the proposal` };
			continue;
		}
		seen.add(identity);
		if (changed) {
			outcomes[index] = { ...base, status: "failed", detail: "the configuration changed since it was inspected; nothing was written. Re-inspect and propose again." };
			continue;
		}
		const verdict = evaluate(fresh, entry, normalized.intended);
		if (verdict.status === "write") {
			writes[entry.kind].push({ index, entry, intended: normalized.intended });
			intendedByIndex.set(index, normalized.intended);
			continue;
		}
		outcomes[index] = {
			...base,
			status: verdict.status,
			detail: verdict.detail,
			...(verdict.path === undefined ? {} : { path: verdict.path }),
			...(verdict.conflictsWith === undefined ? {} : { conflictsWith: verdict.conflictsWith }),
		};
		if (verdict.status === "unchanged") intendedByIndex.set(index, normalized.intended);
	}
	let wrote = false;
	for (const kind of ["lsp", "dap"] as const) {
		const pending = writes[kind];
		if (pending.length === 0) continue;
		const target = fresh.targets[kind];
		const result = await writeKind(fresh, kind, pending);
		wrote ||= result.ok;
		for (const item of pending) {
			const base = { kind, key: item.entry.key, path: target.path };
			outcomes[item.index] = result.ok
				? { ...base, status: "applied", detail: `Added ${kindLabel(kind)} \`${item.entry.key}\` to ${target.path}.` }
				: { ...base, status: "failed", detail: result.detail };
		}
	}
	const final = wrote ? await inspectConfig(fresh.context) : fresh;
	const confirmed = outcomes.map((outcome, index) => {
		if (outcome === undefined) throw new Error(`proposal entry ${index} produced no outcome`);
		const intended = intendedByIndex.get(index);
		if ((outcome.status !== "applied" && outcome.status !== "unchanged") || intended === undefined) return outcome;
		return confirm(final, outcome, intended);
	});
	return { outcomes: confirmed, snapshot: final };
}
