// Lead-driven workflow artifacts in the knowledge base serving a folder: the lead's hard gates and story briefs, the
// agent's plan, each repository's project note, and the state the harness records (approvals, gate decisions, status).
// They live under `<kb>/lead/` unless the knowledge base's `lead` setting names other folders (LeadLayout).
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { atomicWrite, withFileLock } from "../file-lock";
import { forms, inside, resolveKb, within } from "../kb-sources";
import { splitNote } from "../memory-notes";
import { repoRoot, resolveRepoName } from "../repo";
import { expandHome, HOME, type KbSource, tildify } from "../state";
import { BRIEF_TEMPLATE, HARD_GATES_TEMPLATE, PR_FORMAT } from "./templates";

const hash = (algorithm: "sha1" | "sha256", text: string): string => crypto.createHash(algorithm).update(text).digest("hex");
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Absolute folders of the lead files of one knowledge base. */
export interface LeadLayout {
	/** hard-gates.md, pr-format.md and retro-log.md, next to the lead's own policy notes. */
	policy: string;
	/** One folder per story: `<stories>/<id>/` holds brief.md, plan.md, state.json and status.md. */
	stories: string;
	/** brief-template.md. */
	templates: string;
	/** One note per repository, `<notes>/<repo>.md`: always `<kb>/projects`, the place the knowledge base's AGENTS.md names. */
	notes: string;
}

/** `lead/`, `lead/stories/` and `lead/` of the knowledge base, each replaced by the folder the source's `lead` setting names. */
export function leadLayout(source: Pick<KbSource, "kbRef" | "lead">): LeadLayout {
	const kb = expandHome(source.kbRef);
	const at = (folder: unknown, fallback: string): string => path.resolve(kb, typeof folder === "string" && folder ? expandHome(folder) : fallback);
	return {
		policy: at(source.lead?.policy, "lead"),
		stories: at(source.lead?.stories, path.join("lead", "stories")),
		templates: at(source.lead?.templates, "lead"),
		notes: path.join(kb, "projects"),
	};
}

/** Layout of the knowledge base serving `cwd`, or undefined when none serves it. */
export function leadLayoutFor(cwd: string): LeadLayout | undefined {
	const source = resolveKb(cwd);
	return source && leadLayout(source);
}

/** Whether `/starter lead` has set the workflow up: hard-gates.md exists. One that iCloud evicted still counts. */
export function leadReady(layout: LeadLayout): boolean {
	return ["hard-gates.md", ".hard-gates.md.icloud"].some(name => fs.existsSync(path.join(layout.policy, name)));
}

