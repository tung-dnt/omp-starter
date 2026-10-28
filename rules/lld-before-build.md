---
description: Every task from a written task breakdown needs an approved low-level design note before implementation.
alwaysApply: true
agents: [main, task-builder]
---

# Low-level design before building planned tasks

High-level design is done before tasks are broken down; low-level design is not. Before implementing any task from a written task breakdown (vault or repo plan), close that gap first.

**As `task-builder`:** the note is already approved. Build only what it says; if the build must depart from it, stop and report `blocked`. The rest of this rule is for the main session.

- Write the task's low-level design note before any code: signatures, invariants, failure branches, authorization, tests. Use the `low-level-design` skill when installed (agent-skills). Record the note in the task file.
- Pass the approval gate in agent-skills `references/approval-gate.md` ("Confirmation") on each note: show the result in chat, then one `ask` with Proceed / Revise, never plan mode. The same gate closes every planning phase (spec, design, plan). One approval per task note by default; `/build auto` and "don't stop" batch every note into one approval. Notes may be drafted in parallel; a task's implementation waits for its own recorded approval. Without agent-skills, show the catch-up summary, the note verbatim and its absolute path right before the dialog, and ask again after any revision.
- Large stories (more than about five tasks, or several repos) use that reference's slice gates: each task keeps its own note, one approval covers a repo-sized slice (the tasks that change the same repo and ship together, shown as a combined summary plus every note verbatim), then `work_state approve` runs for each task in the slice. Fifty per-task notes waiting on fifty gates is the failure this prevents.
- An approval stands once given: record it and start the approved work in the same turn. Never ask again for something already approved unless its design changed, and never stop after an approval to "confirm" it.
- Implement only what the approved note describes. When agent-skills is installed, delegate through the `task-builder` agent, one task per worktree.
- Run tasks in parallel only when their notes show no shared files or shared generated outputs (e.g. sqlc `querier.go`); otherwise run them in order. `/build` (build.toml) enforces this when it fills a wave.
- If implementation needs to depart from the approved note, stop that task and ask before continuing.
- This gate wins over any default to decide on your own. Ad-hoc requests (fixes, debugging, reviews, investigations) are not planned tasks and are unaffected.
