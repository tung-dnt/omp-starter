---
description: Investigations that span two or more repositories fan out one scout per repo with cited file:line reports; the main session reads the reports, not the source.
alwaysApply: true
agents: main
---

# Cross-repo investigation: scouts read, main decides

When a question spans two or more repositories or worktrees (tracing a ticket to code, a journey across services, comparing implementations), the main session coordinates and does not map source itself. Its turns carry the whole conversation, so each file it reads costs many times what a scout's read costs.

- Follow the `end-to-end-technical-flow-report` skill for scope, provenance and the report. Its source-tracing steps run in scouts.
- Fan out one `scout` per repository in a single `task` batch. Each brief names the question, the repo or worktree path, the revision, and what is already known.
- Each scout writes `local://<repo>-trace.md`: every claim with `path:start-end`, the symbol, an excerpt of at most five lines, and a label (source, ticket/doc claim, inference, unknown).
- The main session reads those reports. To check a doubtful claim it reads only the cited range (`path:N-M`), never the whole file. Follow-up questions go to a scout (`write agent://<id>` or a new scout), not to main-session grep.
- Main-session source reads stay fine for: the cited range of a report claim, one file the user named, or code in the single repo the session is editing.
