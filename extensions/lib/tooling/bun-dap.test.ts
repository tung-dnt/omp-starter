import { expect, test } from "bun:test";
import * as crypto from "node:crypto";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import { type BridgeAdapter, type DapRequest, encodeMessage, FrameReader, serve } from "../../../vendor/bun-dap/stdio-adapter";

// ── The stdio wrapper ───────────────────────────────────────────────────────────────────────────
//
// The upstream adapter has no transport; the wrapper moves framed DAP messages between a byte stream and the
// adapter's event bus. These tests drive `serve` with a fake bus that answers like the real one: it responds to
// `Adapter.request` with `Adapter.response` and emits events, and has one method per supported command.

class FakeAdapter extends EventEmitter implements BridgeAdapter {
	readonly requests: DapRequest[] = [];
	readonly inspector: string[] = [];
	closed = 0;
	/** Fake adapter commands; the real adapter is an object with one method per DAP request. */
	initialize = () => undefined;
	launch = () => undefined;
	configurationDone = () => undefined;
	disconnect = () => undefined;

	constructor() {
		super();
		this.on("Adapter.request", (request: DapRequest) => {
			this.requests.push(request);
			this.emit("Adapter.response", { type: "response", seq: 0, request_seq: request.seq, command: request.command, success: true, body: { echoed: request.command } });
			if (request.command === "initialize") this.emit("Adapter.event", { type: "event", seq: 0, event: "initialized" });
		});
	}

	async send(method: string): Promise<unknown> {
		this.inspector.push(method);
		return {};
	}

	close(): void {
		this.closed += 1;
	}
}

/** A stdin stand-in: chunks pushed by the test, ended on demand. */
function pipe(): { input: AsyncIterable<Uint8Array>; push: (bytes: Uint8Array) => void; end: () => void } {
	const queue: (Uint8Array | null)[] = [];
	let wake: (() => void) | undefined;
	const notify = (): void => {
		wake?.();
		wake = undefined;
	};
	return {
		push: bytes => {
			queue.push(bytes);
			notify();
		},
		end: () => {
			queue.push(null);
			notify();
		},
		input: {
			async *[Symbol.asyncIterator]() {
				for (;;) {
					const next = queue.shift();
					if (next === undefined) {
						const { promise, resolve } = Promise.withResolvers<void>();
						wake = resolve;
						await promise;
						continue;
					}
					if (next === null) return;
					yield next;
				}
			},
		},
	};
}

/** Decodes everything the wrapper wrote. */
function written(chunks: Uint8Array[]): Record<string, unknown>[] {
	const reader = new FrameReader();
	const messages: Record<string, unknown>[] = [];
	for (const chunk of chunks) {
		for (const frame of reader.push(chunk)) {
			if (!frame.ok) throw new Error(frame.reason);
			messages.push(JSON.parse(frame.body) as Record<string, unknown>);
		}
	}
	return messages;
}

function harness(adapter = new FakeAdapter()) {
	const source = pipe();
	const chunks: Uint8Array[] = [];
	const logs: string[] = [];
	const done = serve({ input: source.input, write: bytes => void chunks.push(bytes), adapter, log: text => void logs.push(text) });
	return { adapter, source, chunks, logs, done };
}

const request = (seq: number, command: string, args?: unknown): Uint8Array => encodeMessage({ type: "request", seq, command, arguments: args });

test("framed requests reach the adapter even when a frame is split across chunks, and responses and events come back framed with rising seq", async () => {
	const h = harness();
	const first = request(1, "initialize", { adapterID: "bun" });
	const second = request(2, "launch", { program: "x.ts" });
	const both = Buffer.concat([first, second]);
	// Split inside the first header and inside the second body.
	for (const piece of [both.subarray(0, 8), both.subarray(8, first.length + 40), both.subarray(first.length + 40)]) h.source.push(piece);
	h.source.end();
	await h.done;

	expect(h.adapter.requests.map(item => [item.seq, item.command])).toEqual([
		[1, "initialize"],
		[2, "launch"],
	]);
	const messages = written(h.chunks);
	expect(messages.map(item => [item.type, item.command ?? item.event])).toEqual([
		["response", "initialize"],
		["event", "initialized"],
		["response", "launch"],
	]);
	expect(messages[0]).toMatchObject({ request_seq: 1, success: true, body: { echoed: "initialize" } });
	expect(messages.map(item => item.seq)).toEqual([1, 2, 3]);
});

