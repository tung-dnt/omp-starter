---
description: Every question to the user goes through the ask tool as a one-question dialog that carries its own context and trade-offs.
alwaysApply: true
agents: main
---

# Asking the user questions

**Ask, don't decide for the user.** Put every real decision to the user, never pick silently and continue: workflow and approval gates, interview and grill rounds (interview-me, grill-me), design and approach choices, scope changes, setup confirmations, clarifications. Look up facts yourself and bring only the decision, with your recommendation. Decide alone only for trivial mechanics with one sensible answer (naming a temp file, ordering independent reads), and say what you chose.

Every question goes through the `ask` tool:

- One question per call, one call per turn; never a question asked only in prose.
- 2–5 multiple-choice options. Never add "Other": the UI adds one. `multi: true` only when the choices really aren't mutually exclusive.

## The dialog must stand on its own

The user may see only the dialog, so it carries the whole decision brief. "Which approach?" or "Proceed?" with one-word options is never enough.

- `header`: a short chip naming the decision, e.g. `Q2 · Cache scope`.
- `question`: 2–4 sentences: what is being decided, why it matters now, and what it hinges on (the fact, requirement, or priority that settles it). Name the concrete thing (file, API, table, ticket), not "this" or "the approach".
- Each option: a short `label`, and a `description` always shaped `How: <what this option does>. Pros: <…>. Cons: <risks, cost>. Effort: S/M/L. Reversible: easy/hard.` Back each pro and con with evidence; mark guesses "(est.)".
- `preview`: detail an option needs beyond one line (code shape, schema, file list, a before/after).
- `recommended`: your pick. Its description starts `Recommended: <why it wins on what it hinges on>; choose <other> instead if <condition that would flip it>.`
- Approval gates name what is being approved and what proceeding does next, with options like "Proceed" / "Revise <what>".

Anything longer than the dialog can hold (the step's output, the decision-brief table a workflow such as grill-me requires) goes in the message before the call. That prose supplements the dialog; it never replaces the dialog's own context.
