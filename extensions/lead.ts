// The lead-driven workflow's model-facing side: the `lead` tool, through which the agent reaches the lead (the user).
// No tool argument approves anything; every decision is a dialog only the user can answer, and only the main
// session can open one (subagents have no UI). Off with OMP_STARTER_LEAD=off.
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { leadDirFor } from "./lib/lead/artifacts";
import { gateTitle, recordGate } from "./lib/lead/gates";
import { lead, resetLead } from "./lib/lead/registry";

interface LeadParams {
	op: "approve" | "gate" | "status" | "retro";
	story?: string;
	summary?: string;
	artifact?: string;
}

/** Puts every gate a subagent was blocked on to the lead; undecided ones stay queued. */
async function decideGates(ctx: ExtensionContext): Promise<string> {
	const pending = lead().pending;
	if (pending.size === 0) return "no pending gates";
	if (!ctx.hasUI) throw new Error("lead: gate decisions need an interactive session");
	const lines: string[] = [];
	for (const gate of [...pending.values()]) {
		const answer = await ctx.ui.select(gateTitle(gate, `, blocked ${gate.agent}`), ["Approve", "Reject", "Decide later"]);
		const decision = answer === "Approve" ? "approved" : answer === "Reject" ? "rejected" : undefined;
		if (decision) {
			await recordGate(gate.key, decision, gate.gateId, gate.category);
			pending.delete(gate.key);
		}
		lines.push(`${gate.gateId} ${gate.repoName}/${gate.rel}: ${decision ?? "pending"}`);
	}
	return lines.join("\n");
}

export default function leadExtension(pi: ExtensionAPI): void {
	if (process.env.OMP_STARTER_LEAD === "off") return;
	const z = pi.zod;

	pi.on("session_start", (_event, ctx) => {
		if (ctx.agent?.kind !== "sub") resetLead(ctx.sessionManager.getSessionId());
	});

	pi.registerTool({
		name: "lead",
		label: "Lead",
		description:
			"Lead-driven workflow actions that need the lead (the user). approve: show the active story's plan summary to the lead " +
			"for the single plan approval. gate: let the lead decide pending hard gates. status: compute the story's status from " +
			"GitHub and write status.md. retro: record an escaped bug in retro-log.md; the lead picks the cause. " +
			"No argument approves anything: every decision is a dialog only the user can answer.",
		parameters: z.object({
			op: z.enum(["approve", "gate", "status", "retro"]),
			story: z.string().optional().describe("retro: story id or PR"),
			summary: z.string().optional().describe("retro: what escaped, one line"),
			artifact: z.string().optional().describe("retro: root artifact that was fixed, a path"),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (ctx.agent?.kind === "sub") throw new Error("lead: only the main session can call this tool");
			if (!leadDirFor(ctx.cwd)) throw new Error("lead: no knowledge base serves this folder; run /starter kb, then /starter lead");
			const p = params as LeadParams;
			if (p.op !== "gate") throw new Error(`lead: op ${p.op} is not available`);
			return { content: [{ type: "text", text: await decideGates(ctx) }] };
		},
	});
}
