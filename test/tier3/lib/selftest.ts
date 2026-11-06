// Embedded cases for the pure parts of the checker (plan D.2, `bun run tier3 selftest`). No model, no HOME, no network.
import { parseJUnit, type TestCase } from "./junit.ts";
import { judgeBunTest, rowVerdict, exitCode } from "./verdict.ts";
import { capFor, mayStartHaiku, slotCostOf } from "./ledger.ts";
import { validateRequirements } from "./schema.ts";
import { isNarrowed, judgeScenario, type RepeatResult } from "./scenario-verdict.ts";
import { expectProblem } from "../assert.ts";
import { scanCode, scanText } from "./network-scan.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface Case {
	name: string;
	pass: boolean;
	detail: string;
}

const SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="4" assertions="2" failures="1" skipped="1" time="0.01">
  <testsuite name="p.test.ts" file="p.test.ts" tests="4" assertions="2" failures="1" skipped="1" time="0.002">
    <testsuite name="outer R-1: thing" file="p.test.ts" line="2" tests="3" assertions="2" failures="1" skipped="1" time="0">
      <testsuite name="inner" file="p.test.ts" line="3" tests="2" assertions="1" failures="0" skipped="1" time="0">
        <testcase name="leaf one &amp; &lt;x&gt; &quot;q&quot;" classname="inner &gt; outer R-1: thing" time="0.000025" file="p.test.ts" line="4" assertions="1" />
        <testcase name="skipped one" classname="inner" time="0" file="p.test.ts" line="5" assertions="0">
          <skipped />
        </testcase>
      </testsuite>
      <testcase name="fails here" classname="outer R-1: thing" time="0.0002" file="p.test.ts" line="7" assertions="1">
        <failure type="AssertionError" message="x">AssertionError: x</failure>
      </testcase>
    </testsuite>
    <testcase name="top level" classname="" time="0" file="p.test.ts" line="9" assertions="0" />
  </testsuite>
