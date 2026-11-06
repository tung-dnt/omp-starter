// The scheduler's agent slots: what each slot is (agent definition, model role, tools, write scope, thinking level), the prompt
// code builds for it, the JSON schema of its verdict, and the reader that validates what the slot yielded.
// Pure: no I/O. `spec-scheduler.ts` decides when a slot runs and what each verdict leads to; `spec-slot-runner.ts` is the SDK side.
import { RISK_FIELDS } from "./spec-risk";
import type { RepoChecks, TaskBlock } from "./spec-plan";
import { errorMessage, isRecord } from "./tooling/runtime";

export const SLOT_NAMES = ["test_author", "test_review", "implementer", "code_review", "security_review"] as const;
export type SlotName = (typeof SLOT_NAMES)[number];

export type ModelRole = "tiny" | "task" | "slow";
/** Always explicit: under `auto` a worker calls the Jev classifier and sends content to TypeSafe (spike finding 3). */
export type SlotThinking = "low" | "medium" | "high";

/** What the scheduler hands a slot runner. */
export interface SlotSpec {
	slot: SlotName;
	/** The task the slot works for; the story-end review names only its repo (`id: "story"`). */
	task: Pick<TaskBlock, "id" | "repo">;
	story: string;
	cwd: string;
	prompt: string;
	/** Patterns the slot may write; empty for a read-only slot. */
	writeScope: string[];
	/** Locked test files, relative to `cwd`. */
	lockedFiles: string[];
	/** The tests phase: the slot may write test files only (`isTestPath`), however wide its `writeScope`. */
	testsOnly?: boolean;
	/** The repo's `checks.test_paths`, which replaces the built-in test file patterns; used with `testsOnly`. */
	testPaths?: string[];
	/** JSON schema of the verdict (`outputSchema`). */
	schema: object;
	modelRole: ModelRole;
	thinkingLevel: SlotThinking;
	/** Name of the agent definition whose body becomes the slot's instructions. */
	agent: string;
	maxContextTokens: number;
}

export interface SlotResult {
	/** What the slot yielded, as it came: an object, or a string that holds JSON. Undefined when it yielded nothing. */
	payload: unknown;
	/** Summed from the usage of each assistant `message_end`. */
	costUsd: number;
	sessionFile?: string;
	/** The largest context a request of the slot carried. */
	contextTokens: number;
	/** `context`: the runner stopped the slot at the context ceiling. `signal`: the caller's signal fired. */
	aborted?: "context" | "signal";
	/** Why there is no payload when the slot ended without a verdict (for example, it yielded an error). */
	error?: string;
}

export interface SlotRunner {
	run(spec: SlotSpec, signal: AbortSignal): Promise<SlotResult>;
}

/** The verdicts each slot may return. Every value leads to a fixed branch in the scheduler; none is left to agent judgement. */
export const VERDICTS = {
	test_author: ["pass", "spec_wrong", "need_clarification", "blocked"],
	test_review: ["pass", "fix", "spec_wrong"],
	implementer: ["pass", "test_wrong", "need_shared_change", "need_clarification", "blocked"],
	code_review: ["pass", "fix", "spec_wrong"],
	security_review: ["pass", "fix", "spec_wrong"],
} as const;

/** The verdicts that stop a task and open a gate; `pass` and a review's `fix` are the other two kinds. */
export const STOP_VERDICTS = ["spec_wrong", "test_wrong", "need_shared_change", "need_clarification", "blocked"] as const;
export type StopVerdict = (typeof STOP_VERDICTS)[number];
export const isStopVerdict = (verdict: string): verdict is StopVerdict => STOP_VERDICTS.some(stop => stop === verdict);

export const SEVERITIES = ["low", "medium", "high", "critical"] as const;
export type Severity = (typeof SEVERITIES)[number];

