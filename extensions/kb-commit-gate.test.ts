import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import kbCommitGate from "./kb-commit-gate";
import { type FakePi, fakeContext, fakePi, resetHome, seedKb, seedState, type SeededKb } from "./test-harness";
import { HOME, type KbSource, type MemoryBackend, type MemoryState } from "./lib/state";

beforeEach(resetHome);

/** A file inside `kb`'s root, the way a note or project page is written. */
const note = (kb: SeededKb): string => path.join(kb.root, "projects", "fact.md");

interface Verdict {
	block: boolean;
	reason: string;
}

interface Gate {
	fake: FakePi;
	work: SeededKb;
	personal: SeededKb;
	/** Outcome of running `command` as an agent bash call; undefined = allowed. */
	commit(command: string, options?: { cwd?: string; input?: Record<string, unknown> }): Verdict | undefined;
	write(toolName: "write" | "edit", input: Record<string, unknown>, options?: { cwd?: string; isError?: boolean }): void;
	/** The result of a tool call whose input names no file, as a memory tool's does. */
	result(toolName: string, options?: { isError?: boolean }): void;
}

interface GateOptions {
	sources?: (work: SeededKb, personal: SeededKb) => KbSource[];
	memory?: Partial<MemoryState>;
}

/** Two knowledge bases, `work-kb` serving ~/work and `personal-kb` serving ~/personal; the commit gate covers both folders. */
function gate({ sources, memory }: GateOptions = {}): Gate {
	const work = seedKb({ name: "work-kb", folder: path.join(HOME, "work") });
	const personal = seedKb({ name: "personal-kb", folder: path.join(HOME, "personal") });
	seedState({
		memory: { status: "done", backend: "hindsight", gateDirs: [work.folder, personal.folder], ...memory },
		kb: { status: "done", sources: sources ? sources(work, personal) : [work.source, personal.source] },
	});
	const fake = fakePi();
	kbCommitGate(fake.pi);
	fs.mkdirSync(path.join(work.folder, "repo"), { recursive: true });
	fs.mkdirSync(path.join(HOME, "elsewhere"), { recursive: true });
	return {
		fake,
		work,
		personal,
		commit(command, { cwd = path.join(work.folder, "repo"), input = {} } = {}) {
			const ctx = fakeContext({ cwd, agent: { kind: "main", name: "main" } });
			return fake.emit("tool_call", { toolName: "bash", input: { command, ...input } }, ctx) as Verdict | undefined;
		},
		write(toolName, input, { cwd = path.join(work.folder, "repo"), isError = false } = {}) {
			fake.emit("tool_result", { toolName, isError, input }, fakeContext({ cwd }));
		},
		result(toolName, { isError = false } = {}) {
			fake.emit("tool_result", { toolName, isError, input: { items: [{ content: "a durable fact" }] } }, fakeContext({ cwd: path.join(work.folder, "repo") }));
		},
	};
}

