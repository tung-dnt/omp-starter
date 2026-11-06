import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { type ParseResult, type Plan, type RiskEntry, type RiskField, type TaskBlock, parsePlan } from "./spec-plan";
import { IMPLIED_TESTS, RISK_FIELDS, routeRisk } from "./spec-risk";
import { type Violation, validatePlan } from "./spec-validate";

const SCRIPT = resolve(import.meta.dir, "../../scripts/validate-plan.ts");
const FENCE = "`".repeat(3);

const BACKEND_FILES = ["db/migrations/001.sql", "src/refund/handler.ts", "src/shared/util.ts", "src/orders/api.ts", "package.json", "README.md"];

/** Files keyed by the repo the `task()` helper puts tasks in. */
const byRepo = (files: readonly string[]) => new Map([["org/backend", files]]);
const FILES = byRepo(BACKEND_FILES);

/** Risk answers: every field `no` except those named, which are `yes` with the given reason. */
function risk(yes: Partial<Record<RiskField, string>> = {}): Record<RiskField, RiskEntry> {
	const out = {} as Record<RiskField, RiskEntry>;
	for (const field of RISK_FIELDS) {
		const reason = yes[field];
		out[field] = reason === undefined ? { value: "no" } : { value: "yes", reason };
	}
	return out;
}

function task(id: string, over: Partial<TaskBlock> = {}): TaskBlock {
	return {
		id, repo: "org/backend", depends_on: [], foundation: false, owns: [], new_paths: [], reads: [],
		risk: risk(), lld_required: false, security_review: false, size: "normal", required_tests: [], acceptance: ["it works"],
		...over,
	};
}

/** A task whose routing fields already agree with its risks, so only the change under test can fail. */
function routed(id: string, yes: Partial<Record<RiskField, string>>, over: Partial<TaskBlock> = {}): TaskBlock {
	const risks = risk(yes);
	const route = routeRisk(risks);
	return task(id, { risk: risks, lld_required: route.lld_required, security_review: route.security_review, required_tests: route.implied_tests, lld: "lld/x.md", ...over });
}

/** A story plan whose `checks` declare a `test` for every repo the tasks use, unless `over` says otherwise. */
function plan(tasks: TaskBlock[], over: Partial<Plan> = {}): Plan {
	const checks = Object.fromEntries(tasks.map(t => [t.repo, { test: "go test ./..." }]));
	return { id: "S-1", kind: "story", shared_paths: [], checks, tasks, ...over };
}

const only = (violations: Violation[]) => violations.map(v => `${v.rule}${v.task ? `:${v.task}` : ""}`);

