# /ship for omp-starter

Branch: `feat/ship`. Approved by Tony on 2026-11-24. Build each story with `/story` or `/build omp-starter feat/ship plans/001-ship.md story=N`.

## Goal

A `/ship` command in omp-starter takes your work from a checkout to a PR that is ready to merge, without you watching. It commits, pushes and opens a draft PR when the branch has none, reviews it, then watches until the PR merges or closes, fixing what comes up. It never merges. Any source can trigger it: your omp tab, a Hermes card, or /build.

## Acceptance criteria

1. `/ship [<pr#>|<pr url>|stop|status] [+bot ...]` works in any checkout whose origin is github.com, SSH aliases included (`git@blindx.github:` resolves through `ssh -G`). It acts as the account that owns the repo: `gh-blinx` (blindx-tony-do) for blinxsolutions, plain `gh` (tung-dnt) otherwise, and refuses a PR that account didn't author.
2. Put-up, when the branch has no open PR: refuses on the default branch, a detached HEAD, or secret-looking files (`.env*` except examples, keys, `*.pem`). Shows the files and commits all uncommitted work after one confirm; an unattended session refuses a dirty tree instead. Hooks stay on. Pushes `origin <branch>` without force. Opens a draft PR; a branch carrying a Jira key gets the title `PAC2-####: ...`.
3. Review: runs `interrogate` on `base...HEAD`, report only. The first watch pass checks each finding against the code, fixes the ones that hold, and drops the rest.
4. Watch: code reads the PR every 2 minutes (state, checks, review threads, comments) with no model call. A change starts a pass, but never sooner than 10 minutes after the previous one. Separately, each pass ends by setting its next check: 2 minutes after a push, 30 minutes while checks run, 1 hour when nothing runs, pushed back further while nothing changes.
5. Each pass: CI fixed at the root cause, at most one re-run per job. Conflicts fixed by merging the base, never by rebasing. Small asks from people with write access done and answered; larger asks proposed in a reply and brought to you. Bot findings acted on only when confirmed in the code. Security findings it doesn't fix go to you. At most 3 pushes per cause, one push per round.
6. A fence runs for the whole /ship session: no merge, approve, undraft, close or base change; no force push or branch delete; pushes only to the PR's head branch; no edits to `.github/`, CODEOWNERS, `.env*`, `.npmrc`, AGENTS.md, CLAUDE.md, `.claude/`, `.mcp.json` or git hooks. A fix that needs one of those files is left to you.
7. Only comments from you, people with write access, and bots named with `+bot` reach the model; the rest are counted and you are told once. Its own comments carry `<!-- omp-ship -->`, no AI wording, no @mentions, links or closing keywords.
8. After put-up, /ship commits only files it changed itself, by name. A file you changed in the checkout is never committed, stashed or discarded; a fix that needs it is made there, left uncommitted, and you are told.
9. "Ready" means checks green, no conflict, and every trusted comment answered. It then reports what is still yours (undraft, a required approval) and keeps watching. It never undrafts.
10. Ends on merged, closed, `/ship stop`, 7 days, a base retarget, or the session ending. Running `/ship` again on the same PR resumes from GitHub's state and the state file (D4).
11. One watch per PR: a second /ship on a PR already watched by a live session refuses and names that session.
12. Reports a status line per pass and a macOS notification on ready, needs-you and stopped (interactive only). `--report <path>` rewrites a JSON status file after each pass for other triggers.
13. Unattended sessions never ask; they refuse and report.
14. Spend cap: at most 24 passes per 24 hours per PR. At the cap it runs no more passes, reports "needs you", and keeps reading the PR; running /ship again resets it.
15. `/build` ends by handing its branch to `/ship`, so one put-up path exists.
16. Proven live on a throwaway GitHub repo (red check, conflict and comment set up by a test script, since /ship may not edit `.github/`): the check fixed, the conflict merged, the comment answered, a merge attempt refused, and a quiet hour with no model turns.

Out of scope: GitLab, Bitbucket and Azure. The Hermes "ship" card and deleting hermes-agent-tasks' own fence are a follow-up plan in that repo.

## Decisions