test("the adapter is always told the client will send configurationDone, so it cannot start the program on its own", async () => {
	const h = harness();
	h.source.push(request(1, "initialize", { clientID: "omp", adapterID: "bun-debug-adapter", linesStartAt1: true }));
	h.source.push(request(2, "initialize", { clientID: "other", supportsConfigurationDoneRequest: false }));
	h.source.end();
	await h.done;
	expect(h.adapter.requests.map(item => item.arguments)).toEqual([
		{ clientID: "omp", adapterID: "bun-debug-adapter", linesStartAt1: true, supportsConfigurationDoneRequest: true },
		{ clientID: "other", supportsConfigurationDoneRequest: true },
	]);
});

test("multi-byte text is framed by bytes, not characters", async () => {
	const h = harness();
	h.source.push(request(1, "launch", { program: "dossier-é-日本.ts" }));
	h.source.end();
	await h.done;
	expect(h.adapter.requests[0]?.arguments).toEqual({ program: "dossier-é-日本.ts" });
});

test("stdin ending stops the debuggee and finishes, flushing what was already answered", async () => {
	const h = harness();
	h.source.push(request(1, "initialize"));
	h.source.end();
	await h.done;
	expect(h.adapter.closed).toBe(1);
	expect(written(h.chunks).map(item => item.type)).toEqual(["response", "event"]);
});

test("a disconnect finishes the wrapper after its response was written even though stdin stays open", async () => {
	const h = harness();
	h.source.push(request(1, "disconnect", { terminateDebuggee: true }));
	await h.done;
	expect(h.adapter.closed).toBe(1);
	expect(written(h.chunks)[0]).toMatchObject({ type: "response", command: "disconnect", success: true });
	h.source.end();
});

test("malformed frames get an error response and the wrapper keeps serving", async () => {
	const h = harness();
	h.source.push(Buffer.from("X-Other: 1\r\n\r\n", "ascii"));
	h.source.push(Buffer.concat([Buffer.from("Content-Length: 9\r\n\r\n", "ascii"), Buffer.from("{not json", "utf8")]));
	h.source.push(encodeMessage({ type: "event", seq: 5, event: "surprise" }));
	h.source.push(request(7, "noSuchCommand"));
	h.source.push(request(8, "initialize"));
	h.source.end();
	await h.done;

	const messages = written(h.chunks);
	const errors = messages.filter(item => item.success === false);
	expect(errors.map(item => item.message)).toEqual([
		"malformed frame: missing Content-Length header",
		"malformed frame: body is not JSON",
		"malformed frame: not a DAP request",
		"unsupported request: noSuchCommand",
	]);
	expect(errors[3]).toMatchObject({ request_seq: 7, command: "noSuchCommand" });
	// The bad frames never reached the adapter, and the good request after them was answered.
	expect(h.adapter.requests.map(item => item.command)).toEqual(["initialize"]);
	expect(messages.some(item => item.type === "response" && item.command === "initialize" && item.success === true)).toBe(true);
});

test("stopOnEntry is honoured by pausing once before configurationDone is passed on, and never otherwise", async () => {
	const stops = harness();
	const adapter = stops.adapter;
	const order: string[] = [];
	const original = adapter.send.bind(adapter);
	adapter.send = async method => {
		order.push(`send ${method}`);
		return original(method);
	};
	adapter.on("Adapter.request", (item: DapRequest) => order.push(`request ${item.command}`));
	stops.source.push(request(1, "launch", { program: "x.ts", stopOnEntry: true }));
	stops.source.push(request(2, "configurationDone"));
	stops.source.push(request(3, "configurationDone"));
	stops.source.end();
	await stops.done;
	expect(order).toEqual(["request launch", "send Debugger.pause", "request configurationDone", "request configurationDone"]);

	const runs = harness();
	runs.source.push(request(1, "launch", { program: "x.ts", stopOnEntry: false }));
	runs.source.push(request(2, "configurationDone"));
	runs.source.end();
	await runs.done;
	expect(runs.adapter.inspector).toEqual([]);
});

