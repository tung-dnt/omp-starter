// The PR body format of the lead-driven workflow (pr-format.md, next to hard-gates.md, describes it to the agent; templates.ts
// holds that text). The lead reads the decision log, the invariant checklist and the risk summary before any code,
// so a PR is not opened until they are there and every proving test they name exists.
import * as fs from "node:fs";
import * as path from "node:path";
import { DATA_CATEGORIES, type GateCategory, type HardGates, type ProofRow } from "./artifacts";
import { matchRepoFiles } from "./gates";
import type { ActiveStory } from "./registry";

export interface PrBodyInput {
	body: string;
	/** Repository root the PR comes from. */
	repo: string;
	story?: ActiveStory;
	gates: HardGates;
	/** Changed paths of the branch, repo-root relative. */
	changed: string[];
	/** Lines the branch adds. */
	added: string[];
	/** `+ edge` / `- edge` lines of docs/arch/edges.json against the merge base. */
	edgesDiff?: string[];
	/** An agent changed a project note's services block during the story. */
	mapEdited?: boolean;
	/** The approved plan's proof rows; present in a lead story. `repoName` is this repository's project-note name. */
	proof?: { rows: ProofRow[]; repoName: string };
}

const TESTREF = /test:\s*(\S+?)::(.+?)\s*$/;
const EDGES_FILE = "docs/arch/edges.json";

/** Non-empty lines after `## <name>` up to the next `## `, or undefined when the section is missing. */
function section(body: string, name: string): string[] | undefined {
	const lines = body.split("\n");
	const at = lines.findIndex(line => line.trimEnd() === `## ${name}`);
	if (at < 0) return undefined;
	const rest = lines.slice(at + 1);
	const end = rest.findIndex(line => line.startsWith("## "));
	return (end < 0 ? rest : rest.slice(0, end)).map(line => line.trim()).filter(Boolean);
}

/** Problems that keep a PR body from being opened; empty when it follows the format. */
export function checkPrBody(input: PrBodyInput): string[] {
	const { body, repo, story, gates } = input;
	const problems: string[] = [];
	const required = (name: string): string[] | undefined => {
		const lines = section(body, name);
		if (!lines) problems.push(`Missing section: ## ${name}`);
		return lines;
	};
	/** Checks that a `test: path::name` reference names a test that exists; false when the line has none. */
	const proven = (line: string): boolean => {
		const ref = TESTREF.exec(line);
		if (!ref) return false;
		let text = "";
		try {
			text = fs.readFileSync(path.join(repo, ref[1]), "utf8");
		} catch {}
		if (!text.includes(ref[2])) problems.push(`test reference ${ref[1]}::${ref[2]} not found`);
		return true;
	};

	const decisions = required("Decision log");
	if (decisions && !decisions.some(line => line.startsWith("- "))) problems.push("Decision log: list each choice as `- <choice> — rejected: <alternative> (<why>)`");

	const invariants = required("Invariant checklist");
	if (invariants) {
		const none = invariants.length === 1 && invariants[0] === "none";
		if (!story && !none && !invariants.some(line => TESTREF.test(line))) problems.push("Invariant checklist: list invariants with `test: path::test name` or write `none`");
		const checked = new Set<string>();
		for (const line of invariants) {
			if (proven(line)) checked.add(/^- (I\d+):/.exec(line)?.[1] ?? "");
		}
		for (const inv of story?.invariants ?? []) {
			if (!checked.has(inv.id)) problems.push(`Invariant ${inv.id} has no proving test (format: - ${inv.id}: … — test: path::test name)`);
		}
	}

	const risks = required("Risk summary");
	if (risks && !risks.some(line => /^- .*[\w./-]+:\d+/.test(line))) problems.push("Risk summary: each risk needs a file:line pointer");

	const { paths, patterns } = gates.concurrencyTriggers;
	const triggerGlobs = paths.map(p => new Bun.Glob(p));
	if (input.changed.some(file => triggerGlobs.some(glob => glob.match(file))) || input.added.some(line => patterns.some(pattern => pattern.test(line)))) {
		const note = required("Concurrency note");
		for (const field of note ? ["Idempotency", "Ordering", "Failure", "Transactions"] : []) {
			if (!note!.some(line => line.startsWith(`${field}:`) && line.length > field.length + 1)) problems.push(`Concurrency note: missing ${field}`);
		}
	}

	const gated = new Set(matchRepoFiles(repo, input.changed, gates.gates).map(hit => hit.gate.category as GateCategory));
	const edgesChanged = input.changed.includes(EDGES_FILE);
	if (DATA_CATEGORIES.some(category => gated.has(category))) {
		const ddia = required("DDIA checklist");
		for (let n = 1; ddia && n <= 12; n++) {
			const line = ddia.find(l => new RegExp(`^${n}\\. (yes|no)\\b`).test(l));
			if (!line) problems.push(`DDIA item ${n} unanswered`);
			else if (line.startsWith(`${n}. yes`) && !(line.includes("mechanism:") && proven(line))) problems.push(`DDIA item ${n}: yes needs mechanism: and test: path::name`);
		}
	}
	if (gated.has("contract") || edgesChanged || input.mapEdited) {
		const diff = required("System-map diff");
		if (diff?.length === 0) problems.push("System-map diff: say what changed in the project note's services, one line per service");
	}
	if (input.edgesDiff?.length) {
		const structural = required("Structural changes");
		for (const edge of structural ? input.edgesDiff : []) {
			if (!structural!.includes(edge)) problems.push(`Structural changes: missing ${edge}`);
		}
	}
	if (input.proof) {
		const proven = input.proof.rows.filter(row => row.repo === input.proof?.repoName && row.unprovable === undefined);
		const evidence = proven.length ? required("Evidence") : undefined;
		for (const row of evidence ? proven : []) {
			if (!evidence!.some(line => line.startsWith(`- ${row.ac}:`))) problems.push(`Evidence: no line for ${row.ac}`);
		}
		const unproven = input.proof.rows.filter(row => row.unprovable !== undefined);
		const accepted = unproven.length ? required("Unproven") : undefined;
		for (const row of accepted ? unproven : []) {
			if (!accepted!.some(line => line.startsWith(`- ${row.ac}: `))) problems.push(`Unproven: no line for ${row.ac}`);
		}
	}
	return problems;
}
