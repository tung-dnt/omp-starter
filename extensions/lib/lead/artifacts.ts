// Lead-driven workflow artifacts under `<kb>/lead/` of the knowledge base serving a folder: the lead's hard gates,
// system map and story briefs, the agent's plan, and the state the harness records (approvals, gate decisions, status).
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { atomicWrite, withFileLock } from "../file-lock";
import { forms, resolveKb, within } from "../kb-sources";
import { splitNote } from "../memory-notes";
import { repoRoot } from "../repo";
import { expandHome, HOME, tildify } from "../state";
import { BRIEF_TEMPLATE, HARD_GATES_TEMPLATE, PR_FORMAT, SYSTEM_MAP_TEMPLATE } from "./templates";

const hash = (algorithm: "sha1" | "sha256", text: string): string => crypto.createHash(algorithm).update(text).digest("hex");
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** `<kb>/lead` of the knowledge base serving `cwd`, or undefined when none serves it. */
export function leadDirFor(cwd: string): string | undefined {
	const source = resolveKb(cwd);
	return source ? path.join(expandHome(source.kbRef), "lead") : undefined;
}

/** Whether `/starter lead` has created the lead folder for `cwd`. */
export function leadReady(cwd: string): boolean {
	const dir = leadDirFor(cwd);
	return dir !== undefined && fs.existsSync(dir);
}

// ── YAML blocks ──────────────────────────────────────────────────────────────

type Yaml = Record<string, unknown>;
const isObject = (value: unknown): value is Yaml => typeof value === "object" && value !== null && !Array.isArray(value);

/** The first fenced ```yaml block of a Markdown file, parsed; throws when there is none or it is not a mapping. */
function yamlBlock(text: string): Yaml {
	const block = /^```ya?ml[^\n]*\n([\s\S]*?)^```[ \t]*$/m.exec(text);
	if (!block) throw new Error("no ```yaml block");
	const parsed: unknown = Bun.YAML.parse(block[1]);
	if (!isObject(parsed)) throw new Error("the yaml block must be a mapping");
	return parsed;
}

/** `value` as a list of strings; `undefined` gives `fallback`; anything else throws naming `where`. */
function strings(value: unknown, where: string, fallback?: string[]): string[] {
	if (value === undefined && fallback) return fallback;
	if (!Array.isArray(value) || value.some(v => typeof v !== "string")) throw new Error(`${where}: expected a list of strings`);
	return value as string[];
}

// ── Hard gates ───────────────────────────────────────────────────────────────

export const GATE_CATEGORIES = ["schema", "auth", "payment", "patient-data", "infra-concurrency", "contract", "dependency", "human-tests", "lead-owned"] as const;
export type GateCategory = (typeof GATE_CATEGORIES)[number];
/** Categories whose changes need the PR's DDIA checklist. */
export const DATA_CATEGORIES: GateCategory[] = ["schema", "patient-data", "infra-concurrency", "contract"];

export interface Gate {
	id: string;
	category: GateCategory;
	/** Origin basenames the gate applies to; `*` is every repository. */
	repos: string[];
	/** Globs matched against repository-relative paths. */
	paths: string[];
}

export interface HardGates {
	gates: Gate[];
	concurrencyTriggers: { paths: string[]; patterns: RegExp[] };
	limits: { builders: number };
}

const GATE_ID = /^[a-z0-9][a-z0-9-]*$/;

