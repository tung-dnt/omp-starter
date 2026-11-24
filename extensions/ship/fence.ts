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

// ---- gh -------------------------------------------------------------------------------------------------------------

/** A gh command group's subcommands by every word gh takes for them: `["create", "new"]` is `gh pr create`, which `gh pr new` is too. */
const subs = (...commands: (string | string[])[]): Map<string, string> =>
	new Map(
		commands.flatMap(command => {
			const [name = "", ...aliases] = [command].flat();
			return [name, ...aliases].map((word): [string, string] => [word, name]);
		}),
	);

/**
 * What a fenced session's gh runs, and nothing else: each gh command group with the subcommands a watch, a put-up or a
 * review needs, under the names gh 2.103.3 gives them (`gh help reference` lists the aliases). null is a command with
 * no subcommand to tell apart: `api` (checked below), `status`, `help`, `version`, and `search`, which only reads. A
 * list of what is refused lost to a name gh has for a refused command (`gh pr new` is `gh pr create`), to another
 * group's command with the same effect (`gh issue close 5` closes a PR) and to commands gh adds (`gh repo deploy-key
 * add --allow-write`), so anything not named here is refused.
 */
const GH_RUNS = new Map(
	Object.entries({
		api: null,
		auth: subs("status", "token"),
		cache: subs(["list", "ls"]),
		help: null,
		issue: subs(["list", "ls"], "view", "comment"),
		label: subs(["list", "ls"]),
		pr: subs("view", "checks", "diff", ["list", "ls"], "status", "comment", ["create", "new"], "edit"),
		release: subs(["list", "ls"], "view"),
		repo: subs("view"),
		run: subs(["list", "ls"], "view", "rerun", "watch"),
		search: null,
		status: null,
		version: null,
		workflow: subs(["list", "ls"], "view"),
	}),
);

/** One flag as it was given: `name` as typed (`--draft`, `-d`), and its value, which is null for a flag given bare. */
interface GhFlag {
	name: string;
	value: string | null;
}

/** What a gh command's words come to: its flags in the order given, and the words that are neither flags nor their values. */
interface GhArgs {
	flags: GhFlag[];
	words: string[];
	/** The first flag the command doesn't have. gh refuses it, and nothing past it can be told apart as a value or a word. */
	unknown?: string;
}

/** The flags of a gh command by every spelling: the ones that take a value, and the ones that don't. */
interface GhSpec {
	value: Names;
	bool: Names;
}

const ghSpec = (value: string[], bool: string[]): GhSpec => ({ value: names(...value), bool: names("--help", ...bool) });

/**
 * `args` as pflag, the flag parser gh is built on, reads them for a command with the flags `spec` lists. A value flag
 * takes the next word, a dash or not (`--title --draft` gives a title); a short flag with more after it takes that
 * (`-tdraft`) or, for a bool flag, goes on to the next flag in the bundle (`-fd`); `-x=v` and `--name=v` give any flag a
 * value, which gh reads for a bool flag with strconv.ParseBool; `--` ends the flags.
 */
function pflag(args: string[], spec: GhSpec): GhArgs {
	const out: GhArgs = { flags: [], words: [] };
	const kind = (name: string) => (isIn(spec.value, name) ? "value" : isIn(spec.bool, name) ? "bool" : undefined);
	for (let i = 0; i < args.length; i++) {
		const arg = args[i] as string;
		if (arg === "--") {
			out.words.push(...args.slice(i + 1));
			break;
		}
		if (arg.startsWith("--")) {
			const eq = arg.indexOf("=");
			const name = eq < 0 ? arg : arg.slice(0, eq);
			const given = eq < 0 ? null : arg.slice(eq + 1);
			const k = kind(name);
			if (k === undefined) return { ...out, unknown: name };
			out.flags.push({ name, value: k === "value" ? (given ?? args[++i] ?? "") : given });
		} else if (arg.startsWith("-") && arg.length > 1) {
			for (let bundle = arg.slice(1); bundle !== ""; ) {
				const name = `-${bundle[0]}`;
				const k = kind(name);
				if (k === undefined) return { ...out, unknown: name };
				if (bundle.length > 2 && bundle[1] === "=") out.flags.push({ name, value: bundle.slice(2) });
				else if (k === "bool") {
					out.flags.push({ name, value: null });
					bundle = bundle.slice(1);
					continue;
				} else out.flags.push({ name, value: bundle.length > 1 ? bundle.slice(1) : (args[++i] ?? "") });
				bundle = "";
			}
		} else {
			out.words.push(arg);
		}
	}
	return out;
}

/** The last of the flags spelled `names`: gh keeps the last value a flag is given, whichever of its spellings gave it. */
const lastOf = (f: GhArgs, ...spellings: string[]) => f.flags.findLast(flag => spellings.includes(flag.name));

