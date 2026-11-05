// What a slot can do to the clone around it, driven through the real `GitOps` (`watch`, `discard`) on temp repos. Each test plays
// the slot by hand: it changes git state between `watch()` and `violations()`/`discard()` the way a misbehaving worker or another
// process would, and checks what the scheduler reports and what it puts back.
import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { MARKER } from "./spec-cli";
import { CHECKS, PLAN_PATH, cleanScratch, git, initRepo, initVault, planText, scratch } from "./spec-fixtures";
import { type CheckNote, readCheckNote, writeCheckNote } from "./spec-git";
import { type OpsConfig, realCheckOps, realGitOps } from "./spec-ops";
import type { GitOps, RunLock } from "./spec-scheduler";

afterEach(cleanScratch);

const REPO = "org/backend";
const SCOPE = ["src/a.ts"];

const note = (task: string): CheckNote => ({ v: 1, task, plan_rev: "r", checks: { test: "pass" }, attempts: 1, blocked: false, reason: "", at: "2026-11-05T00:00:00Z" });

function setup(over: Partial<OpsConfig> = {}) {
	const repo = initRepo("git@github.com:org/backend.git");
	git(repo, "checkout", "-q", "-b", "PAC-1");
	// The pre-push hook the run baseline must keep: the marker is what `inspect` reads as installed.
	writeFileSync(join(repo, ".git/hooks/pre-push"), `#!/bin/sh\n${MARKER}\nexit 0\n`, { mode: 0o755 });
	const vault = initVault();
	const rev = vault.commitPlan(
		PLAN_PATH,
		planText({
			id: "S-1",
			tasks: [{ id: "T1", owns: ["src/a.ts"], new_paths: ["t/t1.sh"] }, { id: "T2", owns: ["src/b.ts"], new_paths: ["src/c.ts", "t/t2.sh"] }],
			checks: { [REPO]: CHECKS },
		}),
	);
	const config: OpsConfig = {
		clones: new Map([[REPO, repo]]), story: "S-1", ticket: "PAC-1", base: "main", vaultGitDir: vault.gitDir, vaultRoot: vault.root, planPath: PLAN_PATH,
		worktreeRoot: scratch("wt-"), timeoutMs: 60_000, ...over,
	};
	return { repo, vault, config, rev, ops: realGitOps(config) };
}

/** A clone on its ticket branch with two commits on it, a run lock taken and the ledger seeded: the state a run is in when its first slot starts. */
function started() {
	const w = setup();
	const lock: RunLock = w.ops.acquire(REPO);
	const c1 = commitOnTicket(w.repo, "one");
	w.ops.inspect(REPO);
	const c2 = commitOnTicket(w.repo, "two");
	const wt = w.ops.addWorktree(REPO, "T1");
	return { ...w, lock, c1, c2, wt };
}

function commitOnTicket(repo: string, subject: string): string {
	git(repo, "commit", "-q", "--allow-empty", "-m", subject);
	return git(repo, "rev-parse", "HEAD");
}

const put = (cwd: string, file: string, text: string): void => {
	mkdirSync(dirname(join(cwd, file)), { recursive: true });
	writeFileSync(join(cwd, file), text);
};

