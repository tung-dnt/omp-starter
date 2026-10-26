// Static LSP/DAP configuration inspection and conflict-aware merge (design C2).
//
// Inspection never starts a program. It reads omp's documented config locations (`lsp.*` and `dap.*`;
// JSON or YAML; flat or wrapped) from the project, the native agent directory, foreign user
// directories, installed plugin roots and the home directory, and ranks them the way omp's loaders
// merge them. Applying a confirmed proposal merges only the approved entries into native JSON,
// keeping its flat/wrapped shape and every unrelated key, and refuses (rather than replaces,
// shadows or bypasses) anything that conflicts. YAML files and foreign configs are never touched.
//
// Whether omp reads a source can be unknown (a foreign provider's opt-in, a plugin's gating). Such
// sources still take part in conflict checks, so they can block a write, but they never make an
// entry "effective", "unchanged" or ready.
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
	isWithin,
	type LockHandle,
	projectLocalBinDirs,
	RuntimeError,
	sha256Hex,
	writeFileAtomic,
} from "./runtime";
import {
	type ApplyOutcome,
	type ApplyResult,
	type ApplyStatus,
	CONFIG_ENV_NAMES,
	type ConfigContext,
	type ConfigEnablement,
	type ConfigEntry,
	type ConfigEntryValue,
	type ConfigEnv,
	type ConfigIssue,
	type ConfigKind,
	type ConfigProposal,
	type ConfigScope,
	type ConfigSnapshot,
	type ConfigSource,
	type ConfigSourceState,
	type ConfigTarget,
	type EffectiveEntry,
	type ForeignProvider,
	type JsonObject,
	type JsonValue,
	type ResolvedCommand,
	type ResolvedConfigContext,
	type RootMatch,
} from "./types";

const MAX_CONFIG_BYTES = 1024 * 1024;
const MAX_PLUGIN_ROOTS = 200;
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PROFILE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** Names omp's loaders treat specially at the top level of a file. */
const RESERVED_KEYS: Readonly<Record<string, true>> = { servers: true, adapters: true, idleTimeoutMs: true };
/** DAP merges these two fields one level deep instead of replacing them. */
const DEFAULTS_FIELDS: Readonly<Record<string, true>> = { launchDefaults: true, attachDefaults: true };
/** The only fields omp's DAP loader keeps (`normalizeAdapterConfig`); everything else in an adapter entry is dropped. */
const DAP_FIELDS: Readonly<Record<string, true>> = {
	command: true,
	args: true,
	languages: true,
	fileTypes: true,
	rootMarkers: true,
	launchDefaults: true,
	attachDefaults: true,
	acceptsDirectoryProgram: true,
	connectMode: true,
};
const SCOPE_LABEL: Readonly<Record<ConfigScope, string>> = {
	"cwd-root": "project config",
	"project-dir": "project config",
	"native-user": "user config",
	"foreign-user": "another tool's user config",
	plugin: "plugin config",
	home: "home directory config",
};

type YamlParser = (text: string) => unknown;

/** A plugin whose root omp reads `lsp.*`/`dap.*` (and, for LSP, its marketplace `lspServers`) from: installed, or passed with `--plugin-dir`. */
interface PluginRoot {
	readonly id: string;
	readonly name: string;
	readonly path: string;
	/** Passed to omp with `--plugin-dir` for this launch. */
	readonly launch?: true;
}

interface Candidate {
	readonly kind: ConfigKind;
	readonly path: string;
	readonly scope: ConfigScope;
	readonly provider?: "omp" | ForeignProvider;
	readonly format: "json" | "yaml";
	readonly rank: number;
	readonly enablement: ConfigEnablement;
	/** The plugin root this candidate belongs to. */
	readonly plugin?: PluginRoot;
	/** The root's marketplace `lspServers` entry instead of a file inside the root. */
	readonly catalog?: boolean;
}

