import { describe, expect, test } from "bun:test";
import type { RiskEntry, RiskField, TaskBlock } from "./spec-plan";
import { RISK_FIELDS } from "./spec-risk";
import {
	DIFF_LIMIT,
	SLOT_NAMES,
	SLOTS,
	STOP_VERDICTS,
	VERDICTS,
	type Finding,
	type SlotName,
	buildPrompt,
	findingLines,
	isStopVerdict,
	limitDiff,
	parseVerdict,
	reviewsFor,
	slotTitle,
} from "./spec-slots";

function task(over: Partial<TaskBlock> = {}, yes: RiskField[] = []): TaskBlock {
	const risk = {} as Record<RiskField, RiskEntry>;
	for (const field of RISK_FIELDS) risk[field] = yes.includes(field) ? { value: "yes", reason: `${field} reason` } : { value: "no" };
	return {
		id: "T1", repo: "org/backend", depends_on: [], foundation: false, owns: ["src/a.ts"], new_paths: ["t/a.sh"], reads: ["docs/contract.md"], risk,
		lld_required: false, security_review: false, size: "normal", required_tests: ["duplicate-request"], acceptance: ["refunds are idempotent", "totals add up"], ...over,
	};
}

const finding = (over: Partial<Finding> = {}): Finding => ({ path: "src/a.ts", line: 3, severity: "high", text: "fix it", ...over });

describe("slot table", () => {
	test("every slot names its agent, role and thinking level, and the roles follow the brief", () => {
		expect(SLOT_NAMES).toEqual(["test_author", "test_review", "implementer", "code_review", "security_review"]);
		for (const name of SLOT_NAMES) {
			const slot = SLOTS[name];
			expect(slot.agent).not.toBe("");
			expect(["low", "medium", "high"]).toContain(slot.thinkingLevel);
			expect(["tiny", "task", "slow"]).toContain(slot.modelRole);
		}
		expect(SLOTS.test_author).toMatchObject({ agent: "test-engineer", modelRole: "task", writes: "scope" });
		expect(SLOTS.implementer).toMatchObject({ agent: "task-builder", modelRole: "task", writes: "scope" });
		expect(SLOTS.test_review).toMatchObject({ agent: "code-reviewer", modelRole: "slow", writes: "none" });
		expect(SLOTS.code_review).toMatchObject({ agent: "code-reviewer", modelRole: "slow", writes: "none" });
		expect(SLOTS.security_review).toMatchObject({ agent: "security-auditor", modelRole: "slow", writes: "none" });
	});

	test("no slot can spawn agents, ask, plan, find or reach MCP, and a read-only slot cannot write or run a shell", () => {
		for (const name of SLOT_NAMES) {
			for (const banned of ["task", "ask", "todo", "find", "yield"]) expect(SLOTS[name].tools).not.toContain(banned);
			expect(SLOTS[name].tools.some(tool => tool.startsWith("mcp"))).toBe(false);
			if (SLOTS[name].writes === "none") for (const writing of ["edit", "write", "bash"]) expect(SLOTS[name].tools).not.toContain(writing);
		}
		expect(SLOTS.implementer.tools).toEqual(["read", "glob", "ast_grep", "lsp", "edit", "write", "bash"]);
		expect(SLOTS.code_review.tools).toEqual(["read", "glob", "ast_grep", "lsp"]);
	});

	test("each schema is a closed object whose verdict enum is the slot's verdict list", () => {
		for (const name of SLOT_NAMES) {
			const schema = JSON.parse(JSON.stringify(SLOTS[name].schema)) as { type: string; additionalProperties: boolean; required: string[]; properties: { verdict: { enum: string[] } } };
			expect(schema.type).toBe("object");
			expect(schema.additionalProperties).toBe(false);
			expect(schema.properties.verdict.enum).toEqual([...VERDICTS[name]]);
			expect(schema.required).toContain("verdict");
			expect(SLOTS[name].verdicts).toEqual(VERDICTS[name]);
		}
	});

	test("stop verdicts are the ones that open a gate", () => {
		expect([...STOP_VERDICTS].sort()).toEqual(["blocked", "need_clarification", "need_shared_change", "spec_wrong", "test_wrong"]);
		for (const stop of STOP_VERDICTS) expect(isStopVerdict(stop)).toBe(true);
		for (const other of ["pass", "fix", "", "Pass"]) expect(isStopVerdict(other)).toBe(false);
	});

	test("the session title tags the story, task and slot", () => {
		expect(slotTitle("PAC2-1", "T01", "implementer")).toBe("spec:PAC2-1:T01:implementer");
	});

	test("reviewsFor: a code review for any technical risk, a security review when the plan flags it", () => {
		expect(reviewsFor(task())).toEqual([]);
		expect(reviewsFor(task({}, ["sensitive_data"]))).toEqual([]);
		expect(reviewsFor(task({}, ["retries"]))).toEqual(["code_review"]);
		expect(reviewsFor(task({ security_review: true }, ["sensitive_data"]))).toEqual(["security_review"]);
		expect(reviewsFor(task({ security_review: true }, ["external_io", "multi_step_saga"]))).toEqual(["code_review", "security_review"]);
	});
});

