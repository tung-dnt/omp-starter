// Blocks a coding subagent's rg/grep symbol lookup before it runs and points it at the language server.
// Active only with the TypeSafe Jev step on (`/starter jev`); every failure (no key, timeout, bad answer) lets the call run.
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { JEV_MODEL } from "./lib/jev";
import { blockReason, decide, type Judge } from "./lib/lsp-guard";
import { readState } from "./lib/state";

const RULE = fileURLToPath(new URL("../rules/lsp-symbol-judged.md", import.meta.url));

/** The judged rule's `question`, so the block and the reminder ask Jev the same thing. */
function ruleQuestion(): string | undefined {
	const line = /^question: (".*")$/m.exec(fs.readFileSync(RULE, "utf8"))?.[1];
	const parsed: unknown = line ? JSON.parse(line) : undefined;
	return typeof parsed === "string" ? parsed : undefined;
}

function jevJudge(key: string, question: string): Judge {
	return async command => {
		try {
			const res = await fetch("https://api.typesafe.ai/v1/systemone", {
				method: "POST",
				headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
				body: JSON.stringify({
					model: JEV_MODEL.split("/")[1],
					// Same state shape as the TTSR judge: the tool output's arguments.
					state: { output: "tool", content: JSON.stringify({ command }) },
					questions: { q: { type: "noul", instructions: question } },
				}),
				signal: AbortSignal.timeout(4_000),
			});
			if (!res.ok) return undefined;
			const body: unknown = await res.json();
			const answers = body && typeof body === "object" && "answers" in body ? body.answers : undefined;
			const q = answers && typeof answers === "object" && "q" in answers ? answers.q : undefined;
			return q && typeof q === "object" && "noul" in q && typeof q.noul === "number" ? q.noul : undefined;
		} catch {
			return undefined;
		}
	};
}

export default function lspGuard(pi: ExtensionAPI): void {
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash" || ctx.agent?.kind !== "sub") return;
		const key = process.env.TYPESAFE_API_KEY?.trim();
		if (!key || readState().jev !== "done") return;
		const question = ruleQuestion();
		if (!question) return;
		const agent = ctx.agent.name;
		const verdict = await decide(String(event.input.command ?? ""), agent, jevJudge(key, question));
		if (verdict.block && verdict.p !== undefined && agent) return { block: true, reason: blockReason(agent, verdict.p) };
	});
}