describe("parsePlan", () => {
	const block = (info: string, body: string) => `${FENCE}${info}\n${body}\n${FENCE}`;
	const PLAN_YAML = "id: S-1\nkind: story\nshared_paths: [db/migrations/**]";
	const TASK_LINES: Record<string, string> = {
		id: "id: T01",
		repo: "repo: org/backend",
		depends_on: "depends_on: []",
		foundation: "foundation: true",
		owns: "owns: [db/migrations/**]",
		new_paths: "new_paths: []",
		reads: "reads: [src/**]",
		risk: `risk:\n${RISK_FIELDS.map(f => `  ${f}: ${f === "shared_state" ? "{value: yes, reason: adds refund table}" : "{value: no}"}`).join("\n")}`,
		lld_required: "lld_required: true",
		security_review: "security_review: false",
		lld: "lld: lld/T01.md",
		required_tests: "required_tests: [concurrent-writes]",
		acceptance: 'acceptance: ["refund table exists"]',
		lld_skip_reason: 'lld_skip_reason: ""    # only when lld_required and no lld',
	};
	const taskYaml = (over: Record<string, string | null> = {}) =>
		Object.entries({ ...TASK_LINES, ...over }).flatMap(([, line]) => (line === null ? [] : [line])).join("\n");
	const doc = (...parts: string[]) => parts.join("\n\n");

	test("reads the documented format and ignores prose and other fences", () => {
		const markdown = doc(
			"# Plan\nProse mentioning yaml plan is ignored.",
			block("yaml", "id: not-a-plan"),
			block("yaml plan", PLAN_YAML),
			"Between blocks.",
			block("yaml task", taskYaml()),
			`${FENCE}${FENCE}markdown\n${block("yaml task", "id: example-only")}\n${FENCE}${FENCE}`,
		);
		const result = parsePlan(markdown);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.plan.id).toBe("S-1");
		expect(result.plan.shared_paths).toEqual(["db/migrations/**"]);
		expect(result.plan.tasks.map(t => t.id)).toEqual(["T01"]);
		expect(result.plan.tasks[0].risk.shared_state).toEqual({ value: "yes", reason: "adds refund table" });
		expect(result.plan.tasks[0].lld_skip_reason).toBe("");
	});

	test("parse: no plan block", () => {
		const result = parsePlan(block("yaml task", taskYaml()));
		expect(result.ok).toBe(false);
		if (!result.ok) expect(only(result.errors)).toEqual(["parse"]);
	});

	test("parse: two plan blocks", () => {
		const result = parsePlan(doc(block("yaml plan", PLAN_YAML), block("yaml plan", PLAN_YAML)));
		expect(result.ok).toBe(false);
		if (!result.ok) expect(only(result.errors)).toEqual(["parse"]);
	});

	test("parse: a fence that is never closed", () => {
		const result = parsePlan(doc(block("yaml plan", PLAN_YAML), `${FENCE}yaml task\n{id: X}${FENCE}\n`));
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(only(result.errors)).toEqual(["parse"]);
		expect(result.errors[0].detail).toContain("block 2 (yaml task): fence is never closed");
		const plainPlan = parsePlan(`${FENCE}yaml plan\n${PLAN_YAML}\n`);
		expect(plainPlan.ok).toBe(false);
		if (!plainPlan.ok) expect(plainPlan.errors.map(v => v.detail)).toEqual(["block 1 (yaml plan): fence is never closed"]);
	});

	test("parse: YAML syntax error names the block", () => {
		const result = parsePlan(doc(block("yaml plan", PLAN_YAML), block("yaml task", "id: [")));
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(only(result.errors)).toEqual(["parse"]);
			expect(result.errors[0].detail).toContain("block 2 (yaml task)");
		}
	});

	const cases: Array<[string, Record<string, string | null>, string]> = [
		["a missing field", { acceptance: null }, 'missing field "acceptance"'],
		["a wrongly typed field", { foundation: 'foundation: "yes"' }, 'field "foundation" must be a boolean'],
		["a risk value that is not yes or no", { risk: "risk:\n  shared_state: {value: maybe}" }, 'risk "shared_state" needs value'],
		["an unknown risk field", { risk: `${TASK_LINES.risk}\n  telepathy: {value: no}` }, 'unknown risk field "telepathy"'],
	];
	for (const [name, over, detail] of cases) {
		test(`field: ${name}`, () => {
			const result = parsePlan(doc(block("yaml plan", PLAN_YAML), block("yaml task", taskYaml(over))));
			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.errors.filter(v => v.rule === "field").length).toBeGreaterThan(0);
			expect(result.errors.every(v => v.rule === "field" && v.task === "T01")).toBe(true);
			expect(result.errors.some(v => v.detail.includes(detail))).toBe(true);
		});
	}

	test("field: a plan block with a bad kind", () => {
		const result = parsePlan(doc(block("yaml plan", "id: S-1\nkind: epic\nshared_paths: []"), block("yaml task", taskYaml())));
		expect(result.ok).toBe(false);
		if (!result.ok) expect(only(result.errors)).toEqual(["field"]);
	});

	test("size defaults to normal and accepts small", () => {
		const parsed = (over: Record<string, string | null>) => parsePlan(doc(block("yaml plan", PLAN_YAML), block("yaml task", taskYaml(over))));
		const sizeOf = (result: ParseResult) => (result.ok ? result.plan.tasks[0].size : undefined);
		expect(sizeOf(parsed({}))).toBe("normal");
		expect(sizeOf(parsed({ size: "size: small" }))).toBe("small");
		expect(sizeOf(parsed({ size: "size: normal" }))).toBe("normal");
	});

	test("field: size must be small or normal", () => {
		const result = parsePlan(doc(block("yaml plan", PLAN_YAML), block("yaml task", taskYaml({ size: "size: huge" }))));
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(only(result.errors)).toEqual(["field:T01"]);
		expect(result.errors[0].detail).toContain('field "size" must be one of small, normal');
	});

	describe("checks", () => {
		const withChecks = (checks: string) => parsePlan(doc(block("yaml plan", `${PLAN_YAML}\nchecks:\n${checks}`), block("yaml task", taskYaml())));

		test("reads the documented block; an absent block reads as empty", () => {
			const result = withChecks(
				['  org/backend:', '    test: "go test ./..."', '    test_files: "go test {packages}"', '    typecheck: "go vet ./..."', '    lint: ""', '  org/frontend:', '    test: "bun test"'].join("\n"),
			);
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.plan.checks).toEqual({
				"org/backend": { test: "go test ./...", test_files: "go test {packages}", typecheck: "go vet ./...", lint: "" },
				"org/frontend": { test: "bun test" },
			});
			const absent = parsePlan(doc(block("yaml plan", PLAN_YAML), block("yaml task", taskYaml())));
			expect(absent.ok && absent.plan.checks).toEqual({});
			const empty = withChecks("");
			expect(empty.ok && empty.plan.checks).toEqual({});
		});

		test("a null command reads as a skipped check", () => {
			const result = withChecks(["  org/backend:", '    test: "go test ./..."', "    lint:"].join("\n"));
			expect(result.ok && result.plan.checks["org/backend"]).toEqual({ test: "go test ./...", lint: "" });
		});

		test("test_paths is a list of path patterns that replaces the built-in test file patterns", () => {
			const result = withChecks(["  org/backend:", '    test: "go test ./..."', '    test_paths: ["t/**", "spec/"]'].join("\n"));
			expect(result.ok && result.plan.checks["org/backend"]).toEqual({ test: "go test ./...", test_paths: ["t/**", "spec/"] });
		});

		for (const [name, value] of [["a string", '"t/**"'], ["an empty list", "[]"], ["a list with a blank entry", '["t/**", " "]'], ["a list of numbers", "[1]"]] as const) {
			test(`field: test_paths as ${name} is refused`, () => {
				const result = withChecks(["  org/backend:", '    test: "go test ./..."', `    test_paths: ${value}`].join("\n"));
				expect(result.ok).toBe(false);
				if (result.ok) return;
				expect(only(result.errors)).toEqual(["field"]);
				expect(result.errors[0].detail).toContain('check "test_paths" for "org/backend" must be a non-empty list of path patterns');
			});
		}

		const bad: Array<[string, string, string]> = [
			["an unknown check name", '  org/backend:\n    test: "go test ./..."\n    format: "gofmt"', 'unknown check "format" for "org/backend"'],
			["a command that is not a string", "  org/backend:\n    test: 12", 'check "test" for "org/backend" must be a string'],
			["a repo entry that is not a mapping", "  org/backend: go test ./...", 'checks "org/backend" must be a mapping of commands'],
		];
		for (const [name, checks, detail] of bad) {
			test(`field: ${name}`, () => {
				const result = withChecks(checks);
				expect(result.ok).toBe(false);
				if (result.ok) return;
				expect(only(result.errors)).toEqual(["field"]);
				expect(result.errors[0].detail).toContain(detail);
			});
		}

		test("field: checks itself must be a mapping", () => {
			const result = parsePlan(doc(block("yaml plan", `${PLAN_YAML}\nchecks: [go test]`), block("yaml task", taskYaml())));
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.errors[0].detail).toContain('field "checks" must be a mapping');
		});
	});
});

