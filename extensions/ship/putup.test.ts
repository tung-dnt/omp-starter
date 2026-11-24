import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { privateHome, resetHome, writeFiles } from "../test-harness";
import { checkGh, checkGit } from "./fence";
import { putUp, type PutUpDeps } from "./putup";
import type { Gh, Git, PrRef } from "./types";

const ME = "tung-dnt";
const ORIGIN = "https://github.com/acme/app.git";
const PR_URL = "https://github.com/acme/app/pull/7";
const PR: PrRef = { host: "github.com", owner: "acme", repo: "app", number: 7 };

type Answer = { code: number; out: string; err: string };
const good = (out: string): Answer => ({ code: 0, out, err: "" });
const bad = (err: string): Answer => ({ code: 1, out: "", err });

/** git as the tests set a checkout up and inspect it: synchronous, with the exit code and output as they came. */
function gitSync(dir: string, args: string[]): Answer {
	const ran = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
	return { code: ran.status ?? 1, out: ran.stdout, err: ran.stderr };
}

/** The runner put-up gets: the same git, awaited like the real one. */
const git: Git = async (dir, args) => gitSync(dir, args);

/** Runs git and returns its trimmed output; a nonzero exit fails the test. */
function sh(dir: string, ...args: string[]): string {
	const ran = gitSync(dir, args);
	if (ran.code !== 0) throw new Error(`git ${args.join(" ")} in ${dir}: ${ran.err}`);
	return ran.out.trim();
}

interface Scene {
	/** The checkout put-up runs in. */
	app: string;
	/** The bare repo that stands in for GitHub: pushes to origin land here. */
	bare: string;
}

let template = "";

// A checkout of acme/app with main pushed, and the bare repo behind it, built once; each test copies them into the
// private home. Origin names github.com while pushes go to the bare repo, as `url.<base>.pushInsteadOf` makes git do.
beforeAll(() => {
	const home = privateHome();
	const bare = path.join(home, "github.git");
	const app = path.join(home, "app");
	fs.mkdirSync(app, { recursive: true });
	sh(home, "init", "--quiet", "--bare", "-b", "main", bare);
	sh(app, "init", "--quiet", "-b", "main");
	for (const [key, value] of [["user.name", "t"], ["user.email", "t@t"], ["commit.gpgsign", "false"]]) sh(app, "config", key as string, value as string);
	sh(app, "remote", "add", "origin", ORIGIN);
	sh(app, "config", `url.${bare}.pushInsteadOf`, ORIGIN);
	writeFiles(app, { "README.md": "app\n", "src/app.ts": "export const a = 1;\n", "old.txt": "old\n" });
	sh(app, "add", "-A");
	sh(app, "commit", "--quiet", "-m", "init");
	sh(app, "push", "--quiet", "origin", "main");
	sh(app, "remote", "set-head", "origin", "main");
	// Named like a test home, so the preload removes it if this process dies before afterAll.
	template = `${home}-putup`;
	fs.cpSync(app, path.join(template, "app"), { recursive: true });
	fs.cpSync(bare, path.join(template, "github.git"), { recursive: true });
});

afterAll(() => fs.rmSync(template, { recursive: true, force: true }));

/** A copy of the template on `branch`, its origin URL `origin`. */
function checkout(branch: string, origin = ORIGIN): Scene {
	const scene = { app: path.join(privateHome(), "app"), bare: path.join(privateHome(), "github.git") };
	fs.cpSync(path.join(template, "app"), scene.app, { recursive: true });
	fs.cpSync(path.join(template, "github.git"), scene.bare, { recursive: true });
	if (origin !== ORIGIN) {
		sh(scene.app, "remote", "set-url", "origin", origin);
		sh(scene.app, "config", "--replace-all", `url.${scene.bare}.pushInsteadOf`, origin);
	}
	if (branch !== "main") sh(scene.app, "switch", "--quiet", "-c", branch);
	return scene;
}

/** A commit on the checked-out branch, as the user would have made it before running /ship. */
function commit(s: Scene, subject: string, files: Record<string, string> = { [`${subject.replace(/\W+/g, "-")}.txt`]: `${subject}\n` }): void {
	writeFiles(s.app, files);
	sh(s.app, "add", "-A");
	sh(s.app, "commit", "--quiet", "-m", subject);
}