function parseHardGates(text: string): HardGates {
	const doc = yamlBlock(text);
	if (!Array.isArray(doc.gates)) throw new Error("gates: expected a list");
	const gates = doc.gates.map((raw: unknown, i): Gate => {
		if (!isObject(raw)) throw new Error(`gates[${i}]: expected a mapping`);
		if (typeof raw.id !== "string" || !GATE_ID.test(raw.id)) throw new Error(`gates[${i}].id: expected lowercase letters, digits and "-"`);
		if (!GATE_CATEGORIES.includes(raw.category as GateCategory)) {
			throw new Error(`gate ${raw.id}: category ${JSON.stringify(raw.category)} is not one of ${GATE_CATEGORIES.join(", ")}`);
		}
		return {
			id: raw.id,
			category: raw.category as GateCategory,
			repos: strings(raw.repos, `gate ${raw.id}.repos`, ["*"]),
			paths: strings(raw.paths, `gate ${raw.id}.paths`),
		};
	});
	const triggers = doc.concurrency_triggers === undefined ? {} : doc.concurrency_triggers;
	if (!isObject(triggers)) throw new Error("concurrency_triggers: expected a mapping");
	const patterns = strings(triggers.patterns, "concurrency_triggers.patterns", []).map(source => {
		try {
			return new RegExp(source);
		} catch (error) {
			throw new Error(`concurrency_triggers.patterns: ${message(error)}`);
		}
	});
	const limits = doc.limits === undefined ? {} : doc.limits;
	if (!isObject(limits)) throw new Error("limits: expected a mapping");
	const builders = limits.builders ?? 2;
	if (typeof builders !== "number" || !Number.isInteger(builders) || builders < 1) throw new Error("limits.builders: expected an integer of 1 or more");
	return { gates, concurrencyTriggers: { paths: strings(triggers.paths, "concurrency_triggers.paths", []), patterns }, limits: { builders } };
}

/**
 * The lead's hard gates. `{}` when hard-gates.md does not exist (none configured). When the file cannot be read or
 * is invalid, the last good copy is returned with `error`; with no such copy only `error`, and callers fail closed.
 */
export function readHardGates(leadDir: string): { gates?: HardGates; error?: string } {
	const file = path.join(leadDir, "hard-gates.md");
	const cache = path.join(HOME, ".omp", "agent", "lead-cache", `hard-gates-${hash("sha1", leadDir).slice(0, 16)}.md`);
	const cached = (): string | undefined => {
		try {
			return fs.readFileSync(cache, "utf8");
		} catch {
			return undefined;
		}
	};
	const lastGood = (reason: string): { gates?: HardGates; error?: string } => {
		try {
			return { gates: parseHardGates(cached() ?? ""), error: `${reason}; using last good copy` };
		} catch {
			return { error: reason };
		}
	};
	let text: string;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch (error) {
		// An iCloud-evicted file is unreadable, not absent.
		const evicted = fs.existsSync(path.join(leadDir, ".hard-gates.md.icloud"));
		if ((error as NodeJS.ErrnoException).code === "ENOENT" && !evicted) return {};
		return lastGood(`cannot read ${tildify(file)}${evicted ? " (evicted to iCloud)" : `: ${message(error)}`}`);
	}
	let gates: HardGates;
	try {
		gates = parseHardGates(text);
	} catch (error) {
		return lastGood(`${tildify(file)}: ${message(error)}`);
	}
	// Gates are read on every tool call; the copy is rewritten only when the file changed.
	if (cached() !== text) {
		fs.mkdirSync(path.dirname(cache), { recursive: true });
		atomicWrite(cache, text);
	}
	return { gates };
}

// ── System map ───────────────────────────────────────────────────────────────

export interface Service {
	name: string;
	/** Origin basename of the repository holding the service. */
	repo: string;
	/** Folder of the service inside the repository; "" for the root. */
	path: string;
	ownsTables: string[];
	publishes: string[];
	consumes: string[];
	calls: string[];
}

export function readSystemMap(leadDir: string): { services?: Service[]; text?: string; error?: string } {
	const file = path.join(leadDir, "system-map.md");
	let text: string;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch {
		return { error: `system map missing: ${tildify(file)} (run /starter lead)` };
	}
	try {
		const doc = yamlBlock(text);
		if (!Array.isArray(doc.services)) throw new Error("services: expected a list");
		const services = doc.services.map((raw: unknown, i): Service => {
			if (!isObject(raw) || typeof raw.name !== "string" || typeof raw.repo !== "string") throw new Error(`services[${i}]: needs name and repo`);
			if (raw.path !== undefined && typeof raw.path !== "string") throw new Error(`service ${raw.name}.path: expected a string`);
			return {
				name: raw.name,
				repo: raw.repo,
				path: raw.path ?? "",
				ownsTables: strings(raw.owns_tables, `service ${raw.name}.owns_tables`, []),
				publishes: strings(raw.publishes, `service ${raw.name}.publishes`, []),
				consumes: strings(raw.consumes, `service ${raw.name}.consumes`, []),
				calls: strings(raw.calls, `service ${raw.name}.calls`, []),
			};
		});
		return { services, text };
	} catch (error) {
		return { text, error: `system map ${tildify(file)}: ${message(error)}` };
	}
}

