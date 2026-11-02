#!/usr/bin/env bun
// omp-starter's own code (not vendored): serves the vendored Bun debug adapter over stdio.
//
// The upstream adapter has no transport: it is driven through an internal event bus
// (`Adapter.request` in; `Adapter.response`, `Adapter.event`, `Adapter.reverseRequest` out).
// This file reads Content-Length framed DAP messages from stdin, feeds them to that bus and
// writes what comes out to stdout with the same framing. stdout carries protocol bytes only;
// every diagnostic goes to stderr.

/** The slice of the upstream adapter the bridge depends on. */
export interface BridgeAdapter {
	emit(event: "Adapter.request", request: DapRequest): unknown;
	on<Args extends unknown[]>(event: string, listener: (...args: Args) => void): unknown;
	/** Sends a JavaScriptCore inspector command. */
	send(method: string, params?: object): Promise<unknown>;
	/** Closes the inspector and stops the program being debugged. */
	close(): void;
}

export interface DapRequest {
	type: "request";
	seq: number;
	command: string;
	arguments?: unknown;
}

/** A decoded frame that may or may not be a well-formed request. */
type Incoming = { type?: string; seq?: number; command?: string; arguments?: unknown };

type DapMessage = Record<string, unknown> & { type: string };

const HEADER_END = Buffer.from("\r\n\r\n");

/** Frames one DAP message. */
export function encodeMessage(message: object): Uint8Array {
	const body = Buffer.from(JSON.stringify(message), "utf8");
	return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]);
}

type Frame = { ok: true; body: string } | { ok: false; reason: string };

/** Splits a byte stream into Content-Length frames. A bad frame is reported and skipped. */
export class FrameReader {
	#buffer: Buffer = Buffer.alloc(0);

