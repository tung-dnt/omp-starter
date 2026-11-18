import { beforeEach, describe, expect, test } from "bun:test";
import * as path from "node:path";
import { HOME } from "../state";
import { initGitRepo, resetHome, writeFiles } from "../../test-harness";
import { type HardGates, readHardGates } from "./artifacts";
import { checkPrBody, type PrBodyInput } from "./pr-body";
import type { ActiveStory } from "./registry";
import { HARD_GATES_TEMPLATE } from "./templates";

const repo = path.join(HOME, "work", "shop");
const leadDir = path.join(HOME, "kb", "lead");
let gates: HardGates;

beforeEach(() => {
	resetHome();
	initGitRepo(repo);
	writeFiles(repo, { "src/orders.test.ts": 'test("inserts are idempotent", () => {});\ntest("stock never goes negative", () => {});\n' });
	writeFiles(leadDir, { "hard-gates.md": HARD_GATES_TEMPLATE });
	gates = readHardGates(leadDir).gates!;
});

const story: ActiveStory = { id: "S1", dir: path.join(leadDir, "stories", "S1"), leadDir, mode: "sync", invariants: [{ id: "I1", text: "inserts are idempotent on id" }] };

const BASE = [
	"## Decision log",
	"- unique index — rejected: app-level check (races between requests)",
	"",
	"## Invariant checklist",
	"- I1: inserts are idempotent on id — test: src/orders.test.ts::inserts are idempotent",
	"",
	"## Risk summary",
	"- the backfill holds a table lock — src/orders.ts:12",
].join("\n");

const check = (body: string, input: Partial<PrBodyInput> = {}) => checkPrBody({ body, repo, story, gates, changed: ["src/orders.ts"], added: ["const total = 1;"], ...input });

describe("the sections every PR needs", () => {
	test("a body with all three passes", () => {
		expect(check(BASE)).toEqual([]);
	});

	test("each missing section is named", () => {
		expect(check("Fixes the orders bug.")).toEqual(["Missing section: ## Decision log", "Missing section: ## Invariant checklist", "Missing section: ## Risk summary"]);
	});

	test("a decision log without entries and a risk without a file:line pointer are refused", () => {
		const body = BASE.replace("- unique index", "unique index").replace(" — src/orders.ts:12", "");
		expect(check(body)).toEqual(["Decision log: list each choice as `- <choice> — rejected: <alternative> (<why>)`", "Risk summary: each risk needs a file:line pointer"]);
	});
});

describe("the invariant checklist", () => {
	test("every brief invariant needs a line with a proving test", () => {
		expect(check(BASE.replace(" — test: src/orders.test.ts::inserts are idempotent", ""))).toEqual([
			"Invariant I1 has no proving test (format: - I1: … — test: path::test name)",
		]);
	});

	test("a test reference must name a test that exists in that file", () => {
		expect(check(BASE.replace("::inserts are idempotent", "::inserts are unique"))).toEqual(["test reference src/orders.test.ts::inserts are unique not found"]);
		expect(check(BASE.replace("src/orders.test.ts", "src/missing.test.ts"))).toEqual(["test reference src/missing.test.ts::inserts are idempotent not found"]);
	});

	test("outside a story the section may be the single word none", () => {
		const none = BASE.replace(/- I1: .+/, "none");
		expect(check(none, { story: undefined })).toEqual([]);
		expect(check(none)).toEqual(["Invariant I1 has no proving test (format: - I1: … — test: path::test name)"]);
		expect(check(BASE.replace(/- I1: .+/, "n/a"), { story: undefined })).toEqual(["Invariant checklist: list invariants with `test: path::test name` or write `none`"]);
	});
});

describe("sections the diff calls for", () => {
	const NOTE = "\n\n## Concurrency note\nIdempotency: unique index on orders.id\nOrdering: row lock per order\nFailure: retries are safe, duplicates are ignored\nTransactions: one per order";

	test("a concurrency trigger path or added line needs the concurrency note with all four fields", () => {
		expect(check(BASE, { changed: ["src/workers/sync.ts"] })).toEqual(["Missing section: ## Concurrency note"]);
		expect(check(BASE, { added: ["await db.query('SELECT 1 FOR UPDATE')"] })).toEqual(["Missing section: ## Concurrency note"]);
		expect(check(BASE + NOTE, { changed: ["src/workers/sync.ts"] })).toEqual([]);
		expect(check(BASE + NOTE.replace("Ordering: row lock per order\n", "").replace("one per order", ""), { changed: ["src/workers/sync.ts"] })).toEqual([
			"Concurrency note: missing Ordering",
			"Concurrency note: missing Transactions",
		]);
	});

	const ddia = (lines: Record<number, string> = {}) =>
		`\n\n## DDIA checklist\n${Array.from({ length: 12 }, (_, i) => lines[i + 1] ?? `${i + 1}. no — not affected`)
			.filter(Boolean)
			.join("\n")}`;

	test("a schema change needs all twelve DDIA items answered, and every yes backed by a mechanism and a test", () => {
		const changed = ["db/migrations/002.sql"];
		expect(check(BASE, { changed })).toEqual(["Missing section: ## DDIA checklist"]);
		expect(check(BASE + ddia(), { changed })).toEqual([]);
		expect(check(BASE + ddia({ 12: "" }), { changed })).toEqual(["DDIA item 12 unanswered"]);
		expect(check(BASE + ddia({ 2: "2. yes — two writers can race" }), { changed })).toEqual(["DDIA item 2: yes needs mechanism: and test: path::name"]);
		const proven = "2. yes — two writers can race — mechanism: CHECK (stock >= 0) — test: src/orders.test.ts::stock never goes negative";
		expect(check(BASE + ddia({ 2: proven }), { changed })).toEqual([]);
		expect(check(BASE + ddia({ 2: proven.replace("stock never", "stock sometimes") }), { changed })).toEqual(["test reference src/orders.test.ts::stock sometimes goes negative not found"]);
	});

	test("a contract change, a changed edge list or an agent's edit of the system map needs the system-map diff", () => {
		expect(check(BASE + ddia(), { changed: ["api/openapi.yml"] })).toEqual(["Missing section: ## System-map diff"]);
		expect(check(BASE, { changed: ["docs/arch/edges.json"] })).toEqual(["Missing section: ## System-map diff"]);
		expect(check(BASE, { mapEdited: true })).toEqual(["Missing section: ## System-map diff"]);
		expect(check(`${BASE}\n\n## System-map diff\n`, { mapEdited: true })).toEqual(["System-map diff: say what changed in system-map.md, one line per service"]);
		expect(check(`${BASE}\n\n## System-map diff\n- api: now calls worker`, { mapEdited: true })).toEqual([]);
	});

	test("changed edges must be listed line for line under structural changes", () => {
		const edgesDiff = ["+ cross:api -> worker", "- code:api:src/handlers -> src/db"];
		expect(check(BASE, { edgesDiff })).toEqual(["Missing section: ## Structural changes"]);
		expect(check(`${BASE}\n\n## Structural changes\n+ cross:api -> worker`, { edgesDiff })).toEqual(["Structural changes: missing - code:api:src/handlers -> src/db"]);
		expect(check(`${BASE}\n\n## Structural changes\n${edgesDiff.join("\n")}`, { edgesDiff })).toEqual([]);
	});
});
