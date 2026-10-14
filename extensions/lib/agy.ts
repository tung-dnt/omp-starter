// Google's Antigravity CLI (`agy`) in headless mode: the only way to use a Google AI Pro/Ultra
// subscription from omp within Google's terms (third-party use of Gemini CLI / Antigravity OAuth
// tokens can get the account suspended). Each call is one stateless `agy -p` run from an empty
// scratch dir with --sandbox, so text being translated cannot reach the user's repos.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { HOME } from "./state";

export const AGY = process.env.OMP_STARTER_AGY ?? path.join(HOME, ".local", "bin", "agy");
/** Fastest model measured on AI Pro (~7s per call, mostly CLI startup). */
export const DEFAULT_AGY_MODEL = "gemini-3.8-flash-low";
const INSTALL_SCRIPT = "https://antigravity.google/cli/install.sh";
const WORKDIR = path.join(os.tmpdir(), "omp-starter-agy");
const HEDGE_AFTER_MS = 9_000;

/** agy's `--output-format json` envelope (antigravity.google/docs/cli/headless). */
interface AgyEnvelope {
	status?: string;
	response?: string;
	error?: string;
}

function agyArgs(prompt: string, model: string, timeoutMs: number): string[] {
	const args = [AGY, "-p", prompt, "--output-format", "json", "--sandbox", "--disable-slash-commands"];
	args.push("--print-timeout", `${Math.ceil(timeoutMs / 1000)}s`);
	if (model) args.push("--model", model);
	return args;
}

function parseEnvelope(stdout: string): AgyEnvelope | undefined {
	try {
		const value: unknown = JSON.parse(stdout);
		return typeof value === "object" && value !== null && "status" in value ? (value as AgyEnvelope) : undefined;
	} catch {
		return undefined;
	}
}

/**
 * `agy -p` with a hedge: agy usually answers in 5–12s but some runs hang well past --print-timeout,
 * so a second run starts after HEDGE_AFTER_MS and the first success wins. The deadline is enforced
 * here rather than by agy, and every spawned run is killed when the call settles.
 */
async function runAgy(prompt: string, model: string, timeoutMs: number): Promise<AgyEnvelope | undefined> {
	fs.mkdirSync(WORKDIR, { recursive: true });
	const procs: Bun.Subprocess<"ignore", "pipe", "ignore">[] = [];
	const timers: Timer[] = [];
	try {
		return await new Promise<AgyEnvelope | undefined>(resolve => {
			let pending = 0;
			const attempt = () => {
				const proc = Bun.spawn(agyArgs(prompt, model, timeoutMs), { cwd: WORKDIR, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
				procs.push(proc);
				pending++;
				void new Response(proc.stdout).text().then(stdout => {
					const envelope = parseEnvelope(stdout);
					if (envelope?.status === "SUCCESS") resolve(envelope);
					else if (--pending === 0 && procs.length === 2) resolve(undefined);
				});
			};
			attempt();
			if (timeoutMs > HEDGE_AFTER_MS) timers.push(setTimeout(attempt, HEDGE_AFTER_MS));
			timers.push(setTimeout(resolve, timeoutMs, undefined));
		});
	} finally {
		for (const timer of timers) clearTimeout(timer);
		for (const proc of procs) proc.kill("SIGKILL");
	}
}

export async function translateText(instruction: string, text: string, model: string, timeoutMs: number): Promise<string | undefined> {
	const out = (await runAgy(`${instruction}\n\n<text>\n${text}\n</text>`, model, timeoutMs))?.response?.trim();
	return out ? out.replace(/^<text>\s*|\s*<\/text>$/g, "") : undefined;
}

/** Translates independent strings in one call; undefined unless every item came back. */
export async function translateList(
	instruction: string,
	items: string[],
	model: string,
	timeoutMs: number,
): Promise<string[] | undefined> {
	const prompt = `${instruction}\nThe input is a JSON array of ${items.length} independent strings. Output only a JSON array of exactly ${items.length} translated strings in the same order: no prose, no code fence.\n\n${JSON.stringify(items)}`;
	const response = (await runAgy(prompt, model, timeoutMs))?.response?.trim();
	if (!response) return undefined;
	let t: unknown;
	try {
		t = JSON.parse(response.replace(/^```(?:json)?\s*|\s*```$/g, ""));
	} catch {
		return undefined;
	}
	if (!Array.isArray(t) || t.length !== items.length) return undefined;
	return t.every((s): s is string => typeof s === "string" && s.trim() !== "") ? t : undefined;
}

// ── Setup: install + login ──────────────────────────────────────────────────

export interface AgyLoginUi {
	notify(message: string, type?: "info" | "warning" | "error"): void;
	input(title: string, placeholder?: string): Promise<string | undefined>;
}

/** Runs Google's official installer (installs to ~/.local/bin/agy and adds it to the shell PATH). */
export async function installAgy(): Promise<void> {
	const proc = Bun.spawn(["bash", "-c", `curl -fsSL ${INSTALL_SCRIPT} | bash`], { stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
	if (code !== 0 || !fs.existsSync(AGY)) throw new Error(`agy install failed: ${(stderr || stdout).trim().slice(-400)}`);
}

/** Resolves with the first Google sign-in URL agy prints, or undefined once the stream ends. */
async function findLoginUrl(stream: ReadableStream<Uint8Array>): Promise<string | undefined> {
	const decoder = new TextDecoder();
	let text = "";
	for await (const chunk of stream) {
		text += decoder.decode(chunk, { stream: true });
		const match = /https:\/\/accounts\.google\.com\/\S+/.exec(text);
		if (match && /\s/.test(text.slice(match.index + match[0].length))) return match[0];
	}
	return undefined;
}

export type AgyLoginResult = { ok: true; model: string } | { ok: false; error: string };

/**
 * Signs agy in (when needed) and proves it can answer with `model`, falling back to agy's default
 * model when the account lacks it. agy prints a Google URL and waits ~60s for the code the browser
 * page shows; the code is read from stdin.
 */
export async function loginAgy(ui: AgyLoginUi, model = DEFAULT_AGY_MODEL): Promise<AgyLoginResult> {
	fs.mkdirSync(WORKDIR, { recursive: true });
	const proc = Bun.spawn(agyArgs("Reply with the single word: ok", model, 120_000), {
		cwd: WORKDIR,
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdoutText = new Response(proc.stdout).text();
	const url = await findLoginUrl(proc.stderr);
	if (url) {
		Bun.spawn(["open", url], { stdout: "ignore", stderr: "ignore" });
		ui.notify("Opened Google sign-in for Antigravity CLI in your browser.", "info");
		const code = (await ui.input("Paste the code shown after Google sign-in (within 60s)", "4/0A…"))?.trim();
		if (code) proc.stdin.write(`${code}\n`);
		else proc.kill();
	}
	proc.stdin.end();
	const [stdout] = await Promise.all([stdoutText, proc.exited]);
	const envelope = parseEnvelope(stdout);
	if (envelope?.status === "SUCCESS") return { ok: true, model };
	const error = envelope?.error ?? "agy sign-in was cancelled or failed";
	// Signed in, but this account has no such model: use agy's own default instead.
	if (model && /not recognized/.test(error)) return loginAgy(ui, "");
	return { ok: false, error };
}
