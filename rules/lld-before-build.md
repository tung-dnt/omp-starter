---
description: Every task from a written task breakdown needs an approved low-level design note before implementation.
alwaysApply: true
agents: [main, task-builder]
---

# Low-level design before building planned work

Before implementing any task from a written plan, write a low-level design artifact covering interfaces, invariants, failure cases, authorization and tests. Keep the design separate from mutable native todo progress, and give workers its artifact path.

- Show each design to the user and obtain explicit approval before implementation. One approval per task design is the default; an explicitly requested batch or repo-sized slice may cover every design shown together. Any scope or design departure stops the affected task until fresh approval is recorded.
- Implement only the approved design. If it cannot be followed, stop and report the precise blocker or proposed change instead of silently proceeding.
- As `task-builder`, consume the already-approved artifact; do not ask for approval again or approve a departure yourself. Report the precise blocker to the main session if the approved design cannot be followed.
- Keep native todo as the session's progress checklist. Native task execution does not establish verification; run the required tests and review independently.
- This rule applies to planned work. Ad-hoc fixes, debugging and investigations are not blocked on an LLD.
