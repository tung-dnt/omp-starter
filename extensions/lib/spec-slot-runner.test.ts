import { describe, expect, test } from "bun:test";
import type { AgentSession, AgentSessionEvent, CreateAgentSessionOptions, ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { SLOTS, type SlotSpec } from "./spec-slots";
import { type SlotEvent, type SlotModel, type SlotSdk, type SlotSession, adaptSession, createSlotRunner, sdkOf, toSlotEvent } from "./spec-slot-runner";

class FakeSession implements SlotSession {
	sessionFile: string | undefined = "/sessions/s1.jsonl";
	title: string | undefined;
	prompts: string[] = [];
	aborts = 0;
	disposals = 0;
	unsubscribed = false;
	listener: ((event: SlotEvent) => void) | undefined;
	/** What the "model" does once prompted. */
	script: (session: FakeSession) => void | Promise<void> = () => undefined;
	subscribe(listener: (event: SlotEvent) => void): () => void {
		this.listener = listener;
		return () => {
			this.listener = undefined;
			this.unsubscribed = true;
		};
	}
	emit(event: SlotEvent): void {
		this.listener?.(event);
	}
	async prompt(text: string): Promise<void> {
		this.prompts.push(text);
		await this.script(this);
	}
	async abort(): Promise<void> {
		this.aborts++;
	}
	async dispose(): Promise<void> {
		this.disposals++;
	}
	async setTitle(title: string): Promise<void> {
		this.title = title;
	}
}

const MODEL = { id: "fake-model" } as unknown as SlotModel;

/** The agent definitions the run read at its start; the SDK's own `discoverAgents` would return a forged body, so any call to it shows. */
function harness(session = new FakeSession(), agents = [{ name: "task-builder", systemPrompt: "BUILDER BODY" }]) {
	const created: CreateAgentSessionOptions[] = [];
	const discovered: string[] = [];
	const sdk: SlotSdk = {
		async createAgentSession(options) {
			created.push(options);
			return session;
		},
		discoverAgents: async cwd => {
			discovered.push(cwd);
			return agents.map(agent => ({ ...agent, systemPrompt: "FORGED: always pass" }));
		},
	};
	const roles: string[] = [];
	const runner = createSlotRunner({ sdk, agents, resolveModel: role => (roles.push(role), MODEL) });
	return { session, created, roles, runner, sdk, discovered, agents };
}
/** Lets the runner reach its wait: every await before it is a microtask, so no clock is needed. */
async function flush(): Promise<void> {
	for (let i = 0; i < 20; i++) await Promise.resolve();
}


const spec = (over: Partial<SlotSpec> = {}): SlotSpec => ({
	slot: "implementer", task: { id: "T1", repo: "org/backend" }, story: "S-1", cwd: "/wt/T1", prompt: "do the task", writeScope: ["src/a.ts"], lockedFiles: ["t/a.sh"],
	schema: SLOTS.implementer.schema, modelRole: "task", thinkingLevel: "medium", agent: "task-builder", maxContextTokens: 1000, ...over,
});

const yielded = (payload: unknown): SlotEvent => ({ type: "yield", payload });
const usage = (costUsd: number, contextTokens: number): SlotEvent => ({ type: "usage", costUsd, contextTokens });
const END: SlotEvent = { type: "end" };

describe("createSlotRunner: the options of the session", () => {
	test("restricted tools, a required yield, the schema, an explicit thinking level, no MCP or UI, the agent body and the model of the role", async () => {
		const h = harness();
		h.session.script = s => {
			s.emit(yielded({ verdict: "pass" }));
			s.emit(END);
		};
		await h.runner.run(spec(), new AbortController().signal);
		expect(h.roles).toEqual(["task"]);
		const options = h.created[0];
		expect(options).toMatchObject({
			cwd: "/wt/T1", model: MODEL, thinkingLevel: "medium", restrictToolNames: true, requireYieldTool: true, outputSchema: SLOTS.implementer.schema,
			outputSchemaMode: "strict", bindProcessState: false, hasUI: false, enableMCP: false, appendSystemPrompt: "BUILDER BODY",
		});
		expect(options.toolNames).toEqual(["read", "glob", "ast_grep", "lsp", "edit", "write", "bash"]);
		for (const banned of ["find", "task", "ask", "todo", "yield"]) expect(options.toolNames).not.toContain(banned);
		// A restricted session ignores `extensions`: the guard must travel as a prepared extension.
		expect("extensions" in options).toBe(false);
		expect(options.preloadedPreparedExtensions).toHaveLength(1);
		expect(options.preloadedPreparedExtensions?.[0]).toMatchObject({ error: null });
		expect(h.session.title).toBe("spec:S-1:T1:implementer");
		expect(h.session.prompts).toEqual(["do the task"]);
	});

	test("the agent body is the one read at run start: the runner never asks the SDK to discover agents from the worktree", async () => {
		const h = harness();
		h.session.script = s => s.emit(END);
		await h.runner.run(spec({ cwd: "/wt/T1" }), new AbortController().signal);
		await h.runner.run(spec({ cwd: "/wt/T1", slot: "implementer" }), new AbortController().signal);
		expect(h.discovered).toEqual([]);
		expect(h.created.map(options => options.appendSystemPrompt)).toEqual(["BUILDER BODY", "BUILDER BODY"]);
	});

	test("every run registers under its own agent id (never \"Main\"), parallel runs do not replace each other, and each id is released on dispose", async () => {
		// A model of the SDK's registry: the id is `options.agentId ?? "Main"`, a registration replaces an earlier one of the same id,
		// and disposing the session removes it again.
		const registry = new Map<string, FakeSession>();
		const registered: string[] = [];
		const replaced: string[] = [];
		const sessions: FakeSession[] = [];
		const sdk: SlotSdk = {
			async createAgentSession(options) {
				const id = options.agentId ?? "Main";
				if (registry.has(id)) replaced.push(id);
				const session = new FakeSession();
				session.sessionFile = `/sessions/${id}.jsonl`;
				const dispose = session.dispose.bind(session);
				session.dispose = async () => {
					await dispose();
					if (registry.get(id) === session) registry.delete(id);
				};
				registry.set(id, session);
				registered.push(id);
				sessions.push(session);
				return session;
			},
			discoverAgents: async () => [],
		};
		const runner = createSlotRunner({ sdk, agents: [{ name: "task-builder", systemPrompt: "BODY" }], resolveModel: () => MODEL });
		const running = [spec(), spec(), spec({ task: { id: "T2", repo: "org/backend" } })].map(s => runner.run(s, new AbortController().signal));
		await flush();
		// All three are in flight at once; each holds its own registration.
		expect(registry.size).toBe(3);
		for (const session of sessions) {
			session.emit(yielded({ verdict: "pass" }));
			session.emit(END);
		}
		const results = await Promise.all(running);
		// Each result names the registry id its session ran under, so the run log can show it.
		expect(results.map(result => result.agentId)).toEqual(registered);
		expect(new Set(registered).size).toBe(3);
		expect(registered).not.toContain("Main");
		for (const id of registered) expect(id).toMatch(/^spec-S-1-T[12]-implementer-\d+$/);
		expect(replaced).toEqual([]);
		expect(registry.size).toBe(0);
	});

	test("a tests-only slot gets a guard that blocks writes to files that are not tests, with the repo's own test paths", async () => {
		const h = harness();
		h.session.script = s => s.emit(END);
		const guardOf = async (over: Partial<SlotSpec>) => {
			await h.runner.run(spec({ writeScope: ["src/**", "t/"], lockedFiles: [], testsOnly: true, ...over }), new AbortController().signal);
			const factory = h.created.at(-1)?.preloadedPreparedExtensions?.[0].factory;
			const handlers = new Map<string, unknown>();
			await factory?.({ on: (event: string, handler: unknown) => void handlers.set(event, handler) } as unknown as ExtensionAPI);
			return handlers.get("tool_call") as (event: object, ctx: object) => { block?: boolean; reason?: string } | undefined;
		};
		const builtIn = await guardOf({});
		expect(builtIn({ toolName: "write", input: { path: "src/a.ts" } }, {})?.reason).toContain("src/a.ts is not a test file");
		expect(builtIn({ toolName: "write", input: { path: "src/a.test.ts" } }, {})).toBeUndefined();
		const declared = await guardOf({ testPaths: ["t/**"] });
		expect(declared({ toolName: "write", input: { path: "t/x.sh" } }, {})).toBeUndefined();
		expect(declared({ toolName: "write", input: { path: "src/a.test.ts" } }, {})?.reason).toContain("not a test file");
		const plain = await guardOf({ testsOnly: undefined });
		expect(plain({ toolName: "write", input: { path: "src/a.ts" } }, {})).toBeUndefined();
	});

	test("the prepared guard is the worker guard of this slot: out-of-scope writes and locked tests are blocked, git commits too", async () => {
		const h = harness();
		h.session.script = s => s.emit(END);
		await h.runner.run(spec(), new AbortController().signal);
		const factory = h.created[0].preloadedPreparedExtensions?.[0].factory;
		const handlers = new Map<string, unknown>();
		await factory?.({ on: (event: string, handler: unknown) => void handlers.set(event, handler) } as unknown as ExtensionAPI);
		const toolCall = handlers.get("tool_call") as (event: object, ctx: object) => { block?: boolean; reason?: string } | undefined;
		expect(toolCall({ toolName: "write", input: { path: "src/a.ts" } }, {})).toBeUndefined();
		expect(toolCall({ toolName: "write", input: { path: "docs/x.md" } }, {})?.reason).toContain("outside this task's write scope");
		expect(toolCall({ toolName: "edit", input: { path: "t/a.sh" } }, {})?.reason).toContain("locked test");
		expect(toolCall({ toolName: "bash", input: { command: "git commit -am x" } }, {})?.block).toBe(true);
	});

	test("a read-only slot gets the reading tools and its own agent and role", async () => {
		const h = harness(new FakeSession(), [{ name: "code-reviewer", systemPrompt: "REVIEWER" }]);
		h.session.script = s => s.emit(END);
		await h.runner.run(spec({ slot: "code_review", agent: "code-reviewer", modelRole: "slow", thinkingLevel: "high", writeScope: [], lockedFiles: [], schema: SLOTS.code_review.schema }), new AbortController().signal);
		expect(h.roles).toEqual(["slow"]);
		expect(h.created[0]).toMatchObject({ thinkingLevel: "high", appendSystemPrompt: "REVIEWER" });
		expect(h.created[0].toolNames).toEqual(["read", "glob", "ast_grep", "lsp"]);
	});
});

describe("createSlotRunner: the result", () => {
	test("the payload of the last yield, the summed cost, the largest context and the session file; the session is disposed once", async () => {
		const h = harness();
		h.session.script = s => {
			s.emit(usage(0.01, 100));
			s.emit(yielded("first try"));
			s.emit({ type: "yield-error", message: "schema retry" });
			s.emit(usage(0.02, 300));
			s.emit(usage(0.005, 200));
			s.emit(yielded({ verdict: "pass", notes: "done", checks_run: [] }));
			s.emit(END);
		};
		const result = await h.runner.run(spec(), new AbortController().signal);
		expect(result).toMatchObject({ payload: { verdict: "pass", notes: "done", checks_run: [] }, contextTokens: 300, sessionFile: "/sessions/s1.jsonl" });
		expect(result.costUsd).toBeCloseTo(0.035, 6);
		expect(h.session.disposals).toBe(1);
		expect(h.session.unsubscribed).toBe(true);
		expect(h.session.aborts).toBe(0);
	});

	test("a string payload is passed through for the scheduler to parse", async () => {
		const h = harness();
		h.session.script = s => {
			s.emit(yielded('{"verdict":"pass"}'));
			s.emit(END);
		};
		expect((await h.runner.run(spec(), new AbortController().signal)).payload).toBe('{"verdict":"pass"}');
	});

	test("a worker that only yields an error has no payload and says why; a later yield clears the error", async () => {
		const failed = harness();
		failed.session.script = s => {
			s.emit({ type: "yield-error", message: "no network" });
			s.emit(END);
		};
		expect(await failed.runner.run(spec(), new AbortController().signal)).toMatchObject({ payload: undefined, error: "no network" });
		const recovered = harness();
		recovered.session.script = s => {
			s.emit({ type: "yield-error", message: "no network" });
			s.emit(yielded({ verdict: "pass" }));
			s.emit(END);
		};
		const result = await recovered.runner.run(spec(), new AbortController().signal);
		expect(result.payload).toEqual({ verdict: "pass" });
		expect("error" in result).toBe(false);
	});

	test("a session without a file leaves sessionFile out", async () => {
		const h = harness();
		h.session.sessionFile = undefined;
		h.session.script = s => s.emit(END);
		expect("sessionFile" in (await h.runner.run(spec(), new AbortController().signal))).toBe(false);
	});

	test("it waits for the terminal end even when the prompt has already returned", async () => {
		const h = harness();
		const run = h.runner.run(spec(), new AbortController().signal);
		let settled = false;
		void run.then(() => (settled = true));
		await flush();
		expect(h.session.prompts).toHaveLength(1);
		expect(settled).toBe(false);
		h.session.emit(yielded({ verdict: "pass" }));
		h.session.emit(END);
		expect((await run).payload).toEqual({ verdict: "pass" });
	});
});

describe("createSlotRunner: limits and failures", () => {
	test("past the context ceiling the session is aborted, later events are ignored and the result says context", async () => {
		const h = harness();
		h.session.script = s => {
			s.emit(usage(0.01, 400));
			s.emit(usage(0.02, 1500));
			s.emit(yielded({ verdict: "pass" }));
			s.emit(END);
		};
		const result = await h.runner.run(spec({ maxContextTokens: 1000 }), new AbortController().signal);
		expect(result).toMatchObject({ aborted: "context", costUsd: 0.03, contextTokens: 1500, payload: undefined });
		expect(h.session.aborts).toBe(1);
		expect(h.session.disposals).toBe(1);
	});

	test("the caller's signal aborts the session and the result says signal; an aborted signal never creates a session", async () => {
		const h = harness();
		const controller = new AbortController();
		const run = h.runner.run(spec(), controller.signal);
		await flush();
		controller.abort();
		expect(await run).toMatchObject({ aborted: "signal" });
		expect(h.session.aborts).toBe(1);
		expect(h.session.disposals).toBe(1);

		const idle = harness();
		const already = new AbortController();
		already.abort();
		expect(await idle.runner.run(spec(), already.signal)).toEqual({ payload: undefined, costUsd: 0, contextTokens: 0, aborted: "signal" });
		expect(idle.created).toEqual([]);
	});

	test("a signal that fires while the session is being created still stops the slot: the session is disposed and never prompted", async () => {
		// The wall timeout of a slot can pass during `createAgentSession` (a second or more with a real SDK); the abort event is then gone
		// before the runner listens for it, and the slot used to run to the end with no timeout at all.
		const session = new FakeSession();
		session.script = s => {
			s.emit(yielded({ verdict: "pass", notes: "ran past the timeout", checks_run: [] }));
			s.emit(END);
		};
		const creating = Promise.withResolvers<void>();
		const sdk: SlotSdk = {
			async createAgentSession() {
				await creating.promise;
				return session;
			},
			discoverAgents: async () => [],
		};
		const runner = createSlotRunner({ sdk, agents: [{ name: "task-builder", systemPrompt: "BUILDER BODY" }], resolveModel: () => MODEL });
		const controller = new AbortController();
		const run = runner.run(spec(), controller.signal);
		await flush();
		controller.abort();
		creating.resolve();
		expect(await run).toEqual({ payload: undefined, costUsd: 0, contextTokens: 0, aborted: "signal", agentId: expect.stringMatching(/^spec-S-1-T1-implementer-\d+$/) });
		expect(session.prompts).toEqual([]);
		expect(session.disposals).toBe(1);
	});

	test("a prompt that fails rejects the run with its error, and the session is still disposed", async () => {
		const h = harness();
		h.session.script = () => {
			throw new Error("model unavailable");
		};
		await expect(h.runner.run(spec(), new AbortController().signal)).rejects.toThrow("model unavailable");
		expect(h.session.disposals).toBe(1);
	});

	test("a role with no model and an agent without a definition fail before a session exists", async () => {
		const noModel = createSlotRunner({ sdk: harness().sdk, agents: harness().agents, resolveModel: () => undefined });
		await expect(noModel.run(spec(), new AbortController().signal)).rejects.toThrow("no model resolves for the role @task");
		const h = harness(new FakeSession(), [{ name: "other", systemPrompt: "x" }]);
		await expect(h.runner.run(spec(), new AbortController().signal)).rejects.toThrow('the agent definition "task-builder" was not found; install agent-skills');
		expect(h.created).toEqual([]);
	});
});

/** A message the way the SDK emits it, as far as `toSlotEvent` reads it. */
const message = (role: string, usage?: object) => ({ role, ...(usage === undefined ? {} : { usage }) });
const sdkEvent = (event: object): AgentSessionEvent => event as unknown as AgentSessionEvent;

describe("toSlotEvent and the SDK adapters", () => {
	const cost = { input: 1, output: 1, cacheRead: 1, cacheWrite: 1, total: 0.0123 };

	test("an assistant message_end reports its cost and the context its request carried; other messages are ignored", () => {
		expect(toSlotEvent(sdkEvent({ type: "message_end", message: message("assistant", { input: 100, output: 20, cacheRead: 300, cacheWrite: 40, cost }) }))).toEqual({
			type: "usage", costUsd: 0.0123, contextTokens: 440,
		});
		expect(toSlotEvent(sdkEvent({ type: "message_end", message: message("assistant", { input: 1, output: 1, cacheRead: 1, cacheWrite: 1, contextTokens: 9000, cost }) }))).toMatchObject({ contextTokens: 9000 });
		expect(toSlotEvent(sdkEvent({ type: "message_end", message: message("user") }))).toBeUndefined();
		expect(toSlotEvent(sdkEvent({ type: "turn_start" }))).toBeUndefined();
	});

	test("a successful yield gives its data, an aborted one its error, a failed or other tool call nothing", () => {
		const end = (toolName: string, result: unknown, isError?: boolean) => sdkEvent({ type: "tool_execution_end", toolCallId: "c1", toolName, result, ...(isError === undefined ? {} : { isError }) });
		expect(toSlotEvent(end("yield", { details: { status: "success", data: { verdict: "pass" } } }))).toEqual({ type: "yield", payload: { verdict: "pass" } });
		expect(toSlotEvent(end("yield", { details: { status: "success", data: '{"verdict":"pass"}' } }))).toEqual({ type: "yield", payload: '{"verdict":"pass"}' });
		expect(toSlotEvent(end("yield", { details: { status: "aborted", error: "gave up" } }))).toEqual({ type: "yield-error", message: "gave up" });
		expect(toSlotEvent(end("yield", { details: { status: "aborted" } }))).toEqual({ type: "yield-error", message: "the worker yielded an error" });
		expect(toSlotEvent(end("yield", { details: { status: "success", data: 1 } }, true))).toBeUndefined();
		expect(toSlotEvent(end("yield", "text only"))).toBeUndefined();
		expect(toSlotEvent(end("read", { details: { status: "success", data: 1 } }))).toBeUndefined();
	});

	test("agent_end ends the run unless it is a scheduling pause (isTerminal: false)", () => {
		expect(toSlotEvent(sdkEvent({ type: "agent_end", messages: [] }))).toEqual({ type: "end" });
		expect(toSlotEvent(sdkEvent({ type: "agent_end", messages: [], isTerminal: true }))).toEqual({ type: "end" });
		expect(toSlotEvent(sdkEvent({ type: "agent_end", messages: [], isTerminal: false }))).toBeUndefined();
	});

	test("adaptSession maps events, titles the session as a user name, and passes prompt, abort and dispose through", async () => {
		const calls: string[] = [];
		let listener: ((event: AgentSessionEvent) => void) | undefined;
		const session = {
			sessionFile: "/s/file.jsonl",
			subscribe: (fn: (event: AgentSessionEvent) => void) => {
				listener = fn;
				return () => void calls.push("unsubscribe");
			},
			prompt: async (text: string) => void calls.push(`prompt ${text}`),
			abort: async () => void calls.push("abort"),
			dispose: async () => void calls.push("dispose"),
			setSessionName: async (name: string, source: string) => void calls.push(`name ${name} ${source}`),
		} as unknown as AgentSession;
		const adapted = adaptSession(session);
		expect(adapted.sessionFile).toBe("/s/file.jsonl");
		const seen: SlotEvent[] = [];
		const off = adapted.subscribe(event => void seen.push(event));
		listener?.(sdkEvent({ type: "turn_start" }));
		listener?.(sdkEvent({ type: "agent_end", messages: [] }));
		expect(seen).toEqual([{ type: "end" }]);
		off();
		await adapted.setTitle("spec:S:T:implementer");
		await adapted.prompt("go");
		await adapted.abort();
		await adapted.dispose();
		expect(calls).toEqual(["unsubscribe", "name spec:S:T:implementer user", "prompt go", "abort", "dispose"]);
	});

	test("sdkOf wraps createAgentSession and discoverAgents, keeps well-formed agents, and fails clearly on a build without discoverAgents", async () => {
		const options: CreateAgentSessionOptions[] = [];
		const agentSession = { sessionFile: "/x.jsonl", subscribe: () => () => undefined } as unknown as AgentSession;
		const full = {
			pi: {
				createAgentSession: async (o: CreateAgentSessionOptions) => (options.push(o), { session: agentSession }),
				discoverAgents: async () => ({ agents: [{ name: "task-builder", systemPrompt: "BODY", extra: 1 }, { name: 3 }, { name: "no-body" }] }),
			},
		} as unknown as ExtensionAPI;
		const sdk = sdkOf(full);
		expect(await sdk.discoverAgents("/cwd")).toEqual([{ name: "task-builder", systemPrompt: "BODY" }]);
		const session = await sdk.createAgentSession({ cwd: "/wt" });
		expect(options).toEqual([{ cwd: "/wt" }]);
		expect(session.sessionFile).toBe("/x.jsonl");

		const old = sdkOf({ pi: { createAgentSession: async () => ({ session: agentSession }) } } as unknown as ExtensionAPI);
		await expect(old.discoverAgents("/cwd")).rejects.toThrow("needs omp 18.16 or newer");
		const odd = sdkOf({ pi: { discoverAgents: async () => "nope" } } as unknown as ExtensionAPI);
		await expect(odd.discoverAgents("/cwd")).rejects.toThrow("something other than { agents }");
	});
});
