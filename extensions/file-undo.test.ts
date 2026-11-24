// Drives /undo through the events and command the host uses. `tool()` plays the host's tool lifecycle (tool_call, the change itself,
// tool_result); the bash cases run real git, with an identity because the private HOME has no git config.
import { beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import fileUndo from "./file-undo";
import { tildify } from "./lib/state";
import { fakeContext, fakePi, initGitRepo, privateHome, resetHome, scriptedUi, writeFiles, type FakeContext, type FakeExec, type FakePi, type UiScript } from "./test-harness";

beforeEach(resetHome);

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };

const realGit: FakeExec = (command, args, options) => {
	try {
		return { stdout: execFileSync(command, args, { cwd: options?.cwd, env: GIT_ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }), stderr: "", code: 0 };
	} catch (error) {
		const failed = error as { status?: number; stderr?: string };
		return { stdout: "", stderr: String(failed.stderr ?? ""), code: failed.status ?? 1 };
	}
};

const runGit = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, env: GIT_ENV, stdio: "ignore" });

interface Host {
	fake: FakePi;
	ctx: FakeContext;
}

function session(options: { cwd?: string; exec?: FakeExec; ui?: UiScript; hasUI?: boolean } = {}) {
	const cwd = options.cwd ?? path.join(privateHome(), "work");
	fs.mkdirSync(cwd, { recursive: true });
	const fake = fakePi(options.exec);
	fileUndo(fake.pi);
	const ui = scriptedUi(options.ui);
	const main = fakeContext({ cwd, agent: { kind: "main", name: "main" }, ui, hasUI: options.hasUI });
	// The groups are shared by the whole process, so every session starts by clearing them, as the host does.
	fake.emit("session_start", { type: "session_start" }, main);
	let calls = 0;

	const file = (rel: string) => path.join(cwd, rel);
	const prompt = () => fake.emit("before_agent_start", { type: "before_agent_start", reason: "prompt", prompt: "go", systemPrompt: [] }, main);

	async function tool(toolName: string, input: Record<string, unknown>, change: () => void, host: Host = { fake, ctx: main }, details?: unknown): Promise<void> {
		const toolCallId = `call-${++calls}`;
		await host.fake.emit("tool_call", { type: "tool_call", toolName, toolCallId, input }, host.ctx);
		change();
		await host.fake.emit("tool_result", { type: "tool_result", toolName, toolCallId, input, content: [], details, isError: false }, host.ctx);
	}

	const write = (rel: string, content: string) =>
		tool("write", { path: rel, content }, () => {
			fs.mkdirSync(path.dirname(file(rel)), { recursive: true });
			fs.writeFileSync(file(rel), content);
		});

	async function undo(args = ""): Promise<string> {
		const seen = ui.notifications.length;
		await fake.runCommand("undo", args, main);
		return ui.notifications.slice(seen).map(n => n.message).join("\n");
	}

	return { cwd, fake, main, ui, file, prompt, tool, write, undo };
}

const read = (file: string) => fs.readFileSync(file, "utf8");

