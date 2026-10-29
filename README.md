# omp-starter

A first-run setup plugin for [omp (Oh My Pi)](https://omp.sh) on macOS. The first time you open omp after installing it, it asks a few questions and sets up the steps below. On a fresh omp install it waits until omp's own setup screens are done (or until your first prompt), so its questions get keyboard focus:

| Step | What it does |
|---|---|
| **agent-skills** *(optional)* | Installs [tung-dnt/agent-skills](https://github.com/tung-dnt/agent-skills): engineering-workflow skills, agents and `/spec` `/plan` `/build` `/review` `/ship` commands. Once installed, `/starter skills` offers to update it. |
| **Model routing** *(Claude-first)* | Saves `claude` and `codex` subscription presets without requiring a login. When the required Claude models are available, also routes work to Opus, Sonnet, Haiku and Fable by job, with matching effort levels; otherwise keeps the current routing. Using a preset requires its provider login. |
| **TypeSafe Jev judge** *(optional)* | Routes omp's `judge` role to TypeSafe Jev after checking your API key, and stores the key in `~/.omp/agent/.env` (mode 600). Jev then answers `question` rules such as the LSP-over-grep reminder and picks the thinking level per prompt. Offered on a brand-new install; existing installs run `/starter jev`. See [TypeSafe Jev judge](#typesafe-jev-judge-starter-jev). |
| **Knowledge base** | Uses Obsidian vaults as omp's knowledge base and long-term memory, one per folder if you like (e.g. `~/work` and `~/personal`). Lets you pick a vault Obsidian already knows about, writes an `AGENTS.md` that points sessions at the knowledge base, injects the part of the memory index that applies to the current repo, adds `kb_remember`/`kb_recall` memory tools, and optionally adds a commit gate. |
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

### TypeSafe Jev judge (`/starter jev`)

Optional. It sends judged tool calls and your prompts to TypeSafe (processed in the US), so skip it if your data rules don't allow that.

1. If `TYPESAFE_API_KEY` is already in the environment it is used and never written to disk. Otherwise the step asks for the key (the input is not masked) and saves it to `~/.omp/agent/.env` with mode 600, replacing an earlier `TYPESAFE_API_KEY` line and keeping the rest. omp loads that file into its process, so bash and eval children (for example agent-skills' `jev.sh`) see the key too.
2. The key is checked with one tiny Jev request. A rejected or unreachable key stops the step with nothing changed.
3. `modelRoles.judge` and the `judge` of the saved `claude`/`codex` presets become `typesafe/jev-1.14.0`, with `@tiny` as fallback; `ttsr.judge` stays `auto`. `/starter models` keeps Jev as the judge while this step is on.
4. `lsp-symbol-search` (regex) goes into `ttsr.disabledRules` and `rules/lsp-symbol-judged.md` takes over: Jev reads every non-piped `rg`/`grep` and decides whether it searches for a code symbol. Over 45 real commands it caught 24/24 symbol searches (the regex caught 7) with 2 of 21 other searches flagged, both containing an identifier.

Rerunning `/starter jev` offers to turn Jev off: the presets' own judges and the regex rule come back, and the key stays in `~/.omp/agent/.env`. While Jev is on and unreachable, no LSP reminder fires.

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
- `/starter skills`, `/starter models`, `/starter jev`, `/starter kb`, `/starter tools`: rerun one step (`/starter skills` offers to update an installed agent-skills and reports the old and new version; `/starter kb` manages several knowledge bases once one exists; `/starter jev` turns Jev off when it is on).

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

A fifth always-on rule (`rules/say-it-in-chat.md`): chat views that collapse tool calls to their one-line intent (herdr web's Chat view, for one) hide subagent briefs and paths, so the agent says in chat what a subagent will do (task, files, limits like "no push") and puts paths, branches and results in its prose, not only in tool arguments.

A sixth always-on rule (`rules/agent-sessions.md`): when the agent coordinates other agent sessions (tmux or herdr panes, terminals running omp or Claude), it never answers their `ask` dialogs or sends keystrokes to them; only you answer dialogs. It doesn't wait on a session with no event that will end the wait: it stops and says in chat what is blocked. Progress is reported from verified output, never from a session showing `running`, and building goes to subagents rather than extra top-level sessions.

A seventh always-on rule (`rules/cross-repo-investigation.md`): an investigation that spans two or more repositories follows the `end-to-end-technical-flow-report` skill with one `scout` per repo. Each scout writes `local://<repo>-trace.md` with `path:start-end`, the symbol, a short excerpt and an evidence label; the main session reads those reports and opens only the cited range of a claim it doubts. Its turns carry the whole conversation, so a file read there costs many times a scout's read.

An eighth always-on rule (`rules/subagent-absolute-paths.md`) loads in every subagent and never in the main session: `read`, `edit`, `write`, `glob` and `lsp` resolve relative paths from the session's directory, not from where `bash` `cd`'ed, so subagents pass them absolute paths. Before it, subagents of a session started in a parent folder of the repo lost a turn on each relative `read`/`lsp` call that came back "not found".

Three tool-use rules (`rules/lsp-symbol-search.md`, `rules/dap-over-print.md`, `rules/delegate-cross-repo-reads.md`) are omp TTSR rules: the harness checks each tool call as it streams and adds a reminder after the result, so they work however long the session gets and survive compaction. When the agent greps for a code symbol (camelCase/PascalCase anywhere; snake_case when the command targets Rust or C/C++), it is pointed to `xd://lsp` `definition`/`references`/`symbols`/`rename`. When it adds `console.log`, `fmt.Print*`, `println!`/`dbg!`, `printf` or `std::cerr` to TS/JS, Go, Rust or C/C++ code, it is pointed to `xd://debug`. When the main session reads a source file, or runs `rg`/`grep`, by absolute path, wherever your repositories live, it is pointed to the cross-repo scout fan-out. `/tmp`, hidden folders (`~/.omp`, a `.obsidian` vault), `node_modules` and system folders don't count, and `fd`/`find` only list files and don't trigger it. Relative paths don't trigger it either; if it fires while the session works in its one repo, the reminder itself says to carry on. All three only remind and never block or interrupt; string, SQL-column and config-key searches don't trigger the LSP rule. The LSP and debugger rules load in the main session and `task-builder`; the cross-repo rule loads in the main session only.

With the Jev step on, `rules/lsp-symbol-judged.md` replaces the regex LSP rule (which goes into `ttsr.disabledRules`): it prefilters every non-piped `rg`/`grep` and asks Jev whether the command looks up a code symbol, so forms the regex misses (`export function X`, `^func Test`, `a|b|X`, `X(`) also get the reminder. It loads in the main session, `task-builder`, the default `task` agent (also vibe's `good` workers), `code-reviewer` and `test-engineer`; `task-builder` needs agent-skills 0.6.25 or later, the first version that gives it the `lsp` tool. Without a TypeSafe judge (`ttsr.judge: auto`) the judged rule never runs and costs nothing.

The same Jev step turns on `extensions/lsp-guard.ts`, which blocks instead of reminding, in coding subagents only (`task-builder`, `task`, `code-reviewer`, `test-engineer`). Before an `rg`/`grep` runs, code drops what is text by construction: a grep reading another command's output, and searches whose every path is `/tmp`, an artifact, `node_modules`, docs, SQL/migrations, data or logs. Jev then judges the rest with the judged rule's own question. At p ≥ 0.85 the call is blocked with the exact `lsp`/`xd://lsp` call to make instead. Appending `# text-search` to the command lets it run, for a language with no server or a real text search. No key, a timeout or a bad answer lets the command run. On 94 labelled greps from real subagent sessions it blocked 27 of 36 symbol lookups and 3 of 58 other searches (two of those three also grepped identifiers).

The `ask`-based rules load in the main session only, except `lld-before-build` and `ticket-tracking`, which also load in agent-skills' `task-builder` (it updates its own task note). Other subagents can't use the `ask` tool, so they don't carry these rules.

## Release notes

### 0.26.0 — 2026-10-29

- **Added:** `lsp-guard` (with `/starter jev` on): coding subagents' `rg`/`grep` symbol lookups are blocked before they run and pointed at the language server, at Jev p ≥ 0.85, with `# text-search` as the escape hatch. Reminders alone didn't work: in a live session a `task` agent got three and called LSP 0 times.
- **Changed:** the `lsp-symbol-judged` reminder gives ready-to-paste `xd://lsp` JSON calls (references, definition, symbols, rename) instead of tool names, so using LSP takes one step.

### 0.25.0 — 2026-10-29

- **Fixed:** `delegate-cross-repo-reads` matched only `~/projects/<repo>/`, so it never fired for code kept anywhere else (`~/code`, `~/src`, `/Users/<you>/work`). It now matches source reads and `rg`/`grep` by any absolute path, except `/tmp`, hidden folders, `node_modules` and system folders. Replayed against a day of real reads it still catches 64 of 64 source reads and none of 230 others. It also fires when the main session reads its own repo by absolute path; the reminder says to carry on then.
- **Changed:** `say-it-in-chat`, `agent-sessions` and `ask-user` no longer assume herdr web: they describe chat views that collapse tool calls and terminal multiplexers in general, with herdr as one example.

### 0.24.0 — 2026-10-29

- **Added:** always-on rule `subagent-absolute-paths` (every subagent, not the main session): file tools and `lsp` take absolute paths. In two live sessions started in a parent folder of their repos, subagents hit 7 "not found" errors in 30 minutes from relative `read`/`lsp` paths after `cd` into a repo.
- **Changed:** `lsp-symbol-judged` also loads in `code-reviewer` and `test-engineer`, which have `xd://lsp`; a reviewer grepped symbols about 5 times in one review without a reminder.

### 0.23.0 — 2026-10-29

- **Added:** `/starter skills` (and a full `/starter`) offers to update an installed agent-skills: it refreshes the marketplaces, upgrades the plugin, and reports the old and new version. Previously it returned silently once agent-skills was installed. The startup wizard still never asks.

### 0.22.0 — 2026-10-29

- **Changed:** the Jev-judged `lsp-symbol-judged` rule also loads in the default `task` agent (and vibe `good` workers), which have `xd://lsp`. In `task-builder` it needs agent-skills 0.6.25, which adds the `lsp` tool; before that the reminder pointed task-builder at a tool it didn't have, and live it used LSP 0 times in 5 symbol searches.
- **Fixed:** `delegate-cross-repo-reads` no longer fires on `fd`/`find` under `~/projects/<repo>/` (listing files puts no source in context), nor on an `rg`/`grep` that searches elsewhere while the bash call's `cwd` is under `~/projects` (the match used to run past the end of the command into the `cwd` argument). `rg`/`grep` on a `~/projects` path and source-file reads still trigger it.

### 0.21.0 — 2026-10-29

- **Added:** optional TypeSafe Jev judge step (`/starter jev`, offered on brand-new installs). It verifies the API key, stores it in `~/.omp/agent/.env` (mode 600) unless `TYPESAFE_API_KEY` is already set, routes the `judge` role and both presets' judges to `typesafe/jev-1.14.0`, and swaps the regex `lsp-symbol-search` rule for the Jev-judged `lsp-symbol-judged` (24/24 vs 7/24 symbol searches on real commands). Rerunning it turns Jev off. `/starter models` keeps the Jev judge while the step is on.

### 0.20.0 — 2026-10-29

- **Added:** always-on rule `cross-repo-investigation` and TTSR rule `delegate-cross-repo-reads` (main session). Cross-repo investigations fan out one scout per repo with cited `path:line` reports, and the main session gets a reminder when it reads or searches source under `~/projects/<repo>/` itself. On PAC2-6473 the main session read 64 source files across six repos in one day, at about 10–40x the per-turn cost of a scout; replayed against that day, the reminder fires on all 64 and on none of its 230 vault, `/tmp` and skill reads.

### 0.19.0 — 2026-10-29

- **Removed:** the display-language step, the `/trans` command, `/starter language`, `/starter voice`, and the Antigravity CLI (`agy`) integration with its voice and `PERSONALITY.md` offers. The step installed and tested `agy` for 10+ seconds with nothing on screen, right between the knowledge-base and language-tooling steps, so users quit the wizard thinking it was done and lost the LSP step. After updating, the wizard goes straight from the knowledge base to language tooling. Files the step wrote (`~/.local/bin/agy`, `~/.omp/agent/VOICE.md`, `~/.omp/agent/PERSONALITY.md`) and the `language` key in `omp-starter.json` are left in place; delete them if you no longer want them.

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
