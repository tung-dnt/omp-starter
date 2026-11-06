// Evidence verdicts and the row AND (plan D.4-D.7). Pure.
import type { TestCase } from "./junit.ts";

export type Verdict = "PASS" | "FAIL" | "MISSING";

export interface Evidence {
	kind: "bun-test" | "scenario";
	label: string;
	verdict: Verdict;
	detail: string;
	matched?: string[];
}

const samePath = (a: string, b: string): boolean => a.replace(/^\.\//, "") === b.replace(/^\.\//, "") || a.endsWith(`/${b}`);

/** A bun-test entry: its title or an ancestor describe title contains `name`. */
export function judgeBunTest(file: string, name: string, cases: TestCase[], fileExists: boolean): Evidence {
	const label = `${file} :: ${name}`;
	if (!fileExists) return { kind: "bun-test", label, verdict: "MISSING", detail: "file does not exist" };
	const hits = cases.filter(c => samePath(c.file, file) && (c.name.includes(name) || c.ancestors.some(a => a.includes(name))));
	if (hits.length === 0) return { kind: "bun-test", label, verdict: "MISSING", detail: "no runtime title carries this name" };
	const skipped = hits.filter(c => c.skipped).map(c => c.name);
	const failed = hits.filter(c => c.failed).map(c => c.name);
	const empty = hits.filter(c => !c.skipped && !c.failed && c.assertions === 0).map(c => c.name);
	const matched = hits.map(c => c.name);
	if (skipped.length || failed.length || empty.length) {
		const parts = [skipped.length && `skipped: ${skipped.join("; ")}`, failed.length && `failed: ${failed.join("; ")}`, empty.length && `zero assertions: ${empty.join("; ")}`].filter(Boolean);
		return { kind: "bun-test", label, verdict: "FAIL", detail: parts.join(" | "), matched };
	}
	return { kind: "bun-test", label, verdict: "PASS", detail: `${hits.length} testcase(s)`, matched };
}

/** Row = AND of its evidence: FAIL beats MISSING beats PASS; no evidence is MISSING. */
export function rowVerdict(verdicts: Verdict[]): Verdict {
	if (verdicts.length === 0) return "MISSING";
	if (verdicts.includes("FAIL")) return "FAIL";
	if (verdicts.includes("MISSING")) return "MISSING";
	return "PASS";
}

/**
 * Exit code (plan D.7). 2 harness error, 3 pin refused, 5 narrowed or unpinned run that would
 * otherwise be 0, 1 any row not PASS, 0 only for a complete pinned run with every row PASS.
 */
export function exitCode(o: { harnessError: boolean; pinRefused: boolean; narrowed: boolean; rowVerdicts: Verdict[] }): number {
	if (o.harnessError) return 2;
	if (o.pinRefused) return 3;
	const allPass = o.rowVerdicts.length > 0 && o.rowVerdicts.every(v => v === "PASS");
	if (!allPass) return 1;
	return o.narrowed ? 5 : 0;
}
