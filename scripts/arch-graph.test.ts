// Runs the real dependency-cruiser on a small monorepo; the first run needs the network to install it.
import { beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { initGitRepo, writeFiles } from "../extensions/test-harness";
import { collectEdges, diffEdges, renderFiles, type Service, structureViolations } from "./arch-graph";

const SCRIPT = path.join(import.meta.dir, "arch-graph.ts");
const repo = fs.mkdtempSync(path.join(os.tmpdir(), "arch-graph-test-"));
const map = path.join(repo, "..", `${path.basename(repo)}-system-map.md`);

const SERVICES: Service[] = [
	{ name: "api", path: "services/api", calls: [], ownsTables: ["orders"] },
	{ name: "worker", path: "services/worker", calls: [], ownsTables: [] },
];

const EDGES = [
	"code:api:src/handlers -> src/db",
	"cross:api -> worker",
	"infra:api:api:POST /orders -> fn:create",
	"infra:api:queue:OrdersQueue -> fn:create",
	"table-write:api -> orders",
	"table-write:api -> payments",
];

beforeAll(() => {
	initGitRepo(repo, "git@github.com:acme/shop.git");
	writeFiles(repo, {
		"services/api/src/handlers/create.ts": [
			'import { client } from "../db/client";',
			'import { run } from "../../../worker/src/jobs/run";',
			'import { helper } from "../utils/helper";',
			'import { readFileSync } from "node:fs";',
			"export const create = (db: Db) => {",
			"\tdb.insertInto('orders').values({}).execute();",
			"\tdb.insertInto('payments').values({}).execute();",
			"\treturn [client, run, helper, readFileSync];",
			"};",
			"",
		].join("\n"),
		"services/api/src/db/client.ts": "export const client = 1;\n",
		"services/api/src/utils/helper.ts": "export const helper = 1;\n",
		"services/api/src/handlers/create.test.ts": 'import { client } from "../db/client";\nimport { x } from "../../../worker/src/jobs/other";\nexport const t = [client, x];\n',
		"services/worker/src/jobs/run.ts": "export const run = 1;\n",
		"services/worker/src/jobs/other.ts": "export const x = 1;\n",
		"services/api/serverless.yml": [
			"service: api",
			"functions:",
			"  create:",
			"    handler: src/handlers/create.create",
			"    events:",
			"      - sqs: !GetAtt OrdersQueue.Arn",
			"      - http: POST orders",
			"",
		].join("\n"),
	});
	fs.writeFileSync(
		map,
		[
			"# map",
			"```yaml",
			"services:",
			"  - { name: api, repo: shop, path: services/api, owns_tables: [orders], calls: [] }",
			"  - { name: worker, repo: shop, path: services/worker }",
			"  - { name: elsewhere, repo: other-repo, path: x }",
			"```",
			"",
		].join("\n"),
	);
	execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-qm", "init"], { cwd: repo });
});

function cli(...args: string[]): { code: number; out: string; err: string } {
	const run = Bun.spawnSync(["bun", SCRIPT, ...args], { cwd: repo });
	return { code: run.exitCode, out: run.stdout.toString(), err: run.stderr.toString() };
}

describe("collectEdges", () => {
	test("finds code, cross-service, infra and table-write edges, skipping tests, builtins and generic folders", async () => {
		expect(await collectEdges(repo, SERVICES)).toEqual(EDGES);
	}, 120_000);
});

describe("structureViolations", () => {
	test("names an undeclared cross-service call and a write to a table the service does not own", () => {
		expect(structureViolations(EDGES, SERVICES)).toEqual(["cross-service edge api -> worker not in the project note", "api writes table payments it does not own"]);
		expect(structureViolations(EDGES, [{ ...SERVICES[0], calls: ["worker"], ownsTables: ["Orders", "Payments"] }, SERVICES[1]])).toEqual([]);
	});
});

describe("renderFiles", () => {
	test("one diagram per service, one for infra, and the edge list", () => {
		const files = renderFiles(EDGES, SERVICES);
		expect(Object.keys(files).sort()).toEqual(["api.mmd", "edges.json", "infra.mmd", "services.json", "worker.mmd"]);
		expect(files["api.mmd"]).toBe(
			'flowchart LR\n  api["api"] --> orders["orders"]\n  api["api"] --> payments["payments"]\n  api["api"] --> worker["worker"]\n  src_handlers["src/handlers"] --> src_db["src/db"]\n',
		);
		expect(files["worker.mmd"]).toBe("flowchart LR\n");
		expect(JSON.parse(files["edges.json"])).toEqual(EDGES);
	});
});

describe("the command line", () => {
	test("generate writes docs/arch from the project note, check passes right after and fails after a new import, diff shows the new edge", () => {
		const generated = cli("generate", repo, "--map", map);
		expect(generated.err).toBe("");
		expect(generated.code).toBe(0);
		expect(JSON.parse(fs.readFileSync(path.join(repo, "docs/arch/services.json"), "utf8")).map((s: Service) => s.name)).toEqual(["api", "worker"]);
		expect(JSON.parse(fs.readFileSync(path.join(repo, "docs/arch/edges.json"), "utf8"))).toEqual(EDGES);
		expect(cli("check", repo)).toMatchObject({ code: 0, out: "" });

		execFileSync("git", ["add", "-A"], { cwd: repo });
		execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "graph"], { cwd: repo });
		writeFiles(repo, { "services/api/src/billing/charge.ts": 'import { client } from "../db/client";\nexport const charge = client;\n' });
		const stale = cli("check", repo);
		expect(stale.code).toBe(1);
		expect(stale.out).toContain("stale: docs/arch/edges.json");
		expect(stale.out).toContain("stale: docs/arch/api.mmd");

		expect(cli("generate", repo, "--map", map).code).toBe(0);
		expect(cli("diff", repo, "--base", "HEAD")).toMatchObject({ code: 1, out: "+ code:api:src/billing -> src/db\n" });
		expect(diffEdges(repo, "HEAD")).toEqual(["+ code:api:src/billing -> src/db"]);
	}, 120_000);

	test("usage and tool errors exit 2 with a message on stderr", () => {
		expect(cli("generate", repo)).toMatchObject({ code: 2, err: "arch-graph: --map is required for generate\n" });
		const lonely = fs.mkdtempSync(path.join(os.tmpdir(), "arch-graph-lonely-"));
		initGitRepo(lonely, "git@github.com:acme/lonely.git");
		expect(Bun.spawnSync(["bun", SCRIPT, "generate", lonely, "--map", map]).stderr.toString()).toBe(`arch-graph: ${map} lists no service for repo lonely\n`);
		expect(cli("frobnicate", repo).code).toBe(2);
	});
});