describe("what /undo puts back", () => {
	test("a write over an existing file is undone byte for byte", async () => {
		const s = session();
		const original = Buffer.from([0xff, 0xfe, 0x00, 0x41, 0x0a]);
		fs.writeFileSync(s.file("data.bin"), original);
		await s.prompt();
		await s.write("data.bin", "text now");
		expect(await s.undo()).toContain(`restored 1 file: ${tildify(s.file("data.bin"))}`);
		expect(fs.readFileSync(s.file("data.bin"))).toEqual(original);
	});

	test("a file the prompt created is deleted", async () => {
		const s = session();
		await s.prompt();
		await s.write("new/dir/a.txt", "hi");
		expect(fs.existsSync(s.file("new/dir/a.txt"))).toBe(true);
		await s.undo();
		expect(fs.existsSync(s.file("new/dir/a.txt"))).toBe(false);
	});

	test("an edit's targets come from its payload: the hashline header and MV, and the files a patch deletes", async () => {
		const s = session();
		writeFiles(s.cwd, { "src/a.ts": "one\n", "gone.txt": "keep me\n" });
		await s.prompt();
		await s.tool("edit", { input: "[src/a.ts#1A2B]\nPUT 1.=1:\n+two\nMV src/b.ts" }, () => {
			fs.writeFileSync(s.file("src/b.ts"), "two\n");
			fs.rmSync(s.file("src/a.ts"));
		});
		await s.tool("edit", { input: "*** Begin Patch\n*** Delete File: gone.txt\n*** End Patch" }, () => fs.rmSync(s.file("gone.txt")));
		await s.undo();
		expect(read(s.file("src/a.ts"))).toBe("one\n");
		expect(fs.existsSync(s.file("src/b.ts"))).toBe(false);
		expect(read(s.file("gone.txt"))).toBe("keep me\n");
	});

	test("each prompt is its own group: /undo reverts only the newest, the next one the one before", async () => {
		const s = session();
		fs.writeFileSync(s.file("a.txt"), "v0");
		await s.prompt();
		await s.write("a.txt", "v1");
		await s.prompt();
		await s.write("a.txt", "v2");
		await s.write("a.txt", "v3");
		await s.write("b.txt", "second prompt");
		await s.undo();
		expect(read(s.file("a.txt"))).toBe("v1");
		expect(fs.existsSync(s.file("b.txt"))).toBe(false);
		await s.undo();
		expect(read(s.file("a.txt"))).toBe("v0");
	});

	test("a file over 5 MB is not copied: it is named and left alone", async () => {
		const s = session();
		fs.writeFileSync(s.file("big.bin"), Buffer.alloc(5 * 1024 * 1024 + 1, 1));
		fs.writeFileSync(s.file("small.txt"), "s0");
		await s.prompt();
		await s.write("big.bin", "shrunk");
		await s.write("small.txt", "s1");
		const said = await s.undo();
		expect(said).toContain(`skipped 1 file over 5 MB (not copied): ${tildify(s.file("big.bin"))}`);
		expect(read(s.file("big.bin"))).toBe("shrunk");
		expect(read(s.file("small.txt"))).toBe("s0");
	});
});

describe("when there is nothing to put back", () => {
	test("it says so before any edit, and a call that changed nothing leaves nothing to undo", async () => {
		const s = session();
		expect(await s.undo()).toContain("nothing to undo");
		await s.prompt();
		await s.write("x.txt", "");
		fs.rmSync(s.file("x.txt"));
		expect(await s.undo()).toContain("nothing to undo");
	});

	test("a new session forgets every group", async () => {
		const s = session();
		await s.prompt();
		await s.write("a.txt", "x");
		await s.fake.emit("session_switch", { type: "session_switch" }, s.main);
		expect(await s.undo()).toContain("nothing to undo");
		expect(fs.existsSync(s.file("a.txt"))).toBe(true);
	});

	test("while the agent is working it refuses and changes nothing", async () => {
		const s = session();
		fs.writeFileSync(s.file("a.txt"), "v0");
		await s.prompt();
		await s.write("a.txt", "v1");
		s.main.idle = false;
		expect(await s.undo()).toContain("wait until the turn ends or press Esc");
		expect(read(s.file("a.txt"))).toBe("v1");
		s.main.idle = true;
		await s.undo();
		expect(read(s.file("a.txt"))).toBe("v0");
	});
});

