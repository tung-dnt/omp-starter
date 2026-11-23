// An unattended build is a session the dispatcher starts with OMP_STARTER_UNATTENDED=1 and OMP_STARTER_STORY=<id>:
// nobody answers it, and its one job is an open pull request in every repository of the story's plan, or a
// stuck.md that says why there is none. In any other session this extension registers nothing. In an unattended one:
//  - `ask` is refused; the agent decides and records the choice in the plan's `## Decision log`.
//  - The main session cannot stop until every repository in the plan's `repos:` has an open pull request whose head is
//    its branch, or `stuck.md` exists beside the plan. Each refused stop is counted; after STOP_BUDGET of them the stop
//    goes through and stuck.md says so. A plan that cannot be read lets the stop through and says so in stuck.md.
// The plan is `<kb>/projects/<story>/plan.md`, in the knowledge base serving the session's folder (lib/kb-sources).
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExecResult, ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { doneSources, resolveKb } from "./lib/kb-sources";
import { splitNote } from "./lib/memory-notes";
import { expandHome, readState } from "./lib/state";

/** Stops refused before the next one goes through. */
export const STOP_BUDGET = 20;
const GH_TIMEOUT_MS = 15_000;
const STORY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const REPO = /^[\w.-]+\/[\w.-]+$/;
const WORK_ORG = "blinxsolutions/";

interface PlanRepo {
	repo: string;
	branch: string;
}

