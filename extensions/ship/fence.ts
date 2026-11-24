// The /ship fence, part 1: what a fenced session's gh and git may do, judged from their argv, plus the comment rules
// and the repo files /ship never edits. Argv alone decides, apart from where the paths it names lead. fence-state.ts
// arms the fence and checks what a push carries; fence-tools.ts judges omp tool calls. Each check returns null
// (allowed) or the reason, which the model reads.
import * as fs from "node:fs";
import * as path from "node:path";

/** What a fenced session's git is held to. */
export interface GitPolicy {
	/** The one branch the session pushes to origin; null: it pushes nothing. */
	pushBranch: string | null;
	/** The repo's git folders, absolute: hooks, config and refs live there (a linked worktree's hooks live in the main repo's). */
	gitDirs: string[];
}

/** First line of every comment or reply /ship writes, so the watch can tell its own words apart. */
export const MARKER = "<!-- omp-ship -->";

export const refused = (what: string) => `ship fence: ${what}. This is final while /ship runs: tell the user instead of finding another way.`;

/** A refusal that lifts once the checkout or the connection is in order: what to do, then try again. */
export const retryable = (what: string) => `ship fence: ${what}; then try again.`;

/** Repo files /ship never edits: CI and repo settings, review rules, agent instructions, secrets, hooks. Case-blind, as macOS is. */
const PROTECTED = [
	/^\.github(?:\/|$)/i,
	/(?:^|\/)CODEOWNERS$/i,
	/(?:^|\/)\.env(?!\.(?:example|sample|template)$)[^/]*$/i,
	/(?:^|\/)\.npmrc$/i,
	/(?:^|\/)(?:AGENTS|CLAUDE)\.md$/i,
	/^\.claude(?:\/|$)/i,
	/(?:^|\/)\.mcp\.json$/i,
	/^\.(?:husky|githooks|git)(?:\/|$)/i,
	/(?:^|\/)lefthook\.ya?ml$/i,
	/(?:^|\/)\.pre-commit-config\.yaml$/i,
];

/** `rel` is a repo-relative path with `/` separators. */
export const isProtectedPath = (rel: string): boolean => PROTECTED.some(r => r.test(rel));

/**
 * `p` resolved through symlinks: its nearest existing ancestor's real path, plus the part that doesn't exist yet. The
 * real path comes from the OS, which resolves a `..` after a symlink to the link's target's parent, as git's writes do.
 */
export function canonical(p: string): string {
	let dir = p;
	const rest: string[] = [];
	while (!fs.existsSync(dir) && path.dirname(dir) !== dir) {
		rest.unshift(path.basename(dir));
		dir = path.dirname(dir);
	}
	return path.join(fs.realpathSync.native(dir), ...rest);
}

type Names = Record<string, true>;
const names = (...list: string[]): Names => Object.fromEntries(list.map(n => [n, true]));
const isIn = (set: Names, name: string) => Object.hasOwn(set, name);

interface Flags {
	long: Map<string, string | true>;
	short: Set<string>;
	positionals: string[];
}

/** Splits argv into flags and positionals. A flag in `takesValue` reads `--name=v`, `--name v`, `-Xv` or `-X v`. */
function parse(args: string[], takesValue: Names): Flags {
	const flags: Flags = { long: new Map(), short: new Set(), positionals: [] };
	for (let i = 0; i < args.length; i++) {
		const arg = args[i] as string;
		if (arg === "--") {
			flags.positionals.push(...args.slice(i + 1));
			break;
		}
		if (arg.startsWith("--")) {
			const eq = arg.indexOf("=");
			const name = eq < 0 ? arg : arg.slice(0, eq);
			if (eq >= 0) flags.long.set(name, arg.slice(eq + 1));
			else if (isIn(takesValue, name)) flags.long.set(name, args[++i] ?? "");
			else flags.long.set(name, true);
		} else if (arg.startsWith("-") && arg.length > 1) {
			// Short flags bundle (-uf); one that takes a value ends the bundle (-XPOST, -X POST).
			for (let j = 1; j < arg.length; j++) {
				const name = `-${arg[j]}`;
				flags.short.add(name);
				if (isIn(takesValue, name)) {
					flags.long.set(name, arg.slice(j + 1) || (args[++i] ?? ""));
					break;
				}
			}
		} else {
			flags.positionals.push(arg);
		}
	}
	return flags;
}

