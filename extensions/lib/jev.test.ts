import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Exec, WizardUi } from "../setup";
import { JEV_MODEL, setupJev } from "./jev";
import { MODELS, setupModels } from "./routing";

const homes: string[] = [];
afterEach(() => {
	for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

/** Real omp against a private HOME; `models` stubs `omp models <provider> --json`. */
function client(answers: { confirm?: boolean; input?: string; select?: string } = {}, models: string[] = []) {
	const home = mkdtempSync(join(tmpdir(), "omp-starter-jev-"));
	homes.push(home);
	const env = { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"), XDG_DATA_HOME: join(home, ".local", "share") };
	const exec: Exec = async (command, args) => {
		if (args[0] === "models") return { code: 0, stderr: "", stdout: JSON.stringify({ models: models.map(selector => ({ selector })) }) };
		const child = Bun.spawn([command, ...args], { cwd: home, env, stdout: "pipe", stderr: "pipe" });
		const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
		return { stdout, stderr, code };
	};
	const config = async (action: "get" | "set", key: string, value?: unknown): Promise<unknown> => {
		const result = await exec("omp", action === "set" ? ["config", "set", key, JSON.stringify(value)] : ["config", "get", key, "--json"]);
		if (result.code !== 0) throw new Error(result.stderr || result.stdout);
		return action === "get" ? JSON.parse(result.stdout).value : undefined;
	};
	const notes: string[] = [];
	const ui: WizardUi = {
		confirm: async () => answers.confirm ?? true,
		notify: message => notes.push(message),
		select: async () => answers.select,
		input: async () => answers.input,
	};
	return { exec, config, ui, notes, envFile: join(home, "agent.env") };
}

const accept = async () => undefined;

test("a rejected key changes nothing: no key file, judge and rules untouched", async () => {
	const { exec, config, ui, envFile } = client({ input: "bad-key" });
	await config("set", "modelRoles", { judge: "anthropic/claude-haiku-5-5" });

	const result = await setupJev(ui, exec, { verify: async () => "TypeSafe rejected the key", envFile, env: {} });

	expect(result).toBe("skipped");
	expect(existsSync(envFile)).toBe(false);
	expect(await config("get", "modelRoles")).toEqual({ judge: "anthropic/claude-haiku-5-5" });
	expect(await config("get", "ttsr.disabledRules")).toEqual([]);
}, 60_000);

test("an accepted key is stored 600 beside other entries and routes every judge to Jev", async () => {
	const { exec, config, ui, envFile } = client({ input: " ts-new " });
	writeFileSync(envFile, "OTHER=1\nTYPESAFE_API_KEY=ts-old\n");
	await config("set", "modelRoles", { default: "anthropic/claude-opus-5-5:auto", judge: "anthropic/claude-haiku-5-5" });
	await config("set", "modelPresets", { claude: { modelRoles: { judge: "anthropic/claude-haiku-5-5", tiny: "x" } }, custom: { modelRoles: { judge: "keep" } } });
	await config("set", "ttsr.disabledRules", ["other-rule"]);
	const env: Record<string, string | undefined> = {};

	expect(await setupJev(ui, exec, { verify: accept, envFile, env })).toBe("done");

	expect(readFileSync(envFile, "utf8")).toBe("OTHER=1\nTYPESAFE_API_KEY=ts-new\n");
	expect(statSync(envFile).mode & 0o777).toBe(0o600);
	expect(env.TYPESAFE_API_KEY).toBe("ts-new");
	expect(await config("get", "modelRoles")).toEqual({ default: "anthropic/claude-opus-5-5:auto", judge: JEV_MODEL });
	expect(await config("get", "modelPresets")).toEqual({ claude: { modelRoles: { judge: JEV_MODEL, tiny: "x" } }, custom: { modelRoles: { judge: "keep" } } });
	expect((await config("get", "ttsr.disabledRules") as string[]).sort()).toEqual(["lsp-symbol-search", "other-rule"]);
	expect((await config("get", "retry.fallbackChains") as Record<string, unknown>).judge).toEqual(["@tiny"]);
}, 60_000);

test("a key already in the environment is verified but never written to disk", async () => {
	const { exec, config, ui, envFile } = client();
	let checked: string | undefined;
	const result = await setupJev(ui, exec, { verify: async key => { checked = key; return undefined; }, envFile, env: { TYPESAFE_API_KEY: "ts-env" } });

	expect(result).toBe("done");
	expect(checked).toBe("ts-env");
	expect(existsSync(envFile)).toBe(false);
	expect((await config("get", "modelRoles") as Record<string, string>).judge).toBe(JEV_MODEL);
}, 60_000);

test("turning Jev off restores the presets' judges and the regex LSP rule", async () => {
	const { exec, config, ui, envFile } = client({ input: "ts-key", select: "Turn Jev off" });
	await setupModels(ui, exec);
	await setupJev(ui, exec, { verify: accept, envFile, env: {} });

	expect(await setupJev(ui, exec, { current: "done", envFile, env: {} })).toBe("skipped");

	const presets = await config("get", "modelPresets") as Record<string, { modelRoles: Record<string, string> }>;
	expect(presets.claude.modelRoles.judge).toBe(MODELS.haiku);
	expect(presets.codex.modelRoles.judge).toBe("openai-codex/gpt-6-luna:low");
	expect((await config("get", "modelRoles") as Record<string, string>).judge).toBe("@tiny");
	expect(await config("get", "ttsr.disabledRules")).toEqual([]);
	expect(readFileSync(envFile, "utf8")).toContain("TYPESAFE_API_KEY=ts-key");
}, 90_000);

test("rerunning the models step with Jev on keeps Jev as the judge in roles and presets", async () => {
	const { exec, config, ui } = client({}, Object.values(MODELS));

	await setupModels(ui, exec, JEV_MODEL);

	expect((await config("get", "modelRoles") as Record<string, string>).judge).toBe(JEV_MODEL);
	const presets = await config("get", "modelPresets") as Record<string, { modelRoles: Record<string, string> }>;
	expect(presets.claude.modelRoles.judge).toBe(JEV_MODEL);
	expect(presets.codex.modelRoles.judge).toBe(JEV_MODEL);
	expect((await config("get", "modelRoles") as Record<string, string>).default).toBe("anthropic/claude-opus-5-5:auto");
}, 60_000);
