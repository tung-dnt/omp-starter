import { beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { HOME } from "../state";
import { initGitRepo, resetHome, writeFiles } from "../../test-harness";
import { approvalDigest, freshnessLines, initLead, leadLayout, leadReady, protectedLeadPath, readBrief, readHardGates, readPlan, readProjectNote } from "./artifacts";
import { BRIEF_TEMPLATE, HARD_GATES_TEMPLATE, PROJECT_NOTE_BLOCK } from "./templates";

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

	test("checks: per-repository commands with defaults; a wrong type names its key and falls back to the last good copy", () => {
		const withChecks = (checks: string) => HARD_GATES_TEMPLATE.replace("checks: {}", checks);
		writeFiles(leadDir(), {
			"hard-gates.md": withChecks(
				'checks:\n  shop:\n    verify: ["bun run lint"]\n    test: ["bun test"]\n    gh: gh-blinx\n    ignored_checks: ["Approve Deployment"]\n    acceptance: { deploy_wait: "wait-for-stack {branch}", env: { STACK: "https://{story}.example" } }\n  cart: { verify: ["true"], test: ["true"] }',
			),
		});
		expect(readHardGates(leadDir()).gates?.checks).toEqual({
			shop: {
				verify: ["bun run lint"],
				test: ["bun test"],
				timeoutSeconds: 900,
				gh: "gh-blinx",
				ignoredChecks: ["Approve Deployment"],
				acceptance: { deployWait: "wait-for-stack {branch}", env: { STACK: "https://{story}.example" }, timeoutSeconds: 1800 },
			},
			cart: { verify: ["true"], test: ["true"], timeoutSeconds: 900, gh: "gh", ignoredChecks: [] },
		});

		writeFiles(leadDir(), { "hard-gates.md": withChecks('checks:\n  shop: { verify: [], test: ["bun test"] }') });
		const { gates, error } = readHardGates(leadDir());
		expect(error).toContain("checks.shop.verify: expected at least one command");
		expect(gates?.checks.shop.verify).toEqual(["bun run lint"]);
	});
});

describe("readProjectNote", () => {
	const notesDir = () => path.join(HOME, "kb", "projects");
	const read = (body: string) => {
		writeFiles(notesDir(), { "shop.md": body });
		return readProjectNote(notesDir(), "shop");
	};

	test("reads the services and standing invariants from the first yaml block that has services, with snake_case keys and defaults", () => {
		const block = PROJECT_NOTE_BLOCK.replace("owns_tables: []", "owns_tables: [orders]").replace("invariants: []", "invariants:\n  - Orders are never deleted");
		expect(read(`# shop\n\n\`\`\`yaml\nstages: [dev]\n\`\`\`\n\n${block}\n`).note).toMatchObject({
			services: [{ name: "example-api", repo: "shop", path: "", ownsTables: ["orders"], publishes: [], consumes: [], calls: [] }],
			invariants: ["Orders are never deleted"],
		});
	});

	test("a missing note, a note without a services block and a service claiming another repository each say what is wrong", () => {
		expect(readProjectNote(notesDir(), "shop").error).toBe("project note missing: ~/kb/projects/shop.md");
		expect(read("# shop\n\n```yaml\nstages: [dev]\n```\n").error).toBe("project note ~/kb/projects/shop.md: no ```yaml block with services:");
		expect(read(PROJECT_NOTE_BLOCK.replace("name: example-api,", "name: example-api, repo: other,")).error).toBe(
			"project note ~/kb/projects/shop.md: service example-api.repo: this note describes shop; leave repo out",
		);
	});
});

describe("freshnessLines", () => {
	test("the notes of the plan's repositories come first, named after the origin, then the lead's own notes in the policy folder", () => {
		const shop = path.join(HOME, "work", "shop");
		const other = path.join(HOME, "work", "other");
		initGitRepo(shop, "git@github.com:acme/shop-api.git");
		initGitRepo(other);
		writeFiles(path.join(HOME, "kb"), {
			"projects/shop-api.md": "---\nupdated: 2026-06-12\n---\n\nRuns on Lambda (inferred — verify).\n",
			"company/security-policy.md": "---\nupdated: 2026-06-05\n---\n\n- Retention (inferred — verify retention periods)\n- Owner (inferred — verify process owner)\n",
			"company/review-checklist.md": "# Checklist\n",
			"company/hard-gates.md": HARD_GATES_TEMPLATE,
			"company/pr-format.md": "generated\n",
			"company/retro-log.md": "log\n",
		});
		expect(freshnessLines(leadLayout({ kbRef: "~/kb", lead: { policy: "company" } }), [shop, other], "2026-11-18")).toEqual([
			"shop-api: updated 2026-06-12 (159 days ago), 1 unverified",
			"other: missing",
			"review-checklist: no updated: date, 0 unverified",
			"security-policy: updated 2026-06-05 (166 days ago), 2 unverified",
		]);
	});
});

