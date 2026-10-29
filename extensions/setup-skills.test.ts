import { expect, test } from "bun:test";
import { type Exec, type WizardUi, setupAgentSkills } from "./setup";

const ID = "agent-skills@tung-agent-skills";

/** Fake `omp plugin …`: `versions` are what successive `plugin list` calls report; every call is recorded. */
function client(versions: string[], confirmed: boolean, failUpgrade = false) {
	const calls: string[] = [];
	const notes: string[] = [];
	const exec: Exec = async (_command, args) => {
		calls.push(args.join(" "));
		if (args[1] === "list") return { code: 0, stderr: "", stdout: `Plugins:\n  ${ID} (${versions.shift()}) (user)\n` };
		if (args[1] === "upgrade" && failUpgrade) return { code: 1, stderr: "network down", stdout: "" };
		return { code: 0, stderr: "", stdout: "" };
	};
	const ui: WizardUi = {
		confirm: async () => confirmed,
		notify: message => notes.push(message),
		select: async () => undefined,
		input: async () => undefined,
	};
	return { exec, ui, calls, notes };
}

test("the startup wizard never offers an upgrade for an installed agent-skills", async () => {
	const { exec, ui, calls } = client(["0.6.24"], true);
	expect(await setupAgentSkills(ui, exec)).toBe("done");
	expect(calls).toEqual(["plugin list"]);
});

test("/starter upgrades an installed agent-skills after confirmation and reports both versions", async () => {
	const { exec, ui, calls, notes } = client(["0.6.24", "0.6.25"], true);
	expect(await setupAgentSkills(ui, exec, true)).toBe("done");
	expect(calls).toEqual(["plugin list", "plugin marketplace update", `plugin upgrade ${ID}`, "plugin list"]);
	expect(notes).toEqual(["agent-skills 0.6.24 → 0.6.25. Run /reload-plugins to load it."]);
});

test("declining the upgrade changes nothing, and a failed upgrade is an error, not a success", async () => {
	const declined = client(["0.6.24"], false);
	expect(await setupAgentSkills(declined.ui, declined.exec, true)).toBe("done");
	expect(declined.calls).toEqual(["plugin list"]);

	const failing = client(["0.6.24"], true, true);
	await expect(setupAgentSkills(failing.ui, failing.exec, true)).rejects.toThrow("plugin upgrade failed: network down");
});
