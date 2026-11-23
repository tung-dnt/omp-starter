import type * as Fs from "node:fs";
import type * as Os from "node:os";
import type * as Path from "node:path";

// Preloaded by bunfig.toml before any test file. `bun test` runs every file in one process with one
// module registry, and lib/state.ts caches `os.homedir()` the first time anything imports it, so
// the private home has to exist before the first import, not inside individual tests.
// Bun's os.homedir() ignores later changes to process.env.HOME, so it is replaced as well.
// Built-ins are loaded with require() on purpose: an ESM `import * as os` here would create the
// module namespace before the override and lib/state.ts would then see the stale function.
const fs = require("node:fs") as typeof Fs;
const os = require("node:os") as typeof Os;
const path = require("node:path") as typeof Path;

const PREFIX = "omp-starter-test-home-";

// `bun test` ends without running exit handlers, so a finished run cannot remove its own home.
// Homes are named after the process that made them; remove the ones whose process is gone.
for (const name of fs.readdirSync(os.tmpdir())) {
	const pid = Number(new RegExp(`^${PREFIX}(\\d+)-`).exec(name)?.[1]);
	if (!pid) continue;
	try {
		process.kill(pid, 0);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") fs.rmSync(path.join(os.tmpdir(), name), { recursive: true, force: true });
	}
}

const realHome = os.homedir();
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `${PREFIX}${process.pid}-`)));

os.homedir = () => home;

process.env.HOME = home;
process.env.XDG_CONFIG_HOME = path.join(home, ".config");
process.env.XDG_DATA_HOME = path.join(home, ".local", "share");
process.env.XDG_CACHE_HOME = path.join(home, ".cache");
process.env.XDG_STATE_HOME = path.join(home, ".local", "state");
process.env.OMP_STARTER_TEST_HOME = home;

// lib/state.ts reads the home through the module namespace; if that still answers with the real
// home the override did not take, and tests must stop instead of running against it.
// Dynamic on purpose: a static import would be hoisted above the override.
const seen = (await import("node:os")).homedir();
if (seen !== home || home === realHome) {
	throw new Error(`test-preload: could not replace os.homedir() (still ${seen}); refusing to run tests against the real home`);
}

export {};