const TRUE_BOOLS = names("1", "t", "T", "true", "True", "TRUE");
/** Whether a bool flag is on: given bare, or with a value strconv.ParseBool reads as true. Every other value is off, or an error gh stops at. */
const isOn = (flag: GhFlag | undefined): boolean => flag !== undefined && (flag.value === null || isIn(TRUE_BOOLS, flag.value));

const GH_API = ghSpec(
	["--cache", "-F", "--field", "-H", "--header", "--hostname", "--input", "-q", "--jq", "-X", "--method", "-p", "--preview", "-f", "--raw-field", "-t", "--template"],
	["--allow-escape-sequences", "-i", "--include", "--paginate", "--silent", "--slurp", "--verbose"],
);
const GH_PR_CREATE = ghSpec(
	["-a", "--assignee", "--attach", "-B", "--base", "-b", "--body", "-F", "--body-file", "-H", "--head", "-l", "--label", "-m", "--milestone", "-p", "--project", "--recover", "-r", "--reviewer", "-T", "--template", "-t", "--title", "-R", "--repo"],
	["-d", "--draft", "--dry-run", "-e", "--editor", "-f", "--fill", "--fill-first", "--fill-verbose", "--no-maintainer-edit", "-w", "--web"],
);
const GH_COMMENT = ghSpec(["--attach", "-b", "--body", "-F", "--body-file", "-R", "--repo"], ["--create-if-none", "--delete-last", "--edit-last", "-e", "--editor", "-w", "--web", "--yes"]);

/** The repo flags and the host flag: the only flags the fence reads in front of gh's command words. */
const GH_WORD_FLAGS = names("-R", "--repo", "--hostname");

/**
 * gh's command words, and where the rest of its words begin. gh's command parser, cobra, finds a subcommand past any
 * flags and takes the word after a flag it doesn't know as that flag's value: `gh pr -t x merge 5` is `gh pr merge 5
 * --subject x`, and `gh -p pr -p pr api …` runs api. It skips an empty word and a lone `-` as well (`gh pr - merge`
 * merges). The fence knows the repo and host flags only, so any other flag, empty word or `-` in front of the words it
 * needs is refused: it can't tell whose word the next one is. A command with no subcommand to tell apart (a null in
 * GH_RUNS) needs only its first word, and `api` takes its own flags and words after it.
 */
function ghCommand(args: string[]): { group: string; sub: string; at: number } | string {
	const words: string[] = [];
	let at = 0;
	while (at < args.length && words.length < 2) {
		if (words.length === 1 && !GH_RUNS.get(words[0] as string)) break;
		const arg = args[at++] as string;
		if (isIn(GH_WORD_FLAGS, arg)) at++;
		else if (arg === "--help" || arg === "--version" || /^(?:-R.|--repo=|--hostname=)/.test(arg)) continue;
		else if (arg === "" || arg.startsWith("-")) return refused("a flag, an empty word or a lone - in front of gh's command words is refused: cobra skips them, so gh may run another command than the fence reads, or take the next word as a value. Put the flags after the command (gh pr view 5 --json state)");
		else words.push(arg);
	}
	const [group = "", sub = ""] = words;
	return { group, sub, at };
}

/** Writes a fenced session may make with `gh api`: comments, review replies, asking a reviewer again. */
const API_COMMENTS = [
	/^repos\/[^/]+\/[^/]+\/issues\/\d+\/comments$/,
	/^repos\/[^/]+\/[^/]+\/pulls\/\d+\/comments$/,
	/^repos\/[^/]+\/[^/]+\/pulls\/\d+\/comments\/\d+\/replies$/,
];
const API_REREQUEST = /^repos\/[^/]+\/[^/]+\/pulls\/\d+\/requested_reviewers$/;

