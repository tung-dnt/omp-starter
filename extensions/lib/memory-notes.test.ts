import { expect, test } from "bun:test";
import { findEntry, frontmatterDescription, indexLine, splitNote, updateNote, upsertIndex, yamlString } from "./memory-notes";

const INDEX = [
	"## Global",
	"- [A](a.md) — global a",
	"",
	"## PACO",
	"<!-- repos: paco24, paco-connect-fe -->",
	"- [P1](p1.md) — first",
	"- [P2](p2.md) — second",
	"",
	"## PACO tickets",
	"<!-- repos: -->",
	"",
	"## meme-app",
	"- [M](m.md) — meme",
	"",
].join("\n");

const line = (slug: string) => indexLine(slug, slug.toUpperCase(), `hook ${slug}`);

test("a new line goes after the last entry of the section that lists the repo", () => {
	const r = upsertIndex(INDEX, "new", line("new"), { repo: "paco-connect-fe" });
	expect(r).toMatchObject({ section: "PACO", action: "added", createdSection: false });
	const lines = r.text.split("\n");
	expect(lines.indexOf(line("new"))).toBe(lines.indexOf("- [P2](p2.md) — second") + 1);
});

test("a repo no section lists gets its own section; no repo means Global", () => {
	const repo = upsertIndex(INDEX, "x", line("x"), { repo: "brand-new" });
	expect(repo).toMatchObject({ section: "brand-new", createdSection: true });
	expect(repo.text.endsWith(`## brand-new\n${line("x")}\n`)).toBe(true);
	// A section with an empty repos list never matches a repo, even one equal to its heading.
	expect(upsertIndex(INDEX, "t", line("t"), { repo: "paco tickets" }).createdSection).toBe(true);

	const global = upsertIndex(INDEX, "g", line("g"), {});
	expect(global.section).toBe("Global");
	expect(global.text.split("\n")[2]).toBe(line("g"));
});

test("an explicit scope with no entries yet inserts after its repos comment", () => {
	const r = upsertIndex(INDEX, "t1", line("t1"), { scope: "paco tickets", repo: "paco24" });
	const lines = r.text.split("\n");
	expect(r.section).toBe("PACO tickets");
	expect(lines[lines.indexOf("<!-- repos: -->") + 1]).toBe(line("t1"));
});

test("an existing line is replaced in place without scope and moved with one", () => {
	const inPlace = upsertIndex(INDEX, "p1", "- [P1](p1.md) — changed", { repo: "meme-app" });
	expect(inPlace).toMatchObject({ section: "PACO", action: "updated" });
	expect(findEntry(inPlace.text, "p1")).toMatchObject({ section: "PACO", hook: "changed" });

	const moved = upsertIndex(INDEX, "p1", "- [P1](p1.md) — first", { scope: "Global" });
	expect(moved).toMatchObject({ section: "Global", action: "moved" });
	expect(moved.text.match(/\(p1\.md\)/g)).toHaveLength(1);
	expect(findEntry(moved.text, "p1")?.section).toBe("Global");
	expect(findEntry(moved.text, "p2")?.section).toBe("PACO");
});

test("lines before the first heading count as Global when there is no Global heading", () => {
	const r = upsertIndex("- [A](a.md) — a\n\n## X\n- [B](b.md) — b\n", "c", line("c"), { scope: "global" });
	expect(r.text.split("\n").slice(0, 2)).toEqual(["- [A](a.md) — a", line("c")]);
});

test("updating a note keeps unknown keys and its frontmatter shape", () => {
	const nested = [
		"---",
		"name: n",
		'description: "old: one"',
		"metadata:",
		"  node_type: memory",
		"  type: project",
		"  modified: 2026-01-01T00:00:00Z",
		"  originSessionId: abc",
		"---",
		"",
		"old body",
		"",
	].join("\n");
	const next = updateNote(nested, "n", { description: "new: two", type: "feedback", modified: "2026-10-27T00:00:00Z" });
	const { frontmatter, body } = splitNote(next);
	expect(frontmatter).toEqual([
		"name: n",
		'description: "new: two"',
		"metadata:",
		"  node_type: memory",
		"  type: feedback",
		"  modified: 2026-10-27T00:00:00Z",
		"  originSessionId: abc",
	]);
	expect(body).toBe("\nold body\n");
	expect(frontmatterDescription(frontmatter)).toBe("new: two");

	const flat = "---\nname: f\ndescription: d\ntype: user\n---\nbody\n";
	expect(splitNote(updateNote(flat, "f", { modified: "T", body: "fresh" })).frontmatter).toEqual([
		"name: f",
		"description: d",
		"type: user",
		"modified: T",
	]);
});

test("descriptions YAML would misread are quoted and read back unchanged", () => {
	for (const value of ['"how …" requests = plan', "a: b", "#tag", "yes", "plain words — dash"]) {
		expect(frontmatterDescription([`description: ${yamlString(value)}`])).toBe(value);
	}
	expect(yamlString("plain words — dash")).toBe("plain words — dash");
});
