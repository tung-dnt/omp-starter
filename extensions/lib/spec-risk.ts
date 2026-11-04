import type { RiskEntry, RiskField } from "./spec-plan";

export const RISK_FIELDS: readonly RiskField[] = [
	"shared_state",
	"external_io",
	"retries",
	"concurrent_writers",
	"non_idempotent_effects",
	"async_messaging",
	"multi_step_saga",
	"sensitive_data",
];

/** Test ids a plan must list in `required_tests` for each `yes` risk. `sensitive_data` implies none. */
export const IMPLIED_TESTS: Record<Exclude<RiskField, "sensitive_data">, string[]> = {
	shared_state: ["concurrent-writes"],
	external_io: ["io-failure-injection", "timeout"],
	retries: ["duplicate-request"],
	concurrent_writers: ["concurrent-writes", "race-detector"],
	non_idempotent_effects: ["duplicate-request"],
	async_messaging: ["duplicate-delivery", "out-of-order", "poison-to-dlq", "crash-before-ack"],
	multi_step_saga: ["compensation"],
};

/** Basename of a dependency manifest; a task that owns one needs a security review. */
export const DEPENDENCY_MANIFEST = /^(?:package\.json|bun\.lock|go\.mod|go\.sum|requirements[^/]*\.txt|pyproject\.toml|Cargo\.toml)$/;

/** What the risk answers alone require. The manifest rule is applied by `validatePlan`. */
export function routeRisk(risk: Record<RiskField, RiskEntry>): { lld_required: boolean; security_review: boolean; implied_tests: string[] } {
	const implied = new Set<string>();
	let lld_required = false;
	for (const field of RISK_FIELDS) {
		if (risk[field].value !== "yes" || field === "sensitive_data") continue;
		lld_required = true;
		for (const test of IMPLIED_TESTS[field]) implied.add(test);
	}
	return {
		lld_required,
		security_review: risk.external_io.value === "yes" || risk.sensitive_data.value === "yes",
		implied_tests: [...implied],
	};
}
