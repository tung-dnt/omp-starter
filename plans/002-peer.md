# /peer for omp-starter

Approved by Tony on 2026-11-25: implement `/peer` and keep watching after approval, reopening review on new commits. Work on `feat/peer`; preserve unrelated checkout changes. Tony subsequently requested publication and release on 2026-11-25; local installation is not part of that request.

## Contract

- `/peer <pr#|pr URL> [+bot ...] [--report <path>]`, `/peer status`, `/peer stop`. A number names this checkout's GitHub origin; a URL works from any folder. An explicit PR is required; peer never creates a PR, checkout or worktree.
- Act through `gh-blinx` for blinxsolutions and `gh` otherwise, verifying the actual login. Refuse self-review, closed/merged PRs, or an active ship/peer fence in this session.
- Read source through GitHub at the captured head/base commits. Never run colleague PR code, edit the checkout, commit, push, rerun CI, merge, close, undraft or modify the PR.
- Code polls every 2 minutes with no model cost. A pass starts on relevant changed input (new head, trusted human discussion, check transition, approval dismissal), with the existing 10-minute floor and 24-pass/24-hour, 7-day limits. No model wake for unchanged waiting or approved heads.
- A new head during review remains unreviewed. Edited replies and author replies count. Self-generated reviews/replies/resolutions do not trigger another pass.
- Review earlier blockers first, then the complete diff, changed files and relevant callers. Existing peer-review standards apply: correctness/security and maintainability, with independent reviewer coverage for high-risk diffs. Never run PR code, including package installation or tests. CI is the execution signal.
- Findings must be concrete consumer-impacting blockers. Post inline with `Blocker:` and business impact first. Request changes when blockers remain. Don't duplicate unchanged open findings; answer human replies where needed; resolve only own threads verified fixed and replied to.
- Model outputs a validated structured review result. The trusted controller alone submits reviews, replies and resolutions. Model-side GitHub mutations are forbidden, even approval.
- Approve only with no blockers and CI green or genuinely absent (existing temporary ignored-check policy applies). Pending, failed/cancelled checks, incomplete or unreadable input, a moved head, or unresolved own blockers prevent approval. Other reviewers' threads are not peer's to resolve. A conflict is reported, never fixed; it does not itself invent a code-review blocker.
- Every submitted review is bound to the captured SHA via REST `commit_id`. Re-read before submission, verify the receipt and current head afterward. A raced approval is not current success. GitHub has no atomic head-equals-SHA conditional review endpoint.
- Confirmed approval keeps the watch alive and quiet. New commits reopen review; CI-only noise on an already approved head does not restart review. A dismissed approval does reopen review.
- Restart resumes GitHub's review/thread truth; persisted shared watch ownership/cadence uses the existing ship Watch format so /ship and /peer cannot own the PR from different sessions. This session cannot run both modes at once.
- Stop and session lifecycle abort pending reads, prevent queued submissions, clear timers, release ownership and disarm. Already-accepted remote writes cannot be undone by stop.
- Status/report distinguish reviewing, waiting for author/CI, approved, needs-you and ended; report errors must be visible. Existing macOS notification preference applies.

## Shapes and boundaries

Chosen: separate `extensions/peer.ts` review controller, with helpers under `extensions/peer/` only where an independent job warrants them; reuse shared PR types, execution, watch claim/heartbeat, origin parsing and fence infrastructure. Rejected: a `mode` inside the 1,000-line ship controller, which mixes author and reviewer mutation authority; rejected duplicating the entire ship implementation.

