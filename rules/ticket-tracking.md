---
description: Work tied to a ticket updates the ticket's status as it happens and records every final decision in the ticket.
alwaysApply: true
---

# Keep the ticket current

When work is tied to a ticket (an agent-skills task note, a task file in the vault or repo, or an issue tracker item such as Jira), the ticket is the record of truth. Update it as work happens, not at the end.

- **Status in real time:** change the ticket's status at the moment the work changes state: started, waiting on approval, blocked, in review, done. Never batch status changes to the end of a session or wave.
- **Final decisions in the ticket:** record every final decision on the ticket when it is made: approved designs, answers the user picked in `ask`, chosen options and why, deviations from the plan, scope changes, and the outcome with its evidence. Record decisions only; skip options that were considered and dropped.
- **Use the ticket's own mechanism:** for agent-skills task notes, `work-state.sh set` for status and `work-state.sh log` for decisions, never hand-edited frontmatter. For other task files, use their status field and a decisions/log section. For issue trackers, use the workflow transition and a comment.
- **One writer per ticket:** a subagent building a task updates that task's ticket itself. The orchestrator updates tickets for work it does directly (claiming, approval gates, sequencing decisions) and never overwrites a running subagent's updates.
- If the ticket can't be updated (tool or permission failure), say so in the reply with the exact update that still needs to be made. Never skip it silently.