const has = (f: Flags, ...list: string[]) => list.some(n => f.long.has(n) || f.short.has(n));
const value = (f: Flags, ...list: string[]) => list.map(n => f.long.get(n)).find(v => typeof v === "string");

// ---- what /ship writes on GitHub -----------------------------------------------------------------------------------

const CLOSING = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+(?:[\w.-]+\/[\w.-]+)?#\d+/i;

/** Why a comment body /ship wants to post is refused, or null. */
export function checkCommentBody(body: string): string | null {
	if (!body.startsWith(`${MARKER}\n`) && body !== MARKER) return refused(`a comment starts with the line ${MARKER}`);
	const rest = body.slice(MARKER.length);
	if (rest.includes("<!--")) return refused("a comment holds no other HTML comment");
	if (/(?:^|[\s(])@[A-Za-z0-9]/.test(rest)) return refused("a comment @-mentions nobody");
	if (/https?:\/\/|www\./i.test(rest)) return refused("a comment holds no links");
	if (CLOSING.test(rest)) return refused('a comment holds no closing keyword such as "fixes #12"');
	if (body.length > 8000) return refused("a comment stays under 8,000 characters");
	return null;
}

const FIELD_FLAGS = names("-f", "-F", "--field", "--raw-field");

/** `body` fields of a `gh api` call; a body read from a file (`-F body=@x`) is `null`, since it can't be checked. */
function bodyFields(args: string[]): (string | null)[] {
	const out: (string | null)[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i] as string;
		let field: string | undefined;
		if (isIn(FIELD_FLAGS, arg)) field = args[++i];
		else if (/^--(?:raw-)?field=/.test(arg)) field = arg.slice(arg.indexOf("=") + 1);
		else if (/^-[fF]./.test(arg)) field = arg.slice(2);
		if (field === undefined || !field.startsWith("body=")) continue;
		const raw = field.slice("body=".length);
		out.push(arg.startsWith("-F") || arg.startsWith("--field") ? (raw.startsWith("@") ? null : raw) : raw);
	}
	return out;
}

// ---- gh -------------------------------------------------------------------------------------------------------------

/** gh's own commands. Anything else is an alias or an extension, which the fence can't read. */
const GH_COMMANDS = names(
	"agent-task", "alias", "api", "attestation", "auth", "browse", "cache", "co", "codespace", "completion", "config",
	"copilot", "extension", "gist", "gpg-key", "help", "issue", "label", "org", "pr", "preview", "project", "release",
	"repo", "ruleset", "run", "search", "secret", "ssh-key", "status", "variable", "version", "workflow",
);

/** Subcommands a fenced session never runs. `"all"` refuses every subcommand but the read-only ones. */
const GH_REFUSED: Record<string, Names | "all"> = {
	pr: names("merge", "review", "ready", "close", "reopen", "lock", "unlock"),
	repo: names("delete", "archive", "unarchive", "edit", "rename", "sync", "fork"),
	issue: names("delete", "transfer"),
	release: names("create", "delete", "edit", "upload", "delete-asset"),
	workflow: names("enable", "disable", "run"),
	run: names("cancel", "delete"),
	cache: names("delete"),
	auth: names("login", "logout", "refresh", "switch", "setup-git"),
	config: names("set", "clear-cache"),
	secret: "all",
	variable: "all",
	ruleset: "all",
	alias: "all",
	extension: "all",
	"ssh-key": "all",
	"gpg-key": "all",
};
const READ_ONLY = names("list", "view", "check", "get");

