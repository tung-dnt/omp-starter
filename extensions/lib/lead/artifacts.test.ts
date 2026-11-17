import { beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { HOME } from "../state";
import { initGitRepo, resetHome, writeFiles } from "../../test-harness";
import { protectedLeadPath, readBrief, readHardGates, readPlan, readSystemMap } from "./artifacts";
import { BRIEF_TEMPLATE, HARD_GATES_TEMPLATE, SYSTEM_MAP_TEMPLATE } from "./templates";

beforeEach(resetHome);

const leadDir = () => path.join(HOME, "kb", "lead");
const storyDir = () => path.join(leadDir(), "stories", "S1");

describe("readHardGates", () => {
	test("the template parses: gates, compiled trigger patterns and the builder limit", () => {
		writeFiles(leadDir(), { "hard-gates.md": HARD_GATES_TEMPLATE });
		const { gates, error } = readHardGates(leadDir());
		expect(error).toBeUndefined();
		expect(gates?.gates.find(g => g.id === "migrations")).toEqual({ id: "migrations", category: "schema", repos: ["*"], paths: ["**/migrations/**", "**/*.sql"] });
		expect(gates?.concurrencyTriggers.patterns.some(p => p.test("SELECT 1 FOR UPDATE"))).toBe(true);
		expect(gates?.limits.builders).toBe(2);
	});

	test("no file means no gates are configured", () => {
		expect(readHardGates(leadDir())).toEqual({});
	});

	test("an invalid file falls back to the last good copy and says why", () => {
		writeFiles(leadDir(), { "hard-gates.md": HARD_GATES_TEMPLATE });
		readHardGates(leadDir());
		writeFiles(leadDir(), { "hard-gates.md": HARD_GATES_TEMPLATE.replace("category: schema", "category: databases") });
		const { gates, error } = readHardGates(leadDir());
		expect(error).toContain('category "databases" is not one of');
		expect(error).toEndWith("using last good copy");
		expect(gates?.gates.find(g => g.id === "migrations")?.category).toBe("schema");
	});

	test("an invalid file with no earlier good read returns only the error", () => {
		writeFiles(leadDir(), { "hard-gates.md": "```yaml\ngates:\n  - { id: Bad Id, category: schema, paths: [] }\n```\n" });
		const result = readHardGates(leadDir());
		expect(result.gates).toBeUndefined();
		expect(result.error).toContain("gates[0].id");
	});
});

describe("readSystemMap", () => {
	test("reads services with snake_case keys and defaults", () => {
		writeFiles(leadDir(), { "system-map.md": SYSTEM_MAP_TEMPLATE.replace("owns_tables: []", "owns_tables: [orders]") });
		expect(readSystemMap(leadDir()).services).toEqual([
			{ name: "example-api", repo: "example-repo", path: "", ownsTables: ["orders"], publishes: [], consumes: [], calls: [] },
		]);
	});

	test("a missing map names the file and the command that creates it", () => {
		expect(readSystemMap(leadDir()).error).toBe("system map missing: ~/kb/lead/system-map.md (run /starter lead)");
	});
});

const FILLED_BRIEF = BRIEF_TEMPLATE.replace("mode: sync", "mode: async")
	.replace("- I1: …", "- I1: inserts are idempotent on id\n- I2: totals never go negative")
	.replace(/^(## (?!Invariants).+)$/gm, "$1\none line");

describe("readBrief", () => {
	test("a filled brief gives its mode and invariants", () => {
		writeFiles(storyDir(), { "brief.md": FILLED_BRIEF });
		const { brief, errors } = readBrief(storyDir());
		expect(errors).toEqual([]);
		expect(brief?.mode).toBe("async");
		expect(brief?.invariants).toEqual([
			{ id: "I1", text: "inserts are idempotent on id" },
			{ id: "I2", text: "totals never go negative" },
		]);
	});

	test("the unfilled template is refused section by section", () => {
		writeFiles(storyDir(), { "brief.md": BRIEF_TEMPLATE });
		expect(readBrief(storyDir()).errors).toEqual(
			["Goal", "Success criteria", "Boundaries", "Must never break", "Out of scope"].map(h => `brief: missing or empty section "## ${h}"`),
		);
	});

	test("a missing heading and malformed invariants are named exactly", () => {
		writeFiles(storyDir(), { "brief.md": FILLED_BRIEF.replace("## Boundaries\none line\n", "").replace(/- I1: .+\n- I2: .+/, "* no duplicates") });
		expect(readBrief(storyDir()).errors).toEqual(['brief: missing or empty section "## Boundaries"', "Invariants: list them as `- I1: …` or write `none`"]);
	});

	test("`none` is a valid invariants section", () => {
		writeFiles(storyDir(), { "brief.md": FILLED_BRIEF.replace(/- I1: .+\n- I2: .+/, "none") });
		expect(readBrief(storyDir())).toMatchObject({ errors: [], brief: { invariants: [] } });
	});
});

describe("readPlan", () => {
	const repo = () => path.join(HOME, "work", "shop");
	const plan = (summary: string[], tasks = "- T1: add the table") =>
		`---\nrepos:\n  - ${repo()}\n---\n\n## Summary\n${summary.join("\n")}\n\n## Tasks\n${tasks}\n`;

	test("only the repo list and the summary are approved: editing tasks keeps the digest, editing the summary changes it", () => {
		initGitRepo(repo());
		writeFiles(storyDir(), { "plan.md": plan(["Goal: add orders", "I1: unique index on id"]) });
		const first = readPlan(storyDir());
		expect(first.errors).toEqual([]);
		expect(first.plan?.repos).toEqual([repo()]);

		writeFiles(storyDir(), { "plan.md": plan(["Goal: add orders", "I1: unique index on id"], "- T1: add the table\n- T2: backfill") });
		expect(readPlan(storyDir()).plan?.digest).toBe(first.plan!.digest);

		writeFiles(storyDir(), { "plan.md": plan(["Goal: add orders and refunds", "I1: unique index on id"]) });
		expect(readPlan(storyDir()).plan?.digest).not.toBe(first.plan!.digest);
	});

	test("a summary over 15 lines is rejected with its length", () => {
		initGitRepo(repo());
		writeFiles(storyDir(), { "plan.md": plan(Array.from({ length: 16 }, (_, i) => `line ${i + 1}`)) });
		expect(readPlan(storyDir()).errors).toEqual(["Summary: 16 lines; keep it to 15"]);
	});

	test("a repo entry that is not a repository root is rejected", () => {
		initGitRepo(repo());
		fs.mkdirSync(path.join(repo(), "src"));
		writeFiles(storyDir(), { "plan.md": plan(["Goal"]).replace(repo(), path.join(repo(), "src")) });
		expect(readPlan(storyDir()).errors).toEqual([`repos: ${path.join(repo(), "src")} is not a git repository root`]);
	});
});

describe("protectedLeadPath", () => {
	test("the lead's files are protected; the plan is the agent's", () => {
		const at = (rel: string) => protectedLeadPath(leadDir(), path.join(leadDir(), rel));
		expect(at("stories/S1/brief.md")).toBe(true);
		expect(at("stories/S1/state.json")).toBe(true);
		expect(at("hard-gates.md")).toBe(true);
		expect(at("stories/S1/plan.md")).toBe(false);
	});

	test("a symlinked spelling of the lead folder is protected too", () => {
		fs.mkdirSync(leadDir(), { recursive: true });
		fs.symlinkSync(path.join(HOME, "kb"), path.join(HOME, "link"));
		expect(protectedLeadPath(leadDir(), path.join(HOME, "link", "lead", "system-map.md"))).toBe(false);
		fs.writeFileSync(path.join(leadDir(), "system-map.md"), "x");
		expect(protectedLeadPath(leadDir(), path.join(HOME, "link", "lead", "system-map.md"))).toBe(true);
	});
});