interface Inspected {
	readonly source?: ConfigSource;
	readonly fingerprint: string;
	/** omp reads this location but it could not be inspected here: shadowing cannot be ruled out. */
	readonly blind?: { readonly path: string; readonly detail: string };
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

function sameDirectory(a: string, b: string): boolean {
	return (realpathOrUndefined(a) ?? a) === (realpathOrUndefined(b) ?? b);
}

function identityOf(source: ConfigSource): string {
	return source.realPath ?? source.path;
}

function describeSource(source: ConfigSource): string {
	const plugin = source.pluginId === undefined ? "" : ` ${source.pluginId}`;
	return `${source.path} (${SCOPE_LABEL[source.scope]}${plugin})`;
}

function yamlParser(): YamlParser | undefined {
	if (typeof Bun === "undefined" || !("YAML" in Bun)) return undefined;
	return text => Bun.YAML.parse(text);
}

/** omp skips an LSP server whose `disabled` is truthy; its DAP loader drops `disabled` altogether. */
function isDisabled(kind: ConfigKind, value: ConfigEntryValue): boolean {
	return kind === "lsp" && Boolean(value.disabled);
}

/** Fields of an entry that can change what omp runs: LSP keeps every field, DAP only the ones its loader copies. */
function significantFields(kind: ConfigKind, value: ConfigEntryValue): string[] {
	return Object.keys(value).filter(field => kind === "lsp" || Object.hasOwn(DAP_FIELDS, field));
}

// ── Context ─────────────────────────────────────────────────────────────────────────────────────

/** omp's active profile: `OMP_PROFILE` wins over `PI_PROFILE` whenever it is defined at all (even empty). */
function activeProfile(env: ConfigEnv): string | undefined {
	const raw = (env.OMP_PROFILE !== undefined ? env.OMP_PROFILE : env.PI_PROFILE)?.trim();
	if (!raw || raw === "default") return undefined;
	return PROFILE_PATTERN.test(raw) && !raw.endsWith(".") ? raw : undefined;
}

/** Where omp reads user-level `lsp.*`/`dap.*` from: `~/<PI_CONFIG_DIR or .omp>[/profiles/<profile>]/agent`. `PI_CODING_AGENT_DIR` does not apply. */
function nativeConfigDir(home: string, env: ConfigEnv): string {
	const profile = activeProfile(env);
	return path.join(home, env.PI_CONFIG_DIR || ".omp", ...(profile === undefined ? [] : ["profiles", profile]), "agent");
}

function resolveContext(context: ConfigContext): ResolvedConfigContext {
	const given = context.env ?? process.env;
	// Only the variables this module reads are kept; the snapshot never holds the whole environment.
	const env: Partial<Record<(typeof CONFIG_ENV_NAMES)[number], string>> = {};
	for (const name of CONFIG_ENV_NAMES) {
		const value = given[name];
		if (value !== undefined) env[name] = value;
	}
	const home = path.resolve(context.home ?? os.homedir());
	const cwd = path.resolve(context.cwd);
	const override = env.CLAUDE_CONFIG_DIR?.trim();
	return {
		cwd,
		agentDir: path.resolve(context.agentDir),
		nativeDir: nativeConfigDir(home, env),
		home,
		// omp resolves the override against its own working directory (resolveClaudePaths).
		claudeDir: override ? path.resolve(override) : path.join(home, ".claude"),
		env,
		foreignUserSources: { ...context.foreignUserSources },
		// Only the directories are kept: the rest of the process arguments can hold credentials.
		pluginDirs: [...new Set((context.pluginDirs ?? pluginDirsFromArgv(process.argv)).map(dir => path.resolve(cwd, dir)))],
	};
}

function foreignEnablement(provider: ForeignProvider, context: ResolvedConfigContext): ConfigEnablement {
	const declared = context.foreignUserSources[provider];
	if (declared === true) return "enabled";
	// omp opts Claude in whenever CLAUDE_CONFIG_DIR is set unless the provider is disabled, and a `false` here cannot be told apart from "not opted in".
	if (provider === "claude" && context.env.CLAUDE_CONFIG_DIR?.trim()) return "unknown";
	return declared === false ? "disabled" : "unknown";
}

// ── Plugin roots ────────────────────────────────────────────────────────────────────────────────

interface PluginScan {
	readonly roots: readonly PluginRoot[];
	readonly fingerprints: readonly string[];
	/** Registries that exist but could not be inspected. */
	readonly blind: readonly { readonly path: string; readonly detail: string }[];
}

/**
 * Every `installed_plugins.json` omp may read: Claude's, omp's (default, profile and XDG spellings) and
 * project registries from the cwd upward. It is a superset on purpose: an extra registry can only add conflicts.
 */
function pluginRegistryFiles(context: ResolvedConfigContext): string[] {
	const configName = context.env.PI_CONFIG_DIR || ".omp";
	const profile = activeProfile(context.env);
	const files = new Set<string>();
	files.add(path.join(context.claudeDir, "plugins", "installed_plugins.json"));
	const bases = [path.join(context.home, configName)];
	if (profile !== undefined) bases.push(path.join(context.home, configName, "profiles", profile));
	if (context.env.XDG_DATA_HOME) {
		bases.push(path.join(context.env.XDG_DATA_HOME, "omp"));
		if (profile !== undefined) bases.push(path.join(context.env.XDG_DATA_HOME, "omp", "profiles", profile));
	}
	for (const base of bases) files.add(path.join(base, "plugins", "installed_plugins.json"));
	let dir = context.cwd;
	for (;;) {
		files.add(path.join(dir, configName, "plugins", "installed_plugins.json"));
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return [...files];
}

/** Reads one registry exactly as omp's `parseClaudePluginsRegistry` does: anything it would reject yields no roots. */
function readPluginRegistry(file: string): { roots: PluginRoot[]; fingerprint: string; blind?: string } {
	let stat: fs.Stats;
	try {
		stat = fs.statSync(file);
	} catch {
		return { roots: [], fingerprint: `${file}\tabsent` };
	}
	if (!stat.isFile()) return { roots: [], fingerprint: `${file}\tnot-file` };
	if (stat.size > MAX_CONFIG_BYTES) {
		return {
			roots: [],
			fingerprint: `${file}\ttoo-large`,
			blind: `${file} is larger than ${MAX_CONFIG_BYTES} bytes and was not inspected, so the plugin configuration it lists cannot be ruled out`,
		};
	}
	let bytes: Buffer;
	try {
		bytes = fs.readFileSync(file);
	} catch {
		return { roots: [], fingerprint: `${file}\tunreadable` };
	}
	const fingerprint = `${file}\t${sha256Hex(bytes)}`;
	let data: unknown;
	try {
		data = JSON.parse(bytes.toString("utf8"));
	} catch {
		return { roots: [], fingerprint };
	}
	if (!isRecord(data) || typeof data.version !== "number" || !isRecord(data.plugins)) return { roots: [], fingerprint };
	const roots: PluginRoot[] = [];
	for (const [id, entries] of Object.entries(data.plugins)) {
		const at = id.lastIndexOf("@");
		if (!Array.isArray(entries) || entries.length === 0 || at === -1) continue;
		for (const entry of entries) {
			if (!isRecord(entry) || typeof entry.installPath !== "string" || entry.installPath === "" || entry.enabled === false) continue;
			roots.push({ id, name: id.slice(0, at), path: path.resolve(entry.installPath) });
		}
	}
	return { roots, fingerprint };
}

/**
 * The roots omp was launched with `--plugin-dir`, in order. This follows omp's parser for that one flag:
 * `--plugin-dir <path>` takes the next token whatever it looks like, `--plugin-dir=<path>` is the same,
 * `--` ends option parsing, and a trailing flag without a value adds nothing.
 */
export function pluginDirsFromArgv(argv: readonly string[]): string[] {
	const dirs: string[] = [];
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index]!;
		if (arg === "--") break;
		if (arg === "--plugin-dir") {
			if (index + 1 < argv.length) dirs.push(argv[++index]!);
		} else if (arg.startsWith("--plugin-dir=")) {
			dirs.push(arg.slice("--plugin-dir=".length));
		}
	}
	return dirs;
}

