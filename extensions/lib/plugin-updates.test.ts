import { expect, test } from "bun:test";
import { checkPluginUpdates, readPluginInstallations, type CatalogFetch } from "./plugin-updates";
import type { Exec, WizardUi } from "../setup";

const SKILLS = "agent-skills@tung-agent-skills";
const STARTER = "starter@omp-starter";

type Scope = "user" | "project";
interface Installed { id: string; scope: Scope; version: string; enabled?: boolean }

function fixture(options: {
	installed?: Installed[];
	confirm?: boolean | boolean[];
	latest?: string;
	failure?: "list" | "refresh" | "upgrade" | "post-read";
	catalog?: unknown;
	npm?: { name: string; version: string }[];
} = {}) {
	const installed = structuredClone(options.installed ?? [
		{ id: SKILLS, scope: "user", version: "1.0.0" },
		{ id: STARTER, scope: "user", version: "1.0.0", enabled: false },
	]);
	const latest = options.latest ?? "1.1.0";
	let catalogEpoch = 0;
	let upgraded = false;
	const prompts: string[] = [];
	const notes: string[] = [];
	const answers = Array.isArray(options.confirm) ? [...options.confirm] : undefined;
	const defaultAnswer = typeof options.confirm === "boolean" ? options.confirm : true;
	const ui: WizardUi = {
		confirm: async (_title, message) => { prompts.push(message); return answers ? answers.shift() ?? false : defaultAnswer; },
		notify: message => notes.push(message),
		select: async () => undefined,
		input: async () => undefined,
	};
	const exec: Exec = async (_command, args) => {
		if (args[1] === "list") {
			if (options.failure === "list" || options.failure === "post-read" && upgraded) return { code: 1, stdout: "", stderr: "private native details" };
			return { code: 0, stderr: "", stdout: JSON.stringify({
				npm: options.npm ?? [],
				marketplace: installed.map(entry => ({ id: entry.id, scope: entry.scope, entries: [{ ...entry }] })),
			}) };
		}
		if (args[1] === "marketplace" && args[2] === "update") {
			if (options.failure === "refresh") return { code: 1, stdout: "", stderr: "SECRET_NATIVE_DETAIL" };
			catalogEpoch += 1;
			return { code: 0, stdout: "", stderr: "" };
		}
		if (args[1] === "upgrade") {
			if (options.failure === "upgrade") return { code: 1, stdout: "", stderr: "SECRET_NATIVE_DETAIL" };
			const scopeIndex = args.indexOf("--scope");
			const scope = args[scopeIndex + 1];
			const id = args.find(value => value.includes("@"));
			if (scopeIndex < 0 || !id || catalogEpoch === 0) return { code: 2, stdout: "", stderr: "unsafe upgrade" };
			const entry = installed.find(row => row.id === id && row.scope === scope);
			if (!entry) return { code: 2, stdout: "", stderr: "missing target" };
			entry.version = latest;
			upgraded = true;
			return { code: 0, stdout: "", stderr: "" };
		}
		throw new Error("Unexpected native operation in update fixture");
	};
	const fetchCatalog: CatalogFetch = async url => {
		if (options.catalog !== undefined) return new Response(JSON.stringify(options.catalog));
		const skills = url.includes("agent-skills");
		return new Response(JSON.stringify({ name: skills ? "tung-agent-skills" : "omp-starter", plugins: [{ name: skills ? "agent-skills" : "starter", version: latest }] }));
	};
	return { installed, ui, exec, fetchCatalog, prompts, notes, catalogEpoch: () => catalogEpoch };
}

test("updates only individually approved plugin installations and preserves disabled state", async () => {
	const f = fixture({ confirm: [true, false] });
	await checkPluginUpdates(f.ui, f.exec, { fetchCatalog: f.fetchCatalog });
	expect(f.installed).toEqual([
		{ id: SKILLS, scope: "user", version: "1.1.0" },
		{ id: STARTER, scope: "user", version: "1.0.0", enabled: false },
	]);
	expect(f.prompts.every(message => message.includes("user"))).toBe(true);
});

test("declining all updates leaves installation and catalog state untouched", async () => {
	const f = fixture({ confirm: false });
	await checkPluginUpdates(f.ui, f.exec, { fetchCatalog: f.fetchCatalog });
	expect(f.installed.map(row => row.version)).toEqual(["1.0.0", "1.0.0"]);
	expect(f.catalogEpoch()).toBe(0);
});

test("compares semantic versions instead of reinstalling equal or older versions", async () => {
	for (const latest of ["1.0.0", "0.9.9", "1.0.0+other-build"]) {
		const f = fixture({ latest });
		await checkPluginUpdates(f.ui, f.exec, { fetchCatalog: f.fetchCatalog });
		expect(f.installed.map(row => row.version)).toEqual(["1.0.0", "1.0.0"]);
		expect(f.prompts).toEqual([]);
		expect(f.catalogEpoch()).toBe(0);
	}
	const newer = fixture({ latest: "1.10.0-rc.1" });
	await checkPluginUpdates(newer.ui, newer.exec, { fetchCatalog: newer.fetchCatalog });
	expect(newer.installed.map(row => row.version)).toEqual(["1.10.0-rc.1", "1.10.0-rc.1"]);
});

