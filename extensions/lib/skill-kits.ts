// `/starter skills`: pick any combination of skill kits (pstack, Matt Pocock, addy, ponytail, spec-kit) and warn when the
// chosen kits cover the same job. The picker sets the exact combination: unchecking an installed kit uninstalls it
// after a confirm that names it. Unmanaged (npm/link/Git) and project-scope installs are reported, never touched.
import type { Exec, WizardUi } from "../setup";
import { ADDY_PLUGIN, MATT_PLUGIN, PONYTAIL_PLUGIN, PSTACK_PLUGIN, checkPluginUpdates, readPluginInstallations, type PluginInstallation, type PluginTarget } from "./plugin-updates";

export type KitKey = "pstack" | "mattpocock" | "addy" | "ponytail" | "spec-kit";

interface Kit {
	readonly key: KitKey;
	readonly label: string;
	readonly summary: string;
	/** Marketplace plugin, or undefined for spec-kit (a CLI installed with uv). */
	readonly plugin?: PluginTarget;
}

export const KITS: readonly Kit[] = [
	{ key: "pstack", label: "pstack", summary: "rigorous execution: /poteto-mode playbooks, tdd, interrogate, verification", plugin: PSTACK_PLUGIN },
	{ key: "mattpocock", label: "Matt Pocock", summary: "grilling, to-spec / to-tickets, tdd, code review, domain modelling", plugin: MATT_PLUGIN },
	{ key: "addy", label: "addy (addyosmani/agent-skills)", summary: "spec → plan → build → review → ship lifecycle skills", plugin: ADDY_PLUGIN },
	{ key: "ponytail", label: "ponytail", summary: "always-on least-code ladder (reuse → stdlib → native → minimum); /ponytail-review delete-list", plugin: PONYTAIL_PLUGIN },
	{ key: "spec-kit", label: "spec-kit (GitHub)", summary: "specify CLI; per repo `specify init --integration omp` adds /speckit.* commands and specs/" },
];

/** Skills covering the same job, per kit. Two or more selected kits in one row is an overlap. */
export const OVERLAPS: readonly { job: string; skills: Partial<Record<KitKey, string>> }[] = [
	{ job: "spec / requirements", skills: { mattpocock: "to-spec, grill-with-docs", addy: "spec-driven-development, interview-me", "spec-kit": "speckit.specify, speckit.clarify" } },
	{ job: "plan / tasks", skills: { pstack: "poteto-mode multi-phase-plan", mattpocock: "to-tickets", addy: "planning-and-task-breakdown", "spec-kit": "speckit.plan, speckit.tasks" } },
	{ job: "implementation", skills: { pstack: "poteto-mode feature", mattpocock: "implement, implement-spec", addy: "incremental-implementation", "spec-kit": "speckit.implement" } },
	{ job: "TDD", skills: { pstack: "tdd", mattpocock: "tdd", addy: "test-driven-development" } },
	{ job: "code review", skills: { pstack: "interrogate", mattpocock: "code-review", addy: "code-review-and-quality", ponytail: "ponytail-review" } },
	{ job: "debugging", skills: { pstack: "poteto-mode bug-fix", mattpocock: "diagnosing-bugs", addy: "debugging-and-error-recovery" } },
	{ job: "stress-test a plan", skills: { mattpocock: "grill-me, grilling", addy: "doubt-driven-development" } },
	{ job: "skill router", skills: { pstack: "poteto-mode", mattpocock: "ask-matt, wizard", addy: "using-agent-skills" } },
	{ job: "architecture", skills: { pstack: "architect", mattpocock: "codebase-design, improve-codebase-architecture", addy: "api-and-interface-design" } },
	{ job: "prototype", skills: { pstack: "poteto-mode prototype", mattpocock: "prototype" } },
];

/** Same skill name in two kits: omp keeps pstack's bare name and namespaces the other. */
export const NAME_CLASHES: readonly { name: string; kits: readonly KitKey[]; winner: KitKey }[] = [
	{ name: "tdd", kits: ["pstack", "mattpocock"], winner: "pstack" },
	{ name: "teach", kits: ["pstack", "mattpocock"], winner: "pstack" },
];

/** The every-session AGENTS.md section that tells agents when to reach for pstack skills nobody invokes by habit. */
export const PSTACK_TRIGGERS = `# Skill triggers

When the situation matches, read the skill before acting.

| When | Skill |
| --- | --- |
| Ticket or request is vague, or uses home-made terms | \`reframe\` |
| Logic with states and transitions (orders, approvals, notification delivery) | \`statechart\` |
| Change spans repos or runs in ordered phases (schema repo before its consumers) | \`figure-it-out\` |
| UI change in a repo with no scripted verify skill | \`create-verification-skill\` |
| Before requesting review on my PR | \`make-pr-easy-to-review\` |
| After opening a PR | \`babysit\`; failing checks: \`fix-ci\` |
| Review comments arrived on my PR | \`get-pr-comments\` |
| Reviewing a teammate's PR | \`thermos\`; shared-code diffs also \`blast-radius\` |
| I correct the same mistake a second time | \`correct\` |
| Standup or weekly update | \`what-did-i-get-done\` |
| Unattended or overnight run | \`show-me-your-work\` |
`;

