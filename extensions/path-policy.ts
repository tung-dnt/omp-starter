// Holds read, search and write calls that touch secret or protected paths (`.env`, keys, ~/.ssh, .git, shell profiles).
// Subagents, unattended and headless sessions are refused; an interactive main session is asked once per path.
// Configured in ~/.omp/agent/omp-starter.json under `policy`; bash is left to omp's `bash.patterns`.
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { expandHome, readState, tildify } from "./lib/state";
import { resolveFrom, SELECTOR, targetPaths } from "./lib/tool-input";

const SECRET_READS = ["**/.env", "**/.env.*", "**/*.pem", "**/*.key", "~/.ssh/**", "~/.aws/credentials", "~/.omp/agent/secrets.yml", "**/secrets.yml"];
const PROTECTED_WRITES = ["**/.git/**", "~/.zshrc", "~/.bashrc", "~/.profile", "~/.zprofile", "~/.omp/agent/config.yml", "~/.omp/agent/keybindings.yml"];
const ALLOW = ["**/.env.example", "**/.env.sample", "**/.env.vault"];

interface Rule {
	glob: string;
	pattern: RegExp;
}

/** Glob to RegExp: `**` crosses folders and may match none when followed or preceded by `/`; `*` and `?` stay inside one path segment. */
function compile(glob: string): Rule {
	const g = expandHome(glob);
	let source = "";
	for (let i = 0; i < g.length; i++) {
		const c = g[i];
		if (c === "*" && g[i + 1] === "*") {
			if (g[i + 2] === "/") {
				source += "(?:.*/)?";
				i += 2;
			} else if (i > 0 && g[i - 1] === "/" && i + 2 === g.length) {
				source = `${source.slice(0, -1)}(?:/.*)?`;
				i += 1;
			} else {
				source += ".*";
				i += 1;
			}
		} else if (c === "*") source += "[^/]*";
		else if (c === "?") source += "[^/]";
		else source += c.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
	}
	return { glob, pattern: new RegExp(`^${source}$`) };
}

const compileAll = (globs: string[]): Rule[] => globs.map(compile);
const firstMatch = (rules: Rule[], file: string): Rule | undefined => rules.find(r => r.pattern.test(file));

/** The file itself, or its folder, resolved through symlinks; undefined when neither exists. */
function realTarget(file: string): string | undefined {
	try {
		return fs.realpathSync(file);
	} catch {
		try {
			return path.join(fs.realpathSync(path.dirname(file)), path.basename(file));
		} catch {
			return undefined;
		}
	}
}

const SEARCHERS = ["read", "grep", "glob", "ast_grep"];

/** Paths a call names: `;`-separated lists and selectors are peeled for searches; exclusions (`!glob`) and internal URLs are dropped. */
function pathsOf(values: unknown[], search: boolean): string[] {
	const out: string[] = [];
	for (const value of values) {
		if (typeof value !== "string") continue;
		for (const part of search ? value.split(";") : [value]) {
			const entry = (search ? part.trim().replace(SELECTOR, "") : part).trim();
			if (entry && !entry.startsWith("!") && !entry.includes("://")) out.push(entry);
		}
	}
	return out;
}

/** Paths the call names, as written, with whether it writes. Undefined: a tool this policy does not cover. */
function touched(toolName: string, input: Record<string, unknown>): { paths: string[]; write: boolean } | undefined {
	if (SEARCHERS.includes(toolName)) return { paths: pathsOf([input.path], true), write: false };
	if (toolName === "ast_edit") return { paths: pathsOf(Array.isArray(input.paths) ? input.paths : [], false), write: true };
	if (toolName === "write" || toolName === "edit") return { paths: pathsOf(targetPaths(toolName, input), false), write: true };
	return undefined;
}

export default function pathPolicy(pi: ExtensionAPI): void {
	const policy = readState().policy;
	if (policy?.off) return;
	const secrets = compileAll(policy?.secretReads ?? SECRET_READS);
	const protectedWrites = compileAll(policy?.protectedWrites ?? PROTECTED_WRITES);
	const allow = compileAll(policy?.allow ?? ALLOW);
	const approved = new Set<string>();

	/** The rule holding `file`, checking each spelling of it (as written, and through symlinks) against the allow list first. */
	function holding(file: string, write: boolean): Rule | undefined {
		const real = realTarget(file);
		for (const form of real && real !== file ? [file, real] : [file]) {
			if (firstMatch(allow, form)) continue;
			const rule = firstMatch(secrets, form) ?? (write ? firstMatch(protectedWrites, form) : undefined);
			if (rule) return rule;
		}
		return undefined;
	}

	pi.on("session_start", () => approved.clear());

	pi.on("tool_call", async (event, ctx) => {
		const call = touched(event.toolName, (event.input ?? {}) as Record<string, unknown>);
		if (!call) return;
		const verb = call.write ? "write" : "read";
		for (const written of call.paths) {
			const file = resolveFrom(ctx.cwd, written);
			if (approved.has(file)) continue;
			const rule = holding(file, call.write);
			if (!rule) continue;
			const shown = tildify(file);
			const unanswered = ctx.agent?.kind === "sub" || process.env.OMP_STARTER_UNATTENDED === "1" || !ctx.hasUI;
			if (unanswered) {
				return {
					block: true,
					reason:
						`${event.toolName} was held: ${shown} matches the protected path rule ${rule.glob}. The user protected it in ~/.omp/agent/omp-starter.json \`policy\`. ` +
						"Do not reach it another way (bash, eval, a copy or a symlink); ask the user for the content or for permission instead.",
				};
			}
			const allowed = await ctx.ui.confirm("Protected path", `${event.toolName} wants to ${verb} ${shown} (rule ${rule.glob}). Allow for this session?`);
			if (!allowed) return { block: true, reason: `${event.toolName} on ${shown} was declined by the user (rule ${rule.glob}). Do not retry or reach it another way; ask the user.` };
			approved.add(file);
		}
	});
}
