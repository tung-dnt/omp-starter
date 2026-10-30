import { semver } from "bun";
import type { Exec, WizardUi } from "../setup";

export type PluginKey = "agent-skills" | "starter";
type Scope = "user" | "project";
interface PluginTarget {
	readonly key: PluginKey;
	readonly id: string;
	readonly marketplace: string;
	readonly repo: string;
	readonly catalog: string;
	readonly packageNames: readonly string[];
}

export const AGENT_SKILLS_PLUGIN: PluginTarget = {
	key: "agent-skills", id: "agent-skills@tung-agent-skills", marketplace: "tung-agent-skills",
	repo: "tung-dnt/agent-skills", catalog: ".claude-plugin/marketplace.json", packageNames: ["agent-skills"],
};
const STARTER_PLUGIN: PluginTarget = {
	key: "starter", id: "starter@omp-starter", marketplace: "omp-starter",
	repo: "tung-dnt/omp-starter", catalog: ".omp-plugin/marketplace.json", packageNames: ["omp-starter", "starter"],
};
// Update the updater last; all targets and code are loaded before installation changes.
const TARGETS = [AGENT_SKILLS_PLUGIN, STARTER_PLUGIN];

export type PluginInstallation =
	{ readonly key: PluginKey; readonly kind: "marketplace"; readonly scope: Scope; readonly version: string }
	| { readonly key: PluginKey; readonly kind: "unmanaged"; readonly version: string };
export type CatalogFetch = (url: string, init: { signal: AbortSignal }) => Promise<Response>;
interface UpdateOptions {
	readonly keys?: readonly PluginKey[];
	readonly fetchCatalog?: CatalogFetch;
	readonly installations?: readonly PluginInstallation[];
}

