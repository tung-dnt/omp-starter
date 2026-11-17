import { describe, expect, test } from "bun:test";
import { changedExports, exportedDecls, formatBlastRadius, langOf, MAX_CHARS, referenceSites, type BlastItem, type ExportChange } from "./blast-radius";

const names = (changes: ExportChange[]) => changes.map(c => `${c.kind}:${c.name}`);

describe("changedExports, TypeScript", () => {
	const base = `import { db } from "./db";

export async function getPatient(id: string): Promise<Patient> {
	return db.find(id);
}

export const formatName = (first: string, last: string): string => \`\${first} \${last}\`;

export interface Patient {
	id: string;
	nhsNumber: string;
}

function local(a: number) {
	return a;
}
`;

	test("a body-only edit changes nothing", () => {
		const after = base.replace("return db.find(id);", "const row = await db.find(id);\n\treturn row;");
		expect(changedExports(base, after, "ts")).toEqual([]);
	});

	test("a reformat of a signature changes nothing", () => {
		const after = base.replace(
			"export async function getPatient(id: string): Promise<Patient> {",
			"export async function getPatient(\n\tid: string,\n): Promise<Patient> {",
		);
		expect(changedExports(base, after, "ts")).toEqual([]);
	});

	test("a new parameter is a change, with the name's position in the new text", () => {
		const after = base.replace("getPatient(id: string)", "getPatient(id: string, trust: string)");
		expect(changedExports(base, after, "ts")).toEqual([{ kind: "changed", name: "getPatient", at: { line: 2, character: 22 } }]);
	});

	test("an edit on the second line of a multi-line signature is a change", () => {
		const multi = base.replace("getPatient(id: string)", "getPatient(\n\tid: string,\n\topts: Options,\n)");
		const after = multi.replace("opts: Options", "opts?: Options");
		expect(names(changedExports(multi, after, "ts"))).toEqual(["changed:getPatient"]);
	});

	test("an arrow-function const counts its parameters, not its body", () => {
		const params = base.replace("(first: string, last: string)", "(first: string, last?: string)");
		expect(names(changedExports(base, params, "ts"))).toEqual(["changed:formatName"]);
		const body = base.replace("`${first} ${last}`", "`${last}, ${first}`");
		expect(changedExports(base, body, "ts")).toEqual([]);
	});

	test("a field added to an exported interface is a change", () => {
		const after = base.replace("nhsNumber: string;", "nhsNumber: string;\n\ttrustId?: string;");
		expect(names(changedExports(base, after, "ts"))).toEqual(["changed:Patient"]);
	});

	test("removed and renamed exports are reported under the old name; new exports and local functions are not", () => {
		const after = base
			.replace("export const formatName", "export const formatFullName")
			.replace("function local(a: number)", "function local(a: string)")
			.concat("\nexport function added(): void {}\n");
		expect(names(changedExports(base, after, "ts"))).toEqual(["removed:formatName"]);
	});

	test("export lists track aliases and sources", () => {
		const before = `export { a, b as beta } from "./x";\n`;
		expect([...exportedDecls(before, "ts").keys()]).toEqual(["a", "beta"]);
		expect(names(changedExports(before, `export { a } from "./x";\n`, "ts"))).toEqual(["removed:beta"]);
		expect(names(changedExports(before, `export { a, b as beta } from "./y";\n`, "ts"))).toEqual(["changed:a", "changed:beta"]);
	});

	test("braces inside strings, comments and generic types do not end a header", () => {
		const before = `export function f(a: Promise<{ x: string }>, s = "{"): void /* { */ {\n\treturn;\n}\n`;
		const after = before.replace("x: string", "x: number");
		expect(names(changedExports(before, after, "ts"))).toEqual(["changed:f"]);
	});
});

