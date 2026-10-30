import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

test("session startup and KB setup leave the agent-skills config untouched", () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "omp-starter-native-cutover-"));
	const sentinel = JSON.stringify({ vault: "/must/not/change", unrelated: "preserve" }, null, 2) + "\n";
	const config = path.join(home, ".config", "agent-skills", "config.json");
	fs.mkdirSync(path.dirname(config), { recursive: true });
	fs.writeFileSync(config, sentinel);
	// Load modules only after HOME is set so every module uses the disposable test config.
	const script = `
		const { writeState } = await import("./extensions/lib/state.ts");
		const { memoryDir } = await import("./extensions/lib/kb-store.ts");
		const { default: kbCommitGate } = await import("./extensions/kb-commit-gate.ts");
		const { default: ompStarter } = await import("./extensions/setup.ts");
		writeState({
			agentSkills: "done",
			models: "done",
			jev: "done",
			kb: { status: "done", sources: [
				{ kbRef: "~/work-kb", kbPaths: ["/vaults/work-kb"], contextFile: "/work/AGENTS.md", gateDir: "/work", primary: true },
				{ kbRef: "~/personal-kb", kbPaths: ["/vaults/personal-kb"], contextFile: "/personal/AGENTS.md", gateDir: "/personal", primary: false },
			] },
		});
		const listeners = new Map();
		let command;
		const pi = {
			on(event, handler) { listeners.set(event, handler); },
			registerCommand(_name, definition) { command = definition.handler; },
			exec: async () => ({ stdout: "", stderr: "", code: 0 }),
		};
		ompStarter(pi);
		const ui = {
			notify() {},
			confirm: async () => false,
			select: async () => "Done",
			input: async () => undefined,
		};
		const ctx = { mode: "tui", hasUI: true, cwd: "/work/repo", ui };
		listeners.get("session_start")({}, ctx);
		await command("kb", ctx);
		const memory = memoryDir("/work/repo");
		if (memory.source.kbRef !== "~/work-kb" || memory.dir !== process.env.HOME + "/work-kb/_memory") throw new Error("memory routing lost its KB source");
		const gateHooks = new Map();
		kbCommitGate({ on(event, handler) { gateHooks.set(event, handler); } });
		const commit = () => gateHooks.get("tool_call")({ toolName: "bash", input: { command: "git commit -m test" } }, { cwd: "/work/repo" });
		const gate = commit();
		if (!gate?.block || !gate.reason.includes("~/work-kb")) throw new Error("commit gate lost its KB source");
		gateHooks.get("tool_result")({ toolName: "write", isError: false, input: { path: "/vaults/work-kb/fact.md" } }, { cwd: "/work/repo" });
		if (commit()?.block) throw new Error("commit gate lost KB write tracking");
	`;
	try {
		const result = Bun.spawnSync(["bun", "-e", script], {
			cwd: process.cwd(),
			env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config") },
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(result.exitCode).toBe(0);
		expect(new TextDecoder().decode(result.stderr)).toBe("");
		expect(fs.readFileSync(config, "utf8")).toBe(sentinel);
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
});