const ACCEPT = { refunds: "t/refund.sh" };

/** One valid payload per slot and verdict value. */
const VALID: Record<SlotName, Record<string, unknown>> = {
	test_author: Object.fromEntries(VERDICTS.test_author.map(verdict => [verdict, { verdict, tests: ["t/a.sh"], acceptance_map: ACCEPT, notes: "n" }])),
	test_review: {
		pass: { verdict: "pass", unmapped: [], findings: [] },
		fix: { verdict: "fix", unmapped: ["criterion 2"], findings: ["weak assert"] },
		spec_wrong: { verdict: "spec_wrong", unmapped: [], findings: ["contradiction"] },
	},
	implementer: Object.fromEntries(VERDICTS.implementer.map(verdict => [verdict, { verdict, notes: "done", checks_run: ["bun test"] }])),
	code_review: {
		pass: { verdict: "pass", findings: [] },
		fix: { verdict: "fix", findings: [finding()] },
		spec_wrong: { verdict: "spec_wrong", findings: [finding({ severity: "low" })] },
	},
	security_review: {
		pass: { verdict: "pass", findings: [finding({ severity: "low", category: "other" })] },
		fix: { verdict: "fix", findings: [finding({ severity: "critical", line: undefined, category: "patient_data" })] },
		spec_wrong: { verdict: "spec_wrong", findings: [finding({ category: "other" })] },
	},
};

describe("parseVerdict: every verdict value of every slot", () => {
	for (const slot of SLOT_NAMES) {
		for (const verdict of VERDICTS[slot]) {
			test(`${slot} accepts ${verdict}, as an object and as a JSON string`, () => {
				const payload = VALID[slot][verdict];
				const parsed = parseVerdict(slot, payload);
				expect(parsed.ok).toBe(true);
				if (parsed.ok) expect(parsed.value.verdict).toBe(verdict);
				const encoded = parseVerdict(slot, JSON.stringify(payload));
				expect(encoded.ok).toBe(true);
				if (parsed.ok && encoded.ok) expect(encoded.value).toEqual(parsed.value);
			});
		}
		test(`${slot} rejects a verdict value of another slot, an unknown one and a missing one`, () => {
			const other = SLOT_NAMES.filter(name => name !== slot).flatMap(name => VERDICTS[name]).find(verdict => !(VERDICTS[slot] as readonly string[]).includes(verdict));
			const base = VALID[slot].pass;
			for (const verdict of [other, "approve", "", undefined, 3]) {
				const parsed = parseVerdict(slot, { ...(base as object), verdict });
				expect(parsed.ok).toBe(false);
				if (!parsed.ok) expect(parsed.error).toContain('"verdict" must be one of');
			}
		});
	}

	test("payloads that are not an object are rejected with a reason", () => {
		const reasons = [
			[undefined, "yielded no payload"],
			[null, "yielded no payload"],
			[[1], "not a JSON object"],
			[7, "not a JSON object"],
			["not json", "not valid JSON"],
			["[1]", "not a JSON object"],
			["null", "yielded no payload"],
		] as const;
		for (const [payload, reason] of reasons) {
			const parsed = parseVerdict("implementer", payload);
			expect(parsed.ok).toBe(false);
			if (!parsed.ok) expect(parsed.error).toContain(reason);
		}
	});
});