/** A `--plugin-dir` root as omp builds it: the plugin name comes from a manifest inside the directory, else from the directory name. */
function launchPluginRoot(dir: string): { root: PluginRoot; fingerprints: string[] } {
	const fingerprints = [`${dir}\tlaunch`];
	let name = path.basename(dir);
	const real = realpathOrUndefined(dir);
	const manifests = real === undefined ? [] : [path.join(real, ".claude-plugin", "plugin.json"), path.join(real, "plugin.json")];
	for (const manifest of manifests) {
		const resolved = realpathOrUndefined(manifest);
		if (resolved === undefined || !isWithin(real!, resolved)) continue;
		let bytes: Buffer;
		try {
			const stat = fs.statSync(resolved);
			if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) continue;
			bytes = fs.readFileSync(resolved);
		} catch {
			continue;
		}
		fingerprints.push(`${resolved}\t${sha256Hex(bytes)}`);
		try {
			const parsed: unknown = JSON.parse(bytes.toString("utf8"));
			if (isRecord(parsed) && typeof parsed.name === "string" && parsed.name !== "") {
				name = parsed.name;
				break;
			}
		} catch {
			// An unparsable manifest falls through to the next one and then to the directory name, as in omp.
		}
	}
	return { root: { id: `${name}@__local__`, name, path: dir, launch: true }, fingerprints };
}

function scanPlugins(context: ResolvedConfigContext): PluginScan {
	const roots: PluginRoot[] = [];
	const known = new Set<string>();
	const fingerprints: string[] = [];
	const blind: { path: string; detail: string }[] = [];
	// False once the cap is hit: the remaining roots were not inspected, which is reported as unresolved.
	const add = (root: PluginRoot, origin: string): boolean => {
		const identity = `${root.path}\0${root.name}`;
		if (known.has(identity)) return true;
		if (roots.length >= MAX_PLUGIN_ROOTS) {
			blind.push({ path: origin, detail: `more than ${MAX_PLUGIN_ROOTS} plugin roots are installed, so their configuration was not inspected` });
			return false;
		}
		known.add(identity);
		roots.push(root);
		return true;
	};
	for (const dir of context.pluginDirs) {
		const launched = launchPluginRoot(dir);
		fingerprints.push(...launched.fingerprints);
		if (!add(launched.root, dir)) return { roots, fingerprints, blind };
	}
	for (const file of pluginRegistryFiles(context)) {
		const registry = readPluginRegistry(file);
		fingerprints.push(registry.fingerprint);
		if (registry.blind !== undefined) blind.push({ path: file, detail: registry.blind });
		for (const root of registry.roots) {
			if (!add(root, file)) return { roots, fingerprints, blind };
		}
	}
	return { roots, fingerprints, blind };
}