describe("validatePlan rules", () => {
	test("a valid two-task story has no violations", () => {
		const found = validatePlan(
			plan(
				[
					routed("T01", { shared_state: "adds refund table" }, { foundation: true, owns: ["db/migrations/**"], reads: ["src/**"] }),
					task("T02", { depends_on: ["T01"], owns: ["src/refund/**"], new_paths: ["src/refund/new.ts"], reads: ["src/shared/**"] }),
				],
				{ shared_paths: ["db/migrations/**", "src/shared/**"] },
			),
			FILES,
		);
		expect(found).toEqual([]);
	});

	test("field: an owns pattern that matches no repo file and no new path", () => {
		const found = validatePlan(plan([task("T01", { owns: ["nowhere/**"] })]), FILES);
		expect(only(found)).toEqual(["field:T01"]);
		expect(validatePlan(plan([task("T01", { owns: ["nowhere/**"], new_paths: ["nowhere/new.ts"] })]), FILES)).toEqual([]);
	});

	test("duplicate-id", () => {
		expect(only(validatePlan(plan([task("T01"), task("T01")]), FILES))).toEqual(["duplicate-id:T01"]);
	});

	test("missing-dep", () => {
		expect(only(validatePlan(plan([task("T01", { depends_on: ["T09"] })]), FILES))).toEqual(["missing-dep:T01"]);
	});

	test("cycle is reported once as its id path", () => {
		const found = validatePlan(plan([task("T01", { depends_on: ["T02"] }), task("T02", { depends_on: ["T03"] }), task("T03", { depends_on: ["T01"] })]), FILES);
		expect(only(found)).toEqual(["cycle:T01"]);
		expect(found[0].detail).toContain("T01 -> T02 -> T03 -> T01");
	});

	test("owns-overlap: independent tasks sharing a file fail, a dependency path clears it", () => {
		const a = task("T01", { owns: ["src/orders/**"] });
		const b = task("T02", { owns: ["src/orders/api.ts"] });
		const found = validatePlan(plan([a, b]), FILES);
		expect(only(found)).toEqual(["owns-overlap:T01"]);
		expect(found[0].detail).toContain("src/orders/api.ts");
		expect(validatePlan(plan([a, { ...b, depends_on: ["T01"] }]), FILES)).toEqual([]);
		expect(validatePlan(plan([{ ...a, depends_on: ["T02"] }, b]), FILES)).toEqual([]);
		const mid = task("T03", { depends_on: ["T01"] });
		expect(validatePlan(plan([a, mid, { ...b, depends_on: ["T03"] }]), FILES)).toEqual([]);
	});

	test("owns-overlap: new_paths prefixes that contain one another", () => {
		const overlap = validatePlan(plan([task("T01", { new_paths: ["src/new/**"] }), task("T02", { new_paths: ["src/new/deep/file.ts"] })]), FILES);
		expect(only(overlap)).toEqual(["owns-overlap:T01"]);
		const disjoint = validatePlan(plan([task("T01", { new_paths: ["src/new/**"] }), task("T02", { new_paths: ["src/newer/**"] })]), FILES);
		expect(disjoint).toEqual([]);
		const ordered = validatePlan(plan([task("T01", { new_paths: ["src/new/**"] }), task("T02", { depends_on: ["T01"], new_paths: ["src/new/x.ts"] })]), FILES);
		expect(ordered).toEqual([]);
	});

	describe("repos", () => {
		const other = "org/frontend";
		const both = new Map([["org/backend", BACKEND_FILES], [other, BACKEND_FILES]]);

		test("owns-overlap: the same path owned in two repos by independent tasks is fine, in one repo it is not", () => {
			const a = task("T01", { owns: ["src/orders/api.ts"] });
			const b = task("T02", { owns: ["src/orders/api.ts"], repo: other });
			expect(validatePlan(plan([a, b]), both)).toEqual([]);
			expect(only(validatePlan(plan([a, { ...b, repo: "org/backend" }]), both))).toEqual(["owns-overlap:T01"]);
		});

		test("owns-overlap: new_paths prefixes only clash within a repo", () => {
			const a = task("T01", { new_paths: ["src/new/**"] });
			const b = task("T02", { new_paths: ["src/new/x.ts"], repo: other });
			expect(validatePlan(plan([a, b]), both)).toEqual([]);
			expect(only(validatePlan(plan([a, { ...b, repo: "org/backend" }]), both))).toEqual(["owns-overlap:T01"]);
		});

		test("a task's owns are matched against its own repo's files", () => {
			const files = new Map([["org/backend", BACKEND_FILES], [other, ["web/index.ts"]]]);
			expect(validatePlan(plan([task("T01", { owns: ["web/**"], repo: other })]), files)).toEqual([]);
			const found = validatePlan(plan([task("T01", { owns: ["web/**"] })]), files);
			expect(only(found)).toEqual(["field:T01"]);
		});

		test("shared-path: a shared glob is matched against the task's own repo's files only", () => {
			const shared = { shared_paths: ["src/shared/**"] };
			const files = new Map([["org/backend", BACKEND_FILES], [other, ["src/ui/button.ts"]]]);
			// `src/**` in the frontend matches only src/ui/button.ts, which is not shared; in the backend it reaches src/shared/util.ts.
			expect(validatePlan(plan([task("T01", { owns: ["src/**"], repo: other })], shared), files)).toEqual([]);
			expect(only(validatePlan(plan([task("T01", { owns: ["src/**"] })], shared), files))).toEqual(["shared-path:T01"]);
		});

		test("field: a task whose repo has no files names the missing repo", () => {
			const found = validatePlan(plan([task("T01", { repo: "org/missing", owns: ["src/**"] })]), FILES);
			expect(only(found)).toEqual(["field:T01"]);
			expect(found[0].detail).toContain("org/missing");
			expect(only(validatePlan(plan([task("T01"), task("T02", { repo: "org/missing" })]), FILES))).toEqual(["field:T02"]);
		});
	});

	test("shared-path: a non-foundation task owning or creating shared paths", () => {
		const shared = { shared_paths: ["db/migrations/**"] };
		expect(only(validatePlan(plan([task("T01", { owns: ["db/migrations/**"] })], shared), FILES))).toEqual(["shared-path:T01"]);
		expect(only(validatePlan(plan([task("T01", { new_paths: ["db/migrations/002.sql"] })], shared), FILES))).toEqual(["shared-path:T01"]);
		expect(validatePlan(plan([task("T01", { foundation: true, owns: ["db/migrations/**"] })], shared), FILES)).toEqual([]);
		expect(validatePlan(plan([task("T01", { owns: ["src/orders/**"] })], shared), FILES)).toEqual([]);
	});

	test("foundation-order: a foundation task may not depend on a non-foundation task", () => {
		const found = validatePlan(plan([task("T01"), task("F1", { foundation: true, depends_on: ["T01"] })]), FILES);
		expect(only(found)).toEqual(["foundation-order:F1"]);
		expect(found[0].detail).toContain("T01");
		// Through another foundation task: both reach the non-foundation task, and both are named.
		const chain = validatePlan(plan([task("T01"), task("F1", { foundation: true, depends_on: ["F2"] }), task("F2", { foundation: true, depends_on: ["T01"] })]), FILES);
		expect(only(chain)).toEqual(["foundation-order:F1", "foundation-order:F2"]);
		// Foundation tasks may depend on each other, and any task may depend on a foundation task.
		expect(validatePlan(plan([task("F1", { foundation: true }), task("F2", { foundation: true, depends_on: ["F1"] }), task("T01", { depends_on: ["F2"] })]), FILES)).toEqual([]);
	});

	test("risk-reason", () => {
		const found = validatePlan(plan([routed("T01", { shared_state: "  " })]), FILES);
		expect(only(found)).toEqual(["risk-reason:T01"]);
	});

	test("size-risk: small is rejected when any risk is yes", () => {
		const small = routed("T01", { retries: "re-sends on timeout" }, { size: "small" });
		const found = validatePlan(plan([small]), FILES);
		expect(only(found)).toEqual(["size-risk:T01"]);
		expect(found[0].detail).toContain("retries");
		expect(validatePlan(plan([{ ...small, size: "normal" }]), FILES)).toEqual([]);
		expect(validatePlan(plan([task("T01", { size: "small" })]), FILES)).toEqual([]);
	});

	test("lld-missing: needs lld or a skip reason", () => {
		const base = routed("T01", { shared_state: "new table" }, { lld: undefined });
		expect(only(validatePlan(plan([base]), FILES))).toEqual(["lld-missing:T01"]);
		expect(validatePlan(plan([{ ...base, lld_skip_reason: "covered by T00 design" }]), FILES)).toEqual([]);
		expect(only(validatePlan(plan([{ ...base, lld_skip_reason: "  " }]), FILES))).toEqual(["lld-missing:T01"]);
	});

	test("router-mismatch: lld_required and security_review", () => {
		const lld = validatePlan(plan([task("T01", { lld_required: true, lld: "lld/x.md" })]), FILES);
		expect(only(lld)).toEqual(["router-mismatch:T01"]);
		const security = validatePlan(plan([routed("T01", { sensitive_data: "pii" }, { security_review: false })]), FILES);
		expect(only(security)).toEqual(["router-mismatch:T01"]);
	});

	test("required-tests: an implied test id is missing", () => {
		const t = routed("T01", { async_messaging: "queue consumer" });
		const found = validatePlan(plan([{ ...t, required_tests: t.required_tests.filter(id => id !== "out-of-order") }]), FILES);
		expect(only(found)).toEqual(["required-tests:T01"]);
		expect(found[0].detail).toContain("out-of-order");
	});

	test("acceptance-empty", () => {
		expect(only(validatePlan(plan([task("T01", { acceptance: [] })]), FILES))).toEqual(["acceptance-empty:T01"]);
	});

	test("checks-missing: every task repo needs a test command, reported once per repo under its first task", () => {
		expect(only(validatePlan(plan([task("T01")], { checks: {} }), FILES))).toEqual(["checks-missing:T01"]);
		expect(only(validatePlan(plan([task("T01")], { checks: { "org/backend": { test: "  " } } }), FILES))).toEqual(["checks-missing:T01"]);
		expect(only(validatePlan(plan([task("T01")], { checks: { "org/backend": { lint: "eslint ." } } }), FILES))).toEqual(["checks-missing:T01"]);
		expect(only(validatePlan(plan([task("T01")], { checks: { "org/other": { test: "go test ./..." } } }), FILES))).toEqual(["checks-missing:T01"]);
		expect(validatePlan(plan([task("T01")], { checks: { "org/backend": { test: "go test ./...", lint: "", typecheck: "go vet ./..." } } }), FILES)).toEqual([]);
		const twoOfOneRepo = validatePlan(plan([task("T01"), task("T02", { depends_on: ["T01"] })], { checks: {} }), FILES);
		expect(only(twoOfOneRepo)).toEqual(["checks-missing:T01"]);
		expect(twoOfOneRepo[0].detail).toContain('"test"');
		expect(twoOfOneRepo[0].detail).toContain("org/backend");
		const frontend = "org/frontend";
		const files = new Map([["org/backend", BACKEND_FILES], [frontend, BACKEND_FILES]]);
		const twoRepos = plan([task("T01"), task("T02", { repo: frontend })], { checks: { "org/backend": { test: "go test ./..." } } });
		expect(only(validatePlan(twoRepos, files))).toEqual(["checks-missing:T02"]);
	});

	test("task-plan-size: a story needs at least one task block", () => {
		expect(only(validatePlan(plan([]), FILES))).toEqual(["task-plan-size"]);
		expect(validatePlan(plan([task("T01")]), FILES)).toEqual([]);
	});

	test("task-plan-size: kind task needs exactly one task block", () => {
		expect(only(validatePlan(plan([task("T01"), task("T02")], { kind: "task" }), FILES))).toEqual(["task-plan-size"]);
		expect(only(validatePlan(plan([], { kind: "task" }), FILES))).toEqual(["task-plan-size"]);
		expect(validatePlan(plan([task("T01")], { kind: "task" }), FILES)).toEqual([]);
	});

	test("every rule runs and violations are ordered by task, then rule", () => {
		const found = validatePlan(plan([task("T01", { depends_on: ["T09"], acceptance: [] }), task("T02", { depends_on: ["T09"] })], { kind: "task" }), FILES);
		expect(only(found)).toEqual(["missing-dep:T01", "acceptance-empty:T01", "missing-dep:T02", "task-plan-size"]);
	});
});

