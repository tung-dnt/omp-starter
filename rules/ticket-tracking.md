---
description: Keep mutable work progress in one native session checklist; touch issue trackers only when the user asks.
alwaysApply: true
agents: [main, task-builder]
---

# Keep native progress current

Use the active session's native todo as the single mutable progress checklist. Update it as work changes state; do not create or update task-note status, a parallel board, or a project-wide claim.

- Keep plans, acceptance criteria, designs and decisions in static artifacts, and pass workers the relevant paths.
- Record durable decisions in the appropriate static design or decision artifact. Native task completion records execution outcome only; it is not test or review proof.
- **Issue trackers (Jira etc.):** comment on or edit a tracker issue only when the user asks, and ask before any status transition. Tracker changes notify the team and are hard to take back.