// ── Candidate files ─────────────────────────────────────────────────────────────────────────────

/** Candidate files for one kind, highest precedence first, in omp's own order (`configFileSources`). */
function listCandidates(kind: ConfigKind, context: ResolvedConfigContext, plugins: readonly PluginRoot[]): Candidate[] {
	const names = [`${kind}.json`, `.${kind}.json`, `${kind}.yaml`, `.${kind}.yaml`, `${kind}.yml`, `.${kind}.yml`];
	const ordered: Omit<Candidate, "rank">[] = [];
	const addDir = (
		dir: string,
		scope: ConfigScope,
		provider: Candidate["provider"],
		enablement: ConfigEnablement = "enabled",
		plugin?: PluginRoot,
	): void => {
		for (const name of names) {
			ordered.push({ kind, path: path.join(dir, name), scope, provider, format: name.endsWith(".json") ? "json" : "yaml", enablement, plugin });
		}
	};
	addDir(context.cwd, "cwd-root", undefined);
	for (const [dir, provider] of [
		[".omp", "omp"],
		[".claude", "claude"],
		[".codex", "codex"],
		[".gemini", "gemini"],
	] as const) {
		addDir(path.join(context.cwd, dir), "project-dir", provider);
	}
	addDir(context.nativeDir, "native-user", "omp");
	addDir(context.claudeDir, "foreign-user", "claude", foreignEnablement("claude", context));
	addDir(path.join(context.home, ".codex"), "foreign-user", "codex", foreignEnablement("codex", context));
	addDir(path.join(context.home, ".gemini"), "foreign-user", "gemini", foreignEnablement("gemini", context));
	for (const root of plugins) {
		addDir(root.path, "plugin", undefined, "unknown", root);
		if (kind === "lsp") {
			ordered.push({
				kind,
				path: path.resolve(root.path, "..", "..", "marketplace.json"),
				scope: "plugin",
				format: "json",
				enablement: "unknown",
				plugin: root,
				catalog: true,
			});
		}
	}
	addDir(context.home, "home", undefined);
	return ordered.map((candidate, index) => ({ ...candidate, rank: ordered.length - index }));
}

interface ParsedDocument {
	readonly shape: "wrapped" | "flat";
	readonly entries: Map<string, ConfigEntryValue>;
	readonly keys: string[];
	readonly wrapperIgnored: boolean;
	/** Why omp's loader would throw on this document, when it would. */
	readonly fatal?: string;
}

/**
 * omp (`normalizeConfig`) uses the `servers`/`adapters` wrapper only when it is an object; otherwise it reads
 * the whole document as a flat map. A `null` LSP entry makes its loader throw.
 */
function normalizeDocument(kind: ConfigKind, value: unknown): ParsedDocument | string {
	if (!isRecord(value)) return "the top level must be an object";
	const key = wrapperKey(kind);
	const wrapper = value[key];
	const wrapped = isRecord(wrapper);
	const members: Record<string, unknown> = wrapped
		? wrapper
		: Object.fromEntries(Object.entries(value).filter(([name]) => !(kind === "lsp" && name === "idleTimeoutMs")));
	const entries = new Map<string, ConfigEntryValue>();
	for (const [name, entry] of Object.entries(members)) {
		if (isRecord(entry)) entries.set(name, entry);
	}
	const keys = Object.keys(members);
	const nullEntry = kind === "lsp" ? keys.find(name => members[name] === null) : undefined;
	return {
		shape: wrapped || keys.length === 0 ? "wrapped" : "flat",
		entries,
		keys,
		wrapperIgnored: !wrapped && Object.hasOwn(value, key),
		...(nullEntry === undefined
			? {}
			: { fatal: `omp's loader throws on the null entry \`${nullEntry}\`, so no language server configuration loads while this file is read` }),
	};
}

type SourceExtra = Partial<Pick<ConfigSource, "detail" | "sha256" | "shape" | "entries" | "keys" | "wrapperIgnored">>;

function makeSource(candidate: Candidate, symlink: boolean, state: ConfigSourceState, extra: SourceExtra = {}): ConfigSource {
	return {
		kind: candidate.kind,
		path: candidate.path,
		realPath: realpathOrUndefined(candidate.path),
		scope: candidate.scope,
		provider: candidate.provider,
		pluginId: candidate.plugin?.id,
		format: candidate.format,
		rank: candidate.rank,
		enablement: candidate.enablement,
		symlink,
		state,
		entries: new Map(),
		keys: [],
		wrapperIgnored: false,
		...extra,
	};
}

function inspected(source: ConfigSource, blind?: string): Inspected {
	const fingerprint = [source.path, source.state, source.symlink ? "link" : "file", source.sha256 ?? "-"].join("\t");
	return { source, fingerprint, ...(blind === undefined ? {} : { blind: { path: source.path, detail: blind } }) };
}