const hook = (s: Scene, name: string, script: string) => fs.writeFileSync(path.join(s.app, ".git", "hooks", name), `#!/bin/sh\n${script}\n`, { mode: 0o755 });

const snapshot = (s: Scene) => ({
	head: sh(s.app, "rev-parse", "HEAD"),
	status: sh(s.app, "status", "--porcelain", "--untracked-files=all"),
	remote: sh(s.bare, "for-each-ref", "--format=%(refname) %(objectname)"),
});

const onRemote = (s: Scene, branch: string) => gitSync(s.bare, ["rev-parse", "--verify", "-q", `refs/heads/${branch}`]).code === 0;

/** The rows `gh pr list --json number,url,author,isCrossRepository` returns. */
const row = (login: string, over: Record<string, unknown> = {}) => ({ number: 7, url: PR_URL, author: { login, is_bot: false }, isCrossRepository: false, ...over });

interface FakeGh {
	user?: Answer;
	list?: Answer;
	create?: Answer;
	/** The open PRs `gh pr list` finds. */
	prs?: unknown[];
}

/** A gh that answers the calls put-up makes, as the account `ME`, and records them; any other call fails the test. */
function fakeGh(answers: FakeGh = {}): { gh: Gh; calls: string[][] } {
	const calls: string[][] = [];
	const gh: Gh = async args => {
		calls.push(args);
		const [group, sub] = args;
		if (group === "api" && sub === "user") return answers.user ?? good(`${ME}\n`);
		if (group === "pr" && sub === "list") return answers.list ?? good(JSON.stringify(answers.prs ?? []));
		if (group === "pr" && sub === "create") return answers.create ?? good(`${PR_URL}\n`);
		throw new Error(`unexpected gh ${args.join(" ")}`);
	};
	return { gh, calls };
}

const creates = (calls: string[][]) => calls.filter(c => c[0] === "pr" && c[1] === "create");
const flag = (args: string[] | undefined, name: string) => (args ?? [])[(args ?? []).indexOf(name) + 1];

/** Attended by default; an alias in origin resolves to itself, so no test reads the real ~/.ssh/config. */
const deps = (gh: Gh, over: Partial<PutUpDeps> = {}): PutUpDeps => ({ git, gh, confirm: async () => true, sshHostname: alias => alias, ...over });
const noAsking = () => Promise.reject(new Error("asked"));

/** The password planted in the remote URLs below; no refusal may repeat it. */
const NEEDLE = "hunter2";

/** An https remote with a user and password in it, assembled with `URL` so no credential-shaped URL sits in this source for a secret scanner to flag. */
function withCredentials(host: string): string {
	const url = new URL(`https://${host}/acme/app.git`);
	url.username = "deploy";
	url.password = NEEDLE;
	return url.href;
}

/** Runs put-up, expects the refusal `reason`, and checks the checkout and the remote were left as they were. */
async function refused(s: Scene, d: PutUpDeps, reason: RegExp): Promise<string> {
	const before = snapshot(s);
	const result = await putUp(s.app, d);
	expect(typeof result).toBe("string");
	expect(result).toMatch(reason);
	expect(snapshot(s)).toEqual(before);
	return result as string;
}

beforeEach(resetHome);