/** `args` is what follows `api`. */
function checkGhApi(args: string[]): string | null {
	const f = pflag(args, GH_API);
	if (f.unknown !== undefined) return refused(`gh api ${f.unknown} is not a flag the fence knows`);
	const endpoint = (f.words[0] ?? "").replace(/^\//, "").split("?")[0] ?? "";
	// -f and --raw-field send their text; -F and --field read a value that opens with `@` from a file or stdin.
	const fields = f.flags.flatMap(flag => {
		if (!isIn(FIELD_FLAGS, flag.name) || flag.value === null) return [];
		const eq = flag.value.indexOf("=");
		const value = eq < 0 ? "" : flag.value.slice(eq + 1);
		return [{ key: eq < 0 ? flag.value : flag.value.slice(0, eq), value, reads: (flag.name === "-F" || flag.name === "--field") && value.startsWith("@") }];
	});
	const input = f.flags.some(flag => flag.name === "--input");
	const method = (lastOf(f, "-X", "--method")?.value ?? (fields.length > 0 || input ? "POST" : "GET")).toUpperCase();
	if (endpoint === "graphql") {
		const texts = [...f.flags.flatMap(flag => flag.value ?? []), ...f.words];
		if (texts.some(text => /\bmutation\b/i.test(text) && !RESOLVE_THREAD.test(text))) return refused("GraphQL mutations other than resolving one review thread are refused");
		if (input || fields.some(field => field.key === "query" && field.value.startsWith("@"))) return refused("a GraphQL query read from a file can't be checked");
		return null;
	}
	if (method === "GET") return null;
	if (method === "POST" && API_REREQUEST.test(endpoint)) return null;
	if (method === "POST" && API_COMMENTS.some(p => p.test(endpoint))) {
		if (input) return refused("a comment body read from a file can't be checked; pass it with -f body=");
		const bodies = fields.filter(field => field.key === "body");
		if (bodies.length !== 1) return refused("a comment carries exactly one body field");
		const [body] = bodies as [(typeof bodies)[number]];
		return body.reads ? refused("a comment body read from a file can't be checked; pass it with -f body=") : checkCommentBody(body.value);
	}
	return refused(`gh api ${method} ${endpoint} is refused (only comments, review replies and re-requesting a reviewer write)`);
}

/** `args` is gh's argv without the program name. */
export function checkGh(args: string[]): string | null {
	const command = ghCommand(args);
	if (typeof command === "string") return command;
	const { group, at } = command;
	if (group === "") return null;
	const subcommands = GH_RUNS.get(group);
	if (subcommands === undefined) return refused(`gh ${group} is not something /ship runs`);
	if (group === "api") return checkGhApi(args.slice(at));
	// A group with no subcommand (or only a repo or help flag) prints its help.
	if (subcommands === null || command.sub === "") return null;
	const sub = subcommands.get(command.sub);
	if (sub === undefined) return refused(`gh ${group} ${command.sub} is not something /ship runs`);
	if (group === "pr" && sub === "create") {
		const f = pflag(args, GH_PR_CREATE);
		if (f.unknown !== undefined) return refused(`gh pr create ${f.unknown} is not a flag the fence knows`);
		if (!isOn(lastOf(f, "-d", "--draft"))) return refused("open the pull request as a draft: gh pr create --draft");
	}
	// Judged by the tokens alone: `-b -R -B=main` has a --base that a reading of which word is whose value would lose.
	if (group === "pr" && sub === "edit" && args.some(arg => arg === "--base" || arg.startsWith("--base=") || (/^-[^-]/.test(arg) && (arg.split("=", 1)[0] as string).includes("B")))) return refused("a pull request's base is the user's to change");
	if (sub === "comment") {
		const f = pflag(args, GH_COMMENT);
		if (f.unknown !== undefined) return refused(`gh ${group} comment ${f.unknown} is not a flag the fence knows`);
		const body = lastOf(f, "-b", "--body")?.value;
		if (typeof body !== "string") return refused("pass the comment with --body so the fence can check it");
		return checkCommentBody(body);
	}
	return null;
}

// ---- git ------------------------------------------------------------------------------------------------------------

/** git's global options that take a value: the next word, a dash or not (`git -C -c push` runs push in a folder named `-c`). */
const GIT_GLOBAL_VALUE = names("-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env", "--attr-source", "--shallow-file");
/** The long ones among them that also read `--name=value`, and `--exec-path` and `--list-cmds`, which read nothing else. */
const GIT_GLOBAL_EQUALS = names("--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env", "--attr-source", "--exec-path", "--list-cmds");
/** The ones that take no value. git reads each global option exactly, never by a prefix, and stops at the first word that is not one. */
const GIT_GLOBAL_BARE = names(
	"-p", "--paginate", "-P", "--no-pager", "--no-replace-objects", "--no-lazy-fetch", "--no-optional-locks", "--no-advice", "--bare", "--literal-pathspecs", "--no-literal-pathspecs",
	"--glob-pathspecs", "--noglob-pathspecs", "--icase-pathspecs", "--exec-path", "--html-path", "--man-path", "--info-path",
);
/** `--version` and `--help`, and their short forms, are the commands `version` and `help`. */
const GIT_INFO_COMMANDS: Record<string, string> = { "--version": "version", "-v": "version", "--help": "help", "-h": "help" };

/** A git argv as git reads it: the global options, then the subcommand and the words it takes. */
interface GitCall {
	/** What `-c` sets (`key=value`), what `--config-env` names (`key=VARIABLE`), and the paths --git-dir and --work-tree name. */
	settings: string[];
	configEnv: string[];
	named: string[];
	/** The `-C` folders, each taken from the one before it. */
	dirs: string[];
	/** --git-dir or --bare was given: git runs against a repo other than the one the folder it runs in holds. */
	gitDir: boolean;
	sub: string;
	rest: string[];
	/** Why the options in front of the subcommand can't be read, or null. */
	problem: string | null;
}

/**
 * `args` as git's own option loop reads them. It is the one place the fence tells the subcommand from an option's value:
 * every check, and the push check that runs real git, goes by this reading. An option the fence doesn't know is refused,
 * since it might take the next word, and then the word the fence took for the subcommand would be its value.
 */
function readGit(args: string[]): GitCall {
	const call: GitCall = { settings: [], configEnv: [], named: [], dirs: [], gitDir: false, sub: "", rest: [], problem: null };
	let i = 0;
	for (; i < args.length; i++) {
		const arg = args[i] as string;
		if (!arg.startsWith("-")) break;
		if (Object.hasOwn(GIT_INFO_COMMANDS, arg)) return { ...call, sub: GIT_INFO_COMMANDS[arg] as string, rest: args.slice(i + 1) };
		const eq = arg.indexOf("=");
		const name = eq < 0 ? arg : arg.slice(0, eq);
		if (isIn(GIT_GLOBAL_VALUE, arg)) {
			const word = args[++i] ?? "";
			if (arg === "-C") call.dirs.push(word);
			else if (arg === "-c") call.settings.push(word);
			else if (arg === "--config-env") call.configEnv.push(word);
			else if (arg === "--git-dir" || arg === "--work-tree") call.named.push(word);
			call.gitDir ||= arg === "--git-dir";
		} else if (eq > 0 && isIn(GIT_GLOBAL_EQUALS, name)) {
			// Asking for the path (`--exec-path`) is harmless; setting it moves where git finds the programs it runs.
			if (name === "--exec-path") return { ...call, problem: refused("git --exec-path=<dir> is refused: the programs git runs stay where they are") };
			if (name === "--config-env") call.configEnv.push(arg.slice(eq + 1));
			else if (name === "--git-dir" || name === "--work-tree") call.named.push(arg.slice(eq + 1));
			call.gitDir ||= name === "--git-dir";
		} else if (arg.startsWith("-c") && arg.length > 2) {
			// git itself turns `-cname=value` away; read as -c here, so no spelling hides a key.
			call.settings.push(arg.slice(2));
		} else if (isIn(GIT_GLOBAL_BARE, arg)) {
			call.gitDir ||= arg === "--bare";
		} else {
			return { ...call, problem: refused(`git ${arg} is not an option the fence knows: git reads its options in front of the command exactly, so a word taken for the command could be an option's value`) };
		}
	}
	return { ...call, sub: args[i] ?? "", rest: args.slice(i + 1) };
}

/**
 * Config that bends where a commit or a push goes, makes git run a program or pulls in more config. A fenced session
 * neither writes such a key (`git config`) nor sets it for one command (`-c`, `--config-env`), whatever the subcommand:
 * hooks, remotes, URLs, aliases and credentials; push settings (`push.followTags` sends tags along with the branch);
 * editors, pagers, ssh and proxy commands, fsmonitor, signing programs, diff, merge and filter drivers, help viewers;
 * includes; transports (`ext::` runs a command). Names are case-blind.
 */
const RISKY_CONFIG = new RegExp(
	[
		"core\\.(?:hookspath|fsmonitor|editor|pager|askpass|sshcommand|gitproxy|alternaterefscommand)", "remote\\.", "push\\.", "url\\.", "alias\\.", "credential", "branch\\.[^.]+\\.(?:remote|pushremote)",
		"sequence\\.editor", "pager\\.", "gpg\\.", "filter\\.", "diff\\.external", "diff\\..+\\.(?:command|textconv)$", "merge\\..+\\.driver$", "submodule\\..+\\.update$",
		"uploadpack\\.", "lfs\\.(?:extension|customtransfer)\\.", "man\\.", "browser\\.", "web\\.browser", "help\\.(?:browser|format)", "include\\.", "includeif\\.", "protocol\\.",
	].map(key => `^${key}`).join("|"),
	"i",
);

/**
 * What the environment sets for every git command, as `key=value` like `-c`: `GIT_CONFIG_KEY_<n>` and `_VALUE_<n>` below
 * `GIT_CONFIG_COUNT`, and `GIT_CONFIG_PARAMETERS`, where git keeps what `-c` set for the git processes it starts
 * (`'key=value'` or `'key'='value'`, so each quoted piece is a setting, or the key or value of one).
 */
function environmentSettings(env: Record<string, string | undefined>): string[] {
	const count = Math.max(Math.min(Number.parseInt(env.GIT_CONFIG_COUNT ?? "", 10) || 0, 1024), 0);
	const pairs = Array.from({ length: count }, (_, n) => `${env[`GIT_CONFIG_KEY_${n}`] ?? ""}=${env[`GIT_CONFIG_VALUE_${n}`] ?? ""}`);
	return [...pairs, ...[...(env.GIT_CONFIG_PARAMETERS ?? "").matchAll(/'([^']*)'/g)].map(piece => piece[1] as string)];
}

const PUSH_VALUE_FLAGS = names("--recurse-submodules", "--repo", "--receive-pack", "--exec", "-o", "--push-option");
const PUSH_OK_LONG = names(
	"--set-upstream", "--porcelain", "--quiet", "--verbose", "--dry-run", "--atomic", "--no-atomic", "--progress",
	"--no-progress", "--no-follow-tags", "--thin", "--no-thin", "--signed", "--no-signed", "--ipv4", "--ipv6",
	"--recurse-submodules", "--no-recurse-submodules",
);
const PUSH_OK_SHORT = names("-u", "-q", "-v", "-n", "-4", "-6");

/** `p` from `dir`, walked as the kernel does: a `..` after a symlink leaves the link's target, which `path.resolve` can't know. */
const walk = (dir: string, p: string): string => canonical(path.isAbsolute(p) ? p : `${dir}${path.sep}${p}`);

/** The folder a git call runs in: its `-C` folders, each taken from the one before it, from `cwd`. */
const workDir = (dirs: string[], cwd: string): string => dirs.reduce(walk, cwd);

/** The `src` of each refspec a `git push` argv names, after its flags: `HEAD:x` gives `HEAD`, `x` gives `x`. */
function pushSources(pushArgs: string[]): string[] {
	const [, ...refspecs] = parse(pushArgs, PUSH_VALUE_FLAGS).positionals;
	return refspecs.map(spec => (spec.includes(":") ? spec.slice(0, spec.indexOf(":")) : spec).replace(/^\+/, "") || "HEAD");
}

/**
 * What a `git push` argv comes to, for the checks that ask real git: the folder it runs in, the `src` of each refspec,
 * and the argv that lists the refs it would update (`git push --dry-run --porcelain`, hooks skipped, with the same
 * `-c` settings and the flags that decide which refs go). Null when `args` is no push.
 */
export function readPush(args: string[], cwd: string): { dir: string; sources: string[]; listing: string[] } | null {
	const call = readGit(args);
	if (call.sub !== "push") return null;
	const f = parse(call.rest, PUSH_VALUE_FLAGS);
	const decide = ["--no-follow-tags", "-4", "-6", "--ipv4", "--ipv6"].filter(flag => has(f, flag));
	const config = [...call.settings.flatMap(setting => ["-c", setting]), ...call.configEnv.flatMap(setting => ["--config-env", setting])];
	return { dir: workDir(call.dirs, cwd), sources: pushSources(call.rest), listing: [...config, "push", "--dry-run", "--porcelain", "--no-verify", ...decide, ...f.positionals] };
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

/** git config's options that take a value (`--name=v` or `--name v`), that read and that write; git reads any prefix of a name that is not ambiguous. */
const CONFIG_VALUE_OPTIONS = ["--file", "--blob", "--type", "--default", "--comment", "--value"];
const CONFIG_READ_OPTIONS = ["--get", "--get-all", "--get-regexp", "--get-urlmatch", "--list", "--get-color", "--get-colorbool"];
const CONFIG_WRITE_OPTIONS = ["--add", "--replace-all", "--unset", "--unset-all", "--remove-section"];

/** Whether `name` is a prefix, of at least `least` characters, of one of the options in `full`: git reads any prefix of an option's name that is not ambiguous. */
const abbreviates = (name: string, full: string[], least = 4) => name.length >= least && full.some(option => option.startsWith(name));

const CONFIG_EDITOR = refused("git config --edit opens an editor on the config file, and what it saves can't be checked");
const CONFIG_RENAME = refused("git config rename-section is refused: a section renamed to a risky one carries its keys along");

/** Why a `git config` call is refused: it opens an editor on the config, renames a section, or writes a key that runs a program or reads more config. */
function checkConfig(args: string[]): string | null {
	/** Every word that is not an option, an option's value included, so that no spelling hides a key; and `rest`, the words no option took. */
	const words: string[] = [];
	const rest: string[] = [];
	let reads = false;
	let writes = false;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i] as string;
		if (arg === "--") {
			words.push(...args.slice(i + 1));
			rest.push(...args.slice(i + 1));
			break;
		}
		if (arg.startsWith("--")) {
			const eq = arg.indexOf("=");
			const name = eq < 0 ? arg : arg.slice(0, eq);
			if (abbreviates(name, ["--edit"])) return CONFIG_EDITOR;
			if (abbreviates(name, ["--rename-section"])) return CONFIG_RENAME;
			reads ||= abbreviates(name, CONFIG_READ_OPTIONS);
			writes ||= abbreviates(name, CONFIG_WRITE_OPTIONS);
			if (eq >= 0) words.push(arg.slice(eq + 1));
			else if (abbreviates(name, CONFIG_VALUE_OPTIONS, 3)) words.push(args[++i] ?? "");
		} else if (arg.startsWith("-") && arg.length > 1) {
			for (let j = 1; j < arg.length; j++) {
				if (arg[j] === "e") return CONFIG_EDITOR;
				if (arg[j] === "l") reads = true;
				if (arg[j] === "f") {
					words.push(arg.slice(j + 1) || (args[++i] ?? ""));
					break;
				}
			}
		} else {
			words.push(arg);
			rest.push(arg);
		}
	}
	// `git config set|unset KEY` (git 2.46+) or the classic `git config KEY VALUE` / `--unset KEY`; a lone `git config KEY` reads it.
	const [verb = ""] = rest;
	if (verb === "edit") return CONFIG_EDITOR;
	if (verb === "rename-section") return CONFIG_RENAME;
	const writing = ["set", "unset", "remove-section"].includes(verb) || writes || (rest.length >= 2 && !reads && verb !== "get" && verb !== "list");
	const key = writing ? words.find(word => RISKY_CONFIG.test(word)) : undefined;
	return key === undefined ? null : refused(`git config ${key} is refused: hooks and remotes stay as configured, and so do push settings and anything that runs a program or reads more config`);
}

/** Whether `p`, absolute, is or lies inside a git folder: any `.git`, or one of `gitDirs`. Case-blind, as macOS is. */
function inGitFolder(p: string, gitDirs: string[]): boolean {
	const low = p.toLowerCase();
	return low.split(path.sep).includes(".git") || gitDirs.some(dir => low === dir.toLowerCase() || low.startsWith(`${dir.toLowerCase()}${path.sep}`));
}

/** Where a git subcommand takes a path it creates, fills or reads by name. */
interface PathArgs {
	/** Options whose value is a path. A long one also stands for any prefix of it, as git reads `--pre=x` for `--prefix=x`. */
	options?: string[];
	/** The positionals that are paths: all of them, or those after one of these verbs (`bundle create FILE`). */
	positionals?: true | string[];
}

/** diff's `--output=<file>`, which every command that shows a diff takes. */
const DIFF_OUTPUT: PathArgs = { options: ["--output"] };
/**
 * Only the words git treats as paths are judged against the git folders, so a pattern, a message or a revision may say
 * `.git` freely: the files and folders a subcommand writes or fills, where it moves or clones to, and the few options
 * that read one (`commit -F`, `--template`).
 */
const PATH_ARGS: Record<string, PathArgs> = {
	am: { options: ["--directory"] },
	apply: { options: ["--directory", "--build-fake-ancestor"] },
	archive: { options: ["--output", "-o", "--prefix"], positionals: true },
	bundle: { positionals: ["create"] },
	"checkout-index": { options: ["--prefix"], positionals: true },
	clone: { options: ["--template", "--separate-git-dir"], positionals: true },
	commit: { options: ["--file", "-F", "--template"] },
	config: { options: ["--file", "-f"] },
	diff: DIFF_OUTPUT, "diff-files": DIFF_OUTPUT, "diff-index": DIFF_OUTPUT, "diff-tree": DIFF_OUTPUT, log: DIFF_OUTPUT,
	"range-diff": DIFF_OUTPUT, reflog: DIFF_OUTPUT, show: DIFF_OUTPUT, stash: DIFF_OUTPUT, whatchanged: DIFF_OUTPUT,
	"fast-export": { options: ["--export-marks"] },
	"format-patch": { options: ["--output", "--output-directory", "-o"], positionals: true },
	gc: { options: ["--expire-to"] },
	init: { positionals: true },
	"interpret-trailers": { positionals: true },
	mailinfo: { positionals: true },
	mailsplit: { options: ["-o"] },
	"merge-file": { positionals: true },
	mv: { positionals: true },
	"read-tree": { options: ["--prefix", "--index-output"] },
	repack: { options: ["--expire-to", "--filter-to"] },
	rm: { positionals: true },
	submodule: { positionals: ["add"] },
	worktree: { positionals: ["add", "move"] },
};

/** Every value `options` take in `args`, each occurrence counted: `--name=v`, `--name v`, `-Xv` or `-X v`. A long name stands for any prefix of it, a short one may sit anywhere in a bundle (`-qo v`), and `--` ends the options. */
function optionValues(args: string[], options: string[]): string[] {
	const values: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i] as string;
		if (arg === "--") break;
		if (arg.startsWith("--")) {
			const eq = arg.indexOf("=");
			const name = eq < 0 ? arg : arg.slice(0, eq);
			if (options.some(o => o.startsWith(name))) values.push(eq < 0 ? (args[++i] ?? "") : arg.slice(eq + 1));
		} else if (arg.startsWith("-")) {
			for (let j = 1; j < arg.length; j++) {
				if (!options.includes(`-${arg[j]}`)) continue;
				values.push(arg.slice(j + 1) || (args[++i] ?? ""));
				break;
			}
		}
	}
	return values;
}

