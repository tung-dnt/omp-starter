import { expect, test } from "bun:test";
import * as path from "node:path";
import { EVERY_SESSION_DIR, overlapProblem, primarySource, resolveKb } from "./kb-sources";
import { HOME, migrateKb, type KbSource } from "./state";

const source = (folder: string, kbRef: string, extra: Partial<KbSource> = {}): KbSource => ({
	kbRef,
	kbPaths: [`/vaults/${kbRef}`],
	contextFile: path.join(folder, "AGENTS.md"),
	...extra,
});

const work = source("/w/projects", "work");
const personal = source("/w/personal", "personal", { primary: true });
const everywhere = source(EVERY_SESSION_DIR, "all");

test("the folder source containing the cwd serves it; others and outside folders get none", () => {
	const kb = { status: "done" as const, sources: [work, personal] };
	expect(resolveKb("/w/projects/paco24/src", kb)?.kbRef).toBe("work");
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

test("the marked source is primary, else the first", () => {
	expect(primarySource({ status: "done", sources: [work, personal] })?.kbRef).toBe("personal");
	expect(primarySource({ status: "done", sources: [work, { ...personal, primary: undefined }] })?.kbRef).toBe("work");
});

test("pre-0.14 single-kb state becomes one primary source", () => {
	const legacy = {
		status: "done" as const,
		vault: `${HOME}/.kb`,
		kbRef: "~/.kb/KnowledgeBase",
		kbPaths: [`${HOME}/.kb/KnowledgeBase`],
		contextFile: "/w/projects/AGENTS.md",
		gateDir: "/w/projects",
	};
	expect(migrateKb(legacy)).toEqual({
		status: "done",
		sources: [
			{
				vault: `${HOME}/.kb`,
				kbRef: "~/.kb/KnowledgeBase",
				kbPaths: [`${HOME}/.kb/KnowledgeBase`],
				contextFile: "/w/projects/AGENTS.md",
				gateDir: "/w/projects",
				primary: true,
			},
		],
	});
	expect(migrateKb({ status: "skipped" })).toEqual({ status: "skipped" });
	const current = { status: "done" as const, sources: [work] };
	expect(migrateKb(current)).toEqual(current);
});