/** `patient_data`: patient or personal data in logs, errors, fixtures, test data, prompts or third-party flows. Only a security review sets it. */
export const FINDING_CATEGORIES = ["patient_data", "other"] as const;
export type FindingCategory = (typeof FINDING_CATEGORIES)[number];

export interface Finding {
	path: string;
	line?: number;
	severity: Severity;
	text: string;
	/** Set on every finding of a `security_review`, never on a `code_review` finding: silence is not `other`. */
	category?: FindingCategory;
}

export interface TestAuthorVerdict {
	verdict: (typeof VERDICTS.test_author)[number];
	tests: string[];
	/** Acceptance criterion (as written in the plan) → the test that covers it. */
	acceptance_map: Record<string, string>;
	/** Why, for a verdict other than `pass`. An addition to the brief's payload: a stop verdict needs somewhere to say what is wrong. */
	notes: string;
}

export interface TestReviewVerdict {
	verdict: (typeof VERDICTS.test_review)[number];
	unmapped: string[];
	findings: string[];
}

export interface ImplementerVerdict {
	verdict: (typeof VERDICTS.implementer)[number];
	notes: string;
	checks_run: string[];
}

export interface ReviewVerdict {
	verdict: (typeof VERDICTS.code_review)[number];
	findings: Finding[];
}

export interface SlotVerdicts {
	test_author: TestAuthorVerdict;
	test_review: TestReviewVerdict;
	implementer: ImplementerVerdict;
	code_review: ReviewVerdict;
	security_review: ReviewVerdict;
}

export interface SlotDefinition {
	/** The agent-skills definition loaded with `discoverAgents` and passed as `appendSystemPrompt`. */
	agent: string;
	modelRole: ModelRole;
	thinkingLevel: SlotThinking;
	/** Tool names of the session; `yield` is added by `requireYieldTool`. No slot has `find`, `task`, `ask`, `todo` or MCP. */
	tools: readonly string[];
	/** `scope`: may write the task's `owns` and `new_paths`; `none`: read-only. */
	writes: "scope" | "none";
	verdicts: readonly string[];
	schema: object;
}

const strings = { type: "array", items: { type: "string" } } as const;
const verdictField = (values: readonly string[]) => ({ type: "string", enum: values }) as const;

const FINDING = {
	type: "object",
	properties: {
		path: { type: "string" },
		line: { type: "integer" },
		severity: { type: "string", enum: SEVERITIES },
		text: { type: "string" },
	},
	required: ["path", "severity", "text"],
	additionalProperties: false,
} as const;

/** A security finding must say whether it is about patient data: the category is required, so a missing one fails the payload. */
const SECURITY_FINDING = {
	...FINDING,
	properties: { ...FINDING.properties, category: { type: "string", enum: FINDING_CATEGORIES } },
	required: [...FINDING.required, "category"],
} as const;

const object = (properties: Record<string, object>, required: readonly string[]): object => ({
	type: "object",
	properties,
	required,
	additionalProperties: false,
});

const TEST_AUTHOR_SCHEMA = object(
	{
		verdict: verdictField(VERDICTS.test_author),
		tests: strings,
		acceptance_map: { type: "object", additionalProperties: { type: "string" } },
		notes: { type: "string" },
	},
	["verdict", "tests", "acceptance_map"],
);
const TEST_REVIEW_SCHEMA = object({ verdict: verdictField(VERDICTS.test_review), unmapped: strings, findings: strings }, ["verdict", "unmapped", "findings"]);
const IMPLEMENTER_SCHEMA = object({ verdict: verdictField(VERDICTS.implementer), notes: { type: "string" }, checks_run: strings }, ["verdict", "notes", "checks_run"]);
/** Both review slots return the same verdict values; a security review's findings also carry a category. */
const REVIEW_SCHEMA = object({ verdict: verdictField(VERDICTS.code_review), findings: { type: "array", items: FINDING } }, ["verdict", "findings"]);
const SECURITY_SCHEMA = object({ verdict: verdictField(VERDICTS.security_review), findings: { type: "array", items: SECURITY_FINDING } }, ["verdict", "findings"]);