/** The words of `rest` that `sub` takes as paths. */
function pathWords(sub: string, rest: string[]): string[] {
	const spec = Object.hasOwn(PATH_ARGS, sub) ? PATH_ARGS[sub] : undefined;
	if (spec === undefined) return [];
	const [verb = "", ...others] = parse(rest, {}).positionals;
	const positionals = spec.positionals === true ? [verb, ...others] : spec.positionals?.includes(verb) ? others : [];
	return [...optionValues(rest, spec.options ?? []), ...positionals];
}

/**
 * Why a git argv would write into a git folder, where hooks, config and refs live: it runs in one, or one of the paths
 * `named` (global options and config values) or `sub` takes lies inside one. Relative paths run from `dir`; symlinks are followed.
 */
function checkGitFolder(sub: string, rest: string[], named: string[], dir: string, policy: GitPolicy): string | null {
	if (inGitFolder(dir, policy.gitDirs)) return refused(`git runs in the work tree, not in the git folder ${dir}`);
	const word = [...named, ...pathWords(sub, rest)].find(p => p !== "" && [path.resolve(dir, p), walk(dir, p)].some(form => inGitFolder(form, policy.gitDirs)));
	return word === undefined ? null : refused(`git takes ${word} as a path inside a git folder, where hooks and config live`);
}

