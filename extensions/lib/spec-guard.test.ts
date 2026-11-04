import { describe, expect, test } from "bun:test";
import {
	type FileChange,
	type GuardCommit,
	type GuardRule,
	type GuardViolation,
	type PlanAtRev,
	LockState,
	formatViolation,
	guardCommits,
	inScope,
} from "./spec-guard";
import type { Plan, RiskEntry, RiskField, TaskBlock } from "./spec-plan";
import { RISK_FIELDS } from "./spec-risk";

const REV = "aaa1111";

function task(id: string, over: Partial<TaskBlock> = {}): TaskBlock {
	const risk = {} as Record<RiskField, RiskEntry>;
	for (const field of RISK_FIELDS) risk[field] = { value: "no" };
	return {
		id, repo: "org/backend", depends_on: [], foundation: false, owns: [], new_paths: [], reads: [], risk, lld_required: false,
		security_review: false, size: "normal", required_tests: [], acceptance: ["it works"], ...over,
	};
}

const plan = (...tasks: TaskBlock[]): Plan => ({ id: "S-1", kind: "story", shared_paths: [], checks: {}, tasks });
const valid = (...tasks: TaskBlock[]): PlanAtRev => ({ plan: plan(...tasks), violations: [] });

let counter = 0;
function commit(over: Partial<GuardCommit> = {}): GuardCommit {
	return { sha: `c${String(++counter).padStart(6, "0")}`, merge: false, tasks: ["T1"], planRev: REV, locks: [], locked: [], unlocks: [], changes: [], added: [], ...over };
}

const change = (path: string, from?: string): FileChange => (from === undefined ? { path } : { path, from });
const added = (path: string, ...lines: string[]) => lines.map((text, i) => ({ path, line: i + 1, text }));

/** The violations of `commits` against one plan revision holding `tasks`. */
function guard(commits: GuardCommit[], at: PlanAtRev | undefined, strict = false): GuardViolation[] {
	return guardCommits({ commits, plans: new Map(at === undefined ? [] : [[REV, at]]), strict });
}

const rules = (found: GuardViolation[]): GuardRule[] => found.map(v => v.rule);
const SCOPE = valid(task("T1", { owns: ["src/**"] }));

describe("plan rules", () => {
	test("plan-rev-missing: a Task: commit without Plan-Rev", () => {
		const bare = commit({ planRev: undefined });
		const found = guard([bare, commit({ planRev: undefined, tasks: [] })], SCOPE);
		expect(rules(found)).toEqual(["plan-rev-missing"]);
		expect(found[0]).toMatchObject({ sha: bare.sha, task: "T1" });
		expect(rules(guard([commit()], SCOPE))).toEqual([]);
	});

	test("plan-rev-unreadable: the vault could not give the plan, or it was never loaded", () => {
		const unreadable = guard([commit()], { unreadable: "is not a commit in the vault git dir", violations: [] });
		expect(rules(unreadable)).toEqual(["plan-rev-unreadable"]);
		expect(unreadable[0].detail).toContain(`Plan-Rev ${REV}`);
		expect(unreadable[0].detail).toContain("not a commit in the vault git dir");
		const unloaded = guard([commit()], undefined);
		expect(rules(unloaded)).toEqual(["plan-rev-unreadable"]);
		expect(unloaded[0].detail).toContain("was not loaded");
	});

	test("plan-invalid: validation findings are summarised, and the other rules still run against the parsed plan", () => {
		const findings = ["a", "b", "c", "d"].map(name => ({ rule: "acceptance-empty" as const, task: name, detail: `acceptance of ${name} is empty` }));
		const found = guard([commit({ changes: [change("docs/x.md")] })], { plan: plan(task("T1", { owns: ["src/**"] })), violations: findings });
		expect(rules(found)).toEqual(["plan-invalid", "out-of-scope"]);
		expect(found[0].detail).toContain("acceptance-empty [a]: acceptance of a is empty");
		expect(found[0].detail).toContain("(+1 more)");
		expect(found[0].detail).not.toContain("acceptance of d");
	});

	test("plan-invalid: a plan that did not parse has no tasks to judge", () => {
		const found = guard([commit({ changes: [change("docs/x.md")] })], { violations: [{ rule: "parse", detail: "expected exactly one yaml plan block" }] });
		expect(rules(found)).toEqual(["plan-invalid"]);
		expect(rules(guard([commit()], valid(task("T1"))))).toEqual([]);
	});

	test("unknown-task: every Task: id the plan lacks, while the known ones are still judged", () => {
		const found = guard([commit({ tasks: ["T1", "T9", "T8"], changes: [change("docs/x.md")] })], SCOPE);
		expect(rules(found)).toEqual(["unknown-task", "unknown-task", "out-of-scope"]);
		expect(found.slice(0, 2).map(v => v.task)).toEqual(["T9", "T8"]);
		expect(rules(guard([commit({ tasks: ["T1"] })], SCOPE))).toEqual([]);
	});
});

