// After an edit/write changes an exported symbol's signature, appends where else that symbol is used.
// References come from the language server the host already runs (the same client as the `lsp` tool); a removed
// symbol can no longer be asked about, so its uses come from a word search and are labelled as text matches.
// Never blocks or alters the edit: any failure or the 6 s budget running out appends nothing.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ExtensionAPI, ToolResultEvent } from "@oh-my-pi/pi-coding-agent";
import type { EditToolDetails } from "@oh-my-pi/pi-coding-agent/edit";
import { getOrCreateClient, reconcileFileFromDisk, sendRequest, waitForProjectLoaded } from "@oh-my-pi/pi-coding-agent/lsp/client";
import { getConfig } from "@oh-my-pi/pi-coding-agent/lsp/config";
import { getLspServerForFile } from "@oh-my-pi/pi-coding-agent/lsp/servers";
import {
	changedExports,
	formatBlastRadius,
	langOf,
	MAX_SYMBOLS,
	referenceSites,
	relative,
	type BlastItem,
	type ExportChange,
	type Lang,
	type Location,
	type RefSite,
} from "./lib/blast-radius";

/** Whole-handler budget (decision D2: large repos such as the PACO monorepo need a cold server's first answer). */
export const BUDGET_MS = 6_000;
/** Larger files are skipped rather than parsed on every edit. */
const MAX_SNAPSHOT_BYTES = 512 * 1024;

const SOURCE_PATHSPECS: Record<Lang, string[]> = {
	ts: ["*.ts", "*.tsx", "*.mts", "*.cts", "*.js", "*.jsx", "*.mjs", "*.cjs"],
	go: ["*.go"],
};

interface FileChange {
	file: string;
	lang: Lang;
	oldText: string;
	newText: string;
}

function readSnapshot(file: string): string | undefined {
	try {
		return fs.statSync(file).size <= MAX_SNAPSHOT_BYTES ? fs.readFileSync(file, "utf8") : undefined;
	} catch {
		return undefined;
	}
}

/** Absolute path of a tool's file argument; internal URLs (`local://`, `xd://`) are not source files. */
function sourceFile(raw: unknown, cwd: string): string | undefined {
	if (typeof raw !== "string" || raw === "" || /^[a-z][\w+.-]*:\/\//i.test(raw)) return undefined;
	return path.resolve(cwd, raw);
}

/** Files whose before/after text this result carries, limited to languages the hook understands. */
function fileChanges(event: ToolResultEvent, cwd: string, writeSnapshots: Map<string, string | undefined>): FileChange[] {
	const found: FileChange[] = [];
	const push = (raw: unknown, oldText: string | undefined, newText: string | undefined) => {
		const file = sourceFile(raw, cwd);
		const lang = file ? langOf(file) : undefined;
		if (file && lang && oldText !== undefined && newText !== undefined && oldText !== newText) found.push({ file, lang, oldText, newText });
	};
	if (event.toolName === "edit") {
		// The union's custom-tool member keeps `details` from narrowing on the tool name.
		const details = event.details as EditToolDetails | undefined;
		if (!details) return found;
		for (const entry of details.perFileResults?.length ? details.perFileResults : [details]) {
			if (!("isError" in entry && entry.isError) && !entry.snapshotsPruned) push(entry.path, entry.oldText, entry.newText);
		}
	} else if (event.toolName === "write") {
		const file = sourceFile(event.input.path, cwd);
		if (file) push(file, writeSnapshots.get(event.toolCallId), readSnapshot(file));
	}
	return found;
}

async function lspSites(file: string, at: NonNullable<ExportChange["at"]>, cwd: string, signal: AbortSignal): Promise<RefSite[]> {
	const server = getLspServerForFile(getConfig(cwd), file);
	if (!server) return [];
	const client = await getOrCreateClient(server[1], cwd, undefined, signal);
	await reconcileFileFromDisk(client, file, signal);
	const params = { textDocument: { uri: pathToFileURL(file).href }, position: at, context: { includeDeclaration: false } };
	let locations = (await sendRequest(client, "textDocument/references", params, signal)) as Location[] | null;
	if (!locations?.length) {
		// An empty answer from a server still indexing means "unknown", not "no callers": wait once within budget.
		await waitForProjectLoaded(client, signal);
		locations = (await sendRequest(client, "textDocument/references", params, signal)) as Location[] | null;
	}
	return referenceSites(locations ?? [], file, cwd, uri => uri.startsWith("file://") ? fileURLToPath(uri.replaceAll("#", "%23").replaceAll("?", "%3F")) : uri);
}

/**
 * Tracked files under `cwd` naming a removed symbol (a Go method by `.Name`), excluding the edited file.
 * `git grep`, not `rg`: git is always there in a repo, rg often is not on PATH, and tracked files leave out node_modules.
 */
async function textSites(pi: ExtensionAPI, change: FileChange, name: string, cwd: string, signal: AbortSignal): Promise<RefSite[]> {
	const method = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : undefined;
	const match = method ? ["-E", "-e", `\\.${method}([^A-Za-z0-9_]|$)`] : ["-w", "-F", "-e", name];
	const args = ["grep", "-l", "-I", ...match, "--", ...SOURCE_PATHSPECS[change.lang]];
	const result = await pi.exec("git", args, { cwd, signal });
	if (result.code !== 0) return [];
	return result.stdout
		.split("\n")
		.filter(Boolean)
		.map(line => path.resolve(cwd, line))
		.filter(file => file !== change.file)
		.map(file => ({ file: relative(file, cwd) }))
		.sort((a, b) => a.file.localeCompare(b.file));
}

export default function blastRadius(pi: ExtensionAPI): void {
	// A write's result carries no old text, so the file is read before the write runs.
	const writeSnapshots = new Map<string, string | undefined>();

	pi.on("tool_call", (event, ctx) => {
		if (event.toolName !== "write") return;
		const file = sourceFile(event.input.path, ctx.cwd);
		if (file && langOf(file)) writeSnapshots.set(event.toolCallId, readSnapshot(file));
	});

	pi.on("tool_result", async (event, ctx) => {
		const changes = event.isError ? [] : fileChanges(event, ctx.cwd, writeSnapshots);
		writeSnapshots.delete(event.toolCallId);
		if (changes.length === 0) return;

		const signal = AbortSignal.timeout(BUDGET_MS);
		const items: BlastItem[] = [];
		const looked = { changed: 0, removed: 0 };
		for (const change of changes) {
			for (const exported of changedExports(change.oldText, change.newText, change.lang)) {
				if (looked[exported.kind] >= MAX_SYMBOLS) continue;
				looked[exported.kind]++;
				try {
					const sites =
						exported.kind === "changed" && exported.at
							? await lspSites(change.file, exported.at, ctx.cwd, signal)
							: await textSites(pi, change, exported.name, ctx.cwd, signal);
					items.push({ change: exported, sites, source: exported.kind === "changed" ? "lsp" : "text" });
				} catch {
					// No server, server error or budget spent: this symbol adds nothing.
				}
			}
		}
		const text = formatBlastRadius(items);
		if (text) return { content: [...event.content, { type: "text", text }] };
	});
}
