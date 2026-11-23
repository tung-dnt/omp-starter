import { beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import { resetHome } from "../test-harness";
import { STATE_FILE, readState, updateState, writeState, type SetupState } from "./state";

beforeEach(resetHome);

const legacy = (state: object) => writeState(state as SetupState);
const source = (gateDir?: string) => ({ kbPaths: ["/kb"], contextFile: "/w/AGENTS.md", ...(gateDir ? { gateDir } : {}) });

test("a legacy kb's source gate folders become one deduplicated memory.gateDirs, and the kb key is dropped", () => {
	legacy({ agentSkills: "done", kb: { status: "done", sources: [source("/w/projects"), source("/w/personal"), source("/w/projects"), source()] } });
	expect(readState()).toEqual({ agentSkills: "done", memory: { status: "done", gateDirs: ["/w/projects", "/w/personal"] } });
});

test("the single-source form of 0.13 and earlier carried its gate folder on kb itself", () => {
	legacy({ kb: { status: "done", kbPaths: ["/kb"], contextFile: "/w/AGENTS.md", gateDir: "/w/projects" } });
	expect(readState().memory).toEqual({ status: "done", gateDirs: ["/w/projects"] });
});

test("migration never overrides a memory state, and a skipped kb brings no gate", () => {
	legacy({ memory: { status: "done", backend: "mnemopi" }, kb: { status: "done", sources: [source("/w/projects")] } });
	expect(readState()).toEqual({ memory: { status: "done", backend: "mnemopi" } });

	legacy({ kb: { status: "skipped", sources: [source("/w/projects")] } });
	expect(readState()).toEqual({});
});

test("the next write removes the legacy kb key from disk", () => {
	legacy({ kb: { status: "done", sources: [source("/w/projects")] } });
	updateState({ models: "done" });
	const onDisk = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
	expect(onDisk).toEqual({ models: "done", memory: { status: "done", gateDirs: ["/w/projects"] } });
});