describe("N1: discard undoes what the slot did, never what others did", () => {
	test("a note another process writes during a slot survives a rejected slot, and is not reported as the slot's", () => {
		const w = started();
		const watch = w.ops.watch(w.wt);
		writeCheckNote(w.repo, git(w.repo, "rev-parse", "main"), note("foreign"));
		put(w.wt.dir, "stray.txt", "x\n");
		expect(watch.violations(SCOPE, [])).toEqual(["stray.txt is outside the write scope"]);
		watch.discard();
		expect(readCheckNote(w.repo, git(w.repo, "rev-parse", "main"))?.task).toBe("foreign");
		expect(existsSync(join(w.wt.dir, "stray.txt"))).toBe(false);
	});

	test("a human commit on the ticket branch during a slot is left in place by a rejected slot", () => {
		const w = started();
		const watch = w.ops.watch(w.wt);
		const human = commitOnTicket(w.repo, "human");
		put(w.wt.dir, "stray.txt", "x\n");
		expect(watch.violations(SCOPE, []).join("\n")).toContain("stray.txt is outside the write scope");
		watch.discard();
		expect(git(w.repo, "rev-parse", "refs/heads/PAC-1")).toBe(human);
		expect(git(w.repo, "status", "--porcelain")).toBe("");
	});

	test("a ref of another run's namespace that moves during a slot is neither reported nor touched", () => {
		const w = started();
		const watch = w.ops.watch(w.wt);
		git(w.repo, "update-ref", "refs/heads/spec-wt/OTHER-9/T1", w.c1);
		git(w.repo, "update-ref", "refs/spec-conflict/OTHER-9/T1", w.c1);
		expect(watch.violations(SCOPE, [])).toEqual([]);
		watch.discard();
		expect(git(w.repo, "rev-parse", "refs/heads/spec-wt/OTHER-9/T1")).toBe(w.c1);
		expect(git(w.repo, "rev-parse", "refs/spec-conflict/OTHER-9/T1")).toBe(w.c1);
	});

	test("a ref the slot forges is put back by compare-and-swap, and a ref the slot deleted is put back too", () => {
		const w = started();
		git(w.repo, "branch", "keep", w.c1);
		const watch = w.ops.watch(w.wt);
		git(w.repo, "update-ref", "refs/heads/spec-wt/PAC-1/T9", w.c1);
		git(w.repo, "branch", "-D", "keep");
		expect(watch.violations(SCOPE, []).join("\n")).toContain("ref refs/heads/spec-wt/PAC-1/T9 created at");
		watch.discard();
		expect(git(w.repo, "branch", "--list", "spec-wt/PAC-1/T9")).toBe("");
		expect(git(w.repo, "rev-parse", "refs/heads/keep")).toBe(w.c1);
	});
});

describe("N2: a rollback to an older scheduler-written value is a violation", () => {
	test("the notes ref reset to an earlier value is reported per note and the lost notes are put back", () => {
		const w = started();
		w.ops.writeNote(REPO, w.c1, note("first"));
		const earlier = git(w.repo, "rev-parse", "refs/notes/spec-checks");
		w.ops.writeNote(REPO, w.c2, note("second"));
		const watch = w.ops.watch(w.wt);
		git(w.repo, "update-ref", "refs/notes/spec-checks", earlier);
		expect(watch.violations(SCOPE, []).join("\n")).toMatch(/note on [0-9a-f]{7} was removed/);
		watch.discard();
		expect(readCheckNote(w.repo, w.c1)?.task).toBe("first");
		expect(readCheckNote(w.repo, w.c2)?.task).toBe("second");
	});

	test("the notes ref deleted, and a note rewritten to look like a pass, are caught the same way", () => {
		const w = started();
		w.ops.writeNote(REPO, w.c1, note("first"));
		const watch = w.ops.watch(w.wt);
		writeCheckNote(w.repo, w.c1, note("forged"));
		expect(watch.violations(SCOPE, []).join("\n")).toMatch(/note on [0-9a-f]{7} was changed/);
		watch.discard();
		expect(readCheckNote(w.repo, w.c1)?.task).toBe("first");
		const second = w.ops.watch(w.wt);
		git(w.repo, "update-ref", "-d", "refs/notes/spec-checks");
		expect(second.violations(SCOPE, []).join("\n")).toMatch(/was removed/);
		second.discard();
		expect(readCheckNote(w.repo, w.c1)?.task).toBe("first");
	});

	test("a notes write by the scheduler during the slot (another task's check) is accepted and survives the discard", () => {
		const w = started();
		const watch = w.ops.watch(w.wt);
		w.ops.writeNote(REPO, w.c1, note("sibling"));
		put(w.wt.dir, "stray.txt", "x\n");
		expect(watch.violations(SCOPE, [])).toEqual(["stray.txt is outside the write scope"]);
		watch.discard();
		expect(readCheckNote(w.repo, w.c1)?.task).toBe("sibling");
	});

	test("the ticket branch reset to a tip the scheduler recorded earlier is rejected and restored", () => {
		const w = setup();
		w.ops.acquire(REPO);
		const c1 = commitOnTicket(w.repo, "one");
		w.ops.inspect(REPO);
		const c2 = commitOnTicket(w.repo, "two");
		const wt = w.ops.addWorktree(REPO, "T1");
		const watch = w.ops.watch(wt);
		git(w.repo, "update-ref", "refs/heads/PAC-1", c1);
		expect(watch.violations(SCOPE, []).join("\n")).toContain("ref refs/heads/PAC-1 moved from");
		watch.discard();
		expect(git(w.repo, "rev-parse", "refs/heads/PAC-1")).toBe(c2);
	});
});

