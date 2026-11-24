// `/epic` never implements: from `/epic` until `/epic-done`, `/story` or `/build`, write and edit calls inside the repo are
// held unless they target spec-kit files (`.specify/`, `specs/`, `.omp/commands/speckit.*`). Subagents are held too.
// The state is saved in the session, so it survives the omp restart the epic skill asks for after `specify init`.
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { repoRoot } from "./lib/repo";
import { resolveFrom, targetPaths } from "./lib/tool-input";

const ENTRY = "epic-guard";
const KEY = Symbol.for("omp-starter.epic-guard");
const SPEC_ONLY = /^(?:\.specify\/|specs\/|\.omp\/commands\/speckit\.[^/]+$)/;
const STARTS = /^\/epic(?:\s|$)/;
const ENDS = /^\/(?:story|build)(?:\s|$)/;

// Subagents run the factory again with their own `pi`; one flag on globalThis covers the whole process.
const store = globalThis as typeof globalThis & { [KEY]?: boolean };
const active = (): boolean => store[KEY] === true;

function setActive(pi: ExtensionAPI, on: boolean): void {
	if (active() === on) return;
	store[KEY] = on;
	pi.appendEntry(ENTRY, { active: on });
}

/** The last saved guard state on the current branch. */
function restore(ctx: ExtensionContext): void {
	let on = false;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom" || entry.customType !== ENTRY) continue;
		const data = entry.data;
		on = typeof data === "object" && data !== null && "active" in data && data.active === true;
	}
	store[KEY] = on;
}

/** Repo files outside the spec-kit folders a write or edit call names; paths outside the repo and internal URLs pass. */
export function heldPaths(toolName: string, input: Record<string, unknown>, cwd: string): string[] {
	const named = toolName === "ast_edit" ? (Array.isArray(input.paths) ? input.paths : []) : toolName === "write" || toolName === "edit" ? targetPaths(toolName, input) : [];
	const root = repoRoot(cwd) ?? cwd;
	const held: string[] = [];
	for (const p of named) {
		if (typeof p !== "string" || !p || p.includes("://")) continue;
		const rel = path.relative(root, resolveFrom(cwd, p));
		if (rel.startsWith("..") || path.isAbsolute(rel)) continue;
		if (!SPEC_ONLY.test(rel.split(path.sep).join("/"))) held.push(rel);
	}
	return held;
}

export default function epicGuard(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.agent?.kind !== "sub") restore(ctx);
	});
	pi.on("session_switch", (_event, ctx) => {
		if (ctx.agent?.kind !== "sub") restore(ctx);
	});

	pi.on("input", (event, ctx) => {
		if (ctx.agent?.kind === "sub" || event.source === "extension") return;
		const text = event.text.trimStart();
		if (STARTS.test(text)) {
			setActive(pi, true);
			ctx.ui.notify("epic: spec only. Writes outside .specify/, specs/ and .omp/commands/speckit.* are held until /epic-done, /story or /build.", "info");
		} else if (ENDS.test(text) && active()) {
			setActive(pi, false);
		}
	});

	pi.registerCommand("epic-done", {
		description: "End /epic's spec-only guard so code can be edited again",
		handler: async (_args, ctx) => {
			const was = active();
			setActive(pi, false);
			ctx.ui.notify(was ? "epic: spec-only guard off." : "epic: the spec-only guard was not on.", "info");
		},
	});

	pi.on("tool_call", (event, ctx) => {
		if (!active()) return;
		const held = heldPaths(event.toolName, (event.input ?? {}) as Record<string, unknown>, ctx.cwd);
		if (held.length === 0) return;
		return {
			block: true,
			reason:
				`/epic is spec-only and never implements: ${held.join(", ")} is outside .specify/, specs/ and .omp/commands/speckit.*. ` +
				"Do not write it another way (bash, eval). Record the work as a story in tasks.md instead; the user ends the guard with /epic-done, /story or /build.",
		};
	});
}
