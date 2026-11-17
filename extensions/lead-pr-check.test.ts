import { beforeEach, describe, expect, test } from "bun:test";
import * as path from "node:path";
import leadPrCheck from "./lead-pr-check";
import { HARD_GATES_TEMPLATE } from "./lib/lead/templates";
import { HOME } from "./lib/state";
import { fakeContext, fakePi, initGitRepo, resetHome, seedKb, seedState, writeFiles } from "./test-harness";

beforeEach(resetHome);

interface Verdict {
	block: boolean;
	reason: string;
}

const GOOD = "## Decision log\n- squash the migration — rejected: two steps (no gain)\n\n## Invariant checklist\nnone\n\n## Risk summary\n- the index build is slow — src/a.ts:3\n";

/** A knowledge base serving ~/work (with hard gates unless `gated` is false) and a repo at ~/work/shop holding PR body files. */
function setup(gated = true) {
	const folder = path.join(HOME, "work");
	const kb = seedKb({ name: "kb", folder });
	seedState({ kb: { status: "done", sources: [kb.source] } });
	if (gated) writeFiles(path.join(kb.root, "lead"), { "hard-gates.md": HARD_GATES_TEMPLATE });
	const repo = path.join(folder, "shop");
	initGitRepo(repo);
	writeFiles(repo, { "src/a.ts": "export const a = 1;\n", "good.md": GOOD, "bad.md": "Adds the index.\n" });
	const fake = fakePi();
	leadPrCheck(fake.pi);
	const ctx = fakeContext({ cwd: repo });
	return (toolName: string, input: Record<string, unknown>) => fake.emit("tool_call", { toolName, input }, ctx) as Verdict | undefined;
}

describe("gh pr create", () => {
	test("needs a body it can read: --fill, --web, no body and stdin are refused", () => {
		const call = setup();
		const noBody = "lead PR check: give the PR body with --body or --body-file (format: ~/kb/lead/pr-format.md)".replace("~", HOME);
		expect(call("bash", { command: "gh pr create --fill" })).toEqual({ block: true, reason: noBody });
		expect(call("bash", { command: "gh pr create --title x" })?.reason).toBe(noBody);
		expect(call("bash", { command: "gh pr create --title x --body-file good.md --web" })?.reason).toBe(noBody);
		expect(call("bash", { command: "cat good.md | gh pr create --title x -F -" })?.reason).toBe("lead PR check: pass the body with --body-file <file>, not stdin");
		expect(call("bash", { command: 'gh pr create --title x --body "$(cat good.md)"' })?.reason).toContain("a shell substitution cannot be checked");
	});

	test("is blocked with every problem of the body, and passes with a body in the format", () => {
		const call = setup();
		expect(call("bash", { command: "gh pr create --title x --body-file bad.md" })).toEqual({
			block: true,
			reason: `lead PR check failed (format: ${HOME}/kb/lead/pr-format.md):\n- Missing section: ## Decision log\n- Missing section: ## Invariant checklist\n- Missing section: ## Risk summary`,
		});
		expect(call("bash", { command: "gh pr create --title x --body-file good.md" })).toBeUndefined();
		expect(call("bash", { command: "gh pr create --title x --body-file=good.md" })).toBeUndefined();
		expect(call("bash", { command: `gh pr create --title x --body "${GOOD}"` })).toBeUndefined();
		expect(call("bash", { command: "cd .. && gh pr create --title x -F shop/good.md" })).toBeUndefined();
	});
});

describe("other ways to set a PR body", () => {
	test("gh pr edit is checked only when it changes the body", () => {
		const call = setup();
		expect(call("bash", { command: "gh pr edit 3 --title x" })).toBeUndefined();
		expect(call("bash", { command: "gh pr edit 3 --body-file bad.md" })?.reason).toContain("lead PR check failed");
		expect(call("bash", { command: "gh pr view 3" })).toBeUndefined();
	});

	test("the github tool's pr_create is checked the same way", () => {
		const call = setup();
		expect(call("github", { op: "pr_create", title: "x" })?.reason).toContain("Missing section: ## Decision log");
		expect(call("github", { op: "pr_create", title: "x", body: GOOD })).toBeUndefined();
		expect(call("github", { op: "repo_view" })).toBeUndefined();
	});
});

test("without hard-gates.md nothing is checked", () => {
	expect(setup(false)("bash", { command: "gh pr create --fill" })).toBeUndefined();
});
