// Timed prompts for one session: /every (and the schedule_prompt tools) queue a prompt to be sent again every N minutes or once after a delay.
// omp's built-in /loop only repeats after each turn, so this closes the gap with Claude Code's session crons. Jobs live in memory only:
// they are cleared on session start/switch, expire after 7 days, and end with the process.
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

const TICK_MS = 15_000;
const MIN_INTERVAL_MS = 60_000;
const LIFETIME_MS = 7 * 24 * 60 * 60_000;
const MAX_JOBS = 20;
const UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
const USAGE = [
	"Usage:",
	"/every <duration> <prompt>     repeat the prompt (minimum 60s), e.g. /every 10m check CI",
	"/every in <duration> <prompt>  send the prompt once, e.g. /every in 2h remind me to push",
	"/every list                    show scheduled prompts",
	"/every stop <id>|all           cancel one or all",
	"Durations: 30s, 10m, 2h, 1d or combinations like 1h30m. Jobs are session-scoped and expire after 7 days.",
].join("\n");
const LIFETIME_NOTE = "Scheduled prompts are session-scoped: they live in memory, are cleared when the session changes, and end with the process.";

export interface Job {
	id: string;
	prompt: string;
	kind: "every" | "once";
	intervalMs?: number;
	dueAt: number;
	createdAt: number;
	expiresAt: number;
	runs: number;
}

export interface EveryOptions {
	/** Clock in epoch milliseconds; tests inject their own. */
	now?: () => number;
}

type Scheduled = { job: Job } | { error: string };

/** Milliseconds for `30s`, `10m`, `2h`, `1d` or a combination like `1h30m`; otherwise an error message. */
export function parseDuration(text: string): { ms: number } | { error: string } {
	const value = text.trim().toLowerCase();
	if (!/^(?:\d+[smhd])+$/.test(value)) return { error: `Invalid duration "${text}": use 30s, 10m, 2h, 1d or a combination like 1h30m.` };
	let ms = 0;
	for (const [, amount, unit] of value.matchAll(/(\d+)([smhd])/g)) ms += Number(amount) * UNIT_MS[unit];
	if (ms <= 0) return { error: `Invalid duration "${text}": it must be longer than zero.` };
	return { ms };
}

export function formatDuration(ms: number): string {
	let rest = Math.max(0, Math.round(ms / 1000));
	let out = "";
	for (const [unit, size] of [["d", 86_400], ["h", 3600], ["m", 60], ["s", 1]] as const) {
		if (rest >= size) {
			out += `${Math.floor(rest / size)}${unit}`;
			rest %= size;
		}
	}
	return out || "0s";
}

function splitFirst(text: string): [string, string] {
	const match = /^(\S+)\s*([\s\S]*)$/.exec(text.trim());
	return match ? [match[1], match[2].trim()] : ["", ""];
}

