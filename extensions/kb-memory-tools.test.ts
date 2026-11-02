import { beforeEach, describe, expect, test } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import kbMemoryTools from "./kb-memory-tools";
import { kbWritten } from "./lib/kb-write-flag";
import { parseMemoryIndex } from "./lib/memory-index";
import { HOME } from "./lib/state";
import { fakeContext, fakePi, initGitRepo, memoryNote, resetHome, seedKb, seedState, type FakePi, type SeededKb } from "./test-harness";

beforeEach(resetHome);

const INDEX = [
	"## Global",
	"- [Existing preference](existing-preference.md) — applies everywhere",
	"",
	"## widgets",
	"- [Widget gotcha](widget-gotcha.md) — mind the flange",
	"",
].join("\n");

interface Fixture {
	kb: SeededKb;
	fake: FakePi;
	/** Session folder inside a repo whose origin is `acme/widgets`. */
	repo: string;
	/** Session folder served by the knowledge base, outside any git repo. */
	plain: string;
	ctx(cwd?: string): ReturnType<typeof fakeContext>;
	/** Lines under `## <section>` of the index on disk. */
	section(name: string): string[];
	read(file: string): string;
}

function fixture(index: string | null = INDEX): Fixture {
	const kb = seedKb({
		name: "work-kb",
		folder: path.join(HOME, "work"),
		index: index ?? undefined,
		notes: {
			"existing-preference.md": memoryNote("existing-preference", "applies everywhere", "Always say hello. **Why:** polite."),
			"widget-gotcha.md": memoryNote("widget-gotcha", "mind the flange", "The flange cracks above 80 degrees."),
		},
	});
	seedState({ kb: { status: "done", sources: [kb.source] } });
	const repo = path.join(kb.folder, "widgets");
	initGitRepo(repo, "https://example.com/acme/widgets.git");
	const fake = fakePi();
	kbMemoryTools(fake.pi);
	return {
		kb,
		fake,
		repo,
		plain: kb.folder,
		ctx: (cwd = repo) => fakeContext({ cwd }),
		section: name => {
			const body = parseMemoryIndex(fs.readFileSync(kb.indexPath, "utf8")).find(s => s.name === name)?.body ?? "";
			return body.split("\n").filter(l => l.startsWith("- ["));
		},
		read: file => fs.readFileSync(path.join(kb.memoryDir, file), "utf8"),
	};
}

const created = { mode: "create", slug: "retry-budget", title: "Retry budget", description: "Three retries, then fail", type: "feedback", body: "Retry three times. **Why:** the API is flaky." } as const;

describe("tool registration", () => {
	test("registers kb_remember and kb_recall once a knowledge base is set up", () => {
		const f = fixture();
		expect([...f.fake.tools.keys()].sort()).toEqual(["kb_recall", "kb_remember"]);
	});

	test("registers nothing before setup or after a skipped setup", () => {
		for (const state of [{}, { kb: { status: "skipped" as const } }]) {
			seedState(state);
			const fake = fakePi();
			kbMemoryTools(fake.pi);
			expect(fake.tools.size).toBe(0);
		}
	});
});

describe("kb_remember create", () => {
	test("writes the note with frontmatter and indexes it under the section naming the current repo", async () => {
		const f = fixture();
		const result = await f.fake.callTool("kb_remember", { ...created }, f.ctx());

		const note = f.read("retry-budget.md");
		expect(note).toMatch(/^---\nname: retry-budget\n/);
		expect(note).toContain("description: Three retries, then fail");
		expect(note).toContain("  node_type: memory\n  type: feedback\n  modified: ");
		expect(note).toContain("Retry three times. **Why:** the API is flaky.");
		expect(f.section("widgets")).toEqual([
			"- [Widget gotcha](widget-gotcha.md) — mind the flange",
			"- [Retry budget](retry-budget.md) — Three retries, then fail",
		]);
		expect(f.section("Global")).toEqual(["- [Existing preference](existing-preference.md) — applies everywhere"]);
		expect(result.text).toContain("Created");
		expect(result.text).toContain('under "## widgets"');
		expect(result.details).toEqual({ kbRef: f.kb.source.kbRef });
	});

	test("counts as a knowledge-base write for the commit gate", async () => {
		const f = fixture();
		expect(kbWritten(f.kb.source.kbRef)).toBe(false);
		await f.fake.callTool("kb_remember", { ...created }, f.ctx());
		expect(kbWritten(f.kb.source.kbRef)).toBe(true);
	});

	test("starts a `## <repo>` section when no section names the repo", async () => {
		const f = fixture("## Global\n- [Existing preference](existing-preference.md) — applies everywhere\n");
		const result = await f.fake.callTool("kb_remember", { ...created }, f.ctx());
		expect(f.section("widgets")).toEqual(["- [Retry budget](retry-budget.md) — Three retries, then fail"]);
		expect(result.text).toContain("(new section)");
	});

	test("files the note under Global outside a git repo, and creates the index when it is missing", async () => {
		const f = fixture(null);
		await f.fake.callTool("kb_remember", { ...created }, f.ctx(f.plain));
		expect(f.section("Global")).toEqual(["- [Retry budget](retry-budget.md) — Three retries, then fail"]);
	});

	test("an explicit scope and hook override the repo section and the description", async () => {
		const f = fixture();
		await f.fake.callTool("kb_remember", { ...created, scope: "Global", hook: "retry three times" }, f.ctx());
		expect(f.section("Global")).toContain("- [Retry budget](retry-budget.md) — retry three times");
		expect(f.section("widgets")).toHaveLength(1);
	});

	test("keeps the index free of duplicate lines when two sessions save at once", async () => {
		const f = fixture();
		const other = { ...created, slug: "second-note", title: "Second note", description: "Another fact" };
		await Promise.all([f.fake.callTool("kb_remember", { ...created }, f.ctx()), f.fake.callTool("kb_remember", other, f.ctx())]);
		const lines = f.section("widgets");
		expect(lines).toHaveLength(3);
		expect(lines.filter(l => l.includes("(retry-budget.md)"))).toHaveLength(1);
		expect(lines.filter(l => l.includes("(second-note.md)"))).toHaveLength(1);
	});

	test("takes over the index lock of a writer that crashed long ago", async () => {
		const f = fixture();
		const key = crypto.createHash("sha1").update(fs.realpathSync(f.kb.indexPath)).digest("hex").slice(0, 16);
		const lock = path.join(os.tmpdir(), `omp-starter-kb-${key}.lock`);
		fs.writeFileSync(lock, "99999999");
		const old = new Date(Date.now() - 120_000);
		fs.utimesSync(lock, old, old);
		await f.fake.callTool("kb_remember", { ...created }, f.ctx());
		expect(f.section("widgets")).toHaveLength(2);
		expect(fs.existsSync(lock)).toBe(false);
	});
});

