---
description: Every question to the user goes through the ask tool as a one-question dialog that carries its own context and trade-offs.
alwaysApply: true
---

# Asking the user questions

Every question to the user goes through the `ask` tool as a one-question dialog with multiple-choice answers. This covers interviews (interview-me), grill rounds (grill-me), approval gates, setup confirmations, and clarifications.

**Ask, don't decide for the user.** Put every real decision to the user: workflow gates, grill rounds, design and interview choices, approach choices, and scope changes. Never pick silently and continue. Look up facts yourself; put only the decision to the user, with your recommendation. Decide alone only for trivial mechanics with one sensible answer (naming a temp file, ordering independent reads), and say what you chose.

- One question per `ask` call, one call per turn. Never several questions in one turn, and never a question asked only in prose.
- Never add an "Other" option: the UI adds one.
- `multi: true` only when the choices really aren't mutually exclusive.

## The dialog must stand on its own

The user may see only the dialog, so it carries the whole decision brief. A terse question like "Which approach?" or "Proceed?" with one-word options is never enough.

- `header`: a short chip naming the decision, e.g. `Q2 · Cache scope`.
- `question`: 2–4 sentences: what is being decided, why it matters now, and what it hinges on (the fact, requirement, or priority that settles it). Name the concrete thing (file, API, table, ticket), not "this" or "the approach".
- 2–5 options. `label`: a short name. `description`, every time, in this shape:
  `How: <what this option does>. Pros: <…>. Cons: <risks, cost>. Effort: S/M/L. Reversible: easy/hard.`
  Back each pro and con with evidence; mark guesses "(est.)".
- `preview`: when an option needs more than a line to judge (code shape, schema, file list, a before/after), put that detail there.
- `recommended`: your pick. Start that option's description with `Recommended: <why it wins on what it hinges on>; choose <other> instead if <condition that would flip it>.`
- Approval gates name what is being approved and what proceeding does next. Use options like "Proceed" / "Revise <what>", each with a description; never ask yes/no in prose.

In the message before the call, show anything longer than the dialog can hold: the step's output, or the decision-brief table a workflow (grill-me, approval gate) requires. Prose there supplements the dialog; it never replaces the context the dialog itself must carry.
