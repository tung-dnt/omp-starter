// Haiku spend ledger (plan D, Spend). Pure.
export const CAP_USD = 2;
export const PER_RUN_USD = 0.25;

/** The checker cap; `--cap` may only lower it. */
export function capFor(requested?: number): number {
	return requested === undefined ? CAP_USD : Math.min(CAP_USD, requested);
}

/** A haiku run starts only while spent + the per-run budget stays within the cap. */
export function mayStartHaiku(spentUsd: number, cap: number): boolean {
	return spentUsd + PER_RUN_USD <= cap + 1e-9;
}

/** Sum of costUsd over the slot lines of a run log (JSONL text). */
export function slotCostOf(jsonl: string): number {
	let total = 0;
	for (const line of jsonl.split("\n")) {
		if (!line.trim()) continue;
		try {
			const e = JSON.parse(line);
			if (e.kind === "slot") total += Number(e.costUsd) || 0;
		} catch {
			// a torn line is not spend we can attribute
		}
	}
	return total;
}
