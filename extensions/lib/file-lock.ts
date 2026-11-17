// A lock file that serializes a read-modify-write across omp sessions on this machine.
import * as fs from "node:fs";

const WAIT_MS = 5_000;
/** A lock older than this is from a crashed holder and is taken over. */
const STALE_MS = 30_000;

/** Runs `fn` while holding `lock` (created exclusively, removed after); throws `busy` when another holder keeps it past WAIT_MS. */
export async function withFileLock<T>(lock: string, busy: string, fn: () => T): Promise<T> {
	const deadline = Date.now() + WAIT_MS;
	for (;;) {
		try {
			fs.writeFileSync(lock, String(process.pid), { flag: "wx" });
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const mtime = fs.statSync(lock, { throwIfNoEntry: false })?.mtimeMs;
			if (mtime === undefined || Date.now() - mtime > STALE_MS) {
				fs.rmSync(lock, { force: true });
				continue;
			}
			if (Date.now() > deadline) throw new Error(busy);
			await Bun.sleep(50);
		}
	}
	try {
		return fn();
	} finally {
		fs.rmSync(lock, { force: true });
	}
}
