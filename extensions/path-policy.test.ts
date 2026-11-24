import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import pathPolicy from "./path-policy";
import { fakeContext, fakePi, privateHome, resetHome, scriptedUi, seedState, writeFiles, type UiScript } from "./test-harness";

beforeEach(() => {
	resetHome();
	delete process.env.OMP_STARTER_UNATTENDED;
});

afterAll(() => {
	delete process.env.OMP_STARTER_UNATTENDED;
});

interface Verdict {
	block?: boolean;
	reason?: string;
}

function session(options: { agent?: "main" | "sub"; ui?: UiScript; hasUI?: boolean } = {}) {
	const home = privateHome();
	const repo = path.join(home, "projects", "api");
	writeFiles(repo, { ".env": "TOKEN=x\n", ".env.example": "TOKEN=\n", "src/a.ts": "export {};\n", "config/secrets.yml": "k: v\n", ".git/config": "[core]\n" });
	const fake = fakePi();
	pathPolicy(fake.pi);
	const ui = scriptedUi(options.ui);
	const ctx = fakeContext({ cwd: repo, ui, hasUI: options.hasUI ?? true, agent: { kind: options.agent ?? "main", name: options.agent ?? "main" } });
	const call = async (toolName: string, input: object) => (await fake.emit("tool_call", { toolName, input }, ctx)) as Verdict | undefined;
	return { fake, repo, ui, call };
}

describe("held for a session nobody can answer", () => {
	test("a subagent reading the repo .env is blocked, with the path, the rule and the way out", async () => {
		const { call } = session({ agent: "sub" });
		const verdict = await call("read", { path: ".env" });
		expect(verdict?.block).toBe(true);
		expect(verdict?.reason).toContain("read was held");
		expect(verdict?.reason).toContain("~/projects/api/.env");
		expect(verdict?.reason).toContain("**/.env");
		expect(verdict?.reason).toContain("omp-starter.json");
		expect(verdict?.reason).toContain("ask the user");
	});

	test("an unattended main session blocks without prompting", async () => {
		process.env.OMP_STARTER_UNATTENDED = "1";
		const { call, ui } = session();
		expect((await call("read", { path: ".env" }))?.block).toBe(true);
		expect(ui.prompts).toEqual([]);
	});

	test("a headless main session (no UI) blocks without prompting", async () => {
		const { call, ui } = session({ hasUI: false });
		expect((await call("grep", { pattern: "TOKEN", path: ".env" }))?.block).toBe(true);
		expect(ui.prompts).toEqual([]);
	});
});

describe("interactive main session", () => {
	test("confirm true allows, and the same path is not asked about again", async () => {
		const { call, ui } = session({ ui: { confirm: [true] } });
		expect(await call("read", { path: ".env" })).toBeUndefined();
		expect(await call("read", { path: ".env:1-5" })).toBeUndefined();
		expect(ui.prompts).toHaveLength(1);
		expect(ui.prompts[0].title).toBe("Protected path");
		expect(ui.prompts[0].detail).toContain("read ~/projects/api/.env (rule **/.env)");
	});

	test("approval belongs to the path: another secret still asks", async () => {
		const { call, ui } = session({ ui: { confirm: [true, false] } });
		expect(await call("read", { path: ".env" })).toBeUndefined();
		expect((await call("read", { path: "config/secrets.yml" }))?.block).toBe(true);
		expect(ui.prompts).toHaveLength(2);
	});

	test("confirm false blocks", async () => {
		const { call } = session({ ui: { confirm: [false] } });
		const verdict = await call("read", { path: ".env" });
		expect(verdict?.block).toBe(true);
		expect(verdict?.reason).toContain("declined");
	});

	test("a new session forgets earlier approvals", async () => {
		const { fake, ui, call } = session({ ui: { confirm: [true, true] } });
		await call("read", { path: ".env" });
		fake.emit("session_start", {}, {});
		await call("read", { path: ".env" });
		expect(ui.prompts).toHaveLength(2);
	});
});