describe("git commit under a gated folder", () => {
	test("is blocked until a file in a knowledge base is written, naming the memory tools and the knowledge bases", () => {
		const g = gate();
		const blocked = g.commit('git commit -m "feat: add thing"');
		expect(blocked?.block).toBe(true);
		expect(blocked?.reason).toContain(g.work.source.kbRef);
		expect(blocked?.reason).toContain(g.personal.source.kbRef);
		expect(blocked?.reason).toContain("[skip-mem]");
		expect(blocked?.reason).toContain("`retain` or `learn`");

		g.write("write", { path: note(g.work) });
		expect(g.commit('git commit -m "feat: add thing"')).toBeUndefined();
	});

	test("ignores writes that failed, that miss the knowledge base, or that use other tools", () => {
		const g = gate();
		g.write("write", { path: note(g.work) }, { isError: true });
		g.write("write", { path: path.join(g.work.folder, "repo", "src.ts") });
		g.fake.emit("tool_result", { toolName: "read", isError: false, input: { path: note(g.work) } }, fakeContext({ cwd: g.work.folder }));
		g.fake.emit("tool_result", { toolName: "bash", isError: false, input: { command: `echo x > ${note(g.work)}` } }, fakeContext({ cwd: g.work.folder }));
		expect(g.commit("git commit -m wip")?.block).toBe(true);
	});

	test("a note in any configured knowledge base satisfies the gate of every folder", () => {
		const g = gate();
		g.write("write", { path: note(g.personal) });
		expect(g.commit("git commit -m wip")).toBeUndefined();
		expect(g.commit("git commit -m wip", { cwd: g.personal.folder })).toBeUndefined();
	});

	test("[skip-mem] anywhere in the command lets the commit through", () => {
		const g = gate();
		expect(g.commit('git commit -m "fix typo [skip-mem]"')).toBeUndefined();
		expect(g.commit("git commit -m typo # [skip-mem]")).toBeUndefined();
	});

	test("counts edits named in a hashline payload, a move destination and an apply_patch header", () => {
		for (const input of [
			`[${path.join("KB", "projects", "a.md")}#1A2B]\nPUT 1.=1:\n+x`,
			`MV ${path.join("KB", "projects", "moved.md")}`,
			`*** Update File: ${path.join("KB", "projects", "a.md")}\n@@\n-a\n+b`,
			`*** Move to: ${path.join("KB", "projects", "moved.md")}`,
		]) {
			resetHome();
			const g = gate();
			g.write("edit", { input: input.replaceAll("KB", g.work.root) });
			expect(g.commit("git commit -m wip")).toBeUndefined();
		}
	});

	test("counts a vault:// write as a write to the vault", () => {
		const g = gate();
		g.write("write", { path: "vault://projects/fact.md" });
		expect(g.commit("git commit -m wip")).toBeUndefined();
	});

	test("a vault:// write counts for nothing when no knowledge base is configured", () => {
		const g = gate({ sources: () => [] });
		g.write("write", { path: "vault://projects/fact.md" });
		g.result("recall");
		expect(g.commit("git commit -m wip")?.block).toBe(true);
	});

	test("counts a relative path, resolved against the session folder", () => {
		const g = gate();
		g.write("write", { path: "../../work-kb/projects/fact.md" });
		expect(g.commit("git commit -m wip")).toBeUndefined();
	});

	test("a failed write result for a vault:// path does not count", () => {
		const g = gate();
		g.write("write", { path: "vault://projects/fact.md" }, { isError: true });
		expect(g.commit("git commit -m wip")?.block).toBe(true);
	});
});

describe("saving a memory", () => {
	test("a successful retain, learn or memory_edit result lets the commit through", () => {
		for (const tool of ["retain", "learn", "memory_edit"]) {
			resetHome();
			const g = gate();
			expect(g.commit("git commit -m wip")?.block).toBe(true);
			g.result(tool);
			expect(g.commit("git commit -m wip")).toBeUndefined();
		}
	});

	test("one memory write satisfies every gated folder, since they share one memory", () => {
		const g = gate();
		g.result("retain");
		expect(g.commit("git commit -m wip")).toBeUndefined();
		expect(g.commit("git commit -m wip", { cwd: g.personal.folder })).toBeUndefined();
	});

	test("a retain that failed does not count", () => {
		const g = gate();
		g.result("retain", { isError: true });
		expect(g.commit("git commit -m wip")?.block).toBe(true);
	});

	test("other tools do not count, nor do the memory tools that only read", () => {
		const g = gate();
		for (const tool of ["recall", "reflect", "read", "bash", "todo", "task"]) g.result(tool);
		expect(g.commit("git commit -m wip")?.block).toBe(true);
	});

	test("a retain called through xd:// counts by its own result: the outer write names no knowledge-base file", () => {
		const g = gate();
		g.write("write", { path: "xd://retain", content: JSON.stringify({ items: [{ content: "a durable fact" }] }) });
		expect(g.commit("git commit -m wip")?.block).toBe(true);
		g.result("retain");
		expect(g.commit("git commit -m wip")).toBeUndefined();
	});
});