Approved by Tony with the plan. Chosen option first, then the rejected one.

- **D1. Who drives the loop.** An omp-starter extension owns the watch in code: a 2-minute timer reads the PR with `gh`, decides whether anything changed, and starts a model pass with `pi.sendMessage`. Rejected: the model schedules itself with `/every`, because every wake would cost a model turn even when nothing changed (breaks AC4).
- **D2. How the fence is enforced.** `gh` and `git` shims put first on the session's PATH while a watch runs, plus a `tool_call` check for the github tool, absolute paths, direct API calls and protected-path edits. Moved from hermes-agent-tasks, where it was proven in a real omp session today. Rejected: parsing shell text in `tool_call` only, which misses scripts, eval cells and wrappers (`gh-blinx`, `rtk`).
- **D3. Where passes run.** As turns in the same omp conversation, so later passes remember earlier findings, as in Claude's /ship. Compaction keeps it bounded. Rejected: a fresh session per pass, which loses the review findings and the "already told you" state.
- **D4. Where watch state lives.** GitHub is the truth for PR state. The few facts GitHub can't hold (pushes per cause, what you were already told, the start time) go in `~/.omp/agent/ship/<owner>-<repo>-<pr>.json`, written atomically, so a rerun of /ship resumes. Rejected: in-memory only, which resets the 3-push cap on every rerun.
- **D5. Review skill.** `interrogate` (pstack), which /build already uses. Rejected: a new review prompt of our own, a second convention.
- **D6. Pass instructions.** Written in our own words in `skills/ship/SKILL.md`, following the behavior in the reverse-engineering notes. Rejected: pasting Claude Code's prompt text, which its license doesn't allow.
- **D7. Forges.** GitHub only. Rejected: GitLab, Bitbucket and Azure adapters now; none of your repos use them.

## Story order

Build order. Each story is one PR under about 400 changed lines.

## Story 1: Fence for omp-starter

Covers AC 6, 13.

- [ ] Depends on: nothing.
- [ ] Files: `extensions/ship/fence.ts`, `extensions/ship/fence.test.ts`, `bin/ship-fence/{shim,gh,git}`, `extensions/ship/fence-cli.ts`.
- [ ] Change: move the gh/git/tool-call checks from hermes-agent-tasks `src/fence.ts`; add protected-path refusal for write/edit/ast_edit and the comment marker rule (a `gh api` comment body must start with `<!-- omp-ship -->`, no @, no links, no closing keywords). Export `armFence(policy)` / `disarmFence()`, which put the shim folder first on `process.env.PATH` and write the policy file.
- [ ] Result: with the fence armed, `gh pr merge 1`, `git push origin main`, `/opt/homebrew/bin/gh pr merge 1` and an edit to `.github/workflows/ci.yml` are refused; `git status` and `gh pr view` run.
- [ ] Verify (unit): `bun test extensions/ship/fence.test.ts`.
- [ ] Verify (live): an `omp -p` session in a throwaway repo with the fence armed through a test entry; the four refusals and two successes above, read from the real tool output.

## Story 2: PR reader

Covers AC 1, 4 (the reading half), 7.

- [ ] Depends on: nothing.
- [ ] Files: `extensions/ship/pr.ts`, `extensions/ship/pr.test.ts`.
- [ ] Change: one `readPr(repo, number, run)` that returns a typed snapshot: state, draft, head/base SHAs, mergeable state, checks by bucket, review threads and comments after the trust filter (you, write/admin permission through `gh api …/collaborators/LOGIN/permission`, `+bot` names; quoted lines and hidden comments dropped; length caps). A stable hash of what a pass would act on. Origin parsing with SSH aliases. `run` is injected, so tests use recorded `gh` output.
- [ ] Result: `readPr` on a real PR returns the snapshot; the hash changes when a check goes red or a trusted comment lands, and not when an untrusted one does.
- [ ] Verify (unit): recorded fixtures for green, red, conflicting, untrusted-comment and own-marker cases.
- [ ] Verify (live): against a real PR on the throwaway repo, print the snapshot and hash before and after posting a comment.

## Story 3: Watch engine (code only, no model)

