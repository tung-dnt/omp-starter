import { afterEach, beforeEach, expect, type Mock, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import repoMemory from "./repo-memory";
import { fakeContext, fakePi, initGitRepo, privateHome, resetHome } from "./test-harness";

const HINDSIGHT = "memory:\n  backend: hindsight\nhindsight:\n  bankId: tony\n  apiUrl: http://hindsight.test/\n  apiToken: secret\n";
let fetchSpy: Mock<typeof fetch>;
const requests: { url: string; body: { tags: string[]; tags_match: string }; auth: string | null }[] = [];

beforeEach(() => {
	resetHome();
	requests.length = 0;
	fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (url: string, init: RequestInit) => {
		requests.push({ url, body: JSON.parse(String(init.body)), auth: new Headers(init.headers).get("authorization") });
		return Response.json({ results: [{ text: "Branches are named PAC2-####." }] });
	}) as unknown as typeof fetch);
});
afterEach(() => fetchSpy.mockRestore());

function session(config = HINDSIGHT, cwd?: string) {
	const home = privateHome();
	fs.mkdirSync(path.join(home, ".omp", "agent"), { recursive: true });
	fs.writeFileSync(path.join(home, ".omp", "agent", "config.yml"), config);
	const projects = path.join(home, "projects");
	initGitRepo(path.join(projects, "paco24"));
	initGitRepo(path.join(projects, "paco24-PAC2-1"), "git@github.com:blinx/paco24.git");
	const fake = fakePi();
	repoMemory(fake.pi);
	const ctx = fakeContext({ cwd: cwd ?? projects, agent: { kind: "main", name: "main" } });
	const call = (toolName: string, input: object, c = ctx) =>
		fake.emit("tool_result", { toolName, input, isError: false }, c) as Promise<{ additionalContext: string } | undefined>;
	return { projects, call };
}

test("first touch of a repo recalls its tagged memories once", async () => {
	const { projects, call } = session();
	const result = await call("read", { path: "paco24/README.md:1-20" });
	expect(result?.additionalContext).toContain("Branches are named PAC2-####.");
	expect(requests[0].url).toBe("http://hindsight.test/v1/default/banks/tony/memories/recall");
	expect(requests[0].body).toMatchObject({ tags: ["project:paco24"], tags_match: "any_strict" });
	expect(requests[0].auth).toBe("Bearer secret");
	expect(await call("bash", { command: `rg -n x ${projects}/paco24/src` })).toBeUndefined();
	expect(requests).toHaveLength(1);
});

test("a worktree also matches its origin repo's tag", async () => {
	const { call } = session();
	await call("edit", { input: "[paco24-PAC2-1/src/a.ts#ABCD]\nPUT 1.=1:\n+x" });
	expect(requests[0].body.tags).toEqual(["project:paco24-pac2-1", "project:paco24"]);
});

test("the session's own repo and subagents never recall", async () => {
	const own = session(HINDSIGHT, path.join(privateHome(), "projects", "paco24"));
	expect(await own.call("read", { path: "src/a.ts" })).toBeUndefined();
	const scout = fakeContext({ cwd: own.projects, agent: { kind: "sub", name: "scout" } });
	expect(await own.call("read", { path: `${own.projects}/paco24-PAC2-1/a.ts` }, scout)).toBeUndefined();
	expect(requests).toHaveLength(0);
});

test("memory that is not Hindsight never recalls", async () => {
	const { call } = session("memory:\n  backend: local\n");
	expect(await call("read", { path: "paco24/a.ts" })).toBeUndefined();
	expect(requests).toHaveLength(0);
});

test("a failed recall tells the agent to search by repo name instead", async () => {
	fetchSpy.mockImplementation((async () => new Response("down", { status: 503 })) as unknown as typeof fetch);
	const { call } = session();
	expect((await call("read", { path: "paco24/a.ts" }))?.additionalContext).toContain('Recall for paco24 failed (Error: HTTP 503)');
});
