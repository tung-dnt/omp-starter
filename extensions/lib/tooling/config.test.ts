import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { applyConfig, effectiveEntry, inspectConfig } from "./config";
import { acquireLock, ensureToolingRoots } from "./runtime";
import type { ApplyResult, ConfigContext, ConfigEntry } from "./types";

const sandboxes: string[] = [];

afterEach(() => {
	for (const root of sandboxes.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

interface Box {
	root: string;
	home: string;
	agentDir: string;
	cwd: string;
	context: ConfigContext;
}

/** A private home, native agent directory and project; nothing here touches the real user configuration. */
function sandbox(extra: Partial<ConfigContext> = {}): Box {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "omp-config-test-")));
	sandboxes.push(root);
	const home = path.join(root, "home");
	const agentDir = path.join(home, ".omp", "agent");
	const cwd = path.join(root, "project");
	fs.mkdirSync(agentDir, { recursive: true });
	fs.mkdirSync(cwd, { recursive: true });
	return { root, home, agentDir, cwd, context: { cwd, agentDir, home, env: {}, ...extra } };
}

function put(file: string, content: string | object): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`);
}

function text(file: string): string {
	return fs.readFileSync(file, "utf8");
}

function json(file: string): unknown {
	return JSON.parse(text(file));
}

function lspFile(box: Box): string {
	return path.join(box.agentDir, "lsp.json");
}

function dapFile(box: Box): string {
	return path.join(box.agentDir, "dap.json");
}

async function apply(box: Box, entries: ConfigEntry[], context: ConfigContext = box.context): Promise<ApplyResult> {
	return applyConfig(await inspectConfig(context), { entries });
}

const GOPLS: ConfigEntry = {
	kind: "lsp",
	key: "gopls",
	value: { command: "/managed/gopls", args: [], fileTypes: [".go"], rootMarkers: ["go.mod"] },
};
const CLANGD: ConfigEntry = {
	kind: "lsp",
	key: "clangd",
	value: { command: "/managed/clangd", args: ["--background-index=false"], fileTypes: [".c", ".cpp"], rootMarkers: ["compile_commands.json"] },
};
const CODELLDB: ConfigEntry = {
	kind: "dap",
	key: "codelldb",
	value: { command: "/managed/codelldb", args: [], connectMode: "stdio" },
};
const MINE = { command: "my-server", fileTypes: [".m"], rootMarkers: ["m.marker"] };

// ── Shape preservation ──────────────────────────────────────────────────────────────────────────

test("a fresh home gets wrapped native files and the cwd-only root-marker rule is disclosed", async () => {
	const box = sandbox();
	const snapshot = await inspectConfig(box.context);
	expect(snapshot.targets.lsp).toMatchObject({ exists: false, shape: "new", path: lspFile(box) });
	const result = await applyConfig(snapshot, { entries: [GOPLS, CODELLDB] });

	expect(result.outcomes.map(outcome => outcome.status)).toEqual(["applied", "applied"]);
	expect(json(lspFile(box))).toEqual({ servers: { gopls: GOPLS.value } });
	expect(json(dapFile(box))).toEqual({ adapters: { codelldb: CODELLDB.value } });
	expect(result.outcomes[0]?.rootMatch).toEqual({ cwd: box.cwd, markers: ["go.mod"], matches: false });
	expect(result.outcomes[0]?.detail).toContain("parent directories are not searched");
	expect(result.outcomes[1]?.rootMatch).toBeUndefined();

	fs.writeFileSync(path.join(box.cwd, "go.mod"), "module example\n");
	const again = await applyConfig(result.snapshot, { entries: [GOPLS] });
	expect(again.outcomes[0]).toMatchObject({ status: "unchanged", rootMatch: { matches: true } });
});

test("flat JSON stays flat and keeps its other keys and their order", async () => {
	const box = sandbox();
	put(lspFile(box), { "my-server": MINE, idleTimeoutMs: 1000 });

	const result = await apply(box, [GOPLS]);

	expect(result.outcomes[0]?.status).toBe("applied");
	expect(json(lspFile(box))).toEqual({ "my-server": MINE, idleTimeoutMs: 1000, gopls: GOPLS.value });
	expect(Object.keys(json(lspFile(box)) as object)).toEqual(["my-server", "idleTimeoutMs", "gopls"]);
});

test("wrapped JSON keeps its wrapper, its siblings and its unrelated servers", async () => {
	const box = sandbox();
	put(lspFile(box), { servers: { "my-server": MINE }, idleTimeoutMs: 5 });
	put(dapFile(box), { adapters: { other: { command: "other-adapter" } } });

	const result = await apply(box, [GOPLS, CODELLDB]);

	expect(result.outcomes.map(outcome => outcome.status)).toEqual(["applied", "applied"]);
	expect(json(lspFile(box))).toEqual({ servers: { "my-server": MINE, gopls: GOPLS.value }, idleTimeoutMs: 5 });
	expect(json(dapFile(box))).toEqual({ adapters: { other: { command: "other-adapter" }, codelldb: CODELLDB.value } });
});

test("an empty object or an idle-timeout-only file gets a wrapper without losing keys", async () => {
	const emptyBox = sandbox();
	put(lspFile(emptyBox), "{}\n");
	await apply(emptyBox, [GOPLS]);
	expect(json(lspFile(emptyBox))).toEqual({ servers: { gopls: GOPLS.value } });

	const idleBox = sandbox();
	put(lspFile(idleBox), { idleTimeoutMs: 5 });
	await apply(idleBox, [GOPLS]);
	expect(json(lspFile(idleBox))).toEqual({ idleTimeoutMs: 5, servers: { gopls: GOPLS.value } });
});

test("an existing hidden JSON variant is the merge target and lsp.json is not created beside it", async () => {
	const box = sandbox();
	const hidden = path.join(box.agentDir, ".lsp.json");
	put(hidden, { mine: MINE });

	const result = await apply(box, [GOPLS]);

	expect(result.outcomes[0]?.status).toBe("applied");
	expect(result.snapshot.targets.lsp.path).toBe(hidden);
	expect(fs.existsSync(lspFile(box))).toBe(false);
	expect(Object.keys(json(hidden) as object)).toEqual(["mine", "gopls"]);
});

test("indentation, trailing newline and file mode survive the merge", async () => {
	const box = sandbox();
	put(lspFile(box), '{\n\t"servers": {}\n}');
	fs.chmodSync(lspFile(box), 0o640);

	await apply(box, [GOPLS]);

	const merged = text(lspFile(box));
	expect(merged.startsWith('{\n\t"servers": {\n\t\t"gopls": {')).toBe(true);
	expect(merged.endsWith("\n")).toBe(false);
	expect(fs.statSync(lspFile(box)).mode & 0o777).toBe(0o640);
});

test("a symlinked agent directory still works and the entry lands in the real directory", async () => {
	const box = sandbox();
	const real = path.join(box.root, "dotfiles", "agent");
	fs.mkdirSync(real, { recursive: true });
	fs.rmSync(box.agentDir, { recursive: true });
	fs.symlinkSync(real, box.agentDir);

	const result = await apply(box, [GOPLS]);

	expect(result.outcomes[0]?.status).toBe("applied");
	expect(json(path.join(real, "lsp.json"))).toEqual({ servers: { gopls: GOPLS.value } });
});

test("a missing agent directory is created for the first merge", async () => {
	const box = sandbox();
	fs.rmSync(box.agentDir, { recursive: true });

	const result = await apply(box, [GOPLS]);

	expect(result.outcomes[0]?.status).toBe("applied");
	expect(json(lspFile(box))).toEqual({ servers: { gopls: GOPLS.value } });
});

// ── Idempotence ─────────────────────────────────────────────────────────────────────────────────

test("repeating an approved merge is a no-op that rewrites nothing", async () => {
	const box = sandbox();
	const first = await apply(box, [GOPLS]);
	const before = text(lspFile(box));
	const statBefore = fs.statSync(lspFile(box));

	const second = await applyConfig(first.snapshot, { entries: [GOPLS] });

	expect(second.outcomes[0]?.status).toBe("unchanged");
	expect(text(lspFile(box))).toBe(before);
	const statAfter = fs.statSync(lspFile(box));
	expect(statAfter.mtimeMs).toBe(statBefore.mtimeMs);
	expect(statAfter.ino).toBe(statBefore.ino);
});

test("sequential merges that chain the returned snapshot keep every unrelated key", async () => {
	const box = sandbox();
	put(lspFile(box), { servers: { "my-server": MINE }, idleTimeoutMs: 7 });

	const first = await apply(box, [GOPLS]);
	const second = await applyConfig(first.snapshot, { entries: [CLANGD] });
	const third = await applyConfig(second.snapshot, { entries: [GOPLS, CLANGD] });

	expect(second.outcomes[0]?.status).toBe("applied");
	expect(third.outcomes.map(outcome => outcome.status)).toEqual(["unchanged", "unchanged"]);
	expect(json(lspFile(box))).toEqual({
		servers: { "my-server": MINE, gopls: GOPLS.value, clangd: CLANGD.value },
		idleTimeoutMs: 7,
	});
});

// ── Precedence ladder and YAML ──────────────────────────────────────────────────────────────────

test("sources are ranked exactly as omp merges them: project, native, foreign user, home", async () => {
	const box = sandbox();
	const places = [
		path.join(box.cwd, "lsp.json"),
		path.join(box.cwd, ".omp", "lsp.json"),
		path.join(box.cwd, ".claude", "lsp.json"),
		path.join(box.cwd, ".codex", "lsp.json"),
		path.join(box.cwd, ".gemini", "lsp.json"),
		lspFile(box),
		path.join(box.home, ".claude", "lsp.json"),
		path.join(box.home, ".codex", "lsp.json"),
		path.join(box.home, ".gemini", "lsp.json"),
		path.join(box.home, "lsp.json"),
	];
	for (const place of places) put(place, { servers: { demo: { command: path.relative(box.root, place) } } });

	const snapshot = await inspectConfig(box.context);
	const effective = effectiveEntry(snapshot, "lsp", "demo");

	expect(snapshot.sources.filter(source => source.kind === "lsp").map(source => source.path)).toEqual(places);
	expect(effective?.source.path).toBe(places[0]);
	expect(effective?.layers.map(layer => layer.source.path)).toEqual([...places].reverse());
	expect(effective?.value.command).toBe(path.relative(box.root, places[0]!));
	expect(effective?.projectSupplied).toBe(true);
});

test("variants in one directory merge in omp's order and YAML (wrapped or flat) is read", async () => {
	const box = sandbox();
	put(path.join(box.agentDir, ".lsp.yaml"), "servers:\n  demo:\n    command: yaml\n    fileTypes: ['.x']\n");
	put(path.join(box.agentDir, ".lsp.json"), { demo: { command: "hidden-json" } });
	put(lspFile(box), { servers: { demo: { command: "json" } } });
	put(path.join(box.cwd, "dap.yml"), "codelldb:\n  command: /bin/lldb\n  args: []\n");

	const snapshot = await inspectConfig(box.context);
	const demo = effectiveEntry(snapshot, "lsp", "demo");

	expect(demo?.layers.map(layer => path.basename(layer.source.path))).toEqual([".lsp.yaml", ".lsp.json", "lsp.json"]);
	expect(demo?.value).toEqual({ command: "json", fileTypes: [".x"] });
	expect(effectiveEntry(snapshot, "dap", "codelldb")?.value).toEqual({ command: "/bin/lldb", args: [] });
	expect(snapshot.sources.find(source => source.path.endsWith("dap.yml"))).toMatchObject({ shape: "flat", format: "yaml" });
});

test("YAML in the native directory is never edited or shadowed", async () => {
	const conflictBox = sandbox();
	const yaml = path.join(conflictBox.agentDir, "lsp.yaml");
	put(yaml, "# my notes\nservers:\n  gopls:\n    command: /usr/local/bin/gopls\n    fileTypes: ['.go']\n    rootMarkers: ['go.mod']\n");
	const before = text(yaml);

	const refused = await apply(conflictBox, [GOPLS]);

	expect(refused.outcomes[0]).toMatchObject({ status: "conflict", conflictsWith: [yaml] });
	expect(refused.outcomes[0]?.detail).toContain("replace or bypass");
	expect(text(yaml)).toBe(before);
	expect(fs.existsSync(lspFile(conflictBox))).toBe(false);

	const otherBox = sandbox();
	const otherYaml = path.join(otherBox.agentDir, "lsp.yaml");
	put(otherYaml, "# keep this comment\nservers:\n  my-server:\n    command: my-server\n    fileTypes: ['.m']\n    rootMarkers: ['m']\n");
	const yamlBefore = text(otherYaml);

	const added = await apply(otherBox, [GOPLS]);

	expect(added.outcomes[0]?.status).toBe("applied");
	expect(text(otherYaml)).toBe(yamlBefore);
	expect(json(lspFile(otherBox))).toEqual({ servers: { gopls: GOPLS.value } });
	expect(effectiveEntry(added.snapshot, "lsp", "my-server")?.source.path).toBe(otherYaml);
	expect(effectiveEntry(added.snapshot, "lsp", "gopls")?.source.path).toBe(lspFile(otherBox));
});

// ── Project precedence and shadowing ────────────────────────────────────────────────────────────

const SHADOWS: [string, string, string | object][] = [
	["a flat project-root file", "lsp.json", { gopls: { command: "/proj/gopls" } }],
	["a wrapped project .omp file", ".omp/lsp.json", { servers: { gopls: { command: "/proj/gopls" } } }],
	["a project .claude YAML file", ".claude/lsp.yaml", "servers:\n  gopls:\n    command: /proj/gopls\n"],
	["a project override of a single field", ".gemini/lsp.json", { servers: { gopls: { args: ["--debug"] } } }],
];

for (const [name, relative, content] of SHADOWS) {
	test(`${name} shadows the user-level entry, so it is refused`, async () => {
		const box = sandbox();
		const shadow = path.join(box.cwd, relative);
		put(shadow, content);

		const result = await apply(box, [GOPLS]);

		expect(result.outcomes[0]).toMatchObject({ status: "conflict", conflictsWith: [shadow] });
		expect(result.outcomes[0]?.detail).toContain("takes precedence");
		expect(fs.existsSync(lspFile(box))).toBe(false);
	});
}

test("a project that disables the server blocks the entry", async () => {
	const box = sandbox();
	put(path.join(box.cwd, ".omp", "lsp.json"), { servers: { gopls: { disabled: true } } });

	const result = await apply(box, [GOPLS]);

	expect(result.outcomes[0]?.status).toBe("conflict");
	expect(result.outcomes[0]?.detail).toContain("disables");
});

test("a project override of unrelated fields does not block and stays visible in the effective entry", async () => {
	const box = sandbox();
	put(path.join(box.cwd, ".omp", "lsp.json"), { servers: { gopls: { settings: { gopls: { staticcheck: true } } } } });

	const result = await apply(box, [GOPLS]);
	const effective = effectiveEntry(result.snapshot, "lsp", "gopls");

	expect(result.outcomes[0]?.status).toBe("applied");
	expect(effective?.value).toEqual({ ...GOPLS.value, settings: { gopls: { staticcheck: true } } });
	expect(effective?.projectSupplied).toBe(true);
});

// ── Foreign and home sources ────────────────────────────────────────────────────────────────────

test("foreign user config is a conflict by default and is disclosed as possibly effective", async () => {
	const box = sandbox();
	const foreign = path.join(box.home, ".claude", "lsp.json");
	put(foreign, { gopls: { command: "/claude/gopls" } });

	const result = await apply(box, [GOPLS]);

	expect(result.outcomes[0]).toMatchObject({ status: "conflict", conflictsWith: [foreign] });
	expect(result.outcomes[0]?.detail).toContain("replace or bypass");
	expect(result.snapshot.notes.join("\n")).toContain("treated as possibly effective");
	expect(fs.existsSync(lspFile(box))).toBe(false);
});

test("a foreign provider the caller says is not enabled is listed but inert", async () => {
	const box = sandbox({ foreignUserSources: { claude: false } });
	const foreign = path.join(box.home, ".claude", "lsp.json");
	put(foreign, { gopls: { command: "/claude/gopls" } });

	const result = await apply(box, [GOPLS]);

	expect(result.outcomes[0]?.status).toBe("applied");
	expect(result.snapshot.sources.find(source => source.path === foreign)).toMatchObject({ enabled: false });
	expect(effectiveEntry(result.snapshot, "lsp", "gopls")?.source.path).toBe(lspFile(box));
});

test("CLAUDE_CONFIG_DIR replaces ~/.claude as the Claude user directory", async () => {
	const box = sandbox();
	const alternate = path.join(box.root, "alt-claude");
	const inAlternate = path.join(alternate, "lsp.json");
	put(inAlternate, { gopls: { command: "/alt/gopls" } });
	put(path.join(box.home, ".claude", "lsp.json"), { gopls: { command: "/ignored/gopls" } });

	const result = await apply(box, [GOPLS], { ...box.context, env: { CLAUDE_CONFIG_DIR: alternate } });

	expect(result.outcomes[0]).toMatchObject({ status: "conflict", conflictsWith: [inAlternate] });
});

test("an identical complete entry in another source is reused, not duplicated", async () => {
	const box = sandbox();
	const foreign = path.join(box.home, ".codex", "lsp.json");
	put(foreign, { gopls: GOPLS.value });

	const result = await apply(box, [GOPLS]);

	expect(result.outcomes[0]).toMatchObject({ status: "unchanged", path: foreign });
	expect(fs.existsSync(lspFile(box))).toBe(false);
});

test("home config is the lowest layer yet still refuses to be bypassed", async () => {
	const box = sandbox();
	const home = path.join(box.home, "lsp.json");
	put(home, { gopls: { command: "/home/gopls" } });

	const result = await apply(box, [GOPLS]);

	expect(result.outcomes[0]).toMatchObject({ status: "conflict", conflictsWith: [home] });
});

test("a lower layer that disables the server blocks the entry", async () => {
	const box = sandbox();
	put(path.join(box.home, ".gemini", "lsp.json"), { gopls: { disabled: true } });

	const result = await apply(box, [GOPLS]);

	expect(result.outcomes[0]?.status).toBe("conflict");
	expect(result.outcomes[0]?.detail).toContain("disables");
});

test("DAP launchDefaults merge one level deep, so only the same sub-key conflicts", async () => {
	const box = sandbox();
	const foreign = path.join(box.home, ".codex", "dap.json");
	put(foreign, { adapters: { codelldb: { command: "/managed/codelldb", launchDefaults: { a: 1 } } } });
	const extra: ConfigEntry = { kind: "dap", key: "codelldb", value: { command: "/managed/codelldb", launchDefaults: { b: 2 } } };
	const clash: ConfigEntry = { kind: "dap", key: "codelldb", value: { command: "/managed/codelldb", launchDefaults: { a: 2 } } };

	const refused = await apply(box, [clash]);
	expect(refused.outcomes[0]?.status).toBe("conflict");

	const added = await apply(box, [extra]);
	expect(added.outcomes[0]?.status).toBe("applied");
	expect(effectiveEntry(added.snapshot, "dap", "codelldb")?.value).toEqual({
		command: "/managed/codelldb",
		launchDefaults: { a: 1, b: 2 },
	});
});

// ── Never replace what the user already has ─────────────────────────────────────────────────────

test("an existing native entry is never replaced", async () => {
	const box = sandbox();
	put(lspFile(box), { servers: { gopls: { command: "/mine/gopls" }, other: { command: "x" } } });
	const before = text(lspFile(box));

	const result = await apply(box, [GOPLS]);

	expect(result.outcomes[0]).toMatchObject({ status: "conflict", conflictsWith: [lspFile(box)] });
	expect(result.outcomes[0]?.detail).toContain("already defines");
	expect(text(lspFile(box))).toBe(before);
});

test("a conflict-only run writes nothing and creates no tooling directory", async () => {
	const box = sandbox();
	put(path.join(box.cwd, "lsp.json"), { gopls: { command: "/proj/gopls" } });

	await apply(box, [GOPLS]);

	expect(fs.existsSync(path.join(box.agentDir, "tooling"))).toBe(false);
	expect(fs.existsSync(lspFile(box))).toBe(false);
});

test("one refused entry does not stop independent entries in the same proposal", async () => {
	const box = sandbox();
	put(path.join(box.cwd, "lsp.json"), { gopls: { command: "/proj/gopls" } });

	const result = await apply(box, [GOPLS, CLANGD, CODELLDB]);

	expect(result.outcomes.map(outcome => outcome.status)).toEqual(["conflict", "applied", "applied"]);
	expect(json(lspFile(box))).toEqual({ servers: { clangd: CLANGD.value } });
});

// ── Invalid, unusual and changing files ─────────────────────────────────────────────────────────

const BROKEN: [string, string][] = [
	["invalid JSON", "{ not json"],
	["an array at the top level", "[]\n"],
	["a servers value that is not an object", '{"servers": []}\n'],
];

for (const [name, content] of BROKEN) {
	test(`${name} in the native file is reported and never overwritten`, async () => {
		const box = sandbox();
		put(lspFile(box), content);

		const result = await apply(box, [GOPLS]);

		expect(result.outcomes[0]?.status).toBe("failed");
		expect(result.outcomes[0]?.detail).toContain("not usable");
		expect(result.outcomes[0]?.detail).toContain("not modified");
		expect(text(lspFile(box))).toBe(content);
	});
}

test("an invalid file elsewhere is ignored like omp does and only reported", async () => {
	const box = sandbox();
	const broken = path.join(box.cwd, "lsp.json");
	put(broken, "{ broken");

	const result = await apply(box, [GOPLS]);

	expect(result.outcomes[0]?.status).toBe("applied");
	expect(result.snapshot.issues).toContainEqual(expect.objectContaining({ kind: "lsp", path: broken }));
	expect(text(broken)).toBe("{ broken");
});

test("a symlinked native file is a conflict and neither it nor its target is touched", async () => {
	const box = sandbox();
	const real = path.join(box.root, "dotfiles", "lsp.json");
	put(real, { servers: {} });
	fs.symlinkSync(real, lspFile(box));
	const before = text(real);

	const result = await apply(box, [GOPLS]);

	expect(result.outcomes[0]?.status).toBe("conflict");
	expect(result.outcomes[0]?.detail).toContain("symbolic link");
	expect(text(real)).toBe(before);
	expect(fs.lstatSync(lspFile(box)).isSymbolicLink()).toBe(true);
});

test("a file changed after inspection fails clearly and keeps the other writer's content", async () => {
	const box = sandbox();
	const snapshot = await inspectConfig(box.context);
	put(lspFile(box), { servers: { "late-server": { command: "late" } } });

	const result = await applyConfig(snapshot, { entries: [GOPLS] });

	expect(result.outcomes[0]?.status).toBe("failed");
	expect(result.outcomes[0]?.detail).toContain("changed since it was inspected");
	expect(json(lspFile(box))).toEqual({ servers: { "late-server": { command: "late" } } });

	const retry = await applyConfig(result.snapshot, { entries: [GOPLS] });
	expect(retry.outcomes[0]?.status).toBe("applied");
	expect(json(lspFile(box))).toEqual({ servers: { "late-server": { command: "late" }, gopls: GOPLS.value } });
});

test("an active update lock fails the competing run and leaves the file alone", async () => {
	const box = sandbox();
	put(lspFile(box), { servers: { "my-server": MINE } });
	const before = text(lspFile(box));
	const toolingRoots = await ensureToolingRoots(box.agentDir);
	const lock = await acquireLock(path.join(toolingRoots.locks, "config-lsp.lock"), "test holder");

	const blocked = await apply(box, [GOPLS]);
	expect(blocked.outcomes[0]?.status).toBe("failed");
	expect(blocked.outcomes[0]?.detail).toContain("already in progress");
	expect(text(lspFile(box))).toBe(before);

	await lock.release();
	const retry = await apply(box, [GOPLS]);
	expect(retry.outcomes[0]?.status).toBe("applied");
});

test("two competing applies leave exactly one winner and valid JSON", async () => {
	const box = sandbox();
	const snapshot = await inspectConfig(box.context);

	const [first, second] = await Promise.all([
		applyConfig(snapshot, { entries: [GOPLS] }),
		applyConfig(snapshot, { entries: [CLANGD] }),
	]);

	expect([first.outcomes[0]?.status, second.outcomes[0]?.status].sort()).toEqual(["applied", "failed"]);
	const written = json(lspFile(box)) as { servers: object };
	expect(Object.keys(written.servers)).toHaveLength(1);
});

test("an oversized config file cannot be inspected, so shadowing is unprovable and the entry is refused", async () => {
	const box = sandbox();
	const huge = path.join(box.cwd, "lsp.json");
	put(huge, `{${" ".repeat(1_100_000)}}`);

	const result = await apply(box, [GOPLS]);

	expect(result.snapshot.unresolved).toContainEqual(expect.objectContaining({ path: huge }));
	expect(result.outcomes[0]).toMatchObject({ status: "conflict", conflictsWith: [huge] });
	expect(result.outcomes[0]?.detail).toContain("cannot rule out");
});

// ── Proposal validation ─────────────────────────────────────────────────────────────────────────

const BAD_VALUES: [string, unknown][] = [
	["a missing command", { args: [] }],
	["an empty command", { command: "" }],
	["args that are not strings", { command: "x", args: [1] }],
	["a function inside a nested value", { command: "x", initOptions: { fn: () => 1 } }],
	["a non-finite number", { command: "x", initOptions: { n: Number.NaN } }],
	["an unknown connectMode", { command: "x", connectMode: "udp" }],
	["a non-boolean disabled", { command: "x", disabled: "yes" }],
	["a string instead of an object", "just a string"],
	["an array instead of an object", ["x"]],
];

for (const [name, value] of BAD_VALUES) {
	test(`a proposal with ${name} is rejected without touching disk`, async () => {
		const box = sandbox();
		const entry = { kind: "lsp", key: "gopls", value } as ConfigEntry;

		const result = await apply(box, [entry]);

		expect(result.outcomes[0]?.status).toBe("failed");
		expect(result.outcomes[0]?.detail).toContain("invalid proposal entry");
		expect(fs.existsSync(lspFile(box))).toBe(false);
	});
}

for (const key of ["servers", "adapters", "idleTimeoutMs", "__proto__", "go pls", "", "k".repeat(65)]) {
	test(`the key ${JSON.stringify(key.slice(0, 12))} is not a valid server name`, async () => {
		const box = sandbox();

		const result = await apply(box, [{ kind: "lsp", key, value: { command: "x" } }]);

		expect(result.outcomes[0]?.status).toBe("failed");
		expect(fs.existsSync(lspFile(box))).toBe(false);
	});
}

test("the same kind and key twice in one proposal is refused for the second copy", async () => {
	const box = sandbox();

	const result = await apply(box, [GOPLS, GOPLS]);

	expect(result.outcomes.map(outcome => outcome.status)).toEqual(["applied", "failed"]);
	expect(result.outcomes[1]?.detail).toContain("more than once");
});

// ── Static command resolution (PATH and project-local reuse) ────────────────────────────────────

function executable(file: string): void {
	put(file, "#!/bin/sh\nexit 0\n");
	fs.chmodSync(file, 0o755);
}

test("effective entries resolve their command through PATH and project-local bins without executing anything", async () => {
	const bin = path.join(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "omp-config-bin-"))));
	sandboxes.push(bin);
	executable(path.join(bin, "gopls"));
	const box = sandbox({ env: { PATH: bin } });
	put(lspFile(box), { gopls: { command: "gopls" }, missing: { command: "definitely-not-installed" } });
	put(path.join(box.cwd, "package.json"), "{}\n");
	executable(path.join(box.cwd, "node_modules", ".bin", "typescript-language-server"));
	put(path.join(box.cwd, ".omp", "lsp.json"), { servers: { "typescript-language-server": { command: "typescript-language-server" } } });

	const snapshot = await inspectConfig(box.context);

	expect(effectiveEntry(snapshot, "lsp", "gopls")?.command).toEqual({ path: path.join(bin, "gopls"), origin: "path" });
	expect(effectiveEntry(snapshot, "lsp", "missing")?.command).toBeUndefined();
	const local = effectiveEntry(snapshot, "lsp", "typescript-language-server");
	expect(local?.command).toEqual({ path: path.join(box.cwd, "node_modules", ".bin", "typescript-language-server"), origin: "project-local" });
	expect(local?.projectSupplied).toBe(true);
	expect(effectiveEntry(snapshot, "lsp", "gopls")?.projectSupplied).toBe(false);
});

test("an absolute command and a DAP-relative command resolve to the executables omp would use", async () => {
	const box = sandbox();
	const absolute = path.join(box.root, "tools", "lldb");
	executable(absolute);
	executable(path.join(box.cwd, "tools", "adapter"));
	put(dapFile(box), { adapters: { lldb: { command: absolute }, local: { command: "./tools/adapter" } } });

	const snapshot = await inspectConfig(box.context);

	expect(effectiveEntry(snapshot, "dap", "lldb")?.command).toEqual({ path: absolute, origin: "absolute" });
	expect(effectiveEntry(snapshot, "dap", "local")?.command).toEqual({ path: path.join(box.cwd, "tools", "adapter"), origin: "project-local" });
});

// ── Inspection fingerprint ──────────────────────────────────────────────────────────────────────

test("the inspection digest is stable for identical files and changes when any candidate changes", async () => {
	const box = sandbox();
	put(lspFile(box), { servers: {} });

	const first = await inspectConfig(box.context);
	const second = await inspectConfig(box.context);
	put(path.join(box.cwd, ".claude", "dap.yaml"), "adapters: {}\n");
	const third = await inspectConfig(box.context);

	expect(second.digest).toBe(first.digest);
	expect(third.digest).not.toBe(first.digest);
});
