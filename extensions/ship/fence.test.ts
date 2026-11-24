import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { checkCommentBody, checkGh, checkGit, type GitPolicy, isProtectedPath, MARKER, readPush } from "./fence";

const policy: GitPolicy = { pushBranch: "feat/ship-s1", gitDirs: ["/repo/.git", "/main/.git", "/data/app-gitdir"] };
const words = (line: string) => line.split(" ").filter(Boolean);
const gh = (line: string) => checkGh(words(line));
const git = (line: string, p: GitPolicy = policy, cwd = "/repo") => checkGit(words(line), p, cwd);
const comment = (text: string) => `${MARKER}\n${text}`;

describe("gh", () => {
	test("reads and /ship's own writes pass", () => {
		for (const line of ["pr view 5 --json url,state", "pr checks 5", "pr create --draft --title t --body b", "pr create -d -f", "pr edit 5 --body new", "run view 123 --log-failed", "run rerun 123 --failed", "auth status", "auth token -u blindx-tony-do", "secret list", "-R owner/repo pr view 5", ""]) {
			expect(gh(line)).toBeNull();
		}
		expect(checkGh(["pr", "comment", "5", "--body", comment("Fixed the failing test.")])).toBeNull();
		expect(checkGh(["api", "repos/o/r/issues/5/comments", "-f", `body=${comment("Done.")}`])).toBeNull();
		expect(checkGh(["api", "-X", "POST", "repos/o/r/pulls/5/comments/9/replies", "--raw-field", `body=${comment("Done.")}`])).toBeNull();
		expect(gh("api --method POST repos/o/r/pulls/5/requested_reviewers -f reviewers[]=x")).toBeNull();
		expect(checkGh(["api", "graphql", "-f", "query=mutation($t:ID!){resolveReviewThread(input:{threadId:$t}){thread{isResolved}}}", "-f", "t=X"])).toBeNull();
	});

	test("merging, approving, undrafting, closing and settings are refused", () => {
		for (const line of ["pr merge 5 --squash", "pr merge --auto 5", "pr review 5 --approve", "pr ready 5", "pr close 5", "--repo o/r pr merge 5", "pr -R o/r merge 5", "repo delete o/r --yes", "secret set TOKEN", "alias set m 'pr merge'", "extension install foo/bar", "auth login", "workflow run deploy.yml", "release create v1", "release new v1", "m 5"]) {
			expect(gh(line)).toContain("ship fence");
		}
		expect(gh("pr create --title t --body b")).toContain("as a draft");
		expect(gh("pr edit 5 --base main")).toContain("base");
	});

	test("gh api writes other than comments, replies and re-requests are refused", () => {
		for (const line of ["api -X PUT repos/o/r/pulls/5/merge", "api -XPUT repos/o/r/pulls/5/merge", "api repos/o/r/pulls/5/reviews -f event=APPROVE", "api -X PATCH repos/o/r/pulls/5 -f draft=false", "api -X DELETE repos/o/r/git/refs/heads/main"]) {
			expect(gh(line)).toContain("is refused");
		}
		expect(checkGh(["api", "graphql", "-f", "query=mutation { mergePullRequest(input:{}) { clientMutationId } }"])).toContain("mutations");
		expect(gh("api graphql -F query=@q.graphql")).toContain("from a file");
	});

	test("a comment must carry the marker and nothing that pings, links or closes", () => {
		expect(checkGh(["pr", "comment", "5", "--body", "Fixed it."])).toContain(MARKER);
		expect(checkGh(["pr", "comment", "5", "--body-file", "c.md"])).toContain("--body");
		expect(checkGh(["api", "repos/o/r/issues/5/comments", "-F", "body=@c.md"])).toContain("from a file");
		expect(checkGh(["api", "repos/o/r/issues/5/comments", "-f", "title=x"])).toContain("one body field");
		expect(checkCommentBody(comment("Thanks @alice, fixed."))).toContain("@-mentions");
		expect(checkCommentBody(comment("See https://example.com"))).toContain("links");
		expect(checkCommentBody(comment("This fixes #12."))).toContain("closing keyword");
		expect(checkCommentBody(comment("Closes owner/repo#12"))).toContain("closing keyword");
		expect(checkCommentBody(comment("ok <!-- hidden -->"))).toContain("HTML comment");
		expect(checkCommentBody(comment("x".repeat(8000)))).toContain("8,000");
		expect(checkCommentBody(comment("Fixed in abc1234; email me at a@b.c is not a mention."))).toBeNull();
	});

	test("gh api sends the last of -X and --method, in any spelling", () => {
		const merge = "repos/o/r/pulls/5/merge";
		for (const line of [
			`api -X GET --method PUT ${merge}`, `api --method GET -X PUT ${merge}`, `api -X GET -X PUT ${merge}`, `api --method=GET --method=PUT ${merge}`, `api -XGET -XPUT ${merge}`, `api -X=GET -X=PUT ${merge}`,
			`api ${merge} -X GET -X PUT`, `api -X get -X put ${merge}`, `api -i -X GET -XPUT ${merge}`, `api -iX PUT ${merge}`, "api -X GET --method=DELETE repos/o/r/git/refs/heads/x",
		]) {
			expect(gh(line), line).toContain("is refused");
		}
		for (const line of ["api -X PUT -X GET repos/o/r/pulls/5", "api --method=PUT -XGET repos/o/r/pulls/5", "api -X=PUT --method GET repos/o/r/pulls/5", "api -iX GET repos/o/r/pulls/5"]) expect(gh(line), line).toBeNull();
		expect(gh("api --no-such-flag repos/o/r/pulls/5")).toContain("not a flag the fence knows");
	});

	test("gh pr create is a draft only when the last --draft or -d is on, as strconv.ParseBool reads it, and no value flag has taken the word", () => {
		const make = "--title t --body b";
		for (const draft of ["--draft=0", "--draft=f", "--draft=F", "--draft=false", "--draft=False", "--draft=FALSE", "--draft=bogus", "--draft=", "--draft=tRUE", "--draft=yes", "-d=false", "-d=0", "-d=f", "-d=no", "--draft --draft=false", "-d -d=0", "--draft -d=f", "--draft=0 --draft=F", "--draft=true --draft=0"]) {
			expect(gh(`pr create ${draft} ${make}`), draft).toContain("as a draft");
		}
		// A value flag takes the next word, a dash or not: none of these has a --draft.
		for (const line of [
			"pr create -tdraft --body b", "pr create -t --draft --body b", "pr create --title --draft --body b", "pr create -b --draft --title t", "pr create --title=t --body --draft", "pr create -Bd --title t", "pr create -rd --title t",
			"pr create -fl d --title t", "pr create -lad", "pr create -T --draft", "pr create --template --draft", "pr create --assignee --draft", "pr create --label --draft", "pr create --reviewer --draft", "pr create --milestone --draft",
			"pr create --project --draft", "pr create --head --draft", "pr create --body-file --draft", "pr create --attach --draft", "pr create --recover --draft", "pr create --title t --body b",
		]) {
			expect(gh(line), line).toContain("as a draft");
		}
		for (const draft of ["--draft", "-d", "--draft=true", "--draft=1", "--draft=t", "--draft=T", "--draft=TRUE", "--draft=True", "-d=true", "-d=1", "--draft=false --draft", "-d=0 -d", "-d --draft=T"]) {
			expect(gh(`pr create ${draft} ${make}`), draft).toBeNull();
		}
		for (const line of [
			"pr create -fd", "pr create -df", "pr create -d -f", "pr create -fdw", "-R o/r pr create --draft --fill", "pr create --repo o/r --draft --head b --title t --body body", "pr -R o/r create --draft --fill", "pr create -tx -b y -B main -d",
			"pr create --title --draft --draft --body b",
		]) {
			expect(gh(line), line).toBeNull();
		}
		expect(gh("pr create --draft --no-such-flag")).toContain("not a flag the fence knows");
	});

	test("a flag in front of gh's command words is refused: cobra takes the next word as its value and finds the command past it", () => {
		for (const line of [
			"pr -t x merge 5", "pr --subject x merge 5", "pr -b x review 5 --approve", "pr -c x close 5", "-p pr -p pr api repos/o/r/pulls/5/merge -X PUT", "-q pr pr merge 5", "--jq x pr merge 5", "-X POST pr create", "-t x pr merge", "-i -t x pr merge 5",
		]) {
			expect(gh(line), line).toContain("in front of gh's command words");
		}
		// The repo and host flags, which the command words may have between them, and what has no command to tell apart.
		for (const line of [
			"-R o/r pr view 7", "pr -R o/r view 7", "--repo=o/r pr view 7", "-Ro/r pr view 7", "-R=o/r pr view 7", "pr view 7 -R o/r", "--hostname github.com api user", "--hostname=github.com api user", "--version", "--help", "pr --help", "status -o org",
			"browse -n", "search prs --limit 5 x", "api -X POST repos/o/r/issues/7/comments -f body=x",
		]) {
			expect(gh(line) ?? "allowed", line).not.toContain("in front of gh's command words");
		}
		expect(gh("-R o/r pr -R o/r merge 5")).toContain("gh pr merge is refused");
	});

	test("a GraphQL query read from a file is refused under every spelling of the flag, and resolving a thread is allowed under any", () => {
		for (const args of [
			["-Fquery=@q.gql"], ["--field=query=@q.gql"], ["-F", "query=@q.gql"], ["--field", "query=@q.gql"], ["-F=query=@q.gql"], ["-F", "query=@-"], ["-f", "query=@q.gql"], ["--input", "q.json"], ["-F", "x=1", "-Fquery=@q.gql"],
		]) {
			expect(checkGh(["api", "graphql", ...args]), args.join(" ")).toContain("from a file");
		}
		const mutation = 'mutation{mergePullRequest(input:{pullRequestId:"x"}){clientMutationId}}';
		for (const args of [[`-fquery=${mutation}`], [`--raw-field=query=${mutation}`], ["-f", `query=${mutation}`], ["-F", `query=${mutation}`], [`-F=query=${mutation}`], ["-f", `query=${mutation}`, "-f", "x=y"]]) {
			expect(checkGh(["api", "graphql", ...args]), args.join(" ")).toContain("mutations");
		}
		const resolve = "mutation($t:ID!){resolveReviewThread(input:{threadId:$t}){thread{isResolved}}}";
		for (const args of [["-f", `query=${resolve}`, "-f", "t=X"], [`-fquery=${resolve}`, "-ft=X"], [`--raw-field=query=${resolve}`, "-F", "t=X"], ["-F", `query=${resolve}`, "-F", "t=X"]]) {
			expect(checkGh(["api", "graphql", ...args]), args.join(" ")).toBeNull();
		}
		expect(checkGh(["api", "graphql", "-f", "query=query{viewer{login}}", "-F", "n=7"])).toBeNull();
	});

	test("a comment is the last --body or -b gh is given, so an earlier one can't stand in for it", () => {
		const good = comment("Fixed the failing test.");
		for (const args of [
			["-b", good, "--body", "see https://x.example"], ["--body", good, "-b", "plain"], [`--body=${good}`, "--body=@someone"], ["-b=plain"], ["-b", good, "-b", "fixes #3"],
		]) {
			for (const group of ["pr", "issue"]) expect(checkGh([group, "comment", "7", ...args]), `${group} ${args.join(" ")}`).toContain("ship fence");
		}
		for (const args of [["--body", "plain", "-b", good], [`--body=${good}`], [`-b=${good}`], ["-b", good, "-R", "o/r"], [`-b${good}`], ["--edit-last", "-b", good]]) {
			expect(checkGh(["pr", "comment", "7", ...args]), args.join(" ")).toBeNull();
		}
		expect(checkGh(["pr", "comment", "7", "--body", good, "--no-such-flag"])).toContain("not a flag the fence knows");
	});
});

