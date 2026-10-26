// Which knowledge base serves a directory. Each source owns the folder holding its AGENTS.md;
// a source whose AGENTS.md lives in ~/.omp/agent serves every session (allowed only as the sole source).
import * as fs from "node:fs";
import * as path from "node:path";
import { HOME, readState, type KbSource, type KbState } from "./state";

export const EVERY_SESSION_DIR = path.join(HOME, ".omp", "agent");

/** Folder a source serves (the AGENTS.md folder). */
export const sourceFolder = (s: KbSource): string => path.dirname(s.contextFile);
export const servesEverySession = (s: KbSource): boolean => sourceFolder(s) === EVERY_SESSION_DIR;

export const within = (p: string, dir: string): boolean => p === dir || p.startsWith(dir + path.sep);

/** Existing path as written plus its symlink-resolved form, so either spelling matches. */
export function forms(p: string): string[] {
	try {
		const real = fs.realpathSync(p);
		return real === p ? [p] : [p, real];
	} catch {
		return [p];
	}
}

/** Whether `p` is `dir` or below it, comparing as-written and symlink-resolved forms of both. */
export const inside = (p: string, dir: string): boolean => forms(p).some(a => forms(dir).some(d => within(a, d)));

export function doneSources(kb: KbState | undefined): KbSource[] {
	return kb?.status === "done" ? (kb.sources ?? []) : [];
}

/** The source for `dir`: the deepest folder source containing it, else an every-session source. */
export function resolveKb(dir: string, kb: KbState | undefined = readState().kb): KbSource | undefined {
	const sources = doneSources(kb);
	const folderHits = sources
		.filter(s => !servesEverySession(s) && inside(dir, sourceFolder(s)))
		.sort((a, b) => sourceFolder(b).length - sourceFolder(a).length);
	return folderHits[0] ?? sources.find(servesEverySession);
}

/** Source whose vault agent-skills uses. */
export function primarySource(kb: KbState | undefined): KbSource | undefined {
	const sources = doneSources(kb);
	return sources.find(s => s.primary) ?? sources[0];
}

/** Source whose KB contains `p` (absolute), if any. */
export function sourceOwning(p: string, kb: KbState | undefined): KbSource | undefined {
	return doneSources(kb).find(s => s.kbPaths.some(root => inside(p, root)));
}

/**
 * Why `folder` can't become a new source next to `others`, or undefined when it can.
 * Folders must not nest (omp loads every enclosing AGENTS.md, so two KB roots would mix), and an
 * every-session source can't coexist with others (its AGENTS.md loads everywhere).
 */
export function overlapProblem(folder: string, others: KbSource[]): string | undefined {
	const everySession = folder === EVERY_SESSION_DIR;
	for (const o of others) {
		const of = sourceFolder(o);
		if (everySession || servesEverySession(o)) {
			return `a knowledge base for every session can't coexist with others (${o.kbRef} already serves ${servesEverySession(o) ? "every session" : of})`;
		}
		if (inside(folder, of) || inside(of, folder)) {
			return `${folder} overlaps ${of}, which ${o.kbRef} already serves; source folders must not contain each other`;
		}
	}
	return undefined;
}
