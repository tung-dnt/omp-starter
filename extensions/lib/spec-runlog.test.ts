import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import { RUNS_DIR, fileRunLog, type RunLogEntry } from "./spec-runlog";
import { cleanScratch, scratch } from "./spec-fixtures";

afterEach(cleanScratch);

const slot: RunLogEntry = {
	kind: "slot", at: "2026-11-04T05:00:00.000Z", task: "T1", slot: "implementer", attempt: 1, outcome: "verdict", verdict: "pass",
	costUsd: 0.0123, contextTokens: 4200, durationMs: 1500, sessionFile: "/tmp/s.jsonl",
};
const gate: RunLogEntry = { kind: "gate", at: "2026-11-04T05:01:00.000Z", id: "G1", cause: "spec_wrong", task: "T1", choice: "retry", note: "use v2" };

describe("fileRunLog", () => {
	test("lives under the private HOME's ~/.omp/agent/spec-runs by default", () => {
		expect(RUNS_DIR).toBe(join(os.homedir(), ".omp", "agent", "spec-runs"));
		expect(fileRunLog("PAC2-1", new Date("2026-11-04T05:00:00.123Z")).file).toBe(join(RUNS_DIR, "PAC2-1", "2026-11-04T05-00-00-123Z.jsonl"));
	});

	test("creates nothing until the first entry, then appends one JSON object per line and never rewrites", () => {
		const root = scratch("runlog-");
		const log = fileRunLog("S-1", new Date("2026-11-04T05:00:00Z"), root);
		expect(existsSync(log.file)).toBe(false);
		log.append(slot);
		log.append(gate);
		log.append({ kind: "event", at: "2026-11-04T05:02:00.000Z", event: "task-done", task: "T1" });
		const lines = readFileSync(log.file, "utf8").split("\n");
		expect(lines.at(-1)).toBe("");
		expect(lines.slice(0, -1).map(line => JSON.parse(line))).toEqual([slot, gate, { kind: "event", at: "2026-11-04T05:02:00.000Z", event: "task-done", task: "T1" }]);
		// A second logger for the same run time keeps appending to the same file.
		fileRunLog("S-1", new Date("2026-11-04T05:00:00Z"), root).append(gate);
		expect(readFileSync(log.file, "utf8").split("\n")).toHaveLength(5);
	});

	test("a story id that is not a safe folder name is sanitized, never escaping the root", () => {
		const root = scratch("runlog-");
		const log = fileRunLog("../evil/ticket 1", new Date("2026-11-04T05:00:00Z"), root);
		expect(log.file.startsWith(root)).toBe(true);
		expect(log.file).toBe(join(root, ".._evil_ticket_1", "2026-11-04T05-00-00-000Z.jsonl"));
		log.append(gate);
		expect(existsSync(log.file)).toBe(true);
		for (const dots of ["..", ".", ""]) {
			const file = fileRunLog(dots, new Date("2026-11-04T05:00:00Z"), root).file;
			expect(file).toBe(join(root, "_", "2026-11-04T05-00-00-000Z.jsonl"));
		}
	});
});