/** Refs only a fetch from the remote may set: remote-tracking refs, which a push check could be fooled by, and replacement refs, which change what git reads. */
const FETCH_ONLY_REFS = /^(?:(?:refs\/)?remotes|refs\/replace)\//i;
/** git init's options a fenced session may use. --template and --separate-git-dir are left out: they copy files into the git folder or move it. */
const INIT_OK = names("-q", "--quiet", "--bare", "--shared", "-b", "--initial-branch", "--object-format", "--ref-format");
const INIT_VALUE_FLAGS = names("-b", "--initial-branch", "--object-format", "--ref-format");

const C_ESCAPES: Record<string, string> = { n: "\n", t: "\t", a: "\x07", b: "\b", f: "\f", r: "\r", v: "\v" };
/** C-style quoting in a patch header: git quotes a name with unusual characters, and `\056` is a dot. */
const unquote = (quoted: string): string => quoted.replace(/\\(?:([0-7]{1,3})|(.))/g, (_, octal: string | undefined, char: string) => (octal ? String.fromCharCode(Number.parseInt(octal, 8)) : (C_ESCAPES[char] ?? char)));

/** The names a patch header line gives to files. */
function headerPaths(line: string): string[] {
	const one = /^(?:--- |\+\+\+ |rename (?:from|to) |copy (?:from|to) )(.*)$/.exec(line)?.[1];
	if (one !== undefined) {
		const name = one.startsWith('"') ? unquote(one.slice(1, one.lastIndexOf('"') > 0 ? one.lastIndexOf('"') : undefined)) : (one.split("\t")[0] as string);
		return name === "/dev/null" ? [] : [name];
	}
	// `diff --git a/x b/y`: each name quoted or up to the next space, so a name with spaces is read as pieces and any of them may give it away.
	return [...(line.startsWith("diff --git ") ? line.slice("diff --git ".length).matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g) : [])].map(m => (m[1] === undefined ? (m[2] as string) : unquote(m[1])));
}