const WRITING_TOOLS = ["read", "glob", "ast_grep", "lsp", "edit", "write", "bash"] as const;
const READING_TOOLS = ["read", "glob", "ast_grep", "lsp"] as const;

/** The slot table of the brief ("Agent slots"): definition, model role, tools and write scope per slot. */
export const SLOTS: Record<SlotName, SlotDefinition> = {
	test_author: { agent: "test-engineer", modelRole: "task", thinkingLevel: "medium", tools: WRITING_TOOLS, writes: "scope", verdicts: VERDICTS.test_author, schema: TEST_AUTHOR_SCHEMA },
	implementer: { agent: "task-builder", modelRole: "task", thinkingLevel: "medium", tools: WRITING_TOOLS, writes: "scope", verdicts: VERDICTS.implementer, schema: IMPLEMENTER_SCHEMA },
	test_review: { agent: "code-reviewer", modelRole: "slow", thinkingLevel: "medium", tools: READING_TOOLS, writes: "none", verdicts: VERDICTS.test_review, schema: TEST_REVIEW_SCHEMA },
	code_review: { agent: "code-reviewer", modelRole: "slow", thinkingLevel: "high", tools: READING_TOOLS, writes: "none", verdicts: VERDICTS.code_review, schema: REVIEW_SCHEMA },
	security_review: { agent: "security-auditor", modelRole: "slow", thinkingLevel: "high", tools: READING_TOOLS, writes: "none", verdicts: VERDICTS.security_review, schema: SECURITY_SCHEMA },
};

/** `spec:<story>:<task>:<slot>`: the session title that tells a slot's session from a main session in the usage report. */
export const slotTitle = (story: string, task: string, slot: SlotName): string => `spec:${story}:${task}:${slot}`;

/** The review slots of a task's code: not the test review, which belongs to the test stage. */
export type CodeReviewSlot = "code_review" | "security_review";

/** The review slots a task earns: a code review when any technical risk is `yes`, a security review when the plan flags it. */
export function reviewsFor(task: TaskBlock): CodeReviewSlot[] {
	const reviews: CodeReviewSlot[] = [];
	if (RISK_FIELDS.some(field => field !== "sensitive_data" && task.risk[field].value === "yes")) reviews.push("code_review");
	if (task.security_review) reviews.push("security_review");
	return reviews;
}

// ── Reading a payload ────────────────────────────────────────────────────────────────────────────────────────────────

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/** Typed reads from the payload; the first problem is kept and every later read returns undefined. */
class Reader {
	error: string | undefined;
	constructor(readonly data: Record<string, unknown>) {}

	#fail(message: string): undefined {
		this.error ??= message;
		return undefined;
	}

	verdict<T extends string>(values: readonly T[]): T | undefined {
		const found = values.find(value => value === this.data.verdict);
		return found ?? this.#fail(`"verdict" must be one of ${values.join(", ")}, got ${JSON.stringify(this.data.verdict)}`);
	}

	strings(key: string): string[] | undefined {
		const value = this.data[key];
		if (Array.isArray(value) && value.every(item => typeof item === "string")) return value;
		return this.#fail(`"${key}" must be an array of strings`);
	}

	string(key: string, fallback?: string): string | undefined {
		const value = this.data[key];
		if (typeof value === "string") return value;
		if (value === undefined && fallback !== undefined) return fallback;
		return this.#fail(`"${key}" must be a string`);
	}

	stringMap(key: string): Record<string, string> | undefined {
		const value = this.data[key];
		if (isRecord(value) && Object.values(value).every(item => typeof item === "string")) return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, String(item)]));
		return this.#fail(`"${key}" must be an object that maps each criterion to a test name`);
	}

	findings(key: string, withCategory = false): Finding[] | undefined {
		const value = this.data[key];
		if (!Array.isArray(value)) return this.#fail(`"${key}" must be an array of findings`);
		const found: Finding[] = [];
		for (const [i, item] of value.entries()) {
			if (!isRecord(item) || typeof item.path !== "string" || typeof item.text !== "string") return this.#fail(`"${key}[${i}]" needs a string path and a string text`);
			const severity = SEVERITIES.find(candidate => candidate === item.severity);
			if (severity === undefined) return this.#fail(`"${key}[${i}].severity" must be one of ${SEVERITIES.join(", ")}`);
			if (item.line !== undefined && item.line !== null && (typeof item.line !== "number" || !Number.isInteger(item.line))) return this.#fail(`"${key}[${i}].line" must be an integer`);
			const category = FINDING_CATEGORIES.find(candidate => candidate === item.category);
			if (withCategory && category === undefined) return this.#fail(`"${key}[${i}].category" must be one of ${FINDING_CATEGORIES.join(", ")}`);
			found.push({ path: item.path, ...(typeof item.line === "number" ? { line: item.line } : {}), severity, text: item.text, ...(withCategory && category !== undefined ? { category } : {}) });
		}
		return found;
	}
}

