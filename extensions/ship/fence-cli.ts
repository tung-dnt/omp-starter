// Checks one gh, git or git-lfs process for bin/ship-fence/shim while the fence is armed: `fence-cli.ts gh|git|git-lfs ARGS...`.
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
	if (program !== "git" && program !== "git-lfs") return refused(`no check for ${program}`);
	// `git-lfs install` is `git lfs install` by another name, so one rule judges both.
	const gitArgs = program === "git-lfs" ? ["lfs", ...args] : args;
	const argvWhy = checkGit(gitArgs, state, process.cwd(), process.env);
	if (argvWhy !== null) return argvWhy;
	const sub = gitArgs.findIndex((a, i) => !a.startsWith("-") && !["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env"].includes(gitArgs[i - 1] ?? ""));
	if (gitArgs[sub] !== "push") return null;
	return checkPushContent(gitWorkDir(gitArgs, process.cwd()), pushSources(gitArgs.slice(sub + 1)), state);
}

const reason = why();
if (reason !== null) {
	console.error(reason);
	process.exit(1);
}
