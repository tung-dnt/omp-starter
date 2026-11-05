import { errorMessage, isRecord } from "./tooling/runtime";
import { RISK_FIELDS } from "./spec-risk";
import type { Violation } from "./spec-validate";

export type RiskField =
	| "shared_state"
	| "external_io"
	| "retries"
	| "concurrent_writers"
	| "non_idempotent_effects"
	| "async_messaging"
	| "multi_step_saga"
	| "sensitive_data";

export interface RiskEntry {
	value: "yes" | "no";
	reason?: string;
}

export type TaskSize = "small" | "normal";

export interface TaskBlock {
	id: string;
	repo: string;
	depends_on: string[];
	foundation: boolean;
	owns: string[];
	new_paths: string[];
	reads: string[];
	risk: Record<RiskField, RiskEntry>;
	lld_required: boolean;
	security_review: boolean;
	lld?: string;
	lld_skip_reason?: string;
	required_tests: string[];
	acceptance: string[];
	size: TaskSize;
}

/** The commands `spec-check` runs for one repo. An empty command is a skipped check; `test` is required (rule `checks-missing`). */
export interface RepoChecks {
	test?: string;
	/** Run once per locked test file by the "fails before" check; `{files}` and `{packages}` are replaced by that file and its package directory. */
	test_files?: string;
	/**
	 * Globs, files or directories that count as this repo's test files, replacing the built-in patterns (`*.test.*`, `*.spec.*`, `*_test.*`,
	 * `test_*.*`, `__tests__/`, `tests/`). The tests phase of a task may write, and the lock covers, only these.
	 */
	test_paths?: string[];
	typecheck?: string;
	lint?: string;
}

export interface Plan {
	id: string;
	kind: "story" | "task";
	shared_paths: string[];
	/** Check commands keyed by the tasks' `repo` (`org/name`); an absent `checks` block reads as empty. */
	checks: Record<string, RepoChecks>;
	tasks: TaskBlock[];
}

export type ParseResult = { ok: true; plan: Plan } | { ok: false; errors: Violation[] };

interface Block {
	kind: "plan" | "task";
	/** 1-based position among the `yaml plan` / `yaml task` blocks of the file. */
	index: number;
	text: string;
}

const OPEN_FENCE = /^ {0,3}(`{3,})[ \t]*(.*?)[ \t]*$/;

/** Machine-read blocks: fenced with the info string `yaml plan` or `yaml task`. All other text, including other fences, is skipped. A machine-read fence that never closes is returned in `unclosed`. */
function extractBlocks(markdown: string): { blocks: Block[]; unclosed: Block | undefined } {
	const blocks: Block[] = [];
	let open: { ticks: number; kind: Block["kind"] | undefined; lines: string[] } | undefined;
	for (const line of markdown.split(/\r?\n/)) {
		if (!open) {
			const match = OPEN_FENCE.exec(line);
			if (!match) continue;
			const info = match[2].split(/\s+/).join(" ");
			open = { ticks: match[1].length, kind: info === "yaml plan" ? "plan" : info === "yaml task" ? "task" : undefined, lines: [] };
			continue;
		}
		const close = /^ {0,3}(`{3,})[ \t]*$/.exec(line);
		if (close && close[1].length >= open.ticks) {
			if (open.kind) blocks.push({ kind: open.kind, index: blocks.length + 1, text: open.lines.join("\n") });
			open = undefined;
		} else {
			open.lines.push(line);
		}
	}
	const unclosed = open?.kind ? { kind: open.kind, index: blocks.length + 1, text: open.lines.join("\n") } : undefined;
	return { blocks, unclosed };
}

const isStringList = (v: unknown): v is string[] => Array.isArray(v) && v.every(item => typeof item === "string");

/** Typed reads from one YAML mapping; every miss is reported as a `field` violation and returns undefined. */
class Reader {
	constructor(
		private readonly data: Record<string, unknown>,
		private readonly label: string,
		private readonly task: string | undefined,
		private readonly errors: Violation[],
	) {}

	fail(detail: string): void {
		this.errors.push({ rule: "field", ...(this.task === undefined ? {} : { task: this.task }), detail: `${this.label}: ${detail}` });
	}