const bad = (error: string): { ok: false; error: string } => ({ ok: false, error });

const READERS: { [S in SlotName]: (reader: Reader) => Parsed<SlotVerdicts[S]> } = {
	test_author(reader) {
		const verdict = reader.verdict(VERDICTS.test_author);
		const tests = reader.strings("tests");
		const acceptance_map = reader.stringMap("acceptance_map");
		const notes = reader.string("notes", "");
		if (reader.error !== undefined || verdict === undefined || !tests || !acceptance_map || notes === undefined) return bad(reader.error ?? "the payload is incomplete");
		return { ok: true, value: { verdict, tests, acceptance_map, notes } };
	},
	test_review(reader) {
		const verdict = reader.verdict(VERDICTS.test_review);
		const unmapped = reader.strings("unmapped");
		const findings = reader.strings("findings");
		if (reader.error !== undefined || verdict === undefined || !unmapped || !findings) return bad(reader.error ?? "the payload is incomplete");
		if (verdict === "fix" && findings.length + unmapped.length === 0) return bad('verdict "fix" needs at least one finding');
		return { ok: true, value: { verdict, unmapped, findings } };
	},
	implementer(reader) {
		const verdict = reader.verdict(VERDICTS.implementer);
		const notes = reader.string("notes");
		const checks_run = reader.strings("checks_run");
		if (reader.error !== undefined || verdict === undefined || notes === undefined || !checks_run) return bad(reader.error ?? "the payload is incomplete");
		return { ok: true, value: { verdict, notes, checks_run } };
	},
	code_review: reader => readReview(reader, VERDICTS.code_review, false),
	security_review: reader => readReview(reader, VERDICTS.security_review, true),
};

function readReview(reader: Reader, values: typeof VERDICTS.code_review, withCategory: boolean): Parsed<ReviewVerdict> {
	const verdict = reader.verdict(values);
	const findings = reader.findings("findings", withCategory);
	if (reader.error !== undefined || verdict === undefined || !findings) return bad(reader.error ?? "the payload is incomplete");
	if (verdict === "fix" && findings.length === 0) return bad('verdict "fix" needs at least one finding');
	return { ok: true, value: { verdict, findings } };
}

/**
 * Validates what a slot yielded. A worker may yield the JSON as a string even in strict mode (spike finding 2), so a string is
 * parsed first. A payload that fails is a failed attempt for the scheduler, with `error` as the reason it hands the next run.
 */
export function parseVerdict<S extends SlotName>(slot: S, payload: unknown): Parsed<SlotVerdicts[S]> {
	let data = payload;
	if (typeof data === "string") {
		try {
			data = JSON.parse(data);
		} catch (error) {
			return bad(`the payload is a string that is not valid JSON (${errorMessage(error)})`);
		}
	}
	if (data === undefined || data === null) return bad("the slot yielded no payload");
	if (!isRecord(data)) return bad("the payload is not a JSON object");
	return READERS[slot](new Reader(data));
}

