#!/usr/bin/env bun
// Exercises /peer's command surface in the real omp host, without a model or GitHub writes.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "omp-peer-smoke-"));
const extension = path.resolve(import.meta.dir, "../extensions/peer.ts");
const omp = Bun.which("omp");
assert(omp, "omp must be on PATH");
const child = Bun.spawn([
	omp, "--mode", "rpc", "--no-extensions", "-e", extension,
	"--no-session", "--no-rules", "--no-skills", "--no-context-files",
	"--no-lsp", "--no-title", "--no-tools", "--cwd", home,
	"--model", "openai/gpt-4.1", "--api-key", "peer-smoke-not-a-real-key", "--offline",
], {
	env: {
		PATH: process.env.PATH, HOME: home, TMPDIR: process.env.TMPDIR, TERM: "dumb", NO_COLOR: "1",
		HTTP_PROXY: "http://127.0.0.1:9", HTTPS_PROXY: "http://127.0.0.1:9", ALL_PROXY: "http://127.0.0.1:9",
	},
	stdin: "pipe", stdout: "pipe", stderr: "pipe",
});
const pending = new Map<string, { resolve(value: Record<string, unknown>): void; reject(error: Error): void }>();
const events: Record<string, unknown>[] = [];
let sequence = 0;
let stderr = "";
const errors = new Response(child.stderr).text().then(value => { stderr = value; });
const output = (async () => {
	let buffer = "";
	const decoder = new TextDecoder();
	for await (const bytes of child.stdout) {
		buffer += decoder.decode(bytes, { stream: true });
		let end: number;
		while ((end = buffer.indexOf("\n")) !== -1) {
			const line = buffer.slice(0, end);
			buffer = buffer.slice(end + 1);
			let value: unknown;
			try { value = JSON.parse(line); } catch { continue; }
			if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
			const event = Object.fromEntries(Object.entries(value));
			events.push(event);
			if (typeof event.id === "string" && event.type === "response") pending.get(event.id)?.resolve(event);
		}
	}
	for (const waiting of pending.values()) waiting.reject(new Error(`omp exited before responding: ${stderr}`));
})();

async function request(type: string, fields: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
	const id = `peer-smoke-${++sequence}`;
	const { promise, resolve, reject } = Promise.withResolvers<Record<string, unknown>>();
	pending.set(id, { resolve, reject });
	const timer = setTimeout(() => reject(new Error(`${type} timed out; events=${JSON.stringify(events)}; stderr=${stderr}`)), 30_000);
	try {
		child.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`);
		await child.stdin.flush();
		const response = await promise;
		assert.equal(response.success, true, JSON.stringify(response));
		return response;
	} finally {
		clearTimeout(timer);
		pending.delete(id);
	}
}

try {
	const commands = await request("get_available_commands");
	assert.match(JSON.stringify(commands), /"name":"peer"/, "peer must be registered in the real command registry");
	const cases: [string, RegExp][] = [
		["/peer status", /no.*watch/i],
		["/peer stop", /no.*watch/i],
		["/peer", /\/peer <pr#/],
	];
	for (const [message, expected] of cases) {
		const from = events.length;
		await request("prompt", { message });
		const visible = events.slice(from).filter(event => event.type === "extension_ui_request" && event.method === "notify");
		assert.match(visible.map(event => event.message).join("\n"), expected, `${message} must report its result through the real UI`);
		console.log(`Handled ${message}`);
	}
	assert.equal(events.some(event => event.type === "agent_start"), false, "peer control commands must not start a model turn");
	console.log("Peer RPC smoke passed: command registration, status, stop and required-target usage; no model turn.");
} finally {
	child.stdin.end();
	child.kill();
	await child.exited;
	await Promise.all([output, errors]);
	fs.rmSync(home, { recursive: true, force: true });
}