	string(key: string, opts: { optional?: boolean; nonEmpty?: boolean } = {}): string | undefined {
		const value = this.data[key];
		if (value === undefined && opts.optional) return undefined;
		if (typeof value !== "string") {
			this.fail(value === undefined ? `missing field "${key}"` : `field "${key}" must be a string`);
			return undefined;
		}
		if (opts.nonEmpty && !value.trim()) {
			this.fail(`field "${key}" must not be empty`);
			return undefined;
		}
		return value;
	}

	boolean(key: string): boolean | undefined {
		const value = this.data[key];
		if (typeof value === "boolean") return value;
		this.fail(value === undefined ? `missing field "${key}"` : `field "${key}" must be a boolean`);
		return undefined;
	}

	/** An optional one-of string; an absent key reads as `fallback`. */
	choice<T extends string>(key: string, allowed: readonly T[], fallback: T): T | undefined {
		const value = this.data[key];
		if (value === undefined) return fallback;
		const match = allowed.find(item => item === value);
		if (match === undefined) this.fail(`field "${key}" must be one of ${allowed.join(", ")}`);
		return match;
	}

	strings(key: string): string[] | undefined {
		const value = this.data[key];
		if (isStringList(value)) return value;
		this.fail(value === undefined ? `missing field "${key}"` : `field "${key}" must be a list of strings`);
		return undefined;
	}

	/** An optional mapping; an absent or empty (null) key reads as an empty mapping. */
	mapping(key: string): Record<string, unknown> | undefined {
		const value = this.data[key];
		if (value === undefined || value === null) return {};
		if (isRecord(value)) return value;
		this.fail(`field "${key}" must be a mapping`);
		return undefined;
	}

	record(key: string): Record<string, unknown> | undefined {
		const value = this.data[key];
		if (isRecord(value)) return value;
		this.fail(value === undefined ? `missing field "${key}"` : `field "${key}" must be a mapping`);
		return undefined;
	}
}

const isCompleteRisk = (risk: Partial<Record<RiskField, RiskEntry>>): risk is Record<RiskField, RiskEntry> =>
	RISK_FIELDS.every(field => risk[field] !== undefined);

function parseRisk(reader: Reader): Record<RiskField, RiskEntry> | undefined {
	const raw = reader.record("risk");
	if (!raw) return undefined;
	let valid = true;
	const known = new Set<string>(RISK_FIELDS);
	for (const key of Object.keys(raw)) {
		if (known.has(key)) continue;
		reader.fail(`unknown risk field "${key}"`);
		valid = false;
	}
	const risk: Partial<Record<RiskField, RiskEntry>> = {};
	for (const field of RISK_FIELDS) {
		const entry = raw[field];
		if (entry === undefined) {
			reader.fail(`missing risk field "${field}"`);
			valid = false;
		} else if (!isRecord(entry) || (entry.value !== "yes" && entry.value !== "no")) {
			reader.fail(`risk "${field}" needs value: yes or no`);
			valid = false;
		} else if (entry.reason !== undefined && typeof entry.reason !== "string") {
			reader.fail(`risk "${field}" reason must be a string`);
			valid = false;
		} else {
			risk[field] = entry.reason === undefined ? { value: entry.value } : { value: entry.value, reason: entry.reason };
		}
	}
	return valid && isCompleteRisk(risk) ? risk : undefined;
}

const CHECK_NAMES: readonly (keyof RepoChecks)[] = ["test", "test_files", "test_paths", "typecheck", "lint"];
const isCheckName = (name: string): name is keyof RepoChecks => CHECK_NAMES.some(known => known === name);

/** The `checks` mapping: per repo, command strings by check name. An empty (or null) command is a skipped check. */
function parseChecks(reader: Reader): Record<string, RepoChecks> | undefined {
	const raw = reader.mapping("checks");
	if (!raw) return undefined;
	const checks: Record<string, RepoChecks> = {};
	let valid = true;
	for (const [repo, entry] of Object.entries(raw)) {
		if (!isRecord(entry)) {
			reader.fail(`checks "${repo}" must be a mapping of commands`);
			valid = false;
			continue;
		}
		const commands: RepoChecks = {};
		for (const [name, command] of Object.entries(entry)) {
			if (!isCheckName(name)) {
				reader.fail(`unknown check "${name}" for "${repo}"; use ${CHECK_NAMES.join(", ")}`);
				valid = false;
			} else if (name === "test_paths") {
				if (isStringList(command) && command.length > 0 && command.every(pattern => pattern.trim() !== "")) {
					commands.test_paths = command;
				} else {
					reader.fail(`check "test_paths" for "${repo}" must be a non-empty list of path patterns`);
					valid = false;
				}
			} else if (command !== null && typeof command !== "string") {
				reader.fail(`check "${name}" for "${repo}" must be a string`);
				valid = false;
			} else {
				commands[name] = command ?? "";
			}
		}
		checks[repo] = commands;
	}
	return valid ? checks : undefined;
}