describe("parseVerdict: fields", () => {
	const error = (slot: SlotName, payload: unknown): string => {
		const parsed = parseVerdict(slot, payload);
		if (parsed.ok) throw new Error("expected the payload to be rejected");
		return parsed.error;
	};

	test("test_author: strings, a criterion map and an optional note", () => {
		const ok = parseVerdict("test_author", { verdict: "pass", tests: ["a"], acceptance_map: ACCEPT });
		expect(ok).toEqual({ ok: true, value: { verdict: "pass", tests: ["a"], acceptance_map: ACCEPT, notes: "" } });
		expect(error("test_author", { verdict: "pass", acceptance_map: ACCEPT })).toContain('"tests"');
		expect(error("test_author", { verdict: "pass", tests: ["a", 2], acceptance_map: ACCEPT })).toContain('"tests"');
		expect(error("test_author", { verdict: "pass", tests: [], acceptance_map: ["x"] })).toContain('"acceptance_map"');
		expect(error("test_author", { verdict: "pass", tests: [], acceptance_map: { a: 1 } })).toContain('"acceptance_map"');
		expect(error("test_author", { verdict: "pass", tests: [], acceptance_map: {}, notes: 4 })).toContain('"notes"');
	});

	test("test_review: unmapped and findings are string arrays, and fix needs something to fix", () => {
		expect(error("test_review", { verdict: "pass", findings: [] })).toContain('"unmapped"');
		expect(error("test_review", { verdict: "pass", unmapped: [], findings: [1] })).toContain('"findings"');
		expect(error("test_review", { verdict: "fix", unmapped: [], findings: [] })).toContain("needs at least one finding");
		expect(parseVerdict("test_review", { verdict: "fix", unmapped: ["c"], findings: [] }).ok).toBe(true);
		expect(parseVerdict("test_review", { verdict: "fix", unmapped: [], findings: ["f"] }).ok).toBe(true);
	});

	test("implementer: notes and checks_run are required", () => {
		expect(error("implementer", { verdict: "pass", checks_run: [] })).toContain('"notes"');
		expect(error("implementer", { verdict: "pass", notes: "x" })).toContain('"checks_run"');
		expect(error("implementer", { verdict: "pass", notes: "x", checks_run: "bun test" })).toContain('"checks_run"');
	});

	test("reviews: finding shape, severity values, integer lines, and fix needs a finding", () => {
		expect(error("code_review", { verdict: "pass" })).toContain('"findings"');
		expect(error("code_review", { verdict: "pass", findings: [{ path: "a", text: "t" }] })).toContain("severity");
		expect(error("code_review", { verdict: "pass", findings: [{ path: "a", severity: "urgent", text: "t" }] })).toContain("severity");
		expect(error("code_review", { verdict: "pass", findings: [{ path: "a", severity: "low" }] })).toContain("path and a string text");
		expect(error("code_review", { verdict: "pass", findings: [{ path: "a", severity: "low", text: "t", line: 1.5 }] })).toContain("integer");
		expect(error("code_review", { verdict: "pass", findings: ["text"] })).toContain("path and a string text");
		expect(error("security_review", { verdict: "fix", findings: [] })).toContain("needs at least one finding");
		const parsed = parseVerdict("code_review", { verdict: "pass", findings: [{ path: "a", severity: "low", text: "t", line: null, extra: 1 }] });
		expect(parsed).toEqual({ ok: true, value: { verdict: "pass", findings: [{ path: "a", severity: "low", text: "t" }] } });
	});

	test("security findings need a category and code_review findings do not", () => {
		const bare = { path: "a", severity: "low", text: "t" } as const;
		expect(error("security_review", { verdict: "pass", findings: [bare] })).toContain("category");
		expect(error("security_review", { verdict: "pass", findings: [{ ...bare, category: "pii" }] })).toContain("category");
		expect(error("security_review", { verdict: "pass", findings: [{ ...bare, category: null }] })).toContain("category");
		expect(error("security_review", { verdict: "fix", findings: [{ ...bare, category: "other" }, bare] })).toContain("findings[1].category");
		expect(parseVerdict("security_review", { verdict: "fix", findings: [{ ...bare, category: "patient_data" }, { ...bare, category: "other" }] })).toEqual({
			ok: true,
			value: { verdict: "fix", findings: [{ ...bare, category: "patient_data" }, { ...bare, category: "other" }] },
		});
		// A code review never has one: the field is neither required nor kept.
		expect(parseVerdict("code_review", { verdict: "pass", findings: [bare] })).toEqual({ ok: true, value: { verdict: "pass", findings: [bare] } });
		expect(parseVerdict("code_review", { verdict: "pass", findings: [{ ...bare, category: "patient_data" }] })).toEqual({ ok: true, value: { verdict: "pass", findings: [bare] } });

		// The strict schemas say the same: required and closed for security, absent for code review.
		const items = (slot: "code_review" | "security_review") =>
			(JSON.parse(JSON.stringify(SLOTS[slot].schema)) as { properties: { findings: { items: { required: string[]; additionalProperties: boolean; properties: Record<string, { enum?: string[] }> } } } }).properties.findings.items;
		expect(items("security_review").required).toEqual(["path", "severity", "text", "category"]);
		expect(items("security_review").additionalProperties).toBe(false);
		expect(items("security_review").properties.category.enum).toEqual(["patient_data", "other"]);
		expect(items("code_review").required).toEqual(["path", "severity", "text"]);
		expect(items("code_review").properties.category).toBeUndefined();
	});

	test("the first problem is the one reported", () => {
		expect(error("implementer", { verdict: "nope", checks_run: 3 })).toContain('"verdict"');
	});
});

