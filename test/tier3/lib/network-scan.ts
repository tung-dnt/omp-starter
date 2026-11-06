// R-106: the scheduler makes no network call beyond the model calls and never pushes. A static scan of the code under test: the files
// the scheduler extension loads (the relative-import closure of `extensions/spec-workflow.ts`) and every script under `scripts/`,
// tests excluded. A hit names file and line. Pure apart from reading files, so `selftest` can run it on a temp tree.
import * as fs from "node:fs";
import * as path from "node:path";

export interface Hit {
	file: string;
	line: number;
	text: string;
	why: string;
}

const MODULES = /(?:from\s*|import\s*\(\s*|require\s*\(\s*)["'](?:node:)?(?:https?|net|tls|dgram|http2)["']/;
const FETCH = /(^|[^\w.$])fetch\s*\(/;
const SOCKET = /\b(?:new\s+)?WebSocket\b/;
/** A call that runs git or a process (`git(`, `gitOrThrow(`, `hooklessOrThrow(`, `Bun.spawn(`, `exec(`) or the word "git" as a string: a name like GIT_MUTATIONS is not one. */
const GITCALL = /\b(?:git\w*|hookless\w*|spawn\w*|exec\w*)\s*\(|["'`]git["'`]/;

/** Hits in one file's text. `push` counts only as a string literal near a git call (a git argv), not as an array method. */
export function scanText(file: string, text: string): Hit[] {
	const hits: Hit[] = [];
	const lines = text.split("\n");
	lines.forEach((raw, i) => {
		const code = raw.replace(/\/\/.*$/, "");
		if (/^\s*(\*|\/\*)/.test(raw)) return;
		const hit = (why: string): number => hits.push({ file, line: i + 1, text: raw.trim().slice(0, 160), why });
		if (MODULES.test(code)) hit("imports a network module");
		if (FETCH.test(code)) hit("calls fetch");
		if (SOCKET.test(code)) hit("uses WebSocket");
		if (/["'`]push["'`]/.test(code) && lines.slice(Math.max(0, i - 3), i + 1).some(l => GITCALL.test(l.replace(/\/\/.*$/, "")))) hit("a git argv contains push");
	});
	return hits;
}

const IMPORT = /(?:from\s*|import\s*\(\s*|require\s*\(\s*)["'](\.{1,2}\/[^"']+)["']/g;

function resolve(from: string, spec: string): string | undefined {
	const base = path.resolve(path.dirname(from), spec);
	for (const candidate of [base, `${base}.ts`, path.join(base, "index.ts")]) if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
	return undefined;
}

/** The entry file, every file it reaches through relative imports, and every non-test file under `scripts/`. */
export function schedulerFiles(code: string): string[] {
	const entry = path.join(code, "extensions/spec-workflow.ts");
	const seen = new Set<string>();
	const walk = (file: string): void => {
		if (seen.has(file) || /\.test\.ts$/.test(file)) return;
		seen.add(file);
		for (const m of fs.readFileSync(file, "utf8").matchAll(IMPORT)) {
			const next = resolve(file, m[1] as string);
			if (next !== undefined) walk(next);
		}
	};
	if (fs.existsSync(entry)) walk(entry);
	const scripts = path.join(code, "scripts");
	if (fs.existsSync(scripts)) for (const f of fs.readdirSync(scripts)) if (f.endsWith(".ts") && !f.endsWith(".test.ts")) walk(path.join(scripts, f));
	return [...seen].sort();
}

export function scanCode(code: string): { files: number; hits: Hit[] } {
	const files = schedulerFiles(code);
	return { files: files.length, hits: files.flatMap(f => scanText(path.relative(code, f), fs.readFileSync(f, "utf8"))) };
}
