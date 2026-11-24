---
name: quick-fix
description: Manual entry point for bugs and small tasks. Failing test, fix, run tests, show evidence. No spec, no planning.
disable-model-invocation: true
---

# Quick fix

Needs the pstack skill kit (`/starter skills` → pstack). If `skill://poteto-mode` does not resolve, tell the user to install it and stop.

One bug or one small task, about one file of production code. The request is in the user's invocation text. No spec and no planning.

## Steps

1. **Load the method.** Read `skill://poteto-mode` and follow its rules, using the bug-fix playbook at `skill://poteto-mode/playbooks/bug-fix.md`. Read `skill://tdd` and follow it.
2. **Red.** Reproduce the problem with a failing test. Show the failing output.
3. **Fix.** Fix the root cause with the smallest change.
4. **Green.** Run the new test and the existing tests for the touched module. Show the real output.
5. **Report.** Give the root cause, the files changed, and the test output going from failing to passing.

## Stop rule

Stop and tell the user to restart as `/story` if any of these is true:

- the fix needs production changes in more than about one file
- it touches a public contract (API, schema, migration, event, or shared config)
- it needs a design decision with more than one reasonable answer

If no test can reproduce the problem, say why, and show other evidence: command output or a screenshot.