const GH_API_VALUE_FLAGS = names(
	"-X", "--method", "-H", "--header", "-f", "--raw-field", "-F", "--field", "-q", "--jq", "-t", "--template",
	"--input", "--hostname", "-p", "--preview", "--cache",
);
/** Only these may come before gh's command words with a value; a subcommand's own flags differ (pr create -f is --fill). */
const GH_VALUE_FLAGS = names("-R", "--repo", "--hostname");
const PR_COMMENT_VALUE_FLAGS = names("-b", "--body", "-F", "--body-file", "-R", "--repo");

/** Writes a fenced session may make with `gh api`: comments, review replies, asking a reviewer again. */
const API_COMMENTS = [
	/^repos\/[^/]+\/[^/]+\/issues\/\d+\/comments$/,
	/^repos\/[^/]+\/[^/]+\/pulls\/\d+\/comments$/,
	/^repos\/[^/]+\/[^/]+\/pulls\/\d+\/comments\/\d+\/replies$/,
];
const API_REREQUEST = /^repos\/[^/]+\/[^/]+\/pulls\/\d+\/requested_reviewers$/;

function checkGhApi(args: string[]): string | null {
	const f = parse(args, GH_API_VALUE_FLAGS);
	const endpoint = (f.positionals[0] ?? "").replace(/^\//, "").split("?")[0] ?? "";
	const sendsFields = has(f, "-f", "--raw-field", "-F", "--field", "--input");
	const method = (value(f, "-X", "--method") ?? (sendsFields ? "POST" : "GET")).toUpperCase();
	if (endpoint === "graphql") {
		const mutations = args.filter(a => /\bmutation\b/i.test(a));
		if (mutations.some(a => !RESOLVE_THREAD.test(a))) return refused("GraphQL mutations other than resolving one review thread are refused");
		if (has(f, "--input") || args.some(a => /^query=@/.test(a))) return refused("a GraphQL query read from a file can't be checked");
		return null;
	}
	if (method === "GET") return null;
	if (method === "POST" && API_REREQUEST.test(endpoint)) return null;
	if (method === "POST" && API_COMMENTS.some(p => p.test(endpoint))) {
		if (has(f, "--input")) return refused("a comment body read from a file can't be checked; pass it with -f body=");
		const bodies = bodyFields(args);
		if (bodies.length !== 1) return refused("a comment carries exactly one body field");
		return bodies[0] === null ? refused("a comment body read from a file can't be checked; pass it with -f body=") : checkCommentBody(bodies[0] as string);
	}
	return refused(`gh api ${method} ${endpoint} is refused (only comments, review replies and re-requesting a reviewer write)`);
}

/** `args` is gh's argv without the program name. */
export function checkGh(args: string[]): string | null {
	const f = parse(args, GH_VALUE_FLAGS);
	const [group = "", sub = ""] = f.positionals;
	if (group === "") return null;
	if (!isIn(GH_COMMANDS, group)) return refused(`gh ${group} is not a gh command the fence knows (aliases and extensions are refused)`);
	if (group === "api") return checkGhApi(args.slice(args.indexOf("api") + 1));
	const rule = GH_REFUSED[group];
	if (rule === "all" ? !isIn(READ_ONLY, sub) : rule !== undefined && isIn(rule, sub)) {
		return refused(`gh ${group} ${sub} is refused: merging, approving, undrafting, closing and settings are the user's`);
	}
	if (group === "pr" && sub === "create" && (!has(f, "--draft", "-d") || value(f, "--draft") === "false")) return refused("open the pull request as a draft: gh pr create --draft");
	if (group === "pr" && sub === "edit" && has(f, "--base", "-B")) return refused("a pull request's base is the user's to change");
	if ((group === "pr" || group === "issue") && sub === "comment") {
		const c = parse(args, PR_COMMENT_VALUE_FLAGS);
		const body = value(c, "-b", "--body");
		if (body === undefined) return refused("pass the comment with --body so the fence can check it");
		return checkCommentBody(body);
	}
	return null;
}

// ---- git ------------------------------------------------------------------------------------------------------------

const GIT_GLOBAL_VALUE = names("-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env");
/** `-c` or config settings that would bend a commit or a push: hooks, where a remote points, credentials, aliases. */
const RISKY_CONFIG = /^(core\.hookspath|core\.sshcommand|remote\.|url\.|credential|alias\.|branch\.[^.]+\.(remote|pushremote))/i;

const PUSH_VALUE_FLAGS = names("--recurse-submodules", "--repo", "--receive-pack", "--exec", "-o", "--push-option");
const PUSH_OK_LONG = names(
	"--set-upstream", "--porcelain", "--quiet", "--verbose", "--dry-run", "--atomic", "--no-atomic", "--progress",
	"--no-progress", "--no-follow-tags", "--thin", "--no-thin", "--signed", "--no-signed", "--ipv4", "--ipv6",
	"--recurse-submodules", "--no-recurse-submodules",
);
const PUSH_OK_SHORT = names("-u", "-q", "-v", "-n", "-4", "-6");

/** `p` from `dir`, walked as the kernel does: a `..` after a symlink leaves the link's target, which `path.resolve` can't know. */
const walk = (dir: string, p: string): string => canonical(path.isAbsolute(p) ? p : `${dir}${path.sep}${p}`);

/** The folder a git argv runs in: its `-C` options applied to `cwd`. */
export function gitWorkDir(args: string[], cwd: string): string {
	let dir = cwd;
	for (let i = 0; i < args.length && (args[i] as string).startsWith("-"); i++) {
		if (args[i] === "-C") dir = walk(dir, args[++i] ?? "");
		else if (isIn(GIT_GLOBAL_VALUE, args[i] as string)) i++;
	}
	return dir;
}

/** The `src` of each refspec a `git push` argv names, after its flags: `HEAD:x` gives `HEAD`, `x` gives `x`. */
export function pushSources(pushArgs: string[]): string[] {
	const [, ...refspecs] = parse(pushArgs, PUSH_VALUE_FLAGS).positionals;
	return refspecs.map(spec => (spec.includes(":") ? spec.slice(0, spec.indexOf(":")) : spec).replace(/^\+/, "") || "HEAD");
}

function checkPush(args: string[], policy: GitPolicy): string | null {
	if (policy.pushBranch === null) return refused("this session pushes nothing");
	const only = `git push origin ${policy.pushBranch}`;
	const f = parse(args, PUSH_VALUE_FLAGS);
	for (const name of f.long.keys()) {
		// Short flags that took a value (-o) are also in f.short and judged there.
		if (name.startsWith("--") && !isIn(PUSH_OK_LONG, name)) return refused(`git push ${name} is refused; push with ${only}`);
	}
	for (const name of f.short) if (!isIn(PUSH_OK_SHORT, name)) return refused(`git push ${name} is refused; push with ${only}`);
	const submodules = value(f, "--recurse-submodules");
	if (submodules !== undefined && submodules !== "check" && submodules !== "no") return refused("pushing submodules is refused");
	const [remote, ...refspecs] = f.positionals;
	if (remote !== "origin") return refused(`push to origin only: ${only}`);
	if (refspecs.length === 0) return refused(`name the branch: ${only}`);
	for (const spec of refspecs) {
		if (spec.startsWith("+")) return refused("force pushes are refused");
		const dst = (spec.includes(":") ? spec.slice(spec.indexOf(":") + 1) : spec).replace(/^refs\/heads\//, "");
		// `:dst` pushes nothing onto dst, which deletes it.
		if (spec.startsWith(":") || dst === "") return refused("deleting a branch is refused");
		if (dst !== policy.pushBranch) return refused(`this session pushes only to ${policy.pushBranch}: ${only}`);
	}
	return null;
}

const CONFIG_WRITE_FLAGS = ["--add", "--replace-all", "--unset", "--unset-all", "--rename-section", "--remove-section", "--edit", "-e"];

function checkConfig(args: string[]): string | null {
	const f = parse(args, names("--file", "-f", "--blob", "--type", "--default", "--comment"));
	const [first = "", second] = f.positionals;
	// `git config set|unset KEY` (git 2.46+) or the classic `git config KEY VALUE` / `--unset KEY`.
	const modern = ["set", "unset", "rename-section", "remove-section"].includes(first);
	const key = modern ? (second ?? "") : first;
	const writes = modern || second !== undefined || has(f, ...CONFIG_WRITE_FLAGS);
	return writes && RISKY_CONFIG.test(key) ? refused(`git config ${key} is refused`) : null;
}

/** Whether `p`, absolute, is or lies inside a git folder: any `.git`, or one of `gitDirs`. Case-blind, as macOS is. */
function inGitFolder(p: string, gitDirs: string[]): boolean {
	const low = p.toLowerCase();
	return low.split(path.sep).includes(".git") || gitDirs.some(dir => low === dir.toLowerCase() || low.startsWith(`${dir.toLowerCase()}${path.sep}`));
}

/** The word of `argv` that names a path inside a git folder: as written, as the value of `--opt=value` or `key=value`, or glued to a short option (`-ofile`). Relative paths run from `dir`; symlinks are followed. */
function gitFolderWord(argv: string[], dir: string, gitDirs: string[]): string | undefined {
	return argv.find(word => {
		const paths = [word];
		if (word.includes("=")) paths.push(word.slice(word.indexOf("=") + 1));
		if (/^-[^-]/.test(word)) paths.push(word.slice(2));
		return paths.some(p => p !== "" && [path.resolve(dir, p), walk(dir, p)].some(form => inGitFolder(form, gitDirs)));
	});
}

/** Why a git argv would write into a git folder, where hooks, config and refs live: it runs in one, or a word of it names a path inside one. */
function checkGitFolder(args: string[], dir: string, policy: GitPolicy): string | null {
	if (inGitFolder(dir, policy.gitDirs)) return refused(`git runs in the work tree, not in the git folder ${dir}`);
	const word = gitFolderWord(args, dir, policy.gitDirs);
	return word === undefined ? null : refused(`git names ${word}, a path inside a git folder, where hooks and config live`);
}

/** Refs only a fetch from the remote may set: remote-tracking refs, which a push check could be fooled by, and replacement refs, which change what git reads. */
const FETCH_ONLY_REFS = /^(?:(?:refs\/)?remotes|refs\/replace)\//i;
/** git init's options that copy files into the git folder or move it. */
const INIT_COPYING = ["--template", "--separate-git-dir"];

/** Why a subcommand's own options would write where /ship may not send it: files into the git folder, or a ref only a fetch from the remote may set. */
function checkSubcommandWrites(sub: string, rest: string[]): string | null {
	if (sub === "init") {
		// Abbreviations count: git reads `--templ` as `--template`.
		const copying = [...parse(rest, {}).long.keys()].find(flag => flag.length > 2 && INIT_COPYING.some(full => full.startsWith(flag)));
		if (copying !== undefined) return refused(`git init ${copying} is refused: it copies files into the git folder, or moves it`);
	}
	if (sub === "update-ref") {
		const f = parse(rest, names("-m"));
		// `--stdin` takes its refs from input the fence can't read.
		const flag = [...f.long.keys()].find(name => name.startsWith("--") && name !== "--no-deref" && name !== "--create-reflog");
		if (flag !== undefined) return refused(`git update-ref ${flag} is refused: name the ref on the command line`);
		const ref = f.positionals[0] ?? "";
		if (FETCH_ONLY_REFS.test(ref)) return refused(`git update-ref ${ref} is refused: remote-tracking and replacement refs are set by a fetch from the remote alone`);
	}
	if (sub === "fetch" || sub === "pull") {
		for (const word of rest) {
			// A refspec `src:dst`, as a word or as an option's value (`--refmap=src:dst`).
			const spec = word.startsWith("--") ? word.slice(word.indexOf("=") + 1) : word;
			if (spec.includes(":") && FETCH_ONLY_REFS.test(spec.slice(spec.indexOf(":") + 1))) return refused(`git ${sub} ${word} is refused: remote-tracking and replacement refs are set by a fetch from the remote alone`);
		}
	}
	return null;
}

/** `args` is git's argv without the program name. */
export function checkGit(args: string[], policy: GitPolicy, cwd: string): string | null {
	let i = 0;
	const settings: string[] = [];
	for (; i < args.length; i++) {
		const arg = args[i] as string;
		if (!arg.startsWith("-")) break;
		if (isIn(GIT_GLOBAL_VALUE, arg)) {
			if (arg === "-c") settings.push(args[i + 1] ?? "");
			i++;
		} else if (arg.startsWith("-c") && arg.length > 2) settings.push(arg.slice(2));
	}
	const sub = args[i] ?? "";
	const rest = args.slice(i + 1);
	if (sub !== "" && !isIn(GIT_COMMANDS, sub)) return refused(`git ${sub} is not a git command the fence allows`);
	const writes = checkGitFolder(args, gitWorkDir(args, cwd), policy) ?? checkSubcommandWrites(sub, rest);
	if (writes !== null) return writes;
	const risky = settings.find(s => RISKY_CONFIG.test(s));
	if ((sub === "push" || sub === "commit" || sub === "merge") && risky !== undefined) return refused(`git -c ${risky} with ${sub} is refused: hooks and remotes stay as configured`);
	// The push check reads the repo the shim runs in; --git-dir would point the push at another one.
	if (sub === "push" && args.slice(0, i).some(a => a === "--git-dir" || a.startsWith("--git-dir="))) return refused("git push --git-dir is refused: push from the repo itself");
	if (sub === "push") return checkPush(rest, policy);
	if ((sub === "commit" || sub === "merge") && (rest.includes("--no-verify") || (sub === "commit" && rest.some(a => /^-[a-zA-Z]*n/.test(a) && !a.startsWith("--"))))) return refused(`${sub} keeps its hooks: drop --no-verify / -n`);
	if (sub === "remote" && ["add", "set-url", "rename", "remove", "rm"].includes(rest[0] ?? "")) return refused(`git remote ${rest[0]} is refused`);
	if (sub === "config") return checkConfig(rest);
	return null;
}

/** The one mutation a watch runs: resolving a review thread, with nothing else in the same document. */
const RESOLVE_THREAD = /^query=\s*mutation\s*(?:\(\s*\$\w+\s*:\s*ID!\s*\))?\s*\{\s*resolveReviewThread\s*\(\s*input\s*:\s*\{\s*threadId\s*:\s*\$?\w+\s*\}\s*\)\s*\{\s*thread\s*\{\s*isResolved\s*\}\s*\}\s*\}\s*$/;

/** git's own commands a session may run: read-only or local. Anything else is an alias, a helper or a command that writes a remote or config. */
const GIT_COMMANDS = names(
	"add", "am", "annotate", "apply", "archive", "bisect", "blame", "branch", "bundle", "cat-file", "check-attr", "check-ignore",
	"check-mailmap", "check-ref-format", "checkout", "checkout-index", "cherry", "cherry-pick", "clean", "clone", "column",
	"commit", "commit-tree", "config", "count-objects", "describe", "diff", "diff-files", "diff-index", "diff-tree", "fast-export",
	"fetch", "fmt-merge-msg", "for-each-ref", "format-patch", "fsck", "gc", "get-tar-commit-id", "grep", "hash-object", "help",
	"init", "interpret-trailers", "lfs", "log", "ls-files", "ls-remote", "ls-tree", "mailinfo", "mailsplit", "merge", "merge-base",
	"merge-file", "merge-tree", "mktag", "mktree", "mv", "name-rev", "notes", "pack-refs", "patch-id", "prune", "pull", "push",
	"range-diff", "read-tree", "rebase", "reflog", "refs", "remote", "repack", "request-pull", "rerere", "reset", "restore",
	"rev-list", "rev-parse", "revert", "rm", "shortlog", "show", "show-branch", "show-index", "show-ref", "stage", "stash",
	"status", "stripspace", "submodule", "switch", "symbolic-ref", "tag", "unpack-file", "update-index", "update-ref", "var",
	"verify-commit", "verify-pack", "verify-tag", "version", "whatchanged", "worktree", "write-tree",
);