const label = (key: KitKey) => KITS.find(kit => kit.key === key)?.label ?? key;

/** The overlap warning for a selection, or undefined when the kits do not overlap. */
export function overlapWarning(selected: readonly KitKey[]): string | undefined {
	const lines: string[] = [];
	for (const row of OVERLAPS) {
		const hits = selected.filter(key => row.skills[key]);
		if (hits.length > 1) lines.push(`- ${row.job}: ${hits.map(key => `${label(key)} (${row.skills[key]})`).join(" · ")}`);
	}
	for (const clash of NAME_CLASHES) {
		if (clash.kits.every(key => selected.includes(key))) {
			const others = clash.kits.filter(key => key !== clash.winner).map(key => `${KITS.find(kit => kit.key === key)?.plugin?.key}/${clash.name}`);
			lines.push(`- name clash "${clash.name}": ${label(clash.winner)} keeps /skill:${clash.name}; the other becomes ${others.join(", ")}`);
		}
	}
	return lines.length ? `These kits cover the same jobs, so the model may pick either skill:\n${lines.join("\n")}` : undefined;
}

// ── Detection ───────────────────────────────────────────────────────────────

interface Installed {
	plugins: readonly PluginInstallation[];
	specKit: boolean;
	/** False when `uv` cannot run, so spec-kit can be neither checked nor installed. */
	uv: boolean;
}

async function specKitInstalled(exec: Exec): Promise<{ installed: boolean; uv: boolean }> {
	try {
		const result = await exec("uv", ["tool", "list"]);
		if (result.code !== 0) return { installed: false, uv: false };
		return { installed: /^specify-cli\b/m.test(result.stdout), uv: true };
	} catch {
		return { installed: false, uv: false };
	}
}

async function detect(exec: Exec): Promise<Installed> {
	const [plugins, spec] = await Promise.all([readPluginInstallations(exec), specKitInstalled(exec)]);
	return { plugins, specKit: spec.installed, uv: spec.uv };
}

function isInstalled(kit: Kit, state: Installed): boolean {
	return kit.plugin ? state.plugins.some(row => row.key === kit.plugin?.key) : state.specKit;
}

/** Only a user-scope marketplace install (or spec-kit's uv tool) is ours to uninstall. */
function userInstall(kit: Kit, state: Installed): PluginInstallation | undefined {
	return state.plugins.find(row => row.key === kit.plugin?.key && row.kind === "marketplace" && row.scope === "user");
}

// ── Picker ──────────────────────────────────────────────────────────────────

function kitForm(checked: ReadonlySet<KitKey>): string {
	const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;");
	const boxes = KITS.map(kit => `<label><input type="checkbox" name="kits" value="${kit.key}"${checked.has(kit.key) ? " checked" : ""}> ${escape(kit.label)}: ${escape(kit.summary)}</label>`);
	return [
		"<form>",
		"<p>Pick the skill kits to use. Checked kits are installed; unchecking an installed kit uninstalls it after a confirm. Kits that cover the same job get a warning before anything changes.</p>",
		"<fieldset><legend>Skill kits</legend>",
		...boxes,
		"</fieldset>",
		"</form>",
	].join("\n");
}

function parseKits(value: unknown): KitKey[] {
	const values = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
	return KITS.map(kit => kit.key).filter(key => values.includes(key));
}

/** Checkbox form when the host can draw one; otherwise one confirm per kit. Undefined: cancelled. */
async function pick(ui: WizardUi, checked: ReadonlySet<KitKey>, state: Installed): Promise<KitKey[] | undefined> {
	if (ui.formDialog) {
		const result = await ui.formDialog(kitForm(checked));
		return result ? parseKits(result.data.kits) : undefined;
	}
	const selected: KitKey[] = [];
	for (const kit of KITS) {
		const now = isInstalled(kit, state) ? " Installed now; No uninstalls it." : "";
		if (await ui.confirm(`Skill kit: ${kit.label}`, `Use ${kit.label}? ${kit.summary}.${now}`)) selected.push(kit.key);
	}
	return selected;
}

const INSTALL_ANYWAY = "Install anyway";
const CHANGE_SELECTION = "Change selection";

// ── Install / uninstall ─────────────────────────────────────────────────────

