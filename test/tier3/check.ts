#!/usr/bin/env bun
// verify:step5 (plan D). Exit 0: pinned, selftest green, every in row PASS on evidence this run produced, nothing narrowed.
// 1: a row is not PASS. 2: harness error. 3: pin refused. 4: --print-hash (nothing was verified). 5: a narrowed run (--only, --no-haiku,
// --unpinned) or a run whose pin did not match, that would otherwise have been 0.
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { parseJUnit, type TestCase } from "./lib/junit.ts";
import { committedPin } from "./lib/pin.ts";
import { capFor } from "./lib/ledger.ts";
import { exitCode, judgeBunTest, rowVerdict, type Evidence, type Verdict } from "./lib/verdict.ts";
import { runSelftest } from "./lib/selftest.ts";
import { validateRequirements } from "./lib/schema.ts";
import { isNarrowed, judgeScenario } from "./lib/scenario-verdict.ts";
import { loadScenario, scenarioFiles } from "./scenario.ts";
import { copyCode, ompBinary, REPO_ROOT, TIER3 } from "./setup.ts";

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
	const i = argv.indexOf(`--${name}`);
	return i >= 0 ? argv[i + 1] : undefined;
};
const UNPINNED = argv.includes("--unpinned");
const NO_HAIKU = argv.includes("--no-haiku");
const PRINT_HASH = argv.includes("--print-hash");
const ONLY = flag("only")
	?.split(",")
	.map(s => s.trim())
	.filter(Boolean);
const CAP_ARG = flag("cap");
const REQ = path.join(TIER3, "requirements.yml");
const PIN_REL = "Specs/omp-starter/stories/spec-workflow/step5-requirements.sha256";
const VAULT_GIT = path.join(process.env.HOME ?? "", ".vault-git");
const OMP_MIN: [number, number] = [18, 16];
const BUN_TEST_TIMEOUT_MS = 30 * 60_000;
/** One driver run is capped at 25 minutes (cli.ts); a scenario child gets that per run plus a margin. */
const PER_RUN_TIMEOUT_MS = 26 * 60_000;

const sha256 = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");
const git = (...a: string[]): string => Bun.spawnSync(["git", "-C", REPO_ROOT, ...a], { stdout: "pipe", stderr: "pipe" }).stdout.toString();

/** Digest of every file under a folder (path and bytes), skipping the named top-level entries. */
function digestTree(dir: string, skip: string[] = []): string {
	const hash = createHash("sha256");
	const walk = (d: string, top: boolean): void => {
		for (const name of fs.readdirSync(d).sort()) {
			if (top && skip.includes(name)) continue;
			const p = path.join(d, name);
			const stat = fs.lstatSync(p);
			if (stat.isDirectory()) walk(p, false);
			else if (stat.isFile()) hash.update(path.relative(dir, p)).update("\0").update(fs.readFileSync(p)).update("\0");
		}
	};
	walk(dir, true);
	return hash.digest("hex");
}

/** HEAD, the diff of tracked files, and the bytes of untracked files under `extensions` and `scripts`: what the code under test is. */
function codeDigest(): { digest: string; head: string; dirty: boolean; untracked: string[] } {
	const head = git("rev-parse", "HEAD").trim();
	const diff = git("diff", "HEAD", "--", "extensions", "scripts");
	const untracked = git("ls-files", "-o", "--exclude-standard", "--", "extensions", "scripts").split("\n").filter(Boolean).sort();
	const hash = createHash("sha256").update(head).update(diff);
	for (const file of untracked) hash.update(file).update("\0").update(fs.readFileSync(path.join(REPO_ROOT, file)));
	return { digest: hash.digest("hex"), head, dirty: diff.length > 0 || untracked.length > 0, untracked };
}

