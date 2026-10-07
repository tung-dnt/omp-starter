# omp-starter

A first-run setup plugin for [omp (Oh My Pi)](https://omp.sh) on macOS. The first time you open omp after installing it, it asks a few questions and sets up the steps below. On a fresh omp install it waits until omp's own setup screens are done (or until your first prompt), so its questions get keyboard focus:

| Step | What it does |
|---|---|
| **agent-skills** *(optional)* | Installs [tung-dnt/agent-skills](https://github.com/tung-dnt/agent-skills): engineering-workflow skills, agents and `/spec` `/plan` `/build` `/review` `/ship` commands. |
| **Model routing** *(Claude)* | Routes work to Opus, Sonnet, Haiku and Fable by job, with matching effort levels. Needs a Claude login. |
| **Knowledge base** | Uses an Obsidian vault as omp's knowledge base and long-term memory. Lets you pick a vault Obsidian already knows about, writes an `AGENTS.md` that points sessions at the knowledge base, injects the part of the memory index that applies to the current repo, and optionally adds a commit gate. |

Every step can be skipped.

## Install

```sh
omp plugin marketplace add tung-dnt/omp-starter
omp plugin install starter@omp-starter
omp
```

Before the knowledge-base step, open Obsidian once so your vault is registered (and synced, if it lives in iCloud).

## Model routing

Applied with `omp config set` after you confirm. Role assignments and per-agent overrides are merged into your existing settings; same-named entries are replaced.

| Work | Model | Effort |
|---|---|---|
| Main session | Opus 5.5 | `auto` (Haiku classifies each prompt; `ultrathink` forces `max`) |
| Plan mode, `reviewer` | Opus 5.5 | `high` |
| Coding subagents (`task`, agent-skills builders/testers) | Sonnet 5.5 | `high`; the parent can raise a slice to `max` |
| Exploration (`scout`), commits, `code-reviewer` | Sonnet 5.5 | default |
| Mechanical edits (`sonic`), titles, classifiers | Haiku 4.5 | default |
| Security agents | Opus 5.5 | `high` (never Fable) |
| `deep` agent, Ctrl+P `deep` role | Fable 5.1 | `high` |

The idea: spend effort on the plan, since it runs once and feeds every coding slice. Keep coders at a `high` floor and use `max` only for concurrency, migrations and shared contracts. Fallbacks run Fable → Opus → Sonnet for outages; a subscription limit stops the session instead of switching to paid API usage.

### Fable escalation

Fable is never the default. The `fable-router` extension escalates to it only when:

- **Stuck:** the same command fails twice in one run (searches like `grep` that just find nothing don't count). The agent is told it may delegate to the read-only `deep` agent. The notice is advisory: expected failures, such as a red test, and "don't spawn agents" instructions take precedence.
- **Risky review:** a `reviewer` or `code-reviewer` starts while the git diff touches migrations, `*.sql`, auth/RBAC, infra or CI workflows.

Every Fable spawn counts toward a daily cap: `FABLE_ROUTER_DAILY_CAP`, default 5, tracked in `~/.omp/agent/fable-router.json`. Past the cap, the spawn runs on Opus and the task panel shows a note saying so.

## Knowledge base

- **Vault:** chosen from Obsidian's own vault list, or any folder you type.
- **Knowledge-base folder:** a folder inside the vault (default `KnowledgeBase`). It is created with a `_memory/MEMORY.md` holding an empty `## Global` section if missing.
- **Space-free link:** omp's `@` imports stop at spaces, so a vault path containing spaces gets a `~/.omp-kb` symlink.
- **Always-loaded notes:** optional list of notes (relative paths) imported into every session, e.g. your coding standards.
- **Scope:** every omp session (`~/.omp/agent/AGENTS.md`) or only sessions under one folder (`<folder>/AGENTS.md`). An existing file is backed up before it's replaced.
- **Memory:** the `kb-memory` extension injects the memory index `_memory/MEMORY.md` (one line per note) into each session, scoped to the current repo. `## <Scope>` headings split the index; a section applies to the repos listed in a `<!-- repos: a, b -->` comment under its heading, or to the repo named by the heading itself. `## Global` (and any lines before the first heading) always loads; the other sections are listed by name with their note counts. A section with an empty `<!-- repos: -->` comment never loads, which suits long per-ticket lists. The repo name comes from the `origin` remote, so worktrees and suffixed clones match too. The index is read once per session. Subagents get it only when they write code (`task`, `task-builder`, `test-engineer`); read-only ones such as `scout` and reviewers skip it. The generated `AGENTS.md` tells the agent how to save new memories as notes in `_memory/` and which section to file them under.
- **Commit gate (optional):** blocks the agent's `git commit` under the chosen folder until it has written a knowledge-base note in that session. `[skip-mem]` in the commit message bypasses it. Only the `commit` subcommand is gated: `git commit-tree` or `git log --grep commit` pass.

The plugin also ships a `knowledge-base` skill for searching and creating notes in the knowledge base.

## Commands

- `/starter`: rerun every step.
- `/starter skills`, `/starter models`, `/starter kb`: rerun one step.

Answers are stored in `~/.omp/agent/omp-starter.json`. Delete a key to be asked again at the next start. The wizard only runs automatically in the interactive TUI: not in `omp -p` or subagents.

## agent-skills `/resume` hint

If agent-skills is installed, the plugin also ports its Claude Code SessionStart hook: when a session starts in a repository with claimed tasks, the agent is told to run `/resume`.

### Task tracking

agent-skills work state (stories, tasks, statuses) is stored as notes in the format of Obsidian's project-manager plugin (dotpm). Once the knowledge-base step is done, the notes live in your vault under `<vault>/<projectsFolder>/<repo>/stories` and `…/epics`, where `<projectsFolder>` is the project-manager plugin's setting (default `Projects`) and `<repo>` is the repository name. Without a vault, they live in the repo under `docs/stories`, with the same note format.

The plugin tells agent-skills where your vault is by writing `~/.config/agent-skills/config.json` (or under `$XDG_CONFIG_HOME`). It does this when the knowledge-base step finishes and again at each session start, so existing installs pick it up without rerunning the wizard. The file is per machine, other keys in it are kept, and the plugin never deletes it.

Two optional keys in a repo's committed `.agent-skills.json` override this:

- `"store": "repo"` keeps that repo's tasks in git, even when a vault is configured.
- `"vaultFolder": "group/name"` changes the folder used under the projects folder (default: the repo name).

## Asking questions

The plugin ships an always-on rule (`rules/ask-user.md`): the agent puts every real decision to you (gates, grill rounds, design and approach choices, scope) instead of deciding itself, and every question goes through omp's `ask` dialog, one question at a time, with 2–5 multiple-choice answers and a recommended pick. Each dialog carries its own context: what is being decided, why it matters now, and what it hinges on, and every option lists how it works, pros, cons, effort, and reversibility, with a preview for anything longer. That includes approval gates and setup confirmations; the agent never asks in plain prose.

A second always-on rule (`rules/how-means-plan.md`): a request phrased as "how …" is treated as planning and discussion. The agent investigates read-only, presents options, trade-offs and a recommendation, and asks before building anything.

A third always-on rule (`rules/lld-before-build.md`): before implementing any task from a written task breakdown, the agent writes that task's low-level design note and asks you to approve it, one task at a time. Approved tasks are built only as designed (through agent-skills' `task-builder` when installed), and run in parallel only when their notes show no shared files or generated outputs. Ad-hoc fixes, debugging and reviews are unaffected.

A fourth always-on rule (`rules/ticket-tracking.md`): work tied to a ticket (an agent-skills task note, a vault or repo task file, or a tracker issue such as Jira) updates the ticket's status as the work changes state, and records every final decision (approved designs, your `ask` answers, deviations, the outcome with its evidence) in the ticket when it is made. agent-skills task notes are updated through `work-state.sh`; one writer per ticket.

The rules load in the main session only, except `lld-before-build` and `ticket-tracking`, which also load in agent-skills' `task-builder` (it updates its own task note). Other subagents can't use the `ask` tool, so they don't carry these rules.

## License

MIT
