import { describe, expect, test } from "bun:test";
import { checkCommentBody, checkGh, checkGit, gitWorkDir, isProtectedPath, MARKER, type PushPolicy, pushSources } from "./fence";

const policy: PushPolicy = { pushBranch: "feat/ship-s1" };
const words = (line: string) => line.split(" ").filter(Boolean);
const gh = (line: string) => checkGh(words(line));
const git = (line: string, p: PushPolicy = policy) => checkGit(words(line), p);
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
		expect(git("push origin feat/ship-s1", { pushBranch: null })).toContain("pushes nothing");
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
