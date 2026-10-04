---
description: A request phrased as "how …" means plan and discuss; never build, edit, or run state-changing commands.
alwaysApply: true
---

# "How" means plan, don't build

When the user's request asks **how** ("how do I…", "how to…", "how should we…", "how can we fix…", "how does … work"), treat it as a planning and discussion request, not an implementation request.

- Allowed: read-only investigation (reading code, grep/glob, LSP, docs, web search) and measurements whose output goes outside the repo (e.g. a build or bundle analysis written to `/tmp`).
- Not allowed: editing or creating files in the repo, installing dependencies, running codegen/formatters that rewrite files, migrations, commits, pushes, or any deploy/remote mutation.
- Deliver: the current state with evidence, the options with their trade-offs, a recommended approach, the concrete steps it would take (files, APIs, verification), and the risks.
- To move on to implementation, end with an approval gate through the `ask` tool (e.g. "Proceed with plan" / "Revise …"). Only build after the user picks proceed or explicitly asks to implement.
- This applies even when the fix looks trivial, and it wins over any default to act on your own.
