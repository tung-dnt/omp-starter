// Runs the hook against a real language server on a two-file TypeScript project.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { shutdownAll } from "@oh-my-pi/pi-coding-agent/lsp/client";
import { getConfig } from "@oh-my-pi/pi-coding-agent/lsp/config";
import { getLspServerForFile } from "@oh-my-pi/pi-coding-agent/lsp/servers";
import blastRadius from "./blast-radius";
import { fakeContext, fakePi, initGitRepo, writeFiles } from "./test-harness";

const A = `export function greet(name: string): string {\n\treturn \`hi \${name}\`;\n}\n\nexport const shout = (s: string) => s.toUpperCase();\n`;
const B = `import { greet, shout } from "./a";\n\nexport const msg = shout(greet("x"));\n`;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blast-radius-"));
const fileA = path.join(dir, "src/a.ts");
writeFiles(dir, {
	"tsconfig.json": JSON.stringify({ compilerOptions: { strict: true, module: "esnext", moduleResolution: "bundler" }, include: ["src"] }),
	"src/a.ts": A,
	"src/b.ts": B,
});
initGitRepo(dir);
// The removed-symbol fallback searches tracked files.
execFileSync("git", ["add", "-A"], { cwd: dir });

// The language server comes from the host's own detection; without one there is nothing real to test.
const server = getLspServerForFile(getConfig(dir), fileA);

const fake = fakePi((command, args, options) => {
	const run = Bun.spawnSync([command, ...args], { cwd: (options as { cwd?: string } | undefined)?.cwd });
	return { stdout: run.stdout.toString(), stderr: run.stderr.toString(), code: run.exitCode };
});
blastRadius(fake.pi);
const ctx = fakeContext({ cwd: dir });

/** Applies `next` to src/a.ts the way the edit tool reports it and returns the hook's extra text, if any. */
async function edit(next: string): Promise<string | undefined> {
	const prev = fs.readFileSync(fileA, "utf8");
	fs.writeFileSync(fileA, next);
	const content = [{ type: "text", text: "Updated src/a.ts" }];
	const result = (await fake.emit(
		"tool_result",
		{ type: "tool_result", toolName: "edit", toolCallId: "e1", input: { path: "src/a.ts" }, content, isError: false, details: { diff: "", path: fileA, oldText: prev, newText: next } },
		ctx,
	)) as { content: { text: string }[] } | undefined;
	return result?.content.slice(1).map(c => c.text).join("\n");
}

beforeAll(() => fs.writeFileSync(fileA, A));
afterAll(async () => {
	await shutdownAll();
	fs.rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!server)(`blast-radius hook with ${server?.[0] ?? "no TypeScript language server"}`, () => {
	test("a changed signature lists its callers in other files", async () => {
		const text = await edit(A.replace("greet(name: string)", "greet(name: string, polite: boolean)"));
		expect(text).toContain("- greet: signature changed; 1 ref in 1 file: src/b.ts:3");
		expect(text).not.toContain("src/a.ts");
	}, 30_000);

	test("a body-only edit adds nothing", async () => {
		fs.writeFileSync(fileA, A);
		expect(await edit(A.replace("`hi ${name}`", "`hello ${name}`"))).toBeUndefined();
	}, 30_000);

	test("a write removing an export reports its text matches", async () => {
		fs.writeFileSync(fileA, A);
		fake.emit("tool_call", { type: "tool_call", toolName: "write", toolCallId: "w1", input: { path: "src/a.ts", content: "" } }, ctx);
		fs.writeFileSync(fileA, A.replace(/export const shout[^\n]*\n/, ""));
		const result = (await fake.emit(
			"tool_result",
			{ type: "tool_result", toolName: "write", toolCallId: "w1", input: { path: "src/a.ts" }, content: [], isError: false, details: undefined },
			ctx,
		)) as { content: { text: string }[] } | undefined;
		expect(result?.content.map(c => c.text).join("\n")).toContain("- shout: removed; text matches in 1 file: src/b.ts");
	}, 30_000);

	test("a failed edit adds nothing", async () => {
		const result = await fake.emit(
			"tool_result",
			{ type: "tool_result", toolName: "edit", toolCallId: "e2", input: {}, content: [], isError: true, details: { diff: "", path: fileA, oldText: A, newText: "" } },
			ctx,
		);
		expect(result).toBeUndefined();
	});
});
