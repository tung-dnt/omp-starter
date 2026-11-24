---
name: epic
description: Manual entry point for big work. A pstack multi-phase plan stored in the repo, split into stories. Never implements.
disable-model-invocation: true
---

# Epic

Needs the pstack skill kit (`/starter skills` → pstack). If `skill://poteto-mode` does not resolve, tell the user to install it and stop.

Big work that needs several PRs. The request is in the user's invocation text.

**Do not implement.** Do not edit code. The only file written is the plan, `plans/<NNN-name>.md` in the current repo (NNN = next free number). Plans live in the repo, not in the knowledge base. The `epic-guard` extension enforces this: from `/epic` until the user runs `/epic-done`, `/story` or `/build`, write and edit calls outside `plans/` are refused. A refusal means the work belongs in a story, not that you should find another way to write it.

## Steps

1. **Load the method.** Read `skill://poteto-mode` and follow its multi-phase plan playbook, `skill://poteto-mode/playbooks/multi-phase-plan.md`. Read `skill://architect` for types and module structure.
2. **Requirements.** Clarify one question at a time. Write the goal and numbered acceptance criteria at the top of the plan and get the user's approval.
3. **Decisions.** Record every significant decision with its rejected alternatives under `## Decisions`. The user decides each one.
4. **Stories.** Write one section per PR as the playbook says, each a vertical slice under about 400 lines, in build order. Head each `## Story N: <title>` (N from 1), with a `Depends on: story M` line when it needs an earlier story and the acceptance criteria it covers. Commit the plan.
5. **Hand off.** Show the stories with their dependencies and stop. Story N is built later as one PR: by hand with `/story`, which reads the plan, or by dispatch with `/build <repo> <branch> <plan> story=N`.
