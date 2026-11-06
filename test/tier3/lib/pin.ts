// The pin (plan D.1): sha256 of requirements.yml must equal the committed vault line. Pure apart from git reads.
import { createHash } from "node:crypto";
import * as fs from "node:fs";

export function sha256File(file: string): string {
	return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/** The hash on the first token of the pin file, read from HEAD of the vault repo (not the working tree). */
export function committedPin(vaultGitDir: string, relPath: string): { hash?: string; error?: string } {
	const r = Bun.spawnSync(["git", "--git-dir", vaultGitDir, "show", `HEAD:${relPath}`], { stderr: "pipe", stdout: "pipe" });
	if (r.exitCode !== 0) return { error: r.stderr.toString().trim() || "no committed pin" };
	const hash = r.stdout.toString().trim().split(/\s+/)[0];
	return hash ? { hash } : { error: "pin file is empty" };
}