</testsuites>`;

const F = "x.test.ts";
const tc = (name: string, extra: Partial<{ ancestors: string[]; skipped: boolean; failed: boolean; assertions: number }> = {}): TestCase => ({
	name,
	ancestors: extra.ancestors ?? [],
	file: F,
	skipped: extra.skipped ?? false,
	failed: extra.failed ?? false,
	assertions: extra.assertions ?? 1,
});

export function runSelftest(): Case[] {
	const cases: Case[] = [];
	const add = (name: string, pass: boolean, detail = "") => cases.push({ name, pass, detail });

	const parsed = parseJUnit(SAMPLE);
	const leaf = parsed.find(c => c.name.startsWith("leaf one"));
	add("junit: nested describe titles, entities, skipped, failed, assertions", parsed.length === 4 && leaf?.name === 'leaf one & <x> "q"' && leaf.ancestors.join("|") === "outer R-1: thing|inner" && parsed.some(c => c.skipped) && parsed.some(c => c.failed) && parsed.find(c => c.name === "top level")?.assertions === 0, `cases=${parsed.length}`);

	add("no runtime title carries the name: MISSING", judgeBunTest(F, "nothing here", [tc("a test")], true).verdict === "MISSING");
	add("file does not exist: MISSING", judgeBunTest("gone.test.ts", "a", [tc("a")], false).verdict === "MISSING");
	add("name carried by an ancestor describe: PASS", judgeBunTest(F, "R-104: foundation", [tc("starts later", { ancestors: ["R-104: foundation first"] })], true).verdict === "PASS");
	add("skipped testcase: FAIL", judgeBunTest(F, "a", [tc("a", { skipped: true })], true).verdict === "FAIL");
	add("failing testcase: FAIL", judgeBunTest(F, "a", [tc("a", { failed: true })], true).verdict === "FAIL");
	add("zero-assertion testcase: FAIL", judgeBunTest(F, "a", [tc("a", { assertions: 0 })], true).verdict === "FAIL");
	add("one passing and one failing match: FAIL", judgeBunTest(F, "a", [tc("a one"), tc("a two", { failed: true })], true).verdict === "FAIL");

	add("row AND: a FAIL beats MISSING and PASS", rowVerdict(["PASS", "FAIL", "MISSING"]) === "FAIL");
	add("row AND: a MISSING beats PASS", rowVerdict(["PASS", "MISSING"]) === "MISSING");
	add("row with no evidence is MISSING", rowVerdict([]) === "MISSING");
	add("row AND: all PASS is PASS", rowVerdict(["PASS", "PASS"]) === "PASS");

	add("cap: a haiku run starts while spent + 0.25 <= cap", mayStartHaiku(1.75, 2) === true && mayStartHaiku(1.76, 2) === false);
	add("cap: a haiku run that cannot start leaves its evidence MISSING", rowVerdict([mayStartHaiku(1.9, 2) ? "PASS" : "MISSING"]) === "MISSING");
	add("cap: --cap may only lower the cap", capFor(5) === 2 && capFor(1) === 1 && capFor(undefined) === 2);
	add("spend: sums costUsd of slot lines only", slotCostOf('{"kind":"slot","costUsd":0.5}\n{"kind":"event","costUsd":9}\n{"kind":"slot","costUsd":0.25}\n') === 0.75);

	add("exit: pin refused is 3", exitCode({ harnessError: false, pinRefused: true, narrowed: false, rowVerdicts: ["PASS"] }) === 3);
	add("exit: harness error is 2", exitCode({ harnessError: true, pinRefused: false, narrowed: false, rowVerdicts: [] }) === 2);
	add("exit: a row not PASS is 1", exitCode({ harnessError: false, pinRefused: false, narrowed: false, rowVerdicts: ["PASS", "MISSING"] }) === 1);
	add("exit: an unpinned or narrowed run that would be 0 is 5, never 0", exitCode({ harnessError: false, pinRefused: false, narrowed: true, rowVerdicts: ["PASS"] }) === 5);
	add("exit: a complete pinned run with every row PASS is 0", exitCode({ harnessError: false, pinRefused: false, narrowed: false, rowVerdicts: ["PASS", "PASS"] }) === 0);

	const good = { version: 1, requirements: [{ id: "R-01", scope: "in", evidence: [{ kind: "bun-test", file: F, name: "a" }] }], scenarios: [] };
	add("schema: a well-formed document has no errors", validateRequirements(good, []).length === 0, validateRequirements(good, []).join("; "));
	const dup = { ...good, requirements: [good.requirements[0], good.requirements[0]] };
	add("schema: duplicate ids are refused", validateRequirements(dup, []).some(e => e.includes("duplicate requirement id R-01")));
	const badHaiku = { version: 1, requirements: [{ id: "R-02", scope: "in", evidence: [{ kind: "scenario", id: "S-x", runner: "haiku", repeats: 2 }] }], scenarios: [{ id: "S-x", runner: "haiku", repeats: 2 }] };
	add("schema: haiku repeats must be 3", validateRequirements(badHaiku, ["S-x"]).some(e => e.includes("haiku repeats must be 3")));
	add("schema: an in row with no evidence is refused", validateRequirements({ version: 1, requirements: [{ id: "R-03", scope: "in", evidence: [] }], scenarios: [] }, []).some(e => e.includes("no evidence")));
	const residual = (source: string, extra: Record<string, string> = {}) => ({ version: 1, requirements: [{ id: "AR-09", scope: "residual", source, text: "x", ...extra }], scenarios: [] });
	add("schema: a residual row cites an LLD source and needs no note", validateRequirements(residual("LLD Amendment 3 threat model R2"), []).length === 0);
	add("schema: a residual row with a non-LLD source and no note is refused", validateRequirements(residual("BRIEF Setup 6"), []).some(e => e.includes("residual row needs")));
	add("schema: a residual row with a note is accepted", validateRequirements(residual("BRIEF Setup 6", { note: "deferred" }), []).length === 0);
	add("schema: an out row needs a reason, not a note", validateRequirements({ version: 1, requirements: [{ id: "OS-09", scope: "out", source: "LLD", text: "x", note: "n" }], scenarios: [] }, []).some(e => e.includes("out row needs a reason")));
	add("schema: a scenario file without an entry is refused", validateRequirements(good, ["S-orphan"]).some(e => e.includes("S-orphan")));
	// scenario evidence: every repeat must pass; a failed repeat is FAIL; the cap and --no-haiku leave MISSING; nothing narrowed exits 0
	const repeats = (...results: Array<Partial<RepeatResult>>) => (n: number): RepeatResult => ({ pass: true, spendUsd: 0.01, detail: "", ...results[n - 1] });
	const judge = (o: Partial<Parameters<typeof judgeScenario>[0]> & { run: (n: number) => RepeatResult }) => judgeScenario({ runner: "haiku", repeats: 3, noHaiku: false, cap: 2, spent: 0, ...o });
	add("scenario: three green haiku repeats are PASS", judge({ run: repeats() }).verdict === "PASS");
	add("scenario: two of three green haiku repeats are FAIL, never PASS", judge({ run: repeats({}, { pass: false }) }).verdict === "FAIL");
	add("scenario: a host that throws is a failed repeat", judge({ run: n => { if (n === 2) throw new Error("boom"); return { pass: true, spendUsd: 0, detail: "" }; } }).verdict === "FAIL");
	add("scenario: a cap that leaves a repeat unstarted is MISSING", judge({ spent: 1.9, run: repeats() }).verdict === "MISSING");
	add("scenario: the ledger grows with each repeat, so the cap stops the third", judge({ spent: 1.0, run: repeats({ spendUsd: 0.4 }, { spendUsd: 0.4 }) }).verdict === "MISSING");
	add("scenario: a failed repeat beats a cap-skipped one", judge({ spent: 1.74, run: repeats({ pass: false, spendUsd: 0.2 }) }).verdict === "FAIL");
	add("scenario: --no-haiku leaves haiku evidence MISSING and runs nothing", (() => { let ran = 0; const r = judge({ noHaiku: true, run: n => { ran++; return repeats()(n); } }); return r.verdict === "MISSING" && ran === 0; })());
	add("scenario: --no-haiku does not touch a scripted scenario", judge({ runner: "scripted", repeats: 1, noHaiku: true, run: repeats() }).verdict === "PASS");
	add("scenario: a failed scripted repeat is FAIL", judge({ runner: "scripted", repeats: 1, run: repeats({ pass: false }) }).verdict === "FAIL");
	add("narrowed: --only, --no-haiku, --unpinned and a pin that did not match each narrow", [{ only: true }, { noHaiku: true }, { unpinned: true }, { pinMatched: false }].every(o => isNarrowed({ only: false, noHaiku: false, unpinned: false, pinMatched: true, ...o })));
	add("narrowed: a complete pinned run is not narrowed", !isNarrowed({ only: false, noHaiku: false, unpinned: false, pinMatched: true }));

	// the expectation language: strict keys, nested forms, no silent typos
	add("expect: nested slot, gate and session forms are well formed", [{ slot: { task: "T", slot: "implementer", attempt: 1 } }, { gate: { cause: "cap", choice: "stop" } }, { session: { task: "T", promptHas: "x" } }, { event: "run-start", count: 1 }].every(e => expectProblem(e) === undefined));
	add("expect: a misspelt key is a problem, not a check that matches nothing", expectProblem({ event: "x", tsak: "T" }) !== undefined && expectProblem({ noSlot: { slots: "x" } }) !== undefined && expectProblem({ slot: { task: "T", slot: "x", outcom: "y" } }) !== undefined);
	add("expect: a flat slot or gate string and an unknown name are problems", expectProblem({ slot: "implementer" }) !== undefined && expectProblem({ gate: "cap" }) !== undefined && expectProblem("no-such-check") !== undefined && expectProblem({ ticket: "maybe" }) !== undefined);
	add("expect: two forms in one mapping are a problem", expectProblem({ event: "x", slot: { task: "T", slot: "implementer" } }) !== undefined);
	// R-106 scan: network modules, fetch, WebSocket and a git push are hits; an array push, a comment and a blocklist entry are not
	const scan = (text: string) => scanText("x.ts", text).map(h => h.why);
	add("network scan: node:http(s), net, tls, dgram imports and requires are hits", ["import h from \"node:https\";", "const n = require(\"net\");", "import(\"node:dgram\")", "import { x } from 'node:tls';"].every(t => scan(t).length === 1));
	add("network scan: fetch( and WebSocket are hits", scan("const r = await fetch(url);").length === 1 && scan("const ws = new WebSocket(u);").length === 1);
	add("network scan: a git argv with push is a hit", scan('git(repo, ["push", "origin"]);').length === 1 && scan('hookless(dir, ["push"]);').length === 1 && scan('Bun.spawnSync(["git", "-C", d,\n"push"]);').length === 1);
	add("network scan: items.push(x), comments and a blocklist entry are not hits", scan("items.push(x);").length === 0 && scan("// fetch(url) is not used").length === 0 && scan(" * calls fetch( here").length === 0 && scan('const GIT_MUTATIONS = [\n"commit",\n"push",\n];').length === 0);
	const tree = fs.mkdtempSync(path.join(os.tmpdir(), "t3-scan-"));
	fs.mkdirSync(path.join(tree, "extensions/lib"), { recursive: true });
	fs.mkdirSync(path.join(tree, "scripts"), { recursive: true });
	fs.writeFileSync(path.join(tree, "extensions/spec-workflow.ts"), 'import { a } from "./lib/a";\nexport default a;\n');
	fs.writeFileSync(path.join(tree, "extensions/lib/a.ts"), "export const a = 1;\n");
	fs.writeFileSync(path.join(tree, "extensions/lib/other.ts"), "await fetch(url);\n");
	fs.writeFileSync(path.join(tree, "extensions/lib/a.test.ts"), "await fetch(url);\n");
	const clean = scanCode(tree);
	add("network scan: only the entry's import closure is scanned, and tests are excluded", clean.files === 2 && clean.hits.length === 0, JSON.stringify(clean));
	fs.appendFileSync(path.join(tree, "extensions/lib/a.ts"), "export const r = fetch(\"https://x\");\n");
	const dirty = scanCode(tree);
	add("network scan: an injected fetch( in a loaded file fails with file and line", dirty.hits.length === 1 && dirty.hits[0]?.file === "extensions/lib/a.ts" && dirty.hits[0]?.line === 2, JSON.stringify(dirty.hits));
	fs.rmSync(tree, { recursive: true, force: true });
	return cases;
}