/** Findings as the plain lines the next run of the implementer or test author reads. */
export function findingLines(findings: readonly Finding[]): string[] {
	return findings.map(finding => `[${finding.severity}${finding.category === "patient_data" ? ", patient_data" : ""}] ${finding.path}${finding.line === undefined ? "" : `:${finding.line}`}: ${finding.text}`);
}

// ── Prompts ──────────────────────────────────────────────────────────────────────────────────────────────────────────

export const DIFF_LIMIT = 80_000;

/** The diff as the prompt carries it: cut at `max` characters with a note that says how much is missing. */
export function limitDiff(text: string, max = DIFF_LIMIT): string {
	return text.length <= max ? text : `${text.slice(0, max)}\n[diff cut: ${text.length - max} more characters; read the files for the rest]`;
}

export interface PromptInput {
	slot: SlotName;
	story: string;
	/** The task, or for the story-end review every task of the repo under review. */
	tasks: readonly TaskBlock[];
	/** `story`: the code review over the whole ticket diff of one repo. */
	scope?: "task" | "story";
	/** Absolute path of `plan.md` in the vault work tree. */
	planFile: string;
	planRev: string;
	/** Absolute path of the slot's working directory. */
	cwd: string;
	/** `tests`: the implementer of a small task writes the tests first; `implement`: the locked tests exist. */
	phase?: "tests" | "implement";
	lockedFiles?: readonly string[];
	/** The task's test files, for the reviewers. */
	testFiles?: readonly string[];
	attempt?: { n: number; of: number };
	/** What the previous run of this stage left to fix: check output, review findings, why a run was rejected. */
	findings?: readonly string[];
	/** Text a human typed at a gate. */
	notes?: readonly string[];
	/** The change under review and the ref it is measured from. */
	diff?: { text: string; from: string };
	/** The repo's check commands, which the scheduler runs after the slot. */
	checks?: RepoChecks;
	/** Absolute path of the task's LLD, when it names one. */
	lldFile?: string;
}

const PREAMBLE = [
	"You are one bounded step of an automated spec workflow, not a chat: nobody answers questions. Work only in the working directory below.",
	"When you are done, call the `yield` tool once with your verdict as `data` (the shape is at the end).",
	"Never run a git command that changes state (commit, add, reset, checkout, stash, merge, cherry-pick, push): the scheduler makes every commit, and a git change rejects your run.",
];

const bullets = (items: readonly string[], empty = "none"): string[] => (items.length === 0 ? [`- ${empty}`] : items.map(item => `- ${item}`));

/** The meaning of each verdict, as the slot reads it. */
const MEANING: Record<SlotName, Record<string, string>> = {
	test_author: {
		pass: "the tests are written and each acceptance criterion and required test has one",
		spec_wrong: "the acceptance criteria contradict each other or the code, so no test can be right; explain in notes",
		need_clarification: "a criterion is ambiguous in a way that changes the tests; put the question in notes",
		blocked: "tooling or the environment stops you (not the spec); put the evidence in notes",
	},
	test_review: {
		pass: "every acceptance criterion and required test maps to a test that would fail without the feature and pass with it",
		fix: "tests are missing, wrong or too weak; list each problem in findings and each uncovered criterion or required test in unmapped",
		spec_wrong: "the acceptance criteria themselves are contradictory or impossible; explain in findings",
	},
	implementer: {
		pass: "the implementation is done and you ran the checks you could; the scheduler runs the real checks afterwards",
		test_wrong: "a locked test is wrong or impossible to satisfy; say which and why in notes (you cannot edit it)",
		need_shared_change: "the task needs a change outside the files you may write; say which in notes",
		need_clarification: "the task is ambiguous in a way that changes the code; put the question in notes",
		blocked: "tooling or the environment stops you (not the spec); put the evidence in notes",
	},
	code_review: {
		pass: "no defect, spec deviation or missing test that must be fixed before merge",
		fix: "something must be fixed; each finding names a file, a line when it has one, a severity and what to change",
		spec_wrong: "the code is right for the plan but the plan or acceptance criteria are wrong; explain in findings",
	},
	security_review: {
		pass: "no security or data-protection problem that must be fixed before merge",
		fix: "something must be fixed; each finding names a file, a line when it has one, a severity and what to change",
		spec_wrong: "the plan itself would force an insecure design; explain in findings",
	},
};