function inspectFile(candidate: Candidate, parseYaml: YamlParser | undefined): Inspected {
	let link: fs.Stats;
	try {
		link = fs.lstatSync(candidate.path);
	} catch (error) {
		const code = errnoOf(error);
		if (code === "ENOENT" || code === "ENOTDIR") return { fingerprint: `${candidate.path}\tabsent` };
		return inspected(makeSource(candidate, false, "unreadable", { detail: `cannot inspect: ${brief(errorMessage(error))}` }));
	}
	const symlink = link.isSymbolicLink();
	let stat = link;
	if (symlink) {
		try {
			stat = fs.statSync(candidate.path);
		} catch {
			return inspected(makeSource(candidate, true, "unreadable", { detail: "dangling or unreadable symbolic link" }));
		}
	}
	if (!stat.isFile()) return inspected(makeSource(candidate, symlink, "not-regular", { detail: "not a regular file" }));
	if (stat.size > MAX_CONFIG_BYTES) {
		const detail = `larger than ${MAX_CONFIG_BYTES} bytes and not inspected`;
		return inspected(makeSource(candidate, symlink, "too-large", { detail }), detail);
	}
	let bytes: Buffer;
	try {
		bytes = fs.readFileSync(candidate.path);
	} catch (error) {
		return inspected(makeSource(candidate, symlink, "unreadable", { detail: `cannot read: ${brief(errorMessage(error))}` }));
	}
	const sha256 = sha256Hex(bytes);
	let value: unknown;
	try {
		if (candidate.format === "json") {
			value = JSON.parse(bytes.toString("utf8"));
		} else if (parseYaml === undefined) {
			const detail = "YAML support (Bun.YAML) is unavailable, so this file was not inspected";
			return inspected(makeSource(candidate, symlink, "unreadable", { detail, sha256 }), detail);
		} else {
			value = parseYaml(bytes.toString("utf8"));
		}
	} catch (error) {
		return inspected(makeSource(candidate, symlink, "invalid", { detail: `not valid ${candidate.format.toUpperCase()}: ${brief(errorMessage(error))}`, sha256 }));
	}
	const document = normalizeDocument(candidate.kind, value);
	if (typeof document === "string") return inspected(makeSource(candidate, symlink, "invalid", { detail: document, sha256 }));
	return inspected(
		makeSource(candidate, symlink, "ok", { sha256, shape: document.shape, entries: document.entries, keys: document.keys, wrapperIgnored: document.wrapperIgnored }),
		document.fatal,
	);
}

interface CatalogRead {
	readonly fingerprint: string;
	readonly sha256?: string;
	readonly plugins?: readonly unknown[];
	readonly blind?: string;
}

/** A plugin marketplace catalog; anything omp cannot parse reads as an absent catalog. */
function readCatalogFile(file: string): CatalogRead {
	let stat: fs.Stats;
	try {
		stat = fs.statSync(file);
	} catch {
		return { fingerprint: `${file}\tabsent` };
	}
	if (!stat.isFile()) return { fingerprint: `${file}\tnot-file` };
	if (stat.size > MAX_CONFIG_BYTES) {
		return {
			fingerprint: `${file}\ttoo-large`,
			blind: `${file} is larger than ${MAX_CONFIG_BYTES} bytes and was not inspected, so the plugin servers it defines cannot be ruled out`,
		};
	}
	let bytes: Buffer;
	try {
		bytes = fs.readFileSync(file);
	} catch {
		return { fingerprint: `${file}\tunreadable` };
	}
	const sha256 = sha256Hex(bytes);
	const fingerprint = `${file}\t${sha256}`;
	try {
		const catalog: unknown = JSON.parse(bytes.toString("utf8"));
		if (isRecord(catalog) && Array.isArray(catalog.plugins)) return { fingerprint, sha256, plugins: catalog.plugins };
	} catch {
		// omp skips a catalog it cannot parse.
	}
	return { fingerprint, sha256 };
}