function object(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Query the active OMP CLI context; never guess HOME/profile registry paths. */
export async function readPluginInstallations(exec: Exec): Promise<readonly PluginInstallation[]> {
	const result = await exec("omp", ["plugin", "list", "--json"]);
	if (result.code !== 0) throw new Error(`Cannot read installed plugin versions (native exit ${result.code}).`);
	let value: unknown;
	try { value = JSON.parse(result.stdout); } catch { throw new Error("OMP plugin list did not return supported JSON metadata."); }
	if (!object(value) || !Array.isArray(value.marketplace) || !Array.isArray(value.npm)) throw new Error("OMP plugin list returned an unsupported metadata shape.");
	const rows: PluginInstallation[] = [];
	const scopes = new Set<string>();
	for (const group of value.marketplace) {
		if (!object(group) || typeof group.id !== "string") continue;
		const id = group.id.toLowerCase();
		const target = TARGETS.find(item => item.id.toLowerCase() === id);
		if (!target) continue;
		if (!Array.isArray(group.entries)) throw new Error(`Invalid installed metadata for ${target.id}.`);
		for (const entry of group.entries) {
			if (!object(entry) || entry.scope !== "user" && entry.scope !== "project" || typeof entry.version !== "string" || !entry.version) throw new Error(`Invalid installed scope/version for ${target.id}.`);
			const identity = `${target.key}:${entry.scope}`;
			if (scopes.has(identity)) throw new Error(`Ambiguous installed metadata for ${target.id} (${entry.scope}).`);
			scopes.add(identity);
			rows.push({ key: target.key, kind: "marketplace", scope: entry.scope, version: entry.version });
		}
	}
	for (const entry of value.npm) {
		if (!object(entry) || typeof entry.name !== "string") continue;
		const name = entry.name;
		const target = TARGETS.find(item => item.packageNames.includes(name));
		if (target) rows.push({ key: target.key, kind: "unmanaged", version: typeof entry.version === "string" ? entry.version : "unknown" });
	}
	return rows;
}

function validVersion(version: string): boolean {
	return semver.satisfies(version, version);
}

async function latestVersion(target: PluginTarget, fetchCatalog: CatalogFetch): Promise<string> {
	let response: Response;
	try {
		response = await fetchCatalog(`https://raw.githubusercontent.com/${target.repo}/main/${target.catalog}`, { signal: AbortSignal.timeout(5_000) });
	} catch {
		throw new Error(`Cannot check the latest ${target.key} version; network request failed or timed out.`);
	}
	if (!response.ok) throw new Error(`Cannot check the latest ${target.key} version (HTTP ${response.status}).`);
	let catalog: unknown;
	try { catalog = await response.json(); } catch { throw new Error(`Invalid version catalog for ${target.key}.`); }
	if (!object(catalog) || catalog.name !== target.marketplace || !Array.isArray(catalog.plugins)) throw new Error(`Unexpected version catalog for ${target.key}.`);
	const plugins = catalog.plugins.filter((entry: unknown) => object(entry) && entry.name === target.key);
	const plugin: unknown = plugins[0];
	if (plugins.length !== 1 || !object(plugin) || typeof plugin.version !== "string" || !validVersion(plugin.version)) throw new Error(`No valid published semantic version for ${target.key}.`);
	return plugin.version;
}

/** Manual-only interaction. Reading availability never refreshes or upgrades installed code. */
export async function checkPluginUpdates(
	ui: Pick<WizardUi, "notify" | "confirm">,
	exec: Exec,
	options: UpdateOptions = {},
): Promise<void> {
	const installations = options.installations ?? await readPluginInstallations(exec);
	const fetchCatalog = options.fetchCatalog ?? fetch;
	for (const target of TARGETS) {
		if (options.keys && !options.keys.includes(target.key)) continue;
		const matching = installations.filter(row => row.key === target.key);
		const managed = matching.filter(row => row.kind === "marketplace");
		if (managed.length === 0) {
			ui.notify(matching.length ? `${target.key} uses an unmanaged npm/link/Git installation; update it through its original installation method.` : `${target.key} is not installed; no update was attempted.`, "info");
			continue;
		}
		const latest = await latestVersion(target, fetchCatalog);
		let refreshed = false;
		for (const installation of managed) {
			if (!validVersion(installation.version)) throw new Error(`Cannot compare the installed ${target.key} version format; no update was attempted.`);
			if (semver.order(latest, installation.version) <= 0) {
				ui.notify(`${target.key} (${installation.scope}): installed ${installation.version}; published ${latest}. No newer version is available.`, "info");
				continue;
			}
			ui.notify(`${target.key} (${installation.scope}): installed ${installation.version}; published ${latest}.`, "info");
			if (!(await ui.confirm(`Update ${target.key}?`, `${target.id} (${installation.scope}): ${installation.version} → ${latest} available upstream. Refresh marketplace ${target.marketplace} and install its latest version for this scope? Native version caches may be shared across scopes; unmanaged copies are not updated. Restart the session afterward; it will not be reloaded automatically.`))) continue;
			// Re-read after consent: another session may already have updated/removed this scope.
			const current = (await readPluginInstallations(exec)).find(row => row.key === target.key && row.kind === "marketplace" && row.scope === installation.scope);
			if (!current || current.kind !== "marketplace") throw new Error(`${target.key} (${installation.scope}) is no longer installed; update cancelled.`);
			if (current.version !== installation.version) throw new Error(`${target.key} (${installation.scope}) changed while awaiting confirmation; check again before updating.`);
			if (!refreshed) {
				const refresh = await exec("omp", ["plugin", "marketplace", "update", target.marketplace], { timeout: 120_000 });
				if (refresh.code !== 0) throw new Error(`Marketplace refresh for ${target.marketplace} failed (native exit ${refresh.code}); no upgrade was attempted.`);
				refreshed = true;
			}
			const upgraded = await exec("omp", ["plugin", "upgrade", "--scope", installation.scope, target.id], { timeout: 300_000 });
			if (upgraded.code !== 0) throw new Error(`Update of ${target.id} (${installation.scope}) failed (native exit ${upgraded.code}); installed state may have changed. Check again before retrying.`);
			const after = (await readPluginInstallations(exec)).find(row => row.key === target.key && row.kind === "marketplace" && row.scope === installation.scope);
			if (!after || !validVersion(after.version) || semver.order(after.version, installation.version) <= 0) throw new Error(`Native update finished, but a newer installed ${target.key} version could not be verified.`);
			ui.notify(`Updated ${target.key} (${installation.scope}): ${installation.version} → ${after.version}. Restart your OMP session to load updated extensions; no reload was performed.`, "info");
		}
	}
}