test("scope-specific consent cannot upgrade another installation of the same plugin", async () => {
	const f = fixture({ installed: [{ id: SKILLS, scope: "user", version: "1.0.0" }, { id: SKILLS, scope: "project", version: "1.0.0" }], confirm: [true, false] });
	await checkPluginUpdates(f.ui, f.exec, { keys: ["agent-skills"], fetchCatalog: f.fetchCatalog });
	expect(f.installed).toEqual([{ id: SKILLS, scope: "user", version: "1.1.0" }, { id: SKILLS, scope: "project", version: "1.0.0" }]);
});

test("missing and unmanaged installations are never converted into marketplace installs", async () => {
	const f = fixture({ installed: [], npm: [{ name: "omp-starter", version: "1.0.0" }, { name: "agent-skills", version: "1.0.0" }] });
	await checkPluginUpdates(f.ui, f.exec, { fetchCatalog: f.fetchCatalog });
	expect(f.installed).toEqual([]);
	expect(f.prompts).toEqual([]);
	expect(f.catalogEpoch()).toBe(0);
	const absent = fixture({ installed: [] });
	await checkPluginUpdates(absent.ui, absent.exec, { fetchCatalog: absent.fetchCatalog });
	expect(absent.installed).toEqual([]);
	expect(absent.prompts).toEqual([]);
});

test("failed native operations and unverifiable post-update state do not claim success", async () => {
	for (const failure of ["list", "refresh", "upgrade", "post-read"] as const) {
		const f = fixture({ failure });
		let caught: unknown;
		try { await checkPluginUpdates(f.ui, f.exec, { keys: ["agent-skills"], fetchCatalog: f.fetchCatalog }); } catch (error) { caught = error; }
		expect(caught).toBeInstanceOf(Error);
		expect(String(caught)).not.toContain("SECRET_NATIVE_DETAIL");
		expect(f.installed[0]?.version).toBe(failure === "post-read" ? "1.1.0" : "1.0.0");
	}
});

test("bad catalog or network data cannot authorize an upgrade", async () => {
	for (const catalog of [{}, { name: "wrong", plugins: [] }, { name: "tung-agent-skills", plugins: [{ name: "agent-skills", version: "not-semver" }] }]) {
		const f = fixture({ catalog });
		await expect(checkPluginUpdates(f.ui, f.exec, { keys: ["agent-skills"], fetchCatalog: f.fetchCatalog })).rejects.toBeInstanceOf(Error);
		expect(f.installed[0]?.version).toBe("1.0.0");
		expect(f.catalogEpoch()).toBe(0);
	}
	const f = fixture();
	await expect(checkPluginUpdates(f.ui, f.exec, { fetchCatalog: async () => { throw new Error("network unavailable"); } })).rejects.toBeInstanceOf(Error);
	expect(f.catalogEpoch()).toBe(0);
});

test("registry shape errors and duplicate scope entries fail closed", async () => {
	const bad: Exec = async () => ({ code: 0, stdout: JSON.stringify({ npm: [], marketplace: [{ id: SKILLS, entries: [{ scope: "elsewhere", version: "1.0.0" }] }] }), stderr: "" });
	await expect(readPluginInstallations(bad)).rejects.toBeInstanceOf(Error);
	const duplicate = fixture({ installed: [{ id: SKILLS, scope: "user", version: "1.0.0" }, { id: SKILLS, scope: "user", version: "1.0.1" }] });
	await expect(readPluginInstallations(duplicate.exec)).rejects.toBeInstanceOf(Error);
});

test("confirmation-time version drift requires a fresh check rather than reinstalling", async () => {
	const f = fixture();
	f.ui.confirm = async () => {
		const row = f.installed[0];
		if (!row) throw new Error("Fixture target missing");
		row.version = "1.0.1";
		return true;
	};
	await expect(checkPluginUpdates(f.ui, f.exec, { keys: ["agent-skills"], fetchCatalog: f.fetchCatalog })).rejects.toBeInstanceOf(Error);
	expect(f.installed[0]?.version).toBe("1.0.1");
	expect(f.catalogEpoch()).toBe(0);
});

test("a later catalog failure does not hide or roll back an earlier confirmed update", async () => {
	const f = fixture();
	const fetchCatalog: CatalogFetch = async (url, init) => url.includes("omp-starter")
		? new Response("unavailable", { status: 503 })
		: await f.fetchCatalog(url, init);
	await expect(checkPluginUpdates(f.ui, f.exec, { fetchCatalog })).rejects.toBeInstanceOf(Error);
	expect(f.installed.map(row => row.version)).toEqual(["1.1.0", "1.0.0"]);
});

test("HTTP errors and malformed response bodies are not reported as current versions", async () => {
	for (const response of [new Response("unavailable", { status: 503 }), new Response("not JSON")]) {
		const f = fixture();
		await expect(checkPluginUpdates(f.ui, f.exec, { fetchCatalog: async () => response })).rejects.toBeInstanceOf(Error);
		expect(f.installed.map(row => row.version)).toEqual(["1.0.0", "1.0.0"]);
		expect(f.catalogEpoch()).toBe(0);
	}
});