describe("which folder the commit runs in", () => {
	test("`cd <dir> &&` moves the commit into a gated folder, or out of it", () => {
		const g = gate();
		expect(g.commit(`cd ${g.work.folder}/repo && git commit -m wip`, { cwd: path.join(HOME, "elsewhere") })?.block).toBe(true);
		expect(g.commit(`cd "${path.join(HOME, "elsewhere")}" && git commit -m wip`)).toBeUndefined();
		expect(g.commit("cd ../../elsewhere && git commit -m wip")).toBeUndefined();
	});

	test("`git -C <dir>` and the bash `cwd` argument pick the gated folder, relative to where each applies", () => {
		const g = gate();
		expect(g.commit(`git -C ${g.personal.folder} commit -m wip`, { cwd: path.join(HOME, "elsewhere") })?.block).toBe(true);
		expect(g.commit("git -C ../work/repo commit -m wip", { cwd: path.join(HOME, "elsewhere") })?.block).toBe(true);
		expect(g.commit("git commit -m wip", { cwd: path.join(HOME, "elsewhere"), input: { cwd: g.work.folder } })?.block).toBe(true);
		expect(g.commit(`git -C ${HOME}/elsewhere commit -m wip`)).toBeUndefined();
	});

	test("~ in a path expands to the home directory", () => {
		const g = gate();
		expect(g.commit("git -C ~/personal commit -m wip", { cwd: path.join(HOME, "elsewhere") })?.block).toBe(true);
	});

	test("commits outside every gated folder pass", () => {
		const g = gate();
		expect(g.commit("git commit -m wip", { cwd: path.join(HOME, "elsewhere") })).toBeUndefined();
	});
});

describe("what counts as a commit", () => {
	test("git global options before `commit` still gate it", () => {
		const g = gate();
		for (const command of ["git -c user.name=ci commit -m x", "git --no-pager commit -m x", "git -C . commit --amend", "make && git commit -m x", "git commit"]) {
			expect(g.commit(command)?.block).toBe(true);
		}
	});

	test("other git commands and mentions of the word commit pass", () => {
		const g = gate();
		for (const command of ["git status", "git log --grep commit", "git commit-tree HEAD^{tree}", "bun test"]) {
			expect(g.commit(command)).toBeUndefined();
		}
	});

	test("only bash calls are gated", () => {
		const g = gate();
		const ctx = fakeContext({ cwd: path.join(g.work.folder, "repo") });
		expect(g.fake.emit("tool_call", { toolName: "write", input: { command: "git commit -m wip" } }, ctx)).toBeUndefined();
	});
});

describe("what the block message names", () => {
	test("the write tools of the memory backend", () => {
		const names = (backend: MemoryBackend | undefined) => gate({ memory: { backend } }).commit("git commit -m wip")?.reason ?? "";
		expect(names("mnemopi")).toContain("`retain`, `learn` or `memory_edit`");
		expect(names("local")).toContain("a successful `learn`");
		expect(names(undefined)).toContain("a successful memory tool call such as `retain` or `learn`");
	});

	test("only the knowledge bases when the backend has no write tool", () => {
		for (const backend of ["off", "sharpshooter"] as const) {
			resetHome();
			const reason = gate({ memory: { backend } }).commit("git commit -m wip")?.reason ?? "";
			expect(reason).toContain("a `write` or `edit` of a note under");
			expect(reason).not.toContain("retain");
		}
	});
});

