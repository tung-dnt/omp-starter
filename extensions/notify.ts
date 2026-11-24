// macOS desktop notifications for the main interactive session: a long turn finished, `ask` is waiting, or a tool needs approval.
// Registers nothing off darwin, in unattended sessions, or when state.notify.off is set; at most one notification per 5 seconds.
import * as path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { readState } from "./lib/state";

const DEFAULT_MIN_SECONDS = 20;
const RATE_LIMIT_MS = 5000;

export interface NotifyOptions {
	platform?: string;
	now?: () => number;
}

interface SessionContext {
	cwd: string;
	hasUI: boolean;
	agent?: { kind: string };
}

function applescriptString(text: string): string {
	return text.replace(/[\r\n]+/g, " ").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function formatDuration(seconds: number): string {
	const whole = Math.floor(seconds);
	const minutes = Math.floor(whole / 60);
	return minutes > 0 ? `${minutes}m ${whole % 60}s` : `${whole}s`;
}

export function createNotify(options: NotifyOptions = {}): (pi: ExtensionAPI) => void {
	const platform = options.platform ?? process.platform;
	const now = options.now ?? Date.now;
	return pi => {
		if (platform !== "darwin" || process.env.OMP_STARTER_UNATTENDED === "1") return;
		const settings = readState().notify;
		if (settings?.off) return;
		const minSeconds = settings?.minSeconds ?? DEFAULT_MIN_SECONDS;
		let startedAt: number | undefined;
		let lastSentAt = Number.NEGATIVE_INFINITY;

		const interactive = (ctx: SessionContext): boolean => ctx.agent?.kind !== "sub" && ctx.hasUI;

		function send(message: string, ctx: SessionContext): void {
			const at = now();
			if (at - lastSentAt < RATE_LIMIT_MS) return;
			lastSentAt = at;
			const script = `display notification "${applescriptString(message)}" with title "omp" subtitle "${applescriptString(path.basename(ctx.cwd))}" sound name "Glass"`;
			pi.exec("osascript", ["-e", script], { timeout: 3000 }).catch((error: unknown) => {
				pi.logger.warn(`notify: osascript failed: ${error instanceof Error ? error.message : String(error)}`);
			});
		}

		pi.on("agent_start", (_event, ctx) => {
			if (interactive(ctx)) startedAt = now();
		});
		pi.on("agent_end", (_event, ctx) => {
			if (!interactive(ctx) || startedAt === undefined) return;
			const seconds = (now() - startedAt) / 1000;
			startedAt = undefined;
			if (seconds >= minSeconds) send(`Done in ${formatDuration(seconds)}`, ctx);
		});
		pi.on("tool_call", (event, ctx) => {
			if (event.toolName === "ask" && interactive(ctx)) send("Waiting for your answer", ctx);
			return undefined;
		});
		pi.on("tool_approval_requested", (event, ctx) => {
			if (interactive(ctx)) send(`Approval needed: ${event.toolName}`, ctx);
		});
	};
}

export default createNotify();