describe("findingLines and limitDiff", () => {
	test("findings read as one line each, with the line number when there is one", () => {
		expect(findingLines([finding(), finding({ line: undefined, severity: "low", path: "b.ts", text: "x" })])).toEqual(["[high] src/a.ts:3: fix it", "[low] b.ts: x"]);
	});

	test("a diff over the limit is cut with a note that counts what is missing", () => {
		expect(limitDiff("short")).toBe("short");
		const cut = limitDiff("x".repeat(30), 10);
		expect(cut.startsWith("x".repeat(10))).toBe(true);
		expect(cut).toContain("[diff cut: 20 more characters");
		expect(DIFF_LIMIT).toBe(80_000);
	});
});

describe("buildPrompt", () => {
	const base = { story: "PAC2-1", planFile: "/vault/Specs/PAC2/plan.md", planRev: "abc123", cwd: "/tmp/wt/T1" };
	const prompt = (over: Partial<Parameters<typeof buildPrompt>[0]> & { slot: SlotName }) => buildPrompt({ ...base, tasks: [task()], ...over });

	test("every slot's prompt names the paths, the acceptance criteria and the yield shape, and never reads as a command", () => {
		for (const slot of SLOT_NAMES) {
			const text = prompt({ slot });
			expect(text.startsWith("/")).toBe(false);
			expect(text).toContain("Working directory: /tmp/wt/T1");
			expect(text).toContain("Plan: /vault/Specs/PAC2/plan.md at revision abc123");
			expect(text).toContain("1. refunds are idempotent");
			expect(text).toContain("2. totals add up");
			expect(text).toContain("- duplicate-request");
			expect(text).toContain("Call `yield` with `data` shaped like:");
			for (const verdict of VERDICTS[slot]) expect(text).toContain(`\`${verdict}\`:`);
			expect(text).toContain("Never run a git command that changes state");
		}
	});

	test("writers list the files they may write and read; reviewers do not", () => {
		for (const slot of ["test_author", "implementer"] as const) {
			const text = prompt({ slot });
			expect(text).toContain("Files you may write (owns, then new_paths):\n- src/a.ts\n- t/a.sh");
			expect(text).toContain("Files you may read for context:\n- docs/contract.md");
		}
		for (const slot of ["test_review", "code_review", "security_review"] as const) expect(prompt({ slot })).not.toContain("Files you may write");
	});

	test("risks marked yes are listed with their reasons", () => {
		const text = prompt({ slot: "code_review", tasks: [task({}, ["retries", "external_io"])] });
		expect(text).toContain("- retries: retries reason");
		expect(text).toContain("- external_io: external_io reason");
		expect(prompt({ slot: "code_review" })).toContain("Risks marked yes:\n- none");
	});

	test("locked files, the task's test files and the check commands appear when given", () => {
		const text = prompt({ slot: "implementer", phase: "implement", lockedFiles: ["t/a.sh", "t/b.sh"], testFiles: ["t/a.sh"], checks: { test: "bun test", lint: "", typecheck: "tsc" } });
		expect(text).toContain("## Locked tests (frozen; you cannot edit them)\n- t/a.sh\n- t/b.sh");
		expect(text).toContain("## The task's test files\n- t/a.sh");
		expect(text).toContain("## Checks the scheduler runs after your run\n- test: bun test\n- typecheck: tsc");
		expect(text).not.toContain("lint:");
		expect(text).toContain("The locked tests are frozen");
		expect(prompt({ slot: "implementer", phase: "implement" })).not.toContain("## Locked tests");
	});

	test("prior findings, human notes and the attempt number are carried to the next run", () => {
		const text = prompt({ slot: "implementer", findings: ["test failed: exit 1", "[high] src/a.ts:3: fix it"], notes: ["use the v2 endpoint"], attempt: { n: 2, of: 3 } });
		expect(text).toContain("This is attempt 2 of 3.");
		expect(text).toContain("## To fix from the previous run");
		expect(text).toContain("- test failed: exit 1\n- [high] src/a.ts:3: fix it");
		expect(text).toContain("## Notes from the human who owns this task\n- use the v2 endpoint");
		const first = prompt({ slot: "implementer" });
		expect(first).not.toContain("To fix from the previous run");
		expect(first).not.toContain("Notes from the human");
	});

	test("the small-task implementer writes tests first, then implements", () => {
		expect(prompt({ slot: "implementer", phase: "tests" })).toContain("tests first (a small task)");
		expect(prompt({ slot: "implementer", phase: "implement" })).toContain("Make the locked tests pass");
	});

	test("a review carries the diff, cut when it is long, and the story review lists every task", () => {
		const text = prompt({ slot: "code_review", diff: { text: "+added line", from: "main" } });
		expect(text).toContain("## Diff (against main)\n```diff\n+added line\n```");
		const long = prompt({ slot: "code_review", diff: { text: "x".repeat(DIFF_LIMIT + 5), from: "abc" } });
		expect(long).toContain("[diff cut: 5 more characters");
		const story = prompt({ slot: "code_review", scope: "story", tasks: [task({ id: "T1" }), task({ id: "T2", acceptance: ["second one"] })] });
		expect(story).toContain("### Task T1");
		expect(story).toContain("### Task T2");
		expect(story).toContain("1. second one");
		expect(story).toContain("code reviewer for the whole pull request");
		expect(story).toContain("Review every task above as one change.");
	});

	test("the LLD path or the reason it was skipped is stated", () => {
		expect(prompt({ slot: "implementer", lldFile: "/vault/lld/T1.md" })).toContain("LLD: /vault/lld/T1.md");
		expect(prompt({ slot: "implementer", tasks: [task({ lld_skip_reason: "mechanical" })] })).toContain("LLD skipped: mechanical");
	});

	test("the security prompt defines patient_data and says to cite, not quote", () => {
		const security = prompt({ slot: "security_review" });
		expect(security).toContain('"category": "patient_data|other"');
		expect(security).toContain("`patient_data`");
		for (const place of ["logs", "errors", "fixtures", "test data", "prompts", "third-party"]) expect(security).toContain(place);
		expect(security).toMatch(/cite the file and line/i);
		expect(security).toMatch(/never quote the data/i);
		expect(prompt({ slot: "code_review" })).not.toContain("patient_data");
	});
});