describe("N3, N7: symbolic refs", () => {
	test("a temp notes ref planted as a symref is reported, removed without touching the notes, and a plain one of another live process is ignored", () => {
		const w = started();
		w.ops.writeNote(REPO, w.c1, note("first"));
		const watch = w.ops.watch(w.wt);
		git(w.repo, "symbolic-ref", `refs/notes/spec-tmp-${process.pid}-planted`, "refs/notes/spec-checks");
		git(w.repo, "update-ref", "refs/notes/spec-tmp-1-plain", w.c1);
		const found = watch.violations(SCOPE, []);
		expect(found).toEqual([`ref refs/notes/spec-tmp-${process.pid}-planted became a symref to refs/notes/spec-checks`]);
		watch.discard();
		expect(git(w.repo, "for-each-ref", "--format=%(refname)", "refs/notes")).not.toContain("planted");
		expect(readCheckNote(w.repo, w.c1)?.task).toBe("first");
	});

	test("the ticket branch turned into a symref to the task branch is reported and restored as a plain ref", () => {
		const w = started();
		const watch = w.ops.watch(w.wt);
		git(w.repo, "symbolic-ref", "refs/heads/PAC-1", w.wt.branch.replace(/^/, "refs/heads/"));
		expect(watch.violations(SCOPE, []).join("\n")).toContain(`ref refs/heads/PAC-1 became a symref to refs/heads/${w.wt.branch}`);
		watch.discard();
		expect(git(w.repo, "for-each-ref", "--format=%(symref)", "refs/heads/PAC-1")).toBe("");
		expect(git(w.repo, "rev-parse", "refs/heads/PAC-1")).toBe(w.c2);
		expect(git(w.repo, "rev-parse", "HEAD")).toBe(w.c2);
	});
});

describe("N4: the clone's config", () => {
	test("a config the slot rewrites is reported, restored byte for byte, and its fsmonitor command never runs", () => {
		const w = started();
		const config = join(w.repo, ".git/config");
		const original = readFileSync(config, "utf8");
		const marker = join(scratch("marker-"), "fsmonitor-ran");
		const watch = w.ops.watch(w.wt);
		appendFileSync(config, `[core]\n\tfsmonitor = touch '${marker}'; echo\n\thooksPath = ${join(w.repo, "evil-hooks")}\n`);
		put(w.wt.dir, "src/a.ts", "export const a = 3;\n");
		const found = watch.violations(SCOPE, []).join("\n");
		expect(found).toContain("config added: core.fsmonitor=");
		expect(found).toContain("config was changed in the git dir");
		watch.discard();
		expect(readFileSync(config, "utf8")).toBe(original);
		// Everything the scheduler runs after that, in the clone and in a check worktree, sees no fsmonitor.
		const second = w.ops.watch(w.wt);
		put(w.wt.dir, "src/a.ts", "export const a = 4;\n");
		expect(second.violations(SCOPE, [])).toEqual([]);
		w.ops.commit(w.wt, { task: "T1", planRev: "r", subject: "work" });
		expect(existsSync(marker)).toBe(false);
	});
});

