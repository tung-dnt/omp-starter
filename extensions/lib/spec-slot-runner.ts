// The real `SlotRunner`: one SDK session per slot run (`pi.pi.createAgentSession`), built by the spike's rules:
//  - restricted tools and a required `yield`, the verdict schema as `outputSchema`, an explicit thinking level (so no Jev classifier call),
//    no MCP, no UI, no process-global state;
//  - the worker guard goes in `preloadedPreparedExtensions`, because a restricted session ignores the `extensions` option;
//  - the model comes from the slot's role, the instructions from the agent definitions the run read once at its start from a fixed folder
//    (`SlotRunnerOptions.agents`), never from the worktree: a slot can write files there, and the nearest project `.omp/agents` outranks all others;
//  - cost and context come from each assistant `message_end`, the payload from the last successful `yield`, and the runner waits
//    for a terminal `agent_end`, then disposes the session.
// The SDK is reached through `SlotSdk`, so the tests drive the runner with a fake one.
import type { AgentSession, AgentSessionEvent, CreateAgentSessionOptions, ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { type ModelRole, SLOTS, type SlotResult, type SlotRunner, type SlotSpec, slotTitle } from "./spec-slots";
import { isTestPath } from "./spec-testfiles";
import { isRecord } from "./tooling/runtime";
import { workerGuard } from "./worker-guard";

/** What the runner sees of a session. */
export type SlotEvent =
	/** One assistant message finished: its cost and the context its request carried. */
	| { type: "usage"; costUsd: number; contextTokens: number }
	/** The worker's last successful `yield`: the data it gave. */
	| { type: "yield"; payload: unknown }
	/** The worker yielded an error instead of data. */
	| { type: "yield-error"; message: string }
	/** The agent finished for good (`agent_end` that is not a scheduling pause). */
	| { type: "end" };

export interface SlotSession {
	readonly sessionFile: string | undefined;
	subscribe(listener: (event: SlotEvent) => void): () => void;
	prompt(text: string): Promise<void>;
	abort(): Promise<void>;
	dispose(): Promise<void>;
	setTitle(title: string): Promise<void>;
}

export interface SlotAgent {
	name: string;
	/** The definition's body: what the slot receives as `appendSystemPrompt`. */
	systemPrompt: string;
}

export interface SlotSdk {
	createAgentSession(options: CreateAgentSessionOptions): Promise<SlotSession>;
	discoverAgents(cwd: string): Promise<readonly SlotAgent[]>;
}

export type SlotModel = NonNullable<CreateAgentSessionOptions["model"]>;

export interface SlotRunnerOptions {
	sdk: SlotSdk;
	/** The agent definitions, read once at the start of the run (`sdk.discoverAgents` on a trusted folder). */
	agents: readonly SlotAgent[];
	/** `ctx.models.resolve("@<role>")`: the model a role resolves to, or undefined. */
	resolveModel(role: ModelRole): SlotModel | undefined;
}

/** The worker guard is a prepared extension with no file behind it, so its path is a label. */
const GUARD_LABEL = "omp-starter:worker-guard";

const stopped = (): SlotResult => ({ payload: undefined, costUsd: 0, contextTokens: 0, aborted: "signal" });

/**
 * The registry id of one slot run. Without it the SDK registers the session as "Main", so a slot replaces the host session's registration
 * and parallel slots replace each other ("Main was replaced during session initialization"). `run` is the runner's own counter, so two runs
 * never share an id even for the same task and slot; the SDK unregisters the id when the session is disposed.
 */
export const slotAgentId = (spec: SlotSpec, run: number): string => `spec-${[spec.story, spec.task.id, spec.slot].map(part => part.replace(/[^A-Za-z0-9._-]/g, "_")).join("-")}-${run}`;

async function runSlot(options: SlotRunnerOptions, spec: SlotSpec, signal: AbortSignal, run: number): Promise<SlotResult> {
	if (signal.aborted) return stopped();
	const model = options.resolveModel(spec.modelRole);
	if (model === undefined) throw new Error(`no model resolves for the role @${spec.modelRole}`);
	const agent = options.agents.find(candidate => candidate.name === spec.agent);
	if (agent === undefined) throw new Error(`the agent definition "${spec.agent}" was not found; install agent-skills`);

	const testPaths = spec.testPaths;
	const only = spec.testsOnly ? (file: string): boolean => isTestPath(file, testPaths === undefined ? undefined : { test_paths: testPaths }) : undefined;

	const session = await options.sdk.createAgentSession({
		cwd: spec.cwd,
		model,
		// The SDK types this with `Effort`, a const enum of its catalog package that an extension cannot import; the values are these plain strings.
		thinkingLevel: spec.thinkingLevel as unknown as CreateAgentSessionOptions["thinkingLevel"],
		toolNames: [...SLOTS[spec.slot].tools],
		restrictToolNames: true,
		requireYieldTool: true,
		outputSchema: spec.schema,
		outputSchemaMode: "strict",
		bindProcessState: false,
		hasUI: false,
		enableMCP: false,
		appendSystemPrompt: agent.systemPrompt,
		agentId: slotAgentId(spec, run),
		preloadedPreparedExtensions: [
			{
				path: GUARD_LABEL,
				resolvedPath: GUARD_LABEL,
				factory: workerGuard({ cwd: spec.cwd, writeScope: spec.writeScope, lockedFiles: spec.lockedFiles, ...(only === undefined ? {} : { only }) }),
				error: null,
			},
		],
	});

	// The signal may have fired while the session was being created: its event is gone, so look at it now, before anything runs.
	if (signal.aborted) {
		await session.dispose().catch(() => undefined);
		return stopped();
	}

	let costUsd = 0;
	let contextTokens = 0;
	let payload: unknown;
	let error: string | undefined;
	let aborted: SlotResult["aborted"];
	const finished = Promise.withResolvers<void>();
	const stop = (why: "context" | "signal"): void => {
		if (aborted !== undefined) return;
		aborted = why;
		session
			.abort()
			.catch(() => undefined)
			.finally(() => finished.resolve());
	};
	const unsubscribe = session.subscribe(event => {
		if (aborted !== undefined) return;
		switch (event.type) {
			case "usage":
				costUsd += event.costUsd;
				contextTokens = Math.max(contextTokens, event.contextTokens);
				if (event.contextTokens > spec.maxContextTokens) stop("context");
				break;
			case "yield":
				payload = event.payload;
				error = undefined;
				break;
			case "yield-error":
				error = event.message;
				break;
			case "end":
				finished.resolve();
				break;
		}
	});
	const onAbort = (): void => stop("signal");
	signal.addEventListener("abort", onAbort, { once: true });
	try {
		await session.setTitle(slotTitle(spec.story, spec.task.id, spec.slot));
		session.prompt(spec.prompt).catch(failure => {
			if (aborted === undefined) finished.reject(failure);
		});
		await finished.promise;
	} finally {
		signal.removeEventListener("abort", onAbort);
		unsubscribe();
		// The verdict is already in hand; a session that does not dispose cleanly must not lose it.
		await session.dispose().catch(() => undefined);
	}
	return {
		payload,
		costUsd,
		contextTokens,
		...(session.sessionFile === undefined ? {} : { sessionFile: session.sessionFile }),
		...(aborted === undefined ? {} : { aborted }),
		...(error === undefined ? {} : { error }),
	};
}

export function createSlotRunner(options: SlotRunnerOptions): SlotRunner {
	let runs = 0;
	return { run: (spec, signal) => runSlot(options, spec, signal, ++runs) };
}

// ── The SDK side ────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Maps an SDK session event to what the runner reads; everything else is ignored. */
export function toSlotEvent(event: AgentSessionEvent): SlotEvent | undefined {
	switch (event.type) {
		case "message_end": {
			if (event.message.role !== "assistant") return undefined;
			const { usage } = event.message;
			return { type: "usage", costUsd: usage.cost.total, contextTokens: usage.contextTokens ?? usage.input + usage.cacheRead + usage.cacheWrite };
		}
		case "tool_execution_end": {
			if (event.toolName !== "yield" || event.isError) return undefined;
			const details = isRecord(event.result) ? event.result.details : undefined;
			if (!isRecord(details)) return undefined;
			if (details.status === "success") return { type: "yield", payload: details.data };
			return { type: "yield-error", message: typeof details.error === "string" ? details.error : "the worker yielded an error" };
		}
		case "agent_end":
			return event.isTerminal === false ? undefined : { type: "end" };
		default:
			return undefined;
	}
}

export function adaptSession(session: AgentSession): SlotSession {
	return {
		get sessionFile() {
			return session.sessionFile;
		},
		subscribe: listener =>
			session.subscribe(event => {
				const mapped = toSlotEvent(event);
				if (mapped !== undefined) listener(mapped);
			}),
		prompt: async text => {
			await session.prompt(text);
		},
		abort: () => session.abort(),
		dispose: () => session.dispose(),
		setTitle: async title => {
			await session.setSessionName(title, "user");
		},
	};
}

/** The SDK as an extension gets it (`pi.pi`). `discoverAgents` exists from omp 18.16; older builds fail at the first slot with a clear message. */
export function sdkOf(pi: ExtensionAPI): SlotSdk {
	const sdk = pi.pi;
	return {
		async createAgentSession(options) {
			const { session } = await sdk.createAgentSession(options);
			return adaptSession(session);
		},
		async discoverAgents(cwd) {
			if (!("discoverAgents" in sdk) || typeof sdk.discoverAgents !== "function") throw new Error("this omp build has no discoverAgents; the scheduler needs omp 18.16 or newer");
			const found: unknown = await sdk.discoverAgents(cwd);
			if (!isRecord(found) || !Array.isArray(found.agents)) throw new Error("discoverAgents returned something other than { agents }");
			return found.agents.flatMap(agent => (isRecord(agent) && typeof agent.name === "string" && typeof agent.systemPrompt === "string" ? [{ name: agent.name, systemPrompt: agent.systemPrompt }] : []));
		},
	};
}
