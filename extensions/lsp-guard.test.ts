import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import lspGuard from "./lsp-guard";
import { fakeContext, fakePi, resetHome, seedState, type FakeContext, type FakePi } from "./test-harness";

const originalFetch = globalThis.fetch;
const originalKey = process.env.TYPESAFE_API_KEY;

beforeEach(resetHome);
afterEach(() => {
	globalThis.fetch = originalFetch;
	if (originalKey === undefined) delete process.env.TYPESAFE_API_KEY;
	else process.env.TYPESAFE_API_KEY = originalKey;
});

const LOOKUP = 'rg -n "func ApproveSticker" internal';

interface Request {
	url: string;
	authorization: string | null;
	body: { model: string; state: { content: string }; questions: { q: { instructions: string } } };
}

interface Verdict {
	block: boolean;
	reason: string;
}

interface Guard {
	fake: FakePi;
	/** Requests the guard sent to TypeSafe. */
	requests: Request[];
	/** Result of the guarded bash call (`undefined` = allowed). */
	/** `agent: null` = a host that names no agent. */
	call(command: string, options?: { agent?: FakeContext["agent"] | null; toolName?: string }): Promise<Verdict | undefined>;
}

/** Jev judges as `answer` (a probability, or a fetch response) with a key and the Jev step switched on. */
function guard(answer: number | (() => Promise<Response>), options: { key?: string | null; jev?: "done" | "skipped" } = {}): Guard {
	const key = options.key === undefined ? "test-key" : options.key;
	if (key === null) delete process.env.TYPESAFE_API_KEY;
	else process.env.TYPESAFE_API_KEY = key;
	seedState({ jev: options.jev ?? "done" });
	const requests: Request[] = [];
	globalThis.fetch = Object.assign(
		async (url: string | URL | Request, init?: RequestInit) => {
			requests.push({ url: String(url), authorization: new Headers(init?.headers).get("Authorization"), body: JSON.parse(String(init?.body)) });
			if (typeof answer === "function") return answer();
			return Response.json({ answers: { q: { noul: answer } } });
		},
		originalFetch,
	);
	const fake = fakePi();
	lspGuard(fake.pi);
	return {
		fake,
		requests,
		async call(command, { agent = { kind: "sub" as const, name: "task" }, toolName = "bash" } = {}) {
			const ctx = fakeContext({ cwd: "/repo", agent: agent ?? undefined });
			return (await fake.emit("tool_call", { toolName, input: { command } }, ctx)) as Verdict | undefined;
		},
	};
}

describe("a coding subagent's symbol lookup", () => {
	test("is blocked when Jev is confident, with the call to make instead", async () => {
		const g = guard(0.93);
		const blocked = await g.call(LOOKUP, { agent: { kind: "sub", name: "task" } });
		expect(blocked?.block).toBe(true);
		expect(blocked?.reason).toContain("p=0.93");
		expect(blocked?.reason).toContain("xd://lsp");
		expect(blocked?.reason).toContain("# text-search");
	});

	test("task-builder, which has the lsp tool itself, is pointed at that tool", async () => {
		const g = guard(0.9);
		const blocked = await g.call(LOOKUP, { agent: { kind: "sub", name: "task-builder" } });
		expect(blocked?.reason).toContain("the `lsp` tool");
		expect(blocked?.reason).not.toContain("xd://lsp");
	});

	test("is allowed when Jev is below the blocking threshold", async () => {
		const g = guard(0.8);
		expect(await g.call(LOOKUP)).toBeUndefined();
		expect(g.requests).toHaveLength(1);
	});

	test("is allowed when the command ends in the # text-search marker, without asking Jev", async () => {
		const g = guard(0.99);
		expect(await g.call(`${LOOKUP} # text-search`)).toBeUndefined();
		expect(g.requests).toHaveLength(0);
	});

	test("sends Jev the command and the rule's question, authenticated with the key", async () => {
		const g = guard(0.1, { key: "  secret-key  " });
		await g.call(LOOKUP);
		const [request] = g.requests;
		expect(request.url).toBe("https://api.typesafe.ai/v1/systemone");
		expect(request.authorization).toBe("Bearer secret-key");
		expect(JSON.parse(request.body.state.content)).toEqual({ command: LOOKUP });
		const rule = fs.readFileSync(new URL("../rules/lsp-symbol-judged.md", import.meta.url), "utf8");
		expect(JSON.parse(/^question: (".*")$/m.exec(rule)![1])).toBe(request.body.questions.q.instructions);
	});
});

describe("every uncertainty lets the command run", () => {
	const failures: [string, () => Promise<Response>][] = [
		["TypeSafe being unreachable", async () => Promise.reject(new Error("offline"))],
		["an HTTP error", async () => new Response("no", { status: 500 })],
		["a body without an answer", async () => Response.json({ answers: {} })],
		["a body that is not JSON", async () => new Response("<html>")],
	];
	for (const [name, answer] of failures) {
		test(name, async () => {
			expect(await guard(answer).call(LOOKUP)).toBeUndefined();
		});
	}
});

describe("calls the guard does not judge", () => {
	test("without a TypeSafe key, or with the Jev step off or skipped", async () => {
		for (const options of [{ key: null }, { key: "  " }, { jev: "skipped" as const }]) {
			const g = guard(0.99, options);
			expect(await g.call(LOOKUP)).toBeUndefined();
			expect(g.requests).toHaveLength(0);
		}
	});

	test("the main agent, a host that names no agent, and agents without a language-server tool", async () => {
		const g = guard(0.99);
		expect(await g.call(LOOKUP, { agent: { kind: "main", name: "main" } })).toBeUndefined();
		expect(await g.call(LOOKUP, { agent: null })).toBeUndefined();
		expect(await g.call(LOOKUP, { agent: { kind: "sub", name: "scout" } })).toBeUndefined();
		expect(g.requests).toHaveLength(0);
	});

	test("tools other than bash", async () => {
		const g = guard(0.99);
		expect(await g.call(LOOKUP, { toolName: "read" })).toBeUndefined();
		expect(g.requests).toHaveLength(0);
	});

	test("searches that no language server covers, and greps reading another command's output", async () => {
		const g = guard(0.99);
		for (const command of ['grep -n "x" /tmp/copy.go', 'rg "CREATE TABLE" db/migrations', "go test ./... 2>&1 | grep FAIL", "git status"]) {
			expect(await g.call(command)).toBeUndefined();
		}
		expect(g.requests).toHaveLength(0);
	});
});