// ── Brief and plan ───────────────────────────────────────────────────────────

export const BRIEF_HEADINGS = ["Goal", "Success criteria", "Boundaries", "Invariants", "Must never break", "Out of scope"];

/** Non-empty lines under `## <heading>` up to the next `## `, or undefined when the heading is missing. */
function section(body: string, heading: string): string[] | undefined {
	const lines = body.split("\n");
	const at = lines.findIndex(line => line.trimEnd() === `## ${heading}`);
	if (at < 0) return undefined;
	const rest = lines.slice(at + 1);
	const end = rest.findIndex(line => line.startsWith("## "));
	return (end < 0 ? rest : rest.slice(0, end)).map(line => line.trimEnd()).filter(line => line.trim() !== "");
}

function frontmatter(text: string): { data: Yaml; body: string } {
	const note = splitNote(text);
	const parsed: unknown = note.frontmatter ? Bun.YAML.parse(note.frontmatter.join("\n")) : {};
	return { data: isObject(parsed) ? parsed : {}, body: note.body };
}

export interface Invariant {
	id: string;
	text: string;
}

export interface Brief {
	mode: "sync" | "async";
	invariants: Invariant[];
	/** The brief without its frontmatter. */
	text: string;
}

const INVARIANT = /^- (I\d+): (.+)$/;

/** The lead's brief for a story, with every problem that keeps planning from starting. */
export function readBrief(storyDir: string): { brief?: Brief; errors: string[] } {
	let text: string;
	try {
		text = fs.readFileSync(path.join(storyDir, "brief.md"), "utf8");
	} catch (error) {
		return { errors: [`brief: cannot read ${tildify(path.join(storyDir, "brief.md"))}: ${message(error)}`] };
	}
	const errors: string[] = [];
	let data: Yaml = {};
	let body = text;
	try {
		({ data, body } = frontmatter(text));
	} catch (error) {
		errors.push(`brief: frontmatter is not valid YAML (${message(error)})`);
	}
	const mode = data.mode ?? "sync";
	if (mode !== "sync" && mode !== "async") errors.push("brief: mode must be sync or async");
	const invariants: Invariant[] = [];
	for (const heading of BRIEF_HEADINGS) {
		const lines = section(body, heading);
		if (!lines?.length) {
			errors.push(`brief: missing or empty section "## ${heading}"`);
			continue;
		}
		if (heading !== "Invariants") continue;
		for (const line of lines) {
			const m = INVARIANT.exec(line);
			if (m) invariants.push({ id: m[1], text: m[2] });
		}
		if (!invariants.length && !(lines.length === 1 && lines[0].trim() === "none")) errors.push("Invariants: list them as `- I1: …` or write `none`");
	}
	if (errors.length) return { errors };
	return { brief: { mode: mode as Brief["mode"], invariants, text: body.trim() }, errors };
}

export interface Plan {
	/** Symlink-resolved roots of the repositories the plan reads or changes. */
	repos: string[];
	summary: string[];
	text: string;
	/** Hash of `repos` and `summary`: what the lead approves. The rest of the plan stays the agent's to edit. */
	digest: string;
}

const SUMMARY_MAX = 15;

