import { beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import kbCommitGate from "./kb-commit-gate";
import { type FakePi, fakeContext, fakePi, resetHome, seedKb, seedState, type SeededKb } from "./test-harness";
import { HOME, type KbSource } from "./lib/state";

beforeEach(resetHome);

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
}

/** Two gated knowledge bases: `work-kb` serves ~/work, `personal-kb` serves ~/personal. */
function gate(sources?: (work: SeededKb, personal: SeededKb) => KbSource[]): Gate {
	const work = seedKb({ name: "work-kb", folder: path.join(HOME, "work"), gate: true });
	const personal = seedKb({ name: "personal-kb", folder: path.join(HOME, "personal"), gate: true });
	seedState({ kb: { status: "done", sources: sources ? sources(work, personal) : [work.source, personal.source] } });
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
	};
}

describe("git commit under a gated folder", () => {
	test("is blocked until a file in the serving knowledge base is written, naming that knowledge base", () => {
		const g = gate();
		const blocked = g.commit('git commit -m "feat: add thing"');
		expect(blocked?.block).toBe(true);
		expect(blocked?.reason).toContain(g.work.source.kbRef);
		expect(blocked?.reason).toContain("[skip-mem]");

		g.write("write", { path: path.join(g.work.memoryDir, "fact.md") });
		expect(g.commit('git commit -m "feat: add thing"')).toBeUndefined();
	});

	test("ignores writes that failed, that miss the knowledge base, or that use other tools", () => {
		const g = gate();
		g.write("write", { path: path.join(g.work.memoryDir, "fact.md") }, { isError: true });
		g.write("write", { path: path.join(g.work.folder, "repo", "src.ts") });
		g.fake.emit("tool_result", { toolName: "read", isError: false, input: { path: path.join(g.work.memoryDir, "fact.md") } }, fakeContext({ cwd: g.work.folder }));
		g.fake.emit("tool_result", { toolName: "bash", isError: false, input: { command: `echo x > ${g.work.memoryDir}/fact.md` } }, fakeContext({ cwd: g.work.folder }));
		expect(g.commit("git commit -m wip")?.block).toBe(true);
	});

	test("a write into another knowledge base does not satisfy this one", () => {
		const g = gate();
		g.write("write", { path: path.join(g.personal.memoryDir, "fact.md") });
		expect(g.commit("git commit -m wip")?.block).toBe(true);
		expect(g.commit("git commit -m wip", { cwd: g.personal.folder })).toBeUndefined();
	});

	test("[skip-mem] anywhere in the command lets the commit through", () => {
		const g = gate();
		expect(g.commit('git commit -m "fix typo [skip-mem]"')).toBeUndefined();
		expect(g.commit("git commit -m typo # [skip-mem]")).toBeUndefined();
	});

	test("counts edits named in a hashline payload, a move destination and an apply_patch header", () => {
		for (const input of [
			`[${path.join("KB", "_memory", "a.md")}#1A2B]\nPUT 1.=1:\n+x`,
			`MV ${path.join("KB", "_memory", "moved.md")}`,
			`*** Update File: ${path.join("KB", "_memory", "a.md")}\n@@\n-a\n+b`,
			`*** Move to: ${path.join("KB", "_memory", "moved.md")}`,
		]) {
			resetHome();
			const g = gate();
			g.write("edit", { input: input.replaceAll("KB", g.work.root) });
			expect(g.commit("git commit -m wip")).toBeUndefined();
		}
	});

	test("counts a vault:// write as a write to the knowledge base serving the session folder", () => {
		const g = gate();
		g.write("write", { path: "vault://_memory/fact.md" });
		expect(g.commit("git commit -m wip")).toBeUndefined();
		// The personal knowledge base was not written, so its folder stays gated.
		expect(g.commit("git commit -m wip", { cwd: g.personal.folder })?.block).toBe(true);
	});

	test("counts a relative path, resolved against the session folder", () => {
		const g = gate();
		g.write("write", { path: "../../work-kb/_memory/fact.md" });
		expect(g.commit("git commit -m wip")).toBeUndefined();
	});

	test("a failed write result for a vault:// path does not count", () => {
		const g = gate();
		g.write("write", { path: "vault://_memory/fact.md" }, { isError: true });
		expect(g.commit("git commit -m wip")?.block).toBe(true);
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
		expect(g.commit(`git -C ${g.personal.folder} commit -m wip`, { cwd: path.join(HOME, "elsewhere") })?.reason).toContain(g.personal.source.kbRef);
		expect(g.commit("git -C ../work/repo commit -m wip", { cwd: path.join(HOME, "elsewhere") })?.reason).toContain(g.work.source.kbRef);
		expect(g.commit("git commit -m wip", { cwd: path.join(HOME, "elsewhere"), input: { cwd: g.work.folder } })?.block).toBe(true);
		expect(g.commit(`git -C ${HOME}/elsewhere commit -m wip`)).toBeUndefined();
	});

	test("~ in a path expands to the home directory", () => {
		const g = gate();
		expect(g.commit("git -C ~/personal commit -m wip", { cwd: path.join(HOME, "elsewhere") })?.reason).toContain(g.personal.source.kbRef);
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

describe("when the gate does not apply", () => {
	test("a knowledge base without a gate folder never blocks", () => {
		const g = gate((work, personal) => [{ ...work.source, gateDir: undefined }, personal.source]);
		expect(g.commit("git commit -m wip")).toBeUndefined();
	});

	test("skipped or missing knowledge-base setup never blocks", () => {
		const skipped = gate();
		seedState({ kb: { status: "skipped" } });
		expect(skipped.commit("git commit -m wip")).toBeUndefined();
		seedState({});
		expect(skipped.commit("git commit -m wip")).toBeUndefined();
	});
});

describe("when the write flag resets", () => {
	test("a new main session or a session switch asks for a fresh KB write", () => {
		for (const event of ["session_start", "session_switch"]) {
			const g = gate();
			g.write("write", { path: path.join(g.work.memoryDir, "fact.md") });
			expect(g.commit("git commit -m wip")).toBeUndefined();
			g.fake.emit(event, {}, fakeContext({ cwd: g.work.folder, agent: { kind: "main", name: "main" } }));
			expect(g.commit("git commit -m wip")?.block).toBe(true);
		}
	});

	test("a subagent starting does not reset what its parent already wrote", () => {
		for (const event of ["session_start", "session_switch"]) {
			const g = gate();
			g.write("write", { path: path.join(g.work.memoryDir, "fact.md") });
			g.fake.emit(event, {}, fakeContext({ cwd: g.work.folder, agent: { kind: "sub", name: "task" } }));
			expect(g.commit("git commit -m wip")).toBeUndefined();
		}
	});

	test("a subagent's KB write satisfies its parent's commit", () => {
		const g = gate();
		g.fake.emit("session_start", {}, fakeContext({ cwd: g.work.folder, agent: { kind: "sub", name: "task" } }));
		g.fake.emit("tool_result", { toolName: "write", isError: false, input: { path: path.join(g.work.memoryDir, "fact.md") } }, fakeContext({ cwd: g.work.folder, agent: { kind: "sub", name: "task" } }));
		expect(g.commit("git commit -m wip")).toBeUndefined();
	});
});