- `extensions/ship/pr.ts` exports an additional `readPeerPr: ReadPeerPr`. `readPr` behavior remains unchanged. `PeerSnapshot extends Snapshot` requires `baseSha: string`, `PeerThread[]` with raw first-note ownership, and `PeerReview[]` with review IDs and authenticated self-markers. Ship's Snapshot and fixtures stay unchanged. Peer reading trusts the actual PR author in addition to the existing Trust identities, recognizes `<!-- omp-peer -->` as self-authored only when the login matches, reads complete paginated discussions (including nested thread replies), and hashes the base SHA, review commit/state and edited discussion. Incomplete reads or a head/base move during reading return a refusal, not a clear snapshot. `Trust` remains the existing `{ me, bots }`.
- `extensions/ship/fence-state.ts` exports `armPeerFence({ pr, root }): void` and persists a peer policy marker (`mode: "peer"`) alongside the existing state. Existing ship states remain ship by default. `currentState`, `disarmFence`, shim/tool enforcement support both. A peer model is read-only; the controller's existing internal `exec` bypass is the sole remote writer.
- The peer fence refuses writes through tools, gh/git, shell and eval paths covered by the existing guard; preserves read-only GitHub/source access and read-only review subagents. It is a guardrail, not a sandbox. Ship's existing write permissions stay unchanged. Ship refuses to start while peer is armed before it claims a watch.
- `extensions/peer.ts` default export registers the command and session hooks. Export `createPeer(parts)` for injected runtime tests and `realPeerParts` for the real host/smoke driver. Parts include `now`, `ghFor`, `git`, `readPr` (readPeerPr in real parts), `parseLink`, `parseTarget`, SSH alias resolver, claim/renew/save/release watch, arm/disarm/current fence, rules and notification dependencies as needed; prefer derived types over parallel interfaces.
- Structured model result uses `status: "complete" | "needs-you"` and carries the captured head SHA and summary. Complete results carry inline blockers `{path,line,side,threadId,body}` with `LEFT` for removed lines or `RIGHT` for current lines, and a known thread ID for an existing finding or null for a new one; replies `{threadId,body}`; and resolved own thread IDs. An incomplete-source result is needs-you, never an empty clear review. Use a single documented `PEER-REVIEW: <JSON>` final line and validate at the boundary. Missing/malformed or multiple results are needs-you, never approval. No raw model-provided API paths or commands are executed.
- Controller review API payloads are JSON in a temporary file outside the repo (`gh api ... --input <file>` through internal exec), cleaned in finally. This avoids hand-built nested gh field encoding. Controller verifies PR identity, captured head, login, review/thread ownership, reply-before-resolution and review receipts. Unknown submission outcome is reconciled from GitHub before any retry, not blindly posted again.
- Wire `package.json`, `commands/peer.md`, `skills/peer/SKILL.md`, README and release notes/version following repository convention. No new dependency.

## Ownership for this implementation

- PeerController: `extensions/peer.ts`, `extensions/peer/**`, `extensions/peer.test.ts`, `skills/peer/SKILL.md`.
- PeerFence: `extensions/ship/fence*.ts` (including their tests), `extensions/ship-fence.ts`, and the minimal peer-active start refusal in `extensions/ship.ts` plus its test if needed. Does not edit PR reader/types/watch.
- PeerReader: `extensions/ship/pr.ts`, `extensions/ship/pr.test.ts`, additional reader tests if useful, and `extensions/ship/types.ts` only if indispensable. No controller/fence edits.
- Main: integration, command/manifest/docs/version and runnable smoke/replay script; correct integration defects after workers finish. Native todo is the only progress record.

All workers skip tests/build/lint/formatters mid-flight. Run affected checks once after integration. Every existing exported-symbol change needs LSP references first; use edit for existing files. Do not commit, push, create PRs, install dependencies, modify other branches or touch unrelated user edits.

## Verification

- Controller transitions: blockers → unchanged quiet → author fix/reply → approval → unchanged approved quiet → new commit → re-review.
- Moved head before/during/after submission never produces current approved status; pending/red CI and missing/invalid/truncated results cannot approve.
- Duplicate suppression, ambiguous submission/restart reconciliation, own-only thread resolution, edited replies, non-writer author, full pagination and read errors.
- Stop/start cancellation, session switch/shutdown, same-session ship/peer exclusion and persisted cross-session ownership.
- Peer guard blocks mutations/code execution paths and preserves source reads; ship tests retain current policy.
- A rerunnable smoke/replay script exercises the new controller with deterministic PR events. Drive status/stop through a real omp CLI/RPC host when available. No actual colleague PR mutation is authorized by these verification steps.

## Decision log

- Tony chose continued watching after approval over stopping. No model work on an unchanged approved head; only a later head or dismissed approval reopens review.
- Controller owns all GitHub writes instead of letting review model construct mutation commands, reducing authority and binding every review to captured state.
- Review source through GitHub instead of checking out a colleague's branch, avoiding worktree mutations and accidental execution.
- Share existing watch ownership format rather than adding overlapping peer lock files; preserve existing ship policy and entry behavior except mutual exclusion.
- Main accepted the reader/controller refinement: peer needs a required captured base SHA to pin source reads and invalidate results when the base advances. Added a peer-specific Snapshot subtype rather than weakening ship's type with an optional field.
- Main accepted peer-only thread ownership and review identity fields for safe own-thread resolution and submission reconciliation. Ownership comes from the raw first comment, not whichever comment survives filtering.
- Main chose explicit existing-finding thread IDs over matching prose or suppressing every finding at the same line. Rewording cannot duplicate an identified old finding, while a different new bug at that line remains reportable.
- The changed-file reader checks REST `changed_files` against its complete paginated list and the documented 3,000-file API ceiling. The compare endpoint's 300-file limit does not apply to this endpoint.
