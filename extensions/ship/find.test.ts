import { beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { tildify } from "../lib/state";
import { exec } from "../ship";
import { privateHome, resetHome } from "../test-harness";
import { findCheckout, projectsRoot } from "./find";
import type { FindDeps, Gh, PrRef, RunLimits, Want } from "./types";

// Real git on scratch folders: bare origins under <scratch>/origins/<owner>/<repo>.git, clones and worktrees under
// <scratch>/projects. Only gh is a fake (it clones from those origins) and so is the way an origin URL names a
// repository, since a local path names no GitHub repository.

const OWNER = "tung-dnt";
const REPO = "sandbox";
const BRANCH = "feat/x";
const SLUG = "feat-x";
const PR: PrRef = { host: "github.com", owner: OWNER, repo: REPO, number: 12 };
const WANT: Want = { pr: PR, branch: BRANCH, fork: false };

const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });
}
const branchOf = (dir: string): string => git(dir, "symbolic-ref", "--short", "HEAD").trim();
const worktrees = (dir: string): string[] => [...git(dir, "worktree", "list", "--porcelain").matchAll(/^worktree (.+)$/gm)].map(m => m[1] as string);

let scratch = "";
beforeEach(() => {
	resetHome();
	scratch = fs.mkdtempSync(path.join(privateHome(), "find-"));
	fs.mkdirSync(path.join(scratch, "projects"));
});

const projects = (): string => path.join(scratch, "projects");
const at = (...names: string[]): string => path.join(projects(), ...names);
const listing = (): string[] => fs.readdirSync(projects()).sort();

/** The bare origin of owner/repo, made once: main has a commit, and each branch has one of its own beyond main. */
function origin(owner = OWNER, repo = REPO, branches: string[] = [BRANCH]): string {
	const bare = path.join(scratch, "origins", owner, `${repo}.git`);
	const seed = path.join(scratch, "seeds", `${owner}-${repo}`);
	fs.mkdirSync(path.dirname(bare), { recursive: true });
	fs.mkdirSync(seed, { recursive: true });
	git(scratch, "init", "--quiet", "--bare", "-b", "main", bare);
	git(seed, "init", "--quiet", "-b", "main");
	git(seed, "remote", "add", "origin", bare);
	fs.writeFileSync(path.join(seed, "README.md"), "main\n");
	git(seed, "add", ".");
	git(seed, "commit", "--quiet", "-m", "main");
	git(seed, "push", "--quiet", "origin", "main");
	for (const branch of branches) addBranch(owner, repo, branch);
	return bare;
}

/** Settles when the signal aborts. */
function whenAborted(signal: AbortSignal | undefined): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	signal?.addEventListener("abort", () => resolve(), { once: true });
	return promise;
}

/** Pushes a branch of its own to an origin made earlier, so a clone made before it doesn't know it. */
function addBranch(owner: string, repo: string, branch: string): void {
	const seed = path.join(scratch, "seeds", `${owner}-${repo}`);
	git(seed, "checkout", "--quiet", "-b", branch, "main");
	fs.writeFileSync(path.join(seed, `${branch.replaceAll("/", "-")}.txt`), `${branch}\n`);
	git(seed, "add", ".");
	git(seed, "commit", "--quiet", "-m", branch);
	git(seed, "push", "--quiet", "origin", branch);
	git(seed, "checkout", "--quiet", "main");
}

/** Adds a commit to a branch of an origin, and returns the new tip. */
function advance(owner: string, repo: string, branch: string): string {
	const seed = path.join(scratch, "seeds", `${owner}-${repo}`);
	git(seed, "checkout", "--quiet", branch);
	git(seed, "commit", "--quiet", "--allow-empty", "-m", "more");
	git(seed, "push", "--quiet", "origin", branch);
	const tip = git(seed, "rev-parse", "HEAD").trim();
	git(seed, "checkout", "--quiet", "main");
	return tip;
}

const cloneOf = (owner: string, repo: string, dir: string, ...flags: string[]): string => {
	fs.mkdirSync(path.dirname(dir), { recursive: true });
	git(scratch, "clone", "--quiet", ...flags, path.join(scratch, "origins", owner, `${repo}.git`), dir);
	return dir;
};
/** A clone of the PR's repository under the projects folder, on main. */
const clone = (name = REPO, ...flags: string[]): string => cloneOf(OWNER, REPO, at(name), ...flags);

