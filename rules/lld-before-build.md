---
description: Every task from a written task breakdown needs an approved low-level design note before implementation.
alwaysApply: true
agents: [main, task-builder]
---

# Low-level design before building planned tasks

High-level design is done before tasks are broken down; low-level design is not. Before implementing any task from a written task breakdown (vault or repo plan), close that gap first.

- Write the task's low-level design note before any code: signatures, invariants, failure branches, authorization, tests. Use the `low-level-design` skill when installed (agent-skills). Record the note in the task file.
- Get approval for each note through the `ask` tool, one task per call ("Proceed" / "Revise …"). Notes may be drafted in parallel; a task's implementation waits for its own approval.
- Implement only what the approved note describes. When agent-skills is installed, delegate through the `task-builder` agent, one task per worktree.
- Run tasks in parallel only when their notes show no shared files or shared generated outputs (e.g. sqlc `querier.go`); otherwise run them in order.
- If implementation needs to depart from the approved note, stop that task and ask before continuing.
- This gate wins over any default to decide on your own. Ad-hoc requests (fixes, debugging, reviews, investigations) are not planned tasks and are unaffected.
