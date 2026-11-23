---
description: The lead's decisions (framing, high-level design, invariants, risk, acceptance) go to the user through one self-contained ask form; low-level design and mechanics are the agent's.
alwaysApply: true
agents: main
---

# Asking the user questions

**Ask on the lead's decisions; own the rest.** The lead (the user) owns framing, high-level design (architecture, data model, API contracts, cross-system boundaries), invariants, risk and acceptance. Ask about those: gaps in the brief, invariants, contracts and scope. You own low-level design, code structure, test design and mechanics: decide them, and record each non-trivial choice with the rejected alternative in the PR's `## Decision log`. Don't ask to confirm what tools, code or docs can answer.

Every question goes through the `ask` tool, never only in prose:

- **One `ask` per turn**, one `<form>`. A grill, interview or approval round is one form holding all the round's independent questions; ask a question that depends on an unanswered one in the next round.
- **Keep the user's waits short.** Before a phase's first question, look up everything it needs in one parallel pass. Between rounds, record the answers, do only the lookups they made necessary, then ask the next round at once.
- **Shape:** one `<fieldset>` with a `<legend>` per question; radio buttons for one-of, checkboxes for many-of. Two to five options. Never add an "Other" option: the form adds one.
- **Preselect your recommendation** with `checked`. An unanswered form submits it.

## The form must stand on its own

The user may see only the form, so it carries the whole decision brief. "Which approach?" with one-word options is never enough.

- **Legend:** names the decision and the concrete thing it is about (file, API, table, ticket), e.g. `Q2 · Cache scope for /api/orders`.
- **Context `<p>`** before the options: what is being decided, why it matters now, and the fact or priority it hinges on, in two to four sentences.
- **Each option's label:** what it does, its main pro and con with evidence (mark guesses "(est.)"), and whether it is easy or hard to reverse. Approval gates name what is approved and what proceeding does next ("Proceed: build T03 as designed" / "Revise the error handling").
- **Recommended option:** says why it wins and what would flip the choice.
- **Longer detail** (diffs, file lists, a decision table) goes inside the form as `<pre>` or `<table>`. Paths the user may want to open also go in chat prose in the same turn: many clients (herdr web, for one) make nothing inside the form clickable.
