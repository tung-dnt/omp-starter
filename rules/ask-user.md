---
description: Every question to the user goes through the ask tool as a one-question multiple-choice dialog.
alwaysApply: true
---

# Asking the user questions

Every question to the user goes through the `ask` tool as a one-question dialog with multiple-choice answers. This covers interviews (interview-me), grill rounds (grill-me), approval gates, setup confirmations, and clarifications.

- One question per `ask` call, one call per turn. Never several questions in one turn, and never a question asked only in prose.
- 2–5 real options with short labels. Put the trade-offs in each option's `description`. Set `recommended` to your best guess; this takes the place of a written `GUESS:` line.
- Never add an "Other" option: the UI adds one.
- Before the call, keep any context to a few prose lines: the evidence, plus a hypothesis/confidence line or a decision-brief table where the workflow requires one. The question itself goes only in the `ask` call.
- Approval gates still ask: use options like "Proceed" / "Revise …", never treat them as yes/no in prose.
- `multi: true` only when the choices really aren't mutually exclusive.