describe("out-of-scope", () => {
	const scoped = valid(
		task("T1", { owns: ["src/refund/**", "docs/refund.md", "web/[id]/page.tsx"], new_paths: ["src/new/", "tools/helper.ts"] }),
		task("T2", { owns: ["db/**"] }),
	);

	test("owns globs, exact owns, new_paths directories and new_paths files are in scope", () => {
		const inside = ["src/refund/a.ts", "src/refund/deep/b.ts", "docs/refund.md", "web/[id]/page.tsx", "src/new/x.ts", "src/new/deep/y.ts", "tools/helper.ts"];
		expect(guard([commit({ changes: inside.map(path => change(path)) })], scoped)).toEqual([]);
	});

	test("a path outside owns and new_paths is reported with its path and task", () => {
		const outside = ["src/other.ts", "src/refund.ts", "docs/other.md", "tools/helper.ts.bak", "src/newer/x.ts", "db/001.sql"];
		const bad = commit({ changes: outside.map(path => change(path)) });
		const found = guard([bad], scoped);
		expect(rules(found)).toEqual(outside.map(() => "out-of-scope"));
		expect(found.map(v => v.path)).toEqual(outside);
		expect(found[0]).toMatchObject({ sha: bad.sha, task: "T1" });
	});

	test("a rename is checked on both sides", () => {
		const found = guard([commit({ changes: [change("src/refund/new.ts", "src/legacy/old.ts"), change("src/legacy/moved.ts", "src/refund/gone.ts"), change("src/refund/b.ts", "src/refund/a.ts")] })], scoped);
		expect(found.map(v => v.path)).toEqual(["src/legacy/old.ts", "src/legacy/moved.ts"]);
	});

	test("a commit serving several tasks may touch the union of their scopes", () => {
		const both = commit({ tasks: ["T1", "T2"], changes: [change("src/refund/a.ts"), change("db/001.sql"), change("web/x.ts")] });
		const found = guard([both], scoped);
		expect(found.map(v => v.path)).toEqual(["web/x.ts"]);
		expect(found[0].task).toBe("T1");
		expect(found[0].detail).toContain("T1, T2");
	});

	test("a commit without Task: has no scope to break", () => {
		expect(guard([commit({ tasks: [], planRev: undefined, changes: [change("anything.ts")] })], scoped)).toEqual([]);
	});
});