describe("kb_remember update", () => {
	test("replaces only the given fields, keeps other frontmatter and does not duplicate the index line", async () => {
		const f = fixture();
		fs.writeFileSync(
			path.join(f.kb.memoryDir, "widget-gotcha.md"),
			"---\nname: widget-gotcha\ndescription: mind the flange\nowner: tung\nmetadata:\n  node_type: memory\n  type: project\n  modified: 2020-01-01T00:00:00.000Z\n---\n\nOld body.\n",
		);
		const result = await f.fake.callTool("kb_remember", { mode: "update", slug: "widget-gotcha", body: "New body.", type: "reference" }, f.ctx());

		const note = f.read("widget-gotcha.md");
		expect(note).toContain("owner: tung");
		expect(note).toContain("description: mind the flange");
		expect(note).toContain("  type: reference");
		expect(note).not.toContain("2020-01-01");
		expect(note).toContain("New body.");
		expect(note).not.toContain("Old body.");
		expect(f.section("widgets")).toEqual(["- [Widget gotcha](widget-gotcha.md) — mind the flange"]);
		expect(result.text).toContain("Updated");
		expect(result.text).toContain('index line unchanged under "## widgets"');
	});

	test("a new title or hook rewrites the existing line in place", async () => {
		const f = fixture();
		await f.fake.callTool("kb_remember", { mode: "update", slug: "widget-gotcha", title: "Flange gotcha", hook: "cracks hot" }, f.ctx());
		expect(f.section("widgets")).toEqual(["- [Flange gotcha](widget-gotcha.md) — cracks hot"]);
	});

	test("a new description changes the note but keeps the line's existing hook", async () => {
		const f = fixture();
		await f.fake.callTool("kb_remember", { mode: "update", slug: "widget-gotcha", title: "Widget gotcha", description: "flange limit" }, f.ctx());
		expect(f.section("widgets")).toEqual(["- [Widget gotcha](widget-gotcha.md) — mind the flange"]);
		expect(f.read("widget-gotcha.md")).toContain("description: flange limit");
	});

	test("a new scope moves the line without leaving a copy behind", async () => {
		const f = fixture();
		const result = await f.fake.callTool("kb_remember", { mode: "update", slug: "widget-gotcha", scope: "Global" }, f.ctx());
		expect(f.section("widgets")).toEqual([]);
		expect(f.section("Global")).toContain("- [Widget gotcha](widget-gotcha.md) — mind the flange");
		expect(result.text).toContain("moved");
	});

	test("a note that was never indexed gets its line once a title is passed", async () => {
		const f = fixture();
		fs.writeFileSync(path.join(f.kb.memoryDir, "loose.md"), memoryNote("loose", "a loose note", "Body."));
		await expect(f.fake.callTool("kb_remember", { mode: "update", slug: "loose", body: "Changed." }, f.ctx())).rejects.toThrow("pass title");
		await f.fake.callTool("kb_remember", { mode: "update", slug: "loose", title: "Loose note" }, f.ctx());
		expect(f.section("widgets")).toContain("- [Loose note](loose.md) — a loose note");
	});
});

