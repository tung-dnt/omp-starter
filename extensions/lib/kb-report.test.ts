import { expect, test } from "bun:test";
import { checkMemory, classifyMemoryFile } from "./kb-report";

test("classifies real notes separately from index, hidden files, and temporary files", () => {
	expect(classifyMemoryFile("project-note.md")).toEqual({ kind: "note", slug: "project-note" });
	expect(classifyMemoryFile("MEMORY.md")).toBeUndefined();
	expect(classifyMemoryFile(".hidden-note.md")).toBeUndefined();
	expect(classifyMemoryFile(".note.md.tmp")).toBeUndefined();
	expect(classifyMemoryFile("note.tmp")).toBeUndefined();
	expect(classifyMemoryFile("notes.txt")).toBeUndefined();
});

test("recognizes evicted iCloud placeholders and sync-conflicted copies", () => {
	expect(classifyMemoryFile(".project-note.md.icloud")).toEqual({ kind: "evicted", slug: "project-note" });
	expect(classifyMemoryFile(".md.icloud")).toBeUndefined();
	expect(classifyMemoryFile(".invalid name.md.icloud")).toBeUndefined();
	expect(classifyMemoryFile("project-note 2.md")).toEqual({ kind: "copy" });
	expect(classifyMemoryFile("project-note (conflicted copy).md")).toEqual({ kind: "copy" });
});

test("distinguishes dangling index entries from entries whose notes are evicted", () => {
	const result = checkMemory(
		["## Global", "- [Missing](missing.md) — missing", "- [Evicted](evicted.md) — evicted"].join("\n"),
		[],
		["evicted"],
		[],
	);

	expect(result.dangling).toEqual([{ slug: "missing", section: "Global" }]);
});

test("finds unindexed notes and records every section containing a duplicate slug", () => {
	const index = [
		"## Global",
		"- [Shared](shared.md) — shared",
		"",
		"## Project",
		"<!-- repos: project-repo -->",
		"- [Shared](shared.md) — shared again",
	].join("\n");
	const good = "---\nname: shared\ndescription: Shared note\nmetadata:\n  node_type: memory\n  type: project\n---\nBody\n";
	const result = checkMemory(index, [
		{ slug: "shared", text: good },
		{ slug: "unlisted", text: "---\nname: unlisted\ndescription: Unlisted\n---\nBody\n" },
	], [], []);

	expect(result.unindexed).toEqual(["unlisted"]);
	expect(result.duplicates).toEqual([{ slug: "shared", sections: ["Global", "Project"] }]);
});

test("reports missing frontmatter and missing or empty descriptions", () => {
	const result = checkMemory("", [
		{ slug: "plain", text: "No frontmatter here" },
		{ slug: "no-description", text: "---\nname: no-description\n---\nBody" },
		{ slug: "empty-description", text: "---\nname: empty-description\ndescription: \"\"\n---\nBody" },
	], [], []);

	expect(result.frontmatter.map(({ slug }) => slug)).toEqual(["plain", "no-description", "empty-description"]);
});

test("accepts valid nested and legacy flat frontmatter", () => {
	const nested = "---\nname: nested\ndescription: Nested note\nmetadata:\n  node_type: memory\n  type: reference\n  modified: 2026-10-26T00:00:00Z\n---\nBody";
	const legacy = "---\nname: legacy\ndescription: Legacy note\ntype: user\nmodified: 2024-01-01\n---\nBody";
	const result = checkMemory("", [{ slug: "nested", text: nested }, { slug: "legacy", text: legacy }], [], []);

	expect(result.frontmatter).toEqual([]);
});

test("reports syntactically invalid frontmatter", () => {
	const invalid = "---\nname: broken\ndescription: [unterminated\n---\nBody";
	const result = checkMemory("", [{ slug: "broken", text: invalid }], [], []);

	expect(result.frontmatter.map(({ slug }) => slug)).toContain("broken");
});
test("reports an empty frontmatter name only once", () => {
	const result = checkMemory("", [
		{ slug: "empty-name", text: "---\nname: \"\"\ndescription: Note\n---\nBody" },
	], [], []);

	expect(result.frontmatter).toEqual([{ slug: "empty-name", reason: "no name" }]);
});