describe("risk router", () => {
	const rows: Array<[RiskField, { lld: boolean; security: boolean; tests: string[] }]> = [
		["shared_state", { lld: true, security: false, tests: ["concurrent-writes"] }],
		["external_io", { lld: true, security: true, tests: ["io-failure-injection", "timeout"] }],
		["retries", { lld: true, security: false, tests: ["duplicate-request"] }],
		["concurrent_writers", { lld: true, security: false, tests: ["concurrent-writes", "race-detector"] }],
		["non_idempotent_effects", { lld: true, security: false, tests: ["duplicate-request"] }],
		["async_messaging", { lld: true, security: false, tests: ["duplicate-delivery", "out-of-order", "poison-to-dlq", "crash-before-ack"] }],
		["multi_step_saga", { lld: true, security: false, tests: ["compensation"] }],
		["sensitive_data", { lld: false, security: true, tests: [] }],
	];

	test("all risks no routes to nothing", () => {
		expect(routeRisk(risk())).toEqual({ lld_required: false, security_review: false, implied_tests: [] });
	});

	for (const [field, row] of rows) {
		test(`${field} yes`, () => {
			expect(routeRisk(risk({ [field]: "because" }))).toEqual({ lld_required: row.lld, security_review: row.security, implied_tests: row.tests });
			expect(validatePlan(plan([routed("T01", { [field]: "because" })]), FILES)).toEqual([]);
			if (row.lld) {
				const wrong = task("T01", { risk: risk({ [field]: "because" }), lld_required: false, security_review: row.security, required_tests: row.tests });
				expect(only(validatePlan(plan([wrong]), FILES))).toEqual(["router-mismatch:T01"]);
			}
			if (row.security) {
				const wrong = task("T01", { risk: risk({ [field]: "because" }), lld_required: row.lld, security_review: false, required_tests: row.tests, lld: "lld/x.md" });
				expect(only(validatePlan(plan([wrong]), FILES))).toEqual(["router-mismatch:T01"]);
			}
		});
	}

	test("the implied tests table covers every risk except sensitive_data", () => {
		expect(Object.keys(IMPLIED_TESTS).sort()).toEqual(RISK_FIELDS.filter(f => f !== "sensitive_data").sort());
	});

	test("tests implied by several risks are listed once", () => {
		expect(routeRisk(risk({ shared_state: "a", concurrent_writers: "b" })).implied_tests).toEqual(["concurrent-writes", "race-detector"]);
	});

	test("owning a dependency manifest requires a security review", () => {
		for (const manifest of ["package.json", "bun.lock", "go.mod", "go.sum", "requirements-dev.txt", "pyproject.toml", "Cargo.toml"]) {
			const files = [...BACKEND_FILES, manifest];
			const without = task("T01", { owns: [manifest] });
			expect(only(validatePlan(plan([without]), byRepo(files)))).toEqual(["router-mismatch:T01"]);
			expect(validatePlan(plan([{ ...without, security_review: true }]), byRepo(files))).toEqual([]);
		}
	});

	test("a manifest below a directory, or one that is only created, counts", () => {
		const nested = task("T01", { owns: ["services/api/go.mod"] });
		expect(only(validatePlan(plan([nested]), byRepo([...BACKEND_FILES, "services/api/go.mod"])))).toEqual(["router-mismatch:T01"]);
		const created = task("T01", { new_paths: ["tools/Cargo.toml"] });
		expect(only(validatePlan(plan([created]), FILES))).toEqual(["router-mismatch:T01"]);
	});

	test("a security review without a trigger is a mismatch", () => {
		expect(only(validatePlan(plan([task("T01", { security_review: true })]), FILES))).toEqual(["router-mismatch:T01"]);
	});
});

