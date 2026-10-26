import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { applyConfig, effectiveEntry, inspectConfig, pluginDirsFromArgv } from "./config";
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
	return { root, home, agentDir, cwd, context: { cwd, agentDir, home, env: {}, pluginDirs: [], ...extra } };
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
	const box = sandbox({ foreignUserSources: { claude: true, codex: true, gemini: true } });
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

test("a project override of fields outside the approved entry is a conflict, not a silent merge", async () => {
	const box = sandbox();
	const shadow = path.join(box.cwd, ".omp", "lsp.json");
	put(shadow, { servers: { gopls: { settings: { gopls: { staticcheck: true } } } } });

	const result = await apply(box, [GOPLS]);

	expect(result.outcomes[0]).toMatchObject({ status: "conflict", conflictsWith: [shadow] });
	expect(result.outcomes[0]?.detail).toContain("`settings`");
	expect(fs.existsSync(lspFile(box))).toBe(false);
});

test("a project adapter that adds launch defaults the approval lacks conflicts, while an identical project entry is already effective", async () => {
	const box = sandbox();
	const shadow = path.join(box.cwd, "dap.json");
	put(shadow, { adapters: { codelldb: { command: "/managed/codelldb", launchDefaults: { python: "./evil" } } } });

	const result = await apply(box, [CODELLDB]);

	expect(result.outcomes[0]).toMatchObject({ status: "conflict", conflictsWith: [shadow] });
	expect(result.outcomes[0]?.detail).toContain("`launchDefaults`");
	expect(fs.existsSync(dapFile(box))).toBe(false);

	const same = sandbox();
	const identical = path.join(same.cwd, "lsp.json");
	put(identical, { servers: { gopls: GOPLS.value } });
	const reused = await apply(same, [GOPLS]);
	expect(reused.outcomes[0]).toMatchObject({ status: "unchanged", path: identical });
	expect(effectiveEntry(reused.snapshot, "lsp", "gopls")?.projectSupplied).toBe(true);
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
	expect(result.snapshot.sources.find(source => source.path === foreign)).toMatchObject({ enablement: "disabled" });
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

test("an identical entry in a foreign config of unknown enablement still gets the managed entry written and is never effective", async () => {
	const box = sandbox();
	const foreign = path.join(box.home, ".codex", "lsp.json");
	put(foreign, { gopls: GOPLS.value });
	const before = await inspectConfig(box.context);

	expect(effectiveEntry(before, "lsp", "gopls")).toBeUndefined();
	const result = await applyConfig(before, { entries: [GOPLS] });

	expect(result.outcomes[0]).toMatchObject({ status: "applied", path: lspFile(box) });
	expect(json(lspFile(box))).toEqual({ servers: { gopls: GOPLS.value } });
	const effective = effectiveEntry(result.snapshot, "lsp", "gopls");
	expect(effective?.source.path).toBe(lspFile(box));
	expect(effective?.unverified.map(source => source.path)).toEqual([foreign]);
});

test("the same entry in a foreign config the caller says is enabled is already effective", async () => {
	const box = sandbox({ foreignUserSources: { codex: true } });
	const foreign = path.join(box.home, ".codex", "lsp.json");
	put(foreign, { gopls: GOPLS.value });

	const result = await apply(box, [GOPLS]);

	expect(result.outcomes[0]).toMatchObject({ status: "unchanged", path: foreign });
	expect(fs.existsSync(lspFile(box))).toBe(false);
});

test("an identical complete entry in the home config is reused, not duplicated", async () => {
	const box = sandbox();
	const home = path.join(box.home, "lsp.json");
	put(home, { gopls: GOPLS.value });

	const result = await apply(box, [GOPLS]);

	expect(result.outcomes[0]).toMatchObject({ status: "unchanged", path: home });
	expect(fs.existsSync(lspFile(box))).toBe(false);
});

test("CLAUDE_CONFIG_DIR keeps Claude's directory in play even when the caller says the provider is off", async () => {
	const box = sandbox({ foreignUserSources: { claude: false } });
	const alternate = path.join(box.root, "alt-claude");
	const inAlternate = path.join(alternate, "lsp.json");
	put(inAlternate, { gopls: { command: "/alt/gopls" } });

	const result = await apply(box, [GOPLS], { ...box.context, env: { CLAUDE_CONFIG_DIR: alternate } });

	expect(result.outcomes[0]).toMatchObject({ status: "conflict", conflictsWith: [inAlternate] });
	expect(result.snapshot.sources.find(source => source.path === inAlternate)).toMatchObject({ enablement: "unknown" });
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
	const box = sandbox({ foreignUserSources: { codex: true } });
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
	["an empty fileTypes list", { command: "x", fileTypes: [] }],
	["an empty rootMarkers list", { command: "x", rootMarkers: [] }],
	["an empty string among the fileTypes", { command: "x", fileTypes: [""] }],
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

	put(path.join(box.home, ".claude", "plugins", "installed_plugins.json"), { version: 1, plugins: {} });
	const fourth = await inspectConfig(box.context);
	expect(fourth.digest).not.toBe(third.digest);
});

// ── Plugin roots ────────────────────────────────────────────────────────────────────────────────

test("an installed plugin's marketplace server is a lower layer: bypassing it is refused and it is never effective", async () => {
	const box = sandbox();
	const market = path.join(box.home, ".claude", "plugins", "cache", "market");
	const root = path.join(market, "gopls-lsp", "1.0.0");
	fs.mkdirSync(root, { recursive: true });
	const catalog = path.join(market, "marketplace.json");
	put(catalog, {
		plugins: [{ name: "other" }, { name: "gopls-lsp", lspServers: { gopls: { command: "gopls", args: [], extensionToLanguage: { ".go": "go" } } } }],
	});
	put(path.join(box.home, ".claude", "plugins", "installed_plugins.json"), { version: 2, plugins: { "gopls-lsp@market": [{ installPath: root, version: "1.0.0" }] } });
	const inline = `${catalog}#plugins/gopls-lsp`;

	const snapshot = await inspectConfig(box.context);
	expect(snapshot.sources.find(source => source.path === inline)).toMatchObject({ scope: "plugin", enablement: "unknown", pluginId: "gopls-lsp@market", shape: "wrapped" });
	expect(effectiveEntry(snapshot, "lsp", "gopls")).toBeUndefined();

	const result = await applyConfig(snapshot, { entries: [GOPLS] });

	expect(result.outcomes[0]).toMatchObject({ status: "conflict", conflictsWith: [inline] });
	expect(result.outcomes[0]?.detail).toContain("replace or bypass");
	expect(result.snapshot.notes.join("\n")).toContain("plugin root");
	expect(fs.existsSync(lspFile(box))).toBe(false);
});

test("plugin root config files are read for both kinds and an identical plugin entry leaves the managed entry to be written", async () => {
	const box = sandbox();
	const root = path.join(box.home, ".claude", "plugins", "cache", "market", "dbg", "1.0.0");
	put(path.join(root, "dap.json"), { adapters: { codelldb: { command: "/plugin/codelldb" } } });
	put(path.join(root, "lsp.json"), { servers: { gopls: GOPLS.value } });
	put(path.join(box.home, ".claude", "plugins", "installed_plugins.json"), { version: 2, plugins: { "dbg@market": [{ installPath: root }] } });

	const result = await apply(box, [CODELLDB, GOPLS]);

	expect(result.outcomes[0]).toMatchObject({ status: "conflict", conflictsWith: [path.join(root, "dap.json")] });
	expect(result.outcomes[1]?.status).toBe("applied");
	expect(json(lspFile(box))).toEqual({ servers: { gopls: GOPLS.value } });
	const effective = effectiveEntry(result.snapshot, "lsp", "gopls");
	expect(effective?.source.path).toBe(lspFile(box));
	expect(effective?.unverified.map(source => source.path)).toEqual([path.join(root, "lsp.json")]);
});

test("a plugin switched off in its registry, an id without a marketplace and an unparsable registry contribute nothing", async () => {
	const box = sandbox();
	const off = path.join(box.root, "plugins", "off");
	const orphan = path.join(box.root, "plugins", "orphan");
	put(path.join(off, "lsp.json"), { gopls: { command: "/off/gopls" } });
	put(path.join(orphan, "lsp.json"), { gopls: { command: "/orphan/gopls" } });
	put(path.join(box.home, ".claude", "plugins", "installed_plugins.json"), {
		version: 2,
		plugins: { "off@market": [{ installPath: off, enabled: false }], "no-market": [{ installPath: orphan }] },
	});
	put(path.join(box.home, ".omp", "plugins", "installed_plugins.json"), "{ not json");

	const result = await apply(box, [GOPLS]);

	expect(result.outcomes[0]?.status).toBe("applied");
	expect(result.snapshot.unresolved).toEqual([]);
});

test("a project plugin registry is found from the working directory and an oversized registry fails closed", async () => {
	const box = sandbox();
	const root = path.join(box.root, "plugins", "proj");
	put(path.join(root, "lsp.json"), { servers: { gopls: { command: "/proj-plugin/gopls" } } });
	put(path.join(box.cwd, ".omp", "plugins", "installed_plugins.json"), { version: 1, plugins: { "proj@local": [{ installPath: root, scope: "project" }] } });

	const refused = await apply(box, [GOPLS]);

	expect(refused.outcomes[0]).toMatchObject({ status: "conflict", conflictsWith: [path.join(root, "lsp.json")] });

	const oversized = sandbox();
	const registry = path.join(oversized.home, ".claude", "plugins", "installed_plugins.json");
	put(registry, `{"version":1,"plugins":{},"padding":"${"x".repeat(1_100_000)}"}`);
	const blocked = await apply(oversized, [GOPLS, CODELLDB]);
	expect(blocked.outcomes.map(outcome => outcome.status)).toEqual(["conflict", "conflict"]);
	expect(blocked.snapshot.unresolved.map(issue => issue.path)).toEqual([registry, registry]);
	expect(blocked.outcomes[0]?.detail).toContain("cannot rule out");
});

test("a marketplace lspServers path is read only while it stays inside the plugin root", async () => {
	const box = sandbox();
	const market = path.join(box.home, ".claude", "plugins", "cache", "market");
	const inside = path.join(market, "in", "1.0.0");
	const outside = path.join(market, "out", "1.0.0");
	put(path.join(inside, "servers.json"), { gopls: { command: "/inside/gopls" } });
	put(path.join(market, "escape.json"), { clangd: { command: "/escaped/clangd" } });
	fs.mkdirSync(outside, { recursive: true });
	put(path.join(market, "marketplace.json"), { plugins: [{ name: "in", lspServers: "./servers.json" }, { name: "out", lspServers: "../../escape.json" }] });
	put(path.join(box.home, ".claude", "plugins", "installed_plugins.json"), {
		version: 2,
		plugins: { "in@market": [{ installPath: inside }], "out@market": [{ installPath: outside }] },
	});

	const result = await apply(box, [GOPLS, CLANGD]);

	expect(result.outcomes[0]).toMatchObject({ status: "conflict", conflictsWith: [path.join(inside, "servers.json")] });
	expect(result.outcomes[1]?.status).toBe("applied");
});

test("a root passed to omp with --plugin-dir is inspected: a conflicting entry blocks and an identical one is never counted as ready", async () => {
	const box = sandbox();
	const root = path.join(box.root, "dev-plugin");
	const file = path.join(root, "lsp.json");
	put(file, { servers: { gopls: { command: "/dev/gopls" } } });

	const snapshot = await inspectConfig({ ...box.context, pluginDirs: [root] });
	const result = await applyConfig(snapshot, { entries: [GOPLS] });

	expect(snapshot.sources.find(source => source.path === file)).toMatchObject({ scope: "plugin", enablement: "unknown", pluginId: "dev-plugin@__local__" });
	expect(result.outcomes[0]).toMatchObject({ status: "conflict", conflictsWith: [file] });
	expect(result.outcomes[0]?.detail).toContain("replace or bypass");
	expect(result.snapshot.notes.join("\n")).toContain("--plugin-dir were inspected");
	expect(fs.existsSync(lspFile(box))).toBe(false);

	const same = sandbox();
	const sameRoot = path.join(same.root, "same-plugin");
	put(path.join(sameRoot, "lsp.json"), { gopls: GOPLS.value });
	const written = await apply(same, [GOPLS], { ...same.context, pluginDirs: [sameRoot] });
	expect(written.outcomes[0]).toMatchObject({ status: "applied", path: lspFile(same) });
	expect(effectiveEntry(written.snapshot, "lsp", "gopls")?.unverified.map(source => source.path)).toEqual([path.join(sameRoot, "lsp.json")]);
});

test("a --plugin-dir root takes its plugin name from its manifest to find its marketplace servers", async () => {
	const box = sandbox();
	const root = path.join(box.root, "catalog", "plugins", "dir-name");
	put(path.join(root, ".claude-plugin", "plugin.json"), { name: "manifest-name" });
	const catalog = path.join(box.root, "catalog", "marketplace.json");
	put(catalog, {
		plugins: [
			{ name: "dir-name", lspServers: { clangd: { command: "/wrong/clangd" } } },
			{ name: "manifest-name", lspServers: { gopls: { command: "/cat/gopls" } } },
		],
	});

	const result = await apply(box, [GOPLS, CLANGD], { ...box.context, pluginDirs: [root] });

	expect(result.outcomes[0]).toMatchObject({ status: "conflict", conflictsWith: [`${catalog}#plugins/manifest-name`] });
	expect(result.outcomes[1]?.status).toBe("applied");
});

test("pluginDirsFromArgv follows omp's parser for --plugin-dir", () => {
	expect(pluginDirsFromArgv(["omp", "--plugin-dir", "a", "-p", "--plugin-dir=b", "--plugin-dir", "--odd", "--", "--plugin-dir", "ignored"])).toEqual(["a", "b", "--odd"]);
	expect(pluginDirsFromArgv(["omp", "--plugin-dir"])).toEqual([]);
	expect(pluginDirsFromArgv([])).toEqual([]);
});

test("without an explicit list the roots come from this process's own arguments, and an explicit list replaces them", async () => {
	const box = sandbox();
	const root = path.join(box.root, "argv-plugin");
	put(path.join(root, "lsp.json"), { gopls: { command: "/argv/gopls" } });
	const { pluginDirs: _explicit, ...bare } = box.context;
	const saved = process.argv;
	process.argv = ["omp", "--api-key", "sk-test-secret", "--plugin-dir", root];
	try {
		const fromArgv = await apply(box, [GOPLS], bare);
		expect(fromArgv.outcomes[0]).toMatchObject({ status: "conflict", conflictsWith: [path.join(root, "lsp.json")] });
		expect(fromArgv.snapshot.context.pluginDirs).toEqual([root]);
		expect(JSON.stringify(fromArgv.snapshot.context)).not.toContain("sk-test-secret");

		const none = await apply(box, [GOPLS], { ...bare, pluginDirs: [] });
		expect(none.outcomes[0]?.status).toBe("applied");
	} finally {
		process.argv = saved;
	}
});

// ── Wrapper semantics and loader failures ───────────────────────────────────────────────────────

test("a wrapper that is not an object makes omp read the whole file as a flat map, so those entries still shadow", async () => {
	const dapBox = sandbox();
	const dapYaml = path.join(dapBox.cwd, ".omp", "dap.yaml");
	put(dapYaml, "adapters:\ncodelldb:\n  command: ./tools/adapter\n");

	const dap = await apply(dapBox, [CODELLDB]);

	expect(dap.outcomes[0]).toMatchObject({ status: "conflict", conflictsWith: [dapYaml] });
	expect(dap.snapshot.sources.find(source => source.path === dapYaml)).toMatchObject({ state: "ok", shape: "flat", wrapperIgnored: true });

	const lspBox = sandbox();
	const lspFlat = path.join(lspBox.cwd, "lsp.json");
	put(lspFlat, { servers: [], gopls: { command: "/proj/gopls" } });
	const lsp = await apply(lspBox, [GOPLS]);
	expect(lsp.outcomes[0]).toMatchObject({ status: "conflict", conflictsWith: [lspFlat] });
});

test("an LSP file whose loader would throw on a null entry cannot be ruled out and blocks LSP entries only", async () => {
	const box = sandbox();
	const broken = path.join(box.cwd, ".omp", "lsp.yaml");
	put(broken, "servers:\ngopls:\n  command: /proj/gopls\n");

	const result = await apply(box, [GOPLS, CODELLDB]);

	expect(result.snapshot.unresolved).toEqual([expect.objectContaining({ kind: "lsp", path: broken })]);
	expect(result.outcomes[0]).toMatchObject({ status: "conflict", conflictsWith: [broken] });
	expect(result.outcomes[0]?.detail).toContain("null entry");
	expect(result.outcomes[1]?.status).toBe("applied");
});

test("a native file whose wrapper is null is refused for either kind and never overwritten", async () => {
	const box = sandbox();
	put(lspFile(box), '{"servers": null}\n');
	put(dapFile(box), '{"adapters": null, "other": {"command": "x"}}\n');
	const before = [text(lspFile(box)), text(dapFile(box))];

	const result = await apply(box, [GOPLS, CODELLDB]);

	expect(result.outcomes.map(outcome => outcome.status)).toEqual(["failed", "failed"]);
	expect(result.outcomes[1]?.detail).toContain("not usable");
	expect([text(lspFile(box)), text(dapFile(box))]).toEqual(before);
});

// ── disabled, non-object keys, directories and environment ─────────────────────────────────────

test("any truthy LSP disabled value disables the server, including YAML's yes", async () => {
	const box = sandbox();
	put(path.join(box.cwd, ".omp", "lsp.yaml"), "servers:\n  gopls:\n    disabled: yes\n");

	const result = await apply(box, [GOPLS]);

	expect(result.outcomes[0]?.status).toBe("conflict");
	expect(result.outcomes[0]?.detail).toContain("disables");
});

test("DAP has no disabled switch: a project's disabled adapter neither blocks nor disables", async () => {
	const same = sandbox();
	const identical = path.join(same.cwd, ".omp", "dap.json");
	put(identical, { adapters: { codelldb: { ...CODELLDB.value, disabled: true } } });

	const reused = await apply(same, [CODELLDB]);

	expect(reused.outcomes[0]).toMatchObject({ status: "unchanged", path: identical });
	expect(effectiveEntry(reused.snapshot, "dap", "codelldb")?.disabled).toBe(false);

	const partial = sandbox();
	put(path.join(partial.cwd, ".omp", "dap.json"), { adapters: { codelldb: { command: "/managed/codelldb", disabled: true } } });
	const written = await apply(partial, [CODELLDB]);
	expect(written.outcomes[0]?.status).toBe("applied");
	expect(effectiveEntry(written.snapshot, "dap", "codelldb")?.disabled).toBe(false);
});

test("an existing key that is not an object is never overwritten", async () => {
	const wrapped = sandbox();
	put(lspFile(wrapped), { servers: { gopls: false } });
	const wrappedBefore = text(lspFile(wrapped));

	const refusedWrapped = await apply(wrapped, [GOPLS]);

	expect(refusedWrapped.outcomes[0]).toMatchObject({ status: "conflict", conflictsWith: [lspFile(wrapped)] });
	expect(refusedWrapped.outcomes[0]?.detail).toContain("not an object");
	expect(text(lspFile(wrapped))).toBe(wrappedBefore);

	const flat = sandbox();
	put(dapFile(flat), { codelldb: "off for now", other: { command: "x" } });
	const refusedFlat = await apply(flat, [CODELLDB]);
	expect(refusedFlat.outcomes[0]?.status).toBe("conflict");
	expect(json(dapFile(flat))).toEqual({ codelldb: "off for now", other: { command: "x" } });
});

test("entries are refused when omp would read user-level config from a different directory than the agent directory", async () => {
	const box = sandbox();
	const elsewhere = path.join(box.root, "srv-agent");

	const result = await apply(box, [GOPLS, CODELLDB], { ...box.context, agentDir: elsewhere });

	expect(result.outcomes.map(outcome => outcome.status)).toEqual(["failed", "failed"]);
	expect(result.outcomes[0]?.detail).toContain(box.agentDir);
	expect(result.outcomes[0]?.detail).toContain("PI_CODING_AGENT_DIR");
	expect(result.snapshot.targets.lsp.problem?.code).toBe("elsewhere");
	expect(fs.existsSync(elsewhere)).toBe(false);
	expect(fs.existsSync(lspFile(box))).toBe(false);
});

test("PI_CONFIG_DIR and the active profile decide where omp reads user-level config", async () => {
	const custom = sandbox();
	const customAgent = path.join(custom.home, ".custom", "agent");
	const customResult = await apply(custom, [GOPLS], { ...custom.context, agentDir: customAgent, env: { PI_CONFIG_DIR: ".custom" } });
	expect(customResult.outcomes[0]?.status).toBe("applied");
	expect(json(path.join(customAgent, "lsp.json"))).toEqual({ servers: { gopls: GOPLS.value } });

	for (const env of [{ OMP_PROFILE: "work" }, { PI_PROFILE: "work" }, { OMP_PROFILE: "work", PI_PROFILE: "other" }]) {
		const box = sandbox();
		const agentDir = path.join(box.home, ".omp", "profiles", "work", "agent");
		const result = await apply(box, [GOPLS], { ...box.context, agentDir, env });
		expect(result.outcomes[0]?.status).toBe("applied");
		expect(json(path.join(agentDir, "lsp.json"))).toEqual({ servers: { gopls: GOPLS.value } });
	}

	const mismatched = sandbox();
	const refused = await apply(mismatched, [GOPLS], { ...mismatched.context, env: { OMP_PROFILE: "work" } });
	expect(refused.outcomes[0]?.status).toBe("failed");
	expect(fs.existsSync(lspFile(mismatched))).toBe(false);

	const emptyWins = sandbox();
	const defaulted = await apply(emptyWins, [GOPLS], { ...emptyWins.context, env: { OMP_PROFILE: "", PI_PROFILE: "work" } });
	expect(defaulted.outcomes[0]?.status).toBe("applied");
});

test("the snapshot keeps only the environment variables the module reads", async () => {
	const box = sandbox();
	const env = { PATH: "/usr/bin", CLAUDE_CONFIG_DIR: "", AWS_SECRET_ACCESS_KEY: "s3cr3t", ANTHROPIC_API_KEY: "sk-ant-test" };

	const snapshot = await inspectConfig({ ...box.context, env });
	const result = await applyConfig(snapshot, { entries: [GOPLS] });

	expect(snapshot.context.env).toEqual({ PATH: "/usr/bin", CLAUDE_CONFIG_DIR: "" });
	for (const held of [snapshot, result.snapshot]) {
		expect(JSON.stringify(held.context)).not.toContain("s3cr3t");
		expect(JSON.stringify(held.context)).not.toContain("sk-ant-test");
	}
});