describe("locked-test-changed", () => {
	const lock = (task: string, ...paths: string[]) => commit({ locks: [task], locked: paths });
	const unlock = (task: string) => commit({ unlocks: [task] });
	const touch = (...paths: string[]) => commit({ changes: paths.map(path => change(path)) });
	const open = valid(task("T1", { owns: ["src/**", "test/**"] }), task("T2", { owns: ["src/**", "test/**"] }));

	test("a change before the lock is fine; after it, the path is reported with the locking task", () => {
		const before = touch("test/a.test.ts");
		const after = touch("test/a.test.ts", "test/other.test.ts");
		const found = guard([before, lock("T1", "test/a.test.ts"), after], open);
		expect(rules(found)).toEqual(["locked-test-changed"]);
		expect(found[0]).toMatchObject({ sha: after.sha, task: "T1", path: "test/a.test.ts" });
	});

	test("the lock and unlock commits themselves carry no change", () => {
		expect(guard([lock("T1", "test/a.test.ts"), unlock("T1"), lock("T1", "test/a.test.ts")], open)).toEqual([]);
	});

	test("unlock window: changes are allowed after Task-Unlock and rejected again after the next Task-Lock", () => {
		const during = touch("test/a.test.ts");
		const again = touch("test/a.test.ts");
		const found = guard([lock("T1", "test/a.test.ts"), unlock("T1"), during, lock("T1", "test/a.test.ts"), again], open);
		expect(found.map(v => v.sha)).toEqual([again.sha]);
	});

	test("a new lock covers exactly the paths it lists", () => {
		const first = touch("test/a.test.ts");
		const second = touch("test/b.test.ts");
		const found = guard([lock("T1", "test/a.test.ts", "test/b.test.ts"), unlock("T1"), lock("T1", "test/b.test.ts"), first, second], open);
		expect(found.map(v => v.sha)).toEqual([second.sha]);
	});

	test("an unlock opens only its own task's files", () => {
		const t1 = touch("test/a.test.ts");
		const t2 = touch("test/b.test.ts");
		const found = guard([lock("T1", "test/a.test.ts"), lock("T2", "test/b.test.ts"), unlock("T1"), t1, t2], open);
		expect(found).toHaveLength(1);
		expect(found[0]).toMatchObject({ sha: t2.sha, task: "T2", path: "test/b.test.ts" });
	});

	test("an unlock for a task that holds no lock does nothing", () => {
		const t = touch("test/a.test.ts");
		expect(guard([unlock("T1"), lock("T2", "test/a.test.ts"), t], open)).toHaveLength(1);
	});

	test("a rename, a deletion and a rename onto a locked path all count", () => {
		const commits = [
			lock("T1", "test/a.test.ts"),
			commit({ changes: [change("test/renamed.test.ts", "test/a.test.ts")] }),
			commit({ changes: [change("test/a.test.ts", "test/x.test.ts")] }),
			commit({ changes: [change("test/a.test.ts")] }),
		];
		expect(guard(commits, open).map(v => v.path)).toEqual(["test/a.test.ts", "test/a.test.ts", "test/a.test.ts"]);
	});

	test("every commit is held to a lock, with or without Task:", () => {
		const stray = commit({ tasks: [], planRev: undefined, changes: [change("test/a.test.ts")] });
		expect(rules(guard([lock("T1", "test/a.test.ts"), stray], open))).toEqual(["locked-test-changed"]);
	});

	test("LockState reports the locks in force", () => {
		const state = new LockState();
		state.apply({ locks: ["T1"], locked: ["a", "b"], unlocks: [] });
		state.apply({ locks: ["T2"], locked: ["c"], unlocks: [] });
		expect([...state.locked()]).toEqual([["a", "T1"], ["b", "T1"], ["c", "T2"]]);
		state.apply({ locks: [], locked: [], unlocks: ["T1"] });
		expect([...state.locked()]).toEqual([["c", "T2"]]);
		state.apply({ locks: ["T1"], locked: ["b"], unlocks: ["T2"] });
		expect([...state.locked()]).toEqual([["b", "T1"]]);
		state.apply({ locks: ["T1"], locked: ["d"], unlocks: ["T1"] });
		expect([...state.locked()]).toEqual([["d", "T1"]]);
	});
});

