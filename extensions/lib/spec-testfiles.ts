// Which files of a repo count as tests. The scheduler lets the tests phase of a task write only these, locks only these and runs only
// these through the "fails before" check. A repo's plan may declare its own patterns (`checks.test_paths`); without them the built-in
// patterns below apply, anywhere in the tree.
import { inScope } from "./spec-guard";
import type { RepoChecks } from "./spec-plan";

/** Built-in test file patterns: `*.test.*`, `*.spec.*`, `*_test.*`, `test_*.*`, and everything under `__tests__/` or `tests/`. */
const BUILT_IN = ["**/*.test.*", "**/*.spec.*", "**/*_test.*", "**/test_*.*", "**/__tests__/**", "**/tests/**"].map(pattern => new Bun.Glob(pattern));

/**
 * True when `path` (relative to the repo root) is a test file. A repo's `checks.test_paths` replaces the built-in patterns; each entry
 * is a file, a glob or a directory, as for a task's `owns`.
 */
export function isTestPath(path: string, repoChecks?: Pick<RepoChecks, "test_paths">): boolean {
	const file = path.replace(/^(?:\.\/)+/, "");
	const declared = repoChecks?.test_paths;
	if (declared !== undefined) return inScope(file, declared);
	return BUILT_IN.some(glob => glob.match(file));
}