describe("changedExports, Go", () => {
	const base = `package svc

type Patient struct {
	ID        string
	NHSNumber string
}

const (
	MaxRetries = 4
	minDelay   = 1
)

func (s *Service) Get(ctx context.Context, id string) (*Patient, error) {
	return s.repo.Get(ctx, id)
}

func helper(a int) int { return a }
`;

	test("methods are keyed by receiver and a body-only edit changes nothing", () => {
		expect([...exportedDecls(base, "go").keys()].sort()).toEqual(["MaxRetries", "Patient", "Service.Get"]);
		expect(changedExports(base, base.replace("return s.repo.Get(ctx, id)", "return nil, nil"), "go")).toEqual([]);
	});

	test("a changed method signature, struct field and removed constant are reported; unexported ones are not", () => {
		const after = base
			.replace("id string) (*Patient", "id string, trust string) (*Patient")
			.replace("NHSNumber string", "NHSNumber string\n\tTrust     string")
			.replace("\tMaxRetries = 4\n", "")
			.replace("helper(a int)", "helper(a string)");
		expect(names(changedExports(base, after, "go"))).toEqual(["changed:Patient", "changed:Service.Get", "removed:MaxRetries"]);
	});
});

test("langOf covers TS/JS module extensions and Go only", () => {
	expect(["a.ts", "a.tsx", "a.mts", "a.cjs", "a.jsx", "a.go", "a.rs", "a.d.ts", "a.json"].map(langOf)).toEqual([
		"ts",
		"ts",
		"ts",
		"ts",
		"ts",
		"go",
		undefined,
		"ts",
		undefined,
	]);
});

test("referenceSites drops the edited file and duplicates, and makes paths relative", () => {
	const loc = (file: string, line: number) => ({ uri: `file://${file}`, range: { start: { line } } });
	const sites = referenceSites(
		[loc("/r/src/b.ts", 9), loc("/r/src/a.ts", 1), loc("/r/src/b.ts", 2), loc("/r/src/b.ts", 9), loc("/other/c.ts", 0)],
		"/r/src/a.ts",
		"/r",
		uri => uri.slice("file://".length),
	);
	expect(sites).toEqual([
		{ file: "/other/c.ts", line: 1 },
		{ file: "src/b.ts", line: 3 },
		{ file: "src/b.ts", line: 10 },
	]);
});

describe("formatBlastRadius", () => {
	const sites = (n: number) => Array.from({ length: n }, (_, i) => ({ file: `src/f${i % 3}.ts`, line: i + 1 }));

	test("lists up to 8 sites per symbol and counts the rest", () => {
		const text = formatBlastRadius([{ change: { kind: "changed", name: "getPatient" }, sites: sites(10), source: "lsp" }]);
		expect(text).toContain("- getPatient: signature changed; 10 refs in 3 files: src/f0.ts:1, src/f1.ts:2,");
		expect(text).toContain("src/f1.ts:8 (+2)");
	});

	test("labels text matches and skips symbols without uses", () => {
		const text = formatBlastRadius([
			{ change: { kind: "changed", name: "unused" }, sites: [], source: "lsp" },
			{ change: { kind: "removed", name: "formatName" }, sites: [{ file: "src/ui/Card.tsx" }], source: "text" },
		]);
		expect(text).toBe(
			[
				"Blast radius (exported symbols changed by this edit; other files only):",
				"- formatName: removed; text matches in 1 file: src/ui/Card.tsx",
				"Update or check these before finishing.",
			].join("\n"),
		);
		expect(formatBlastRadius([{ change: { kind: "changed", name: "unused" }, sites: [], source: "lsp" }])).toBeUndefined();
	});

	test("never exceeds the size cap", () => {
		const long = (name: string): BlastItem => ({
			change: { kind: "changed", name },
			sites: Array.from({ length: 8 }, (_, i) => ({ file: `packages/some/deeply/nested/module/file${i}.ts`, line: 1000 + i })),
			source: "lsp",
		});
		const text = formatBlastRadius([long("a"), long("b"), long("c"), long("d"), long("e"), long("f")])!;
		expect(text.length).toBeLessThanOrEqual(MAX_CHARS);
		expect(text).toMatch(/\(\+\d more symbols?\)/);
	});
});