describe("kb_remember rejects bad requests without writing", () => {
	const cases: [string, Record<string, unknown>, string][] = [
		["a slug with a path or extension", { ...created, slug: "../escape.md" }, "slug"],
		["an existing note in create mode", { ...created, slug: "widget-gotcha" }, "already exists"],
		["create without its required fields", { mode: "create", slug: "bare" }, "needs title, description, type, body"],
		["a title containing a closing bracket", { ...created, title: "Bad ] title" }, "must not contain"],
		["a multi-line description", { ...created, description: "one\ntwo" }, "single line"],
		["an empty hook", { ...created, hook: "  " }, "must not be empty"],
		["an empty body", { ...created, body: "  " }, "body must not be empty"],
		["updating a note that does not exist", { mode: "update", slug: "ghost", body: "x" }, "does not exist"],
		["an update that changes nothing", { mode: "update", slug: "widget-gotcha" }, "at least one of"],
	];
	for (const [name, params, message] of cases) {
		test(name, async () => {
			const f = fixture();
			const before = fs.readdirSync(f.kb.memoryDir).sort();
			const index = fs.readFileSync(f.kb.indexPath, "utf8");
			await expect(f.fake.callTool("kb_remember", params, f.ctx())).rejects.toThrow(message);
			expect(fs.readdirSync(f.kb.memoryDir).sort()).toEqual(before);
			expect(fs.readFileSync(f.kb.indexPath, "utf8")).toBe(index);
			expect(kbWritten(f.kb.source.kbRef)).toBe(false);
		});
	}

	test("a note evicted to iCloud must be downloaded first", async () => {
		const f = fixture();
		fs.writeFileSync(path.join(f.kb.memoryDir, ".retry-budget.md.icloud"), "");
		await expect(f.fake.callTool("kb_remember", { ...created }, f.ctx())).rejects.toThrow("evicted to iCloud");
	});

	test("a folder no knowledge base serves", async () => {
		const f = fixture();
		fs.mkdirSync(path.join(HOME, "unrelated"));
		await expect(f.fake.callTool("kb_remember", { ...created }, f.ctx(path.join(HOME, "unrelated")))).rejects.toThrow("No knowledge base serves ~/unrelated (configured for: ~/work)");
	});
});

describe("kb_recall", () => {
	test("finds notes by words in the name, description or body, best match first, with their section", async () => {
		const f = fixture();
		const result = await f.fake.callTool("kb_recall", { query: "flange cracks" }, f.ctx());
		expect(result.text).toContain("1 note(s) match every word");
		expect(result.text).toContain("widget-gotcha.md [widgets] (2/2 terms) — mind the flange");
		expect(result.text).toContain("> The flange cracks above 80 degrees.");
		expect(result.text).not.toContain("existing-preference");
	});

	test("lists notes matching only some words after those matching all", async () => {
		const f = fixture();
		const result = await f.fake.callTool("kb_recall", { query: "flange hello" }, f.ctx());
		expect(result.text).toContain("0 note(s) match every word of \"flange hello\" and 2 match some");
		expect(result.text.indexOf("widget-gotcha")).toBeGreaterThan(0);
		expect(result.text.indexOf("existing-preference")).toBeGreaterThan(0);
	});

	test("scope limits the search to one index section", async () => {
		const f = fixture();
		const result = await f.fake.callTool("kb_recall", { query: "flange hello", scope: "Global" }, f.ctx());
		expect(result.text).toContain('(within "## Global")');
		expect(result.text).toContain("existing-preference.md [Global]");
		expect(result.text).not.toContain("widget-gotcha");
	});

	test("a note saved with kb_remember is found at once", async () => {
		const f = fixture();
		await f.fake.callTool("kb_remember", { ...created }, f.ctx());
		const result = await f.fake.callTool("kb_recall", { query: "retry flaky" }, f.ctx());
		expect(result.text).toContain("retry-budget.md [widgets] (2/2 terms)");
	});

	test("limit caps the hits and says so", async () => {
		const f = fixture();
		const result = await f.fake.callTool("kb_recall", { query: "flange hello", limit: 1 }, f.ctx());
		expect(result.text).toContain("showing the best 1");
		expect(result.text.match(/^- /gm)).toHaveLength(1);
	});

	test("no match says so without listing anything, and notes evicted to iCloud are reported", async () => {
		const f = fixture();
		fs.writeFileSync(path.join(f.kb.memoryDir, ".hidden-note.md.icloud"), "");
		const result = await f.fake.callTool("kb_recall", { query: "zeppelin" }, f.ctx());
		expect(result.text).toContain('0 note(s) match every word of "zeppelin" and 0 match some');
		expect(result.text).toContain("1 note(s) evicted to iCloud were not searched");
		expect(result.text).not.toContain("\n- ");
	});

	test("a query with no usable word is rejected", async () => {
		const f = fixture();
		await expect(f.fake.callTool("kb_recall", { query: "a ?" }, f.ctx())).rejects.toThrow("at least one word");
	});

	test("does not write anything, so the commit gate stays closed", async () => {
		const f = fixture();
		await f.fake.callTool("kb_recall", { query: "flange" }, f.ctx());
		expect(kbWritten(f.kb.source.kbRef)).toBe(false);
	});
});