describe("validate-plan CLI", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	const PLAN = (acceptance: string, checks = ["checks:", '  org/backend: {test: "go test ./..."}']) =>
		[
			`${FENCE}yaml plan`,
			"id: S-1",
			"kind: story",
			"shared_paths: []",
			...checks,
			FENCE,
			"",
			`${FENCE}yaml task`,
			"id: T01",
			"repo: org/backend",
			"depends_on: []",
			"foundation: false",
			"owns: [src/**]",
			"new_paths: []",
			"reads: []",
			"risk:",
			...RISK_FIELDS.map(f => `  ${f}: {value: no}`),
			"lld_required: false",
			"security_review: false",
			"required_tests: []",
			`acceptance: ${acceptance}`,
			FENCE,
		].join("\n");

	/** A temp git repo with one tracked file under `src/`, plus a scratch folder for plan files. */
	function world() {
		const root = mkdtempSync(join(tmpdir(), "validate-plan-"));
		dirs.push(root);
		const repo = join(root, "repo");
		mkdirSync(join(repo, "src"), { recursive: true });
		writeFileSync(join(repo, "src", "a.ts"), "export {};\n");
		const git = Bun.spawnSync({ cmd: ["sh", "-c", "git init --quiet && git add -A"], cwd: repo });
		expect(git.exitCode).toBe(0);
		const write = (name: string, text: string) => {
			const file = join(root, name);
			mkdirSync(dirname(file), { recursive: true });
			writeFileSync(file, text);
			return file;
		};
		return { root, repo, write };
	}

	const run = (...args: string[]) => {
		const result = Bun.spawnSync({ cmd: [process.execPath, SCRIPT, ...args], stdout: "pipe", stderr: "pipe" });
		return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
	};

	test("exit 0 for a valid plan", () => {
		const { repo, write } = world();
		const result = run(write("plan.md", PLAN('["works"]')), "--repo", repo);
		expect(result.code).toBe(0);
		expect(result.stdout.trim()).toBe("valid");
		expect(JSON.parse(run(write("plan.md", PLAN('["works"]')), "--repo", repo, "--json").stdout)).toEqual({ ok: true, violations: [] });
	});

	test("exit 1 for an invalid plan, with violations in text and JSON", () => {
		const { repo, write } = world();
		const file = write("plan.md", PLAN("[]"));
		const text = run(file, "--repo", repo);
		expect(text.code).toBe(1);
		expect(text.stdout).toContain("acceptance-empty [T01]");
		const json = JSON.parse(run(file, "--repo", repo, "--json").stdout);
		expect(json.ok).toBe(false);
		expect(json.violations).toEqual([{ rule: "acceptance-empty", task: "T01", detail: "acceptance is empty" }]);
	});

	test("exit 1 for a plan whose repo declares no test check", () => {
		const { repo, write } = world();
		const result = run(write("plan.md", PLAN('["works"]', [])), "--repo", repo);
		expect(result.code).toBe(1);
		expect(result.stdout).toContain('checks-missing [T01]: checks has no "test" command for repo "org/backend"');
	});

	test("exit 1 for a plan that does not parse", () => {
		const { repo, write } = world();
		const result = run(write("plan.md", "no blocks here"), "--repo", repo, "--json");
		expect(result.code).toBe(1);
		expect(JSON.parse(result.stdout).violations[0].rule).toBe("parse");
	});

	test("exit 2 for a missing plan file, a non-git repo and bad usage", () => {
		const { root, repo, write } = world();
		const file = write("plan.md", PLAN('["works"]'));
		expect(run(join(root, "absent.md"), "--repo", repo).code).toBe(2);
		const plain = join(root, "plain");
		mkdirSync(plain);
		const notGit = run(file, "--repo", plain);
		expect(notGit.code).toBe(2);
		expect(notGit.stderr).toContain("not a git work tree");
		expect(run(file).code).toBe(2);
		expect(run("--repo", repo).code).toBe(2);
		expect(run(file, "--repo", repo, "--bogus").code).toBe(2);
		expect(run().stdout).toBe("");
	});

	describe("several repos", () => {
		const task = (id: string, repo: string) =>
			[
				`${FENCE}yaml task`,
				`id: ${id}`,
				`repo: ${repo}`,
				"depends_on: []",
				"foundation: false",
				"owns: [src/a.ts]",
				"new_paths: []",
				"reads: []",
				"risk:",
				...RISK_FIELDS.map(f => `  ${f}: {value: no}`),
				"lld_required: false",
				"security_review: false",
				"required_tests: []",
				'acceptance: ["works"]',
				FENCE,
				"",
			];
		const twoTasks = (repoA: string, repoB: string) =>
			[
				`${FENCE}yaml plan`,
				"id: S-1",
				"kind: story",
				"shared_paths: []",
				"checks:",
				...[...new Set([repoA, repoB])].map(repo => `  ${repo}: {test: "true"}`),
				FENCE,
				"",
				...task("T01", repoA),
				...task("T02", repoB),
			].join("\n");

		/** A git clone of `origin` under `root` with `src/a.ts` tracked. */
		function clone(root: string, name: string, origin: string): string {
			const repo = join(root, name);
			mkdirSync(join(repo, "src"), { recursive: true });
			writeFileSync(join(repo, "src", "a.ts"), "export {};\n");
			for (const args of [["init", "--quiet"], ["add", "-A"], ["remote", "add", "origin", origin]]) {
				expect(Bun.spawnSync({ cmd: ["git", ...args], cwd: repo }).exitCode).toBe(0);
			}
			return repo;
		}

		test("each clone serves the tasks of its origin; the same path in two repos does not overlap", () => {
			const { root, write } = world();
			const backend = clone(root, "backend", "git@github.com:org/backend.git");
			const frontend = clone(root, "frontend", "https://github.com/org/frontend.git");
			const file = write("two.md", twoTasks("org/backend", "org/frontend"));
			const result = run(file, "--repo", backend, "--repo", frontend);
			expect(result.stdout.trim()).toBe("valid");
			expect(result.code).toBe(0);
		});

		test("the same path owned by independent tasks of one repo is an owns-overlap", () => {
			const { root, write } = world();
			const backend = clone(root, "backend", "git@github.com:org/backend.git");
			const result = run(write("one.md", twoTasks("org/backend", "org/backend")), "--repo", backend);
			expect(result.code).toBe(1);
			expect(result.stdout).toContain("owns-overlap [T01]");
		});

		test("a task repo without a --repo clone is reported as a field violation", () => {
			const { root, write } = world();
			const backend = clone(root, "backend", "git@github.com:org/backend.git");
			const result = run(write("two.md", twoTasks("org/backend", "org/frontend")), "--repo", backend);
			expect(result.code).toBe(1);
			expect(result.stdout).toContain('field [T02]: no files supplied for repo "org/frontend"');
		});

		test("a lone clone without an origin cannot serve a multi-repo plan, two clones of one repo are refused", () => {
			const { root, repo, write } = world();
			const noOrigin = run(write("two.md", twoTasks("org/backend", "org/frontend")), "--repo", repo);
			expect(noOrigin.code).toBe(2);
			expect(noOrigin.stderr).toContain("cannot serve a plan with 2 repos");
			const first = clone(root, "first", "git@github.com:org/backend.git");
			const second = clone(root, "second", "https://github.com/org/backend.git");
			const twins = run(write("two.md", twoTasks("org/backend", "org/backend")), "--repo", first, "--repo", second);
			expect(twins.code).toBe(2);
			expect(twins.stderr).toContain("both clones of org/backend");
		});
	});
});