describe("skip-added and ignore-added", () => {
	const skips: Array<[string, string]> = [
		["TypeScript .skip(", 'it.skip("handles refunds", () => {});'],
		["TypeScript describe.only(", 'describe.only("refunds", () => {'],
		["TypeScript test.todo(", 'test.todo("later");'],
		["TypeScript xit(", 'xit("later", () => {});'],
		["TypeScript xdescribe(", '  xdescribe("later", () => {'],
		["TypeScript xtest(", 'xtest("later", () => {});'],
		["Go t.Skip(", '\tt.Skip("flaky on CI")'],
		["Python @pytest.mark.skip", '@pytest.mark.skip(reason="later")'],
		["Python @pytest.mark.xfail", "@pytest.mark.xfail"],
		["Java @Disabled", '@Disabled("later")'],
	];
	const ignores: Array<[string, string]> = [
		["TypeScript @ts-ignore", "// @ts-ignore"],
		["TypeScript @ts-expect-error", "// @ts-expect-error not typed yet"],
		["ESLint disable", "/* eslint-disable no-console */"],
		["Biome ignore", "// biome-ignore lint/suspicious/noExplicitAny: legacy"],
		["Go nolint", "\tdefer f.Close() //nolint:errcheck"],
		["Go nolint with a space", "// nolint"],
		["Python type: ignore", "value = load()  # type: ignore"],
		["Python noqa", "import os  # noqa: F401"],
		["istanbul ignore", "/* istanbul ignore next */"],
		["c8 ignore", "/* c8 ignore next 3 */"],
	];
	const clean = [
		'it("skips nothing", () => {});',
		"const skipped = 3;",
		"expect(result).toBe(1);",
		'\tt.Run("subtest", func(t *testing.T) {})',
		"items.Skip(3)",
		"// TODO: add more cases",
		"const typeIgnore = true;",
		"@Test",
		"@pytest.mark.parametrize('x', [1])",
	];

	for (const [name, line] of skips) {
		test(`skip-added: ${name}`, () => {
			const bad = commit({ added: [{ path: "src/a.test.ts", line: 7, text: line }] });
			const found = guard([bad], SCOPE);
			expect(found).toHaveLength(1);
			expect(found[0]).toMatchObject({ rule: "skip-added", sha: bad.sha, task: "T1", path: "src/a.test.ts" });
			expect(found[0].detail).toContain("src/a.test.ts:7");
		});
	}

	for (const [name, line] of ignores) {
		test(`ignore-added: ${name}`, () => {
			const found = guard([commit({ added: [{ path: "src/a.ts", line: 2, text: line }] })], SCOPE);
			expect(rules(found)).toEqual(["ignore-added"]);
			expect(found[0].path).toBe("src/a.ts");
		});
	}

	test("ordinary lines are not reported", () => {
		expect(guard([commit({ added: added("src/a.ts", ...clean) })], SCOPE)).toEqual([]);
	});

	test("every matching added line is reported, skips before suppressions, in line order", () => {
		const lines = added("src/a.test.ts", "// @ts-ignore", 'it.only("x", f);', "const ok = 1;", 'xit("y", f);', "# noqa");
		const found = guard([commit({ added: lines })], SCOPE);
		expect(rules(found)).toEqual(["skip-added", "skip-added", "ignore-added", "ignore-added"]);
		expect(found.map(v => v.detail.split(" ")[0])).toEqual(["src/a.test.ts:2", "src/a.test.ts:4", "src/a.test.ts:1", "src/a.test.ts:5"]);
	});

	test("a long line is cut in the report", () => {
		const found = guard([commit({ added: added("src/a.ts", `// @ts-ignore ${"x".repeat(400)}`) })], SCOPE);
		expect(found[0].detail.length).toBeLessThan(220);
		expect(found[0].detail).toContain("…");
	});

	test("the rules apply to commits without Task: too", () => {
		const found = guard([commit({ tasks: [], planRev: undefined, added: added("src/a.ts", 'it.skip("x", f);') })], SCOPE);
		expect(found).toHaveLength(1);
		expect(found[0].task).toBeUndefined();
	});

	test("binary files have changes and no added lines, so only path rules apply", () => {
		expect(guard([commit({ changes: [change("src/logo.png")], added: [] })], SCOPE)).toEqual([]);
	});
});

