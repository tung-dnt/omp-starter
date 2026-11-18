// Structural architecture graph of one repository: who imports whom inside each service, which service reaches
// into which, what triggers each Lambda, and which tables each service writes. Written to docs/arch/ and checked in
// CI so that a PR changes the structure only where its edge list changes (the lead reads that diff first).
//
//   bun scripts/arch-graph.ts generate <repoDir> --map <project-note.md>   write docs/arch/*
//   bun scripts/arch-graph.ts check <repoDir>                            exit 1 when docs/arch/* is stale
//   bun scripts/arch-graph.ts diff <repoDir> --base <ref>                print `+ edge` / `- edge` against <ref>
//
// Exit codes: 0 ok; 1 stale or differences found; 2 usage or tool error (message on stderr).
// Self-contained on purpose (node:* and Bun only): CI downloads this one file and runs it. `check` and `diff` read
// docs/arch/services.json, never the project note, which lives in the lead's vault.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** What the graph needs of a service in the repository's project note. */
export interface Service {
	name: string;
	/** Folder of the service inside the repository; "" for the root. */
	path: string;
	/** Services this one may call. */
	calls: string[];
	ownsTables: string[];
}

class ToolError extends Error {}

const DEPCRUISE = "dependency-cruiser@18.8.0";
const TYPESCRIPT = "typescript@6.0.3";
const TEST_PATH = /(^|\/)(__tests__|test|tests)\/|\.(test|spec)\.[cm]?[jt]sx?$/;
const GENERIC_NODE = /^(utils?|libs?|helpers?|common|shared|types?|constants?|config)$/;
const SOURCE_FILES = "**/*.{ts,tsx,js,mjs,cjs}";
const KYSELY_WRITE = /\.(?:insertInto|updateTable|deleteFrom|replaceInto|mergeInto)\(\s*['"]([\w.]+)['"]/g;
const KNEX_WRITE = /\b(?:knex|db|trx)\(\s*['"]([\w.]+)['"]\s*\)\s*\.(?:insert|update|del|delete)\b/g;

const posix = (p: string): string => p.split(path.sep).join("/");
const firstLine = (text: string): string => text.trim().split("\n")[0] ?? "";

function run(cmd: string[], cwd: string): { code: number; stdout: string; stderr: string } {
	const result = Bun.spawnSync({ cmd, cwd, stdout: "pipe", stderr: "pipe", maxBuffer: 256 * 1024 * 1024 });
	return { code: result.exitCode ?? 1, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

/** Basename of the origin URL, else the folder name: what a service's optional `repo` field is compared with. */
function repoName(repoDir: string): string {
	const origin = run(["git", "-C", repoDir, "remote", "get-url", "origin"], repoDir);
	const name = origin.code === 0 ? origin.stdout.trim().replace(/\/+$/, "").replace(/\.git$/, "").split(/[/:]/).pop() : undefined;
	return name || path.basename(path.resolve(repoDir));
}

/** Services of `repoDir` from the note's first yaml block that has `services:`; an entry naming another `repo` is left out. */
function servicesFromMap(mapFile: string, repoDir: string): Service[] {
	const text = fs.readFileSync(mapFile, "utf8");
	const block = Array.from(text.matchAll(/^```ya?ml[^\n]*\n([\s\S]*?)^```[ \t]*$/gm), match => match[1]).find(body => /^services\s*:/m.test(body));
	if (block === undefined) throw new ToolError(`arch-graph: ${mapFile} has no \`\`\`yaml block with services:`);
	const doc = Bun.YAML.parse(block) as { services?: Record<string, unknown>[] } | null;
	const list = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : []);
	const name = repoName(repoDir);
	const services = (doc?.services ?? [])
		.filter(s => s.repo === undefined || s.repo === name)
		.map((s): Service => ({ name: String(s.name), path: typeof s.path === "string" ? s.path : "", calls: list(s.calls), ownsTables: list(s.owns_tables) }))
		.sort((a, b) => a.name.localeCompare(b.name));
	if (!services.length) throw new ToolError(`arch-graph: ${mapFile} lists no service for repo ${name}`);
	return services;
}

function servicesFile(repoDir: string): string {
	return path.join(repoDir, "docs", "arch", "services.json");
}

/** Services recorded in docs/arch/services.json of `repoDir`. */
export function readServices(repoDir: string): Service[] {
	try {
		return JSON.parse(fs.readFileSync(servicesFile(repoDir), "utf8")) as Service[];
	} catch {
		throw new ToolError(`arch-graph: ${servicesFile(repoDir)} is missing or unreadable; run generate first`);
	}
}

// ── Edges ────────────────────────────────────────────────────────────────────

const serviceDir = (repoDir: string, s: Service): string => path.resolve(repoDir, s.path);

/** The service whose folder holds `abs` (the deepest one when they nest). */
function owner(repoDir: string, services: Service[], abs: string): Service | undefined {
	return services
		.filter(s => abs === serviceDir(repoDir, s) || abs.startsWith(serviceDir(repoDir, s) + path.sep))
		.sort((a, b) => b.path.length - a.path.length)[0];
}

/** A file's node inside its service: `src/<dir>`, `<dir>`, or the file name without extension. */
function collapse(serviceRoot: string, abs: string): string {
	const parts = posix(path.relative(serviceRoot, abs)).split("/");
	if (parts[0] === "src" && parts.length > 2) return `src/${parts[1]}`;
	if (parts.length > 1) return parts[0];
	return parts[0].replace(/\.[^.]+$/, "");
}

const generic = (node: string): boolean => GENERIC_NODE.test(node.split("/").at(-1)!);

/** dependency-cruiser and typescript in a private folder, installed once (the TypeScript transpiler is a peer dependency bunx would skip). */
function depcruiseBin(): string {
	const dir = path.join(os.tmpdir(), `arch-graph-deps-${DEPCRUISE.split("@")[1]}`);
	const bin = path.join(dir, "node_modules", ".bin", "depcruise");
	if (fs.existsSync(bin)) return bin;
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "package.json"), '{"name":"arch-graph-deps","private":true}\n');
	const install = run([Bun.which("bun") ?? "bun", "add", "--silent", DEPCRUISE, TYPESCRIPT], dir);
	if (install.code !== 0 || !fs.existsSync(bin)) throw new ToolError(`arch-graph: dependency-cruiser unavailable (${firstLine(install.stderr) || "install failed"})`);
	return bin;
}

interface Cruise {
	modules: { source: string; dependencies: { resolved: string; coreModule?: boolean; couldNotResolve?: boolean }[] }[];
}

function typescriptEdges(repoDir: string, services: Service[], svc: Service): Set<string> {
	const root = serviceDir(repoDir, svc);
	const edges = new Set<string>();
	const tsconfig = path.join(root, "tsconfig.json");
	const config = path.join(os.tmpdir(), `arch-graph-${process.pid}.cjs`);
	const options = {
		tsPreCompilationDeps: true,
		...(fs.existsSync(tsconfig) ? { tsConfig: { fileName: tsconfig } } : {}),
		enhancedResolveOptions: { extensions: [".ts", ".tsx", ".d.ts", ".js", ".mjs", ".cjs", ".json"] },
	};
	fs.writeFileSync(config, `module.exports = ${JSON.stringify({ options })};\n`);
	let output: string;
	try {
		const cruise = run([Bun.which("bun") ?? "bun", depcruiseBin(), root, "--config", config, "-T", "json", "-x", "node_modules"], repoDir);
		if (cruise.code !== 0 && !cruise.stdout.trim()) throw new ToolError(`arch-graph: dependency-cruiser unavailable (${firstLine(cruise.stderr)})`);
		output = cruise.stdout;
	} finally {
		fs.rmSync(config, { force: true });
	}
	for (const mod of (JSON.parse(output) as Cruise).modules) {
		const from = path.resolve(repoDir, mod.source);
		if (!from.startsWith(root + path.sep) || mod.source.includes("node_modules") || TEST_PATH.test(mod.source)) continue;
		for (const dep of mod.dependencies) {
			if (dep.coreModule || dep.couldNotResolve || dep.resolved.includes("node_modules") || TEST_PATH.test(dep.resolved)) continue;
			const target = path.resolve(repoDir, dep.resolved);
			const targetService = owner(repoDir, services, target);
			if (targetService && targetService.name !== svc.name) {
				edges.add(`cross:${svc.name} -> ${targetService.name}`);
				continue;
			}
			if (!target.startsWith(root + path.sep)) continue;
			const [a, b] = [collapse(root, from), collapse(root, target)];
			if (a !== b && !generic(a) && !generic(b)) edges.add(`code:${svc.name}:${a} -> ${b}`);
		}
	}
	return edges;
}

/** Concatenated JSON objects as `go list -json` prints them. */
function jsonObjects(text: string): Record<string, unknown>[] {
	return text
		.split(/^\}\s*$/m)
		.filter(part => part.includes("{"))
		.map(part => JSON.parse(`${part}}`) as Record<string, unknown>);
}

function goEdges(repoDir: string, services: Service[], svc: Service): Set<string> {
	const root = serviceDir(repoDir, svc);
	const edges = new Set<string>();
	const module = run(["go", "list", "-m"], root);
	if (module.code !== 0) throw new ToolError(`arch-graph: go not found for ${svc.name}${module.stderr ? ` (${firstLine(module.stderr)})` : ""}`);
	const modulePath = module.stdout.trim();
	const listed = run(["go", "list", "-json", "./..."], root);
	if (listed.code !== 0) throw new ToolError(`arch-graph: go list failed for ${svc.name} (${firstLine(listed.stderr)})`);
	// Module path -> folder, for imports that reach into another service's module.
	const modules = new Map<string, string>([[modulePath, root]]);
	for (const other of services) {
		const dir = serviceDir(repoDir, other);
		const m = other.name !== svc.name && fs.existsSync(path.join(dir, "go.mod")) ? run(["go", "list", "-m"], dir) : undefined;
		if (m?.code === 0) modules.set(m.stdout.trim(), dir);
	}
	const node = (importPath: string): string => (importPath === modulePath ? "." : importPath.slice(modulePath.length + 1).split("/")[0]);
	for (const pkg of jsonObjects(listed.stdout)) {
		const from = node(String(pkg.ImportPath));
		for (const imp of (pkg.Imports as string[] | undefined) ?? []) {
			const base = [...modules.keys()].find(m => imp === m || imp.startsWith(`${m}/`));
			if (!base) continue;
			const abs = path.join(modules.get(base)!, imp.slice(base.length));
			const target = owner(repoDir, services, abs);
			if (target && target.name !== svc.name) edges.add(`cross:${svc.name} -> ${target.name}`);
			else if (base === modulePath && node(imp) !== from) edges.add(`code:${svc.name}:${from} -> ${node(imp)}`);
		}
	}
	return edges;
}

type Yaml = Record<string, unknown>;

/** The resource a Serverless event names: an ARN string, `X.Arn`, `{ "Fn::GetAtt": [X, …] }`, `{ Ref: X }` or a plain name. */
function resourceName(value: unknown): string {
	if (typeof value === "string") return value.includes(":") ? value.split(":").at(-1)! : value.split(".")[0];
	if (typeof value !== "object" || value === null) return String(value);
	const v = value as Yaml;
	if (Array.isArray(v["Fn::GetAtt"])) return String(v["Fn::GetAtt"][0]);
	if (v.Ref !== undefined) return String(v.Ref);
	return resourceName(v.arn ?? v.topicName ?? v.bucket ?? v.name ?? Object.values(v)[0]);
}

function eventSource(event: Yaml): string {
	const [key, value] = Object.entries(event)[0] ?? ["event", undefined];
	if (key === "http" || key === "httpApi") {
		const [method, route] = typeof value === "string" ? value.split(/\s+/) : [(value as Yaml).method, (value as Yaml).path];
		return `api:${String(method).toUpperCase()} /${String(route ?? "").replace(/^\/+/, "")}`;
	}
	if (key === "sqs") return `queue:${resourceName(value)}`;
	if (key === "sns") return `topic:${resourceName(value)}`;
	if (key === "stream") return `stream:${resourceName(value)}`;
	if (key === "s3") return `bucket:${resourceName(typeof value === "object" && value ? ((value as Yaml).bucket ?? value) : value)}`;
	return key === "schedule" ? "schedule" : key;
}

function serverlessEdges(repoDir: string, svc: Service): Set<string> {
	const root = serviceDir(repoDir, svc);
	const edges = new Set<string>();
	const file = ["serverless.yml", "serverless.yaml"].map(f => path.join(root, f)).find(f => fs.existsSync(f));
	if (!file) {
		if (fs.existsSync(path.join(root, "serverless.ts"))) console.error(`arch-graph: ${svc.name} uses serverless.ts; infra layer skipped`);
		return edges;
	}
	let doc: Yaml | null;
	try {
		doc = Bun.YAML.parse(fs.readFileSync(file, "utf8")) as Yaml | null;
	} catch (error) {
		throw new ToolError(`arch-graph: cannot parse ${path.basename(file)} of ${svc.name}: ${(error as Error).message}`);
	}
	for (const [fn, def] of Object.entries((doc?.functions ?? {}) as Record<string, Yaml>)) {
		for (const event of (def?.events as Yaml[] | undefined) ?? []) edges.add(`infra:${svc.name}:${eventSource(event)} -> fn:${fn}`);
	}
	return edges;
}

function tableWrites(repoDir: string, svc: Service): Set<string> {
	const root = serviceDir(repoDir, svc);
	const edges = new Set<string>();
	if (!fs.existsSync(root)) return edges;
	for (const rel of new Bun.Glob(SOURCE_FILES).scanSync({ cwd: root, dot: false })) {
		if (rel.split("/").includes("node_modules") || TEST_PATH.test(rel)) continue;
		const text = fs.readFileSync(path.join(root, rel), "utf8");
		for (const pattern of [KYSELY_WRITE, KNEX_WRITE]) {
			for (const m of text.matchAll(pattern)) edges.add(`table-write:${svc.name} -> ${m[1].toLowerCase()}`);
		}
	}
	return edges;
}

/** Every edge of the repository's services, sorted and deduplicated. */
export async function collectEdges(repoDir: string, services: Service[]): Promise<string[]> {
	const edges = new Set<string>();
	for (const svc of services) {
		const root = serviceDir(repoDir, svc);
		const hasTs = fs.existsSync(path.join(root, "package.json")) || [...new Bun.Glob("**/*.ts").scanSync({ cwd: root })].some(f => !f.includes("node_modules"));
		const found = [
			...(hasTs ? typescriptEdges(repoDir, services, svc) : []),
			...(fs.existsSync(path.join(root, "go.mod")) ? goEdges(repoDir, services, svc) : []),
			...serverlessEdges(repoDir, svc),
			...tableWrites(repoDir, svc),
		];
		for (const edge of found) edges.add(edge);
	}
	return [...edges].sort();
}

// ── Output ───────────────────────────────────────────────────────────────────

const mermaidId = (label: string): string => label.replace(/[^A-Za-z0-9_]/g, "_");
const mermaidLine = (a: string, b: string): string => `  ${mermaidId(a)}["${a}"] --> ${mermaidId(b)}["${b}"]`;

/** `[kind, service, from, to]` of an edge line. */
function parseEdge(edge: string): { kind: string; service: string; a: string; b: string } {
	const [left, b] = edge.split(" -> ");
	const [kind, service, ...rest] = left.split(":");
	return { kind, service, a: kind === "code" || kind === "infra" ? rest.join(":") : service, b };
}

/** docs/arch files by name: edges.json, one diagram per service, infra.mmd when there are infra edges, services.json. */
export function renderFiles(edges: string[], services: Service[]): Record<string, string> {
	const files: Record<string, string> = {
		"edges.json": `${JSON.stringify(edges, null, 2)}\n`,
		"services.json": `${JSON.stringify(
			services.map(s => ({ name: s.name, path: s.path, calls: s.calls, ownsTables: s.ownsTables })).sort((a, b) => a.name.localeCompare(b.name)),
			null,
			2,
		)}\n`,
	};
	const parsed = edges.map(parseEdge);
	for (const svc of services) {
		const lines = parsed.filter(e => e.service === svc.name && e.kind !== "infra").map(e => mermaidLine(e.a, e.b)).sort();
		files[`${svc.name}.mmd`] = `flowchart LR\n${lines.map(l => `${l}\n`).join("")}`;
	}
	const infra = parsed.filter(e => e.kind === "infra").map(e => mermaidLine(e.a, e.b)).sort();
	if (infra.length) files["infra.mmd"] = `flowchart LR\n${infra.map(l => `${l}\n`).join("")}`;
	return files;
}

/** Violations of what the project note allows: undeclared cross-service calls and writes to tables another service owns. */
export function structureViolations(edges: string[], services: Service[]): string[] {
	const byName = new Map(services.map(s => [s.name, s]));
	const out: string[] = [];
	for (const edge of edges) {
		const { kind, service, b } = parseEdge(edge);
		const svc = byName.get(service);
		if (kind === "cross" && !svc?.calls.includes(b)) out.push(`cross-service edge ${service} -> ${b} not in the project note`);
		if (kind === "table-write" && !svc?.ownsTables.map(t => t.toLowerCase()).includes(b)) out.push(`${service} writes table ${b} it does not own`);
	}
	return out;
}

/** `+ edge` / `- edge` lines of docs/arch/edges.json in the working copy against `base`; a missing file counts as empty. */
export function diffEdges(repoDir: string, base: string | undefined): string[] {
	const read = (text: string | undefined): Set<string> => {
		try {
			return new Set(JSON.parse(text ?? "[]") as string[]);
		} catch {
			return new Set();
		}
	};
	const shown = base ? run(["git", "-C", repoDir, "show", `${base}:docs/arch/edges.json`], repoDir) : undefined;
	const before = read(shown?.code === 0 ? shown.stdout : undefined);
	const working = path.join(repoDir, "docs", "arch", "edges.json");
	const after = read(fs.existsSync(working) ? fs.readFileSync(working, "utf8") : undefined);
	return [...[...after].filter(e => !before.has(e)).map(e => `+ ${e}`), ...[...before].filter(e => !after.has(e)).map(e => `- ${e}`)].sort((a, b) => a.slice(2).localeCompare(b.slice(2)));
}

/** Names of the docs/arch files that differ from the rendered `files`, including files on one side only. */
export function staleFiles(repoDir: string, files: Record<string, string>): string[] {
	const archDir = path.join(repoDir, "docs", "arch");
	const existing = fs.existsSync(archDir) ? fs.readdirSync(archDir) : [];
	return [...new Set([...Object.keys(files), ...existing])]
		.filter(name => files[name] === undefined || !existing.includes(name) || fs.readFileSync(path.join(archDir, name), "utf8") !== files[name])
		.sort();
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function option(args: string[], name: string): string | undefined {
	const at = args.indexOf(name);
	return at >= 0 ? args[at + 1] : undefined;
}

async function main(args: string[]): Promise<number> {
	const [command, dir] = args;
	if (!dir || !["generate", "check", "diff"].includes(command)) {
		throw new ToolError("arch-graph: usage: arch-graph.ts generate <repoDir> --map <project-note.md> | check <repoDir> | diff <repoDir> --base <ref>");
	}
	const repoDir = path.resolve(dir);
	const archDir = path.join(repoDir, "docs", "arch");
	if (command === "diff") {
		const base = option(args, "--base");
		if (!base) throw new ToolError("arch-graph: --base is required for diff");
		const lines = diffEdges(repoDir, base);
		for (const line of lines) console.log(line);
		return lines.length ? 1 : 0;
	}
	if (command === "generate") {
		const map = option(args, "--map");
		if (!map) throw new ToolError("arch-graph: --map is required for generate");
		const services = servicesFromMap(path.resolve(map), repoDir);
		const files = renderFiles(await collectEdges(repoDir, services), services);
		fs.mkdirSync(archDir, { recursive: true });
		for (const name of fs.readdirSync(archDir)) if (!(name in files)) fs.rmSync(path.join(archDir, name), { recursive: true, force: true });
		for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(archDir, name), content);
		console.log(`arch-graph: wrote ${Object.keys(files).length} files to docs/arch`);
		return 0;
	}
	const services = readServices(repoDir);
	const stale = staleFiles(repoDir, renderFiles(await collectEdges(repoDir, services), services));
	for (const name of stale) console.log(`stale: docs/arch/${name}`);
	return stale.length ? 1 : 0;
}

if (import.meta.main) {
	try {
		process.exit(await main(process.argv.slice(2)));
	} catch (error) {
		if (!(error instanceof ToolError)) throw error;
		console.error(error.message);
		process.exit(2);
	}
}