/** The marketplace `lspServers` of a plugin root, resolved like omp's `readMarketplaceLspConfig`: an inline object, or a config file inside the root. */
function inspectCatalog(candidate: Candidate, parseYaml: YamlParser | undefined, cache: Map<string, CatalogRead>): Inspected {
	const root = candidate.plugin!;
	const fingerprints: string[] = [];
	for (const location of [path.resolve(root.path, "..", "..", "marketplace.json"), path.resolve(root.path, "..", "..", ".claude-plugin", "marketplace.json")]) {
		let catalog = cache.get(location);
		if (catalog === undefined) {
			catalog = readCatalogFile(location);
			cache.set(location, catalog);
		}
		fingerprints.push(catalog.fingerprint);
		if (catalog.blind !== undefined) return { fingerprint: fingerprints.join("\n"), blind: { path: location, detail: catalog.blind } };
		const plugin = catalog.plugins?.find(item => isRecord(item) && item.name === root.name);
		if (!isRecord(plugin)) continue;
		const servers = plugin.lspServers;
		if (typeof servers === "string") {
			const file = path.resolve(root.path, servers);
			if (!isWithin(realpathOrUndefined(root.path) ?? root.path, realpathOrUndefined(file) ?? file)) return { fingerprint: fingerprints.join("\n") };
			const found = inspectFile({ ...candidate, path: file, format: /\.ya?ml$/i.test(file) ? "yaml" : "json", catalog: undefined }, parseYaml);
			return { ...found, fingerprint: [...fingerprints, found.fingerprint].join("\n") };
		}
		if (!isRecord(servers)) return { fingerprint: fingerprints.join("\n") };
		const document = normalizeDocument("lsp", { servers });
		if (typeof document === "string") return { fingerprint: fingerprints.join("\n") };
		const source = makeSource({ ...candidate, path: `${location}#plugins/${root.name}`, catalog: undefined }, false, "ok", {
			sha256: catalog.sha256,
			shape: document.shape,
			entries: document.entries,
			keys: document.keys,
			wrapperIgnored: false,
		});
		const result = inspected(source, document.fatal);
		return { ...result, fingerprint: fingerprints.join("\n") };
	}
	return { fingerprint: fingerprints.join("\n") };
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
	if (source.wrapperIgnored) {
		return {
			code: "invalid",
			detail: `${source.path} is not usable (\`${wrapperKey(source.kind)}\` is not an object, so omp reads the whole file as a flat map); it was not modified. Fix or move it, then retry.`,
		};
	}
	return undefined;
}

/** The native JSON file entries are merged into: an existing variant (highest precedence first) or a new `<kind>.json`. */
function computeTarget(
	kind: ConfigKind,
	candidates: readonly Candidate[],
	sources: readonly ConfigSource[],
	context: ResolvedConfigContext,
): ConfigTarget {
	const nativeJson = candidates.filter(candidate => candidate.scope === "native-user" && candidate.format === "json");
	const first = nativeJson[0]!;
	if (!sameDirectory(context.agentDir, context.nativeDir)) {
		return {
			kind,
			path: path.join(context.agentDir, `${kind}.json`),
			exists: false,
			shape: "new",
			rank: first.rank,
			keys: [],
			problem: {
				code: "elsewhere",
				detail: `omp reads user-level ${kind}.json from ${context.nativeDir} (the home directory, PI_CONFIG_DIR and the active profile decide it; PI_CODING_AGENT_DIR does not apply), not from ${context.agentDir}, so an entry written there would never be used and nothing was written. Use ${context.nativeDir} as the agent directory, or add the entry there yourself.`,
			},
		};
	}
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
			keys: source.keys,
			...(problem === undefined ? {} : { problem }),
		};
	}
	return { kind, path: first.path, exists: false, shape: "new", rank: first.rank, keys: [] };
}

interface KindInspection {
	sources: ConfigSource[];
	target: ConfigTarget;
	issues: ConfigIssue[];
	unresolved: ConfigIssue[];
	fingerprints: string[];
}

function inspectKind(
	kind: ConfigKind,
	context: ResolvedConfigContext,
	parseYaml: YamlParser | undefined,
	plugins: PluginScan,
	catalogs: Map<string, CatalogRead>,
): KindInspection {
	const candidates = listCandidates(kind, context, plugins.roots);
	const sources: ConfigSource[] = [];
	const issues: ConfigIssue[] = [];
	const unresolved: ConfigIssue[] = [];
	const fingerprints: string[] = [];
	const flagged = new Set<string>();
	const flag = (file: string, detail: string): void => {
		if (flagged.has(`${file}\0${detail}`)) return;
		flagged.add(`${file}\0${detail}`);
		const issue: ConfigIssue = { kind, path: file, detail };
		issues.push(issue);
		unresolved.push(issue);
	};
	for (const registry of plugins.blind) flag(registry.path, registry.detail);
	for (const candidate of candidates) {
		const found = candidate.catalog === true ? inspectCatalog(candidate, parseYaml, catalogs) : inspectFile(candidate, parseYaml);
		fingerprints.push(found.fingerprint);
		if (found.source !== undefined) sources.push(found.source);
		if (found.blind !== undefined) {
			flag(found.blind.path, found.blind.detail);
		} else if (found.source !== undefined && found.source.state !== "ok") {
			issues.push({ kind, path: found.source.path, detail: found.source.detail ?? found.source.state });
		}
	}
	return { sources, target: computeTarget(kind, candidates, sources, context), issues, unresolved, fingerprints };
}

