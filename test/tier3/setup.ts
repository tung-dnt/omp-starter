// Isolated environment for one run segment (plan D.5, Isolation). Builds: HOME (a copy of ~/.omp/agent without
// sessions, logs, .env, blobs, mcp.json, extensions, rules and history; every model role Haiku, judge included; the
// agent-skills plugin only), fixture clones, the temp vault and a copy of the code under test. Never writes to the real
// ~/.omp, ~/vault or ~/.vault-git; their fingerprint is read before and after each run.
import { $ } from "bun";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { RunSetup } from "./scenario.ts";

export const HAIKU = "anthropic/claude-haiku-5-5";
export const STORY = "T3-SUM";
export const TIER3 = import.meta.dir;
export const REPO_ROOT = path.resolve(TIER3, "../..");
const FIXTURES = path.join(TIER3, "fixtures");
const ID = ["-c", "user.name=t3", "-c", "user.email=t3@example.com"];

export interface SegmentEnv {
	root: string;
	home: string;
	work: string;
	vault: string;
	code: string;
	/** repo name (e.g. "fixture") to its clone path */
	repos: Record<string, string>;
	/** ticket branch sha per repo name, at build time */
	tickets: Record<string, string>;
}

/** Copies the code under test (extensions/, scripts/, package.json) into `dest`; node_modules is linked. */
export function copyCode(dest: string): string {
	fs.rmSync(dest, { recursive: true, force: true });
	fs.mkdirSync(dest, { recursive: true });
	for (const d of ["extensions", "scripts"]) fs.cpSync(path.join(REPO_ROOT, d), path.join(dest, d), { recursive: true });
	fs.copyFileSync(path.join(REPO_ROOT, "package.json"), path.join(dest, "package.json"));
	fs.symlinkSync(path.join(REPO_ROOT, "node_modules"), path.join(dest, "node_modules"));
	return dest;
}

function buildHome(home: string): void {
	const REAL = `${process.env.HOME}/.omp`;
	const AGENT = `${home}/.omp/agent`;
	fs.mkdirSync(AGENT, { recursive: true });
	const skip = ["sessions", "spec-runs", "logs", ".env", "blobs", "mcp.json", "extensions", "rules", "terminal-sessions", "custom-session-files", "predict", "history.db", "history.db-shm", "history.db-wal"];
	for (const name of fs.readdirSync(`${REAL}/agent`)) {
		if (skip.includes(name) || name.startsWith("._")) continue;
		fs.cpSync(`${REAL}/agent/${name}`, `${AGENT}/${name}`, { recursive: true });
	}
	const cfgFile = `${AGENT}/config.yml`;
	const cfg = Bun.YAML.parse(fs.readFileSync(cfgFile, "utf8")) as Record<string, any>;
	const haiku = (roles: Record<string, string>) => {
		for (const key of ["default", "task", "slow", "tiny", "judge"]) roles[key] = HAIKU;
		for (const [key, value] of Object.entries(roles)) if (!String(value).startsWith("@")) roles[key] = HAIKU;
		return roles;
	};
	cfg.modelRoles = haiku({ ...(cfg.modelRoles ?? {}) });
	for (const preset of Object.values<any>(cfg.modelPresets ?? {})) preset.modelRoles = haiku({ ...(preset.modelRoles ?? {}) });
	fs.writeFileSync(cfgFile, Bun.YAML.stringify(cfg, null, 2));
	fs.chmodSync(cfgFile, 0o600);

	// plugins: only agent-skills, repointed at the copy (a second starter plugin would load a second /run-story)
	const P = `${home}/.omp/plugins`;
	fs.mkdirSync(`${P}/cache/plugins`, { recursive: true });
	const skillsDir = "tung-agent-skills___agent-skills___0.7.0";
	fs.cpSync(`${REAL}/plugins/cache/plugins/${skillsDir}`, `${P}/cache/plugins/${skillsDir}`, { recursive: true });
	fs.mkdirSync(`${P}/node_modules`, { recursive: true });
	fs.symlinkSync(`${P}/cache/plugins/${skillsDir}`, `${P}/node_modules/agent-skills`);
	fs.copyFileSync(`${REAL}/plugins/package.json`, `${P}/package.json`);
	const installed = JSON.parse(fs.readFileSync(`${REAL}/plugins/installed_plugins.json`, "utf8"));
	delete installed.plugins["starter@omp-starter"];
	for (const entries of Object.values<any[]>(installed.plugins)) for (const e of entries) e.installPath = String(e.installPath).replace(REAL, `${home}/.omp`);
	fs.writeFileSync(`${P}/installed_plugins.json`, JSON.stringify(installed, null, 2));
	const lock = JSON.parse(fs.readFileSync(`${REAL}/plugins/omp-plugins.lock.json`, "utf8"));
	delete lock.plugins["omp-starter"];
	fs.writeFileSync(`${P}/omp-plugins.lock.json`, JSON.stringify(lock, null, 2));
}