describe("which calls are held", () => {
	test(".env.example passes by the allow list", async () => {
		const { call } = session({ agent: "sub" });
		expect(await call("read", { path: ".env.example" })).toBeUndefined();
		expect(await call("read", { path: "src/a.ts" })).toBeUndefined();
	});

	test("a hashline edit payload naming .git/config is a protected write", async () => {
		const { call } = session({ agent: "sub" });
		const verdict = await call("edit", { input: "[.git/config#ABCD]\nPUT 1.=1:\n+[core]\n" });
		expect(verdict?.block).toBe(true);
		expect(verdict?.reason).toContain("**/.git/**");
		expect((await call("write", { path: ".git/hooks/pre-commit", content: "x" }))?.block).toBe(true);
	});

	test("protected writes only bind writers: reading .git/config is fine", async () => {
		const { call } = session({ agent: "sub" });
		expect(await call("read", { path: ".git/config" })).toBeUndefined();
		expect(await call("grep", { pattern: "core", path: ".git" })).toBeUndefined();
	});

	test("a read selector does not hide the file", async () => {
		const { call } = session({ agent: "sub" });
		expect((await call("read", { path: "config/secrets.yml:1-5" }))?.block).toBe(true);
		expect((await call("read", { path: "config/secrets.yml:raw" }))?.block).toBe(true);
	});

	test("internal and web URLs are not files", async () => {
		const { call } = session({ agent: "sub" });
		expect(await call("read", { path: "https://example.com/.env" })).toBeUndefined();
		expect(await call("read", { path: "local://.env" })).toBeUndefined();
	});

	test("search tools check their path lists; ast_edit its paths array", async () => {
		const { call } = session({ agent: "sub" });
		expect((await call("grep", { pattern: "x", path: "src;.env" }))?.block).toBe(true);
		expect((await call("ast_grep", { pat: "$A", path: "config/secrets.yml" }))?.block).toBe(true);
		expect((await call("ast_edit", { ops: [], paths: ["src", ".env"] }))?.block).toBe(true);
		expect(await call("glob", { path: "src/**/*.ts" })).toBeUndefined();
	});

	test("a symlink to a secret counts as the secret", async () => {
		const { call, repo } = session({ agent: "sub" });
		fs.symlinkSync(path.join(repo, ".env"), path.join(repo, "notes.txt"));
		expect((await call("read", { path: "notes.txt" }))?.block).toBe(true);
	});

	test("~ globs follow HOME", async () => {
		const { call } = session({ agent: "sub" });
		expect((await call("read", { path: "~/.ssh/id_ed25519" }))?.block).toBe(true);
		expect((await call("write", { path: "~/.zshrc", content: "" }))?.block).toBe(true);
		expect(await call("read", { path: "~/.zshrc" })).toBeUndefined();
	});

	test("bash is not handled here", async () => {
		const { call } = session({ agent: "sub" });
		expect(await call("bash", { command: "cat .env" })).toBeUndefined();
	});
});

describe("configuration", () => {
	test("a provided list replaces its default", async () => {
		seedState({ policy: { secretReads: ["**/*.secret"] } });
		const { call, repo } = session({ agent: "sub" });
		expect(await call("read", { path: ".env" })).toBeUndefined();
		writeFiles(repo, { "db.secret": "x" });
		expect((await call("read", { path: "db.secret" }))?.block).toBe(true);
		expect((await call("write", { path: ".git/config", content: "" }))?.block).toBe(true);
	});

	test("allow replaces its default too", async () => {
		seedState({ policy: { allow: ["**/src/**"], secretReads: ["**/*"] } });
		const { call } = session({ agent: "sub" });
		expect(await call("read", { path: "src/a.ts" })).toBeUndefined();
		expect((await call("read", { path: ".env.example" }))?.block).toBe(true);
	});

	test("policy.off registers no handler", () => {
		seedState({ policy: { off: true } });
		const { fake } = session();
		expect([...fake.handlers.keys()]).toEqual([]);
	});
});
