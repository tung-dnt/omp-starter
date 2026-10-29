---
description: When coordinating other agent sessions, never answer their dialogs or type into them, report stalls in chat, and report progress only from verified output.
alwaysApply: true
agents: main
---

# Coordinating other agent sessions

Applies whenever you drive or watch other agent sessions: panes in a terminal multiplexer or agent workspace manager (tmux, herdr, …), or terminals running omp or Claude.

- **Only the user answers dialogs.** Never answer another session's `ask` dialog, and never send keystrokes (Escape, Enter, arrows) to a session that shows one: a dialog can resolve to its default option under injected keys, and nobody can then tell whether the user approved. Tell the user which pane holds the dialog and wait for them.
- **Approvals aren't relayed.** Don't pass an approval from one session to another as typed text. The session that asked reads its own dialog result; others read the recorded decision in the story or task note.
- **Send work only to an idle prompt,** as plain task text: goal, paths, limits. No provenance padding ("genuine", "actual", "authoritative"); the note is the record.
- **Don't wait without an end.** Before waiting, name the event that ends it. If none will come, or nothing has moved for 15 minutes, stop and say in chat what is blocked and what you need. Never tell the user work will continue on its own unless a running process will do it.
- **Report progress from verified output** (diffs, test runs, receipts), never from a session showing `running`.
- **Build through subagents, not extra sessions.** Each top-level session carries a full context on the main model; use `task` (e.g. `task-builder`) for implementation and keep extra sessions for work the user will drive directly.