describe("when the gate does not apply", () => {
	test("no gate folders never block", () => {
		for (const gateDirs of [undefined, []]) {
			resetHome();
			expect(gate({ memory: { gateDirs } }).commit("git commit -m wip")).toBeUndefined();
		}
	});

	test("a backend with no write tool and no knowledge base leaves nothing to satisfy the gate, so it never blocks", () => {
		const g = gate({ memory: { backend: "sharpshooter" }, sources: () => [] });
		expect(g.commit("git commit -m wip")).toBeUndefined();
	});

	test("skipped or missing memory setup never blocks", () => {
		const skipped = gate();
		seedState({ memory: { status: "skipped", gateDirs: [skipped.work.folder] } });
		expect(skipped.commit("git commit -m wip")).toBeUndefined();
		seedState({});
		expect(skipped.commit("git commit -m wip")).toBeUndefined();
	});

	test("0.39 state, with the gate on a knowledge-base source, is migrated and keeps blocking", () => {
		const g = gate();
		seedState({ kb: { status: "done", sources: [{ ...g.work.source, gateDir: g.work.folder }] } } as never);
		expect(g.commit("git commit -m wip")?.block).toBe(true);
		expect(g.commit("git commit -m wip", { cwd: path.join(HOME, "elsewhere") })).toBeUndefined();
	});
});

describe("unattended builds", () => {
	afterEach(() => {
		delete process.env.OMP_STARTER_UNATTENDED;
	});

	test("OMP_STARTER_UNATTENDED=1 lets every commit through, under every gated folder, and the gate is back without it", () => {
		const g = gate();
		expect(g.commit("git commit -m wip")?.block).toBe(true);

		process.env.OMP_STARTER_UNATTENDED = "1";
		expect(g.commit("git commit -m wip")).toBeUndefined();
		expect(g.commit("git commit -m wip", { cwd: g.personal.folder })).toBeUndefined();

		delete process.env.OMP_STARTER_UNATTENDED;
		expect(g.commit("git commit -m wip")?.block).toBe(true);
	});

	test("only the exact value 1 switches the gate off", () => {
		const g = gate();
		for (const value of ["0", "true", "", " 1"]) {
			process.env.OMP_STARTER_UNATTENDED = value;
			expect(g.commit("git commit -m wip")?.block).toBe(true);
		}
	});
});

describe("when the write flag resets", () => {
	test("a new main session or a session switch asks for a fresh save", () => {
		for (const event of ["session_start", "session_switch"]) {
			const g = gate();
			g.write("write", { path: note(g.work) });
			expect(g.commit("git commit -m wip")).toBeUndefined();
			g.fake.emit(event, {}, fakeContext({ cwd: g.work.folder, agent: { kind: "main", name: "main" } }));
			expect(g.commit("git commit -m wip")?.block).toBe(true);
		}
	});

	test("a saved memory is forgotten at a new main session, like a knowledge-base write", () => {
		const g = gate();
		g.result("retain");
		expect(g.commit("git commit -m wip")).toBeUndefined();
		g.fake.emit("session_start", {}, fakeContext({ cwd: g.work.folder, agent: { kind: "main", name: "main" } }));
		expect(g.commit("git commit -m wip")?.block).toBe(true);
	});

	test("a subagent starting does not reset what its parent already wrote", () => {
		for (const event of ["session_start", "session_switch"]) {
			const g = gate();
			g.write("write", { path: note(g.work) });
			g.fake.emit(event, {}, fakeContext({ cwd: g.work.folder, agent: { kind: "sub", name: "task" } }));
			expect(g.commit("git commit -m wip")).toBeUndefined();
		}
	});

	test("a subagent's KB write satisfies its parent's commit", () => {
		const g = gate();
		g.fake.emit("session_start", {}, fakeContext({ cwd: g.work.folder, agent: { kind: "sub", name: "task" } }));
		g.fake.emit("tool_result", { toolName: "write", isError: false, input: { path: note(g.work) } }, fakeContext({ cwd: g.work.folder, agent: { kind: "sub", name: "task" } }));
		expect(g.commit("git commit -m wip")).toBeUndefined();
	});
});
