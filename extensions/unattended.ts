// An unattended build is a session the dispatcher starts with OMP_STARTER_UNATTENDED=1: nobody answers it.
// In such a session `ask` is refused; the agent decides and records the choice in the pull request's `## Decision log`,
// or writes stuck.md in the spec folder and stops. In any other session this extension registers nothing.
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const REASON =
	"unattended build: nobody can answer a question in this session. Decide yourself and record the decision, with the alternative you rejected, " +
	"in the pull request's ## Decision log. If the work cannot continue, write why to stuck.md in the spec folder and stop.";

export default function unattended(pi: ExtensionAPI): void {
	if (process.env.OMP_STARTER_UNATTENDED !== "1") return;
	pi.on("tool_call", event => {
		if (event.toolName !== "ask") return;
		return { block: true, reason: REASON };
	});
}
