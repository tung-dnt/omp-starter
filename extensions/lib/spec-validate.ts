import type { Plan, TaskBlock } from "./spec-plan";
import { DEPENDENCY_MANIFEST, RISK_FIELDS, routeRisk } from "./spec-risk";

export type RuleId =
	| "parse"
	| "field"
	| "duplicate-id"
	| "cycle"
	| "missing-dep"
	| "owns-overlap"
	| "shared-path"
	| "risk-reason"
	| "size-risk"
	| "lld-missing"
	| "router-mismatch"
	| "required-tests"
	| "acceptance-empty"
	| "task-plan-size";

export interface Violation {
	rule: RuleId;
	task?: string;
	detail: string;
}

/** A violation and the index of the task it is reported under (undefined: the plan as a whole, listed last). */
interface Finding {
	at: number | undefined;
	violation: Violation;
}

const GLOB_META = /[*?[\]{}!]/;
const LISTED = 5;

/** Leading path segments of a pattern before its first glob segment: the directory a pattern is rooted at. */
function prefixSegments(pattern: string): string[] {
	const segments = pattern.split("/").filter(segment => segment && segment !== ".");
	const glob = segments.findIndex(segment => GLOB_META.test(segment));
	return glob === -1 ? segments : segments.slice(0, glob);
}

/** True when one prefix contains the other, segment by segment (`src/a` contains `src/a/b`, not `src/ab`). */
function prefixesOverlap(a: readonly string[], b: readonly string[]): boolean {
	const shared = Math.min(a.length, b.length);
	for (let i = 0; i < shared; i++) if (a[i] !== b[i]) return false;
	return true;
}

function listed(items: readonly string[]): string {
	return items.length > LISTED ? `${items.slice(0, LISTED).join(", ")} (+${items.length - LISTED} more)` : items.join(", ");
}

/** The repo files each pattern of a list matches. */
function expand(patterns: readonly string[], repoFiles: readonly string[]): Map<string, string[]> {
	const out = new Map<string, string[]>();
	for (const pattern of patterns) {
		const glob = new Bun.Glob(pattern);
		out.set(pattern, repoFiles.filter(file => glob.match(file)));
	}
	return out;
}

/** Index of the task the dependency edges lead to, by task id. Duplicate ids map to every task that carries them. */
function indexById(tasks: readonly TaskBlock[]): Map<string, number[]> {
	const byId = new Map<string, number[]>();
	tasks.forEach((task, i) => byId.set(task.id, [...(byId.get(task.id) ?? []), i]));
	return byId;
}

/** Elementary cycles found by a depth-first walk in task order; each back edge yields one, rotated to start at its first task. */
function findCycles(edges: readonly number[][]): number[][] {
	const cycles: number[][] = [];
	const seen = new Set<string>();
	const state: Array<"new" | "open" | "done"> = edges.map(() => "new");
	const stack: number[] = [];
	const visit = (node: number): void => {
		state[node] = "open";
		stack.push(node);
		for (const next of edges[node]) {
			if (state[next] === "open") {
				const cycle = stack.slice(stack.indexOf(next));
				const start = cycle.indexOf(Math.min(...cycle));
				const rotated = [...cycle.slice(start), ...cycle.slice(0, start)];
				const key = rotated.join(",");
				if (!seen.has(key)) {
					seen.add(key);
					cycles.push(rotated);
				}
			} else if (state[next] === "new") {
				visit(next);
			}
		}
		stack.pop();
		state[node] = "done";
	};
	edges.forEach((_, node) => {
		if (state[node] === "new") visit(node);
	});
	return cycles;
}

/** Every task index reachable from `from` through `depends_on`, not counting `from` unless a cycle returns to it. */
function reachable(from: number, edges: readonly number[][]): Set<number> {
	const out = new Set<number>();
	const pending = [...edges[from]];
	for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
		if (out.has(node)) continue;
		out.add(node);
		pending.push(...edges[node]);
	}
	return out;
}

/**
 * Checks a parsed plan against the Phase 5 rules. Every rule runs; nothing stops at the first finding.
 * Order: by task (plan order), then by rule (the order of the rules table), then by discovery order.
 * Findings about a pair of tasks are listed under the earlier task, a cycle under its first task, and
 * `task-plan-size` last. Pure: the files come in as `filesByRepo`, the tracked files (`git ls-files`) of each repo keyed by the
 * tasks' `repo` (`org/name`). Overlap and shared-path checks compare only tasks of the same repo, and a task's `owns`
 * and `new_paths` are matched against its own repo's files; a task whose repo has no entry is a `field` violation.
 */