async function buildRepos(work: string, names: string[], ticketBranch: boolean): Promise<{ repos: Record<string, string>; tickets: Record<string, string> }> {
	const repos: Record<string, string> = {};
	const tickets: Record<string, string> = {};
	for (const name of names) {
		const dir = path.join(work, name);
		fs.mkdirSync(path.join(dir, "src"), { recursive: true });
		await $`git init -q -b main ${dir}`;
		if (name === "fixture") {
			fs.writeFileSync(path.join(dir, "package.json"), '{\n  "name": "fixture",\n  "private": true\n}\n');
			fs.writeFileSync(path.join(dir, "src/sum.ts"), "export function sum(a: number, b: number): number {\n\treturn a - b; // BUG: must be a + b\n}\n");
		} else {
			fs.writeFileSync(path.join(dir, "package.json"), `{\n  "name": "${name}",\n  "private": true\n}\n`);
			fs.writeFileSync(path.join(dir, `src/${name}.ts`), `export const ${name} = 0;\n`);
		}
		await $`git ${ID} -C ${dir} add -A`.quiet();
		await $`git ${ID} -C ${dir} commit -qm ${`${name}: base`}`.quiet();
		await $`git -C ${dir} remote add origin ${`git@github.com:org/${name}.git`}`.quiet();
		if (ticketBranch) await $`git -C ${dir} branch ${STORY} main`.quiet();
		await $`git -C ${dir} config user.name t3`.quiet();
		await $`git -C ${dir} config user.email t3@example.com`.quiet();
		repos[name] = dir;
		tickets[name] = ticketBranch ? (await $`git -C ${dir} rev-parse ${STORY}`.quiet().text()).trim() : "";
	}
	return { repos, tickets };
}

/** Builds one segment: HOME, clones, vault (Specs/T3/plan.md from fixtures/<plan>) and the code copy. */
export async function buildSegment(root: string, repoNames: string[], plan: string, code: string, setups: readonly RunSetup[] = []): Promise<SegmentEnv> {
	fs.rmSync(root, { recursive: true, force: true });
	fs.mkdirSync(root, { recursive: true });
	const home = path.join(root, "home");
	buildHome(home);
	const work = path.join(root, "work");
	fs.mkdirSync(work, { recursive: true });
	const { repos, tickets } = await buildRepos(work, repoNames, !setups.includes("no-branch"));
	const vault = path.join(root, "vault");
	fs.mkdirSync(path.join(vault, "Specs/T3"), { recursive: true });
	await $`git init -q -b main ${vault}`;
	fs.copyFileSync(path.join(FIXTURES, plan), path.join(vault, "Specs/T3/plan.md"));
	await $`git -C ${vault} add -A`.quiet();
	await $`git ${ID} -C ${vault} commit -qm ${"plan T3-SUM"}`.quiet();
	const env: SegmentEnv = { root, home, work, vault, code, repos, tickets };
	applySetups(env, setups);
	return env;
}

/** The run lock file of the first clone: `<git dir>/spec-run-<ticket>.lock`. */
export const lockFileOf = (clone: string): string => path.join(clone, ".git", `spec-run-${STORY}.lock`);

