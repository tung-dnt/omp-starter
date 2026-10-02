// Port of agent-skills' Claude SessionStart hook: runs `work-state.sh hint` and injects its
// additionalContext (claimed-task /resume hint) on the first turn.
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { HOME } from "./lib/state";

const SCRIPT = path.join(HOME, ".omp/plugins/node_modules/agent-skills/hooks/work-state.sh");

export default function agentSkillsHint(pi: ExtensionAPI): void {
	let pending: Promise<string | undefined> | undefined;

	pi.on("session_start", (_event, ctx) => {
		if (ctx.agent?.kind === "sub" || !fs.existsSync(SCRIPT)) return;
		pending = (async () => {
			const result = await pi.exec("bash", [SCRIPT, "hint"], { cwd: ctx.cwd, timeout: 10_000 });
			const out = result.stdout?.trim();
			if (result.code !== 0 || !out) return undefined;
			return JSON.parse(out).hookSpecificOutput?.additionalContext as string | undefined;
		})().catch(() => undefined);
	});

	pi.on("before_agent_start", async () => {
		if (!pending) return;
		const hint = await pending;
		pending = undefined;
		if (!hint) return;
		return { message: { customType: "agent-skills-work-state", content: hint, display: true } };
	});
}
