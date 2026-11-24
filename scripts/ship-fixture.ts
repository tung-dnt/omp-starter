#!/usr/bin/env bun
// Sets up /ship's live proof (plans/001-ship.md, AC16) on the throwaway sandbox repository and tears it down again.
// /ship may not edit .github/, so the three things it has to fix are made here: a red check, a conflict and a comment.
//
//   bun scripts/ship-fixture.ts setup [--dir <folder>]   a PR with all three; prints JSON with the PR and the clone to run /ship in
//   bun scripts/ship-fixture.ts comment <pr> [text]      one more comment from the same account, for a later pass
//   bun scripts/ship-fixture.ts status <pr>              state, mergeable, checks, comments and files of the PR
//   bun scripts/ship-fixture.ts teardown <pr> [--dir <folder>]   closes the PR, deletes its two branches and the clone
//
// The sandbox's CI (`sh test.sh`) fails while a file named FAIL exists. Branches and PR titles start with `s4-`, so they never
// touch another story's. Needs `gh` logged in as the account /ship will act as.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const REPO = "tung-dnt/omp-ship-sandbox";
const ASK = 'Please also print "bye" after "hello" in app.sh.';

function run(command: string[], cwd?: string): string {
	const done = Bun.spawnSync(command, { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0" } });
	if (done.exitCode !== 0) throw new Error(`${command.join(" ")} failed (${done.exitCode}): ${done.stderr.toString().trim()}`);
	return done.stdout.toString().trim();
}

const gh = (...args: string[]): string => run(["gh", ...args]);
const git = (dir: string, ...args: string[]): string => run(["git", ...args], dir);

/** The value after `--name`, or undefined. */
function option(args: string[], name: string): string | undefined {
	const at = args.indexOf(name);
	return at >= 0 ? args[at + 1] : undefined;
}

function commit(dir: string, file: string, content: string, message: string): void {
	fs.writeFileSync(path.join(dir, file), content);
	git(dir, "add", file);
	git(dir, "commit", "-q", "-m", message);
}

function setup(dir: string): void {
	const id = Date.now().toString(36);
	const [base, work] = [`s4-base-${id}`, `s4-work-${id}`];
	gh("repo", "clone", REPO, dir, "--", "--quiet");
	git(dir, "switch", "-q", "-c", base, "origin/main");
	git(dir, "push", "-q", "-u", "origin", base);
	git(dir, "switch", "-q", "-c", work);
	// The red check: test.sh fails while FAIL exists. The same first line of app.sh changes on the base below, which makes the conflict.
	commit(dir, "app.sh", 'echo "hello from work"\n', "feat: greet from the work branch");
	commit(dir, "FAIL", "left by ship-fixture.ts: this file turns the check red\n", "test: leave a FAIL file");
	git(dir, "push", "-q", "-u", "origin", work);
	const url = gh("pr", "create", "--repo", REPO, "--draft", "--base", base, "--head", work, "--title", `${work}: live proof for /ship`, "--body", "Throwaway PR for the /ship live proof (plans/001-ship.md).");
	git(dir, "switch", "-q", base);
	commit(dir, "app.sh", 'echo "hello from base"\n', "feat: greet from the base branch");
	git(dir, "push", "-q", "origin", base);
	git(dir, "switch", "-q", work);
	const number = Number(url.split("/").at(-1));
	gh("pr", "comment", String(number), "--repo", REPO, "--body", ASK);
	// GitHub works out mergeable in the background; wait for it so the first read sees the conflict.
	for (let i = 0; i < 30 && gh("pr", "view", String(number), "--repo", REPO, "--json", "mergeable", "--jq", ".mergeable") === "UNKNOWN"; i++) Bun.sleepSync(2000);
	console.log(JSON.stringify({ repo: REPO, pr: number, url, dir, base, work }, null, 2));
}

function status(pr: string): void {
	const view = JSON.parse(gh("pr", "view", pr, "--repo", REPO, "--json", "state,isDraft,mergeable,headRefName,baseRefName,headRefOid,statusCheckRollup,comments,files,commits"));
	console.log(
		JSON.stringify(
			{
				state: view.state,
				draft: view.isDraft,
				mergeable: view.mergeable,
				head: `${view.headRefName}@${String(view.headRefOid).slice(0, 7)}`,
				base: view.baseRefName,
				checks: view.statusCheckRollup.map((c: { name: string; status: string; conclusion: string }) => `${c.name}: ${c.status} ${c.conclusion}`),
				files: view.files.map((f: { path: string }) => f.path),
				commits: view.commits.map((c: { messageHeadline: string }) => c.messageHeadline),
				comments: view.comments.map((c: { author: { login: string }; body: string }) => `${c.author.login}: ${c.body.split("\n").slice(0, 3).join(" | ")}`),
			},
			null,
			2,
		),
	);
}

function teardown(pr: string, dir: string | undefined): void {
	const view = JSON.parse(gh("pr", "view", pr, "--repo", REPO, "--json", "headRefName,baseRefName,state"));
	for (const branch of [view.headRefName, view.baseRefName] as string[]) if (!branch.startsWith("s4-")) throw new Error(`refusing to delete ${branch}: not an s4- branch`);
	if (view.state === "OPEN") gh("pr", "close", pr, "--repo", REPO);
	for (const branch of [view.headRefName, view.baseRefName]) gh("api", "-X", "DELETE", `repos/${REPO}/git/refs/heads/${branch}`);
	if (dir) fs.rmSync(dir, { recursive: true, force: true });
	console.log(`closed ${REPO}#${pr}, deleted ${view.headRefName} and ${view.baseRefName}`);
}

const [command, ...args] = process.argv.slice(2);
const pr = args[0] ?? "";
if (command === "setup") setup(option(args, "--dir") ?? path.join(fs.mkdtempSync(path.join(os.tmpdir(), "omp-ship-s4-")), "clone"));
else if (command === "comment" && pr) console.log(gh("pr", "comment", pr, "--repo", REPO, "--body", args.slice(1).join(" ") || ASK));
else if (command === "status" && pr) status(pr);
else if (command === "teardown" && pr) teardown(pr, option(args, "--dir"));
else {
	console.error("usage: ship-fixture.ts setup [--dir <folder>] | comment <pr> [text] | status <pr> | teardown <pr> [--dir <folder>]");
	process.exit(2);
}
