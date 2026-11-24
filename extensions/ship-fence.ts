// The /ship fence in every omp session: on load it names this process's fence state file and puts bin/ship-fence first
// on PATH (both before omp captures the environment its shells start from), so /ship can arm and disarm the fence later
// by rewriting the file. While armed, tool calls go through extensions/ship/fence-tools.ts. Unarmed, it costs one file
// read per tool call and a shell test per gh or git call.
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { currentState, installFence } from "./ship/fence-state";
import { checkToolCall } from "./ship/fence-tools";

export default function shipFence(pi: ExtensionAPI): void {
	installFence();
	pi.on("tool_call", (event, ctx) => {
		const state = currentState();
		if (!state.armed) return;
		const reason = checkToolCall(event.toolName, (event.input ?? {}) as Record<string, unknown>, state, ctx.cwd);
		return reason === null ? undefined : { block: true, reason };
	});
}