test("a pause that fails is logged and configurationDone still goes through", async () => {
	const h = harness();
	const adapter = h.adapter;
	adapter.send = async () => {
		throw new Error("inspector is gone");
	};
	h.source.push(request(1, "launch", { stopOnEntry: true }));
	h.source.push(request(2, "configurationDone"));
	h.source.end();
	await h.done;
	expect(h.logs.join("\n")).toContain("could not pause at entry: inspector is gone");
	expect(adapter.requests.map(item => item.command)).toEqual(["launch", "configurationDone"]);
});

test("the debuggee's output becomes DAP output events and adapter errors go to the log, never to the protocol stream", async () => {
	const h = harness();
	const adapter = h.adapter;
	adapter.emit("Process.stdout", "hello\n");
	adapter.emit("Process.stderr", "warning\n");
	adapter.emit("Adapter.error", new Error("boom"));
	h.source.end();
	await h.done;

	expect(written(h.chunks)).toEqual([
		{ type: "event", event: "output", body: { category: "stdout", output: "hello\n" }, seq: 1 },
		{ type: "event", event: "output", body: { category: "stderr", output: "warning\n" }, seq: 2 },
	]);
	expect(h.logs).toEqual(["adapter error: boom"]);
});

// ── The vendored tree ───────────────────────────────────────────────────────────────────────────

const VENDOR = path.resolve(import.meta.dir, "../../../vendor/bun-dap");

function filesUnder(directory: string): string[] {
	return fs
		.readdirSync(directory, { withFileTypes: true })
		.flatMap(entry => (entry.isDirectory() ? filesUnder(path.join(directory, entry.name)).map(file => `${entry.name}/${file}`) : [entry.name]));
}

test("PROVENANCE.md lists every copied file with the SHA-256 it has on disk, and no copied file is unlisted", () => {
	const provenance = fs.readFileSync(path.join(VENDOR, "PROVENANCE.md"), "utf8");
	const listed = new Map<string, string>();
	for (const match of provenance.matchAll(/^\| `([^`]+)` \| `([0-9a-f]{64})` \|$/gm)) listed.set(match[1] as string, match[2] as string);

	const copied = ["bun-debug-adapter-protocol", "bun-inspector-protocol"].flatMap(directory => filesUnder(path.join(VENDOR, directory)).map(file => `${directory}/${file}`)).sort();
	expect([...listed.keys()].sort()).toEqual(copied);
	for (const [file, hash] of listed) {
		expect(crypto.createHash("sha256").update(fs.readFileSync(path.join(VENDOR, file))).digest("hex")).toBe(hash);
	}
	expect(provenance).toContain("38afee6c84fcf48c0edb2466aa4b27d287a59c30");
	expect(provenance).toContain("Bun itself is MIT-licensed.");
});

test("the vendored lock pins exactly the three runtime dependencies", () => {
	const lock = fs.readFileSync(path.join(VENDOR, "bun.lock"), "utf8");
	const pinned = [...lock.matchAll(/^\s{4}"([^"]+)": \["[^"]+@[^"]+", "", .*"sha512-[^"]+"\],?$/gm)].map(match => match[1]).sort();
	expect(pinned).toEqual(["semver", "source-map-js", "ws"]);
	expect(JSON.parse(fs.readFileSync(path.join(VENDOR, "package.json"), "utf8")).dependencies).toEqual({ semver: "^7.5.4", "source-map-js": "^1.0.2", ws: "^8.18.3" });
});