interface PrCheck extends PlanRepo {
	gh: string;
	open: boolean;
	/** Why GitHub could not answer; an answer of "no pull request" has none. */
	problem?: string;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The story of an unattended build, or undefined for any other session. */
function unattendedStory(): string | undefined {
	const story = process.env.OMP_STARTER_STORY?.trim();
	return process.env.OMP_STARTER_UNATTENDED === "1" && story ? story : undefined;
}

/**
 * `<kb>/projects/<story>`: in the knowledge base serving `cwd`, or in another one when only that one holds the plan.
 * Undefined without a knowledge base, or for an id that is not a plain folder name.
 */
function storyDir(cwd: string, story: string): string | undefined {
	if (!STORY_ID.test(story)) return undefined;
	const kb = readState().kb;
	const dirs = [resolveKb(cwd, kb), ...doneSources(kb)].flatMap(source => (source ? [path.join(expandHome(source.kbRef), "projects", story)] : []));
	return dirs.find(dir => fs.existsSync(path.join(dir, "plan.md"))) ?? dirs[0];
}

/** The repositories in the `repos:` of the plan's frontmatter, or why they cannot be read. */
function planRepos(file: string): { repos: PlanRepo[] } | { problem: string } {
	let text: string;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch (error) {
		return { problem: `${file} cannot be read (${message(error)})` };
	}
	const { frontmatter } = splitNote(text);
	if (!frontmatter) return { problem: `${file} has no frontmatter` };
	let data: unknown;
	try {
		data = Bun.YAML.parse(frontmatter.join("\n"));
	} catch (error) {
		return { problem: `the frontmatter of ${file} is not valid YAML (${message(error)})` };
	}
	const list = isObject(data) ? data.repos : undefined;
	if (!Array.isArray(list) || list.length === 0) return { problem: `${file} lists no repos: in its frontmatter` };
	const repos: PlanRepo[] = [];
	for (const [i, entry] of list.entries()) {
		if (!isObject(entry) || typeof entry.repo !== "string" || !REPO.test(entry.repo) || typeof entry.branch !== "string" || !entry.branch.trim()) {
			return { problem: `repos[${i}] of ${file} needs repo: <owner/name> and branch: <branch>` };
		}
		repos.push({ repo: entry.repo, branch: entry.branch.trim() });
	}
	return { repos };
}

async function checkPr(pi: ExtensionAPI, { repo, branch }: PlanRepo, cwd: string, signal: AbortSignal | undefined): Promise<PrCheck> {
	// `gh-blinx` carries the work account's token, which the work organisation's repositories need; plain `gh` elsewhere, and when it is not installed.
	const gh = repo.toLowerCase().startsWith(WORK_ORG) && Bun.which("gh-blinx", { PATH: process.env.PATH }) ? "gh-blinx" : "gh";
	const unanswered = (problem: string): PrCheck => ({ repo, branch, gh, open: false, problem });
	let result: ExecResult;
	try {
		result = await pi.exec(gh, ["pr", "list", "-R", repo, "--head", branch, "--state", "open", "--json", "url"], { cwd, timeout: GH_TIMEOUT_MS, signal });
	} catch (error) {
		return unanswered(message(error));
	}
	if (result.code !== 0) return unanswered(`${gh} exited ${result.code}: ${result.stderr.trim().split("\n")[0] || "no message"}`);
	try {
		const list: unknown = JSON.parse(result.stdout || "[]");
		if (Array.isArray(list)) return { repo, branch, gh, open: list.length > 0 };
	} catch {
		// Falls through to the same answer as a JSON value that is not a list.
	}
	return unanswered(`${gh} did not print a JSON list`);
}

function blockReason(story: string, stuck: string, missing: PrCheck[], refused: number): string {
	const lines = missing.map(({ repo, branch, gh, problem }) =>
		problem
			? `- ${repo} (branch ${branch}): could not check for a pull request: ${problem}`
			: `- ${repo} (branch ${branch}): no open pull request. Open it as a draft: ${gh} pr create --draft -R ${repo} --head ${branch}`,
	);
	return [
		`[unattended build ${story}] You cannot stop yet (stop ${refused} of ${STOP_BUDGET}). Still missing:`,
		...lines,
		`Open the draft pull request for each repository above that has none, or, if the work cannot be finished or GitHub cannot be checked, write why to ${stuck} and stop. Nobody answers questions in this session.`,
	].join("\n");
}

export default function unattended(pi: ExtensionAPI): void {
	const story = unattendedStory();
	if (!story) return;
	let refused = 0;

	const reset = (ctx: { agent?: { kind: string } }): void => {
		if (ctx.agent?.kind !== "sub") refused = 0;
	};
	pi.on("session_start", (_event, ctx) => reset(ctx));
	pi.on("session_switch", (_event, ctx) => reset(ctx));

	pi.on("tool_call", (event, ctx) => {
		if (event.toolName !== "ask") return;
		const dir = storyDir(ctx.cwd, story);
		return {
			block: true,
			reason:
				"unattended build: nobody can answer a question in this session. Decide yourself and record the decision, with the alternative you rejected, " +
				`in the plan's ## Decision log${dir ? ` (${path.join(dir, "plan.md")})` : ""}. ` +
				`If the work cannot meet an invariant of the plan, write why to ${dir ? path.join(dir, "stuck.md") : "stuck.md beside the plan"} and stop.`,
		};
	});

	pi.on("session_stop", async (event, ctx) => {
		if (ctx.agent?.kind === "sub") return;
		const dir = storyDir(ctx.cwd, story);
		if (!dir) return;
		const stuck = path.join(dir, "stuck.md");
		if (fs.existsSync(stuck)) return;
		const say = (line: string): void => {
			try {
				fs.mkdirSync(dir, { recursive: true });
				fs.appendFileSync(stuck, `${line}\n`);
			} catch {
				// The vault cannot be written right now; the stop still goes through.
			}
		};

		const plan = planRepos(path.join(dir, "plan.md"));
		if ("problem" in plan) {
			say(`plan unreadable: ${plan.problem}. The stop rule of this unattended build could not check for pull requests, so it let the session stop.`);
			return;
		}
		const missing = (await Promise.all(plan.repos.map(repo => checkPr(pi, repo, ctx.cwd, event.signal)))).filter(check => !check.open);
		if (!missing.length) return;
		if (refused >= STOP_BUDGET) {
			const names = missing.map(m => `${m.repo} (${m.branch})${m.problem ? ` [${m.problem}]` : ""}`).join(", ");
			say(`stop budget spent: ${STOP_BUDGET} stops were refused and no open pull request was confirmed for ${names}.`);
			return;
		}
		refused++;
		return { decision: "block" as const, reason: blockReason(story, stuck, missing, refused) };
	});
}
