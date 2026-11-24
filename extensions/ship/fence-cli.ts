// Checks one gh or git process for bin/ship-fence/shim while the fence is armed: `fence-cli.ts gh|git ARGS...`.
// Exit 0 lets the shim run the real program; exit 1 prints the reason on stderr.
import { checkGh, checkGit, gitWorkDir, pushSources, refused } from "./fence";
import { checkPushContent, FENCE_ENV, readState } from "./fence-state";

const [program, ...args] = process.argv.slice(2);
const file = process.env[FENCE_ENV];

function why(): string | null {
	// The shims are on PATH only in sessions with a state file, so a missing name means someone unset it.
	if (!file) return refused(`${FENCE_ENV} was removed from this command's environment`);
	const state = readState(file);
	if (!state.armed) return null;
	if (program === "gh") return checkGh(args);
	if (program !== "git") return refused(`no check for ${program}`);
	const argvWhy = checkGit(args, state, process.cwd());
	if (argvWhy !== null) return argvWhy;
	const sub = args.findIndex((a, i) => !a.startsWith("-") && !["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env"].includes(args[i - 1] ?? ""));
	if (args[sub] !== "push") return null;
	return checkPushContent(gitWorkDir(args, process.cwd()), pushSources(args.slice(sub + 1)), state);
}

const reason = why();
if (reason !== null) {
	console.error(reason);
	process.exit(1);
}
