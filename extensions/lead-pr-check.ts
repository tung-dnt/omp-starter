// Blocks opening or re-describing a pull request whose body does not follow the lead-driven PR format
// (lib/lead/pr-body.ts): decision log, invariant checklist with proving tests, risk summary, and the sections the
// diff calls for. Active once hard-gates.md exists (`<kb>/lead/` by default); off with OMP_STARTER_LEAD=off.
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { ghCommands, leadLayoutFor, noteName, readBrief, readHardGates, readPlan, readStoryState } from "./lib/lead/artifacts";
import { shipProblems } from "./lib/lead/loop";
import { checkPrBody } from "./lib/lead/pr-body";
import { lead } from "./lib/lead/registry";
import { planApproved } from "./lib/lead/story";
import { diffEdges } from "../scripts/arch-graph";
import { addedLines, changedFiles, mergeBase, repoRoot } from "./lib/repo";
import { bashDir, ghPr, resolveFrom, simpleCommands } from "./lib/tool-input";

interface PrCall {
	/** Folder the PR is opened from. */
	dir: string;
	body: string;
}

const NO_BODY: Record<string, true> = { "--fill": true, "-f": true, "--fill-first": true, "--web": true, "-w": true };

/** The PR body a `gh pr create|edit` command carries; undefined when there is nothing to check; `refuse` when it cannot be read. */
function ghBody(command: string, cwd: unknown, sessionCwd: string, format: string, ghPrCommand: RegExp): PrCall | { refuse: string } | undefined {
	const words = simpleCommands(command).find(c => ghPrCommand.test(c.words.join(" ")))?.words;
	if (!words) return undefined;
	const dir = bashDir(command, cwd, sessionCwd);
	let body: string | undefined;
	let file: string | undefined;
	for (let i = 0; i < words.length; i++) {
		const eq = words[i].startsWith("--") ? words[i].indexOf("=") : -1;
		const flag = eq < 0 ? words[i] : words[i].slice(0, eq);
		const value = () => (eq < 0 ? (words[++i] ?? "") : words[i].slice(eq + 1));
		if (flag === "--body" || flag === "-b") body = value();
		else if (flag === "--body-file" || flag === "-F") file = value();
	}
	if (file === "-") return { refuse: "lead PR check: pass the body with --body-file <file>, not stdin" };
	if (body !== undefined && /^\$\(.*\)$/.test(body.trim())) return { refuse: "lead PR check: pass the body with --body-file <file>; a shell substitution cannot be checked" };
	if (file !== undefined) {
		try {
			body = fs.readFileSync(resolveFrom(dir, file), "utf8");
		} catch {
			return { refuse: `lead PR check: cannot read the body file ${file}` };
		}
	}
	if (words[words.indexOf("pr") + 1] === "create" && (body === undefined || words.some(w => NO_BODY[w]))) {
		return { refuse: `lead PR check: give the PR body with --body or --body-file (format: ${format})` };
	}
	return body === undefined ? undefined : { dir, body };
}

export default function leadPrCheck(pi: ExtensionAPI): void {
	if (process.env.OMP_STARTER_LEAD === "off") return;

	pi.on("tool_call", (event, ctx) => {
		const input = (event.input ?? {}) as Record<string, unknown>;
		const viaGithub = event.toolName === "github" && input.op === "pr_create";
		// Cheap test first: the hard gates are read only for a command that could set a PR body.
		if (!viaGithub && !(event.toolName === "bash" && /\bpr\s+(?:create|edit)\b/.test(String(input.command ?? "")))) return;
		const policyDir = leadLayoutFor(ctx.cwd)?.policy;
		const gates = policyDir && readHardGates(policyDir).gates;
		if (!policyDir || !gates) return;
		const ghPrCommand = ghPr(ghCommands(gates));
		if (!viaGithub && !ghPrCommand.test(String(input.command ?? ""))) return;
		const format = path.join(policyDir, "pr-format.md");
		const call = viaGithub ? { dir: ctx.cwd, body: typeof input.body === "string" ? input.body : "" } : ghBody(String(input.command), input.cwd, ctx.cwd, format, ghPrCommand);
		if (!call) return;
		if ("refuse" in call) return { block: true, reason: call.refuse };
		const repo = repoRoot(call.dir);
		if (!repo) return;
		const active = lead().story;
		const story = active && { ...active, invariants: readBrief(active.dir).brief?.invariants ?? active.invariants };
		// In an approved story the PR also needs the loop's receipts and a clean review at HEAD, and an evidence line per proven AC.
		const approved = active && planApproved(active).approved ? readPlan(active.dir).plan : undefined;
		const problems = checkPrBody({
			body: call.body,
			repo,
			story,
			gates,
			changed: changedFiles(repo),
			added: addedLines(repo),
			edgesDiff: diffEdges(repo, mergeBase(repo)),
			mapEdited: active !== undefined && readStoryState(active.dir).mapEditedAt !== null,
			proof: approved && { rows: approved.proof, repoName: noteName(repo) },
		});
		if (active && approved) problems.push(...shipProblems(active, repo));
		if (problems.length) return { block: true, reason: `lead PR check failed (format: ${format}):\n- ${problems.join("\n- ")}` };
	});
}