	push(chunk: Uint8Array): Frame[] {
		this.#buffer = Buffer.concat([this.#buffer, chunk]);
		const frames: Frame[] = [];
		for (;;) {
			const end = this.#buffer.indexOf(HEADER_END);
			if (end === -1) return frames;
			const header = this.#buffer.subarray(0, end).toString("ascii");
			const match = /^content-length:\s*(\d+)\s*$/im.exec(header);
			if (!match) {
				this.#buffer = this.#buffer.subarray(end + HEADER_END.length);
				frames.push({ ok: false, reason: "missing Content-Length header" });
				continue;
			}
			const length = Number(match[1]);
			const start = end + HEADER_END.length;
			if (this.#buffer.length < start + length) return frames;
			frames.push({ ok: true, body: this.#buffer.subarray(start, start + length).toString("utf8") });
			this.#buffer = this.#buffer.subarray(start + length);
		}
	}
}

export interface ServeOptions {
	input: AsyncIterable<Uint8Array>;
	/** Receives framed bytes in order. May be asynchronous; the bridge awaits the last write before it resolves. */
	write: (bytes: Uint8Array) => void | Promise<void>;
	adapter: BridgeAdapter;
	/** Diagnostics sink (stderr). */
	log: (text: string) => void;
}

/**
 * Bridges framed DAP messages on `input`/`write` to the adapter's event bus.
 * Resolves after stdin ends or after the adapter has answered `disconnect`; the adapter is closed first.
 */
export async function serve({ input, write, adapter, log }: ServeOptions): Promise<void> {
	let seq = 0;
	let queue: Promise<void> = Promise.resolve();
	const send = (message: object): void => {
		const framed = encodeMessage({ ...message, seq: ++seq });
		queue = queue.then(() => write(framed)).catch((error: unknown) => log(`could not write to the client: ${error instanceof Error ? error.message : String(error)}`));
	};
	const errorResponse = (request: Incoming | undefined, message: string): void =>
		send({
			type: "response",
			request_seq: typeof request?.seq === "number" ? request.seq : 0,
			success: false,
			command: typeof request?.command === "string" ? request.command : "",
			message,
		});

	const { promise: disconnected, resolve: finish } = Promise.withResolvers<void>();

	adapter.on("Adapter.response", (response: DapMessage) => {
		send(response);
		if (response.command === "disconnect") finish();
	});
	adapter.on("Adapter.event", (event: DapMessage) => send(event));
	adapter.on("Adapter.reverseRequest", (request: DapMessage) => send(request));
	adapter.on("Adapter.error", (error: Error) => log(`adapter error: ${error.message}`));
	// The debuggee's output travels as DAP output events; its pipes are not ours.
	adapter.on("Process.stdout", (output: string) => send({ type: "event", event: "output", body: { category: "stdout", output } }));
	adapter.on("Process.stderr", (output: string) => send({ type: "event", event: "output", body: { category: "stderr", output } }));

	const reader = new FrameReader();
	// Bun 1.4.4 ignores `break=1` (the flag the adapter sets for stopOnEntry), so stopOnEntry is honoured here: the program
	// is paused before `configurationDone` releases it.
	let stopOnEntry = false;
	const handle = async (frame: Frame): Promise<void> => {
		if (!frame.ok) return errorResponse(undefined, `malformed frame: ${frame.reason}`);
		let message: unknown;
		try {
			message = JSON.parse(frame.body);
		} catch {
			return errorResponse(undefined, "malformed frame: body is not JSON");
		}
		const request = message as Incoming | null;
		if (request === null || typeof request !== "object") return errorResponse(undefined, "malformed frame: body is not an object");
		if (request.type === "response") return; // We make no reverse requests of our own.
		if (request.type !== "request" || typeof request.command !== "string" || typeof request.seq !== "number") {
			return errorResponse(request, "malformed frame: not a DAP request");
		}
		// The adapter silently ignores commands it does not implement, which would leave the client waiting.
		if (typeof (adapter as unknown as Record<string, unknown>)[request.command] !== "function") {
			return errorResponse(request, `unsupported request: ${request.command}`);
		}
		if (request.command === "initialize") {
			// A client that does not advertise configurationDone makes the adapter start the program the moment the inspector
			// connects, a few milliseconds before any client can set a breakpoint or the entry pause can land. The adapter
			// answers with supportsConfigurationDoneRequest, so every client that reads capabilities sends configurationDone.
			adapter.emit("Adapter.request", { ...(request as DapRequest), arguments: { ...(request.arguments as object | undefined), supportsConfigurationDoneRequest: true } });
			return;
		}
		if (request.command === "launch") {
			stopOnEntry = (request.arguments as { stopOnEntry?: unknown } | undefined)?.stopOnEntry === true;
		} else if (request.command === "configurationDone" && stopOnEntry) {
			stopOnEntry = false;
			try {
				await adapter.send("Debugger.pause");
			} catch (error) {
				log(`could not pause at entry: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		adapter.emit("Adapter.request", request as DapRequest);
	};

	const pump = (async () => {
		// One at a time, so a request that waits (configurationDone) cannot be overtaken.
		for await (const chunk of input) for (const frame of reader.push(chunk)) await handle(frame);
	})();
	try {
		await Promise.race([pump, disconnected]);
	} finally {
		adapter.close();
		await queue;
	}
}

async function main(): Promise<void> {
	// The adapter prints debug lines with console.log when NODE_ENV=development; that would corrupt stdout.
	console.log = console.info = console.debug = (...args: unknown[]) => console.error(...args);
	// Dynamic on purpose: the adapter sources need their installed dependencies, which unit tests of the bridge do not have.
	const specifier = new URL("./bun-debug-adapter-protocol/index.ts", import.meta.url).href;
	const { DebugAdapter } = (await import(specifier)) as { DebugAdapter: new () => BridgeAdapter };
	const stdout = process.stdout;
	await serve({
		input: process.stdin as unknown as AsyncIterable<Uint8Array>,
		write: (bytes) => {
			const { promise, resolve, reject } = Promise.withResolvers<void>();
			stdout.write(bytes, (error) => (error ? reject(error) : resolve()));
			return promise;
		},
		adapter: new DebugAdapter(),
		log: (text) => console.error(`[bun-dap] ${text}`),
	});
}

if (import.meta.main) {
	main().then(
		() => process.exit(0),
		(error) => {
			console.error(`[bun-dap] ${error instanceof Error ? error.stack : String(error)}`);
			process.exit(1);
		},
	);
}
