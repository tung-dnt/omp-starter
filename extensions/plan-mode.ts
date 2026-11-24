// `/story` and `/epic` start in omp's plan mode: clarifying, the acceptance criteria and the decisions are read-only,
// and the plan goes to Plan Review. Approving it leaves plan mode: `/story` then builds, `/epic` writes its plan to
// plans/ and commits it (epic-guard still holds every other write). Interactive TUI main sessions only; elsewhere both
// commands run as before and confirm with `ask`.
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const PLAN_FIRST = /^\/(story|epic)(?:\s|$)/;

export default function planMode(pi: ExtensionAPI): void {
	pi.on("input", async (event, ctx) => {
		if (ctx.agent?.kind === "sub" || event.source === "extension") return;
		const command = PLAN_FIRST.exec(event.text.trimStart())?.[1];
		const modes = ctx.sessionModes;
		if (!command || !modes) return;
		const result = await modes.set({ mode: "plan", action: "enter" });
		if (!result.ok) ctx.ui.notify(`${command}: plan mode not entered (${result.code}: ${result.message}); clarify before editing anyway.`, "warning");
	});
}
