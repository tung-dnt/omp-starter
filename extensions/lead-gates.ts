// Deterministic hard gates of the lead-driven workflow. The lead lists risky paths in hard-gates.md (`<kb>/lead/` by default);
// a write/edit to one, or a commit, push or PR carrying one, stops until the lead approves that path. The decision is
// a dialog only the user can answer (main session) or the `lead` tool's op "gate" (after a subagent was blocked).
// Also keeps agents from editing the lead's own files. Active once `/starter lead` created hard-gates.md; off with
// OMP_STARTER_LEAD=off.
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { draftableBrief, ghCommands, leadLayoutFor, protectedLeadPath, readHardGates } from "./lib/lead/artifacts";
import { matchGates, matchRepoFiles, resolveGate } from "./lib/lead/gates";
import { checkStructure } from "./lib/lead/structure";
import { changedFiles, repoRoot, stagedFiles } from "./lib/repo";
import { tildify } from "./lib/state";
import { bashDir, GIT_COMMIT, ghPr, gitCommandDir, resolveFrom, targetPaths } from "./lib/tool-input";

const WRITE_TOOLS: Record<string, true> = { write: true, edit: true };
const GIT_PUSH = /\bgit(?:\s+-C\s+\S+)*\s+push\b/;
/** `git commit -a`: tracked edits are committed without being staged first. */
const COMMIT_ALL = /\s(?:-a|-am|--all)(?=\s|$)/;

interface Published {
	repo: string;
	/** Repo-root relative. */
	files: string[];
	/** The call is a commit of this repository, not only a push or a PR. */
	commit?: true;
}

/** What a commit, push or PR call would publish, per repository; undefined when the call is none of those. */
function published(toolName: string, input: Record<string, unknown>, sessionCwd: string, ghPrCommand: RegExp): Published[] | undefined {
	if (toolName === "github") {
		if (input.op !== "pr_create") return undefined;
		const repo = repoRoot(sessionCwd);
		return repo ? [{ repo, files: changedFiles(repo) }] : [];
	}
	if (toolName !== "bash") return undefined;
	const command = String(input.command ?? "");
	const commit = GIT_COMMIT.exec(command);
	const push = GIT_PUSH.exec(command);
	const pr = ghPrCommand.test(command);
	if (!commit && !push && !pr) return undefined;
	const out: Published[] = [];
	const commitRepo = commit && repoRoot(gitCommandDir(command, commit, input.cwd, sessionCwd));
	if (commitRepo) out.push({ repo: commitRepo, files: stagedFiles(commitRepo, COMMIT_ALL.test(command)), commit: true });
	const branchRepo = push ? repoRoot(gitCommandDir(command, push, input.cwd, sessionCwd)) : pr ? repoRoot(bashDir(command, input.cwd, sessionCwd)) : undefined;
	if (branchRepo) out.push({ repo: branchRepo, files: changedFiles(branchRepo) });
	return out;
}

export default function leadGates(pi: ExtensionAPI): void {
	if (process.env.OMP_STARTER_LEAD === "off") return;
	// The last "using last good copy" problem shown, so an invalid hard-gates.md is reported once, not per tool call.
	let warned: string | undefined;

	pi.on("tool_call", async (event, ctx) => {
		const layout = leadLayoutFor(ctx.cwd);
		if (!layout) return;
		const input = (event.input ?? {}) as Record<string, unknown>;
		const writes = WRITE_TOOLS[event.toolName]
			? targetPaths(event.toolName, input)
					.filter(p => !p.includes("://"))
					.map(p => resolveFrom(ctx.cwd, p))
			: [];
		// A story's brief is the agent's to draft until the lead approves it with the plan.
		const owned = writes.find(p => protectedLeadPath(layout, p) && !draftableBrief(layout, p));
		if (owned) return { block: true, reason: `lead: ${tildify(owned)} is owned by the lead; propose the change in chat or in the PR body instead.` };

		const { gates, error } = readHardGates(layout.policy);
		if (!gates && !error) return;
		const publishing = published(event.toolName, input, ctx.cwd, ghPr(ghCommands(gates)));
		if (!gates) {
			if (!publishing && !writes.some(p => repoRoot(p))) return;
			return { block: true, reason: `lead: hard-gates.md unreadable (${error}); gates fail closed until it can be read.` };
		}
		if (error && error !== warned && ctx.hasUI) {
			warned = error;
			ctx.ui.notify(`lead: ${error}`, "warning");
		}
		const structure = await Promise.all((publishing ?? []).filter(p => p.commit).map(p => checkStructure(p.repo, layout.notes)));
		const stale = structure.find(s => s.block);
		if (stale) return { block: true, reason: stale.block };
		const hits = [
			...writes.flatMap(p => matchGates(p, gates.gates)),
			...(publishing ?? []).flatMap(({ repo, files }) => matchRepoFiles(repo, files, gates.gates)),
			...structure.flatMap(s => s.hits),
		];
		return resolveGate(ctx, hits);
	});
}
