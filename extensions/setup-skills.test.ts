import { expect, test } from "bun:test";
import { type Exec, type WizardUi, setupAgentSkills } from "./setup";

const ID = "agent-skills@tung-agent-skills";

function installationFixture(kind: "marketplace" | "unmanaged" | "absent", confirm: boolean) {
	let installed = kind === "marketplace";
	let authorized = false;
	let mutations = 0;
	const ui: WizardUi = {
		confirm: async () => { authorized = confirm; return confirm; },
		notify() {},
		select: async () => undefined,
		input: async () => undefined,
	};
	const exec: Exec = async (_command, args) => {
		if (args[1] === "list") return { code: 0, stderr: "", stdout: JSON.stringify({
			npm: kind === "unmanaged" ? [{ name: "agent-skills", version: "local" }] : [],
			marketplace: installed ? [{ id: ID, entries: [{ scope: "user", version: "1.0.0" }] }] : [],
		}) };
		if (!authorized) throw new Error("Installation attempted without user authorization");
		mutations += 1;
		if (args[1] === "install") installed = true;
		return { code: 0, stdout: "", stderr: "" };
	};
	return { ui, exec, installed: () => installed, mutations: () => mutations };
}

test("startup presence detection does not fetch versions or mutate installed skills", async () => {
	const f = installationFixture("marketplace", true);
	const originalFetch = globalThis.fetch;
	let network = false;
	globalThis.fetch = Object.assign(async () => { network = true; throw new Error("Unexpected startup network"); }, originalFetch);
	try {
		expect(await setupAgentSkills(f.ui, f.exec)).toBe("done");
		expect(network).toBe(false);
		expect(f.installed()).toBe(true);
		expect(f.mutations()).toBe(0);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("unmanaged skills are not converted to a marketplace installation", async () => {
	const f = installationFixture("unmanaged", true);
	expect(await setupAgentSkills(f.ui, f.exec, true)).toBe("done");
	expect(f.installed()).toBe(false);
	expect(f.mutations()).toBe(0);
});

test("missing skills install only after consent and are verified as installed", async () => {
	const decline = installationFixture("absent", false);
	expect(await setupAgentSkills(decline.ui, decline.exec)).toBe("skipped");
	expect(decline.installed()).toBe(false);
	expect(decline.mutations()).toBe(0);
	const accept = installationFixture("absent", true);
	expect(await setupAgentSkills(accept.ui, accept.exec)).toBe("done");
	expect(accept.installed()).toBe(true);
});