const SHAPE: Record<SlotName, string> = {
	test_author: '{"verdict": "pass", "tests": ["<test file or name>"], "acceptance_map": {"<criterion as written>": "<test that covers it>"}, "notes": ""}',
	test_review: '{"verdict": "pass", "unmapped": [], "findings": []}',
	implementer: '{"verdict": "pass", "notes": "<what you did>", "checks_run": ["<command you ran>"]}',
	code_review: '{"verdict": "pass", "findings": [{"path": "<file>", "line": 12, "severity": "low|medium|high|critical", "text": "<what to change>"}]}',
	security_review: '{"verdict": "pass", "findings": [{"path": "<file>", "line": 12, "severity": "low|medium|high|critical", "category": "patient_data|other", "text": "<what to change>"}]}',
};

/** What counts as a test file in the tests phase, as the prompt says it: the repo's `checks.test_paths`, else the built-in patterns. */
function testFileRule(input: PromptInput): string {
	const declared = input.checks?.test_paths;
	const names = declared !== undefined && declared.length > 0 ? declared.join(", ") : "*.test.*, *.spec.*, *_test.*, test_*.*, and everything under __tests__/ or tests/";
	return `Test files are: ${names}. A write to any other file rejects your run.`;
}

function role(input: PromptInput): string[] {
	switch (input.slot) {
		case "test_author":
			return [
				"Role: test author. Write the tests first; the feature does not exist yet and must not be implemented by you.",
				"Cover every acceptance criterion and every required test id below, in the repo's own test style, so each test fails now and passes once the feature is built.",
				"Write only test files (and fixtures they need). Do not edit production code.",
				testFileRule(input),
			];
		case "implementer":
			return input.phase === "tests"
				? [
						"Role: implementer, tests first (a small task). Write the tests for this task now; the implementation comes in a later run.",
						"Cover every acceptance criterion and required test id below, in the repo's own test style, so each test fails now and passes once the feature is built.",
						"Write only test files (and fixtures they need). Do not edit production code. Report `pass` when the tests are written.",
						testFileRule(input),
					]
				: [
						"Role: implementer. Make the locked tests pass by changing production code inside the files you may write.",
						"The locked tests are frozen: you cannot edit them, and a change to one rejects your run. If one is wrong, report `test_wrong`.",
						"Do not weaken checks, add skips or suppressions, or touch lint, type or test configuration unless it is listed under the files you may write.",
					];
		case "test_review":
			return [
				"Role: test reviewer (read-only: you change nothing). Judge the new tests against the acceptance criteria and required tests below.",
				"A test that passes without the feature, asserts nothing meaningful, or only restates the implementation does not count as coverage.",
			];
		case "code_review":
			return input.scope === "story"
				? [
						"Role: code reviewer for the whole pull request (read-only: you change nothing). The diff below is the full change of this repo for the story.",
						"Check spec compliance against every task's acceptance criteria, risk-test coverage, test-to-acceptance mapping, correctness, readability, architecture and performance.",
					]
				: [
						"Role: code reviewer (read-only: you change nothing). The diff below is this task's change.",
						"Check spec compliance against the acceptance criteria, risk-test coverage, correctness, readability, architecture and performance.",
					];
		case "security_review":
			return [
				"Role: security reviewer (read-only: you change nothing). The diff below is this task's change.",
				"Check authorisation on every new path, personal or patient data in logs, errors, fixtures or prompts, secrets handling, input validation of external data, data minimisation and new third-party data flows.",
				"Give every finding a `category`: `patient_data` when patient or personal data is, or would be, written to logs or errors, kept in fixtures or test data, put in prompts or sent through a third-party data flow; `other` for everything else.",
				"A `patient_data` finding blocks the merge until a human decides. Cite the file and line, and never quote the data itself.",
			];
	}
}