function parseTask(data: Record<string, unknown>, label: string, errors: Violation[]): TaskBlock | undefined {
	const task = typeof data.id === "string" && data.id.trim() ? data.id : undefined;
	const reader = new Reader(data, label, task, errors);
	const before = errors.length;
	const id = reader.string("id", { nonEmpty: true });
	const repo = reader.string("repo", { nonEmpty: true });
	const depends_on = reader.strings("depends_on");
	const foundation = reader.boolean("foundation");
	const owns = reader.strings("owns");
	const new_paths = reader.strings("new_paths");
	const reads = reader.strings("reads");
	const risk = parseRisk(reader);
	const lld_required = reader.boolean("lld_required");
	const security_review = reader.boolean("security_review");
	const lld = reader.string("lld", { optional: true });
	const lld_skip_reason = reader.string("lld_skip_reason", { optional: true });
	const size = reader.choice("size", ["small", "normal"], "normal");
	const required_tests = reader.strings("required_tests");
	const acceptance = reader.strings("acceptance");
	if (
		errors.length > before || id === undefined || repo === undefined || !depends_on || foundation === undefined || !owns || !new_paths ||
		!reads || !risk || lld_required === undefined || security_review === undefined || size === undefined || !required_tests || !acceptance
	) {
		return undefined;
	}
	return {
		id, repo, depends_on, foundation, owns, new_paths, reads, risk, lld_required, security_review, size,
		...(lld === undefined ? {} : { lld }),
		...(lld_skip_reason === undefined ? {} : { lld_skip_reason }),
		required_tests, acceptance,
	};
}

/** Parses a `plan.md`. Reports every problem it finds; a plan is returned only when there are none. */
export function parsePlan(markdown: string): ParseResult {
	const errors: Violation[] = [];
	const { blocks, unclosed } = extractBlocks(markdown);
	const planBlocks = blocks.filter(block => block.kind === "plan");
	if (unclosed) {
		errors.push({ rule: "parse", detail: `block ${unclosed.index} (yaml ${unclosed.kind}): fence is never closed` });
	}
	const planCount = planBlocks.length + (unclosed?.kind === "plan" ? 1 : 0);
	if (planCount !== 1) {
		errors.push({ rule: "parse", detail: `expected exactly one "yaml plan" block, found ${planCount}` });
	}

	let header: { id: string; kind: "story" | "task"; shared_paths: string[]; checks: Record<string, RepoChecks> } | undefined;
	const tasks: TaskBlock[] = [];
	for (const block of blocks) {
		const label = `block ${block.index} (yaml ${block.kind})`;
		let data: unknown;
		try {
			data = Bun.YAML.parse(block.text);
		} catch (error) {
			errors.push({ rule: "parse", detail: `${label}: ${errorMessage(error)}` });
			continue;
		}
		if (!isRecord(data)) {
			errors.push({ rule: "field", detail: `${label}: block must be a mapping` });
			continue;
		}
		if (block.kind === "task") {
			const task = parseTask(data, label, errors);
			if (task) tasks.push(task);
			continue;
		}
		if (planBlocks.length !== 1) continue;
		const reader = new Reader(data, label, undefined, errors);
		const before = errors.length;
		const id = reader.string("id", { nonEmpty: true });
		const kind = reader.string("kind");
		const validKind = kind === "story" || kind === "task" ? kind : undefined;
		if (kind !== undefined && !validKind) reader.fail(`field "kind" must be story or task`);
		const shared_paths = reader.strings("shared_paths");
		const checks = parseChecks(reader);
		if (errors.length === before && id !== undefined && validKind && shared_paths && checks) header = { id, kind: validKind, shared_paths, checks };
	}
	if (errors.length > 0 || !header) return { ok: false, errors };
	return { ok: true, plan: { ...header, tasks } };
}
