// Reads Bun's JUnit reporter output (`bun test --reporter=junit`). Pure.
// Bun nests <testsuite> per describe() and puts `assertions` on every <testcase>.
export interface TestCase {
	name: string;
	/** Describe titles around the test, outermost first (the file-level suite is dropped). */
	ancestors: string[];
	file: string;
	skipped: boolean;
	failed: boolean;
	assertions: number;
}

const attrs = (s: string): Record<string, string> =>
	Object.fromEntries(
		[...s.matchAll(/([\w:-]+)="([^"]*)"/g)].map(m => [
			m[1],
			m[2]
				.replace(/&lt;/g, "<")
				.replace(/&gt;/g, ">")
				.replace(/&quot;/g, '"')
				.replace(/&apos;/g, "'")
				.replace(/&#10;/g, "\n")
				.replace(/&amp;/g, "&"),
		]),
	);

export function parseJUnit(xml: string): TestCase[] {
	const cases: TestCase[] = [];
	const suites: { name: string; file: string }[] = [];
	const re = /<testsuite\b([^>]*?)(\/?)>|<\/testsuite>|<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
	for (const m of xml.matchAll(re)) {
		const tag = m[0];
		if (tag.startsWith("</testsuite")) suites.pop();
		else if (tag.startsWith("<testsuite")) {
			if (m[2] !== "/") {
				const a = attrs(m[1] ?? "");
				suites.push({ name: a.name ?? "", file: a.file ?? "" });
			}
		} else {
			const a = attrs(m[3] ?? "");
			const body = m[5] ?? "";
			cases.push({
				name: a.name ?? "",
				ancestors: suites.filter(s => s.name !== s.file).map(s => s.name),
				file: a.file ?? suites.at(-1)?.file ?? "",
				skipped: /<skipped\b/.test(body),
				failed: /<(failure|error)\b/.test(body),
				assertions: Number(a.assertions ?? 0),
			});
		}
	}
	return cases;
}
