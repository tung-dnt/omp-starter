import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Exec, WizardUi } from "../setup";
import { MODELS, setupModels } from "./routing";

const homes: string[] = [];
afterEach(() => {
	for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function client(claudeModels?: string[], confirmed = true) {
	const home = mkdtempSync(join(tmpdir(), "omp-starter-routing-"));
	homes.push(home);
	const env = {
		PATH: process.env.PATH,
		HOME: home,
		XDG_CONFIG_HOME: join(home, ".config"),
		XDG_CACHE_HOME: join(home, ".cache"),
		XDG_DATA_HOME: join(home, ".local", "share"),
	};
	const exec: Exec = async (command, args) => {
		if (claudeModels && args[0] === "models") {
			return { code: 0, stderr: "", stdout: JSON.stringify({ models: claudeModels.map(selector => ({ selector })) }) };
		}
		const child = Bun.spawn([command, ...args], { cwd: home, env, stdout: "pipe", stderr: "pipe" });
		const [stdout, stderr, code] = await Promise.all([
			new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
		]);
		return { stdout, stderr, code };
	};
	const config = async (action: "get" | "set", key: string, value?: unknown): Promise<unknown> => {
		const args = ["config", action, key];
		if (action === "set") args.push(JSON.stringify(value));
		const result = await exec("omp", args);
		if (result.code !== 0) throw new Error(result.stderr || result.stdout);
		if (action !== "get") return undefined;
		return key === "defaultThinkingLevel" ? result.stdout.trim() : JSON.parse(result.stdout);
	};
	const ui: WizardUi = {
		confirm: async () => confirmed,
		notify: () => {},
		select: async () => undefined,
		input: async () => undefined,
	};
	return { exec, config, ui };
}

test("an unauthenticated client saves both presets without changing active routing", async () => {
	const { exec, config, ui } = client();
	await config("set", "modelRoles", { default: "openai-codex/gpt-6.1-sol", custom: "@default" });
	await config("set", "defaultThinkingLevel", "high");
	const before = await config("get", "modelRoles");

	expect(await setupModels(ui, exec)).toBe("done");
	const presets = await config("get", "modelPresets") as Record<string, { modelRoles: { default: string } }>;
	expect(presets.codex.modelRoles.default).toBe("openai-codex/gpt-6.1-sol");
	expect(presets.claude.modelRoles.default).toBe("anthropic/claude-opus-5-5:auto");
	expect(await config("get", "modelRoles")).toEqual(before);
	expect(await config("get", "defaultThinkingLevel")).toBe("high");
}, 60_000);

test("saving presets replaces matching names and preserves unrelated presets", async () => {
	const { exec, config, ui } = client([]);
	const custom = { modelRoles: { default: "openai-codex/gpt-6.1-sol" }, defaultThinkingLevel: "low" };
	await config("set", "modelPresets", { custom, codex: custom });

	await setupModels(ui, exec);
	const presets = await config("get", "modelPresets") as Record<string, { defaultThinkingLevel: string }>;
	expect(presets.custom).toEqual(custom);
	expect(presets.codex.defaultThinkingLevel).toBe("auto");
}, 60_000);

test("available Claude models still activate Claude routing without deleting custom roles", async () => {
	const { exec, config, ui } = client(Object.values(MODELS));
	await config("set", "modelRoles", { default: "openai-codex/gpt-6.1-sol", custom: "@default" });

	expect(await setupModels(ui, exec)).toBe("done");
	expect(await config("get", "modelRoles")).toMatchObject({
		default: "anthropic/claude-opus-5-5:auto", custom: "@default", deep: "anthropic/claude-fable-5-1:high",
	});
	const presets = await config("get", "modelPresets") as Record<string, unknown>;
	expect(Object.keys(presets).sort()).toEqual(["claude", "codex"]);
}, 60_000);

test("cancelling setup leaves saved presets and routing untouched", async () => {
	const { exec, config, ui } = client(Object.values(MODELS), false);
	const custom = { modelRoles: { default: "openai-codex/gpt-6.1-sol" }, defaultThinkingLevel: "low" };
	await config("set", "modelPresets", { custom });
	await config("set", "modelRoles", custom.modelRoles);

	expect(await setupModels(ui, exec)).toBe("skipped");
	expect(await config("get", "modelPresets")).toEqual({ custom });
	expect(await config("get", "modelRoles")).toEqual(custom.modelRoles);
}, 60_000);
