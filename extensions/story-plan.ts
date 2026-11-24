// `/story` starts in omp's plan mode: the clarify step and the acceptance criteria are read-only, and approving the plan
// (Plan Review) leaves plan mode and starts the build. Interactive TUI main sessions only; elsewhere /story runs as before.
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const STORY = /^\/story(?:\s|$)/;

export default function storyPlan(pi: ExtensionAPI): void {
	pi.on("input", async (event, ctx) => {
		if (ctx.agent?.kind === "sub" || event.source === "extension" || !STORY.test(event.text.trimStart())) return;
		const modes = ctx.sessionModes;
		if (!modes) return;
		const result = await modes.set({ mode: "plan", action: "enter" });
		if (!result.ok) ctx.ui.notify(`story: plan mode not entered (${result.code}: ${result.message}); clarify before editing anyway.`, "warning");
	});
}