const FILLED_BRIEF = BRIEF_TEMPLATE.replace("- I1: …", "- I1: inserts are idempotent on id\n- I2: totals never go negative").replace(
	/^(## (?!Invariants).+)$/gm,
	"$1\none line",
);

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
		expect(readBrief(storyDir()).errors).toEqual(["Goal", "Boundaries", "Must never break", "Out of scope"].map(h => `brief: missing or empty section "## ${h}"`));
	});

	test("criteria are read as `- AC<n>: …` lines and are required", () => {
		writeFiles(storyDir(), { "brief.md": FILLED_BRIEF.replace("- AC1: …", "- AC1: orders are listed\n- AC2: refunds are listed") });
		expect(readBrief(storyDir()).brief?.acs).toEqual([
			{ id: "AC1", text: "orders are listed" },
			{ id: "AC2", text: "refunds are listed" },
		]);
		writeFiles(storyDir(), { "brief.md": FILLED_BRIEF.replace("- AC1: …", "") });
		expect(readBrief(storyDir()).errors).toEqual(["Success criteria: list each as `- AC1: …`"]);
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
	const row = '{ ac: AC1, repo: shop, test: { run: "sh t.sh", files: [t.sh] } }';
	const plan = (summary: string[], tasks = "- T1: add the table", proofRow = row) =>
		`---\nrepos:\n  - ${repo()}\n---\n\n## Summary\n${summary.join("\n")}\n\n## Tasks\n${tasks}\n\n## Proof\n\`\`\`yaml\nproof:\n  - ${proofRow}\n\`\`\`\n`;

	test("the approval covers the repos and the brief's invariants and boundaries, not the plan's summary or tasks", () => {
		initGitRepo(repo());
		initGitRepo(`${repo()}-two`);
		const digest = (planText: string, briefText = FILLED_BRIEF) => {
			writeFiles(storyDir(), { "plan.md": planText, "brief.md": briefText });
			const { plan, errors } = readPlan(storyDir());
			expect(errors).toEqual([]);
			return approvalDigest(plan!, readBrief(storyDir()).brief!);
		};
		const first = digest(plan(["Goal: add orders", "I1: unique index on id"]));
		expect(readPlan(storyDir()).plan?.repos).toEqual([repo()]);

		expect(digest(plan(["Goal: add orders and refunds", "I1: a lock instead"], "- T1: add the table\n- T2: backfill"))).toBe(first);
		expect(digest(plan(["Goal: add orders"]), FILLED_BRIEF.replace("## Goal\none line", "## Goal\nanother goal"))).toBe(first);

		expect(digest(plan(["Goal: add orders"]).replace(`  - ${repo()}\n`, `  - ${repo()}\n  - ${repo()}-two\n`))).not.toBe(first);
		expect(digest(plan(["Goal: add orders"]), FILLED_BRIEF.replace("totals never go negative", "totals may go negative"))).not.toBe(first);
		expect(digest(plan(["Goal: add orders"]), FILLED_BRIEF.replace("## Boundaries\none line", "## Boundaries\nonly the orders service"))).not.toBe(first);
	});

	test("the approval covers what is proven and how, not the proof commands", () => {
		initGitRepo(repo());
		const digest = (proofRow: string) => {
			writeFiles(storyDir(), { "plan.md": plan(["Goal"], "- T1", proofRow), "brief.md": FILLED_BRIEF });
			const { plan: read, errors } = readPlan(storyDir());
			expect(errors).toEqual([]);
			return approvalDigest(read!, readBrief(storyDir()).brief!);
		};
		expect(digest(row.replace("sh t.sh", "sh other.sh"))).toBe(digest(row));
		expect(digest('{ ac: AC1, unprovable: "needs EMIS sandbox" }')).not.toBe(digest(row));
		expect(digest('{ ac: AC1, repo: shop, acceptance: { run: "sh a.sh" } }')).not.toBe(digest(row));
	});

	test("a proof row is checked field by field", () => {
		initGitRepo(repo());
		const errors = (proofRow: string) => {
			writeFiles(storyDir(), { "plan.md": plan(["Goal"], "- T1", proofRow) });
			return readPlan(storyDir()).errors;
		};
		expect(errors('{ ac: AC1, unprovable: "no sandbox", test: { run: "x", files: [t.sh] } }')).toEqual(["proof[0]: unprovable excludes test and acceptance"]);
		expect(errors('{ ac: first, repo: shop, test: { run: "x", files: [t.sh] } }')).toEqual(["proof[0]: ac: expected AC<n>"]);
		expect(errors("{ ac: AC1, test: { run: x, files: [t.sh] } }")).toEqual(["proof[0]: repo: expected the repository's origin basename"]);
		expect(errors("{ ac: AC1, repo: shop }")).toEqual(["proof[0]: needs test, acceptance or unprovable"]);
		expect(errors("{ ac: AC1, repo: shop, test: { run: x, files: [] } }")).toEqual(["proof[0]: test.files: list the test files to copy onto the base commit"]);
		writeFiles(storyDir(), { "plan.md": plan(["Goal"]).replace(/\n## Proof[\s\S]*$/, "\n") });
		expect(readPlan(storyDir()).errors).toEqual(['plan: missing "## Proof" with a ```yaml proof: list']);
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

describe("leadLayout", () => {
	const kbRef = "~/kb";
	const kb = () => path.join(HOME, "kb");

	test("everything is under lead/ unless the knowledge base's lead setting names other folders", () => {
		const notes = path.join(kb(), "projects");
		expect(leadLayout({ kbRef })).toEqual({ policy: path.join(kb(), "lead"), stories: path.join(kb(), "lead", "stories"), templates: path.join(kb(), "lead"), notes });
		expect(leadLayout({ kbRef, lead: { stories: "projects", policy: "company", templates: "_templates" } })).toEqual({
			policy: path.join(kb(), "company"),
			stories: path.join(kb(), "projects"),
			templates: path.join(kb(), "_templates"),
			notes,
		});
		expect(leadLayout({ kbRef, lead: { stories: "projects" } }).policy).toBe(path.join(kb(), "lead"));
	});

	test("/starter lead writes each file to its folder, keeps the notes already there, and only then is the workflow on", () => {
		const layout = leadLayout({ kbRef, lead: { stories: "projects", policy: "company", templates: "_templates" } });
		writeFiles(kb(), { "company/security-policy.md": "policy\n", "_templates/project-note.md": "note\n" });
		expect(leadReady(layout)).toBe(false);
		const { created } = initLead(layout);
		expect(created.map(file => path.relative(kb(), file)).sort()).toEqual([
			"_templates/brief-template.md",
			"company/hard-gates.md",
			"company/pr-format.md",
		]);
		expect(fs.readdirSync(kb()).sort()).toEqual(["_templates", "company", "projects"]);
		expect(fs.readFileSync(path.join(kb(), "company", "security-policy.md"), "utf8")).toBe("policy\n");
		expect(leadReady(layout)).toBe(true);
	});
});

describe("protectedLeadPath", () => {
	const layout = () => leadLayout({ kbRef: "~/kb" });

	test("the lead's files are protected; the plan and the project notes are the agent's to keep current", () => {
		const at = (rel: string) => protectedLeadPath(layout(), path.join(leadDir(), rel));
		expect(at("stories/S1/brief.md")).toBe(true);
		expect(at("stories/S1/state.json")).toBe(true);
		expect(at("hard-gates.md")).toBe(true);
		expect(at("brief-template.md")).toBe(true);
		expect(at("stories/S1/plan.md")).toBe(false);
		expect(protectedLeadPath(layout(), path.join(HOME, "kb", "projects", "shop.md"))).toBe(false);
	});

	test("in folders shared with other notes, only the lead's file names are protected, each in its own folder", () => {
		const shared = leadLayout({ kbRef: "~/kb", lead: { stories: "projects", policy: "company", templates: "_templates" } });
		const at = (rel: string) => protectedLeadPath(shared, path.join(HOME, "kb", rel));
		expect(at("projects/S1/brief.md")).toBe(true);
		expect(at("projects/S1/status.md")).toBe(true);
		expect(at("company/hard-gates.md")).toBe(true);
		expect(at("company/retro-log.md")).toBe(true);
		expect(at("_templates/brief-template.md")).toBe(true);
		expect(at("projects/S1/plan.md")).toBe(false);
		expect(at("projects/S1/t01-design.md")).toBe(false);
		expect(at("projects/paco24.md")).toBe(false);
		expect(at("projects/S1/notes/brief.md")).toBe(false);
		expect(at("company/security-policy.md")).toBe(false);
		expect(at("company/brief-template.md")).toBe(false);
		expect(at("_templates/hard-gates.md")).toBe(false);
		expect(at("lead/hard-gates.md")).toBe(false);
	});

	test("a symlinked spelling of the lead folder is protected too", () => {
		fs.mkdirSync(leadDir(), { recursive: true });
		fs.symlinkSync(path.join(HOME, "kb"), path.join(HOME, "link"));
		expect(protectedLeadPath(layout(), path.join(HOME, "link", "lead", "hard-gates.md"))).toBe(false);
		fs.writeFileSync(path.join(leadDir(), "hard-gates.md"), "x");
		expect(protectedLeadPath(layout(), path.join(HOME, "link", "lead", "hard-gates.md"))).toBe(true);
	});
});
