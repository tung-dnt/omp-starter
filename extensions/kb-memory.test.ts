import { beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import kbMemory from "./kb-memory";
import { MEMORY_BLOCK_HEADER } from "./lib/memory-index";
import { HOME } from "./lib/state";
import { fakeContext, fakePi, initGitRepo, resetHome, seedKb, seedState, type FakeContext, type FakePi, type SeededKb } from "./test-harness";

beforeEach(resetHome);

const INDEX = [
	"## Global",
	"- [Everywhere rule](everywhere-rule.md) — applies to every repo",
	"",
	"## widgets",
	"- [Widget gotcha](widget-gotcha.md) — mind the flange",
	"",
	"## Billing",
	"<!-- repos: ledger, invoices -->",
	"- [Ledger rule](ledger-rule.md) — cents only",
	"",
	"## gadgets",
	"- [Gadget gotcha](gadget-gotcha.md) — gears slip",
	"",
].join("\n");

interface Fixture {
	kb: SeededKb;
	fake: FakePi;
	widgets: string;
	ledger: string;
	plain: string;
	/** System prompt after the extension ran for an agent in `cwd`; undefined = left untouched. */
	prompt(cwd: string, options?: { agent?: FakeContext["agent"]; sessionId?: string; systemPrompt?: string[] }): string[] | undefined;
}

function fixture(index: string | null = INDEX): Fixture {
	const kb = seedKb({ name: "work-kb", folder: path.join(HOME, "work"), index: index ?? undefined });
	seedState({ kb: { status: "done", sources: [kb.source] } });
	const widgets = path.join(kb.folder, "widgets");
	const ledger = path.join(kb.folder, "ledger-service");
	initGitRepo(widgets, "git@example.com:acme/widgets.git");
	initGitRepo(ledger, "git@example.com:acme/Ledger.git");
	const fake = fakePi();
	kbMemory(fake.pi);
	return {
		kb,
		fake,
		widgets,
		ledger,
		plain: kb.folder,
		prompt(cwd, { agent, sessionId, systemPrompt = ["base prompt"] } = {}) {
			const ctx = fakeContext({ cwd, agent, sessionId });
			const result = fake.emit("before_agent_start", { systemPrompt }, ctx) as { systemPrompt: string[] } | undefined;
			return result?.systemPrompt;
		},
	};
}

const block = (prompt: string[] | undefined): string => prompt?.at(-1) ?? "";

describe("the injected memory index", () => {
	test("holds Global and the section for the current repo, and only names the other scopes", () => {
		const f = fixture();
		const prompt = f.prompt(f.widgets);
		expect(prompt?.[0]).toBe("base prompt");
		const text = block(prompt);
		expect(text.startsWith(`${MEMORY_BLOCK_HEADER}\n`)).toBe(true);
		expect(text).toContain("Loaded scopes: Global, widgets.");
		expect(text).toContain("Other scopes (read the file when relevant): Billing (1), gadgets (1).");
		expect(text).toContain("- [Everywhere rule](everywhere-rule.md)");
		expect(text).toContain("- [Widget gotcha](widget-gotcha.md)");
		expect(text).not.toContain("ledger-rule.md");
		expect(text).not.toContain("gadget-gotcha.md");
	});

	test("a section listing the repo in `<!-- repos: … -->` is loaded, matching names without regard to case", () => {
		const f = fixture();
		const text = block(f.prompt(f.ledger));
		expect(text).toContain("Loaded scopes: Global, Billing.");
		expect(text).toContain("- [Ledger rule](ledger-rule.md)");
		expect(text).not.toContain("widget-gotcha.md");
	});

	test("outside a git repo only Global is loaded", () => {
		const f = fixture();
		const text = block(f.prompt(f.plain));
		expect(text).toContain("Loaded scopes: Global.");
		expect(text).toContain("Other scopes (read the file when relevant): widgets (1), Billing (1), gadgets (1).");
		expect(text).not.toContain("widget-gotcha.md");
	});

	test("nothing is injected when no knowledge base serves the folder", () => {
		const f = fixture();
		fs.mkdirSync(path.join(HOME, "unrelated"));
		expect(f.prompt(path.join(HOME, "unrelated"))).toBeUndefined();
	});

	test("nothing is injected without a set-up knowledge base, a memory index, or any notes", () => {
		const missing = fixture(null);
		expect(missing.prompt(missing.widgets)).toBeUndefined();

		resetHome();
		const empty = fixture("## Global\n");
		expect(empty.prompt(empty.widgets)).toBeUndefined();

		resetHome();
		const skipped = fixture();
		seedState({ kb: { status: "skipped" } });
		expect(skipped.prompt(skipped.widgets)).toBeUndefined();
	});

	test("an index that was already injected is not added again", () => {
		const f = fixture();
		const present = [`${MEMORY_BLOCK_HEADER}\nalready here`];
		expect(f.prompt(f.widgets, { systemPrompt: present })).toBeUndefined();
	});
});

describe("which agents get it", () => {
	test("the main agent, or a host that names no agent, gets the index", () => {
		const f = fixture();
		expect(block(f.prompt(f.widgets, { agent: { kind: "main", name: "main" } }))).toContain(MEMORY_BLOCK_HEADER);
		expect(block(f.prompt(f.widgets, { agent: undefined }))).toContain(MEMORY_BLOCK_HEADER);
	});

	test("subagents that write code get it, whatever the capitalisation of their name", () => {
		const f = fixture();
		for (const name of ["task", "Task-Builder", "test-engineer"]) {
			expect(block(f.prompt(f.widgets, { agent: { kind: "sub", name } }))).toContain(MEMORY_BLOCK_HEADER);
		}
	});

	test("read-only subagents do not", () => {
		const f = fixture();
		for (const name of ["scout", "code-reviewer", "sonic", "security-reviewer"]) {
			expect(f.prompt(f.widgets, { agent: { kind: "sub", name } })).toBeUndefined();
		}
	});
});

describe("the per-session snapshot", () => {
	test("edits to the index show up in the next session, not mid-session", () => {
		const f = fixture();
		expect(block(f.prompt(f.widgets))).not.toContain("fresh-note.md");
		fs.appendFileSync(f.kb.indexPath, "\n## widgets\n- [Fresh note](fresh-note.md) — new today\n");

		expect(block(f.prompt(f.widgets))).not.toContain("fresh-note.md");
		expect(block(f.prompt(f.widgets, { sessionId: "session-2" }))).toContain("fresh-note.md");
	});

	test("starting, switching to or shutting down a session drops its snapshot", () => {
		for (const event of ["session_start", "session_switch", "session_shutdown"]) {
			resetHome();
			const f = fixture();
			f.prompt(f.widgets);
			fs.appendFileSync(f.kb.indexPath, "\n## widgets\n- [Fresh note](fresh-note.md) — new today\n");
			f.fake.emit(event, {}, fakeContext({ cwd: f.widgets }));
			expect(block(f.prompt(f.widgets))).toContain("fresh-note.md");
		}
	});

	test("each folder of a session has its own snapshot", () => {
		const f = fixture();
		expect(block(f.prompt(f.widgets))).toContain("Loaded scopes: Global, widgets.");
		expect(block(f.prompt(f.ledger))).toContain("Loaded scopes: Global, Billing.");
	});

	test("an index that was missing when the session began stays unavailable for that session", () => {
		const f = fixture(null);
		expect(f.prompt(f.widgets)).toBeUndefined();
		fs.writeFileSync(f.kb.indexPath, INDEX);
		expect(f.prompt(f.widgets)).toBeUndefined();
		expect(block(f.prompt(f.widgets, { sessionId: "session-2" }))).toContain("widget-gotcha.md");
	});
});