describe("a dirty branch with no PR", () => {
	test("is committed after one confirm, pushed without touching main, and opened as a draft PR", async () => {
		const s = checkout("feat/ship-s5");
		hook(s, "pre-commit", "touch .git/hook-ran");
		const main = sh(s.bare, "rev-parse", "refs/heads/main");
		writeFiles(s.app, { "src/app.ts": "export const a = 2;\n", "notes.md": "notes\n" });
		sh(s.app, "mv", "README.md", "docs.md");
		fs.rmSync(path.join(s.app, "old.txt"));
		const asked: string[][] = [];
		const { gh, calls } = fakeGh();

		const result = await putUp(s.app, deps(gh, { confirm: async files => (asked.push(files), true) }));

		expect(result).toEqual(PR);
		expect(asked).toHaveLength(1);
		expect([...(asked[0] ?? [])].sort()).toEqual(["docs.md", "notes.md", "old.txt", "src/app.ts"]);
		expect(sh(s.app, "status", "--porcelain", "--untracked-files=all")).toBe("");
		expect(sh(s.app, "log", "-1", "--format=%s")).toBe("feat: ship s5");
		expect(fs.existsSync(path.join(s.app, ".git", "hook-ran"))).toBe(true);
		expect(sh(s.bare, "rev-parse", "refs/heads/feat/ship-s5")).toBe(sh(s.app, "rev-parse", "HEAD"));
		expect(sh(s.bare, "rev-parse", "refs/heads/main")).toBe(main);
		expect(creates(calls)).toHaveLength(1);
		const create = creates(calls)[0];
		expect(create).toContain("--draft");
		expect(flag(create, "--repo")).toBe("acme/app");
		expect(flag(create, "--head")).toBe("feat/ship-s5");
		expect(flag(create, "--title")).toBe("feat: ship s5");
		expect(flag(create, "--body")).toBe(`Opened as a draft by /ship from \`feat/ship-s5\`.\n\nCommits:\n- \`feat: ship s5\` (${sh(s.app, "rev-parse", "--short", "HEAD")})`);
	});

	test("takes the PR's owner, repo and number from the URL GitHub printed", async () => {
		const s = checkout("feat/x");
		commit(s, "one");
		const { gh } = fakeGh({ create: good("https://github.com/Acme/App/pull/9\n") });
		expect(await putUp(s.app, deps(gh))).toEqual({ host: "github.com", owner: "Acme", repo: "App", number: 9 });
	});

	for (const [branch, subject, title] of [
		["feat/ship-s5", "feat: ship s5", "feat: ship s5"],
		["fix/login-redirect", "fix: login redirect", "fix: login redirect"],
		["s5-putup", "chore: work on s5-putup", "chore: work on s5-putup"],
		["fix/utf-8-encoding", "fix: utf 8 encoding", "fix: utf 8 encoding"],
		["PAC2-8005-add-login-redirect", "chore: work on PAC2-8005-add-login-redirect", "PAC2-8005: add login redirect"],
		["feat/PAC2-8005_login_redirect", "feat: login redirect", "PAC2-8005: login redirect"],
		["user/PAC2-8005/login", "chore: work on user/PAC2-8005/login", "PAC2-8005: user login"],
		["PAC2-8005", "chore: work on PAC2-8005", "PAC2-8005: work in progress"],
		["pac2-8005-lowercase", "chore: work on pac2-8005-lowercase", "chore: work on pac2-8005-lowercase"],
	] as const) {
		test(`${branch}: commit "${subject}", PR title "${title}"`, async () => {
			const s = checkout(branch);
			writeFiles(s.app, { "notes.md": "notes\n" });
			const { gh, calls } = fakeGh();
			expect(await putUp(s.app, deps(gh))).toEqual(PR);
			expect(sh(s.app, "log", "-1", "--format=%s")).toBe(subject);
			expect(flag(creates(calls)[0], "--title")).toBe(title);
		});
	}

	test("lists the branch's commits oldest first in the body, with subjects that can't ping or close anything", async () => {
		const s = checkout("feat/x");
		commit(s, "bump @types/node and `zod`", { "a.txt": "a\n" });
		commit(s, "fixes #12", { "b.txt": "b\n" });
		const [first, second] = sh(s.app, "log", "--reverse", "--format=%h", "origin/main..HEAD").split("\n");
		const { gh, calls } = fakeGh();
		await putUp(s.app, deps(gh));
		expect(flag(creates(calls)[0], "--body")).toBe(`Opened as a draft by /ship from \`feat/x\`.\n\nCommits:\n- \`bump @types/node and 'zod'\` (${first})\n- \`fixes #12\` (${second})`);
	});

	test("lists at most 20 commits and counts the rest", async () => {
		const s = checkout("feat/x");
		for (let i = 1; i <= 23; i++) commit(s, `change ${i}`, { [`f${i}.txt`]: `${i}\n` });
		const { gh, calls } = fakeGh();
		await putUp(s.app, deps(gh));
		const body = flag(creates(calls)[0], "--body") ?? "";
		expect(body.split("\n").filter(line => line.startsWith("- "))).toHaveLength(21);
		expect(body).toEndWith("- and 3 more");
	});

	test("files that only look like secrets are committed", async () => {
		const s = checkout("feat/x");
		writeFiles(s.app, { ".env.example": "A=\n", "config/.env.sample": "A=\n", ".env.template": "A=\n", "id_rsa.pub": "ssh-rsa AAA\n", "src/monkey.ts": "x\n", "docs/keyboard.md": "x\n" });
		expect(await putUp(s.app, deps(fakeGh().gh))).toEqual(PR);
		expect(sh(s.app, "ls-files", "--others", "--exclude-standard")).toBe("");
	});

	test("deleting a tracked .env.production is not committing a secret", async () => {
		const s = checkout("main");
		commit(s, "track env", { ".env.production": "TOKEN=old\n" });
		sh(s.app, "push", "--quiet", "origin", "main");
		sh(s.app, "switch", "--quiet", "-c", "chore/untrack-env");
		sh(s.app, "rm", "--quiet", ".env.production");
		expect(await putUp(s.app, deps(fakeGh().gh))).toEqual(PR);
		expect(sh(s.app, "ls-files", ".env.production")).toBe("");
	});

	test("an unattended session with a clean tree and commits ahead has nothing to confirm", async () => {
		const s = checkout("feat/x");
		commit(s, "one");
		expect(await putUp(s.app, { git, gh: fakeGh().gh, sshHostname: alias => alias })).toEqual(PR);
		expect(onRemote(s, "feat/x")).toBe(true);
	});

	test("a PR from a fork that reuses the branch name is not this branch's PR", async () => {
		const s = checkout("feat/x");
		commit(s, "one");
		const { gh, calls } = fakeGh({ prs: [row("someone-else", { isCrossRepository: true })] });
		expect(await putUp(s.app, deps(gh))).toEqual(PR);
		expect(creates(calls)).toHaveLength(1);
	});
});

