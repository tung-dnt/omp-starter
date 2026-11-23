import { beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import kbCommand from "./kb-command";
import { markKbWritten } from "./lib/kb-write-flag";
import { HOME } from "./lib/state";
import type { MemoryState } from "./lib/state";
import { fakeContext, fakePi, resetHome, scriptedUi, seedKb, seedState, type FakePi, type KbSpec, type Notification, type SeededKb } from "./test-harness";

beforeEach(resetHome);

interface Fixture {
	kb: SeededKb;
	fake: FakePi;
	/** Runs `/kb <args>` in `cwd` (default: the served folder) and returns what the user was shown. */
	kbCommand(args: string, cwd?: string): Promise<Notification[]>;
}

function fixture(spec: Partial<KbSpec> = {}, memory?: MemoryState): Fixture {
	const kb = seedKb({ name: "work-kb", folder: path.join(HOME, "work"), ...spec });
	seedState({ kb: { status: "done", sources: [kb.source] }, ...(memory ? { memory } : {}) });
	const fake = fakePi();
	kbCommand(fake.pi);
	return {
		kb,
		fake,
		async kbCommand(args, cwd = kb.folder) {
			const ui = scriptedUi();
			await fake.runCommand("kb", args, fakeContext({ cwd, ui }));
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
	test("is the default subcommand and names the knowledge base serving the folder and the vault it reads", async () => {
		const f = fixture();
		const shown = only(await f.kbCommand(""));
		expect(shown.type).toBe("info");
		for (const fact of ["Knowledge base ~/work-kb serves ~/work.", "Vault: ~/work-kb", "Memory: not set up", "Commit gate: off"]) {
			expect(shown.message).toContain(fact);
		}
		expect((await f.kbCommand("status"))[0].message).toBe(shown.message);
	});

	test("shows the memory backend, or that it is unknown and where to look", async () => {
		const set = fixture({}, { status: "done", backend: "mnemopi" });
		expect(only(await set.kbCommand("status")).message).toContain("Memory backend: mnemopi");
		const migrated = fixture({}, { status: "done", gateDirs: [path.join(HOME, "work")] });
		expect(only(await migrated.kbCommand("status")).message).toContain("Memory backend: unknown, see /settings → Memory");
	});

	test("shows the commit gate state, flipping once the session saves a memory or writes to the knowledge base", async () => {
		const f = fixture({}, { status: "done", backend: "hindsight", gateDirs: [path.join(HOME, "work")] });
		expect(only(await f.kbCommand("status")).message).toContain("Commit gate (~/work): blocks git commit until this session saves a memory or writes a note to the KB");
		markKbWritten();
		expect(only(await f.kbCommand("status")).message).toContain("Commit gate (~/work): satisfied, a memory or note was saved this session");
	});

	test("shows the memory backend even when no knowledge base serves the folder or none exists", async () => {
		const f = fixture({}, { status: "done", backend: "local" });
		fs.mkdirSync(path.join(HOME, "unrelated"));
		expect(only(await f.kbCommand("status", path.join(HOME, "unrelated"))).message).toContain("Memory backend: local");
		seedState({ memory: { status: "done", backend: "local" } });
		expect(only(await f.kbCommand("status")).message).toContain("Memory backend: local");
	});

	test("lists the other knowledge bases and what they serve", async () => {
		const f = fixture();
		const other = seedKb({ name: "personal-kb", folder: path.join(HOME, "personal") });
		seedState({ kb: { status: "done", sources: [f.kb.source, other.source] } });
		expect(only(await f.kbCommand("status")).message).toContain("Other knowledge bases: ~/personal-kb → ~/personal");
	});

	test("reports a vault that is not reachable", async () => {
		const f = fixture();
		fs.rmSync(f.kb.root, { recursive: true });
		expect(only(await f.kbCommand("status")).message).toContain(`Vault: ${f.kb.root} is not reachable`);
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

describe("unknown input", () => {
	test("the memory subcommands of earlier versions are unknown now, and nothing is written to the vault", async () => {
		const f = fixture();
		for (const args of ["search flange cracks", "scopes", "view widgets", "check", "remember something"]) {
			const shown = only(await f.kbCommand(args));
			expect(shown.type).toBe("warning");
			expect(shown.message).toContain(`Unknown /kb subcommand "${args.split(" ")[0]}"`);
			expect(shown.message).toContain("Usage: /kb [status]");
		}
		expect(fs.readdirSync(f.kb.root)).toEqual([]);
	});
});