/** Whether `p` is in one of the layout's folders. */
export const inLead = (layout: LeadLayout, p: string): boolean =>
	[layout.policy, layout.stories, layout.templates, layout.notes].some(dir => inside(p, dir));

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
export function readHardGates(policyDir: string): { gates?: HardGates; error?: string } {
	const file = path.join(policyDir, "hard-gates.md");
	const cache = path.join(HOME, ".omp", "agent", "lead-cache", `hard-gates-${hash("sha1", policyDir).slice(0, 16)}.md`);
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
		const evicted = fs.existsSync(path.join(policyDir, ".hard-gates.md.icloud"));
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

// ── Project notes ────────────────────────────────────────────────────────────

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

/** The machine-readable part of a repository's note: its first ```yaml block that has `services:`. */
export interface ProjectNote {
	services: Service[];
	/** Standing "must never break" lines of the project: context for the agent, not checked. */
	invariants: string[];
	/** The block as written. */
	block: string;
}

/** Name of a repository's project note: the basename of its origin URL, else of its folder. */
export const noteName = (repo: string): string => resolveRepoName(repo) ?? path.basename(repo);

/** The project-note names of `repos` (roots), each once: worktrees of one repository share a note. */
export const noteNames = (repos: string[]): string[] => [...new Set(repos.map(noteName))];

const YAML_BLOCKS = /^```ya?ml[^\n]*\n([\s\S]*?)^```[ \t]*$/gm;

/** What `<notesDir>/<repoName>.md` says about the repository's services, or why it cannot be used. */
export function readProjectNote(notesDir: string, repoName: string): { note?: ProjectNote; error?: string } {
	const file = path.join(notesDir, `${repoName}.md`);
	let text: string;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch {
		return { error: `project note missing: ${tildify(file)}` };
	}
	try {
		const block = Array.from(text.matchAll(YAML_BLOCKS), match => match[1]).find(body => /^services\s*:/m.test(body));
		if (block === undefined) throw new Error("no ```yaml block with services:");
		const doc: unknown = Bun.YAML.parse(block);
		if (!isObject(doc) || !Array.isArray(doc.services)) throw new Error("services: expected a list");
		const services = doc.services.map((raw: unknown, i): Service => {
			if (!isObject(raw) || typeof raw.name !== "string") throw new Error(`services[${i}]: needs a name`);
			if (raw.repo !== undefined && raw.repo !== repoName) throw new Error(`service ${raw.name}.repo: this note describes ${repoName}; leave repo out`);
			if (raw.path !== undefined && typeof raw.path !== "string") throw new Error(`service ${raw.name}.path: expected a string`);
			return {
				name: raw.name,
				repo: repoName,
				path: raw.path ?? "",
				ownsTables: strings(raw.owns_tables, `service ${raw.name}.owns_tables`, []),
				publishes: strings(raw.publishes, `service ${raw.name}.publishes`, []),
				consumes: strings(raw.consumes, `service ${raw.name}.consumes`, []),
				calls: strings(raw.calls, `service ${raw.name}.calls`, []),
			};
		});
		return { note: { services, invariants: strings(doc.invariants, "invariants", []), block: block.trimEnd() } };
	} catch (error) {
		return { error: `project note ${tildify(file)}: ${message(error)}` };
	}
}

/** One problem per repository of `repos` (roots) whose project note is missing or has no usable services block. */
export function undescribedRepos(layout: LeadLayout, repos: string[]): string[] {
	return noteNames(repos).flatMap(name => readProjectNote(layout.notes, name).error ?? []);
}

// ── Note freshness ───────────────────────────────────────────────────────────

/** Today as YYYY-MM-DD in local time, the form a note's `updated:` is written in. */
export const today = (): string => new Date().toLocaleDateString("en-CA");

/** A note's `updated:` date (YYYY-MM-DD) and how many "(inferred — verify)" markers it still carries. */
export function noteAge(text: string): { updated?: string; unverified: number } {
	let updated: unknown;
	try {
		updated = frontmatter(text).data.updated;
	} catch {
		// Frontmatter that is not YAML has no date.
	}
	const day = updated instanceof Date ? updated.toISOString() : typeof updated === "string" ? updated : "";
	return { updated: /^\d{4}-\d{2}-\d{2}/.exec(day)?.[0], unverified: text.match(/\(inferred\b[^)]*\)/gi)?.length ?? 0 };
}

/** What the lead sees of one note before approving against it: its age and what in it nobody has verified. */
function freshnessLine(file: string, now: string): string {
	let text: string;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch {
		return `${path.basename(file, ".md")}: missing`;
	}
	const { updated, unverified } = noteAge(text);
	const age = updated ? `updated ${updated} (${Math.round((Date.parse(now) - Date.parse(updated)) / 86_400_000)} days ago)` : "no updated: date";
	return `${path.basename(file, ".md")}: ${age}, ${unverified} unverified`;
}

/** Freshness of the project notes of `repos` (roots), then of the lead's own notes in the policy folder. Shown, never enforced. */
export function freshnessLines(layout: LeadLayout, repos: string[], now = today()): string[] {
	let policyNotes: string[] = [];
	try {
		policyNotes = fs
			.readdirSync(layout.policy)
			.filter(name => name.endsWith(".md") && !POLICY_OWNED[name] && name !== "brief-template.md")
			.sort();
	} catch {
		// No policy folder yet: nothing to report.
	}
	return [...noteNames(repos).map(name => path.join(layout.notes, `${name}.md`)), ...policyNotes.map(name => path.join(layout.policy, name))].map(file => freshnessLine(file, now));
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
	/** Non-empty lines of `## Boundaries`. */
	boundaries: string[];
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
	let boundaries: string[] = [];
	for (const heading of BRIEF_HEADINGS) {
		const lines = section(body, heading);
		if (!lines?.length) {
			errors.push(`brief: missing or empty section "## ${heading}"`);
			continue;
		}
		if (heading === "Boundaries") boundaries = lines;
		if (heading !== "Invariants") continue;
		for (const line of lines) {
			const m = INVARIANT.exec(line);
			if (m) invariants.push({ id: m[1], text: m[2] });
		}
		if (!invariants.length && !(lines.length === 1 && lines[0].trim() === "none")) errors.push("Invariants: list them as `- I1: …` or write `none`");
	}
	if (errors.length) return { errors };
	return { brief: { mode: mode as Brief["mode"], invariants, boundaries, text: body.trim() }, errors };
}