export function createEvery({ now = Date.now }: EveryOptions = {}): (pi: ExtensionAPI) => void {
	return function every(pi: ExtensionAPI): void {
		const jobs = new Map<string, Job>();
		const inFlight = new Set<string>();
		let nextId = 1;
		/** The timer and the context that created it; the context is what clears it and answers isIdle()/notify. */
		let owner: { ctx: ExtensionContext; timer: Timer } | undefined;

		function release(): void {
			if (jobs.size > 0 || !owner) return;
			owner.ctx.clearTimer(owner.timer);
			owner = undefined;
		}

		function clearAll(): void {
			jobs.clear();
			inFlight.clear();
			release();
		}

		async function deliver(job: Job, text: string, idle: boolean, ctx: ExtensionContext): Promise<void> {
			try {
				await (idle ? pi.sendUserMessage(text) : pi.sendUserMessage(text, { deliverAs: "followUp" }));
				job.runs++;
				if (job.kind === "once" && jobs.get(job.id) === job) {
					jobs.delete(job.id);
					release();
				}
			} catch (error) {
				ctx.ui.notify(`Scheduled prompt ${job.id} was not delivered (${error instanceof Error ? error.message : String(error)}); it stays scheduled.`, "warning");
			} finally {
				inFlight.delete(job.id);
			}
		}

		function tick(): void {
			if (!owner) return;
			const { ctx } = owner;
			const t = now();
			for (const job of [...jobs.values()]) {
				if (t >= job.expiresAt) {
					jobs.delete(job.id);
					ctx.ui.notify(`Scheduled prompt ${job.id} expired after 7 days and was removed.`, "info");
					continue;
				}
				if (t < job.dueAt || inFlight.has(job.id)) continue;
				// A missed tick never catches up: the next run is one full interval from now.
				if (job.kind === "every" && job.intervalMs !== undefined) job.dueAt = t + job.intervalMs;
				else inFlight.add(job.id);
				void deliver(job, `[scheduled ${job.id}] ${job.prompt}`, ctx.isIdle(), ctx);
			}
			release();
		}

		function schedule(prompt: string, kind: Job["kind"], duration: string, ctx: ExtensionContext): Scheduled {
			const text = prompt.trim();
			if (!text) return { error: "A prompt is required." };
			const parsed = parseDuration(duration);
			if ("error" in parsed) return parsed;
			if (kind === "every" && parsed.ms < MIN_INTERVAL_MS) return { error: `Interval ${formatDuration(parsed.ms)} is too short: the minimum is 60s.` };
			if (parsed.ms > LIFETIME_MS) return { error: `${formatDuration(parsed.ms)} is longer than the 7-day lifetime of a scheduled prompt.` };
			if (jobs.size >= MAX_JOBS) return { error: `At most ${MAX_JOBS} scheduled prompts at once; stop one first.` };
			const createdAt = now();
			const job: Job = {
				id: `j${nextId++}`,
				prompt: text,
				kind,
				...(kind === "every" ? { intervalMs: parsed.ms } : {}),
				dueAt: createdAt + parsed.ms,
				createdAt,
				expiresAt: createdAt + LIFETIME_MS,
				runs: 0,
			};
			jobs.set(job.id, job);
			owner ??= { ctx, timer: ctx.setInterval(tick, TICK_MS) };
			return { job };
		}

		function stop(target: string): string {
			if (target === "all") {
				const count = jobs.size;
				clearAll();
				return count ? `Stopped ${count} scheduled prompt${count === 1 ? "" : "s"}.` : "No scheduled prompts.";
			}
			if (!jobs.delete(target)) return `No scheduled prompt ${target}.`;
			inFlight.delete(target);
			release();
			return `Stopped scheduled prompt ${target}.`;
		}

		function describe(job: Job): string {
			const cadence = job.kind === "every" ? `every ${formatDuration(job.intervalMs ?? 0)}` : "once";
			const prompt = job.prompt.length > 80 ? `${job.prompt.slice(0, 77)}...` : job.prompt;
			return `${job.id}  ${cadence}, next in ${formatDuration(job.dueAt - now())}, ${job.runs} run${job.runs === 1 ? "" : "s"}: ${prompt}`;
		}

		function list(): string {
			return jobs.size ? [...jobs.values()].map(describe).join("\n") : "No scheduled prompts.";
		}

		function confirmation(job: Job): string {
			const when = job.kind === "every" ? `every ${formatDuration(job.intervalMs ?? 0)}` : `once in ${formatDuration(job.dueAt - job.createdAt)}`;
			return `Scheduled ${job.id}: ${when}, expires in 7 days.`;
		}

		pi.on("session_start", () => clearAll());
		pi.on("session_switch", () => clearAll());

		pi.registerCommand("every", {
			description: "Timed prompts: /every <duration> <prompt> | in <duration> <prompt> | list | stop <id>|all",
			handler: async (args, ctx) => {
				const [head, afterHead] = splitFirst(args);
				if (!head) return ctx.ui.notify(USAGE, "info");
				if (head === "list") return ctx.ui.notify(list(), "info");
				if (head === "stop") {
					if (!afterHead) return ctx.ui.notify(USAGE, "warning");
					return ctx.ui.notify(stop(afterHead), "info");
				}
				const once = head === "in";
				const [duration, prompt] = once ? splitFirst(afterHead) : [head, afterHead];
				if (!duration || !prompt) return ctx.ui.notify(USAGE, "warning");
				const result = schedule(prompt, once ? "once" : "every", duration, ctx);
				if ("error" in result) return ctx.ui.notify(result.error, "error");
				ctx.ui.notify(confirmation(result.job), "info");
			},
		});

		const { Type } = pi.typebox;
		const text = (message: string) => ({ content: [{ type: "text" as const, text: message }], details: undefined });
		/** Why this session may not schedule prompts, or undefined. Subagents and unattended sessions have nobody to prompt later. */
		function refusal(ctx: ExtensionContext): string | undefined {
			if (ctx.agent?.kind === "sub") return "Scheduling prompts is only available in the main session, not in a subagent.";
			if (process.env.OMP_STARTER_UNATTENDED === "1") return "Scheduling prompts is not available in an unattended session: nobody can receive them.";
			return undefined;
		}

		pi.registerTool({
			name: "schedule_prompt",
			label: "Schedule prompt",
			description:
				"Schedule a prompt to be sent back to this session later. Pass exactly one of `every` (repeat at that interval, minimum 60s) or `in` (send once after that delay). " +
				"Durations look like 30s, 10m, 2h, 1d or 1h30m. At most 20 jobs; each expires after 7 days. " +
				LIFETIME_NOTE,
			parameters: Type.Object({
				prompt: Type.String({ description: "The prompt to send when the job is due." }),
				every: Type.Optional(Type.String({ description: "Repeat interval, e.g. 10m. Minimum 60s." })),
				in: Type.Optional(Type.String({ description: "One-shot delay, e.g. 2h." })),
			}),
			approval: "write",
			async execute(_id, params, _signal, _onUpdate, ctx) {
				const refused = refusal(ctx);
				if (refused) return text(refused);
				if ((params.every === undefined) === (params.in === undefined)) return text("Not scheduled: pass exactly one of `every` or `in`.");
				const result = params.every !== undefined ? schedule(params.prompt, "every", params.every, ctx) : schedule(params.prompt, "once", params.in ?? "", ctx);
				if ("error" in result) return text(`Not scheduled: ${result.error}`);
				return text(confirmation(result.job));
			},
		});

		pi.registerTool({
			name: "list_scheduled_prompts",
			label: "List scheduled prompts",
			description: `List this session's scheduled prompts with their ids, cadence and next run. ${LIFETIME_NOTE}`,
			parameters: Type.Object({}),
			approval: "read",
			async execute(_id, _params, _signal, _onUpdate, ctx) {
				return text(refusal(ctx) ?? list());
			},
		});

		pi.registerTool({
			name: "cancel_scheduled_prompt",
			label: "Cancel scheduled prompt",
			description: `Cancel one scheduled prompt by id (for example j1) as shown by list_scheduled_prompts. ${LIFETIME_NOTE}`,
			parameters: Type.Object({ id: Type.String({ description: "Job id, e.g. j1." }) }),
			approval: "write",
			async execute(_id, params, _signal, _onUpdate, ctx) {
				return text(refusal(ctx) ?? stop(params.id.trim()));
			},
		});
	};
}

export default createEvery();