describe("a file changed after the agent's edit", () => {
	for (const answer of [false, true]) {
		test(`is ${answer ? "restored" : "kept"} when the confirm answers ${answer}; the other files are restored either way`, async () => {
			const s = session({ ui: { confirm: [answer] } });
			fs.writeFileSync(s.file("mine.txt"), "v0");
			fs.writeFileSync(s.file("plain.txt"), "p0");
			await s.prompt();
			await s.write("mine.txt", "agent");
			await s.write("plain.txt", "p1");
			fs.writeFileSync(s.file("mine.txt"), "my own change");
			const said = await s.undo();
			expect(s.ui.prompts).toHaveLength(1);
			expect(s.ui.prompts[0].detail).toContain(tildify(s.file("mine.txt")));
			expect(read(s.file("plain.txt"))).toBe("p0");
			expect(read(s.file("mine.txt"))).toBe(answer ? "v0" : "my own change");
			expect(said).toContain(answer ? "restored 2 files" : "kept 1 file changed after the edit");
		});
	}

	test("is skipped with a warning, never asked about, when there is no UI", async () => {
		const s = session({ hasUI: false });
		fs.writeFileSync(s.file("mine.txt"), "v0");
		await s.prompt();
		await s.write("mine.txt", "agent");
		fs.writeFileSync(s.file("mine.txt"), "my own change");
		const said = await s.undo();
		expect(s.ui.prompts).toHaveLength(0);
		expect(said).toContain("no UI to confirm");
		expect(s.ui.notifications.at(-1)?.type).toBe("warning");
		expect(read(s.file("mine.txt"))).toBe("my own change");
	});
});

describe("subagents", () => {
	function subagent(cwd: string): Host {
		const fake = fakePi();
		fileUndo(fake.pi);
		return { fake, ctx: fakeContext({ cwd, agent: { kind: "sub", name: "scout" } }) };
	}

	test("an edit by a subagent joins the prompt's group, and the subagent's own session start does not clear it", async () => {
		const s = session();
		const scout = subagent(s.cwd);
		await s.prompt();
		await s.write("main.txt", "m");
		await scout.fake.emit("session_start", { type: "session_start" }, scout.ctx);
		await s.tool("write", { path: "sub.txt", content: "x" }, () => fs.writeFileSync(s.file("sub.txt"), "x"), scout);
		expect(await s.undo()).toContain("restored 2 files");
		expect(fs.existsSync(s.file("main.txt")) || fs.existsSync(s.file("sub.txt"))).toBe(false);
	});

	test("an edit in an isolated worktree is not the user's file and is left out", async () => {
		const s = session();
		const worktree = path.join(privateHome(), "worktree");
		fs.mkdirSync(worktree);
		const isolated = subagent(worktree);
		await s.prompt();
		await s.tool("write", { path: "wt.txt", content: "y" }, () => fs.writeFileSync(path.join(worktree, "wt.txt"), "y"), isolated);
		expect(await s.undo()).toContain("nothing to undo");
		expect(fs.existsSync(path.join(worktree, "wt.txt"))).toBe(true);
	});

	test("the command does nothing when a subagent runs it", async () => {
		const s = session();
		const scout = subagent(s.cwd);
		await s.prompt();
		await s.write("a.txt", "x");
		await scout.fake.runCommand("undo", "", scout.ctx);
		expect(scout.ctx.ui.notifications).toHaveLength(0);
		expect(fs.existsSync(s.file("a.txt"))).toBe(true);
	});
});

describe("ast_edit", () => {
	const preview = (cwd: string) => ({ files: ["src/a.ts"], cwd, applied: false });
	const rewrite = { ops: [{ pat: "old()", out: "new()" }], paths: ["src"] };

	test("a rewrite is undone once resolve applied it, without asking about the file the agent had already edited", async () => {
		const s = session();
		writeFiles(s.cwd, { "src/a.ts": "orig\n" });
		await s.prompt();
		await s.write("src/a.ts", "old()\n");
		await s.tool("ast_edit", rewrite, () => {}, undefined, preview(s.cwd));
		expect(read(s.file("src/a.ts"))).toBe("old()\n");
		await s.tool("bash", { command: 'resolve "apply the rewrite"' }, () => fs.writeFileSync(s.file("src/a.ts"), "new()\n"));
		await s.undo();
		expect(read(s.file("src/a.ts"))).toBe("orig\n");
		expect(s.ui.prompts).toHaveLength(0);
	});

	test("a preview that was rejected changed nothing, so there is nothing to undo", async () => {
		const s = session();
		writeFiles(s.cwd, { "src/a.ts": "old()\n" });
		await s.prompt();
		await s.tool("ast_edit", rewrite, () => {}, undefined, preview(s.cwd));
		await s.tool("reject", { reason: "no" }, () => {});
		expect(await s.undo()).toContain("nothing to undo");
	});
});

