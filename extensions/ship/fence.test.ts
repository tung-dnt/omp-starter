import { describe, expect, test } from "bun:test";
import { checkCommentBody, checkGh, checkGit, type GitPolicy, gitWorkDir, isProtectedPath, MARKER, pushSources } from "./fence";

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
		for (const line of ["pr merge 5 --squash", "pr merge --auto 5", "pr review 5 --approve", "pr ready 5", "pr close 5", "--repo o/r pr merge 5", "pr -R o/r merge 5", "repo delete o/r --yes", "secret set TOKEN", "alias set m 'pr merge'", "extension install foo/bar", "auth login", "workflow run deploy.yml", "m 5"]) {
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

	test("a push's sources and a git argv's folder", () => {
		expect(pushSources(words("-u origin HEAD:feat/ship-s1 main"))).toEqual(["HEAD", "main"]);
		expect(pushSources(words("origin :gone"))).toEqual(["HEAD"]);
		expect(gitWorkDir(words("-C a -c x=y -C b push"), "/r")).toBe("/r/a/b");
	});
});