describe("N5, N6: the order and the robustness of the restore", () => {
	test("a reference-transaction hook planted by the slot does not run while discard puts refs back", () => {
		const w = started();
		const marker = join(scratch("marker-"), "hook-ran");
		const watch = w.ops.watch(w.wt);
		git(w.repo, "update-ref", "refs/heads/spec-wt/PAC-1/T9", w.c1);
		writeFileSync(join(w.repo, ".git/hooks/reference-transaction"), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
		expect(watch.violations(SCOPE, []).join("\n")).toContain("hooks/reference-transaction was created in the git dir");
		watch.discard();
		expect(existsSync(marker)).toBe(false);
		expect(existsSync(join(w.repo, ".git/hooks/reference-transaction"))).toBe(false);
		expect(git(w.repo, "branch", "--list", "spec-wt/PAC-1/T9")).toBe("");
	});

	test("pre-push replaced by a directory is restored as the hook file, and the rest of the discard still happens", () => {
		const w = started();
		const hook = join(w.repo, ".git/hooks/pre-push");
		const original = readFileSync(hook, "utf8");
		const watch = w.ops.watch(w.wt);
		git(w.repo, "update-ref", "refs/heads/spec-wt/PAC-1/T9", w.c1);
		Bun.spawnSync({ cmd: ["rm", "-f", hook] });
		mkdirSync(join(hook, "sub"), { recursive: true });
		writeFileSync(join(hook, "sub/x"), "x");
		put(w.wt.dir, "stray.txt", "x\n");
		expect(watch.violations(SCOPE, []).join("\n")).toContain("hooks/pre-push was");
		watch.discard();
		expect(readFileSync(hook, "utf8")).toBe(original);
		expect(original).toContain(MARKER);
		expect(existsSync(join(w.wt.dir, "stray.txt"))).toBe(false);
		expect(git(w.repo, "branch", "--list", "spec-wt/PAC-1/T9")).toBe("");
	});
});

describe("N10: temp notes refs of dead processes", () => {
	test("taking the run lock prunes them, and leaves a live process's alone", () => {
		const w = setup();
		const dead = Bun.spawnSync({ cmd: ["true"] }).pid;
		const tip = commitOnTicket(w.repo, "one");
		git(w.repo, "update-ref", `refs/notes/spec-tmp-${dead}-abc`, tip);
		git(w.repo, "update-ref", `refs/notes/spec-tmp-${process.pid}-abc`, tip);
		w.ops.acquire(REPO);
		const left = git(w.repo, "for-each-ref", "--format=%(refname)", "refs/notes");
		expect(left).toContain(`spec-tmp-${process.pid}-abc`);
		expect(left).not.toContain(`spec-tmp-${dead}-abc`);
	});
});

describe("the run's temp folder", () => {
	test("the worktree root the ops made is removed when the last lock is released, once it is empty", () => {
		const w = setup({ worktreeRoot: undefined });
		const lock = w.ops.acquire(REPO);
		w.ops.inspect(REPO);
		const wt = w.ops.addWorktree(REPO, "T1");
		const root = dirname(wt.dir);
		expect(existsSync(root)).toBe(true);
		w.ops.removeWorktree(wt);
		lock.release();
		expect(existsSync(root)).toBe(false);
	});

	test("a root the caller supplied is never removed", () => {
		const w = setup();
		const root = w.config.worktreeRoot ?? "";
		const lock = w.ops.acquire(REPO);
		lock.release();
		expect(existsSync(root)).toBe(true);
	});
});

// ── Amendment 3 ────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A second task works in its own worktree, commits and lands on the ticket branch while slot X runs; returns what it landed. */
function landTask(w: { ops: GitOps; rev: string }, name: string, file: string, from: string) {
	const wtY = w.ops.addWorktree(REPO, name);
	put(wtY.dir, file, `export const ${name} = 1;\n`);
	const done = w.ops.commit(wtY, { task: name, planRev: w.rev, subject: `work ${name}` });
	if (done === undefined) throw new Error("nothing was committed");
	w.ops.publish(wtY, { from, to: done.sha });
	return { wt: wtY, sha: done.sha };
}

describe("R1: the latest recorded value is the only one a slot may leave", () => {
	test("a ticket branch rolled back to the slot-start tip after a sibling landed is rejected and put back at the sibling's tip", () => {
		const w = started();
		const watch = w.ops.watch(w.wt);
		const y = landTask(w, "T2", "src/b.ts", w.c2);
		git(w.repo, "update-ref", "refs/heads/PAC-1", w.c2);
		expect(watch.violations(SCOPE, []).join("\n")).toContain(`ref refs/heads/PAC-1 moved from ${y.sha.slice(0, 7)} to ${w.c2.slice(0, 7)}`);
		watch.discard();
		expect(git(w.repo, "rev-parse", "refs/heads/PAC-1")).toBe(y.sha);
	});

	test("a ref the scheduler moved twice during the slot (S, A, B) and the slot resets to A is rejected and put back at B", () => {
		const w = started();
		const watch = w.ops.watch(w.wt);
		const a = landTask(w, "T2", "src/b.ts", w.c2);
		const wtY = a.wt;
		put(wtY.dir, "src/c.ts", "export const c = 1;\n");
		const second = w.ops.commit(wtY, { task: "T2", planRev: w.rev, subject: "more" });
		if (second === undefined) throw new Error("nothing was committed");
		w.ops.publish(wtY, { from: a.sha, to: second.sha });
		git(w.repo, "update-ref", "refs/heads/PAC-1", a.sha);
		expect(watch.violations(SCOPE, []).join("\n")).toContain("ref refs/heads/PAC-1 moved from");
		watch.discard();
		expect(git(w.repo, "rev-parse", "refs/heads/PAC-1")).toBe(second.sha);
	});

	test("a ref the scheduler left alone during the slot may still only stay where it was", () => {
		const w = started();
		const watch = w.ops.watch(w.wt);
		expect(watch.violations(SCOPE, [])).toEqual([]);
		watch.discard();
		expect(git(w.repo, "rev-parse", "refs/heads/PAC-1")).toBe(w.c2);
	});

	test("a note the scheduler wrote during the slot on a target that had none, removed by the slot, is reported and written again", () => {
		const w = started();
		const watch = w.ops.watch(w.wt);
		w.ops.writeNote(REPO, w.c1, note("sibling"));
		git(w.repo, "update-ref", "-d", "refs/notes/spec-checks");
		expect(watch.violations(SCOPE, []).join("\n")).toMatch(/note on [0-9a-f]{7} was removed/);
		watch.discard();
		expect(readCheckNote(w.repo, w.c1)?.task).toBe("sibling");
	});

	test("a note the scheduler rewrote twice during the slot (S, A, B) and the slot puts back to A is reported and ends as B", () => {
		const w = started();
		w.ops.writeNote(REPO, w.c1, note("S"));
		const watch = w.ops.watch(w.wt);
		w.ops.writeNote(REPO, w.c1, note("A"));
		const blobA = git(w.repo, "notes", "--ref=spec-checks", "list", w.c1);
		w.ops.writeNote(REPO, w.c1, note("B"));
		git(w.repo, "notes", "--ref=spec-checks", "add", "-f", "-C", blobA, w.c1);
		expect(watch.violations(SCOPE, []).join("\n")).toMatch(/note on [0-9a-f]{7} was changed/);
		watch.discard();
		expect(readCheckNote(w.repo, w.c1)?.task).toBe("B");
	});
});

describe("R3: a notes ref that is deleted or rolled back keeps the foreign notes", () => {
	test("the notes ref deleted by the slot: the foreign note of the start survives, and the scheduler's notes of the slot are written again", () => {
		const w = started();
		w.ops.writeNote(REPO, w.c1, note("ours"));
		writeCheckNote(w.repo, git(w.repo, "rev-parse", "main"), note("foreign"));
		const watch = w.ops.watch(w.wt);
		w.ops.writeNote(REPO, w.c2, note("during"));
		git(w.repo, "update-ref", "-d", "refs/notes/spec-checks");
		expect(watch.violations(SCOPE, []).length).toBeGreaterThan(0);
		watch.discard();
		expect(readCheckNote(w.repo, git(w.repo, "rev-parse", "main"))?.task).toBe("foreign");
		expect(readCheckNote(w.repo, w.c1)?.task).toBe("ours");
		expect(readCheckNote(w.repo, w.c2)?.task).toBe("during");
	});

	test("the notes ref reset to an older notes commit: the foreign note written after it survives", () => {
		const w = started();
		w.ops.writeNote(REPO, w.c1, note("ours"));
		const older = git(w.repo, "rev-parse", "refs/notes/spec-checks");
		writeCheckNote(w.repo, git(w.repo, "rev-parse", "main"), note("foreign"));
		const watch = w.ops.watch(w.wt);
		git(w.repo, "update-ref", "refs/notes/spec-checks", older);
		watch.discard();
		expect(readCheckNote(w.repo, git(w.repo, "rev-parse", "main"))?.task).toBe("foreign");
		expect(readCheckNote(w.repo, w.c1)?.task).toBe("ours");
	});

	test("the notes ref pointed at a tree object does not wedge the discard", () => {
		const w = started();
		w.ops.writeNote(REPO, w.c1, note("ours"));
		const watch = w.ops.watch(w.wt);
		git(w.repo, "update-ref", "refs/notes/spec-checks", git(w.repo, "rev-parse", "main^{tree}"));
		watch.discard();
		expect(readCheckNote(w.repo, w.c1)?.task).toBe("ours");
	});
});

describe("R4: the note checkCommit writes is recorded at the write", () => {
	test("a check run for another task while a slot is open is neither reported nor reverted by that slot", async () => {
		const w = started();
		const wtY = w.ops.addWorktree(REPO, "T2");
		const watch = w.ops.watch(w.wt);
		put(wtY.dir, "src/b.ts", "export const b = 2;\n");
		put(wtY.dir, "t/t2.sh", "exit 0\n");
		const done = w.ops.commit(wtY, { task: "T2", planRev: w.rev, subject: "work T2" });
		if (done === undefined) throw new Error("nothing was committed");
		const report = await realCheckOps(w.config).check(wtY, done.sha);
		expect(report.ok).toBe(true);
		put(w.wt.dir, "stray.txt", "x\n");
		expect(watch.violations(SCOPE, [])).toEqual(["stray.txt is outside the write scope"]);
		watch.discard();
		expect(readCheckNote(w.repo, done.sha)?.task).toBe("T2");
	});
});