export interface Plan {
	/** Symlink-resolved roots of the repositories the plan reads or changes. */
	repos: string[];
	/** Non-empty lines of `## Summary`: the current plan in brief. The agent replaces them as the approach changes. */
	summary: string[];
	text: string;
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
	return { plan: { repos, summary, text }, errors };
}

/**
 * What the lead's approval covers: the plan's repositories and the brief's invariants and boundaries. The plan's
 * summary and tasks are the agent's to replace as the work changes; a change to any covered part needs approval again.
 */
export function approvalDigest(plan: Plan, brief: Brief): string {
	return hash("sha256", JSON.stringify({ repos: plan.repos, invariants: brief.invariants, boundaries: brief.boundaries }));
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
	/** When an agent last changed a project note's services block during the story; the PR body must then describe the change. */
	mapEditedAt: string | null;
}

export function readStoryState(storyDir: string): StoryState {
	let text: string;
	try {
		text = fs.readFileSync(path.join(storyDir, "state.json"), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		return { plan: null, gates: {}, status: null, mapEditedAt: null };
	}
	const state = JSON.parse(text) as Partial<StoryState>;
	return { plan: state.plan ?? null, gates: state.gates ?? {}, status: state.status ?? null, mapEditedAt: state.mapEditedAt ?? null };
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

const POLICY_OWNED: Record<string, true> = { "hard-gates.md": true, "retro-log.md": true, "pr-format.md": true };
const STORY_OWNED = /^[^/]+\/(?:brief\.md|state\.json|status\.md)$/;

/** `absPath` relative to `dir` with `/` separators, in each symlink form in which it is at or below `dir`. */
const relativeTo = (dir: string, absPath: string): string[] =>
	forms(absPath).flatMap(p => forms(dir).filter(d => within(p, d)).map(d => path.relative(d, p).split(path.sep).join("/")));

/** Whether `absPath` is a lead file agents must not write with write/edit (the plan and the project notes are theirs to keep current). */
export function protectedLeadPath(layout: LeadLayout, absPath: string): boolean {
	return (
		relativeTo(layout.policy, absPath).some(rel => POLICY_OWNED[rel]) ||
		relativeTo(layout.templates, absPath).includes("brief-template.md") ||
		relativeTo(layout.stories, absPath).some(rel => STORY_OWNED.test(rel))
	);
}

/** Creates the lead files. The lead's files are written only when missing; pr-format.md is rewritten every time. */
export function initLead(layout: LeadLayout): { created: string[]; kept: string[] } {
	for (const dir of [layout.policy, layout.stories, layout.templates]) fs.mkdirSync(dir, { recursive: true });
	const created: string[] = [];
	const kept: string[] = [];
	const files: [dir: string, name: string, content: string, always: boolean][] = [
		[layout.policy, "hard-gates.md", HARD_GATES_TEMPLATE, false],
		[layout.templates, "brief-template.md", BRIEF_TEMPLATE, false],
		[layout.policy, "pr-format.md", PR_FORMAT, true],
	];
	for (const [dir, name, content, always] of files) {
		const file = path.join(dir, name);
		const exists = fs.existsSync(file);
		(exists ? kept : created).push(file);
		if (!exists || always) atomicWrite(file, content);
	}
	return { created, kept };
}

/**
 * Brings the generated files in step with this plugin version at session start. pr-format.md describes checks that
 * live in code, so it is rewritten when it differs. brief-template.md may be the lead's own: it is never overwritten,
 * and a difference is reported once per shipped template (a marker outside the vault remembers which one was reported).
 */
export function syncGenerated(layout: LeadLayout): { prFormatRewritten: boolean; briefTemplateDiffers: boolean } {
	const read = (file: string): string | undefined => {
		try {
			return fs.readFileSync(file, "utf8");
		} catch {
			return undefined;
		}
	};
	const prFormat = path.join(layout.policy, "pr-format.md");
	const prFormatRewritten = read(prFormat) !== PR_FORMAT;
	if (prFormatRewritten) atomicWrite(prFormat, PR_FORMAT);

	const template = read(path.join(layout.templates, "brief-template.md"));
	if (template === undefined || template === BRIEF_TEMPLATE) return { prFormatRewritten, briefTemplateDiffers: false };
	const marker = path.join(HOME, ".omp", "agent", "lead-cache", `brief-template-${hash("sha1", layout.templates).slice(0, 16)}.seen`);
	const shipped = hash("sha1", BRIEF_TEMPLATE);
	if (read(marker) === shipped) return { prFormatRewritten, briefTemplateDiffers: false };
	fs.mkdirSync(path.dirname(marker), { recursive: true });
	atomicWrite(marker, shipped);
	return { prFormatRewritten, briefTemplateDiffers: true };
}