async function installKit(ui: WizardUi, exec: Exec, kit: Kit): Promise<boolean> {
	if (!kit.plugin) {
		const install = await exec("uv", ["tool", "install", "specify-cli"], { timeout: 300_000 });
		if (install.code !== 0) throw new Error(`Cannot install spec-kit (uv tool install specify-cli, exit ${install.code}).`);
		if (!(await specKitInstalled(exec)).installed) throw new Error("uv finished, but specify-cli could not be verified.");
		ui.notify("Installed spec-kit's specify CLI. Run `specify init --here --integration omp` in a repo to add its /speckit.* commands.", "info");
		return true;
	}
	const plugin = kit.plugin;
	const add = await exec("omp", ["plugin", "marketplace", "add", plugin.repo], { timeout: 120_000 });
	if (add.code !== 0 && !/already exists/.test(add.stdout + add.stderr)) throw new Error(`Cannot add the ${plugin.marketplace} marketplace (native exit ${add.code}).`);
	const install = await exec("omp", ["plugin", "install", "--scope", "user", plugin.id], { timeout: 300_000 });
	if (install.code !== 0) throw new Error(`Cannot install ${plugin.id} (native exit ${install.code}); installed state may have changed.`);
	const row = (await readPluginInstallations(exec)).find(entry => entry.key === plugin.key && entry.kind === "marketplace" && entry.scope === "user");
	if (!row || row.kind !== "marketplace") throw new Error(`Native installation finished, but ${plugin.id} could not be verified.`);
	ui.notify(`Installed ${kit.label} (${plugin.id}).`, "info");
	return true;
}

async function uninstallKit(ui: WizardUi, exec: Exec, kit: Kit): Promise<void> {
	if (!kit.plugin) {
		const result = await exec("uv", ["tool", "uninstall", "specify-cli"], { timeout: 120_000 });
		if (result.code !== 0) throw new Error(`Cannot uninstall spec-kit (uv tool uninstall specify-cli, exit ${result.code}).`);
		ui.notify("Uninstalled spec-kit's specify CLI. Repos keep their .specify/ and specs/ folders.", "info");
		return;
	}
	const result = await exec("omp", ["plugin", "uninstall", kit.plugin.id], { timeout: 120_000 });
	if (result.code !== 0) throw new Error(`Cannot uninstall ${kit.plugin.id} (native exit ${result.code}).`);
	ui.notify(`Uninstalled ${kit.label} (${kit.plugin.id}).`, "info");
}

// ── The step ────────────────────────────────────────────────────────────────

/**
 * Startup (`fromCommand` false) only records an existing install and never asks or changes anything.
 * `/starter skills` shows the picker, applies the exact combination, and offers updates for kept plugin kits.
 */
export async function setupSkillKits(ui: WizardUi, exec: Exec, fromCommand = false): Promise<"done" | "skipped"> {
	const state = await detect(exec);
	const installed = new Set(KITS.filter(kit => isInstalled(kit, state)).map(kit => kit.key));
	if (!fromCommand && installed.size > 0) return "done";

	let checked: ReadonlySet<KitKey> = installed.size ? installed : new Set<KitKey>(["addy"]);
	let selected: KitKey[] | undefined;
	for (;;) {
		selected = await pick(ui, checked, state);
		if (!selected) return installed.size ? "done" : "skipped";
		const warning = overlapWarning(selected);
		if (!warning) break;
		ui.notify(warning, "warning");
		if ((await ui.select("Overlapping skill kits", [INSTALL_ANYWAY, CHANGE_SELECTION])) === INSTALL_ANYWAY) break;
		checked = new Set(selected);
	}

	const failures: string[] = [];
	for (const kit of KITS) {
		const want = selected.includes(kit.key);
		const has = installed.has(kit.key);
		try {
			if (want && !has) {
				if (!kit.plugin && !state.uv) {
					ui.notify("spec-kit needs uv (https://docs.astral.sh/uv/). Install uv, then run /starter skills again.", "warning");
					continue;
				}
				await installKit(ui, exec, kit);
			} else if (!want && has) {
				const row = userInstall(kit, state);
				if (kit.plugin && !row) {
					ui.notify(`${kit.label} is installed outside user scope or as an unmanaged copy; remove it where it was installed.`, "info");
					continue;
				}
				const what = kit.plugin ? `${kit.plugin.id} (user scope)` : "the specify-cli uv tool";
				if (await ui.confirm(`Uninstall ${kit.label}?`, `You unchecked ${kit.label}. Uninstall ${what}? Check it again in /starter skills to reinstall.`)) await uninstallKit(ui, exec, kit);
			}
		} catch (error) {
			failures.push(error instanceof Error ? error.message : String(error));
		}
	}

	const kept = KITS.filter(kit => kit.plugin && selected.includes(kit.key) && installed.has(kit.key)).map(kit => kit.plugin!.key);
	if (kept.length) {
		try {
			await checkPluginUpdates(ui, exec, { keys: kept, installations: state.plugins });
		} catch (error) {
			failures.push(error instanceof Error ? error.message : String(error));
		}
	}
	if (failures.length) ui.notify(failures.join("\n"), "error");
	if (selected.length) ui.notify("Restart your OMP session to load the changed skill kits.", "info");
	return selected.length ? "done" : "skipped";
}
