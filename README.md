# omp-starter

A first-run setup plugin for [omp (Oh My Pi)](https://omp.sh) on macOS. The first time you open omp after installing it, it asks a few questions and sets up the steps below. On a fresh omp install it waits until omp's own setup screens are done (or until your first prompt), so its questions get keyboard focus:

| Step | What it does |
|---|---|
| **agent-skills** *(optional)* | Installs [tung-dnt/agent-skills](https://github.com/tung-dnt/agent-skills): engineering-workflow skills, agents and `/spec` `/plan` `/build` `/review` `/ship` commands. |
| **Model routing** *(Claude-first)* | Saves `claude` and `codex` subscription presets without requiring a login. When the required Claude models are available, also routes work to Opus, Sonnet, Haiku and Fable by job, with matching effort levels; otherwise keeps the current routing. Using a preset requires its provider login. |
| **Knowledge base** | Uses Obsidian vaults as omp's knowledge base and long-term memory, one per folder if you like (e.g. `~/work` and `~/personal`). Lets you pick a vault Obsidian already knows about, writes an `AGENTS.md` that points sessions at the knowledge base, injects the part of the memory index that applies to the current repo, adds `kb_remember`/`kb_recall` memory tools, and optionally adds a commit gate. |
| **Display language** *(optional)* | Sets the target language of the `/trans` command, which translates on demand between any languages while the agent keeps working in English. Installs Google's Antigravity CLI and signs it in to your Google AI Pro/Ultra plan. |
| **Developer tools** *(optional)* | Sets up a language server (LSP) and a debugger (DAP) for JavaScript/TypeScript, Python, Go, Rust and C/C++ with the SDKs you already have. Offered on a brand-new install; existing installs run `/starter tools`. See [Language tooling](#language-tooling-starter-tools). |

Every step can be skipped.

## Install

```sh
omp plugin marketplace add tung-dnt/omp-starter
omp plugin install starter@omp-starter
omp
```

Before the knowledge-base step, open Obsidian once so your vault is registered (and synced, if it lives in iCloud).

## Model routing

Applied with `omp config set` after you confirm, on any subscription. Setup always saves both subscription presets and the settings that name no concrete model: effort, cycle order, per-agent overrides (role aliases such as `@tiny`), LSP diagnostics after every edit (`lsp.diagnosticsOnEdit`), and repeating rule reminders (`ttsr.repeatMode: after-gap`, `ttsr.repeatGap: 10`). It then applies active routing for the first subscription whose models are all available: Claude (table below), otherwise Codex (the `codex` preset's roles). With neither, active routing stays unchanged. Role assignments, named presets and per-agent overrides are merged into your existing settings; same-named entries are replaced.

| Work | Model | Effort |
|---|---|---|
| Main session | Opus 5.5 | `auto` (Haiku classifies each prompt; `ultrathink` forces `max`) |
| Plan mode, `reviewer` | Opus 5.5 | `high` |
| Coding subagents (`task`, agent-skills builders/testers) | Sonnet 5.5 | `high`; the parent can raise a slice to `max` |
| Commits, `code-reviewer` | Sonnet 5.5 | default |
| Exploration (`scout`), mechanical edits (`sonic`), titles, classifiers | Haiku 5.5 | default |
| Security agents | Opus 5.5 | `high` (never Fable) |
| `deep` agent, Ctrl+P `deep` role | Fable 5.1 | `high` |

The idea: spend effort on the plan, since it runs once and feeds every coding slice. Keep coders at a `high` floor and use `max` only for concurrency, migrations and shared contracts. Fallbacks run Fable → Opus → Sonnet for outages; a subscription limit stops the session instead of switching to paid API usage.

### Subscription presets

The model step saves two complete role setups, even when neither provider is logged in:

| Preset | Main session | Planning / deep consultation | Helpers |
|---|---|---|---|
| `claude` | Opus 5.5 (`auto`) | Opus 5.5 / Fable 5.1 (`high`) | Sonnet 5.5; Haiku 5.5 for exploration, tiny work and judgments |
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
- **Space-free link:** omp's `@` imports stop at spaces, so a vault path containing spaces gets a `~/.omp-kb` symlink (`~/.omp-kb-<vault>` when that name already points at another vault; existing links are never repointed).
- **Always-loaded notes:** optional list of notes (relative paths) imported into every session, e.g. your coding standards.
- **Scope:** every omp session (`~/.omp/agent/AGENTS.md`) or only sessions under one folder (`<folder>/AGENTS.md`). An existing file is backed up before it's replaced.
- **Several knowledge bases:** rerunning `/starter kb` opens a menu to add or replace a knowledge base for another folder, remove one (its `AGENTS.md` is backed up and deleted only if you agree; the vault is never touched), or choose the primary one. Each session uses the knowledge base whose folder contains its working directory. Folders must not contain each other, since omp loads every enclosing `AGENTS.md` and two knowledge-base roots would mix; "every omp session" is only offered while it is the sole knowledge base. agent-skills stores tasks in the primary knowledge base's vault. State written by 0.13 or earlier is read as one primary knowledge base.
- **Memory tools:** `kb_remember` saves a memory note to `_memory/<slug>.md` (nested `metadata:` frontmatter) and adds or updates its index line: under the `scope` you pass, else the section listing the current repo (a new `## <repo>` section if none does), else `## Global` outside a repo. `mode: "create"` refuses to overwrite an existing note; `mode: "update"` changes only the fields given and keeps other frontmatter keys. Index edits are serialized across sessions with a lock file in the temp folder and written atomically. `kb_recall` searches the notes' names, descriptions and bodies, optionally within one index section, and reports notes iCloud has evicted. Both use the knowledge base serving the session's folder and fail with a clear message outside every configured folder. They are discoverable tools (listed under `xd://`), so they add nothing to the prompt until used.
- **Memory:** the `kb-memory` extension injects the memory index `_memory/MEMORY.md` (one line per note) into each session, scoped to the current repo. `## <Scope>` headings split the index; a section applies to the repos listed in a `<!-- repos: a, b -->` comment under its heading, or to the repo named by the heading itself. `## Global` (and any lines before the first heading) always loads; the other sections are listed by name with their note counts. A section with an empty `<!-- repos: -->` comment never loads, which suits long per-ticket lists. The repo name comes from the `origin` remote, so worktrees and suffixed clones match too. The index is read once per session. Subagents get it only when they write code (`task`, `task-builder`, `test-engineer`); read-only ones such as `scout` and reviewers skip it. The generated `AGENTS.md` tells the agent how to save new memories as notes in `_memory/` and which section to file them under.
- **Commit gate (optional):** blocks the agent's `git commit` under the chosen folder until it has written a note in that folder's knowledge base in that session. `[skip-mem]` in the commit message bypasses it. Only the `commit` subcommand is gated: `git commit-tree` or `git log --grep commit` pass. The gate checks the folder the commit really runs in (bash `cwd`, a leading `cd <dir> &&`, `git -C <dir>`). A KB write counts when `kb_remember` succeeds, or when a `write`/`edit` target is inside that knowledge base (symlinked or real path) or a `vault://` path; mentioning the KB path in a file's content doesn't count, and a note written to another folder's knowledge base doesn't either. The folder must be an existing absolute path such as `~/projects`. Cancelling a step while rerunning `/starter` keeps that step's saved result.

**Read-only `/kb` commands** inspect the knowledge base serving the current session's folder; they do not change notes:

- `/kb` or `/kb status`: show the active knowledge base, memory index and session status.
- `/kb search <words>`: search note names, descriptions and bodies.
- `/kb scopes`: list index scopes and mark those loaded for the current repo.
- `/kb view [scope]`: show the memory index prepared for this session, or the current on-disk section for a named scope.
- `/kb check`: check indexed notes for consistency problems.

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

## Language tooling (`/starter tools`)

An optional step that gives omp a language server and a debugger for the languages you pick. It is offered once on a brand-new install (before any `omp-starter.json` exists); existing installs opt in with `/starter tools` (or a full `/starter`). A skipped or incomplete result is never re-offered at startup.

1. You confirm the step, then toggle languages (none is preselected).
2. It inspects your SDKs and configuration and shows a plan: the SDKs it found, each tool it would install with source, version and destination, and the config entries it would add. Nothing has run yet.
3. You confirm again. Then, one language at a time, it installs, verifies and applies. Declining at either prompt writes no tool or config file.
4. Esc or Ctrl+C cancels: owned processes are stopped, results from earlier runs are kept, and the summary lists what was already installed (installs are never rolled back).

It needs no provider login, never installs or changes an SDK, and never changes a project.

**Supported profiles.** macOS Apple Silicon and Intel, and Ubuntu/Debian glibc Linux x64. Anything else (other Linux, musl, Linux arm, Windows) is reported unsupported and nothing is installed. The CI workflow `.github/workflows/tooling.yml` exercises `macos-15-intel`, `macos-15` (arm64), `ubuntu-24.04` and a `debian:12` container, each with Node 24.22, TypeScript 6.0.3, Python (3.12 from setup-python; Debian 12 uses its system Python 3.11 with `python3-venv`), Go 1.27.2, Rust stable with `rust-src`, the runner's C and C++ compilers, omp 18.12.6 and Bun 1.4.3, plus a separate JavaScript/TypeScript run against TypeScript 7.0.2. Other versions that meet the minimums below are accepted but untested.

**SDKs you install yourself** (a missing or too-old one is reported as `needs-sdk` with the fix):

| Group | Needs |
|---|---|
| JavaScript / TypeScript | Node.js ≥ 22.22.2 with npm ≥ 7, and TypeScript 6 (`tsc`, regular npm install) or TypeScript 7 (native `tsc --lsp`). `tsc` also compiles the source-mapped TypeScript debug fixture. |
| Python | Python 3.10–3.14 with `venv` and `ensurepip` (Debian/Ubuntu: `python3-venv`). |
| Go | Go ≥ 1.27; toolchain downloads stay off (`GOTOOLCHAIN=local`). |
| Rust | `cargo` and `rustc` ≥ 1.56 and the `rust-src` component. |
| C / C++ | A working C compiler and a working C++ compiler (`cc`/`gcc`/`clang`, `c++`/`g++`/`clang++`); on macOS the Xcode Command Line Tools. |

**What gets installed.** Tools that already work (on `PATH` or in your config) are reused, never replaced. Otherwise the step installs, under `~/.omp/agent/tooling/` (one immutable folder per tool and version): typescript-language-server 6.0.2, js-debug 1.140.0, python-lsp-server 1.15.0 and debugpy 1.8.22 (private venv), gopls v0.24.0, Delve 1.27.2, rust-analyzer 2026-10-19, clangd 23.1.0 and one CodeLLDB 1.12.3 shared by Rust and C/C++. Entries are merged into your native `lsp.json` and `dap.json` (`~/.omp/agent`, following omp's profile and `PI_CONFIG_DIR` rules).

**Integrity and trust.** GitHub release assets are pinned by SHA-256 and checked before extraction. npm installs use a committed lockfile with scripts disabled, Python uses a committed hash lock with binary wheels only, and gopls is built with pinned module versions checked against the public Go checksum database. No upstream signature verification is performed, and Go-built binaries are not claimed to be bit-identical across compilers. js-debug listens on a loopback TCP port while a debug session runs.

**Verification.** Each language is checked in a private temporary directory (private HOME, no credentials, no model call) with a disposable fixture: omp's own `lsp` tool must resolve a cross-file definition, and its `debug` tool must stop at a breakpoint and read `answer = 42`. JavaScript and source-mapped TypeScript, and C and C++, are checked separately; Go launches a package directory. Your project is only inspected, never run in. LSP and DAP get independent results (`ready`, `unverified`, `missing`, `needs-sdk`, `unsupported`, `failed`, `skipped`), saved as `tooling` in `omp-starter.json`. A rerun re-verifies every tool; a stored `ready` is never trusted. The step is `done` only when both are `ready` for every language you selected.

**Config conflicts and switches.** Entries are only added to JSON files. A conflicting or shadowed entry (including one in another tool's config, a plugin or the project) is reported and never replaced; YAML files are not edited. A project-local executable runs only after you approve its exact path. If `lsp.enabled` or `debug.enabled` is `false`, the setting is left alone and the result stays `unverified` with the command to turn it on. omp starts a server only when the working directory itself holds a root marker (`Cargo.toml`, `compile_commands.json`, ...), so open omp at the project root.

**OS permissions for debugging.** On Linux, debugging needs ptrace of your own processes (`kernel.yama.ptrace_scope`, and containers must allow it, for example `--cap-add=SYS_PTRACE` with a seccomp profile that permits it). On macOS it needs the Command Line Tools and Developer Tools access (`DevToolsSecurity -enable`, or approve the authorization prompt). When the OS refuses, the debugger is reported not ready; nothing is changed for you.

## Commands

- `/starter`: rerun every step.
- `/starter skills`, `/starter models`, `/starter kb`, `/starter language`, `/starter tools`: rerun one step (`/starter kb` manages several knowledge bases once one exists).
- `/starter voice`: change only the voice (and offer `PERSONALITY.md` if missing).
- `/trans [--to <language>] [text | file | local://name.md]`: translate on demand (see above).

Answers are stored in `~/.omp/agent/omp-starter.json`. Delete a key to be asked again at the next start. The wizard only runs automatically in the interactive TUI: not in `omp -p` or subagents.

## agent-skills

agent-skills (0.6.23 and later) registers its own omp extension: the `work_state` tool its workflows run on, and the `/resume` hint shown when a session starts in a repository with claimed tasks. This plugin no longer ships that hint.

### Task tracking

agent-skills work state (stories, tasks, statuses) is stored as notes in the format of Obsidian's project-manager plugin (dotpm). Once the knowledge-base step is done, the notes live in your vault under `<vault>/<projectsFolder>/<repo>/stories` and `…/epics`, where `<projectsFolder>` is the project-manager plugin's setting (default `Projects`) and `<repo>` is the repository name. Without a vault, they live in the repo under `docs/stories`, with the same note format.

The plugin tells agent-skills where your vault is by writing `~/.config/agent-skills/config.json` (or under `$XDG_CONFIG_HOME`). It does this when the knowledge-base step finishes and again at each session start, so existing installs pick it up without rerunning the wizard. The file is per machine, other keys in it are kept, and the plugin never deletes it.

Two optional keys in a repo's committed `.agent-skills.json` override this:

- `"store": "repo"` keeps that repo's tasks in git, even when a vault is configured.
- `"vaultFolder": "group/name"` changes the folder used under the projects folder (default: the repo name).

## Asking questions

The plugin ships an always-on rule (`rules/ask-user.md`): the agent puts every real decision to you (gates, grill rounds, design and approach choices, scope) instead of deciding itself, and every question goes through omp's `ask` dialog: one `ask` call per turn, where a grill, interview or approval round is one call holding all the round's independent questions, each with 2–5 multiple-choice answers and a recommended pick. Each dialog carries its own context: what is being decided, why it matters now, and what it hinges on, and every option lists how it works, pros, cons, effort, and reversibility (Proceed/Continue confirmations get one-line descriptions; interview-me rounds use your guess as the recommended pick), with a preview for anything longer. That includes approval gates and setup confirmations; the agent never asks in plain prose.

A second always-on rule (`rules/how-means-plan.md`): a request phrased as "how …" (or in Vietnamese "làm sao …", "như thế nào …", "cách nào …") is treated as planning and discussion. The agent investigates read-only, presents options, trade-offs and a recommendation, and asks before building anything.

A third always-on rule (`rules/lld-before-build.md`): before implementing any task from a written task breakdown, the agent writes that task's low-level design note and gets your explicit approval through agent-skills' approval gate, one approval per note by default (`/build auto` and the approval gate's "Don't stop" batch mode show every note and ask once for all of them). Large stories (more than about five tasks, or several repos) use slice gates: every task keeps its own note, and one approval covers a repo-sized slice, after which each task in it is recorded as approved, so `work_state ready` and `task-builder` accept them. At the end of each planning phase (spec, design, plan, task design), the agent shows the result, settled decisions, and artifact path in chat, including a task's design verbatim, then asks for approval through the `ask` dialog in the same turn. No plan-mode toggle or Plan Review submission is required. Proceed authorizes the next step and the agent starts it in the same turn, without asking again; Revise updates the result and asks again. Approved tasks are built only as designed (through agent-skills' `task-builder` when installed), and run in parallel only when their notes show no shared files or generated outputs. Ad-hoc fixes, debugging and reviews are unaffected.

A fourth always-on rule (`rules/ticket-tracking.md`): work tied to an agent-skills task note, or a vault or repo task file, updates its status as the work changes state, and records every final decision (approved designs, your `ask` answers, deviations, the outcome with its evidence) there when it is made. agent-skills task notes are updated through `work_state` (`set` for status, `log` for decisions, with "waiting on approval" as a log line); one writer per ticket. Issue trackers such as Jira are never commented on unless you ask, and any status transition is asked first.

A fifth always-on rule (`rules/say-it-in-chat.md`): herdr web's Chat view collapses tool calls to their one-line intent, so the agent says in chat what a subagent will do (task, files, limits like "no push") and puts paths, branches and results in its prose, not only in tool arguments.

A sixth always-on rule (`rules/agent-sessions.md`): when the agent coordinates other agent sessions (herdr panes, terminals running omp or Claude), it never answers their `ask` dialogs or sends keystrokes to them; only you answer dialogs. It doesn't wait on a session with no event that will end the wait: it stops and says in chat what is blocked. Progress is reported from verified output, never from a session showing `running`, and building goes to subagents rather than extra top-level sessions.

Two tool-use rules (`rules/lsp-symbol-search.md`, `rules/dap-over-print.md`) are omp TTSR rules: the harness checks each tool call as it streams and adds a reminder after the result, so they work however long the session gets and survive compaction. When the agent greps for a code symbol (camelCase/PascalCase anywhere; snake_case when the command targets Rust or C/C++), it is pointed to `xd://lsp` `definition`/`references`/`symbols`/`rename`. When it adds `console.log`, `fmt.Print*`, `println!`/`dbg!`, `printf` or `std::cerr` to TS/JS, Go, Rust or C/C++ code, it is pointed to `xd://debug`. Both only remind and never block or interrupt; string, SQL-column and config-key searches don't trigger them. They load in the main session and `task-builder`.

The `ask`-based rules load in the main session only, except `lld-before-build` and `ticket-tracking`, which also load in agent-skills' `task-builder` (it updates its own task note). Other subagents can't use the `ask` tool, so they don't carry these rules.

## Release notes

### 0.18.0 — 2026-10-29

- **Added:** TTSR rules `lsp-symbol-search` and `dap-over-print` (main session and `task-builder`) remind the agent to use `xd://lsp` instead of grepping for symbols and `xd://debug` instead of print debugging, for TS/JS, Go, Rust and C/C++.
- **Changed:** the models step works on any subscription. Settings that name no model, now including `lsp.diagnosticsOnEdit: true` and `ttsr.repeatMode: after-gap` (gap 10), are always applied; active routing uses Claude when its models are available, otherwise Codex, otherwise stays unchanged. Previously a machine without Claude got only the presets. Run `/starter models` after updating.

### 0.17.0 — 2026-10-29

- **Changed:** the `claude` preset's `tiny` and `judge` roles move from Haiku 4.5 to Haiku 5.5, and `scout` now routes to `@tiny` (Haiku 5.5 under `claude`, `gpt-6-luna:low` under `codex`). Haiku 5.5 bills prompts over 100K tokens at 5x, so long coding subagents stay on Sonnet. Run `/starter models` after updating.

### 0.16.1 — 2026-10-28

- **Changed:** `rules/ask-user.md` lets the agent settle the mechanical choices that the Jev delegation rule hands to Jev (scope, request type, target repo, delegation) without an `ask`.

### 0.16.0 — 2026-10-28

- **Removed:** the agent-skills `/resume` hint extension (`extensions/agent-skills-hint.ts`). agent-skills 0.6.23 registers the hint itself, with the `work_state` tool that replaced its `work-state.sh`. Upgrade both plugins together.
- **Changed:** show planning results in the current chat and request explicit approval through `ask`, without requiring plan mode. Per-note approvals, batch gates, and re-approval after changes remain required.
- **Changed:** large stories (more than about five tasks or several repos) are approved per repo-sized slice, not per task, through agent-skills' slice gates: each task keeps its own note and is recorded as approved, so the build tooling accepts it. An approval is acted on in the same turn and never re-asked.
- **Changed:** `rules/how-means-plan.md` also recognises Vietnamese "how" phrasing ("làm sao", "như thế nào", "cách nào").
- **Changed:** `rules/ask-user.md` keeps waits short: facts are looked up before a phase's first question, every independent question goes into one dialog, and nothing but the lookups the answers require runs between rounds.
- **Added:** `rules/agent-sessions.md`: never answer another session's dialog or type into it, report a stall in chat instead of waiting, and report progress only from verified output.

### 0.15.0 — 2026-10-26

- **Added:** read-only `/kb` commands to inspect knowledge-base status, search notes, list scopes, view memory and check index consistency.


### 0.14.0 — 2026-10-27

- **Added:** `kb_remember` and `kb_recall` tools to save and search memory notes without hand-editing `MEMORY.md`.
- **Added:** one knowledge base per folder. `/starter kb` adds, replaces or removes knowledge bases and picks the primary one for agent-skills; the memory index, tools and commit gate follow the session's folder. Existing single-knowledge-base installs keep working unchanged.
- **Changed:** the generated `AGENTS.md` documents nested `metadata:` frontmatter for memory notes and points at `kb_remember`. Rerun `/starter kb` to regenerate it, or edit yours by hand.

### 0.13.0 — 2026-10-26

- **Added:** optional guided language tooling. `/starter tools` (offered once on a brand-new install) sets up an LSP and a debugger for JavaScript/TypeScript, Python, Go, Rust and C/C++ with your existing SDKs, after two confirmations, and proves each one with a real definition lookup and breakpoint stop before reporting it ready. Existing installs run `/starter tools` after updating.
- **Verified:** real LSP definitions and debugger breakpoint/variable checks for all five groups (seven fixture variants) on macOS 15 Intel/Apple Silicon, Ubuntu 24.04 x64 and Debian 12 x64; TypeScript 6 and a separate TypeScript 7 check. The pinned runtime is omp 18.12.6 with Bun 1.4.3. `.github/workflows/tooling.yml` retains per-platform JSON evidence for fresh installation, reuse, cancellation, config preservation and cleanup.

### 0.12.1 — 2026-10-26

- **Fixed:** `/starter models` saves both subscription presets without requiring a Claude or Codex login. Clients without the required Claude models keep their current routing. Existing installs must upgrade and rerun `/starter models`; using a preset still requires its provider login.

### 0.12.0 — 2026-10-22

- **Added:** complete `codex` and `claude` subscription presets; rerun `/starter models` after upgrading to save them. Setup remains Claude-first.
- **Fixed:** security agents follow the selected preset, and the Fable router no longer escalates Codex sessions to Claude.

## License

MIT
