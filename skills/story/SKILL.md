---
name: story
description: Manual entry point for one vertical slice. End to end, one PR, under ~400 changed lines. Clarify, TDD, review, verify with real test output.
disable-model-invocation: true
---

# Story

Needs the pstack skill kit (`/starter skills` → pstack). If `skill://poteto-mode` does not resolve, tell the user to install it and stop.

One vertical slice: end to end, one PR, under about 400 changed lines. The request is in the user's invocation text.

## Steps

1. **Clarify, one question at a time.** Ask exactly ONE question per `ask` call, with your best guess preselected. Stop when you can predict the answers. Write the acceptance criteria as a numbered list and get them confirmed.
   - If the repo has an epic plan covering this story (`plans/<NNN-name>.md` with a `## Story N` section), read it first. Ask only about what it leaves open.
   - In the interactive TUI, `/story` starts in plan mode (omp-starter `story-plan`): steps 1 and 2 are read-only. Write the plan with the confirmed acceptance criteria, the size check, the target branch and the build order, then submit it for approval. Approving it in Plan Review leaves plan mode and starts step 3. Without plan mode (print, RPC, unattended), confirm the criteria with `ask` as above.
2. **Size check.** If the slice needs more than about 400 lines, more than one PR, or several independent slices, stop and recommend `/epic`.
3. **Load the method.** Read `skill://poteto-mode` and follow it, using the feature playbook at `skill://poteto-mode/playbooks/feature.md`. Before code crosses a function boundary, read `skill://architect`. Build test-first with `skill://tdd`.
4. **Branch.** Confirm the target branch with the user before creating any branch.
5. **Review.** Read `skill://interrogate` and run it on your full diff. Fix every finding it proves.
6. **Verify.** Run the relevant test suite, plus the type check and lint the repo uses. Paste the real output. Map each acceptance criterion to the test that proves it.
7. **PR.** Ask before pushing. Then open one PR, following `skill://poteto-mode/playbooks/opening-a-pr.md`.

If the work outgrows the size limit, stop, report what is done, and recommend `/epic`.
