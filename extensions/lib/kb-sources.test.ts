import { beforeEach, expect, test } from "bun:test";
import * as path from "node:path";
import { resetHome } from "../test-harness";
import { EVERY_SESSION_DIR, overlapProblem, resolveKb } from "./kb-sources";
import { HOME, migrateKb, readState, writeState, type KbSource, type SetupState } from "./state";

beforeEach(resetHome);

const source = (folder: string, kbRef: string, extra: Partial<KbSource> = {}): KbSource => ({
	kbRef,
	kbPaths: [`/vaults/${kbRef}`],
	contextFile: path.join(folder, "AGENTS.md"),
	...extra,
});

const work = source("/w/projects", "work");
const personal = source("/w/personal", "personal");
const everywhere = source(EVERY_SESSION_DIR, "all");

test("the folder source containing the cwd serves it; others and outside folders get none", () => {
	const kb = { status: "done" as const, sources: [work, personal] };
	expect(resolveKb("/w/projects/acme-api/src", kb)?.kbRef).toBe("work");
	expect(resolveKb("/w/personal", kb)?.kbRef).toBe("personal");
	expect(resolveKb("/w/projects-old", kb)).toBeUndefined();
	expect(resolveKb("/w/projects", { status: "skipped", sources: [work] })).toBeUndefined();
	expect(resolveKb("/anywhere", { status: "done", sources: [everywhere] })?.kbRef).toBe("all");
});

test("source folders may be siblings but not nested, and every-session must stand alone", () => {
	expect(overlapProblem("/w/personal", [work])).toBeUndefined();
	expect(overlapProblem("/w/projects/client", [work])).toContain("overlaps");
	expect(overlapProblem("/w", [work])).toContain("overlaps");
	expect(overlapProblem(EVERY_SESSION_DIR, [work])).toContain("every session");
	expect(overlapProblem("/w/personal", [everywhere])).toContain("every session");
	expect(overlapProblem(EVERY_SESSION_DIR, [])).toBeUndefined();
});

test("pre-0.14 single-kb state becomes one source, and its gate folder moves to the memory state", () => {
	const legacy = {
		status: "done" as const,
		vault: `${HOME}/.kb`,
		kbRef: "~/.kb/KnowledgeBase",
		kbPaths: [`${HOME}/.kb/KnowledgeBase`],
		contextFile: "/w/projects/AGENTS.md",
		gateDir: "/w/projects",
	};
	const expected = {
		vault: `${HOME}/.kb`,
		kbRef: "~/.kb/KnowledgeBase",
		kbPaths: [`${HOME}/.kb/KnowledgeBase`],
		contextFile: "/w/projects/AGENTS.md",
	};
	expect(migrateKb(legacy)).toEqual({ status: "done", sources: [expected] });
	expect(migrateKb({ status: "skipped" })).toEqual({ status: "skipped" });

	writeState({ kb: legacy } as unknown as SetupState);
	expect(readState()).toEqual({ kb: { status: "done", sources: [expected] }, memory: { status: "done", gateDirs: ["/w/projects"] } });
});

test("0.39 state keeps its gate: every source's gateDir becomes one deduplicated memory.gateDirs, and routing is unchanged", () => {
	const legacy = {
		status: "done" as const,
		sources: [
			{ ...work, primary: true, gateDir: "/w/projects" },
			{ ...personal, primary: false, gateDir: "/w/personal" },
			{ ...everywhere, gateDir: "/w/projects" },
			source("/w/plain", "plain"),
		],
	};
	writeState({ kb: legacy } as unknown as SetupState);
	const state = readState();
	expect(state.memory).toEqual({ status: "done", gateDirs: ["/w/projects", "/w/personal"] });
	expect(state.kb?.sources).toEqual([work, personal, everywhere, source("/w/plain", "plain")]);
	expect(resolveKb("/w/projects/acme-api", state.kb)?.kbRef).toBe("work");
	expect(resolveKb("/w/personal/notes", state.kb)?.kbRef).toBe("personal");
});

test("migration never overrides a memory state, and a skipped knowledge base brings no gate", () => {
	writeState({ memory: { status: "done", backend: "mnemopi" }, kb: { status: "done", sources: [{ ...work, gateDir: "/w/projects" }] } } as unknown as SetupState);
	expect(readState().memory).toEqual({ status: "done", backend: "mnemopi" });
	expect(readState().kb?.sources).toEqual([work]);

	writeState({ kb: { status: "skipped", sources: [{ ...work, gateDir: "/w/projects" }] } } as unknown as SetupState);
	expect(readState().memory).toBeUndefined();
});