/** Changes to a fresh segment before its run (scenario `setup:`). */
function applySetups(env: SegmentEnv, setups: readonly RunSetup[]): void {
	const clone = Object.values(env.repos)[0] as string;
	for (const setup of setups) {
		if (setup === "hook-installed") {
			const r = Bun.spawnSync(["bun", path.join(env.code, "scripts/spec-hook.ts"), "install", "--repo", clone, "--plan", "Specs/T3/plan.md", "--base", "main", "--vault-git-dir", path.join(env.vault, ".git")], { stdout: "pipe", stderr: "pipe" });
			if (r.exitCode !== 0) throw new Error(`hook install failed: ${r.stdout.toString()}${r.stderr.toString()}`);
		} else if (setup === "vault-dirty") fs.appendFileSync(path.join(env.vault, "Specs/T3/plan.md"), "\nAn edit nobody committed.\n");
		else if (setup === "clone-dirty") fs.appendFileSync(path.join(clone, "src/sum.ts"), "// uncommitted edit\n");
		else if (setup === "lock-live" || setup === "lock-foreign" || setup === "lock-dead") {
			let pid = process.pid;
			if (setup === "lock-dead") {
				const child = Bun.spawnSync(["sh", "-c", "exit 0"]);
				pid = (child as unknown as { pid?: number }).pid ?? 2 ** 22 - 3;
				// A pid that is certainly gone: far above any live pid on this machine unless it is in use.
				while (pidAlive(pid)) pid -= 1;
			}
			const holder = { pid, host: setup === "lock-foreign" ? "some-other-host" : os.hostname(), startedAt: "2026-11-05T01:02:03.000Z" };
			fs.writeFileSync(lockFileOf(clone), JSON.stringify(holder));
		}
	}
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as { code?: string }).code === "EPERM";
	}
}

/** Removes the copied HOME (it holds credentials). The clones, vault and run logs stay as evidence. */
export function removeHome(env: SegmentEnv): void {
	fs.rmSync(env.home, { recursive: true, force: true });
}

/** Real-state fingerprint (the TS port of the proven baseline.sh). Read-only commands only. */
export function fingerprint(): string[] {
	const H = process.env.HOME ?? "";
	const sh = (...cmd: string[]) => {
		const r = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
		return (r.stdout.toString() + r.stderr.toString()).trim();
	};
	const digest = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex");
	const fileDigest = (p: string) => (fs.existsSync(p) ? digest(fs.readFileSync(p, "utf8")) : "absent");
	return [
		`vault-git HEAD: ${sh("git", `--git-dir=${H}/.vault-git`, "rev-parse", "HEAD")}`,
		`vault-git refs: ${digest(sh("git", `--git-dir=${H}/.vault-git`, "for-each-ref"))}`,
		`vault-git config: ${fileDigest(`${H}/.vault-git/config`)}`,
		`vault status: ${digest(sh("git", `--git-dir=${H}/.vault-git`, `--work-tree=${H}/vault`, "status", "--porcelain=v1"))}`,
		`real spec-runs: ${fs.existsSync(`${H}/.omp/agent/spec-runs`) ? "present" : "absent"}`,
		`real .env: ${fs.existsSync(`${H}/.omp/agent/.env`) ? "present" : "absent"}`,
		`real config.yml: ${fileDigest(`${H}/.omp/agent/config.yml`)}`,
		`real mcp.json: ${fileDigest(`${H}/.omp/agent/mcp.json`)}`,
		`real plugins: ${fileDigest(`${H}/.omp/plugins/installed_plugins.json`)}`,
		`omp-starter tree: ${digest(sh("git", "-C", REPO_ROOT, "status", "--porcelain=v1"))}`,
	];
}

/** The omp the user runs: the first on PATH outside node_modules/.bin (`bun run` puts the repo's own devDependency first). */
export function ompBinary(): string {
	const dirs = (process.env.PATH ?? "").split(":").filter(d => d !== "" && !d.includes("node_modules/.bin"));
	for (const d of dirs) {
		const p = path.join(d, "omp");
		if (fs.existsSync(p)) return p;
	}
	throw new Error("no omp on PATH outside node_modules/.bin");
}

export function specWorktreeRoots(): string[] {
	return fs.readdirSync("/tmp").filter(n => n.startsWith("spec-wt-")).sort();
}