/** Reads every omp config location for LSP and DAP without executing anything. */
export async function inspectConfig(context: ConfigContext): Promise<ConfigSnapshot> {
	const resolved = resolveContext(context);
	const parseYaml = yamlParser();
	const plugins = scanPlugins(resolved);
	const catalogs = new Map<string, CatalogRead>();
	const lsp = inspectKind("lsp", resolved, parseYaml, plugins, catalogs);
	const dap = inspectKind("dap", resolved, parseYaml, plugins, catalogs);
	const sources = [...lsp.sources, ...dap.sources];
	const notes = ["omp's built-in server and adapter definitions are the base layer; they are not listed here."];
	const launched = plugins.roots.filter(root => root.launch === true).length;
	if (launched > 0) {
		notes.push(`${launched} root(s) passed to omp with --plugin-dir were inspected. They last for this launch only, so they can block a write but never make an entry ready.`);
	}
	if (plugins.roots.length > launched) {
		notes.push(
			`${plugins.roots.length - launched} installed plugin root(s) were checked for lsp/dap configuration. Whether omp enables each one cannot be determined statically, so their configuration is treated as possibly effective: it can block a write but never counts as ready.`,
		);
	}
	for (const source of sources) {
		if (source.scope !== "foreign-user" || source.enablement !== "unknown" || source.state !== "ok" || source.entries.size === 0) continue;
		notes.push(`${source.path} is another tool's user config. omp reads it only when that provider is enabled, which was not provided, so it is treated as possibly effective.`);
	}
	return {
		context: resolved,
		sources,
		targets: { lsp: lsp.target, dap: dap.target },
		issues: [...lsp.issues, ...dap.issues],
		unresolved: [...lsp.unresolved, ...dap.unresolved],
		notes,
		digest: sha256Hex([...plugins.fingerprints, ...lsp.fingerprints, ...dap.fingerprints].join("\n")),
	};
}

// ── Effective configuration ─────────────────────────────────────────────────────────────────────

/**
 * Sources defining `key`, lowest precedence first; a file reachable through several locations counts once.
 * `certain` keeps only sources omp is known to read; `possible` also keeps those whose enablement is unknown.
 */
