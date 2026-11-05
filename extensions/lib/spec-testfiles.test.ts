import { describe, expect, test } from "bun:test";
import { isTestPath } from "./spec-testfiles";

describe("isTestPath: built-in patterns", () => {
	test("test and spec files, in any folder", () => {
		for (const path of ["a.test.ts", "src/a.test.ts", "src/deep/a.spec.js", "pkg/foo_test.go", "pkg/test_foo.py", "test_foo.py", "./src/a.test.ts", "src/a.test.tsx"]) {
			expect(isTestPath(path)).toBe(true);
		}
	});

	test("anything under __tests__/ or tests/", () => {
		for (const path of ["__tests__/helper.ts", "src/__tests__/helper.ts", "tests/fixtures/data.json", "pkg/tests/util.py"]) expect(isTestPath(path)).toBe(true);
	});

	test("source files, and names that only contain the words, are not tests", () => {
		for (const path of ["src/foo.ts", "src/latest.ts", "src/contest.ts", "src/testing/runner.ts", "src/test.ts", "src/attest_x.ts", "README.md", "t/t1.sh"]) {
			expect(isTestPath(path)).toBe(false);
		}
	});
});

describe("isTestPath: checks.test_paths replaces the built-ins", () => {
	const checks = { test_paths: ["t/**", "spec/", "src/**/*.check.ts"] };

	test("matches the declared globs and directories", () => {
		for (const path of ["t/t1.sh", "t/deep/x.sh", "spec/a.rb", "src/a/b.check.ts"]) expect(isTestPath(path, checks)).toBe(true);
	});

	test("a built-in test name outside the declared paths is not a test", () => {
		for (const path of ["src/a.test.ts", "tests/a.ts", "src/foo.ts"]) expect(isTestPath(path, checks)).toBe(false);
	});

	test("an absent test_paths means the built-ins", () => {
		expect(isTestPath("src/a.test.ts", {})).toBe(true);
	});
});
