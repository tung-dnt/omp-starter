# omp-starter

A first-run setup plugin for [omp (Oh My Pi)](https://omp.sh) on macOS. The first time you open omp after installing it, it asks a few questions and sets up the steps below. On a fresh omp install it waits until omp's own setup screens are done (or until your first prompt), so its questions get keyboard focus:

| Step | What it does |
|---|---|
| **agent-skills** *(optional)* | Installs [tung-dnt/agent-skills](https://github.com/tung-dnt/agent-skills): engineering-workflow skills, agents and `/spec` `/plan` `/build` `/review` `/ship` commands. |
| **Model routing** *(Claude-first)* | Saves `claude` and `codex` subscription presets without requiring a login. When the required Claude models are available, also routes work to Opus, Sonnet, Haiku and Fable by job, with matching effort levels; otherwise keeps the current routing. Using a preset requires its provider login. |
| **Knowledge base** | Uses an Obsidian vault as omp's knowledge base and long-term memory. Lets you pick a vault Obsidian already knows about, writes an `AGENTS.md` that points sessions at the knowledge base, injects the part of the memory index that applies to the current repo, and optionally adds a commit gate. |
| **Display language** *(optional)* | Sets the target language of the `/trans` command, which translates on demand between any languages while the agent keeps working in English. Installs Google's Antigravity CLI and signs it in to your Google AI Pro/Ultra plan. |

Every step can be skipped.

## Install

```sh
omp plugin marketplace add tung-dnt/omp-starter
omp plugin install starter@omp-starter
omp
```

Before the knowledge-base step, open Obsidian once so your vault is registered (and synced, if it lives in iCloud).

## Model routing

Applied with `omp config set` after you confirm. Setup saves both subscription presets regardless of login status. It applies Claude routing only when the required Claude models are available; otherwise all active routing settings stay unchanged. Role assignments, named presets and per-agent overrides are merged into your existing settings; same-named entries are replaced.

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

### Subscription presets

The model step saves two complete role setups, even when neither provider is logged in:

| Preset | Main session | Planning / deep consultation | Helpers |
|---|---|---|---|
| `claude` | Opus 5.5 (`auto`) | Opus 5.5 / Fable 5.1 (`high`) | Sonnet 5.5; Haiku 4.5 for tiny work and judgments |
| `codex` | GPT-6.1 Sol (`auto`) | GPT-6.1 Sol (`high`) | GPT-6 Luna; `high` for tasks, `low` for tiny work and judgments |

Existing installs: update the plugin and run `/starter models` to save the presets. Restart open sessions to load the routing changes, then switch inside omp:

```text
/modelpreset switch codex
/modelpreset switch claude
```

`/modelpreset` opens the picker. Switching replaces the model-role setup, not just the main conversation model; the security agents follow `@slow` rather than staying pinned to Claude. Other agent overrides and explicitly requested models are not part of a preset.

Both presets save `defaultThinkingLevel: auto`; the advisor uses Luna or Sonnet at `medium`. Presets do not change authentication, enable the advisor, or bypass subscription quotas. Use `/login openai-codex` for the Codex subscription and `/login anthropic` for Claude. No API key is installed by this step. The Fable router does not escalate or consume its local daily allowance while the active model is outside Anthropic, so the Codex preset stays on Codex for its deep/review paths.


### Fable escalation

Fable is never the default. While the active model is Anthropic, the `fable-router` extension escalates to it only when:

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
- **Commit gate (optional):** blocks the agent's `git commit` under the chosen folder until it has written a knowledge-base note in that session. `[skip-mem]` in the commit message bypasses it. Only the `commit` subcommand is gated: `git commit-tree` or `git log --grep commit` pass. The gate checks the folder the commit really runs in (bash `cwd`, a leading `cd <dir> &&`, `git -C <dir>`). A KB write counts only when a `write`/`edit` target is inside the knowledge base (symlinked or real path) or a `vault://` path; mentioning the KB path in a file's content doesn't count. The folder must be an existing absolute path such as `~/projects`. Cancelling a step while rerunning `/starter` keeps that step's saved result.

The plugin also ships a `knowledge-base` skill for searching and creating notes in the knowledge base.

## Display language and `/trans`

Nothing is translated automatically. You translate on demand with `/trans`; the result opens in a viewer or goes into the prompt editor, and never enters the model's context, so it costs no Claude tokens and the agent keeps working in English. The source text can be in any language (agy detects it), and the target can be any language.

- `/trans <text>`: text that is not in your display language is translated into it and shown in a viewer. Text already in your display language is translated into English and put in the prompt editor, for you to check and send.
- `/trans`: translates the last assistant reply into the display language.
- `/trans <file>` or `/trans local://<name>.md`: translates a file into the display language. A `local://` file is also saved beside the original as `<name>.<suffix>.md` (`notes.vi.md`, `notes.brazilian-portuguese.md`). Repo and vault files are only shown and never written.
- `/trans --to <language> …`: translates into any language instead, e.g. `/trans --to Japanese deploy tonight` or `/trans --to "Brazilian Portuguese" local://notes.md`.

The step asks for the display language: a preset (Vietnamese, Chinese, Japanese, Korean, Thai, Russian), any language name under **Other language…**, or English (no display language; `/trans --to` still works). Translation runs on Google's [Antigravity CLI](https://antigravity.google/docs/cli/headless/) (`agy`), so it uses your Google AI Pro/Ultra plan. Google's terms forbid using Gemini CLI or Antigravity sign-in tokens from third-party tools, and accounts have been suspended for it. Running Google's own CLI in headless mode is the allowed route.

- **Setup:** if `agy` is missing, the step asks first, then runs Google's installer (`~/.local/bin/agy`; the installer also adds that folder to your shell profile). It then opens Google sign-in in your browser and shows the URL in the dialog, so you can open it yourself on a headless machine. Paste the code the page shows into the dialog within 60 seconds; the whole sign-in gives up after 3 minutes. The step ends with a test call, which checks that the default model `gemini-3.8-flash-low` is available on your account. If it isn't, agy's default model is used.
- **Speed and failures:** a call takes about 5–15 seconds while the footer shows the status. A slow `agy` run gets a parallel second run after 9 seconds, the first result wins, and the command gives up after 3 minutes with a warning. `agy` runs with `--sandbox` from an empty scratch folder. Every translated text goes to Google; check your data-handling rules before using it on confidential work. Translating Vietnamese into English also repairs common speech-to-text slips.
- **Voice (form of address):** after sign-in the step asks how text translated into your display language addresses you. Vietnamese has presets: `tôi–bạn` (neutral), `em–anh/chị` (polite), and `Tèo` (em–đại ca, playful Hà Nội street style). Other languages get neutral. Every language can pick custom, which writes `~/.omp/agent/VOICE.md` for you to edit. The voice only changes wording: code, paths, numbers and warnings stay exact. Stored as `language.voice`.
- **Personality:** the same step offers to write `~/.omp/agent/PERSONALITY.md`, which replaces omp's default personality block for the main session. The agent debates plans, lists edge cases and keeps objecting until you settle it (e.g. "chốt"). An existing file is never overwritten. Pronouns live in the voice, because English has no "em/đại ca"; the personality stays in English so the agent keeps working in English.
- **Overrides:** `OMP_STARTER_AGY` sets the path to the `agy` binary. The language and model are stored as `language.name` and `language.model` in `omp-starter.json` (installs from before 0.11 that stored a preset `language.code` keep working).

## Commands

- `/starter`: rerun every step.
- `/starter skills`, `/starter models`, `/starter kb`, `/starter language`: rerun one step.
- `/starter voice`: change only the voice (and offer `PERSONALITY.md` if missing).
- `/trans [--to <language>] [text | file | local://name.md]`: translate on demand (see above).

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

The plugin ships an always-on rule (`rules/ask-user.md`): the agent puts every real decision to you (gates, grill rounds, design and approach choices, scope) instead of deciding itself, and every question goes through omp's `ask` dialog: one `ask` call per turn, where a grill, interview or approval round is one call holding all the round's independent questions, each with 2–5 multiple-choice answers and a recommended pick. Each dialog carries its own context: what is being decided, why it matters now, and what it hinges on, and every option lists how it works, pros, cons, effort, and reversibility (Proceed/Continue confirmations get one-line descriptions; interview-me rounds use your guess as the recommended pick), with a preview for anything longer. That includes approval gates and setup confirmations; the agent never asks in plain prose.

A second always-on rule (`rules/how-means-plan.md`): a request phrased as "how …" is treated as planning and discussion. The agent investigates read-only, presents options, trade-offs and a recommendation, and asks before building anything.

A third always-on rule (`rules/lld-before-build.md`): before implementing any task from a written task breakdown, the agent writes that task's low-level design note and gets your approval in plan mode, one approval per note by default (`/build auto` and the approval gate's "Don't stop" batch mode show every note in one plan). At the end of each planning phase (spec, design, plan, task design) the agent asks you to turn plan mode on (Alt+Shift+P; omp doesn't let the agent do it), submits the result to omp's Plan Review, and continues only after you approve it there; `refine` sends it back with your feedback. Approved tasks are built only as designed (through agent-skills' `task-builder` when installed), and run in parallel only when their notes show no shared files or generated outputs. Ad-hoc fixes, debugging and reviews are unaffected.

A fourth always-on rule (`rules/ticket-tracking.md`): work tied to an agent-skills task note, or a vault or repo task file, updates its status as the work changes state, and records every final decision (approved designs, your `ask` answers, deviations, the outcome with its evidence) there when it is made. agent-skills task notes are updated through `work-state.sh` (`set` for status, `log` for decisions, with "waiting on approval" as a log line); one writer per ticket. Issue trackers such as Jira are never commented on unless you ask, and any status transition is asked first.

A fifth always-on rule (`rules/say-it-in-chat.md`): herdr web's Chat view collapses tool calls to their one-line intent, so the agent says in chat what a subagent will do (task, files, limits like "no push") and puts paths, branches and results in its prose, not only in tool arguments.

The rules load in the main session only, except `lld-before-build` and `ticket-tracking`, which also load in agent-skills' `task-builder` (it updates its own task note). Other subagents can't use the `ask` tool, so they don't carry these rules.

## Release notes

### 0.12.1 — 2026-10-26

- **Fixed:** `/starter models` saves both subscription presets without requiring a Claude or Codex login. Clients without the required Claude models keep their current routing. Existing installs must upgrade and rerun `/starter models`; using a preset still requires its provider login.

### 0.12.0 — 2026-10-22

- **Added:** complete `codex` and `claude` subscription presets; rerun `/starter models` after upgrading to save them. Setup remains Claude-first.
- **Fixed:** security agents follow the selected preset, and the Fable router no longer escalates Codex sessions to Claude.

## License

MIT