function taskBlock(task: TaskBlock, input: PromptInput): string[] {
	const lines = [`### Task ${task.id} (repo ${task.repo}, size ${task.size})`, "Acceptance criteria:", ...task.acceptance.map((criterion, i) => `${i + 1}. ${criterion}`)];
	lines.push("Required test ids:", ...bullets(task.required_tests));
	const risks = RISK_FIELDS.filter(field => task.risk[field].value === "yes").map(field => `${field}: ${task.risk[field].reason ?? "no reason given"}`);
	lines.push("Risks marked yes:", ...bullets(risks));
	if (input.slot === "test_author" || input.slot === "implementer") {
		lines.push("Files you may write (owns, then new_paths):", ...bullets([...task.owns, ...task.new_paths], "none (you cannot change any file)"));
		lines.push("Files you may read for context:", ...bullets(task.reads));
	}
	if (input.lldFile !== undefined) lines.push(`LLD: ${input.lldFile}`);
	else if (task.lld_skip_reason) lines.push(`LLD skipped: ${task.lld_skip_reason}`);
	return lines;
}

/** The prompt of one slot run, built from the task block and what earlier runs left behind. It never starts with `/`, so it cannot be read as a command. */
export function buildPrompt(input: PromptInput): string {
	const lines = [`# Spec workflow ${input.slot}: ${input.story}`, "", ...PREAMBLE, "", ...role(input), "", "## Where"];
	lines.push(`Working directory: ${input.cwd}`, `Plan: ${input.planFile} at revision ${input.planRev} (read only; never edit it)`);
	if (input.attempt) lines.push(`This is attempt ${input.attempt.n} of ${input.attempt.of}.`);

	lines.push("", "## Task");
	for (const task of input.tasks) lines.push(...taskBlock(task, input), "");
	if (input.scope === "story") lines.splice(lines.length - 1, 0, "Review every task above as one change.");

	if (input.checks !== undefined) {
		const commands = (["test", "typecheck", "lint"] as const)
			.filter(name => input.checks?.[name]?.trim())
			.map(name => `${name}: ${input.checks?.[name]}`);
		if (commands.length > 0) lines.push("## Checks the scheduler runs after your run", ...bullets(commands), "");
	}
	if (input.lockedFiles !== undefined && input.lockedFiles.length > 0) {
		lines.push("## Locked tests (frozen; you cannot edit them)", ...bullets(input.lockedFiles), "");
	}
	if (input.testFiles !== undefined && input.testFiles.length > 0) lines.push("## The task's test files", ...bullets(input.testFiles), "");
	if (input.diff !== undefined) lines.push(`## Diff (against ${input.diff.from})`, "```diff", limitDiff(input.diff.text), "```", "");
	if (input.findings !== undefined && input.findings.length > 0) {
		lines.push("## To fix from the previous run", "The previous run did not pass. Address every point:", ...bullets(input.findings), "");
	}
	if (input.notes !== undefined && input.notes.length > 0) lines.push("## Notes from the human who owns this task", ...bullets(input.notes), "");

	const meanings = Object.entries(MEANING[input.slot]).map(([verdict, meaning]) => `\`${verdict}\`: ${meaning}`);
	lines.push("## Verdict", `Call \`yield\` with \`data\` shaped like: ${SHAPE[input.slot]}`, "Verdict values:", ...bullets(meanings));
	return lines.join("\n");
}