Covers AC 4, 10, 11, 14.

- [ ] Depends on: story 2.
- [ ] Files: `extensions/ship/watch.ts`, `extensions/ship/watch.test.ts`.
- [ ] Change: the watch as data. State `starting → watching → ended(reason)`. A pure `nextStep(snapshot, state, now)` returns one of: run a pass now, wait until T, or end with a reason (merged, closed, retargeted, 7 days, spend cap). It applies the AC4 cadence and the 10-minute floor. The D4 state file holds the start time, pushes per cause, "told once" keys, the pass count against the spend cap, and the owning session id with a heartbeat, so a second live watch on the same PR is refused (AC11) and a stale one is taken over. Writes go to a temp file and are renamed into place.
- [ ] Result: replaying a recorded PR history through `nextStep` gives the expected passes and waits.
- [ ] Verify (unit): table tests (changed, unchanged, within 10 minutes, after a push, checks pending, quiet for hours, merged, retargeted, 7 days, cap reached, second watch refused, stale owner taken over, crash mid-write leaves the old file).

## Story 4: `/ship <pr>` watches an existing PR

Covers AC 5, 7, 8, 9, 12, 13, 16.

- [ ] Depends on: story 1, story 3.
- [ ] Files: `extensions/ship.ts`, `skills/ship/SKILL.md`, `commands/ship.md`, `package.json`, `README.md`.
- [ ] Change: `/ship <pr>`, `/ship stop`, `/ship status`. A 2-minute timer calls `readPr` and `nextStep`. A pass sends the skill's rules plus the snapshot to the model with `pi.sendMessage`. The pass rules (AC5, 7, 8, 9) live in the skill, in our own words. Status line, notifications, `--report` file. The fence is armed while a watch runs and disarmed when it ends.
- [ ] Result: started on a PR with a red check, one pass fixes and pushes, then the session sits without model turns until the checks report.
- [ ] Verify (live, review-gated): on the throwaway repo, with the red check, conflict and comment set up by `scripts/ship-fixture.ts`: the check fixed, the conflict merged, the comment answered, a merge attempt refused by the fence, and an hour with no model turns, counted from the session log.

## Story 5: Put-up and review

Covers AC 1 (author check), 2, 3, 13.

- [ ] Depends on: story 4.
- [ ] Files: `extensions/ship/putup.ts`, `extensions/ship/putup.test.ts`, `extensions/ship.ts`, `skills/ship/SKILL.md`.
- [ ] Change: `/ship` with no PR: the AC2 refusals, the file list and one confirm (refused unattended), commit with hooks on, `git push origin <branch>`, `gh pr create --draft` with a `PAC2-####:` title when the branch carries a key, then `interrogate` on `base...HEAD`, then hand to the watch.
- [ ] Result: from a dirty checkout on a new branch, one confirm ends in a draft PR whose review findings the first pass triages.
- [ ] Verify (unit): refusal table (default branch, detached HEAD, `.env` in the tree, foreign author, unattended dirty tree).
- [ ] Verify (live, review-gated): on the throwaway repo, a dirty branch to a draft PR; title, body and draft state checked on GitHub.

## Story 6: /build hands off to /ship

Covers AC 15.

- [ ] Depends on: story 5.
- [ ] Files: `skills/build/SKILL.md`, `README.md`, release notes.
- [ ] Change: /build's PR step becomes "run /ship on the branch"; its own push and `gh pr create` go.
- [ ] Result: an unattended /build of a one-story plan ends with /ship watching the new draft PR.
- [ ] Verify (live): `/build` on the throwaway repo with a one-story plan, unattended.

## Dependency graph

Stories 1 and 2 are independent and branch from `feat/ship`. Story 3 waits for 2. Story 4 waits for 1 and 3. Story 5 waits for 4, story 6 for 5. Stories 4 and 5 change how you interact with omp and wait for your review before merge.

## Unproven

- That `pi.sendMessage` with `triggerTurn` starts a pass in an unattended session the same way it does in the TUI. Story 4's live check settles it.
- That an extension timer keeps firing while the session sits idle for hours. Story 4's quiet-hour check settles it.