export function readPlan(storyDir: string): { plan?: Plan; errors: string[] } {
	const file = path.join(storyDir, "plan.md");
	let text: string;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch {
		return { errors: [`plan: ${tildify(file)} not found`] };
	}
	const errors: string[] = [];
	let data: Yaml = {};
	let body = text;
	try {
		({ data, body } = frontmatter(text));
	} catch (error) {
		errors.push(`plan: frontmatter is not valid YAML (${message(error)})`);
	}
	const repos: string[] = [];
	if (!Array.isArray(data.repos) || data.repos.length === 0) errors.push("repos: list the absolute root of every repository in the frontmatter");
	else {
		for (const entry of data.repos as unknown[]) {
			let real: string | undefined;
			try {
				real = fs.realpathSync(expandHome(String(entry)));
			} catch {}
			if (real && repoRoot(real) === real) repos.push(real);
			else errors.push(`repos: ${String(entry)} is not a git repository root`);
		}
	}
	const summary = section(body, "Summary") ?? [];
	if (summary.length === 0) errors.push('plan: missing or empty section "## Summary"');
	else if (summary.length > SUMMARY_MAX) errors.push(`Summary: ${summary.length} lines; keep it to ${SUMMARY_MAX}`);
	if (errors.length) return { errors };
	return { plan: { repos, summary, text, digest: hash("sha256", JSON.stringify({ repos, summary })) }, errors };
}

// ── Story state ──────────────────────────────────────────────────────────────

export interface GateDecision {
	decision: "approved" | "rejected";
	gateId: string;
	category: string;
	at: string;
}

export interface StoryState {
	plan: { digest: string; approvedAt: string } | null;
	/** Gate decisions by gate key (`<repo root>::<repo-relative path>`). */
	gates: Record<string, GateDecision>;
	status: { value: "in-progress" | "in-review" | "done"; prs: { repo: string; url: string; state: string }[]; at: string } | null;
}

export function readStoryState(storyDir: string): StoryState {
	let text: string;
	try {
		text = fs.readFileSync(path.join(storyDir, "state.json"), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		return { plan: null, gates: {}, status: null };
	}
	const state = JSON.parse(text) as Partial<StoryState>;
	return { plan: state.plan ?? null, gates: state.gates ?? {}, status: state.status ?? null };
}

/** Lock file for a read-modify-write of `file`; in the temp dir, not the vault, so it never syncs. */
export const leadLock = (file: string): string => path.join(os.tmpdir(), `omp-starter-lead-${hash("sha1", file).slice(0, 16)}.lock`);

/** Applies `change` to the story's state under a lock and writes it; returns the new state. */
export function updateStoryState(storyDir: string, change: (state: StoryState) => void): Promise<StoryState> {
	const file = path.join(storyDir, "state.json");
	return withFileLock(leadLock(storyDir), `${tildify(file)} is being updated by another session; retry`, () => {
		const state = readStoryState(storyDir);
		change(state);
		fs.mkdirSync(storyDir, { recursive: true });
		atomicWrite(file, `${JSON.stringify(state, null, 2)}\n`);
		return state;
	});
}

// ── Ownership and setup ──────────────────────────────────────────────────────

const PROTECTED = /^(?:hard-gates\.md|system-map\.md|retro-log\.md|brief-template\.md|pr-format\.md|stories\/[^/]+\/(?:brief\.md|state\.json|status\.md))$/;

/** Whether `absPath` is a lead file agents must not write with write/edit (the plan file is theirs). */
export function protectedLeadPath(leadDir: string, absPath: string): boolean {
	return forms(absPath).some(p =>
		forms(leadDir).some(dir => within(p, dir) && PROTECTED.test(path.relative(dir, p).split(path.sep).join("/"))),
	);
}

/** Creates the lead folder. The lead's files are written only when missing; pr-format.md is rewritten every time. */
export function initLead(leadDir: string): { created: string[]; kept: string[] } {
	fs.mkdirSync(path.join(leadDir, "stories"), { recursive: true });
	const created: string[] = [];
	const kept: string[] = [];
	const files: [name: string, content: string, always: boolean][] = [
		["hard-gates.md", HARD_GATES_TEMPLATE, false],
		["system-map.md", SYSTEM_MAP_TEMPLATE, false],
		["brief-template.md", BRIEF_TEMPLATE, false],
		["pr-format.md", PR_FORMAT, true],
	];
	for (const [name, content, always] of files) {
		const file = path.join(leadDir, name);
		const exists = fs.existsSync(file);
		(exists ? kept : created).push(file);
		if (!exists || always) atomicWrite(file, content);
	}
	return { created, kept };
}
