import { beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import kbCommand from "./kb-command";
import kbMemory from "./kb-memory";
import { markKbWritten } from "./lib/kb-write-flag";
import { HOME } from "./lib/state";
import { fakeContext, fakePi, initGitRepo, memoryNote, resetHome, scriptedUi, seedKb, seedState, type FakePi, type KbSpec, type Notification, type SeededKb } from "./test-harness";

beforeEach(resetHome);

const INDEX = [
	"## Global",
	"- [Everywhere rule](everywhere-rule.md) — applies to every repo",
	"",
	"## widgets",
	"- [Widget gotcha](widget-gotcha.md) — mind the flange",
	"",
	"## gadgets",
	"- [Gadget gotcha](gadget-gotcha.md) — gears slip",
	"",
].join("\n");

const NOTES = {
	"everywhere-rule.md": memoryNote("everywhere-rule", "applies to every repo", "Always say hello."),
	"widget-gotcha.md": memoryNote("widget-gotcha", "mind the flange", "The flange cracks above 80 degrees."),
	"gadget-gotcha.md": memoryNote("gadget-gotcha", "gears slip", "Gears slip when wet."),
};

interface Fixture {
	kb: SeededKb;
	fake: FakePi;
	repo: string;
	/** Runs `/kb <args>` in `cwd` and returns what the user was shown. */
	kbCommand(args: string, cwd?: string, sessionId?: string): Promise<Notification[]>;
}

function fixture(spec: Partial<KbSpec> = {}): Fixture {
	const kb = seedKb({ name: "work-kb", folder: path.join(HOME, "work"), index: INDEX, notes: NOTES, ...spec });
	seedState({ kb: { status: "done", sources: [kb.source] } });
	const repo = path.join(kb.folder, "widgets");
	initGitRepo(repo, "https://example.com/acme/widgets.git");
	const fake = fakePi();
	kbCommand(fake.pi);
	return {
		kb,
		fake,
		repo,
		async kbCommand(args, cwd = repo, sessionId) {
			const ui = scriptedUi();
			await fake.runCommand("kb", args, fakeContext({ cwd, ui, sessionId }));
			return ui.notifications;
		},
	};
}

/** The single message of a one-notification result. */
function only(notifications: Notification[]): Notification {
	expect(notifications).toHaveLength(1);
	return notifications[0];
}

describe("/kb status", () => {
	test("is the default subcommand and describes the knowledge base serving the folder", async () => {
		const f = fixture();
		const shown = only(await f.kbCommand(""));
		expect(shown.type).toBe("info");
		for (const fact of ["~/work-kb serves ~/work", "Notes: 3", "Repo: widgets", "Global (1), widgets (1)", "gadgets (1)", "no memory snapshot", "Commit gate: off"]) {
			expect(shown.message).toContain(fact);
		}
		expect((await f.kbCommand("status"))[0].message).toBe(shown.message);
	});

	test("outside a git repo reports no repo and only Global eligible", async () => {
		const f = fixture();
		const { message } = only(await f.kbCommand("status", f.kb.folder));
		expect(message).toContain("Repo: none (not in a git repo)");
		expect(message).toContain("Eligible scopes on disk: Global (1)");
		expect(message).toContain("Other scopes: widgets (1), gadgets (1)");
	});

	test("shows the commit gate state, flipping once the session writes to the knowledge base", async () => {
		const f = fixture({ gate: true });
		expect(only(await f.kbCommand("status")).message).toContain("Commit gate (~/work): blocks git commit until this session writes to the KB");
		markKbWritten(f.kb.source.kbRef);
		expect(only(await f.kbCommand("status")).message).toContain("Commit gate (~/work): satisfied, KB written this session");
	});

	test("notices the snapshot a session prepared at its first prompt", async () => {
		const f = fixture();
		const memory = fakePi();
		kbMemory(memory.pi);
		memory.emit("before_agent_start", { systemPrompt: ["base"] }, fakeContext({ cwd: f.repo, sessionId: "s1" }));
		expect(only(await f.kbCommand("status", f.repo, "s1")).message).toContain("This session: memory snapshot prepared; /kb view shows it");
		expect(only(await f.kbCommand("status", f.repo, "s2")).message).toContain("no memory snapshot prepared yet");
	});

	test("lists the other knowledge bases and what they serve", async () => {
		const f = fixture();
		const other = seedKb({ name: "personal-kb", folder: path.join(HOME, "personal") });
		seedState({ kb: { status: "done", sources: [f.kb.source, other.source] } });
		expect(only(await f.kbCommand("status")).message).toContain("Other knowledge bases: ~/personal-kb → ~/personal");
	});

	test("reports sync duplicates and evicted notes, and an unreachable vault", async () => {
		const f = fixture();
		fs.writeFileSync(path.join(f.kb.memoryDir, "widget-gotcha 2.md"), "dup");
		fs.writeFileSync(path.join(f.kb.memoryDir, ".archived.md.icloud"), "");
		expect(only(await f.kbCommand("status")).message).toContain("Notes: 3 in ~/work-kb/_memory; 1 evicted to iCloud; 1 sync duplicate(s), see /kb check");

		fs.rmSync(f.kb.root, { recursive: true });
		const { message } = only(await f.kbCommand("status"));
		expect(message).toContain(`Vault: ${f.kb.root} is not reachable`);
		expect(message).toContain("is missing, so no memory index is injected");
	});

	test("says when the memory folder or its index does not exist yet", async () => {
		const f = fixture();
		fs.rmSync(f.kb.memoryDir, { recursive: true });
		const { message } = only(await f.kbCommand("status"));
		expect(message).toContain("Notes: ~/work-kb/_memory does not exist yet; kb_remember creates it");
		expect(message).toContain("Index: ~/work-kb/_memory/MEMORY.md is missing");
	});

	test("points to /starter kb before a knowledge base exists, and reports a folder nothing serves", async () => {
		const f = fixture();
		fs.mkdirSync(path.join(HOME, "unrelated"));
		const unserved = only(await f.kbCommand("status", path.join(HOME, "unrelated")));
		expect(unserved.type).toBe("error");
		expect(unserved.message).toContain("No knowledge base serves ~/unrelated (configured for: ~/work). Run /starter kb");

		seedState({});
		expect(only(await f.kbCommand("status")).message).toContain("No knowledge base is set up");
	});
});

describe("/kb search", () => {
	test("returns the matching notes with their section", async () => {
		const f = fixture();
		const shown = only(await f.kbCommand("search flange cracks"));
		expect(shown.type).toBe("info");
		expect(shown.message).toContain("1 note(s) match every word of \"flange cracks\"");
		expect(shown.message).toContain("widget-gotcha.md [widgets]");
		expect(shown.message).not.toContain("gadget-gotcha");
	});

	test("asks for words, and reports a query too short to search", async () => {
		const f = fixture();
		const bare = only(await f.kbCommand("search"));
		expect(bare.type).toBe("error");
		expect(bare.message).toContain("Usage: /kb search");
		expect(only(await f.kbCommand("search x")).message).toContain("at least one word");
	});
});

describe("/kb scopes", () => {
	test("marks the sections this repo loads", async () => {
		const f = fixture();
		const { message } = only(await f.kbCommand("scopes"));
		const lines = message.split("\n");
		expect(lines[0]).toContain("widgets");
		expect(lines.slice(1).map(l => l.split(" — ")[0])).toEqual(["● Global", "● widgets", "○ gadgets"]);
	});

	test("says so when the index is missing", async () => {
		const f = fixture();
		fs.rmSync(f.kb.indexPath);
		expect(only(await f.kbCommand("scopes")).message).toBe("~/work-kb/_memory/MEMORY.md is missing.");
	});
});

describe("/kb view", () => {
	test("previews the block from disk before the session has a snapshot", async () => {
		const f = fixture();
		const { message } = only(await f.kbCommand("view"));
		expect(message.startsWith("No session snapshot yet. Preview from disk:\n# Memory index\n")).toBe(true);
		expect(message).toContain("- [Widget gotcha](widget-gotcha.md)");
		expect(message).not.toContain("gadget-gotcha.md");
	});

	test("shows the block the session actually received, even after the index changed", async () => {
		const f = fixture();
		const memory = fakePi();
		kbMemory(memory.pi);
		memory.emit("before_agent_start", { systemPrompt: ["base"] }, fakeContext({ cwd: f.repo, sessionId: "s1" }));
		fs.writeFileSync(f.kb.indexPath, "## Global\n- [New](new.md) — new\n");
		const { message } = only(await f.kbCommand("view", f.repo, "s1"));
		expect(message.startsWith("# Memory index\n")).toBe(true);
		expect(message).toContain("widget-gotcha.md");
		expect(message).not.toContain("new.md");
	});

	test("one scope shows its current lines from disk, whatever the capitalisation", async () => {
		const f = fixture();
		const { message } = only(await f.kbCommand("view WIDGETS"));
		expect(message).toContain("- [Widget gotcha](widget-gotcha.md) — mind the flange");
		expect(message).not.toContain("everywhere-rule.md");
	});

	test("an unknown scope lists the scopes that exist", async () => {
		const f = fixture();
		const shown = only(await f.kbCommand("view nowhere"));
		expect(shown.type).toBe("error");
		expect(shown.message).toContain('No scope "nowhere"');
		expect(shown.message).toContain("Global, widgets, gadgets");
	});

	test("a scope view without an index says so", async () => {
		const f = fixture();
		fs.rmSync(f.kb.indexPath);
		expect(only(await f.kbCommand("view widgets")).message).toBe("~/work-kb/_memory/MEMORY.md is missing.");
	});
});

describe("/kb check", () => {
	test("reports agreement as information when index and notes match", async () => {
		const f = fixture();
		const shown = only(await f.kbCommand("check"));
		expect(shown.type).toBe("info");
		expect(shown.message).toContain("no problems found");
	});

	test("warns about every kind of drift it finds", async () => {
		const f = fixture();
		fs.rmSync(path.join(f.kb.memoryDir, "gadget-gotcha.md"));
		fs.writeFileSync(path.join(f.kb.memoryDir, "orphan.md"), memoryNote("orphan", "never indexed", "Body."));
		fs.writeFileSync(path.join(f.kb.memoryDir, "bare.md"), "no frontmatter here");
		fs.writeFileSync(path.join(f.kb.memoryDir, "everywhere-rule 2.md"), "dup");
		const shown = only(await f.kbCommand("check"));
		expect(shown.type).toBe("warning");
		expect(shown.message).toContain("5 problem(s).");
		expect(shown.message).toContain('gadget-gotcha.md under "## gadgets"');
		expect(shown.message).toContain("orphan.md");
		expect(shown.message).toContain("bare.md: no frontmatter");
		expect(shown.message).toContain("everywhere-rule 2.md");
	});

	test("warns when the index itself is missing", async () => {
		const f = fixture();
		fs.rmSync(f.kb.indexPath);
		const shown = only(await f.kbCommand("check"));
		expect(shown.type).toBe("warning");
		expect(shown.message).toContain("MEMORY.md is missing");
	});
});

describe("unknown input", () => {
	test("an unknown subcommand warns with the usage line and changes nothing", async () => {
		const f = fixture();
		const before = fs.readFileSync(f.kb.indexPath, "utf8");
		const shown = only(await f.kbCommand("remember something"));
		expect(shown.type).toBe("warning");
		expect(shown.message).toContain('Unknown /kb subcommand "remember"');
		expect(shown.message).toContain("Usage: /kb");
		expect(fs.readFileSync(f.kb.indexPath, "utf8")).toBe(before);
	});
});