interface Rigged extends FindDeps {
	asked: { title: string; message: string }[];
	gitCalls: string[];
	ghCalls: { args: string[]; limits: RunLimits | undefined }[];
}

interface Options extends Partial<FindDeps> {
	/** The default branch `gh repo view` reports; null makes the lookup fail. */
	defaultBranch?: string | null;
	/** What the confirm answers. */
	says?: boolean;
	/** Replaces the clone gh makes. */
	cloner?: Gh;
}

function rig(options: Options = {}): Rigged {
	const { defaultBranch = "main", says = true, cloner, ...given } = options;
	const asked: Rigged["asked"] = [];
	const gitCalls: string[] = [];
	const ghCalls: Rigged["ghCalls"] = [];
	const deps: Rigged = {
		asked,
		gitCalls,
		ghCalls,
		git: (dir, args, limits) => {
			gitCalls.push(`${path.relative(scratch, dir)}: ${args.join(" ")}`);
			return exec("git", ["-C", dir, ...args], limits?.timeoutMs, limits?.signal);
		},
		gh: async (args, limits) => {
			ghCalls.push({ args, limits });
			if (args[0] === "repo" && args[1] === "view") return defaultBranch === null ? { code: 1, out: "", err: "gh: Could not resolve to a Repository" } : { code: 0, out: `${defaultBranch}\n`, err: "" };
			if (args[0] === "repo" && args[1] === "clone") return cloner ? cloner(args, limits) : exec("git", ["clone", "--quiet", path.join(scratch, "origins", `${args[2]}.git`), args[3] as string], undefined, limits?.signal);
			return { code: 1, out: "", err: `unexpected gh ${args.join(" ")}` };
		},
		repoOf: url => {
			const named = /([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url);
			return named ? { owner: named[1] as string, repo: named[2] as string } : null;
		},
		projects: projects(),
		session: null,
		confirm: async (title, message) => {
			asked.push({ title, message });
			return says;
		},
		signal: new AbortController().signal,
		...given,
	};
	return deps;
}

describe("the session's own folder", () => {
	test("is used as it is when it is a checkout of the repository on the branch: no question, and nothing searched", async () => {
		origin();
		const own = clone();
		git(own, "checkout", "--quiet", "-b", BRANCH, `origin/${BRANCH}`);
		const t = rig({ session: own });
		expect(await findCheckout(WANT, t)).toEqual({ root: own, kind: "session" });
		expect(t.asked).toEqual([]);
		expect(t.gitCalls.some(call => call.includes("worktree"))).toBe(false);
		expect(t.ghCalls).toEqual([]);
	});

	test("is used without a question even when nobody could answer one", async () => {
		origin();
		const own = clone();
		git(own, "checkout", "--quiet", "-b", BRANCH, `origin/${BRANCH}`);
		expect(await findCheckout(WANT, rig({ session: own, confirm: undefined }))).toEqual({ root: own, kind: "session" });
	});

	test("is used for a fork's PR too when it is on that branch, as before: a fork's checkout names the upstream's PR", async () => {
		origin();
		const mine = clone();
		git(mine, "checkout", "--quiet", "-b", BRANCH, `origin/${BRANCH}`);
		const upstream: Want = { pr: { ...PR, owner: "upstream-org" }, branch: BRANCH, fork: true };
		const t = rig({ session: mine });
		expect(await findCheckout(upstream, t)).toEqual({ root: mine, kind: "session" });
		expect(t.asked).toEqual([]);
	});

	test("is not used when it is on that branch of another repository: origin has to be the PR's", async () => {
		origin();
		origin(OWNER, "other");
		const stranger = cloneOf(OWNER, "other", at("other"));
		git(stranger, "checkout", "--quiet", "-b", BRANCH, `origin/${BRANCH}`);
		const t = rig({ session: stranger, says: false });
		expect(typeof (await findCheckout(WANT, t))).toBe("string");
		expect(t.asked).toHaveLength(1);
	});

	test("is not used when it is on another branch", async () => {
		origin();
		const own = clone();
		const t = rig({ session: own, says: false });
		expect(typeof (await findCheckout(WANT, t))).toBe("string");
		expect(t.asked).toHaveLength(1);
	});
});

describe("a checkout of the branch that exists", () => {
	test("a linked worktree under the projects folder that has it checked out is used after one question that names the folder", async () => {
		origin();
		const main = clone();
		const tree = at(`${REPO}-${SLUG}`);
		git(main, "worktree", "add", "--quiet", "--track", "-b", BRANCH, tree, `origin/${BRANCH}`);
		const t = rig({ session: main });
		expect(await findCheckout(WANT, t)).toEqual({ root: tree, kind: "existing" });
		expect(t.asked).toHaveLength(1);
		expect(t.asked[0]?.title).toContain(tildify(tree));
		expect(t.asked[0]?.message).toContain(BRANCH);
	});

	test("a standalone clone on the branch is used too", async () => {
		origin();
		const only = clone("sandbox-work");
		git(only, "checkout", "--quiet", "-b", BRANCH, `origin/${BRANCH}`);
		const t = rig();
		expect(await findCheckout(WANT, t)).toEqual({ root: only, kind: "existing" });
		expect(t.asked).toHaveLength(1);
	});

	test("a worktree outside the projects folder is found through the clone it belongs to", async () => {
		origin();
		const main = clone();
		const away = path.join(scratch, "elsewhere", "wt");
		fs.mkdirSync(path.dirname(away));
		git(main, "worktree", "add", "--quiet", "--track", "-b", BRANCH, away, `origin/${BRANCH}`);
		const t = rig();
		expect(await findCheckout(WANT, t)).toEqual({ root: fs.realpathSync(away), kind: "existing" });
	});

	test("a no leaves every folder as it was", async () => {
		origin();
		const main = clone();
		const tree = at(`${REPO}-${SLUG}`);
		git(main, "worktree", "add", "--quiet", "--track", "-b", BRANCH, tree, `origin/${BRANCH}`);
		const before = listing();
		const t = rig({ says: false });
		const why = await findCheckout(WANT, t);
		expect(typeof why).toBe("string");
		expect(why).toContain(tildify(tree));
		expect(listing()).toEqual(before);
	});
});

describe("a worktree added to a clone", () => {
	test("goes beside the clone as <clone>-<branch with / as ->, tracking origin's branch, fetched first", async () => {
		origin(OWNER, REPO, []);
		const main = clone();
		// Pushed after the clone was made: only the fetch brings it.
		addBranch(OWNER, REPO, BRANCH);
		const tree = at(`${REPO}-${SLUG}`);
		const t = rig();
		expect(await findCheckout(WANT, t)).toEqual({ root: tree, kind: "worktree" });
		expect(branchOf(tree)).toBe(BRANCH);
		expect(git(tree, "rev-parse", "--abbrev-ref", `${BRANCH}@{upstream}`).trim()).toBe(`origin/${BRANCH}`);
		expect(fs.readFileSync(path.join(tree, `${SLUG}.txt`), "utf8")).toBe(`${BRANCH}\n`);
		expect(worktrees(main).map(dir => fs.realpathSync(dir))).toContain(tree);
		expect(t.asked).toHaveLength(1);
		expect(t.asked[0]?.title).toContain(tildify(tree));
		expect(t.asked[0]?.message).toContain(tildify(main));
		// A clone that already fetches every branch is left as it was.
		expect(git(main, "config", "--get-all", "remote.origin.fetch").trim()).toBe("+refs/heads/*:refs/remotes/origin/*");
	});

	test("a single-branch clone, which fetches no other branch, gets the branch added to what it fetches, and then the tracking branch", async () => {
		origin(OWNER, REPO, []);
		const main = clone(REPO, "--single-branch", "--branch", "main");
		addBranch(OWNER, REPO, BRANCH);
		const tree = at(`${REPO}-${SLUG}`);
		expect(await findCheckout(WANT, rig())).toEqual({ root: tree, kind: "worktree" });
		expect(git(tree, "rev-parse", "--abbrev-ref", `${BRANCH}@{upstream}`).trim()).toBe(`origin/${BRANCH}`);
		expect(git(main, "config", "--get-all", "remote.origin.fetch").trim().split("\n")).toEqual(["+refs/heads/main:refs/remotes/origin/main", `+refs/heads/${BRANCH}:refs/remotes/origin/${BRANCH}`]);
		// A plain fetch in the worktree now brings the branch's next commit, as it does for any other branch.
		const tip = advance(OWNER, REPO, BRANCH);
		git(tree, "fetch", "origin");
		expect(git(tree, "rev-parse", `origin/${BRANCH}`).trim()).toBe(tip);
	});

	test("the session's own clone outside the projects folder is a clone to add it to", async () => {
		origin();
		const own = cloneOf(OWNER, REPO, path.join(scratch, "elsewhere", REPO));
		const tree = path.join(scratch, "elsewhere", `${REPO}-${SLUG}`);
		const t = rig({ session: own });
		expect(await findCheckout(WANT, t)).toEqual({ root: tree, kind: "worktree" });
		expect(branchOf(tree)).toBe(BRANCH);
		expect(listing()).toEqual([]);
	});

	test("nothing is fetched or added until the user has said yes", async () => {
		origin();
		clone();
		const tree = at(`${REPO}-${SLUG}`);
		let existedWhenAsked = true;
		let fetchedWhenAsked: string[] = [];
		const t = rig();
		t.confirm = async () => {
			existedWhenAsked = fs.existsSync(tree);
			fetchedWhenAsked = t.gitCalls.filter(call => call.includes("fetch") || call.includes("worktree add"));
			return true;
		};
		await findCheckout(WANT, t);
		expect(existedWhenAsked).toBe(false);
		expect(fetchedWhenAsked).toEqual([]);
	});

	test("the fetch and the add may run long and are killed by a stop: they carry a time allowance and the signal", async () => {
		origin();
		clone();
		const seen: (RunLimits | undefined)[] = [];
		const t = rig();
		const run = t.git;
		t.git = (dir, args, limits) => {
			if (args[0] === "fetch" || (args[0] === "worktree" && args[1] === "add")) seen.push(limits);
			return run(dir, args, limits);
		};
		await findCheckout(WANT, t);
		expect(seen).toHaveLength(2);
		for (const limits of seen) {
			expect(limits?.signal).toBe(t.signal);
			expect(limits?.timeoutMs).toBeGreaterThan(90_000);
		}
	});
});

describe("a clone made for the link", () => {
	test("with no clone anywhere it clones into <projects>/<repo>, adds the worktree, and asks once naming both", async () => {
		origin();
		const t = rig();
		const main = at(REPO);
		const tree = at(`${REPO}-${SLUG}`);
		expect(await findCheckout(WANT, t)).toEqual({ root: tree, kind: "worktree" });
		expect(fs.existsSync(path.join(main, ".git"))).toBe(true);
		expect(branchOf(main)).toBe("main");
		expect(branchOf(tree)).toBe(BRANCH);
		const cloning = t.ghCalls.find(call => call.args[1] === "clone");
		expect(cloning?.args).toEqual(["repo", "clone", `${OWNER}/${REPO}`, main]);
		// A big repository takes longer than a read, and a stop has to be able to end it.
		expect(cloning?.limits?.signal).toBe(t.signal);
		expect(cloning?.limits?.timeoutMs).toBeGreaterThan(90_000);
		expect(t.asked).toHaveLength(1);
		expect(t.asked[0]?.message).toContain(tildify(main));
		expect(t.asked[0]?.title).toContain(tildify(tree));
	});

	test("when the PR's branch is the repository's default branch the clone itself is the folder, with no worktree", async () => {
		origin(OWNER, REPO, []);
		const t = rig();
		const main = at(REPO);
		expect(await findCheckout({ ...WANT, branch: "main" }, t)).toEqual({ root: main, kind: "clone" });
		expect(worktrees(main)).toHaveLength(1);
		expect(listing()).toEqual([REPO]);
		expect(t.asked[0]?.title).toContain(tildify(main));
	});

	test("makes the projects folder when it isn't there yet", async () => {
		origin();
		const fresh = path.join(scratch, "new", "projects");
		const found = await findCheckout(WANT, rig({ projects: fresh }));
		expect(found).toEqual({ root: path.join(fresh, `${REPO}-${SLUG}`), kind: "worktree" });
	});

	test("a clone that fails says why and leaves nothing behind", async () => {
		origin();
		const t = rig({
			cloner: async args => {
				fs.mkdirSync(path.join(args[3] as string, ".git"), { recursive: true });
				return { code: 128, out: "", err: "fatal: repository 'https://github.com/tung-dnt/sandbox/' not found\n" };
			},
		});
		const why = await findCheckout(WANT, t);
		expect(why).toContain("not found");
		expect(listing()).toEqual([]);
	});

	test("a stop while the clone runs kills it, removes what it left, and adds nothing", async () => {
		origin();
		const controller = new AbortController();
		const running = Promise.withResolvers<void>();
		const t = rig({
			signal: controller.signal,
			cloner: async (args, limits) => {
				fs.mkdirSync(path.join(args[3] as string, ".git"), { recursive: true });
				running.resolve();
				await whenAborted(limits?.signal);
				return { code: 1, out: "", err: "stopped" };
			},
		});
		const finding = findCheckout(WANT, t);
		await running.promise;
		controller.abort();
		const why = await finding;
		expect(typeof why).toBe("string");
		expect(why).toContain("stopped");
		expect(listing()).toEqual([]);
		expect(t.gitCalls.some(call => call.includes("worktree add"))).toBe(false);
		expect(t.asked).toHaveLength(1);
	});

	test("a default branch gh can't read refuses before anything is asked or cloned", async () => {
		origin();
		const t = rig({ defaultBranch: null });
		expect(await findCheckout(WANT, t)).toContain("default branch");
		expect(t.asked).toEqual([]);
		expect(t.ghCalls.some(call => call.args[1] === "clone")).toBe(false);
		expect(listing()).toEqual([]);
	});

	test("a clone that finishes but whose worktree can't be added stays, so the next run only adds the worktree", async () => {
		origin();
		const t = rig();
		const run = t.git;
		t.git = (dir, args, limits) => (args[0] === "fetch" ? Promise.resolve({ code: 1, out: "", err: "fatal: unable to access 'origin': Could not resolve host\n" }) : run(dir, args, limits));
		expect(await findCheckout(WANT, t)).toContain("Could not resolve host");
		expect(listing()).toEqual([REPO]);
	});
});

describe("several clones", () => {
	test("the main clone that already owns linked worktrees gets the new one, and the question names it", async () => {
		origin();
		const first = clone("sandbox-a");
		const second = clone("sandbox-b");
		git(second, "worktree", "add", "--quiet", "-b", "other", at("sandbox-b-other"));
		const t = rig();
		const tree = at(`sandbox-b-${SLUG}`);
		expect(await findCheckout(WANT, t)).toEqual({ root: tree, kind: "worktree" });
		expect(t.asked[0]?.message).toContain(tildify(second));
		expect(worktrees(first)).toHaveLength(1);
	});

	test("with none owning a worktree, the session's clone is the one", async () => {
		origin();
		clone("sandbox-a");
		const second = clone("sandbox-b");
		const tree = at(`sandbox-b-${SLUG}`);
		expect(await findCheckout(WANT, rig({ session: second }))).toEqual({ root: tree, kind: "worktree" });
	});

	test("with none owning a worktree and none the session's, the first by name is", async () => {
		origin();
		clone("sandbox-b");
		clone("sandbox-a");
		expect(await findCheckout(WANT, rig())).toEqual({ root: at(`sandbox-a-${SLUG}`), kind: "worktree" });
	});

	test("one that has the branch checked out beats a better-ranked clone without it", async () => {
		origin();
		const holder = clone("sandbox-a");
		git(holder, "checkout", "--quiet", "-b", BRANCH, `origin/${BRANCH}`);
		const owner = clone("sandbox-b");
		git(owner, "worktree", "add", "--quiet", "-b", "other", at("sandbox-b-other"));
		expect(await findCheckout(WANT, rig())).toEqual({ root: holder, kind: "existing" });
	});

	test("clones of other repositories, plain folders and files are not looked at", async () => {
		origin();
		origin(OWNER, "other");
		cloneOf(OWNER, "other", at("other"));
		fs.mkdirSync(at("notes"));
		fs.writeFileSync(at("a-file"), "x");
		const main = clone();
		expect(await findCheckout(WANT, rig())).toEqual({ root: at(`${REPO}-${SLUG}`), kind: "worktree" });
		expect(worktrees(main)).toHaveLength(2);
	});

	test("the repository's name is matched without regard to case", async () => {
		origin();
		clone();
		const shouting: Want = { ...WANT, pr: { ...PR, owner: "Tung-DNT", repo: "Sandbox" } };
		expect((await findCheckout(shouting, rig())) as { kind: string }).toMatchObject({ kind: "worktree" });
	});
});

describe("what refuses before anything is made", () => {
	test("a folder where the worktree would go that already exists", async () => {
		origin();
		clone();
		fs.mkdirSync(at(`${REPO}-${SLUG}`));
		const before = listing();
		const t = rig();
		const why = await findCheckout(WANT, t);
		expect(why).toContain("already exists");
		expect(why).toContain(tildify(at(`${REPO}-${SLUG}`)));
		expect(t.asked).toEqual([]);
		expect(listing()).toEqual(before);
	});

	test("that folder being a worktree on another branch", async () => {
		origin();
		const main = clone();
		git(main, "worktree", "add", "--quiet", "-b", "other", at(`${REPO}-${SLUG}`));
		const t = rig();
		expect(await findCheckout(WANT, t)).toContain("already exists");
		expect(t.asked).toEqual([]);
		expect(worktrees(main)).toHaveLength(2);
	});

	test("a local branch of that name that no folder has checked out", async () => {
		origin();
		const main = clone();
		git(main, "branch", BRANCH, `origin/${BRANCH}`);
		const t = rig();
		const why = await findCheckout(WANT, t);
		expect(why).toContain(`local branch ${BRANCH}`);
		expect(why).toContain(tildify(main));
		expect(t.asked).toEqual([]);
		expect(listing()).toEqual([REPO]);
	});

	test("a fork's PR, when this session isn't on its branch: no clone of this repository can hold it", async () => {
		origin();
		clone();
		const t = rig();
		const why = await findCheckout({ ...WANT, fork: true }, t);
		expect(why).toContain("fork");
		expect(t.asked).toEqual([]);
		expect(t.ghCalls).toEqual([]);
		expect(listing()).toEqual([REPO]);
	});

	test.each([["-x"], ["a b"], ["x\ny"], ["a~b"]])("a branch name git or a path could misread: %j", async name => {
		origin();
		const t = rig();
		expect(typeof (await findCheckout({ ...WANT, branch: name }, t))).toBe("string");
		expect(t.asked).toEqual([]);
		expect(t.ghCalls).toEqual([]);
	});

	test("a folder in the way of the clone, which is not a clone of the repository, is refused and left alone", async () => {
		origin();
		fs.mkdirSync(at(REPO));
		fs.writeFileSync(at(REPO, "mine.txt"), "keep");
		const t = rig();
		const why = await findCheckout(WANT, t);
		expect(why).toContain("already exists");
		expect(fs.readFileSync(at(REPO, "mine.txt"), "utf8")).toBe("keep");
		expect(t.asked).toEqual([]);
		expect(t.ghCalls.some(call => call.args[1] === "clone")).toBe(false);
	});

	test("the worktree folder a new clone would need being taken", async () => {
		origin();
		fs.mkdirSync(at(`${REPO}-${SLUG}`));
		const t = rig();
		expect(await findCheckout(WANT, t)).toContain("already exists");
		expect(t.asked).toEqual([]);
		expect(listing()).toEqual([`${REPO}-${SLUG}`]);
	});
});

describe("the question", () => {
	test("a no to a worktree leaves every folder as it was", async () => {
		origin();
		const main = clone();
		const t = rig({ says: false });
		const why = await findCheckout(WANT, t);
		expect(typeof why).toBe("string");
		expect(why).toContain(tildify(at(`${REPO}-${SLUG}`)));
		expect(listing()).toEqual([REPO]);
		expect(worktrees(main)).toHaveLength(1);
		expect(t.gitCalls.some(call => call.includes("fetch"))).toBe(false);
	});

	test("a no to a clone makes none", async () => {
		origin();
		const t = rig({ says: false });
		expect(typeof (await findCheckout(WANT, t))).toBe("string");
		expect(listing()).toEqual([]);
		expect(t.ghCalls.some(call => call.args[1] === "clone")).toBe(false);
	});

	test("with nobody to ask it refuses, naming the folder it would have used, and makes nothing", async () => {
		origin();
		const main = clone();
		const t = rig({ confirm: undefined });
		const why = await findCheckout(WANT, t);
		expect(why).toContain(tildify(at(`${REPO}-${SLUG}`)));
		expect(why).toContain("confirm");
		expect(listing()).toEqual([REPO]);
		expect(worktrees(main)).toHaveLength(1);
	});

	test("with nobody to ask, a checkout that exists is refused too, and named", async () => {
		origin();
		const main = clone();
		const tree = at(`${REPO}-${SLUG}`);
		git(main, "worktree", "add", "--quiet", "--track", "-b", BRANCH, tree, `origin/${BRANCH}`);
		const why = await findCheckout(WANT, rig({ confirm: undefined }));
		expect(why).toContain(tildify(tree));
		expect(why).toContain("confirm");
	});

	test("with nobody to ask, no clone is made either", async () => {
		origin();
		const t = rig({ confirm: undefined });
		expect(await findCheckout(WANT, t)).toContain(tildify(at(REPO)));
		expect(listing()).toEqual([]);
		expect(t.ghCalls.some(call => call.args[1] === "clone")).toBe(false);
	});

	test("a stop while the question is open ends it as a no", async () => {
		origin();
		clone();
		const controller = new AbortController();
		const asking = Promise.withResolvers<void>();
		const t = rig({
			signal: controller.signal,
			confirm: () => {
				asking.resolve();
				return whenAborted(controller.signal).then(() => false);
			},
		});
		const finding = findCheckout(WANT, t);
		await asking.promise;
		controller.abort();
		expect(typeof (await finding)).toBe("string");
		expect(listing()).toEqual([REPO]);
	});

	test("a stop that comes with the yes makes nothing", async () => {
		origin();
		const main = clone();
		const controller = new AbortController();
		const t = rig({
			signal: controller.signal,
			confirm: async () => {
				controller.abort();
				return true;
			},
		});
		expect(typeof (await findCheckout(WANT, t))).toBe("string");
		expect(listing()).toEqual([REPO]);
		expect(worktrees(main)).toHaveLength(1);
		expect(t.gitCalls.some(call => call.includes("fetch"))).toBe(false);
	});

	test("a folder that appears at the clone's place while the question is open is not cloned into, and not removed", async () => {
		origin();
		const t = rig();
		t.confirm = async () => {
			fs.mkdirSync(at(REPO));
			fs.writeFileSync(at(REPO, "mine.txt"), "keep");
			return true;
		};
		expect(await findCheckout(WANT, t)).toContain("appeared");
		expect(fs.readFileSync(at(REPO, "mine.txt"), "utf8")).toBe("keep");
		expect(t.ghCalls.some(call => call.args[1] === "clone")).toBe(false);
	});

	test("a folder with something in it that appears at the worktree's place while the question is open is left alone, and the add says it failed", async () => {
		origin();
		const main = clone();
		const tree = at(`${REPO}-${SLUG}`);
		const t = rig();
		t.confirm = async () => {
			fs.mkdirSync(tree);
			fs.writeFileSync(path.join(tree, "mine.txt"), "keep");
			return true;
		};
		expect(await findCheckout(WANT, t)).toContain("git worktree add");
		expect(fs.readFileSync(path.join(tree, "mine.txt"), "utf8")).toBe("keep");
		expect(worktrees(main)).toHaveLength(1);
	});

	test("a clone folder that can't be made says why", async () => {
		origin();
		fs.writeFileSync(path.join(scratch, "blocker"), "a file where the projects folder should be");
		const t = rig({ projects: path.join(scratch, "blocker", "projects") });
		expect(await findCheckout(WANT, t)).toContain("can't make");
		expect(t.ghCalls.some(call => call.args[1] === "clone")).toBe(false);
	});
});

describe("the projects folder", () => {
	const home = (): string => privateHome();

	test("is ~/projects unless the environment says otherwise", () => {
		expect(projectsRoot({})).toBe(path.join(home(), "projects"));
		expect(projectsRoot({ OMP_SHIP_PROJECTS: "" })).toBe(path.join(home(), "projects"));
		expect(projectsRoot({ OMP_SHIP_PROJECTS: "   " })).toBe(path.join(home(), "projects"));
	});

	test("is OMP_SHIP_PROJECTS when that is set, a leading ~ being the home folder", () => {
		expect(projectsRoot({ OMP_SHIP_PROJECTS: "/srv/code" })).toBe("/srv/code");
		expect(projectsRoot({ OMP_SHIP_PROJECTS: "~/code" })).toBe(path.join(home(), "code"));
		expect(projectsRoot({ OMP_SHIP_PROJECTS: " /srv/code/ " })).toBe("/srv/code");
	});

	test("reads process.env by default", () => {
		const before = process.env.OMP_SHIP_PROJECTS;
		process.env.OMP_SHIP_PROJECTS = "/srv/elsewhere";
		try {
			expect(projectsRoot()).toBe("/srv/elsewhere");
		} finally {
			if (before === undefined) delete process.env.OMP_SHIP_PROJECTS;
			else process.env.OMP_SHIP_PROJECTS = before;
		}
	});
});
