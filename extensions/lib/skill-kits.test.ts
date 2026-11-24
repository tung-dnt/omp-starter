import { expect, test } from "bun:test";
import type { Exec } from "../setup";
import { scriptedUi, type UiScript } from "../test-harness";
import { overlapWarning, setupSkillKits } from "./skill-kits";

const IDS = { pstack: "pstack@pstack-claude", mattpocock: "mattpocock-skills@mattpocock", addy: "agent-skills@addy-agent-skills", ponytail: "ponytail@ponytail" } as const;
type PluginKit = keyof typeof IDS;

/** Stateful fake of the omp and uv CLIs: tracks user-scope plugin installs and the specify-cli uv tool. */
function world(options: { installed?: PluginKit[]; unmanaged?: PluginKit[]; specKit?: boolean; uv?: boolean } = {}) {
	const plugins = new Set<PluginKit>(options.installed ?? []);
	let specKit = options.specKit ?? false;
	const mutations: string[][] = [];
	const exec: Exec = async (command, args) => {
		if (command === "uv") {
			if (options.uv === false) throw new Error("uv: command not found");
			if (args[1] === "list") return { code: 0, stderr: "", stdout: specKit ? "specify-cli v1.4.3\n- specify\n" : "" };
			mutations.push([command, ...args]);
			specKit = args[1] === "install";
			return { code: 0, stdout: "", stderr: "" };
		}
		if (args[0] === "plugin" && args[1] === "list") {
			return { code: 0, stderr: "", stdout: JSON.stringify({
				npm: (options.unmanaged ?? []).map(kit => ({ name: kit === "addy" ? "agent-skills" : kit === "mattpocock" ? "mattpocock-skills" : "pstack", version: "local" })),
				marketplace: [...plugins].map(kit => ({ id: IDS[kit], entries: [{ scope: "user", version: "1.0.0" }] })),
			}) };
		}
		mutations.push([command, ...args]);
		const kit = (Object.keys(IDS) as PluginKit[]).find(key => IDS[key] === args.at(-1));
		if (kit && args[1] === "install") plugins.add(kit);
		if (kit && args[1] === "uninstall") plugins.delete(kit);
		return { code: 0, stdout: "", stderr: "" };
	};
	return { exec, plugins, mutations, specKit: () => specKit };
}

const ui = (script: UiScript) => scriptedUi(script);

test("startup only records an existing kit: no prompt, no network, no change", async () => {
	const w = world({ installed: ["addy"] });
	const originalFetch = globalThis.fetch;
	let network = false;
	globalThis.fetch = Object.assign(async () => { network = true; throw new Error("Unexpected startup network"); }, originalFetch);
	try {
		const u = ui({});
		expect(await setupSkillKits(u, w.exec)).toBe("done");
		expect(u.prompts).toEqual([]);
		expect(network).toBe(false);
		expect(w.mutations).toEqual([]);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("a fresh picker preselects addy and installs exactly the checked kits", async () => {
	const w = world();
	const u = ui({ form: [{ kits: ["addy"] }] });
	expect(await setupSkillKits(u, w.exec)).toBe("done");
	expect(u.prompts[0]?.detail).toContain('value="addy" checked');
	expect([...w.plugins]).toEqual(["addy"]);
});

test("overlapping kits warn first; changing the selection reopens the picker with it, and nothing installs until accepted", async () => {
	const w = world();
	const u = ui({ form: [{ kits: ["pstack", "mattpocock"] }, { kits: ["pstack"] }], select: ["Change selection"] });
	expect(await setupSkillKits(u, w.exec, true)).toBe("done");
	const warning = u.notifications.find(n => n.type === "warning")?.message ?? "";
	expect(warning).toContain("TDD");
	expect(warning).toContain('name clash "tdd"');
	expect(u.prompts[2]?.detail).toContain('value="mattpocock" checked');
	expect([...w.plugins]).toEqual(["pstack"]);
});

test("accepting an overlap installs every kit", async () => {
	const w = world();
	const u = ui({ form: [{ kits: ["pstack", "mattpocock", "addy"] }], select: ["Install anyway"] });
	expect(await setupSkillKits(u, w.exec, true)).toBe("done");
	expect([...w.plugins].sort()).toEqual(["addy", "mattpocock", "pstack"]);
});

test("unchecking an installed kit uninstalls it only after a confirm naming it", async () => {
	const keep = world({ installed: ["pstack"] });
	const declined = ui({ form: [{ kits: [] }], confirm: [false] });
	await setupSkillKits(declined, keep.exec, true);
	expect(declined.prompts.find(p => p.kind === "confirm")?.detail).toContain(IDS.pstack);
	expect([...keep.plugins]).toEqual(["pstack"]);

	const remove = world({ installed: ["pstack"] });
	expect(await setupSkillKits(ui({ form: [{ kits: [] }], confirm: [true] }), remove.exec, true)).toBe("skipped");
	expect([...remove.plugins]).toEqual([]);
});

test("unmanaged copies are neither converted nor uninstalled", async () => {
	const w = world({ unmanaged: ["addy"] });
	const u = ui({ form: [{ kits: [] }] });
	await setupSkillKits(u, w.exec, true);
	expect(w.mutations).toEqual([]);
	expect(u.notifications.some(n => n.message.includes("unmanaged"))).toBe(true);
});

test("spec-kit installs and uninstalls through uv, and without uv it is not attempted", async () => {
	const w = world();
	await setupSkillKits(ui({ form: [{ kits: ["spec-kit"] }] }), w.exec, true);
	expect(w.specKit()).toBe(true);
	await setupSkillKits(ui({ form: [{ kits: [] }], confirm: [true] }), w.exec, true);
	expect(w.specKit()).toBe(false);

	const noUv = world({ uv: false });
	const u = ui({ form: [{ kits: ["spec-kit"] }] });
	await setupSkillKits(u, noUv.exec, true);
	expect(noUv.mutations).toEqual([]);
	expect(u.notifications.some(n => n.type === "warning" && n.message.includes("needs uv"))).toBe(true);
});

test("cancelling the picker changes nothing", async () => {
	const w = world({ installed: ["addy"] });
	expect(await setupSkillKits(ui({ form: [undefined] }), w.exec, true)).toBe("done");
	expect(await setupSkillKits(ui({ form: [undefined] }), world().exec, true)).toBe("skipped");
	expect(w.mutations).toEqual([]);
});

test("a host without forms asks one confirm per kit", async () => {
	const w = world();
	const u = ui({ confirm: [false, false, false, true, false] });
	expect(await setupSkillKits(u, w.exec, true)).toBe("done");
	expect(u.prompts.map(p => p.title)).toEqual(["Skill kit: pstack", "Skill kit: Matt Pocock", "Skill kit: addy (addyosmani/agent-skills)", "Skill kit: ponytail", "Skill kit: spec-kit (GitHub)"]);
	expect([...w.plugins]).toEqual(["ponytail"]);
});

test("overlapWarning: one kit never overlaps; the same job in two kits does", () => {
	expect(overlapWarning(["pstack"])).toBeUndefined();
	expect(overlapWarning([])).toBeUndefined();
	expect(overlapWarning(["addy", "spec-kit"])).toContain("spec / requirements");
	expect(overlapWarning(["pstack", "addy"])).not.toContain("name clash");
	expect(overlapWarning(["addy", "ponytail"])).toContain("ponytail-review");
});
