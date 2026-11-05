import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { PLAN_PATH, cleanScratch, git, initRepo, initVault, planText } from "../extensions/lib/spec-fixtures";
import { type OpsConfig, realGitOps } from "../extensions/lib/spec-ops";
import { main } from "./spec-status";

afterEach(cleanScratch);

const REPO = "org/backend";

/** A clone on PAC-1 and a vault whose plan has T1 and T2 (T2 waits for T1). */
function world() {
	const repo = initRepo("git@github.com:org/backend.git");
	git(repo, "checkout", "-q", "-b", "PAC-1");
	const vault = initVault();
	const text = planText({
		id: "S-1",
		tasks: [{ id: "T1", owns: ["src/a.ts"] }, { id: "T2", owns: ["src/b.ts"], depends_on: ["T1"] }],
		checks: { [REPO]: { test: "true" } },
	});
	const rev = vault.commitPlan(PLAN_PATH, text);
	const config: OpsConfig = { clones: new Map([[REPO, repo]]), story: "S-1", ticket: "PAC-1", base: "main", vaultGitDir: vault.gitDir, vaultRoot: vault.root, planPath: PLAN_PATH };
	const status = (...extra: string[]): { code: number; out: string } => {
		const log = spyOn(console, "log").mockImplementation(() => {});
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		const error = spyOn(console, "error").mockImplementation(() => {});
		try {
			const code = main([join(vault.root, PLAN_PATH), "--repo", repo, "--branch", "PAC-1", "--base", "main", ...extra]);
			return { code, out: log.mock.calls.map(call => String(call[0])).join("\n") };
		} finally {
			log.mockRestore();
			warn.mockRestore();
			error.mockRestore();
		}
	};
	return { repo, vault, text, rev, config, status };
}

describe("spec-status CLI: blocked notes of tasks with no commit", () => {
	test("a task-key note of the current plan revision shows blocked; a new plan revision shows ready", () => {
		const w = world();
		realGitOps(w.config).setTaskNote(REPO, "T1", { v: 1, task: "T1", plan_rev: w.rev, checks: {}, attempts: 1, blocked: true, reason: "spec_wrong", at: "2026-11-05T00:00:00Z" });

		const blocked = w.status("--vault-git-dir", w.vault.gitDir);
		expect(blocked.code).toBe(0);
		expect(blocked.out).toMatch(/T1\s+blocked\s+attempts 1\s+spec_wrong/);
		expect(blocked.out).toMatch(/T2\s+waiting/);

		w.vault.commitPlan(PLAN_PATH, `${w.text}\nClarified.\n`);
		const ready = w.status("--vault-git-dir", w.vault.gitDir);
		expect(ready.out).toMatch(/T1\s+ready/);
	});

	test("a plan outside the vault prints a note, and a blocked note is shown without the plan-revision check", () => {
		const w = world();
		realGitOps(w.config).setTaskNote(REPO, "T1", { v: 1, task: "T1", plan_rev: "an-older-rev", checks: {}, attempts: 1, blocked: true, reason: "blocked", at: "2026-11-05T00:00:00Z" });
		const other = initVault();
		const result = w.status("--vault-git-dir", other.gitDir);
		expect(result.code).toBe(0);
		expect(result.out).toContain("note: blocked notes are shown without a plan-revision check");
		expect(result.out).toMatch(/T1\s+blocked/);
	});
});