export function validatePlan(plan: Plan, filesByRepo: ReadonlyMap<string, readonly string[]>): Violation[] {
	const { tasks } = plan;
	const found: Finding[] = [];
	const report = (rule: RuleId, at: number | undefined, detail: string): void => {
		const task = at === undefined ? undefined : tasks[at].id;
		found.push({ at, violation: { rule, ...(task === undefined ? {} : { task }), detail } });
	};

	const byId = indexById(tasks);
	const edges = tasks.map(task => task.depends_on.flatMap(id => byId.get(id) ?? []));
	const reach = edges.map((_, i) => reachable(i, edges));
	const owned = tasks.map(task => expand(task.owns, filesByRepo.get(task.repo) ?? []));
	const ownedFiles = owned.map(entries => new Set([...entries.values()].flat()));
	const sharedGlobs = plan.shared_paths.map(pattern => ({ pattern, glob: new Bun.Glob(pattern), prefix: prefixSegments(pattern) }));

	// field: an `owns` pattern that matches no repo file and no new path of the task.
	tasks.forEach((task, i) => {
		if (!filesByRepo.has(task.repo)) {
			report("field", i, `no files supplied for repo "${task.repo}"`);
			return;
		}
		const newPrefixes = task.new_paths.map(prefixSegments);
		for (const [pattern, files] of owned[i]) {
			if (files.length > 0) continue;
			const prefix = prefixSegments(pattern);
			if (newPrefixes.some(newPrefix => prefixesOverlap(prefix, newPrefix))) continue;
			report("field", i, `owns "${pattern}" matches no repo file and no new_paths entry`);
		}
	});

	tasks.forEach((task, i) => {
		if (byId.get(task.id)?.[0] !== i) report("duplicate-id", i, `duplicate task id "${task.id}"`);
	});

	tasks.forEach((task, i) => {
		for (const id of task.depends_on) if (!byId.has(id)) report("missing-dep", i, `depends_on "${id}" is not a task in the plan`);
	});

	for (const cycle of findCycles(edges)) {
		const path = [...cycle, cycle[0]].map(node => tasks[node].id).join(" -> ");
		report("cycle", cycle[0], `dependency cycle: ${path}`);
	}

	for (let i = 0; i < tasks.length; i++) {
		for (let j = i + 1; j < tasks.length; j++) {
			if (tasks[i].repo !== tasks[j].repo) continue;
			if (reach[i].has(j) || reach[j].has(i)) continue;
			const sharedFiles = [...ownedFiles[i]].filter(file => ownedFiles[j].has(file));
			if (sharedFiles.length > 0) {
				report("owns-overlap", i, `${tasks[i].id} and ${tasks[j].id} have no dependency path and both own: ${listed(sharedFiles)}`);
			}
			const clashes: string[] = [];
			for (const a of tasks[i].new_paths) {
				for (const b of tasks[j].new_paths) if (prefixesOverlap(prefixSegments(a), prefixSegments(b))) clashes.push(`${a} ~ ${b}`);
			}
			if (clashes.length > 0) {
				report("owns-overlap", i, `${tasks[i].id} and ${tasks[j].id} have no dependency path and share new_paths: ${listed(clashes)}`);
			}
		}
	}

	tasks.forEach((task, i) => {
		if (task.foundation) return;
		const entries = [
			...[...owned[i]].map(([pattern, files]) => ({ field: "owns", pattern, files })),
			...task.new_paths.map(pattern => ({ field: "new_paths", pattern, files: new Array<string>() })),
		];
		for (const entry of entries) {
			const prefix = prefixSegments(entry.pattern);
			for (const shared of sharedGlobs) {
				// An entry that exists in the repo is compared by file; a new path or an empty match by directory.
				const hit = entry.files.length > 0 ? entry.files.some(file => shared.glob.match(file)) : prefixesOverlap(prefix, shared.prefix);
				if (hit) report("shared-path", i, `${entry.field} "${entry.pattern}" intersects shared_paths "${shared.pattern}"; only a foundation task may change it`);
			}
		}
	});

	tasks.forEach((task, i) => {
		for (const field of RISK_FIELDS) {
			const entry = task.risk[field];
			if (entry.value === "yes" && !entry.reason?.trim()) report("risk-reason", i, `risk "${field}" is yes without a reason`);
		}
	});

	tasks.forEach((task, i) => {
		const yes = RISK_FIELDS.filter(field => task.risk[field].value === "yes");
		if (task.size === "small" && yes.length > 0) report("size-risk", i, `size is small but risk is yes for: ${yes.join(", ")}`);
	});

	tasks.forEach((task, i) => {
		if (task.lld_required && !task.lld?.trim() && !task.lld_skip_reason?.trim()) {
			report("lld-missing", i, "lld_required is true but there is neither lld nor lld_skip_reason");
		}
	});

	tasks.forEach((task, i) => {
		const routed = routeRisk(task.risk);
		const candidates = [...ownedFiles[i], ...task.owns, ...task.new_paths];
		const ownsManifest = candidates.some(path => DEPENDENCY_MANIFEST.test(path.slice(path.lastIndexOf("/") + 1)));
		const security = routed.security_review || ownsManifest;
		if (task.lld_required !== routed.lld_required) {
			report("router-mismatch", i, `lld_required is ${task.lld_required} but the risks route it to ${routed.lld_required}`);
		}
		if (task.security_review !== security) {
			const why = ownsManifest && !routed.security_review ? " (the task owns a dependency manifest)" : "";
			report("router-mismatch", i, `security_review is ${task.security_review} but the risks route it to ${security}${why}`);
		}
		for (const test of routed.implied_tests) {
			if (!task.required_tests.includes(test)) report("required-tests", i, `required_tests is missing "${test}", implied by the risks`);
		}
	});

	tasks.forEach((task, i) => {
		if (task.acceptance.length === 0) report("acceptance-empty", i, "acceptance is empty");
	});

	if (plan.kind === "task" && tasks.length !== 1) {
		report("task-plan-size", undefined, `a task plan needs exactly one task block, found ${tasks.length}`);
	}
	if (plan.kind === "story" && tasks.length === 0) {
		report("task-plan-size", undefined, "a story plan needs at least one task block, found 0");
	}

	return found
		.map((finding, order) => ({ finding, order }))
		.sort((a, b) => (a.finding.at ?? Infinity) - (b.finding.at ?? Infinity) || a.order - b.order)
		.map(({ finding }) => finding.violation);
}