describe("a branch that already has the user's open PR", () => {
	test("gets its commits pushed and its PR back, leaving the dirty tree alone and unasked", async () => {
		const s = checkout("feat/x");
		commit(s, "one");
		writeFiles(s.app, { "wip.txt": "wip\n", "src/app.ts": "export const a = 3;\n" });
		const { gh, calls } = fakeGh({ prs: [row(ME)] });
		const tree = sh(s.app, "status", "--porcelain", "--untracked-files=all");

		// No confirm: nothing is committed, so there is nothing to approve.
		expect(await putUp(s.app, { git, gh, sshHostname: alias => alias })).toEqual(PR);

		expect(creates(calls)).toHaveLength(0);
		expect(sh(s.bare, "rev-parse", "refs/heads/feat/x")).toBe(sh(s.app, "rev-parse", "HEAD"));
		expect(sh(s.app, "status", "--porcelain", "--untracked-files=all")).toBe(tree);
	});

	test("running put-up again after it opened the PR changes nothing and returns the same PR", async () => {
		const s = checkout("feat/x");
		writeFiles(s.app, { "notes.md": "notes\n" });
		expect(await putUp(s.app, deps(fakeGh().gh))).toEqual(PR);
		const before = snapshot(s);

		const { gh, calls } = fakeGh({ prs: [row(ME)] });
		expect(await putUp(s.app, deps(gh))).toEqual(PR);

		expect(creates(calls)).toHaveLength(0);
		expect(snapshot(s)).toEqual(before);
	});

	test("compares logins without regard to case", async () => {
		const s = checkout("feat/x");
		commit(s, "one");
		expect(await putUp(s.app, deps(fakeGh({ prs: [row("Tung-DNT")] }).gh))).toEqual(PR);
	});

	test("is asked about with the PR it found, before anything is pushed, and a clear answer lets the push through", async () => {
		const s = checkout("feat/x");
		commit(s, "one");
		const order: string[] = [];
		const heldElsewhere = (pr: PrRef) => (order.push(`asked ${pr.owner}/${pr.repo}#${pr.number}; pushed: ${onRemote(s, "feat/x")}`), null);
		expect(await putUp(s.app, deps(fakeGh({ prs: [row(ME)] }).gh, { heldElsewhere }))).toEqual(PR);
		expect(order).toEqual(["asked acme/app#7; pushed: false"]);
		expect(onRemote(s, "feat/x")).toBe(true);
	});

	test("is refused, with nothing committed or pushed, when another live session already watches it", async () => {
		const s = checkout("feat/x");
		commit(s, "one");
		writeFiles(s.app, { "notes.md": "notes\n" });
		const held = "acme/app#7 is already watched by session sess-B (pid 4242); run /ship stop there first";
		const { gh, calls } = fakeGh({ prs: [row(ME)] });
		await refused(s, deps(gh, { confirm: noAsking, heldElsewhere: () => held }), /put-up refused: acme\/app#7 is already watched by session sess-B \(pid 4242\)/);
		expect(onRemote(s, "feat/x")).toBe(false);
		expect(creates(calls)).toHaveLength(0);
	});

	test("is not asked about when there is no PR yet, since nobody can watch one that doesn't exist", async () => {
		const s = checkout("feat/x");
		commit(s, "one");
		const heldElsewhere = () => {
			throw new Error("asked");
		};
		expect(await putUp(s.app, deps(fakeGh().gh, { heldElsewhere }))).toEqual(PR);
	});
});

describe("refuses", () => {
	test("the default branch, with work waiting to be committed", async () => {
		const s = checkout("main");
		writeFiles(s.app, { "notes.md": "notes\n" });
		const { gh, calls } = fakeGh();
		await refused(s, deps(gh, { confirm: noAsking }), /main is the default branch/);
		expect(calls).toEqual([]);
	});

	test("the default branch when origin/HEAD names another one", async () => {
		const s = checkout("develop");
		sh(s.app, "push", "--quiet", "origin", "develop");
		sh(s.app, "remote", "set-head", "origin", "develop");
		writeFiles(s.app, { "notes.md": "notes\n" });
		await refused(s, deps(fakeGh().gh), /develop is the default branch/);
	});

	test("a detached HEAD", async () => {
		const s = checkout("feat/x");
		sh(s.app, "checkout", "--quiet", "--detach");
		writeFiles(s.app, { "notes.md": "notes\n" });
		await refused(s, deps(fakeGh().gh), /HEAD is detached/);
	});

	test("an unknown default branch, since the branch might be it", async () => {
		const s = checkout("feat/x");
		sh(s.app, "remote", "set-head", "origin", "--delete");
		await refused(s, deps(fakeGh().gh), /default branch is unknown.*set-head origin --auto/);
	});

	test("a checkout with no origin", async () => {
		const s = checkout("feat/x");
		sh(s.app, "remote", "remove", "origin");
		await refused(s, deps(fakeGh().gh), /no origin remote/);
	});

	for (const name of [".env", ".env.local", "config/.env.production", ".envrc", "server.pem", "tls/private.key", "id_rsa", "ssh/id_ed25519"]) {
		test(`${name} in the tree, before anything is asked or committed`, async () => {
			const s = checkout("feat/x");
			writeFiles(s.app, { [name]: "secret\n", "notes.md": "notes\n" });
			const { gh, calls } = fakeGh();
			const why = await refused(s, deps(gh, { confirm: noAsking }), /secret-looking files would be committed/);
			expect(why).toContain(name);
			expect(creates(calls)).toHaveLength(0);
		});
	}

	test("a secret that is staged under a new name", async () => {
		const s = checkout("feat/x");
		sh(s.app, "mv", "old.txt", "prod.pem");
		await refused(s, deps(fakeGh().gh), /prod\.pem/);
	});

	test("names the first five secrets and counts the rest", async () => {
		const s = checkout("feat/x");
		writeFiles(s.app, Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map(i => [`k${i}.pem`, "k\n"])));
		await refused(s, deps(fakeGh().gh), /k1\.pem, k2\.pem, k3\.pem, k4\.pem, k5\.pem and 2 more/);
	});

	test("a secret already committed on the branch, even when a later commit removed it", async () => {
		const s = checkout("feat/x");
		commit(s, "add env", { ".env": "TOKEN=1\n" });
		sh(s.app, "rm", "--quiet", ".env");
		sh(s.app, "commit", "--quiet", "-m", "drop env again");
		await refused(s, deps(fakeGh().gh), /secret-looking files are already committed on feat\/x: \.env/);
	});

	test("someone else's open PR for the branch", async () => {
		const s = checkout("feat/x");
		writeFiles(s.app, { "notes.md": "notes\n" });
		const { gh, calls } = fakeGh({ prs: [row("someone-else")] });
		const why = await refused(s, deps(gh, { confirm: noAsking }), /someone-else opened it and gh acts as tung-dnt/);
		expect(why).toContain(PR_URL);
		expect(creates(calls)).toHaveLength(0);
	});

	test("a PR whose author is gone, since it isn't the user's", async () => {
		const s = checkout("feat/x");
		await refused(s, deps(fakeGh({ prs: [row("x", { author: null })] }).gh), /an account that no longer exists opened it/);
	});

	test("two open PRs for one branch, naming both", async () => {
		const s = checkout("feat/x");
		const { gh } = fakeGh({ prs: [row(ME), row(ME, { number: 8, url: "https://github.com/acme/app/pull/8" })] });
		await refused(s, deps(gh), /2 open pull requests use feat\/x \(#7, #8\)/);
	});

	test("a PR list it can't read, since a row might be someone else's PR", async () => {
		const s = checkout("feat/x");
		await refused(s, deps(fakeGh({ prs: [{}] }).gh), /returned a row this can't read/);
		await refused(s, deps(fakeGh({ list: good("not json") }).gh), /something other than JSON/);
	});

	test("an unattended session with uncommitted work", async () => {
		const s = checkout("feat/x");
		writeFiles(s.app, { "notes.md": "notes\n" });
		const { gh, calls } = fakeGh();
		await refused(s, { git, gh, sshHostname: alias => alias }, /uncommitted work in 1 file and nobody to confirm committing it/);
		expect(creates(calls)).toHaveLength(0);
	});

	test("uncommitted work the user did not confirm", async () => {
		const s = checkout("feat/x");
		writeFiles(s.app, { "notes.md": "notes\n" });
		await refused(s, deps(fakeGh().gh, { confirm: async () => false }), /not confirmed/);
	});

	test("a tree that changed while the confirm was open", async () => {
		const s = checkout("feat/x");
		writeFiles(s.app, { "notes.md": "notes\n" });
		const head = sh(s.app, "rev-parse", "HEAD");
		const confirm = async () => (writeFiles(s.app, { "late.txt": "late\n" }), true);
		expect(await putUp(s.app, deps(fakeGh().gh, { confirm }))).toMatch(/changed while waiting for the confirm/);
		expect(sh(s.app, "rev-parse", "HEAD")).toBe(head);
		expect(onRemote(s, "feat/x")).toBe(false);
	});

	test("a secret that came back in a deleted file while the confirm was open", async () => {
		const s = checkout("main");
		commit(s, "track env", { ".env.production": "TOKEN=old\n" });
		sh(s.app, "push", "--quiet", "origin", "main");
		sh(s.app, "switch", "--quiet", "-c", "feat/x");
		fs.rmSync(path.join(s.app, ".env.production"));
		const head = sh(s.app, "rev-parse", "HEAD");
		const confirm = async () => (writeFiles(s.app, { ".env.production": "TOKEN=new\n" }), true);
		expect(await putUp(s.app, deps(fakeGh().gh, { confirm }))).toMatch(/secret-looking files would be committed: \.env\.production/);
		expect(sh(s.app, "rev-parse", "HEAD")).toBe(head);
		expect(onRemote(s, "feat/x")).toBe(false);
	});

	test("a merge with unresolved conflicts, which would commit conflict markers", async () => {
		const s = checkout("feat/x");
		commit(s, "mine", { "README.md": "mine\n" });
		sh(s.app, "switch", "--quiet", "-c", "other", "main");
		commit(s, "theirs", { "README.md": "theirs\n" });
		sh(s.app, "switch", "--quiet", "feat/x");
		expect(gitSync(s.app, ["merge", "other"]).code).toBe(1);
		await refused(s, deps(fakeGh().gh), /unresolved merge conflicts in README\.md/);
	});

	test("a branch with nothing beyond the default branch and a clean tree", async () => {
		const s = checkout("feat/x");
		const { gh, calls } = fakeGh();
		await refused(s, deps(gh), /feat\/x has no commits beyond main, so there is nothing to put up/);
		expect(creates(calls)).toHaveLength(0);
	});

	test("a checkout that can't be compared with origin's default branch", async () => {
		const s = checkout("feat/x");
		sh(s.app, "update-ref", "-d", "refs/remotes/origin/main");
		await refused(s, deps(fakeGh().gh), /can't compare feat\/x with origin\/main/);
	});

	describe("an origin that is not on github.com", () => {
		for (const origin of [
			"https://gitlab.com/acme/app.git",
			"git@gitlab.com:acme/app.git",
			"ssh://git@bitbucket.org/acme/app.git",
			withCredentials("gitlab.com"),
			"/srv/git/app.git",
			"file:///srv/git/app.git",
			"https://github.com.evil.example/acme/app.git",
			"ftp://github.com/acme/app.git",
		]) {
			test(origin.replace(NEEDLE, "***"), async () => {
				const s = checkout("feat/x", origin);
				writeFiles(s.app, { "notes.md": "notes\n" });
				const { gh, calls } = fakeGh();
				const why = await refused(s, deps(gh), /is not a github\.com repository/);
				expect(why).not.toContain(NEEDLE);
				expect(calls).toEqual([]);
			});
		}

		test("an alias in ~/.ssh/config that points at another host", async () => {
			const s = checkout("feat/x", "git@work:acme/app.git");
			const asked: string[] = [];
			const sshHostname = (alias: string) => (asked.push(alias), "git.corp.example");
			await refused(s, deps(fakeGh().gh, { sshHostname }), /is not a github\.com repository/);
			expect(asked).toEqual(["work"]);
		});

		test("an https URL, which is never read as an alias", async () => {
			const s = checkout("feat/x", "https://blindx.github/acme/app.git");
			await refused(s, deps(fakeGh().gh, { sshHostname: () => "github.com" }), /is not a github\.com repository/);
		});

		test("an owner and repository it can't read", async () => {
			const s = checkout("feat/x", "https://github.com/acme/app/extra.git");
			await refused(s, deps(fakeGh().gh), /can't read an owner and repository/);
		});
	});

	describe("a failing gh or git", () => {
		test("gh pr list", async () => {
			const s = checkout("feat/x");
			await refused(s, deps(fakeGh({ list: bad("HTTP 502") }).gh), /can't list the open pull requests for feat\/x: HTTP 502/);
		});

		test("gh api user, when an open PR needs the account", async () => {
			const s = checkout("feat/x");
			await refused(s, deps(fakeGh({ prs: [row(ME)], user: bad("not logged in") }).gh), /can't tell which GitHub account gh acts as: not logged in/);
		});

		test("a pre-commit hook, which is never skipped", async () => {
			const s = checkout("feat/x");
			hook(s, "pre-commit", "echo 'lint failed: no console.log' >&2; exit 1");
			writeFiles(s.app, { "notes.md": "notes\n" });
			const head = sh(s.app, "rev-parse", "HEAD");
			const { gh, calls } = fakeGh();
			expect(await putUp(s.app, deps(gh))).toMatch(/git commit failed \(hooks stay on.*lint failed: no console\.log/);
			expect(sh(s.app, "rev-parse", "HEAD")).toBe(head);
			expect(onRemote(s, "feat/x")).toBe(false);
			expect(creates(calls)).toHaveLength(0);
		});

		test("a push that isn't a fast-forward, which is never forced", async () => {
			const s = checkout("feat/x");
			const other = path.join(privateHome(), "other");
			sh(privateHome(), "clone", "--quiet", s.bare, other);
			sh(other, "config", "user.name", "o");
			sh(other, "config", "user.email", "o@o");
			sh(other, "switch", "--quiet", "-c", "feat/x");
			commit({ app: other, bare: s.bare }, "theirs");
			sh(other, "push", "--quiet", "origin", "feat/x");
			const theirs = sh(s.bare, "rev-parse", "refs/heads/feat/x");
			writeFiles(s.app, { "notes.md": "notes\n" });
			const { gh, calls } = fakeGh();

			expect(await putUp(s.app, deps(gh))).toMatch(/git push origin feat\/x failed \(the work is committed locally\)/);

			expect(sh(s.bare, "rev-parse", "refs/heads/feat/x")).toBe(theirs);
			expect(creates(calls)).toHaveLength(0);
		});

		test("gh pr create, after the branch was pushed", async () => {
			const s = checkout("feat/x");
			commit(s, "one");
			expect(await putUp(s.app, deps(fakeGh({ create: bad("draft pull requests are not supported") }).gh))).toMatch(/gh pr create failed \(feat\/x is pushed\): draft pull requests are not supported/);
			expect(onRemote(s, "feat/x")).toBe(true);
		});

		test("a gh pr create that prints no URL", async () => {
			const s = checkout("feat/x");
			commit(s, "one");
			expect(await putUp(s.app, deps(fakeGh({ create: good("done\n") }).gh))).toMatch(/printed no pull request URL/);
		});
	});
});

describe("an origin on github.com", () => {
	// A branch with nothing to put up stops after the PR lookup, which names the repo put-up read from origin.
	for (const origin of [
		"https://github.com/acme/app",
		"https://github.com/acme/app.git",
		"https://github.com/acme/app/",
		"HTTPS://GitHub.com/acme/app.git",
		"git://github.com/acme/app.git",
		"git@github.com:acme/app.git",
		"github.com:acme/app",
		"ssh://git@github.com/acme/app.git",
		"ssh://git@github.com:22/acme/app.git",
		"git@ssh.github.com:acme/app.git",
		"ssh://git@ssh.github.com:443/acme/app.git",
		withCredentials("github.com"),
	]) {
		test(origin.replace(NEEDLE, "***"), async () => {
			const s = checkout("feat/x", origin);
			const { gh, calls } = fakeGh();
			await putUp(s.app, deps(gh));
			const list = calls.find(c => c[0] === "pr" && c[1] === "list");
			expect(flag(list, "--repo")).toBe("acme/app");
			expect(flag(list, "--head")).toBe("feat/x");
		});
	}

	test("an ssh alias resolves through the hostname lookup, which is asked for the host alone", async () => {
		const s = checkout("feat/x", "git@blindx.github:acme/app.git");
		commit(s, "one");
		const asked: string[] = [];
		const sshHostname = (alias: string) => (asked.push(alias), alias === "blindx.github" ? "github.com" : null);
		expect(await putUp(s.app, deps(fakeGh().gh, { sshHostname }))).toEqual(PR);
		expect(asked).toEqual(["blindx.github"]);
	});

	test("an ssh:// alias resolves the same way, whatever case the lookup answers in", async () => {
		const s = checkout("feat/x", "ssh://git@blindx.github/acme/app.git");
		commit(s, "one");
		const sshHostname = (alias: string) => (alias === "blindx.github" ? "GitHub.com" : null);
		expect(await putUp(s.app, deps(fakeGh().gh, { sshHostname }))).toEqual(PR);
	});
});

describe("in a fenced /ship session", () => {
	test("every git and gh call put-up makes is one the fence allows", async () => {
		const gitCalls: string[][] = [];
		const ghCalls: string[][] = [];
		// Both paths: a dirty branch that gets a new PR, and a branch whose PR exists.
		for (const [prs, files] of [[[], { "notes.md": "notes\n" }], [[row(ME)], {}]] as const) {
			const s = checkout("feat/ship-s5");
			commit(s, "one");
			writeFiles(s.app, files);
			const { gh, calls } = fakeGh({ prs: [...prs] });
			const recording: Git = (dir, args) => (gitCalls.push(["-C", dir, ...args]), git(dir, args));
			expect(await putUp(s.app, deps(gh, { git: recording }))).toEqual(PR);
			ghCalls.push(...calls);
			resetHome();
		}
		expect(gitCalls.some(args => args.includes("commit"))).toBe(true);
		expect(gitCalls.some(args => args.includes("push"))).toBe(true);
		expect(ghCalls.some(args => args[0] === "api")).toBe(true);
		const policy = { pushBranch: "feat/ship-s5", gitDirs: [path.join(privateHome(), "app", ".git")] };
		for (const args of gitCalls) expect(checkGit(args, policy, process.cwd())).toBeNull();
		for (const args of ghCalls) expect(checkGh(args)).toBeNull();
	});
});