describe("config-changed", () => {
	const protectedPaths = [
		"tsconfig.json", "tsconfig.build.json", "packages/web/tsconfig.json", "eslint.config.mjs", ".eslintrc.json", ".eslintrc", "biome.json", "biome.jsonc",
		".golangci.yml", ".golangci.yaml", ".github/workflows/ci.yml", ".github/workflows/nested/release.yaml", "bunfig.toml", "jest.config.ts",
		"vitest.config.mts", "pytest.ini", "pyproject.toml", "services/api/pyproject.toml", "setup.cfg",
	];

	for (const path of protectedPaths) {
		test(`${path} must be listed by exact path`, () => {
			const broad = valid(task("T1", { owns: ["**", `${path.split("/")[0]}/**`] }));
			const found = guard([commit({ changes: [change(path)] })], broad);
			expect(rules(found)).toEqual(["config-changed"]);
			expect(found[0]).toMatchObject({ path, task: "T1" });
			const exact = valid(task("T1", { owns: [path] }));
			expect(guard([commit({ changes: [change(path)] })], exact)).toEqual([]);
		});
	}

	test("a new config file is planned through an exact new_paths entry; a new_paths directory is not enough", () => {
		const exactNew = valid(task("T1", { new_paths: ["pkg/tsconfig.json"] }));
		expect(guard([commit({ changes: [change("pkg/tsconfig.json")] })], exactNew)).toEqual([]);
		const directory = valid(task("T1", { new_paths: ["pkg/"] }));
		expect(rules(guard([commit({ changes: [change("pkg/tsconfig.json")] })], directory))).toEqual(["config-changed"]);
	});

	test("files that merely look like configs are not protected", () => {
		const open = valid(task("T1", { owns: ["**"] }));
		const harmless = ["src/tsconfig.txt", "docs/eslint.md", ".github/CODEOWNERS", ".github/workflows.md", "src/pytest.ini.example", "packagejson.json", "src/config.ts"];
		expect(guard([commit({ changes: harmless.map(path => change(path)) })], open)).toEqual([]);
	});

	test("a rename is checked on both sides; owning one side is not enough", () => {
		const owned = valid(task("T1", { owns: ["tsconfig.json", "tsconfig.base.json"] }));
		expect(guard([commit({ changes: [change("tsconfig.base.json", "tsconfig.json")] })], owned)).toEqual([]);
		const half = valid(task("T1", { owns: ["tsconfig.json"] }));
		const found = guard([commit({ changes: [change("tsconfig.base.json", "tsconfig.json")] })], half);
		expect(found.map(v => `${v.rule}:${v.path}`)).toEqual(["out-of-scope:tsconfig.base.json", "config-changed:tsconfig.base.json"]);
	});

	test("the exact path must be listed by one of the commit's own tasks", () => {
		const two = valid(task("T1", { owns: ["src/**"] }), task("T2", { owns: ["tsconfig.json"] }));
		expect(rules(guard([commit({ tasks: ["T1"], changes: [change("tsconfig.json")] })], two))).toEqual(["out-of-scope", "config-changed"]);
		expect(guard([commit({ tasks: ["T1", "T2"], changes: [change("tsconfig.json")] })], two)).toEqual([]);
	});

	test("a commit without a known task has no owns, so any config change is reported", () => {
		expect(rules(guard([commit({ tasks: [], planRev: undefined, changes: [change("tsconfig.json")] })], SCOPE))).toEqual(["config-changed"]);
		expect(rules(guard([commit({ tasks: ["T9"], changes: [change("tsconfig.json")] })], SCOPE))).toEqual(["unknown-task", "config-changed"]);
	});
});