describe("/undo list", () => {
	test("shows one line per prompt that changed files, and only the last 20 prompts are kept", async () => {
		const s = session();
		for (let i = 0; i < 22; i++) {
			await s.prompt();
			// A prompt that changes nothing in between does not take a slot.
			await s.prompt();
			await s.write(`f${i}.txt`, "x");
		}
		const rows = (await s.undo("list")).split("\n");
		expect(rows[0]).toContain("20 prompts");
		expect(rows).toHaveLength(21);
		expect(rows[1]).toMatch(/^ {2}\d+s ago, 1 file, snapshot none$/);
	});
});

describe("git", () => {
	test("a git that fails neither blocks an edit nor breaks the undo; /undo all says there is no snapshot", async () => {
		const s = session({
			exec: () => {
				throw new Error("git is not installed");
			},
		});
		fs.writeFileSync(s.file("a.txt"), "v0");
		await s.prompt();
		await s.write("a.txt", "v1");
		expect(await s.undo("all")).toContain("no git snapshot");
		expect(read(s.file("a.txt"))).toBe("v0");
	});

	/** A repo with tracked.txt and src/a.ts committed; the prompt edits src/a.ts, then bash rewrites tracked.txt and creates created.txt. */
	async function bashed(dirty: boolean, hasUI = true) {
		const repo = path.join(privateHome(), "repo");
		initGitRepo(repo);
		writeFiles(repo, { "tracked.txt": "committed\n", "src/a.ts": "a0\n" });
		runGit(repo, "add", "-A");
		runGit(repo, "commit", "-q", "-m", "init");
		if (dirty) fs.writeFileSync(path.join(repo, "tracked.txt"), "uncommitted\n");
		const s = session({ cwd: repo, exec: realGit, ui: { confirm: [true] }, hasUI });
		await s.prompt();
		await s.write("src/a.ts", "a1\n");
		await s.tool("bash", { command: "echo changed > tracked.txt; touch created.txt" }, () => {
			fs.writeFileSync(s.file("tracked.txt"), "by bash\n");
			fs.writeFileSync(s.file("created.txt"), "");
		});
		return s;
	}

	test("/undo reports what bash changed and leaves it alone", async () => {
		const s = await bashed(false);
		const said = await s.undo();
		expect(said).toContain(`changed outside the edit tools (bash?): ${tildify(s.file("tracked.txt"))}`);
		expect(said).toContain("/undo all also restores tracked ones from the snapshot");
		expect(read(s.file("src/a.ts"))).toBe("a0\n");
		expect(read(s.file("tracked.txt"))).toBe("by bash\n");
	});

	for (const [dirty, snapshot] of [
		[false, "committed\n"],
		[true, "uncommitted\n"],
	] as const) {
		test(`/undo all restores a tracked file bash changed to its state when the prompt started (${dirty ? "uncommitted work" : "clean tree"}) and never deletes an untracked one`, async () => {
			const s = await bashed(dirty);
			const said = await s.undo("all");
			expect(s.ui.prompts).toHaveLength(1);
			expect(read(s.file("tracked.txt"))).toBe(snapshot);
			expect(read(s.file("src/a.ts"))).toBe("a0\n");
			expect(fs.existsSync(s.file("created.txt"))).toBe(true);
			expect(said).toContain(`untracked files written since the snapshot, never deleted: ${tildify(s.file("created.txt"))}`);
		});
	}

	test("/undo all without a UI undoes the edit tools' files and refuses to touch what bash changed", async () => {
		const s = await bashed(false, false);
		const said = await s.undo("all");
		expect(said).toContain("needs a UI to confirm");
		expect(read(s.file("src/a.ts"))).toBe("a0\n");
		expect(read(s.file("tracked.txt"))).toBe("by bash\n");
	});
});