async function main(): Promise<number> {
	// One read: the bytes that are hashed for the pin are the bytes that are parsed.
	const reqBytes = fs.readFileSync(REQ);
	const hash = sha256(reqBytes);
	if (PRINT_HASH) {
		console.log(hash);
		console.log("--print-hash verified nothing: exit 4");
		return 4;
	}
	const pin = committedPin(VAULT_GIT, PIN_REL);
	const pinMatched = pin.hash === hash;
	if (!pinMatched && !UNPINNED) {
		console.log(`pin refused: requirements.yml sha256 ${hash}; committed pin ${pin.hash ?? `(none: ${pin.error})`}. Nothing ran.`);
		return 3;
	}
	if (!pinMatched) console.log(`--unpinned: pin does not match (${hash} vs ${pin.hash ?? "none"}); this run cannot exit 0`);
	if (UNPINNED) console.log("--unpinned: this run cannot exit 0");

	const failedCases = runSelftest().filter(c => !c.pass);
	if (failedCases.length) {
		for (const c of failedCases) console.log(`selftest FAIL ${c.name}: ${c.detail}`);
		console.log("harness error: selftest is not green");
		return 2;
	}
	const omp = Bun.spawnSync([ompBinary(), "--version"], { stdout: "pipe", stderr: "pipe" });
	const ver = /(\d+)\.(\d+)/.exec(omp.stdout.toString() + omp.stderr.toString());
	if (!ver || Number(ver[1]) < OMP_MIN[0] || (Number(ver[1]) === OMP_MIN[0] && Number(ver[2]) < OMP_MIN[1])) {
		console.log(`harness error: omp 18.16 or newer is required on PATH (saw ${ver?.[0] ?? "none"})`);
		return 2;
	}

	const doc: any = Bun.YAML.parse(reqBytes.toString("utf8"));
	const errors = validateRequirements(doc, scenarioFiles());
	if (errors.length) {
		for (const e of errors) console.log(`schema: ${e}`);
		console.log("harness error: schema check failed");
		return 2;
	}
	// Every scenario file must load: a malformed expectation is a harness error, not a quiet pass.
	for (const id of scenarioFiles()) {
		try {
			loadScenario(id);
		} catch (error) {
			console.log(`harness error: scenario ${id}: ${error instanceof Error ? error.message : error}`);
			return 2;
		}
	}

	const narrowed = isNarrowed({ only: ONLY !== undefined, noHaiku: NO_HAIKU, unpinned: UNPINNED, pinMatched });
	const rows: any[] = doc.requirements.filter((r: any) => r.scope === "in" && (ONLY === undefined || ONLY.includes(r.id)));
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const runsDir = path.join(TIER3, "runs", stamp);
	fs.mkdirSync(runsDir, { recursive: true });
	const code = copyCode(path.join(runsDir, "code"));
	const codeInfo = codeDigest();
	const harnessDigest = digestTree(TIER3, ["runs"]);

	// bun-test evidence: one process over every existing file the in rows name
	const bunFiles = [...new Set(rows.flatMap(r => (r.evidence ?? []).filter((e: any) => e.kind === "bun-test").map((e: any) => e.file as string)))];
	const existing = bunFiles.filter(f => fs.existsSync(path.join(REPO_ROOT, f)));
	let cases: TestCase[] = [];
	if (existing.length) {
		const xml = path.join(runsDir, "junit.xml");
		const bun = Bun.spawnSync(["bun", "test", ...existing, "--reporter=junit", `--reporter-outfile=${xml}`], { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe", timeout: BUN_TEST_TIMEOUT_MS });
		fs.writeFileSync(path.join(runsDir, "bun-test.log"), bun.stdout.toString() + bun.stderr.toString());
		if (!fs.existsSync(xml)) {
			console.log(`harness error: bun test wrote no JUnit report (exit ${bun.exitCode}${bun.signalCode ? `, ${bun.signalCode}` : ""})`);
			return 2;
		}
		cases = parseJUnit(fs.readFileSync(xml, "utf8"));
		// A non-zero exit with no failing testcase is an error JUnit does not attribute (a load error, an unhandled rejection): not a pass.
		if (bun.exitCode !== 0 && !cases.some(c => c.failed)) {
			console.log(`harness error: bun test exited ${bun.exitCode} with no failing testcase in the JUnit report (see ${path.join(runsDir, "bun-test.log")})`);
			return 2;
		}
	}

	// scenario evidence: one child per repeat; haiku repeats gated by the spend cap
	const cap = capFor(CAP_ARG === undefined ? undefined : Number(CAP_ARG));
	let spent = 0;
	const cache = new Map<string, { verdict: Verdict; detail: string; dirs: string[] }>();
	const runScenario = (id: string, runner: "haiku" | "scripted", repeats: number) => {
		const key = `${id}|${runner}`;
		const hit = cache.get(key);
		if (hit) return hit;
		const dirs: string[] = [];
		const timeoutMs = loadScenario(id).runs.length * PER_RUN_TIMEOUT_MS;
		const judged = judgeScenario({
			runner,
			repeats,
			noHaiku: NO_HAIKU,
			cap,
			spent,
			run: n => {
				const out = path.join(runsDir, "scenarios", `${id}-${runner}-r${n}`);
				const child = Bun.spawnSync(["bun", path.join(TIER3, "cli.ts"), "run", id, "--runner", runner, "--repeat", String(n), "--out", out, "--code", code], { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe", timeout: timeoutMs });
				dirs.push(out);
				const resultFile = path.join(out, "result.json");
				const result = fs.existsSync(resultFile) ? JSON.parse(fs.readFileSync(resultFile, "utf8")) : undefined;
				// A host that left no result may still have spent: count a whole run's budget for it.
				const spendUsd = result ? Number(result.spendUsd) || 0 : runner === "haiku" ? 0.25 : 0;
				const pass = child.exitCode === 0 && result?.pass === true;
				return { pass, spendUsd, detail: `exit ${child.exitCode}${child.signalCode ? ` ${child.signalCode}` : ""}${result ? "" : ", no result.json"}` };
			},
		});
		spent = judged.spent;
		const r = { verdict: judged.verdict, detail: judged.detail, dirs };
		cache.set(key, r);
		return r;
	};

	const report: any[] = [];
	const rowVerdicts: Verdict[] = [];
	const broad: string[] = [];
	for (const row of rows) {
		const ev: Evidence[] = [];
		for (const e of row.evidence ?? []) {
			if (e.kind === "bun-test") {
				const judged = judgeBunTest(e.file, e.name, cases, fs.existsSync(path.join(REPO_ROOT, e.file)));
				ev.push(judged);
				// Reported, never failed: a short name or one that matches many cases proves less than it looks like.
				if (e.name.trim().length < 12 || (judged.matched?.length ?? 0) > 5) broad.push(`${row.id}: ${e.file} :: "${e.name}" (${judged.matched?.length ?? 0} cases, ${e.name.trim().length} chars)`);
			} else {
				const r = runScenario(e.id, e.runner, e.repeats);
				ev.push({ kind: "scenario", label: `${e.id} [${e.runner}] x${e.repeats}`, verdict: r.verdict, detail: r.detail });
			}
		}
		const verdict = rowVerdict(ev.map(x => x.verdict));
		rowVerdicts.push(verdict);
		report.push({ id: row.id, verdict, evidence: ev });
	}

	for (const r of report) {
		console.log(`${r.id.padEnd(7)} ${r.verdict}`);
		for (const e of r.evidence) if (e.verdict !== "PASS") console.log(`          ${e.verdict} ${e.label}: ${e.detail}`);
	}
	if (broad.length) {
		console.log(`broad bun-test names (reported, not failed): ${broad.length}`);
		for (const b of broad) console.log(`          ${b}`);
	}
	const totals: Record<Verdict, number> = { PASS: 0, FAIL: 0, MISSING: 0 };
	for (const v of rowVerdicts) totals[v]++;
	const exit = exitCode({ harnessError: false, pinRefused: false, narrowed, rowVerdicts });
	console.log(`rows ${rowVerdicts.length}: PASS ${totals.PASS}, FAIL ${totals.FAIL}, MISSING ${totals.MISSING}; spend $${spent.toFixed(4)} of cap $${cap}; narrowed=${narrowed}; pin ${pinMatched ? "matched" : "NOT matched (--unpinned)"}`);
	fs.writeFileSync(
		path.join(runsDir, "report.json"),
		JSON.stringify({ stamp, head: codeInfo.head, dirty: codeInfo.dirty, untracked: codeInfo.untracked, codeDigest: codeInfo.digest, harnessDigest, pin: { hash, committed: pin.hash ?? null, matched: pinMatched }, narrowed, cap, spendUsd: spent, totals, broadBunTestNames: broad, rows: report, runDirs: [...cache.values()].flatMap(v => v.dirs) }, null, 2),
	);
	console.log(`report: ${path.join(runsDir, "report.json")}`);
	console.log(`exit ${exit}`);
	return exit;
}

if (import.meta.main) {
	try {
		process.exitCode = await main();
	} catch (error) {
		console.error(`harness error: ${error}`);
		process.exitCode = 2;
	}
}
