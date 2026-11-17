import { beforeEach, expect, test } from "bun:test";
import * as path from "node:path";
import crossRepoReads from "./cross-repo-reads";
import { fakeContext, fakePi, initGitRepo, privateHome, resetHome } from "./test-harness";

beforeEach(resetHome);

function session() {
	const home = privateHome();
	const projects = path.join(home, "projects");
	for (const repo of ["api", "web"]) initGitRepo(path.join(projects, repo));
	const fake = fakePi();
	crossRepoReads(fake.pi);
	const main = fakeContext({ cwd: projects, agent: { kind: "main", name: "main" } });
	const call = (toolName: string, input: object, ctx = main) =>
		fake.emit("tool_result", { toolName, input, isError: false }, ctx) as { additionalContext: string } | undefined;
	return { projects, call };
}

test("one repo read and searched every way stays quiet", () => {
	const { projects, call } = session();
	expect(call("read", { path: "api/src/a.ts:10-20" })).toBeUndefined();
	expect(call("bash", { command: "cd api && rg -n handler src" })).toBeUndefined();
	expect(call("bash", { command: `cat ${projects}/api/src/b.go` })).toBeUndefined();
});

test("source from a second repo reminds once; reading that repo again does not", () => {
	const { projects, call } = session();
	call("read", { path: `${projects}/api/src/a.ts` });
	const notice = call("bash", { command: `rg -n handler ${projects}/web/src` });
	expect(notice?.additionalContext).toContain("2 repositories (api, web)");
	expect(call("read", { path: `${projects}/web/src/c.tsx` })).toBeUndefined();
});

test("docs, dependencies and subagent reads never count", () => {
	const { projects, call } = session();
	call("read", { path: `${projects}/api/src/a.ts` });
	expect(call("read", { path: `${projects}/web/README.md` })).toBeUndefined();
	expect(call("read", { path: `${projects}/web/node_modules/x/index.js` })).toBeUndefined();
	const scout = fakeContext({ cwd: projects, agent: { kind: "sub", name: "scout" } });
	expect(call("read", { path: `${projects}/web/src/c.ts` }, scout)).toBeUndefined();
});