describe("untracked-commit", () => {
	const stray = () => commit({ tasks: [], planRev: undefined });

	test("strict rejects a non-merge commit without Task:", () => {
		const bad = stray();
		const found = guard([bad, commit()], SCOPE, true);
		expect(found).toEqual([{ rule: "untracked-commit", sha: bad.sha, detail: "the commit has no Task: trailer" }]);
	});

	test("without strict a commit without Task: is tolerated", () => {
		expect(guard([stray()], SCOPE, false)).toEqual([]);
	});

	test("a merge commit is never untracked", () => {
		expect(guard([commit({ merge: true, tasks: [], planRev: undefined })], SCOPE, true)).toEqual([]);
	});

	test("path rules still apply to a merge commit's first-parent diff", () => {
		const merge = commit({ merge: true, tasks: [], planRev: undefined, changes: [change("tsconfig.json")] });
		expect(rules(guard([merge], SCOPE, true))).toEqual(["config-changed"]);
	});
});

describe("ordering", () => {
	test("findings follow commit order, then rule order within a commit", () => {
		const lockCommit = commit({ locks: ["T1"], locked: ["src/locked.test.ts"] });
		const bad = commit({
			planRev: undefined,
			tasks: ["T1"],
			changes: [change("src/locked.test.ts"), change("tsconfig.json")],
			added: added("src/locked.test.ts", 'it.skip("x", f);', "// @ts-ignore"),
		});
		const stray = commit({ tasks: [], planRev: undefined });
		const found = guard([lockCommit, bad, stray], SCOPE, true);
		expect(found.map(v => `${v.sha === bad.sha ? "bad" : "stray"}:${v.rule}`)).toEqual([
			"bad:plan-rev-missing",
			"bad:locked-test-changed",
			"bad:skip-added",
			"bad:ignore-added",
			"bad:config-changed",
			"stray:untracked-commit",
		]);
	});

	test("a plan problem, an unknown task and an out-of-scope path come in rule order", () => {
		const found = guard(
			[commit({ tasks: ["T1", "T9"], changes: [change("docs/x.md")] })],
			{ plan: plan(task("T1", { owns: ["src/**"] })), violations: [{ rule: "cycle", task: "T1", detail: "dependency cycle: T1 -> T1" }] },
		);
		expect(rules(found)).toEqual(["plan-invalid", "unknown-task", "out-of-scope"]);
	});

	test("an empty range has no violations", () => {
		expect(guard([], SCOPE, true)).toEqual([]);
	});
});

describe("helpers", () => {
	test("inScope: exact, glob, directory prefix, literal brackets and ./ prefixes", () => {
		expect(inScope("src/a.ts", ["src/a.ts"])).toBe(true);
		expect(inScope("src/a.ts", ["src/*.ts"])).toBe(true);
		expect(inScope("src/deep/a.ts", ["src/*.ts"])).toBe(false);
		expect(inScope("src/deep/a.ts", ["src"])).toBe(true);
		expect(inScope("src/deep/a.ts", ["./src/"])).toBe(true);
		expect(inScope("srcx/a.ts", ["src"])).toBe(false);
		expect(inScope("web/[id]/page.tsx", ["web/[id]/page.tsx"])).toBe(true);
		expect(inScope("src/a.ts", [])).toBe(false);
		expect(inScope("src/a.ts", ["", "./"])).toBe(false);
	});

	test("formatViolation prints rule, short sha, task, path and detail", () => {
		expect(formatViolation({ rule: "out-of-scope", sha: "0123456789abcdef", task: "T1", path: "src/x.ts", detail: "outside" })).toBe("out-of-scope 0123456 T1 src/x.ts: outside");
		expect(formatViolation({ rule: "untracked-commit", sha: "0123456789abcdef", detail: "no Task" })).toBe("untracked-commit 0123456: no Task");
	});
});
