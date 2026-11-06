// The rules that turn repeats of a scenario into one evidence verdict, and the rule for a narrowed run (plan D.5-D.7). Pure, so
// `selftest` can run them: check.ts supplies the callback that really runs a repeat.
import { mayStartHaiku } from "./ledger.ts";
import { rowVerdict, type Verdict } from "./verdict.ts";

export interface RepeatResult {
	pass: boolean;
	spendUsd: number;
	detail: string;
}

export interface ScenarioJudgement {
	verdict: Verdict;
	detail: string;
	/** The ledger after this scenario. */
	spent: number;
}

/**
 * One verdict for a scenario: every repeat must pass (a haiku scenario has 3, Decision 4), a failed repeat is FAIL, a repeat the cap or
 * `--no-haiku` kept from starting is MISSING, and FAIL beats MISSING. A host that throws is a failed repeat.
 */
export function judgeScenario(o: {
	runner: "haiku" | "scripted";
	repeats: number;
	noHaiku: boolean;
	cap: number;
	spent: number;
	run(repeat: number): RepeatResult;
}): ScenarioJudgement {
	if (o.noHaiku && o.runner === "haiku") return { verdict: "MISSING", detail: "skipped by --no-haiku", spent: o.spent };
	let spent = o.spent;
	const verdicts: Verdict[] = [];
	const details: string[] = [];
	for (let n = 1; n <= o.repeats; n++) {
		if (o.runner === "haiku" && !mayStartHaiku(spent, o.cap)) {
			verdicts.push("MISSING");
			details.push(`repeat ${n} not started: cap (spent $${spent.toFixed(2)} of $${o.cap})`);
			continue;
		}
		let result: RepeatResult;
		try {
			result = o.run(n);
		} catch (error) {
			result = { pass: false, spendUsd: 0, detail: `host error: ${error}` };
		}
		spent += result.spendUsd;
		verdicts.push(result.pass ? "PASS" : "FAIL");
		details.push(`repeat ${n}: ${result.pass ? "PASS" : `FAIL (${result.detail})`}`);
	}
	return { verdict: rowVerdict(verdicts), detail: details.join("; "), spent };
}

/** A run is narrowed, and can never exit 0, when it was cut down with `--only` or `--no-haiku`, or is unpinned (a flag, or a pin that did not match). */
export function isNarrowed(o: { only: boolean; noHaiku: boolean; unpinned: boolean; pinMatched: boolean }): boolean {
	return o.only || o.noHaiku || o.unpinned || !o.pinMatched;
}