describe("git", () => {
	test("pushes only the watched branch to origin", () => {
		for (const line of ["push origin feat/ship-s1", "push -u origin feat/ship-s1", "push origin HEAD:refs/heads/feat/ship-s1", "-C /tmp/wt push --porcelain origin feat/ship-s1"]) {
			expect(git(line)).toBeNull();
		}
		for (const line of ["push --force origin feat/ship-s1", "push -uf origin feat/ship-s1", "push --force-with-lease origin feat/ship-s1", "push origin +feat/ship-s1", "push origin :feat/ship-s1", "push --delete origin feat/ship-s1", "push origin main", "push origin feat/ship-s1:main", "push --tags origin feat/ship-s1", "push -o merge_request.merge_when_pipeline_succeeds origin feat/ship-s1", "push --no-verify origin feat/ship-s1", "push upstream feat/ship-s1", "push", "-c core.hooksPath=/dev/null push origin feat/ship-s1"]) {
			expect(git(line)).toContain("ship fence");
		}
		expect(git("push origin feat/ship-s1", { ...policy, pushBranch: null })).toContain("pushes nothing");
		for (const line of ["--git-dir=/tmp/y/gd push origin feat/ship-s1", "--git-dir /tmp/y/gd push origin feat/ship-s1", "-C /tmp/wt --git-dir=x push origin feat/ship-s1"]) expect(git(line)).toContain("--git-dir");
		expect(git("--git-dir=/tmp/y/gitdir status")).toBeNull();
	});

	test("commits keep their hooks and origin stays where it points", () => {
		expect(git("commit -m msg")).toBeNull();
		expect(git("commit --no-verify -m msg")).toContain("hooks");
		expect(git("commit -nm msg")).toContain("hooks");
		for (const line of ["remote set-url origin git@x:y", "config remote.origin.url git@x:y", "config --unset core.hooksPath"]) expect(git(line)).toContain("is refused");
		for (const line of ["status", "remote -v", "config --get remote.origin.url", "fetch origin", "merge --no-edit origin/main"]) expect(git(line)).toBeNull();
	});

	test("stock read and local commands run while armed", () => {
		for (const line of ["archive HEAD", "archive --format=tar HEAD -o /tmp/x.tar", "ls-tree -r HEAD", "diff-index HEAD", "update-ref refs/x HEAD", "write-tree", "whatchanged"]) expect(git(line)).toBeNull();
	});

	test("git that would write into a git folder is refused, however the path is spelled", () => {
		for (const line of [
			"diff --output=.git/hooks/pre-commit HEAD~1", "diff --output .git/hooks/pre-commit HEAD~1", "log --output=./.git/hooks/x",
			"archive -o .git/hooks/pre-commit HEAD", "archive -o.git/hooks/pre-commit HEAD", "archive --output=.git/hooks/pre-commit HEAD",
			"checkout-index --prefix=.git/hooks/ -a", "bundle create .git/hooks/x HEAD", "format-patch -o .git/hooks HEAD~1", "merge-file .git/hooks/x a b",
			"bundle create sub/../.git/hooks/x HEAD", "archive -o .GIT/hooks/x HEAD", "archive -o /repo/.git/hooks/x HEAD",
			"archive -o /main/.git/hooks/x HEAD", "archive -o /elsewhere/clone/.git/hooks/x HEAD", "archive -o /data/app-gitdir/hooks/x HEAD",
			"-C .git/hooks status", "-C sub archive -o ../.git/hooks/x HEAD", "--work-tree=.git/hooks checkout HEAD -- src/a.ts", "--work-tree .git/hooks checkout HEAD -- src/a.ts",
			"-c core.worktree=.git/hooks checkout HEAD -- src/a.ts",
		]) {
			expect(git(line)).toContain("git folder");
		}
		expect(git("archive -o x HEAD", policy, "/repo/.git/hooks")).toContain("git folder");
		expect(git("status", policy, "/data/app-gitdir")).toContain("git folder");
		for (const line of ["init --template=/tmp/tpl", "init --templ /tmp/tpl", "init --separate-git-dir=/tmp/gd new", "init --bogus"]) expect(git(line)).toContain("git init");
		for (const line of [
			"archive --format=tar HEAD -o /tmp/x.tar", "diff --output=/tmp/d.patch HEAD~1", "checkout-index --prefix=/tmp/out/ -a", "bundle create /tmp/x.bundle HEAD",
			"format-patch -o /tmp/patches HEAD~1", "add .gitignore", "diff -- .github/workflows/ci.yml", "log -- .gitattributes", "-C sub archive -o out.tar HEAD",
			"init", "init --bare /tmp/new.git", "init -q /tmp/new", "init -b main /tmp/new", "init --initial-branch=main", "init --object-format=sha256 /tmp/new",
		]) {
			expect(git(line)).toBeNull();
		}
		expect(checkGit(["commit", "-m", ".gitignore: add build"], policy, "/repo")).toBeNull();
		expect(checkGit(["commit", "-m", "docs: why .git stays out of the tree"], policy, "/repo")).toBeNull();
	});

	test("every command and option that creates or fills a file at a path it is given is held to the git-folder rule, by whatever spelling", () => {
		for (const line of [
			// Positionals that are files or folders git writes: the name of a file it fills, a place it moves to or clones into.
			"mailinfo .git/hooks/pre-commit /tmp/patch", "mailinfo /tmp/msg .git/hooks/pre-commit", "mv a.sh .git/hooks/pre-commit", "mv -f a.sh .git/hooks/pre-commit", "mv -- a.sh .git/hooks/pre-commit", "rm -f .git/hooks/pre-commit", "rm -- .git/hooks/pre-commit",
			"clone /tmp/hooks-repo .git/hooks", "clone --depth 1 /tmp/r .git/hooks", "init .git/hooks/x", "worktree add .git/hooks/wt", "worktree add -b x .git/hooks/wt",
			"worktree move wt .git/hooks/wt", "submodule add /tmp/r .git/hooks/s", "submodule --quiet add /tmp/r .git/hooks/s", "interpret-trailers --in-place --trailer k:v .git/hooks/pre-commit",
			"archive HEAD .git/hooks/x", "bundle create --version=3 .git/hooks/x HEAD", "checkout-index -a .git/hooks/x", "merge-file -L a -L b .git/hooks/x a b",
			// Options whose value is a path: written, created or, for the few the fence reads as one, named.
			"config --file .git/hooks/pre-push core.x y", "config -f .git/config core.x y", "config --file=.git/config core.x y", "config -f.git/config core.x y", "config core.x y --file .git/config",
			"commit -F .git/hooks/x", "commit -aF .git/x", "commit --file=.git/x", "commit --file .git/x", "format-patch --output-directory=.git/hooks HEAD~1", "format-patch --output-directory .git/hooks HEAD~1",
			"mailsplit -o.git/hooks mbox", "mailsplit -o .git/hooks mbox", "apply --directory=.git/hooks p.patch", "am --directory=.git/hooks p.mbox", "fast-export --export-marks=.git/hooks/x HEAD",
			"read-tree --index-output=.git/hooks/x HEAD", "gc --expire-to=.git/hooks", "repack -d --expire-to=.git/hooks", "clone --template=.git/hooks /tmp/r x",
			// A long option stands for any prefix of it, a short one may sit in a bundle, and every occurrence counts: git creates the file of each --output.
			"checkout-index --pre=.git/hooks/ -a", "checkout-index --prefix .git/hooks/ -a", "archive -vo .git/hooks/x HEAD", "archive -qo.git/hooks/x HEAD",
			"diff --output=/tmp/a --output=.git/hooks/pre-commit", "diff --output=.git/hooks/pre-commit --output=/tmp/a",
			// Config values and global options: any value may be a path (format.outputDirectory, core.worktree, trace2.eventTarget).
			"-c format.outputDirectory=.git/hooks format-patch HEAD~1", "-c trace2.eventTarget=.git/hooks/x status", "-ctrace2.eventTarget=.git/hooks/x status",
			"--git-dir=.git/modules/x status", "--git-dir .git/modules/x status",
		]) {
			expect(git(line) ?? `${line}: allowed`).toContain("git folder");
		}
	});

	test("words git does not take as paths may mention .git: patterns, messages, revisions and config reads", () => {
		for (const args of [
			["grep", "-n", ".git/hooks"], ["grep", "-e", ".git/hooks", "--", "src"], ["grep", "-rnF", "/.git/", "."],
			["log", "-S.git"], ["log", "-S", ".git"], ["log", "-G.git/hooks"], ["log", "--grep=/.git/"], ["log", "--grep", "/.git/", "--oneline"], ["log", "--author=.git"],
			["commit", "-m", "…/.git/…"], ["commit", "-am", "docs: /.git/ stays out"], ["commit", "--message=/.git/hooks"], ["commit", "-m", "a", "-m", ".git/hooks"],
			["-c", "user.name=x", "commit", "-m", "/.git/"], ["tag", "-a", "v1", "-m", "see .git/hooks"], ["notes", "add", "-m", ".git/x"], ["stash", "push", "-m", "/.git/"],
			["diff", "-S.git"], ["show", "HEAD:.gitignore"], ["rev-parse", "--git-dir"], ["rev-parse", "--git-path", "hooks/pre-commit"], ["rev-parse", "--git-common-dir"],
			["config", "--get", "remote.origin.url"], ["config", "user.name", ".git"], ["check-ignore", "-v", ".git/config"], ["status", "--", "/.git/"], ["ls-files", "--directory"],
			// After `--` a word is a file name, not an option; the bundle verbs other than create only read a bundle.
			["diff", "--", "--output=.git/hooks/x"], ["bundle", "verify", ".git/x.bundle"],
		]) {
			expect(checkGit(args, policy, "/repo"), args.join(" ")).toBeNull();
		}
	});

	test("update-ref, fetch and pull leave remote-tracking and replacement refs to a plain fetch from the remote", () => {
		for (const line of [
			"update-ref refs/remotes/origin/feat/ship-s1 HEAD", "update-ref -d refs/remotes/origin/main", "update-ref -m why refs/remotes/origin/HEAD HEAD",
			"update-ref --no-deref refs/remotes/origin/x HEAD", "update-ref refs/REMOTES/origin/x HEAD", "update-ref refs/replace/0123abc HEAD", "update-ref remotes/origin/x HEAD",
			"update-ref --stdin", "update-ref -z --stdin", "update-ref --stdi",
			"fetch . HEAD:refs/remotes/origin/feat/ship-s1", "fetch . +HEAD:refs/remotes/origin/main", "fetch origin main:refs/remotes/origin/feat/ship-s1",
			"fetch origin main:remotes/origin/x", "fetch . refs/heads/*:refs/remotes/origin/*", "fetch . x:refs/replace/y",
			"fetch --refmap=+refs/heads/*:refs/remotes/origin/* . refs/heads/*", "fetch --refmap +refs/heads/*:refs/remotes/origin/* . x",
			"pull . HEAD:refs/remotes/origin/main", "-C /tmp/wt fetch . HEAD:refs/remotes/origin/x",
		]) {
			expect(git(line)).toContain("ship fence");
		}
		expect(git("update-ref refs/remotes/origin/main HEAD")).toContain("refs/remotes/origin/main");
		expect(git("fetch . HEAD:refs/remotes/origin/main")).toContain("refs/remotes/origin/main");
		for (const line of [
			"update-ref refs/heads/x HEAD", "update-ref refs/x HEAD", "update-ref -d refs/heads/x", "update-ref -m why refs/heads/x HEAD", "update-ref HEAD HEAD~1", "update-ref --no-deref HEAD refs/heads/x",
			"fetch", "fetch origin", "fetch origin main", "fetch --all --prune", "fetch -p origin", "fetch --depth 5 origin main", "fetch origin main:other", "fetch origin refs/heads/main",
			"pull origin main", "pull --no-rebase origin main", "remote update", "remote set-head origin --auto",
		]) {
			expect(git(line)).toBeNull();
		}
	});

	test("aliases, hook-skipping merges and config that redirects a push are refused", () => {
		expect(git("p")).toContain("git p is not a git command the fence allows");
		expect(git("-c alias.p=push p origin main")).toContain("git p is not a git command the fence allows");
		expect(git("credential fill")).toContain("not a git command the fence allows");
		expect(git("merge --no-verify origin/main")).toContain("hooks");
		expect(git("-c core.hooksPath=/tmp/h merge origin/main")).toContain("hooks and remotes");
		expect(git("--version")).toBeNull();
	});

	test("git's options in front of the command are read as git reads them: an option's word is not the command, a dash or not, and an option the fence doesn't know is refused", () => {
		expect(readPush(words("-C -c push origin feat/ship-s1"), "/r")).toMatchObject({ dir: "/r/-c" });
		expect(git("-C -c push origin feat/ship-s1")).toBeNull();
		// `status` is the value of --attr-source and --shallow-file, so push is the command, and it is judged.
		for (const line of ["--attr-source status push origin feat/ship-s1", "--shallow-file status push origin feat/ship-s1", "--attr-source=status push origin feat/ship-s1"]) {
			expect(readPush(words(line), "/r"), line).not.toBeNull();
			expect(git(line), line).toBeNull();
		}
		for (const line of ["--attr-source status push origin main", "--shallow-file status push --force origin feat/ship-s1", "--attr-source=HEAD push origin main", "-C -c push origin main", "-C x -C -c push --tags origin feat/ship-s1"]) {
			expect(git(line), line).toContain("ship fence");
		}
		for (const line of ["--no-such-option status", "--shallow-file=x status", "-Cdir status", "--git-direct=x status", "-- status", "--no-pager --bogus log", "--super-pref x status"]) {
			expect(git(line) ?? `${line}: allowed`, line).toContain("is not an option the fence knows");
		}
		for (const line of [
			"--no-pager log", "-P log", "-p log", "--paginate log", "--no-optional-locks status", "--no-lazy-fetch fetch origin", "--no-advice status", "--literal-pathspecs status", "--no-replace-objects log", "--exec-path", "--html-path",
			"--list-cmds=main", "--attr-source HEAD status", "--attr-source=HEAD status", "--namespace x status", "--namespace=x status", "-c core.quotepath=false -C /tmp --no-pager status", "--shallow-file /dev/null log", "--version",
			"-v", "--help", "-h", "--version push --force origin x", "-C /tmp", "",
		]) {
			expect(git(line), line).toBeNull();
		}
		expect(git("--bare push origin feat/ship-s1")).toContain("--git-dir");
	});

	test("every spelling of --no-verify keeps the hooks on for commit, merge, pull, am and rebase; -n is no-verify on commit and am only", () => {
		for (const line of [
			"commit --no-verify -m x", "commit --no-verif -m x", "commit --no-veri -m x", "commit --no-ver -m x", "commit --no-ve -m x", "commit --no-v -m x", "commit -m x --no-verify", "commit -nm x", "commit -n -m x", "commit -anm x", "commit -m x -n",
			"commit -mx -sn", "commit -m x -sn", "commit --amend -n", "merge --no-verify x", "merge --no-verif x", "merge --no-ve x", "pull --no-verify . x", "pull --no-rebase --no-ff --no-veri . x", "am --no-verify p", "am -n p", "am -3n p",
			"rebase --no-verify main", "rebase --no-verif main", "commit --message x --no-verify", "commit --author=x --no-verify",
		]) {
			expect(git(line), line).toContain("hooks");
		}
		for (const line of [
			"commit -mnew", "commit -m --no-verify", "commit -m -n", "commit --message=--no-verify", "commit --message --no-verify", "commit -am n", "commit -Fnotes.txt", "commit -F n", "commit -C n", "commit -c n", "commit --author=x -m y",
			"commit --author n -m y", "commit -m x -- -n", "commit -m x -- --no-verify", "commit -unormal -m x", "commit -Sn -m x", "commit --no-edit", "commit --no-post-rewrite -m x", "commit --reuse-message n", "commit --fixup n", "commit -t n",
			"merge -n x", "merge --no-verify-signatures x", "merge --no-ff --no-edit x", "pull -n origin main", "pull --no-rebase origin main", "pull --no-verify-signatures origin main", "rebase -n main", "am --no-3way p", "am -3 p", "log --no-verify",
			"grep -e --no-verify", "log -S--no-verify",
		]) {
			expect(git(line), line).toBeNull();
		}
	});

	test("git remote's subcommand is the first word that is no option, so -v and --verbose in front hide nothing", () => {
		for (const line of ["remote -v set-url origin x", "remote --verbose set-url origin x", "remote -v add evil x", "remote -vv rename origin gone", "remote --verb remove origin", "remote -v rm origin", "remote -- set-url origin x", "remote -v -v add a b", "remote -v set-url --push origin x"]) {
			expect(git(line), line).toContain("is refused");
		}
		for (const line of ["remote", "remote -v", "remote --verbose", "remote -v show origin", "remote get-url origin", "remote update", "remote -v update", "remote set-head origin --auto", "remote prune origin"]) expect(git(line), line).toBeNull();
	});

	/** Keys that make git run a program, read more config, or move hooks, remotes and credentials. */
	const RISKY_KEYS = [
		"core.hooksPath", "core.sshCommand", "core.fsmonitor", "core.editor", "core.pager", "core.askpass", "core.gitProxy", "core.alternateRefsCommand", "sequence.editor",
		"gpg.program", "gpg.openpgp.program", "gpg.x509.program", "gpg.ssh.program", "gpg.ssh.defaultKeyCommand",
		"diff.external", "diff.word.textconv", "diff.word.command", "diff.my.driver.textconv", "filter.lfs.clean", "filter.lfs.smudge", "filter.lfs.process", "merge.ours.driver",
		"include.path", "includeIf.gitdir:/x/.path", "credential.helper", "credential.https://github.com.helper", "uploadpack.packObjectsHook", "protocol.ext.allow", "protocol.allow",
		"remote.origin.url", "remote.origin.pushurl", "url.git@github.com:.insteadOf", "alias.p", "branch.main.remote", "branch.main.pushRemote", "push.followTags", "push.default", "push.autoSetupRemote", "push.pushOption", "push.recurseSubmodules",
		"push.gpgSign", "pager.log", "man.viewer", "browser.x.cmd", "web.browser", "help.browser", "submodule.x.update", "lfs.extension.x.clean", "lfs.customtransfer.x.path",
	];

	test("config that runs a program or reads more config is refused when written and when set for one command, for every subcommand", () => {
		for (const key of RISKY_KEYS) {
			for (const line of [
				`-c ${key}=x status`, `-c ${key.toUpperCase()}=x log`, `-c ${key} status`, `--config-env=${key}=VAR status`, `--config-env ${key}=VAR fetch origin`, `-c user.name=x --config-env=${key}=VAR diff`,
				`config ${key} x`, `config --add ${key} x`, `config --global ${key} x`, `config --replace-all ${key} x`, `config --unset ${key}`, `config --unset-all ${key}`,
				`config set ${key} x`, `config unset ${key}`, `config --file /tmp/x.cfg ${key} x`, `config -f /tmp/x.cfg ${key} x`, `config ${key.toUpperCase()} x`,
			]) {
				expect(git(line) ?? `${line}: allowed`, line).toContain("ship fence");
			}
		}
		expect(git("-c core.hooksPath=/tmp/h merge origin/main")).toContain("hooks and remotes");
	});

	test("reads of those keys, and config that runs nothing, still go", () => {
		for (const key of RISKY_KEYS) {
			for (const line of [`config --get ${key}`, `config ${key}`, `config get ${key}`, `config --get-all ${key}`, `config --show-origin --get ${key}`, `config --global --get ${key}`]) {
				expect(git(line), line).toBeNull();
			}
		}
		for (const line of [
			"config --list", "config -l", "config list", "config --list --show-origin", "config --get-regexp ^core\\.", "config --get-regexp remote\\..*\\.url", "config user.name", "config --default x --get user.name",
			"-c user.name=x -c user.email=x@y commit -m msg", "-c commit.gpgsign=false commit -m msg", "-c core.quotepath=false status", "-c core.autocrlf=false status", "-c color.ui=never diff", "-c advice.detachedHead=false switch x",
			"-c core.fileMode=false status", "-c diff.renames=copies diff", "-c merge.conflictStyle=zdiff3 merge --no-edit x", "-c pull.rebase=false pull origin main",
			"config user.name x", "config --global user.email a@b.c", "config pull.rebase false", "config core.autocrlf false", "config --local core.fileMode false", "config set merge.ff false",
		]) {
			expect(git(line), line).toBeNull();
		}
	});

	test("git config can't be steered past the key check by an abbreviated option, an editor or a renamed section", () => {
		for (const line of [
			// Options git reads by any unambiguous prefix move the key to another position.
			"config --typ path core.fsmonitor x", "config --ty path core.fsmonitor x", "config --repl core.fsmonitor x", "config --ad core.fsmonitor x", "config -f /tmp/x.cfg --typ path core.fsmonitor x", "config --fil /tmp/x.cfg core.fsmonitor x",
			"config --default y --typ path core.fsmonitor x",
			// The editor opens the repo's config for anything.
			"config --edit", "config -e", "config edit", "config --edi", "config --global -e", "config --edit --file /tmp/x.cfg",
			// A harmless key's section renamed to a risky one carries its keys along.
			"config --rename-section foo core", "config rename-section foo core", "config --rename foo core", "config --rename-section --global foo include",
		]) {
			expect(git(line) ?? `${line}: allowed`, line).toContain("ship fence");
		}
		expect(git("config --remove-section foo")).toBeNull();
	});

	test("--config-env values are judged as the paths they hold", () => {
		expect(checkGit(words("--config-env=core.worktree=V checkout HEAD -- src/a.ts"), policy, "/repo", { V: ".git/hooks" })).toContain("git folder");
		expect(checkGit(words("--config-env=core.worktree=V checkout HEAD -- src/a.ts"), policy, "/repo", { V: "/tmp/elsewhere" })).toBeNull();
		expect(checkGit(words("--config-env=core.worktree=V checkout HEAD -- src/a.ts"), policy, "/repo", {})).toBeNull();
	});

	test("config the environment sets for every command is judged like -c: GIT_CONFIG_COUNT with its keys and values, and GIT_CONFIG_PARAMETERS", () => {
		const status = (env: Record<string, string | undefined>) => checkGit(words("status"), policy, "/repo", env);
		for (const env of [
			{ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.fsmonitor", GIT_CONFIG_VALUE_0: "/tmp/p" },
			{ GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: "user.name", GIT_CONFIG_VALUE_0: "x", GIT_CONFIG_KEY_1: "Include.Path", GIT_CONFIG_VALUE_1: "/tmp/i.cfg" },
			{ GIT_CONFIG_PARAMETERS: "'core.fsmonitor=/tmp/p'" },
			{ GIT_CONFIG_PARAMETERS: "'user.name'='x' 'core.pager'='/tmp/p'" },
			{ GIT_CONFIG_PARAMETERS: "'credential.helper='" },
		]) {
			expect(status(env) ?? `${JSON.stringify(env)}: allowed`).toContain("ship fence");
		}
		for (const env of [
			{}, { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "user.name", GIT_CONFIG_VALUE_0: "x" }, { GIT_CONFIG_COUNT: "x" }, { GIT_CONFIG_COUNT: "-1", GIT_CONFIG_KEY_0: "core.fsmonitor" },
			{ GIT_CONFIG_KEY_0: "core.fsmonitor", GIT_CONFIG_VALUE_0: "/tmp/p" }, { GIT_CONFIG_PARAMETERS: "'user.name=x' 'color.ui'='never'" },
		]) {
			expect(status(env), JSON.stringify(env)).toBeNull();
		}
		// Their values are paths like any other: this one points core.worktree into a git folder.
		expect(status({ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.worktree", GIT_CONFIG_VALUE_0: ".git/hooks" })).toContain("git folder");
	});

	test("--exec-path=<dir> moves git's helper programs and is refused; asking for the path is not", () => {
		for (const line of ["--exec-path=/tmp/x status", "--exec-path=/tmp/x fetch origin", "-C /tmp --exec-path=/x status", "-c user.name=x --exec-path=/x log", "--exec-path= status"]) {
			expect(git(line) ?? `${line}: allowed`, line).toContain("ship fence");
		}
		expect(git("--exec-path")).toBeNull();
		expect(git("status")).toBeNull();
	});

	describe("apply", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fence-apply-"));
		afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
		let n = 0;
		/** A patch file whose headers are `headers`; returns its path. */
		const patch = (...headers: string[]): string => {
			const file = path.join(dir, `p${n++}.patch`);
			fs.writeFileSync(file, `${headers.join("\n")}\n@@ -0,0 +1 @@\n+x\n`);
			return file;
		};
		const named = (p: string, mode = "") => [`diff --git a/${p} b/${p}`, ...(mode ? [`new file mode ${mode}`] : []), "--- /dev/null", `+++ b/${p}`];

		test("--unsafe-paths lets a patch write outside the work tree, .git included; any prefix git reads for it is refused", () => {
			const ok = patch(...named("src/a.ts"));
			for (const line of [`apply --unsafe-paths ${ok}`, `apply --unsafe-path ${ok}`, `apply --unsafe ${ok}`, `apply --uns ${ok}`, `apply -p0 --unsafe-paths ${ok}`, `apply ${ok} --unsafe-paths`, `-C sub apply --unsafe-paths ${ok}`, "apply --unsafe-paths -"]) {
				expect(git(line) ?? `${line}: allowed`, line).toContain("unsafe-paths");
			}
			for (const line of [`apply ${ok}`, `apply --check ${ok}`, `apply --stat --summary ${ok}`, `apply -R ${ok}`, `apply --3way ${ok}`, `apply --index ${ok}`, `apply -p2 ${ok}`, `apply --whitespace=fix ${ok}`, "apply -", "apply", "apply -- --unsafe-paths"]) {
				expect(git(line), line).toBeNull();
			}
		});

		test("a patch that names a path inside a git folder is refused, whatever the header, quoting or strip level", () => {
			for (const headers of [
				named(".git/hooks/pre-commit", "100755"), named(".GIT/hooks/pre-commit"), named("sub/.git/config"), named(".git/hooks/pre-commit").slice(1),
				["--- a/.git/hooks/x", "+++ b/.git/hooks/x"], ["--- .git/hooks/x\t2020-01-01 00:00:00", "+++ .git/hooks/x\t2020-01-01 00:00:00"],
				["diff --git a/x b/.git/hooks/x", "rename from x", "rename to .git/hooks/x"], ["diff --git a/x b/y", "copy from x", "copy to .git/hooks/x"],
				["diff --git a/x b/y", "rename from .git/hooks/x", "rename to y"],
				// C-style quoting spells a character as an octal escape: \056 is the dot.
				["--- /dev/null", '+++ "b/\\056git/hooks/x"'], ['diff --git "a/\\056git/x" "b/\\056git/x"'], ['diff --git "a/y z" "b/.git/hooks/y z"'],
				// Absolute, `..` and the git folders the fence knows by name.
				["--- /dev/null", "+++ /repo/.git/hooks/x"], ["--- /dev/null", "+++ b/../.git/hooks/x"], ["--- /dev/null", "+++ /data/app-gitdir/hooks/x"], ["--- /dev/null", "+++ b/../../data/app-gitdir/hooks/x"],
				["--- /dev/null", "+++ b/../main/.git/hooks/x"],
			]) {
				const file = patch(...headers);
				expect(git(`apply ${file}`) ?? `${headers.join(" | ")}: allowed`).toContain("git folder");
				expect(git(`apply --check -p0 ${file}`) ?? "allowed", headers.join(" | ")).toContain("git folder");
			}
			// Patch files named among other options and operands are all read.
			const bad = patch(...named(".git/hooks/pre-commit"));
			const good = patch(...named("src/a.ts"));
			expect(git(`apply --whitespace=fix ${good} ${bad}`)).toContain("git folder");
			expect(git(`apply --directory=sub ${bad}`)).toContain("git folder");
			// --directory puts a root in front of every path.
			expect(git(`apply --directory=../data/app-gitdir ${patch(...named("hooks/x"))}`)).toContain("git folder");
		});

		test("ordinary patches apply: files, dotfiles and folders that only look like .git", () => {
			for (const headers of [
				named("src/a.ts"), named(".github/workflows/ci.yml"), named(".gitignore"), named("docs/.gitattributes"), named(".gitmodules"), named("src/git/hooks.ts", "100755"), named("not.git/x"),
				["--- a/src/a.ts", "+++ b/src/a.ts"], ["diff --git a/x b/y", "rename from src/x", "rename to src/y"],
			]) {
				expect(git(`apply ${patch(...headers)}`), headers.join(" | ")).toBeNull();
			}
			expect(git(`apply ${path.join(dir, "missing.patch")}`)).toBeNull();
			expect(git(`apply ${dir}`)).toBeNull();
		});
	});

	test("lfs commands that write or remove the repo's hooks are refused; the rest of lfs runs", () => {
		for (const line of ["lfs install", "lfs install --force", "lfs install --local", "lfs install --skip-repo", "lfs update", "lfs update --force", "lfs update --manual", "lfs uninstall", "-C /tmp lfs install --force", "-c core.quotepath=false lfs install"]) {
			expect(git(line) ?? `${line}: allowed`, line).toContain("lfs");
		}
		for (const line of ["lfs ls-files", "lfs pull", "lfs fetch origin", "lfs track *.psd", "lfs env", "lfs status", "lfs --version", "lfs pointer --file=x", "lfs locks"]) expect(git(line), line).toBeNull();
	});

	test("GraphQL may only resolve one review thread, with nothing riding along", () => {
		const resolve = "query=mutation($thread:ID!){resolveReviewThread(input:{threadId:$thread}){thread{isResolved}}}";
		expect(checkGh(["api", "graphql", "-f", resolve, "-f", "thread=PRRT_1"])).toBeNull();
		const smuggled = "query=mutation{resolveReviewThread(input:{threadId:\"x\"}){thread{isResolved}} m: mergePullRequest(input:{pullRequestId:\"y\"}){clientMutationId}}";
		expect(checkGh(["api", "graphql", "-f", smuggled])).toContain("mutations");
	});
});

describe("argv helpers", () => {
	test("protected names are matched case-blind and .env* without examples", () => {
		for (const rel of [".GITHUB/workflows/ci.yml", ".github", "agents.md", "Claude.md", ".MCP.json", ".git", ".GIT/hooks/x", ".envrc", ".env-prod", ".env_local", "a/.env.production"]) expect(isProtectedPath(rel)).toBe(true);
		for (const rel of [".env.example", "src/github.ts", "docs/agents-guide.md", ".gitignore"]) expect(isProtectedPath(rel)).toBe(false);
	});

	test("a push's sources, its folder and the argv that lists what it would send", () => {
		expect(readPush(words("status"), "/r")).toBeNull();
		expect(readPush(words("-C a -c x=y -C b push -u origin HEAD:feat/ship-s1 main"), "/r")).toEqual({
			dir: "/r/a/b",
			sources: ["HEAD", "main"],
			listing: ["-c", "x=y", "push", "--dry-run", "--porcelain", "--no-verify", "origin", "HEAD:feat/ship-s1", "main"],
		});
		expect(readPush(words("push origin :gone"), "/r")?.sources).toEqual(["HEAD"]);
		// -q would hide the listing; --no-follow-tags and the address family decide what goes and where.
		expect(readPush(words("push -qv --no-follow-tags -4 --atomic origin feat/ship-s1"), "/r")?.listing).toEqual(["push", "--dry-run", "--porcelain", "--no-verify", "--no-follow-tags", "-4", "origin", "feat/ship-s1"]);
		expect(readPush(words("--config-env=core.x=V push origin b"), "/r")?.listing.slice(0, 3)).toEqual(["--config-env", "core.x=V", "push"]);
	});
});

/** The installed gh, found past the shims. The tests below skip where there is none. */
const realGh = Bun.which("gh", { PATH: (process.env.PATH ?? "").split(path.delimiter).filter(entry => !entry.endsWith(`${path.sep}ship-fence`)).join(path.delimiter) });

describe.skipIf(realGh === null)("the fence reads gh's argv as the installed gh does", () => {
	const config = fs.mkdtempSync(path.join(os.tmpdir(), "fence-gh-"));
	afterAll(() => fs.rmSync(config, { recursive: true, force: true }));
	/** What gh prints for `args`, with only a port nobody listens on to talk to: what it does shows without anything being sent. */
	const ghSays = (args: string[]): string => {
		const env: Record<string, string | undefined> = { ...process.env, GH_HOST: "localhost:1", GH_ENTERPRISE_TOKEN: "x", GH_CONFIG_DIR: config, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1" };
		for (const token of ["GH_TOKEN", "GITHUB_TOKEN"]) delete env[token];
		const r = spawnSync(realGh as string, args, { cwd: config, env, encoding: "utf8", timeout: 20_000 });
		return `${r.stdout}${r.stderr}`;
	};

	test("the method gh sends is the last of -X and --method, and the fence lets through exactly the reads", () => {
		const cases: [string[], string][] = [
			[["api", "-X", "GET", "--method", "PUT", "repos/o/r/pulls/5/merge"], "PUT"],
			[["api", "--method", "GET", "-X", "PUT", "repos/o/r/pulls/5/merge"], "PUT"],
			[["api", "-X", "PUT", "-X", "GET", "repos/o/r/pulls/5"], "GET"],
			[["api", "--method=PUT", "-XGET", "repos/o/r/pulls/5"], "GET"],
			[["api", "-X=GET", "-X=DELETE", "repos/o/r/git/refs/heads/x"], "DELETE"],
			[["api", "-iX", "PUT", "repos/o/r/pulls/5/merge"], "PUT"],
			[["-p", "pr", "-p", "pr", "api", "repos/o/r/pulls/5/merge", "-X", "PUT"], "PUT"],
		];
		for (const [args, sends] of cases) {
			expect(/^> (\w+) \S+ HTTP/m.exec(ghSays([...args, "--verbose"]))?.[1], args.join(" ")).toBe(sends);
			expect(checkGh(args) === null, args.join(" ")).toBe(sends === "GET");
		}
	});

	test("--draft takes what strconv.ParseBool does, and the fence calls a draft exactly the values that parse as true", () => {
		const parsed = ["1", "0", "t", "T", "f", "F", "true", "True", "TRUE", "false", "False", "FALSE"];
		for (const value of [...parsed, "tRUE", "TRue", "fALSE", "yes", "no", "on", "off", "y", "n", "", "2", "-1", " true", "true "]) {
			expect(ghSays(["pr", "create", `--draft=${value}`, "--dry-run"]).includes("invalid argument"), JSON.stringify(value)).toBe(!parsed.includes(value));
		}
		expect(parsed.filter(value => checkGh(["pr", "create", `--draft=${value}`, "--title", "t", "--body", "b"]) === null)).toEqual(["1", "t", "T", "true", "True", "TRUE"]);
	});

	test("a flag in front of the command words moves the command gh runs, and the fence refuses it", () => {
		for (const args of [["pr", "-t", "x", "merge", "5"], ["pr", "-b", "x", "review", "5", "--approve"], ["pr", "-c", "x", "close", "5"]]) {
			const full = [...args, "-R", "localhost:1/o/r"];
			expect(ghSays(full), args.join(" ")).toContain("connection refused");
			expect(checkGh(full), args.join(" ")).toContain("in front of gh's command words");
		}
		expect(ghSays(["pr", "-t", "x", "frobnicate", "5", "-R", "localhost:1/o/r"])).not.toContain("connection refused");
	});
});