function layersFor(snapshot: ConfigSnapshot, kind: ConfigKind, key: string, view: "certain" | "possible"): Layer[] {
	const layers: Layer[] = [];
	const seen = new Set<string>();
	for (const source of snapshot.sources) {
		if (source.kind !== kind || source.state !== "ok") continue;
		if (view === "certain" ? source.enablement !== "enabled" : source.enablement === "disabled") continue;
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

/** What omp would use for `key`, computed statically; undefined when no source omp is known to read defines it. */
export function effectiveEntry(snapshot: ConfigSnapshot, kind: ConfigKind, key: string): EffectiveEntry | undefined {
	const layers = layersFor(snapshot, kind, key, "certain");
	const top = layers[layers.length - 1];
	if (top === undefined) return undefined;
	const value = mergeLayers(kind, layers);
	const command = typeof value.command === "string" ? resolveEntryCommand(kind, value.command, snapshot.context) : undefined;
	const certain = new Set(layers.map(layer => identityOf(layer.source)));
	return {
		kind,
		key,
		value,
		layers,
		source: top.source,
		projectSupplied: layers.some(layer => layer.source.scope === "cwd-root" || layer.source.scope === "project-dir"),
		disabled: isDisabled(kind, value),
		...(command === undefined ? {} : { command }),
		unverified: layersFor(snapshot, kind, key, "possible")
			.filter(layer => layer.source.enablement === "unknown" && !certain.has(identityOf(layer.source)))
			.map(layer => layer.source),
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
	if (entry.kind === "lsp") {
		// omp drops a whole LSP entry whose fileTypes or rootMarkers normalise to an empty list (empty strings are filtered out too).
		for (const field of ["fileTypes", "rootMarkers"]) {
			const list = intended[field];
			if (Array.isArray(list) && (list.length === 0 || list.some(item => item === ""))) {
				return { ok: false, reason: `value.${field} needs at least one entry and no empty strings; omp ignores a server without it` };
			}
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
	if (isDisabled(kind, current) && !isDisabled(kind, intended)) return false;
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

/** First field of a lower-precedence layer whose value differs from the approved one. */
function differingField(kind: ConfigKind, layer: Layer, intended: JsonObject): string | undefined {
	return Object.keys(intended).find(field => Object.hasOwn(layer.value, field) && fieldConflict(kind, field, layer.value[field], intended[field]));
}

/**
 * First field of a higher-precedence layer (the project) that would change the approved entry: any field
 * omp keeps that the approval does not contain with exactly the same value, not only the proposed ones.
 */
function overriddenField(kind: ConfigKind, layer: ConfigEntryValue, intended: JsonObject): string | undefined {
	for (const field of significantFields(kind, layer)) {
		if (!Object.hasOwn(intended, field)) return field;
		const have = layer[field];
		const wanted = intended[field];
		if (kind === "dap" && Object.hasOwn(DEFAULTS_FIELDS, field)) {
			// omp ignores a non-object defaults value and merges objects one level deep.
			if (!isRecord(have)) continue;
			if (!isRecord(wanted)) return field;
			for (const [name, value] of Object.entries(have)) {
				if (!Object.hasOwn(wanted, name) || !isDeepStrictEqual(value, wanted[name])) return `${field}.${name}`;
			}
			continue;
		}
		if (!isDeepStrictEqual(have, wanted)) return field;
	}
	return undefined;
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
	const possible = layersFor(snapshot, kind, key, "possible");
	const own = possible.find(layer => identityOf(layer.source) === targetIdentity);
	const others = possible.filter(layer => layer !== own);
	const higher = others.filter(layer => layer.source.rank > target.rank);
	const lower = others.filter(layer => layer.source.rank < target.rank);
	for (const layer of higher) {
		if (isDisabled(kind, layer.value)) {
			return conflictFor(layer, `${describeSource(layer.source)} disables ${label} and takes precedence over the user-level config. Remove that setting or work from another project, then retry; nothing was changed.`);
		}
		const field = overriddenField(kind, layer.value, intended);
		if (field !== undefined) {
			return conflictFor(
				layer,
				`${describeSource(layer.source)} defines ${label} and its \`${field}\` differs from, or is absent from, the approved entry; it takes precedence over the user-level config, so the approved entry would not be used as approved. Remove or align that entry, then retry; nothing was changed.`,
			);
		}
	}
	if (own !== undefined) {
		if (!satisfies(kind, own.value, intended)) {
			return { status: "conflict", detail: `${target.path} already defines ${label} differently; it was not replaced. Edit or remove it yourself, or keep the existing tool.`, path: target.path, conflictsWith: [target.path] };
		}
		return { status: "unchanged", detail: `${label} is already configured as approved in ${target.path}; nothing was written.`, path: target.path };
	}
	if (target.keys.includes(key)) {
		return {
			status: "conflict",
			detail: `${target.path} already has a \`${key}\` value that is not an object; it was not replaced. Fix or remove it yourself, then retry.`,
			path: target.path,
			conflictsWith: [target.path],
		};
	}
	for (const layer of lower) {
		const field = differingField(kind, layer, intended);
		if (field !== undefined) {
			return conflictFor(layer, `${describeSource(layer.source)} already configures ${label} with a different \`${field}\`; adding the managed tool would replace or bypass it, so nothing was changed. Keep using that tool or remove its entry yourself.`);
		}
		if (isDisabled(kind, layer.value) && intended.disabled !== false) {
			return conflictFor(layer, `${describeSource(layer.source)} disables ${label}; the managed tool would stay disabled. Remove that setting yourself, then retry; nothing was changed.`);
		}
	}
	// Only sources omp is known to read can make the entry already effective.
	const certain = layersFor(snapshot, kind, key, "certain");
	const top = certain[certain.length - 1];
	if (top !== undefined && satisfies(kind, mergeLayers(kind, certain), intended)) {
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

interface CurrentFile {
	readonly exists: boolean;
	readonly sha256?: string;
	readonly text: string;
	readonly mode: number;
}

/** Reads the target through a descriptor opened without following links, so a link swapped in meanwhile is refused. */
function readNow(file: string): CurrentFile {
	let fd: number;
	try {
		fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
	} catch (error) {
		const code = errnoOf(error);
		if (code === "ENOENT") return { exists: false, text: "", mode: 0o666 };
		if (code === "ELOOP") throw new Error(`${file} is now a symbolic link`);
		throw error;
	}
	try {
		const stat = fs.fstatSync(fd);
		if (!stat.isFile()) throw new Error(`${file} is no longer a regular file`);
		if (stat.size > MAX_CONFIG_BYTES) throw new Error(`${file} is larger than ${MAX_CONFIG_BYTES} bytes`);
		const bytes = fs.readFileSync(fd);
		return { exists: true, sha256: sha256Hex(bytes), text: bytes.toString("utf8"), mode: stat.mode & 0o777 };
	} finally {
		fs.closeSync(fd);
	}
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

/**
 * One exclusive, compare-and-swap update of a native file: reread through a no-follow descriptor, merge, then
 * publish atomically after a last check. A new file is created only if it still does not exist (hard link), and an
 * existing file keeps its exact permissions through fchmod on the temporary file, never a chmod on the path.
 */
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
		fs.mkdirSync(path.dirname(target.path), { recursive: true });
		let raced = false;
		try {
			await writeFileAtomic(target.path, serialized, current.mode, {
				exactMode: current.exists,
				createOnly: !current.exists,
				beforePublish: () => {
					const again = readNow(target.path);
					if (again.exists !== current.exists || again.sha256 !== current.sha256) {
						raced = true;
						throw new Error(`${target.path} changed while it was being updated`);
					}
				},
			});
		} catch (error) {
			if (raced || errnoOf(error) === "EEXIST") return changed;
			throw error;
		}
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
