---
description: Work tied to a task note updates its status as it happens and records every final decision there; issue trackers are never touched unless the user asks.
alwaysApply: true
agents: [main, task-builder]
---

# Keep the ticket current

When work is tied to a ticket (an agent-skills task note, or a task file in the vault or repo), the task note is the record of truth. Update it as work happens, not at the end.

- **Status in real time:** change the status at the moment the work changes state. For agent-skills task notes the values are `work-state.sh set` statuses: `todo`, `in-progress` (started), `blocked`, `review`, `done`, `cancelled`. "Waiting on approval" is not a status: record it as a `work-state.sh log` line. Never batch status changes to the end of a session or wave.
- **Final decisions in the note:** record every final decision when it is made: approved designs, answers the user picked in `ask`, chosen options and why, deviations from the plan, scope changes, and the outcome with its evidence. Record decisions only; skip options that were considered and dropped.
- **Use the note's own mechanism:** for agent-skills task notes, `work-state.sh set` for status and `work-state.sh log` for log lines, never hand-edited frontmatter; the log cadence is defined in agent-skills' `references/work-artifacts.md`. For other task files, use their status field and a decisions/log section.
- **Issue trackers (Jira etc.):** never comment on or edit a tracker issue unless the user asks, and ask before any status transition. Decisions go to the vault story/task notes, not the tracker.
- **One writer per ticket:** a subagent building a task updates that task's note itself. The orchestrator updates notes for work it does directly (claiming, approval gates, sequencing decisions) and never overwrites a running subagent's updates.
- If a note can't be updated (tool or permission failure), say so in the reply with the exact update that still needs to be made. Never skip it silently.