/**
 * A name in the patch file `file` that is, or lies inside, a git folder, at any `-p` strip level and under any of
 * `bases`: git itself turns away a path with a `.git` part, but not a git folder with another name. Undefined when
 * `file` is not a readable file; git says why.
 */
function patchGitPath(file: string, bases: string[], policy: GitPolicy): string | undefined {
	let patch: string;
	try {
		if (!fs.statSync(file).isFile()) return undefined;
		patch = fs.readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
	for (const line of patch.split("\n")) {
		for (const named of headerPaths(line)) {
			const parts = named.split("/");
			for (let strip = 0; strip < parts.length; strip++) {
				const stripped = parts.slice(strip).join("/");
				if (bases.some(base => inGitFolder(path.resolve(base, stripped), policy.gitDirs))) return named;
			}
		}
	}
	return undefined;
}

/** lfs commands that write or remove the repo's hooks. */
const LFS_HOOKS = names("install", "update", "uninstall");

/** Why a subcommand's own options would write where /ship may not send it: files into a git folder, or a ref only a fetch from the remote may set. */
function checkSubcommandWrites(sub: string, rest: string[], dir: string, policy: GitPolicy): string | null {
	if (sub === "init") {
		const f = parse(rest, INIT_VALUE_FLAGS);
		const flag = [...f.long.keys(), ...f.short].find(name => !isIn(INIT_OK, name));
		if (flag !== undefined) return refused(`git init ${flag} is refused: init takes only -q, --bare, -b, --object-format, --ref-format and --shared`);
		// Running init again in a repo copies the templates, hooks included, into its git folder: from --template, -c init.templateDir or GIT_TEMPLATE_DIR alike.
		const target = walk(dir, f.positionals[0] ?? ".");
		if (fs.existsSync(path.join(target, ".git")) || ["HEAD", "objects", "refs"].every(name => fs.existsSync(path.join(target, name)))) return refused(`git init in ${target} is refused: it holds a repo already, and init would copy templates, hooks included, into it`);
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
	if (sub === "apply") {
		const f = parse(rest, {});
		// --unsafe-paths lets a patch write outside the work tree, `.git` included; git reads any prefix of the name.
		if ([...f.long.keys()].some(name => name.length >= 3 && "--unsafe-paths".startsWith(name))) return refused("git apply --unsafe-paths is refused: it lets a patch write outside the work tree, a git folder included");
		const bases = [dir, ...optionValues(rest, ["--directory"]).map(root => path.resolve(dir, root))];
		for (const file of f.positionals.filter(word => word !== "-")) {
			const named = patchGitPath(path.resolve(dir, file), bases, policy);
			if (named !== undefined) return refused(`git apply ${file} names ${named}, a path inside a git folder, where hooks and config live`);
		}
	}
	if (sub === "lfs") {
		const verb = rest.find(word => !word.startsWith("-")) ?? "";
		if (isIn(LFS_HOOKS, verb)) return refused(`git lfs ${verb} is refused: it writes or removes the repo's hooks`);
	}
	return null;
}

/** Subcommands that run hooks, which `--no-verify` skips. (`push` takes only the flags it is allowed, and this is not one.) */
const HOOKED = names("commit", "merge", "pull", "am", "rebase");
/** git reads a long option by any prefix of its name that isn't ambiguous, so `--no-veri` is `--no-verify`. From `--no-v` a prefix is that option or an error to git, and refused alike. */
const NO_VERIFY = "--no-verify";
/** `commit`'s options that take a value, as the next word or the rest of a short bundle: `-mnew` is a message, not `-n`. */
const COMMIT_VALUE_SHORT = "mFCct";
const COMMIT_VALUE_LONG = names("--message", "--file", "--reuse-message", "--reedit-message", "--template", "--author", "--date", "--cleanup", "--fixup", "--squash", "--trailer", "--pathspec-from-file");

/** Whether the words after `commit`, `merge`, `pull`, `am` or `rebase` ask git to skip its hooks: `--no-verify` by any prefix git reads for it, or `-n` on a commit or an am. */
function skipsHooks(sub: string, rest: string[]): boolean {
	for (let i = 0; i < rest.length; i++) {
		const arg = rest[i] as string;
		if (arg === "--") return false;
		if (arg.startsWith("--")) {
			const eq = arg.indexOf("=");
			const name = eq < 0 ? arg : arg.slice(0, eq);
			if (name.length >= "--no-v".length && NO_VERIFY.startsWith(name)) return true;
			if (sub === "commit" && eq < 0 && isIn(COMMIT_VALUE_LONG, name)) i++;
		} else if (arg.startsWith("-") && (sub === "commit" || sub === "am")) {
			// git reads a short bundle option by option: the first that takes a value takes the rest of the bundle, or the next word.
			for (let j = 1; j < arg.length; j++) {
				const flag = arg[j] as string;
				if (flag === "n") return true;
				if (sub !== "commit") continue;
				if (COMMIT_VALUE_SHORT.includes(flag)) {
					if (j === arg.length - 1) i++;
					break;
				}
				if (flag === "u" || flag === "S") break;
			}
		}
	}
	return false;
}

/** `git remote` subcommands that change where the remotes point. */
const REMOTE_CHANGES = names("add", "set-url", "rename", "remove", "rm");

/** `args` is git's argv without the program name; `env` is what the call runs with, which `--config-env` reads its values from. */
export function checkGit(args: string[], policy: GitPolicy, cwd: string, env: Record<string, string | undefined> = {}): string | null {
	const call = readGit(args);
	if (call.problem !== null) return call.problem;
	const { sub, rest } = call;
	if (sub !== "" && !isIn(GIT_COMMANDS, sub)) return refused(`git ${sub} is not a git command the fence allows`);
	const dir = workDir(call.dirs, cwd);
	/** What `-c` and the environment set: `key=value`. */
	const settings = [...call.settings, ...environmentSettings(env)];
	const risky = [...settings, ...call.configEnv].map(setting => setting.split("=", 1)[0] as string).find(key => RISKY_CONFIG.test(key));
	if (risky !== undefined) return refused(`${risky} can't be set for one command (-c, --config-env, GIT_CONFIG_*): hooks and remotes stay as configured, and so do push settings and anything that runs a program or reads more config`);
	// Any config value may be a path (core.worktree, format.outputDirectory, trace2.eventTarget); a --config-env value is what its variable holds.
	const configPaths = [...settings.map(s => s.slice(s.indexOf("=") + 1)), ...call.configEnv.map(s => env[s.slice(s.indexOf("=") + 1)] ?? "")];
	const writes = checkGitFolder(sub, rest, [...call.named, ...configPaths], dir, policy) ?? checkSubcommandWrites(sub, rest, dir, policy);
	if (writes !== null) return writes;
	// The push check reads the repo the shim runs in; --git-dir would point the push at another one.
	if (sub === "push" && call.gitDir) return refused("git push --git-dir (or --bare) is refused: push from the repo itself");
	if (sub === "push") return checkPush(rest, policy);
	if (isIn(HOOKED, sub) && skipsHooks(sub, rest)) return refused(`${sub} keeps its hooks: drop --no-verify / -n`);
	// `git remote -v set-url …`: the subcommand is the first word that is no option.
	const verb = sub === "remote" ? (parse(rest, {}).positionals[0] ?? "") : "";
	if (isIn(REMOTE_CHANGES, verb)) return refused(`git remote ${verb} is refused`);
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
