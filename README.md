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

The idea: spend effort on the plan, since it runs once and feeds every coding slice. Keep coders at a `high` floor and use `max` only for concurrency, migrations and shared contracts. Fallbacks stay within the subscription: Fable → Opus → Sonnet on Claude, Astra → Sol on Codex. A subscription limit stops the session instead of switching to paid API usage.

### Subscription presets

The model step saves two complete role setups, even when neither provider is logged in:

| Preset | Main session | Planning / deep consultation | Helpers |
|---|---|---|---|
| `claude` | Opus 5.5 (`auto`) | Opus 5.5 / Fable 5.1 (`high`) | Sonnet 5.5; Haiku 5.5 for exploration, tiny work and judgments |
| `codex` | GPT-6.1 Sol (`auto`) | GPT-6.1 Sol / GPT-6 Astra (`high`) | GPT-6 Luna; `high` for tasks, `low` for tiny work and judgments |

Existing installs: update the plugin and run `/starter models` to save the presets. Restart open sessions to load the routing changes, then switch inside omp:

```text
/modelpreset switch codex
/modelpreset switch claude
```

`/modelpreset` opens the picker. Switching replaces the model-role setup, not just the main conversation model; the security agents follow `@slow` rather than staying pinned to Claude. Other agent overrides and explicitly requested models are not part of a preset.

Both presets save `defaultThinkingLevel: auto`; the advisor uses Luna or Sonnet at `medium`. Presets do not change authentication, enable the advisor, or bypass subscription quotas. Use `/login openai-codex` for the Codex subscription and `/login anthropic` for Claude. No API key is installed by this step. The escalation router selects Fable only in Anthropic sessions and Astra only in OpenAI Codex sessions; other providers are untouched. Setup saves both subscriptions' fallback chains, so switching presets does not require rerunning setup.


### Fable / Astra escalation

Neither escalation model is the default. The `fable-router` extension uses Fable for an active Anthropic model and Astra for an active OpenAI Codex model:

- **Stuck:** the same command fails twice in one run (searches like `grep` that just find nothing don't count). The agent is told it may delegate to the read-only `deep` agent. The notice is advisory: expected failures, such as a red test, and "don't spawn agents" instructions take precedence.
- **Risky review:** a `reviewer` or `code-reviewer` starts while the git diff touches migrations, `*.sql`, auth/RBAC, infra or CI workflows.

Every routed escalation spawn counts toward its subscription's daily cap. Claude uses `FABLE_ROUTER_DAILY_CAP` (default 5), tracked in `~/.omp/agent/fable-router.json`, then falls back to Opus. Codex uses `ASTRA_ROUTER_DAILY_CAP` (default 5), tracked separately in `~/.omp/agent/astra-router.json`, then falls back to Sol. The task panel shows the escalation reason or cap fallback. The `deep` agent stays read-only, and security agents stay on `@slow`.

**Do:** delegate an unexpectedly stuck investigation to `deep`, with evidence and the commands already tried. Keep routine work on Sol/Luna or Opus/Sonnet.

**Don't:** make Astra/Fable the default, repeatedly escalate expected red tests, or treat the local daily counter as the provider's subscription quota.

**Verify:** run `bun test extensions/fable-router.test.ts extensions/lib/routing.test.ts`. After `/starter models`, the Codex preset's `deep` role is `openai-codex/gpt-6-astra:high`; the main role remains Sol. Restart open sessions after updating the plugin.

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

**Supported profiles.** macOS Apple Silicon and Intel, and Ubuntu/Debian glibc Linux x64. Anything else (other Linux, musl, Linux arm, Windows) is reported unsupported and nothing is installed. The CI workflow `.github/workflows/tooling.yml` exercises `macos-15-intel`, `macos-15` (arm64), `ubuntu-24.04` and a `debian:12` container, each with Bun 1.4.4, Node 24.22, TypeScript 6.0.3 (installed with `bun add --global`), Python (3.12 from setup-python; Debian 12 uses its system Python 3.11 with `python3-venv`), Go 1.27.2, Rust stable with `rust-src`, the runner's C and C++ compilers and omp 18.12.6, plus a separate JavaScript/TypeScript run against TypeScript 7.0.2. Other versions that meet the minimums below are accepted but untested.

**SDKs you install yourself** (a missing or too-old one is reported as `needs-sdk` with the fix):

| Group | Needs |
|---|---|
| JavaScript / TypeScript | Bun ≥ 1.4.4 (the language server and both debuggers run on it; the step never installs Bun), and TypeScript 6 (`tsc`, a regular installation such as `bun add --global typescript@6`) or TypeScript 7 (native `tsc --lsp`). Node.js ≥ 22.22.2 is needed only to debug Node programs with js-debug. npm is not used. `tsc` also compiles the source-mapped TypeScript debug fixture. |
| Python | Python 3.10–3.14 with `venv` and `ensurepip` (Debian/Ubuntu: `python3-venv`). |
| Go | Go ≥ 1.27; toolchain downloads stay off (`GOTOOLCHAIN=local`). |
| Rust | `cargo` and `rustc` ≥ 1.56 and the `rust-src` component. |
| C / C++ | A working C compiler and a working C++ compiler (`cc`/`gcc`/`clang`, `c++`/`g++`/`clang++`); on macOS the Xcode Command Line Tools. |

**What gets installed.** Tools that already work (on `PATH` or in your config) are reused, never replaced. Otherwise the step installs, under `~/.omp/agent/tooling/` (one immutable folder per tool and version): typescript-language-server 6.0.2 (run on Bun), js-debug 1.140.0 (its adapter runs on Bun, the Node programs it debugs on Node), the Bun debugger (Bun's own debug adapter from oven-sh/bun commit `38afee6c`, vendored in this plugin), python-lsp-server 1.15.0 and debugpy 1.8.22 (private venv), gopls v0.24.0, Delve 1.27.2, rust-analyzer 2026-10-19, clangd 23.1.0 and one CodeLLDB 1.12.3 shared by Rust and C/C++. Entries are merged into your native `lsp.json` and `dap.json` (`~/.omp/agent`, following omp's profile and `PI_CONFIG_DIR` rules).

**Which JavaScript debugger.** One `dap.json` serves every project, so both JavaScript debuggers are installed. omp picks `js-debug-adapter` for JavaScript and TypeScript whenever no adapter is named, even in a project whose only lockfile is `bun.lock` (checked with omp 18.12.5). So in Bun projects (`bun.lock`, `bun.lockb` or `bunfig.toml`) pass `adapter: "bun-debug-adapter"` to the `debug` tool; `rules/dap-over-print.md` tells agents to. The Bun debugger starts paused (`stopOnEntry` on by default) because Bun 1.4.4 ignores its own pause-at-start setting: set breakpoints, then continue.

**Integrity and trust.** GitHub release assets are pinned by SHA-256 and checked before extraction. The language server installs with `bun install --frozen-lockfile --ignore-scripts` from a committed `bun.lock` (an install without a matching lock is refused), Python uses a committed hash lock with binary wheels only, and gopls is built with pinned module versions checked against the public Go checksum database. The Bun debugger is not a release asset: Bun publishes no standalone adapter, so its source is vendored under `vendor/bun-dap/` at one pinned upstream commit with a per-file SHA-256 list, the upstream licence statement and the exact upstream paths in `vendor/bun-dap/PROVENANCE.md` (a test checks the list against the files); its three dependencies (`semver`, `source-map-js`, `ws`) come from the vendored lock the same way. No upstream signature verification is performed, and Go-built binaries are not claimed to be bit-identical across compilers. js-debug listens on a loopback TCP port while a debug session runs.

**Verification.** Each language is checked in a private temporary directory (private HOME, no credentials, no model call) with a disposable fixture: omp's own `lsp` tool must resolve a cross-file definition, and its `debug` tool must stop at a breakpoint and read `answer = 42`. JavaScript, source-mapped TypeScript and Bun, and C and C++, are checked separately; Go launches a package directory. Your project is only inspected, never run in. LSP and DAP get independent results (`ready`, `unverified`, `missing`, `needs-sdk`, `unsupported`, `failed`, `skipped`), saved as `tooling` in `omp-starter.json`. A rerun re-verifies every tool; a stored `ready` is never trusted. The step is `done` only when both are `ready` for every language you selected.

**Config conflicts and switches.** Entries are only added to JSON files. A conflicting or shadowed entry (including one in another tool's config, a plugin or the project) is reported and never replaced; YAML files are not edited. A project-local executable runs only after you approve its exact path. If `lsp.enabled` or `debug.enabled` is `false`, the setting is left alone and the result stays `unverified` with the command to turn it on. omp starts a server only when the working directory itself holds a root marker (`Cargo.toml`, `compile_commands.json`, ...), so open omp at the project root.

**OS permissions for debugging.** On Linux, debugging needs ptrace of your own processes (`kernel.yama.ptrace_scope`, and containers must allow it, for example `--cap-add=SYS_PTRACE` with a seccomp profile that permits it). On macOS it needs the Command Line Tools and Developer Tools access (`DevToolsSecurity -enable`, or approve the authorization prompt). When the OS refuses, the debugger is reported not ready; nothing is changed for you.

## Commands

- `/starter`: rerun every step.
- `/starter skills`, `/starter models`, `/starter jev`, `/starter kb`, `/starter tools`: rerun one step (`/starter skills` offers to update an installed agent-skills and reports the old and new version; `/starter kb` manages several knowledge bases once one exists; `/starter jev` turns Jev off when it is on).
- `/starter updates`: check installed/published versions of both `agent-skills@tung-agent-skills` and `starter@omp-starter`; confirm each plugin/scope before updating.

Answers are stored in `~/.omp/agent/omp-starter.json`. Delete a key to be asked again at the next start. The wizard only runs automatically in the interactive TUI: not in `omp -p` or subagents.

### Confirmed plugin updates

Run `/starter updates` when you want to check. There is no added startup version request, polling timer, or background updater. `/starter skills` uses the same version-check/update helper for agent-skills and retains its existing confirmed installation flow when skills are missing.

The updater reads structured native installation metadata and the two official public catalogs. A newer semantic version is offered with its `user` or `project` scope; equal/older versions are not reinstalled. Only confirmation permits refreshing that named marketplace and invoking native upgrade for that exact plugin/scope. Missing plugins and unmanaged npm/link/Git copies are not converted or overwritten.

| Do | Don't |
|---|---|
| Review the plugin ID, scope and available version, then confirm or decline. | Expect opening a session to check or install updates. |
| Restart the OMP session after a verified update to load new extension code. | Treat an on-disk update as an automatic reload of the running extension. |
| Read failures as unverified state and check again deliberately. | Interpret network, metadata or native-command errors as “already latest.” |

Native OMP remains responsible for configured marketplace sources and installation. Its version caches can be shared across scopes; a targeted scope does not guarantee a physically separate cache. Its independent `marketplace.autoUpdate` preference is not changed by this feature.

## agent-skills and task tracking

agent-skills' planning and build workflows use the native session todo and task tools for mutable progress. The active session is the single progress owner; a task run is execution, not proof that code is verified.

Keep plans, acceptance criteria, designs and decisions as static artifacts, and pass workers their approved artifact paths. Native todo/task state is session-local: it does not provide a shared project board, cross-session claims or automatic dependency scheduling. For durable cross-session project coordination, choose and maintain an external tracker deliberately; do not mirror native task status into KB notes.

## Asking questions

The plugin ships an always-on rule (`rules/ask-user.md`): the agent puts every real decision to you (gates, grill rounds, design and approach choices, scope) instead of deciding itself, and every question goes through omp's `ask` dialog: one `ask` call per turn, where a grill, interview or approval round is one call holding all the round's independent questions, each with 2–5 multiple-choice answers and a recommended pick. Each dialog carries its own context: what is being decided, why it matters now, and what it hinges on, and every option lists how it works, pros, cons, effort, and reversibility (Proceed/Continue confirmations get one-line descriptions; interview-me rounds use your guess as the recommended pick), with a preview for anything longer. That includes approval gates and setup confirmations; the agent never asks in plain prose.

A second always-on rule (`rules/how-means-plan.md`): a request phrased as "how …" (or in Vietnamese "làm sao …", "như thế nào …", "cách nào …") is treated as planning and discussion. The agent investigates read-only, presents options, trade-offs and a recommendation, and asks before building anything.

A third always-on rule (`rules/lld-before-build.md`): every task from a written plan gets a low-level design artifact and your explicit approval before implementation. The main session keeps mutable progress in native todo; workers receive the approved artifact path. Design changes require fresh approval. Native task completion is not verification.

A fourth always-on rule (`rules/ticket-tracking.md`): native todo is the sole mutable progress checklist for the active session. Plans and decisions remain in static artifacts; native execution is not test proof. Issue trackers such as Jira are never commented on unless you ask, and any status transition is asked first.

A fifth always-on rule (`rules/say-it-in-chat.md`): chat views that collapse tool calls to their one-line intent (herdr web's Chat view, for one) hide subagent briefs and paths, so the agent says in chat what a subagent will do (task, files, limits like "no push") and puts paths, branches and results in its prose, not only in tool arguments.

A sixth always-on rule (`rules/agent-sessions.md`): when the agent coordinates other agent sessions (tmux or herdr panes, terminals running omp or Claude), it never answers their `ask` dialogs or sends keystrokes to them; only you answer dialogs. It doesn't wait on a session with no event that will end the wait: it stops and says in chat what is blocked. Progress is reported from verified output, never from a session showing `running`, and building goes to subagents rather than extra top-level sessions.

A seventh always-on rule (`rules/cross-repo-investigation.md`): an investigation that spans two or more repositories follows the `end-to-end-technical-flow-report` skill with one `scout` per repo. Each scout writes `local://<repo>-trace.md` with `path:start-end`, the symbol, a short excerpt and an evidence label; the main session reads those reports and opens only the cited range of a claim it doubts. Its turns carry the whole conversation, so a file read there costs many times a scout's read.

An eighth always-on rule (`rules/subagent-absolute-paths.md`) loads in every subagent and never in the main session: `read`, `edit`, `write`, `glob` and `lsp` resolve relative paths from the session's directory, not from where `bash` `cd`'ed, so subagents pass them absolute paths. Before it, subagents of a session started in a parent folder of the repo lost a turn on each relative `read`/`lsp` call that came back "not found".

Three tool-use rules (`rules/lsp-symbol-search.md`, `rules/dap-over-print.md`, `rules/delegate-cross-repo-reads.md`) are omp TTSR rules: the harness checks each tool call as it streams and adds a reminder after the result, so they work however long the session gets and survive compaction. When the agent greps for a code symbol (camelCase/PascalCase anywhere; snake_case when the command targets Rust or C/C++), it is pointed to `xd://lsp` `definition`/`references`/`symbols`/`rename`. When it adds `console.log`, `fmt.Print*`, `println!`/`dbg!`, `printf` or `std::cerr` to TS/JS, Go, Rust or C/C++ code, it is pointed to `xd://debug`. When the main session reads a source file, or runs `rg`/`grep`, by absolute path, wherever your repositories live, it is pointed to the cross-repo scout fan-out. `/tmp`, hidden folders (`~/.omp`, a `.obsidian` vault), `node_modules` and system folders don't count, and `fd`/`find` only list files and don't trigger it. Relative paths don't trigger it either; if it fires while the session works in its one repo, the reminder itself says to carry on. All three only remind and never block or interrupt; string, SQL-column and config-key searches don't trigger the LSP rule. The LSP and debugger rules load in the main session and `task-builder`; the cross-repo rule loads in the main session only.

With the Jev step on, `rules/lsp-symbol-judged.md` replaces the regex LSP rule (which goes into `ttsr.disabledRules`): it prefilters every non-piped `rg`/`grep` and asks Jev whether the command looks up a code symbol, so forms the regex misses (`export function X`, `^func Test`, `a|b|X`, `X(`) also get the reminder. It loads in the main session, `task-builder`, the default `task` agent (also vibe's `good` workers), `code-reviewer` and `test-engineer`; `task-builder` needs agent-skills 0.6.25 or later, the first version that gives it the `lsp` tool. Without a TypeSafe judge (`ttsr.judge: auto`) the judged rule never runs and costs nothing.

The same Jev step turns on `extensions/lsp-guard.ts`, which blocks instead of reminding, in coding subagents only (`task-builder`, `task`, `code-reviewer`, `test-engineer`). Before an `rg`/`grep` runs, code drops what is text by construction: a grep reading another command's output, and searches whose every path is `/tmp`, an artifact, `node_modules`, docs, SQL/migrations, data or logs. Jev then judges the rest with the judged rule's own question. At p ≥ 0.85 the call is blocked with the exact `lsp`/`xd://lsp` call to make instead. Appending `# text-search` to the command lets it run, for a language with no server or a real text search. No key, a timeout or a bad answer lets the command run. On 94 labelled greps from real subagent sessions it blocked 27 of 36 symbol lookups and 3 of 58 other searches (two of those three also grepped identifiers).

The `ask`-based rules load in the main session only, except `lld-before-build` and `ticket-tracking`, which also load in agent-skills' `task-builder`. Other subagents can't use the `ask` tool, so they don't carry these rules.

## Usage report

A read-only report on how agents actually use the knowledge base and the native todo, mined from omp's session transcripts. It calls no model and no network.

```bash
bun run usage                      # or: bun scripts/usage-report.ts
bun run usage --since 2026-10-15   # only sessions that started on or after that day
bun scripts/usage-report.ts --json /tmp/usage-report.json   # same numbers plus one row per session
# options: --sessions <dir> (default ~/.omp/agent/sessions), --vault <KnowledgeBase dir> (default: the folder `/kb` uses)
```

It prints one markdown table per metric, for main sessions and subagents separately (todo and memory duties belong to the main session), then a coverage line with files read, skipped files, malformed lines and schema versions.

| Metric | Question |
|---|---|
| M1 | Before the first edit of a repo file, did the agent recall (`kb_recall`, a `_memory/<note>.md` read, or the repo's `projects/<repo>.md` page)? Counts only repos whose memory scope has notes; the injected index does not count. |
| M2 | Before the first `git commit`, did the agent save a note? Commits marked `[skip-mem]` are their own bucket. |
| M3 | Is each saved note indexed under the session's repo section or Global in `MEMORY.md`? |
| M4 | Vault hygiene: dangling index lines, unindexed notes, near-duplicate notes (word overlap of name and description ≥ 0.8). |
| M5 | Todo: did the session end with open items, how many edit/write/bash calls ran after the last todo update, how many turns held only `todo` calls? |
| M6 | Counts of `kb_remember`, `kb_recall`, `_memory/` file writes and `todo` calls. |

| Do | Don't |
|---|---|
| Read it as a trend: compare runs with `--since`. | Treat a rate as a verdict: M1 can't tell whether a recall was needed. |
| Write `--json` outside the repo, for example under `/tmp`. | Commit the JSON; session rows name your sessions and repos. |
| Check the coverage line first: skipped files and unresolved repos shrink what a table covers. | Compare numbers across omp upgrades without it; the transcript format can change (only schema version 3 is read). |

Limits: M3 and M1's scope check use today's vault, so notes moved later are judged at their new place. A session's repo comes from the origin URL of its working folder, so a folder deleted since is counted as "repo unresolved". The output holds counts, session file names, repo names, tool names and note slugs; it never prints message text, tool arguments, command lines or file contents. Lines that are not needed for a metric are checked only for being a brace-delimited JSON object, not fully parsed. The report never writes to the sessions folder or the vault; its only write is the `--json` file.

## Spec plans

`plan.md` is the machine-readable plan of a spec-workflow story or task. Only fenced blocks count: exactly one `yaml plan` block (`id`, `kind: story | task`, `shared_paths`, `checks`) and one `yaml task` block per task (`id`, `repo`, `depends_on`, `foundation`, `owns`, `new_paths`, `reads`, `risk`, `lld_required`, `security_review`, `lld`, `lld_skip_reason`, `size`, `required_tests`, `acceptance`). `size` is optional: `small` or `normal` (the default). All other text is ignored. `risk` answers `yes` or `no` for `shared_state`, `external_io`, `retries`, `concurrent_writers`, `non_idempotent_effects`, `async_messaging`, `multi_step_saga` and `sensitive_data`; a `yes` needs a `reason`. `checks` maps each task repo (`org/name`) to the commands `spec-check` runs: `test` (required), `test_files`, `typecheck` and `lint`; an absent or empty `checks` reads as no commands (see [Guard and checks](#guard-and-checks)).

```bash
bun run validate-plan path/to/plan.md --repo path/to/checkout                          # one violation per line
bun run validate-plan path/to/plan.md --repo path/to/backend --repo path/to/frontend   # one clone per plan repo
bun run validate-plan path/to/plan.md --repo path/to/checkout --json                   # {"ok": …, "violations": […]}
```

`--repo` is repeatable. Each clone serves the tasks whose `repo` (`org/name`) equals the clone's `origin` URL (SSH or HTTPS); a single `--repo` for a single-repo plan needs no origin. The validator reads each repo's file list with `git ls-files` and runs every rule, so one run reports all violations, ordered by task and then by rule. It makes no network calls, calls no model and writes nothing.

| Exit code | Meaning |
|---|---|
| 0 | The plan is valid. |
| 1 | The plan is invalid; violations are on stdout. |
| 2 | Usage or IO error: unreadable plan file, a `--repo` that is not a git work tree or has no `org/name` origin (except a lone `--repo` for a single-repo plan), two clones of one repo, bad arguments. |

| Rule | Fails when |
|---|---|
| `parse`, `field` | Not exactly one `yaml plan` block, a `yaml plan` / `yaml task` fence that is never closed, a YAML syntax error, a missing or wrongly typed field, an unknown risk field, a task `repo` with no `--repo` clone, or an `owns` pattern that matches no file of the task's repo and no `new_paths` entry. |
| `duplicate-id`, `missing-dep`, `cycle` | Two tasks share an id, `depends_on` names an unknown task, or the dependencies loop. |
| `owns-overlap` | Two tasks of the same `repo` with no dependency path between them own the same file or create paths where one prefix contains the other. The same path in two different repos never overlaps. |
| `shared-path` | A task that is not `foundation` owns or creates something inside `shared_paths`; the globs are matched against the files of the task's own repo. |
| `risk-reason`, `acceptance-empty` | A `yes` risk has no reason, or `acceptance` is empty. |
| `lld-missing` | `lld_required` is true and there is neither `lld` nor a `lld_skip_reason`. |
| `router-mismatch`, `required-tests` | `lld_required` or `security_review` differs from what the risks require, or an implied test is not in `required_tests`. |
| `task-plan-size` | `kind: task` with anything other than one task block, or `kind: story` with no task block. |
| `size-risk` | A task has `size: small` and any risk is `yes`. |
| `checks-missing` | A task's repo has no `checks.test` command in the plan block (reported once per repo, under the first task that uses it). |

Risk routing: any `yes` except `sensitive_data` requires an LLD; `external_io` and `sensitive_data` require a security review; so does owning a dependency manifest (`package.json`, `bun.lock`, `go.mod`, `go.sum`, `requirements*.txt`, `pyproject.toml`, `Cargo.toml`). Each `yes` implies test ids: `shared_state` → `concurrent-writes`; `external_io` → `io-failure-injection`, `timeout`; `retries` and `non_idempotent_effects` → `duplicate-request`; `concurrent_writers` → `concurrent-writes`, `race-detector`; `async_messaging` → `duplicate-delivery`, `out-of-order`, `poison-to-dlq`, `crash-before-ack`; `multi_step_saga` → `compensation`.

### Status

Task and story status come from git alone: the plan, commit trailers and check notes. Nothing is stored except the notes.

- `Task: <task-id>` on every task commit (repeat the trailer for a commit that serves several tasks); `Task-Lock: <task-id>` on the task's lock commit; `Plan-Rev: <vault-sha>` on scheduler commits.
- A check note lives in `refs/notes/spec-checks` on a commit SHA and holds JSON: `{"v": 1, "task", "plan_rev", "checks": {"test": "pass", "guard": "pass", …}, "attempts", "blocked", "reason", "at"}`. Each check is `pass`, `fail` or `skip`; `blocked: true` carries the stop verdict in `reason`. Notes are local: the status command never pushes them. A note that is not valid JSON, has another `v` or misses a field is ignored with a warning.

```bash
bun run spec-status path/to/plan.md --repo path/to/backend --repo path/to/frontend --branch PAC2-1234
bun run spec-status path/to/plan.md --repo path/to/checkout --branch PAC2-1234 --base origin/main --json
bun run spec-status path/to/plan.md --repo path/to/checkout --branch PAC2-1234 --pr
```

`--repo` is repeatable; each clone serves the plan tasks whose `repo` equals the `org/name` of the clone's `origin` URL (SSH or HTTPS). `--base` defaults to the clone's `origin/HEAD`, else `main`. The command reads `<base>..<branch>` in each repo and refuses a plan that fails the validator. `--json` prints `{"id", "state", "tasks": [{"id", "state", "lastSha", "reason", "attempts"}]}`. Warnings (a repo without the branch, a `Task:` id outside the plan, an invalid note, `gh` trouble) go to stderr.

| Task state | When (first matching row wins) |
|---|---|
| `blocked` | The latest note on any of the task's commits has `blocked: true`. |
| `done` | The task's last commit has a note whose checks are all `pass` or `skip`, with `guard: pass`. A note on an older commit never counts. |
| `failing` | The task's last commit has a note with a `fail`. |
| `checking` | The task has a `Task-Lock` commit and its last commit has no passing note yet. |
| `awaiting-lock` | The task has commits but no `Task-Lock` commit. |
| `ready` | No commits, and every `depends_on` task is `done`. |
| `waiting` | No commits, and some dependency is not `done`. |

The story is `in-progress` until every task is `done`, then `tasks-done`. With `--pr` it becomes `done` once `gh pr list --head <branch> --state merged` lists a PR in every task repo; without `--pr` there is no network call, and a missing or unauthenticated `gh` leaves `tasks-done` with a warning. Exit codes: 0 when the status is computed (whatever the states), 2 on a usage or IO error or an invalid plan.

### Guard and checks

The local enforcement layer the scheduler relies on. Everything is deterministic and local: no model, no network, and nothing is pushed. The guard judges commits against the plan they pin, `spec-check` runs the repo's checks and records the check note that [Status](#status) reads, lock commits freeze a task's tests, a clone-local `pre-push` hook runs the guard on every push, and a worker guard keeps a worker session inside its slot.

**Check commands** live in the plan, per repo:

```yaml
checks:
  org/backend:
    test: "go test ./..."
    test_files: "go test {packages}"   # optional: run once per locked test file by the "fails before" check
    typecheck: "go vet ./..."
    lint: ""                            # empty = skipped
```

**Trailers.** Repeat a trailer for several values; a comma list is one value. Lock and unlock commits are empty (`--allow-empty`), so they never mix with a content change.

| Trailer | Written by | Meaning |
|---|---|---|
| `Task: <id>` | scheduler | The commit belongs to the task. |
| `Plan-Rev: <vault-sha>` | scheduler | The plan version the commit was made against: a hex sha of a commit in the vault git dir (a branch or tag name does not pin a plan). |
| `Task-Lock: <id>` and one `Locked: <path>` per test file | scheduler, after the test review | These files are locked for the task. |
| `Task-Unlock: <id>` and `Unlock-Gate: <gate-id>` | scheduler, after a human gate approved `test_wrong` | The task's locked files may change until the next `Task-Lock`. |

`lockCommit`, `unlockCommit` and `lockedFilesAt` (`extensions/lib/spec-lock.ts`) are the scheduler's helpers for these commits. They refuse staged changes (they would ride along in the empty commit), values that span lines (a crafted value could forge a trailer) and unsafe paths, and they skip the repo's commit hooks.

#### `spec-guard`

```bash
bun run spec-guard --repo path/to/backend --plan Specs/PAC2/stories/PAC2-1234/plan.md --strict
bun run spec-guard --repo path/to/backend --plan Specs/PAC2/stories/PAC2-1234/plan.md --range origin/main..PAC2-1234 --json
```

`--plan` is the plan's path inside the vault repo (the path of `git show <rev>:<path>`), not a file path. The plan is read from the vault git dir (`~/.vault-git`; `--vault-git-dir` overrides it) at each commit's `Plan-Rev`, never from the vault work tree, so a later edit of `plan.md` does not change how an older commit is judged. `--range <from>..<to>` defaults to `<base>..HEAD`; an empty `<from>` means the base and an empty `<to>` means `HEAD`. `--base` defaults to the clone's `origin/HEAD`, else `main`. `--plan`, `--base` and `--vault-git-dir` default to the clone's `.git/spec-workflow.json`, which `spec-hook install` writes. `--strict` also rejects commits without `Task:`; the scheduler and the hook always pass it. The command only reads: it writes nothing.

| Exit code | Meaning |
|---|---|
| 0 | No violations. |
| 1 | Violations; one line each (`rule sha task path: detail`), or `--json` `{"ok", "commits", "violations"}`. |
| 2 | Usage or IO error: missing `--repo` or plan, an absolute `--plan`, an unknown base or range, a missing vault git dir (set up the vault spec store first), a clone that cannot be matched to a plan repo. |

| Rule | Fails when |
|---|---|
| `plan-rev-missing` | A commit with `Task:` has no `Plan-Rev`. |
| `plan-rev-unreadable` | `Plan-Rev` is not a sha of a vault commit, or the plan path does not exist at that commit. |
| `plan-invalid` | The plan at that `Plan-Rev` does not parse or fails `validate plan`, checked against the repo's files at the start of the range. Only plan-wide findings and findings about tasks of this clone's repo count; other repos' tasks are judged by their own clones. |
| `unknown-task` | A `Task:` id is not in the plan at that `Plan-Rev`. |
| `out-of-scope` | A changed path is outside the `owns` and `new_paths` of the commit's tasks (a rename is checked on both sides; a commit serving several tasks may touch the union of their scopes). `owns` entries are globs; a `new_paths` entry is a file, a directory or a glob. |
| `locked-test-changed` | A commit, with or without `Task:`, changes a path locked by a `Task-Lock` that no later `Task-Unlock` of that task reopened. A new `Task-Lock` locks exactly the paths it lists. |
| `skip-added` | An added line matches `.skip(`, `.only(`, `.todo(`, `xit(`, `xdescribe(`, `xtest(`, `t.Skip(`, `@pytest.mark.skip`, `@pytest.mark.xfail` or `@Disabled`. |
| `ignore-added` | An added line matches `@ts-ignore`, `@ts-expect-error`, `eslint-disable`, `biome-ignore`, `//nolint`, `# type: ignore`, `# noqa`, `istanbul ignore` or `c8 ignore`. |
| `config-changed` | A changed path is a protected config, at any depth (`tsconfig*.json`, `eslint.config.*`, `.eslintrc*`, `biome.json*`, `.golangci*`, `bunfig.toml`, `jest.config.*`, `vitest.config.*`, `pytest.ini`, `pyproject.toml`, `setup.cfg`) or under `.github/workflows/`, and the commit's tasks do not list that exact path in `owns` (or `new_paths`, for a new file). A broad glob is not enough. |
| `untracked-commit` | With `--strict`, a non-merge commit has no `Task:`. |

The lock, skip, ignore and config rules apply to every commit in the range; the plan rules apply to commits with `Task:`. A merge commit is read against its first parent. A binary file is subject to the path rules only. "Loosened" is not judged semantically: any change to a protected config has to be planned by its exact path.

#### `spec-check`

```bash
bun run spec-check <sha> --repo path/to/backend --plan Specs/PAC2/stories/PAC2-1234/plan.md --base origin/main
bun run spec-check <sha> --repo path/to/backend --timeout 120 --json
```

Reads the commit's `Task:` and `Plan-Rev:`, takes the `checks` of the task's repo from the plan at that `Plan-Rev`, and runs `test`, `typecheck` and `lint` with `sh -c` in a temporary `git worktree` at the commit (repo hooks off; the worktree is removed afterwards, also after a failure or timeout). Each command gets `--timeout` seconds (default 900) in its own process group; a command that runs out of time is killed with everything it started and recorded as `fail` with reason `timeout`. An empty or missing command is a skip. Then it runs the guard over the task's commits in `<base>..<sha>` and writes the check note on the commit: the three checks plus `guard`, `blocked: false`, and `attempts` = the nearest earlier note of the task + 1 (a rerun on the same commit does not count twice).

The worktree is a fresh checkout: installed dependencies and build output from your clone are not there, so a check command that needs them has to install or build them itself (for example `bun install --frozen-lockfile && bun test`). Check commands run with your environment minus the variables that name a repository (`GIT_DIR` and friends).

| Exit code | Meaning |
|---|---|
| 0 | Every check passed or was skipped and the guard found nothing. The task reads as `done` once this note is on its last commit. |
| 1 | A check or the guard failed. The note is written all the same (`failing`, with `attempts` counting up). |
| 2 | The checks could not run, and no note is written: usage error, unknown commit or base, no or several `Task:` trailers, no `Plan-Rev:`, an unreadable or unparseable plan, a task the plan lacks, no `checks.test` for its repo, a missing vault git dir, or no worktree. |

**Fails before** (`failsBefore` in `extensions/lib/spec-check.ts`, for the scheduler): new tests must fail where the work has not been done. It creates a worktree at the task's base (the parent of the task's first commit), copies only the locked test files from the test commit, and runs `test_files` once per file with `{files}` (that file) and `{packages}` (its directory, `./dir`) filled in, already shell-quoted. A file whose run exits zero is `already-passes` and the lock must be refused. The granularity is the file, not the test case; files that render to the same command run once, a command without a placeholder runs once for all files, and a timeout counts as failing.

#### `spec-hook`

```bash
bun run spec-hook install --repo path/to/backend --plan Specs/PAC2/stories/PAC2-1234/plan.md
bun run spec-hook install --repo path/to/backend --plan <plan> --chain      # keep an existing pre-push hook
bun run spec-hook uninstall --repo path/to/backend
```

`install` writes `.git/hooks/pre-push`, a short `sh` script that carries a marker comment and runs `spec-guard --strict` over `<remote sha>..<local sha>` for every ref the push updates (`<base>..<local sha>` for a new ref; a deleted ref is skipped), and saves `.git/spec-workflow.json` (`{"plan", "base", "vaultGitDir"}`; `--base` defaults to `origin/HEAD`, else `main`). Nothing is committed and the repo config is untouched. It refuses (exit 2) to replace a `pre-push` without the marker, unless `--chain`, which renames it to `pre-push.local` and runs it first with git's own arguments and input; and to install while `core.hooksPath` is set, because git would never call `.git/hooks`. `uninstall` removes only the marked hook and its config and puts a chained hook back. The hook guards every ref pushed from the clone, including unrelated branches and tags, and `git push --no-verify` skips it; that is the documented human limit.

#### Worker guard

`workerGuard({ cwd, writeScope, lockedFiles })` in `extensions/lib/worker-guard.ts` returns an extension factory for the scheduler to load into worker sessions (it is not in `omp.extensions`). Its `tool_call` handler blocks `write` and `edit` calls that name a path outside `writeScope` (or outside the worktree), or a locked file, in `path`, `paths` or the edit payload itself (hashline headers, `MV`, patch headers), and blocks `bash` commands that run `git commit`, `push`, `reset`, `checkout`, `switch`, `rebase`, `merge`, `cherry-pick`, `tag`, `update-ref`, `stash`, `worktree`, `notes` or `config`, also inside `sh -c`, `bash -c`, `env`, `xargs` and `$(...)`. This is best effort: variables, aliases, scripts and encoded commands are not seen, and `git branch`, `revert`, `am` and `pull` are not on the list. So the scheduler also checks after every slot, and rejects it when either list is non-empty:

- `snapshotGit(repo)` and `compareSnapshot(before, after)`: `HEAD`, the branch `HEAD` names, every ref under `refs/` and `git config --local --list`, compared line by line (credentials in URLs are hidden). A commit made behind the guard's back, for example with `GIT_DIR` set from another folder, moves a ref and shows up here.
- `scopeCheck(worktree, writeScope, lockedFiles)`: every changed path from `git status` (tracked changes and every untracked file; ignored files are not listed by git) that lies outside the scope or touches a locked file, such as a file written by a bash redirect.

| Do | Don't |
|---|---|
| Pass `--plan` as the path inside the vault repo, and `--strict` for anything that decides a push. | Pass the plan's file path, or read the plan from the vault work tree: the guard only trusts the commit named by `Plan-Rev`. |
| Commit as the scheduler does: `Task:` and `Plan-Rev:` on every task commit, an empty lock commit after the test review. | Edit a locked test to make a check pass; ask for a `Task-Unlock` through a gate. |
| Name a protected config by its exact path in `owns` when the task has to change it. | Rely on a broad `owns` glob for `tsconfig.json`, workflow files or lint configs. |
| Run `spec-hook install` per ticket clone; `uninstall` when the ticket is done. | Use the hook as the only protection: `--no-verify` skips it, and the scheduler runs the guard itself. |

Verify: `bun test extensions/lib/spec-guard.test.ts extensions/lib/spec-diff.test.ts extensions/lib/spec-lock.test.ts extensions/lib/spec-check.test.ts extensions/lib/worker-guard.test.ts extensions/lib/spec-cli.test.ts extensions/lib/spec-hook.test.ts`, then `bun run typecheck`. The tests use temp git repos, a temp vault git repo and a local bare remote under a private HOME; they never touch a real repo or the real vault.

## Release notes

### 0.30.0 — 2026-11-02

- **Changed:** JavaScript/TypeScript tooling runs on Bun. typescript-language-server installs with `bun install --frozen-lockfile --ignore-scripts` from a committed `bun.lock` and starts as `bun --bun`, and js-debug runs on Bun. Node only runs the Node programs js-debug debugs, and npm is no longer needed. JS/TS setup now requires `bun` ≥ 1.4.4 on `PATH`; without it the step reports `needs-sdk`. Existing installs: rerun `/starter tools`.
- **Added:** `bun-debug-adapter` for Bun projects, vendored from oven-sh/bun at `38afee6c` with a per-file SHA-256 list (`vendor/bun-dap/PROVENANCE.md`). It starts paused. Verified through omp's real `debug` tool: a breakpoint stop with `answer = 42`. omp defaults JS/TS to js-debug, so Bun projects name the adapter.
- **Added:** `bun run usage`, a read-only report on how agents use memory and todo, mined from session transcripts (see [Usage report](#usage-report)).
- **Added:** tests for the commit gate, `kb_remember`/`kb_recall`, the memory index, `lsp-guard`, `/kb` and `/starter`. Every `bun test` runs under a private temporary HOME (`bunfig.toml` preload).
- **Fixed:** `setup-skills.test.ts` loaded the real `~/.omp/agent/omp-starter.json` path; it never wrote to it.
- **Added:** a Bun-only CI workflow (`test.yml`: tests, `bun run typecheck`, build). `tooling.yml` drops its duplicate unit-test step, checks omp's integrity with `bun pm view`, pins Bun 1.4.4 and proves 8 fixture variants. `scripts/tooling-smoke.ts --groups=` runs a partial check on machines missing some SDKs.
- **Changed:** `@types/bun` replaces `@types/node`.

### 0.29.0 — 2026-11-02

- **Added:** GPT-6 Astra as Codex's `deep` model and escalation equivalent of Claude Fable: risky reviews, repeated-failure notices, a separate five-spawn daily cap (`ASTRA_ROUTER_DAILY_CAP`), and Sol fallback. Routine Sol/Luna roles and the optional Jev judge are unchanged.
- **Changed:** setup saves fallback chains for both subscriptions, including when switching presets later. The read-only `deep` agent documents both subscription routes.
- **Added:** `@types/node` as a development dependency.

### 0.28.0 — 2026-10-30

- **Removed:** task-vault synchronization into agent-skills and the primary-KB designation. Knowledge-base folder routing, memory and the commit gate remain independent.
- **Changed:** task progress uses native todo/task with static requirement/design briefs; every task from a written plan still requires explicit LLD approval.
- **Added:** `/starter updates` checks both plugins on demand and updates only after explicit per-plugin/scope confirmation, with native version verification and no automatic reload.

### 0.26.1 — 2026-10-29

- **Fixed:** the `lsp-symbol-judged` reminder no longer fires on an `rg`/`grep` that carries `# text-search`, the marker `lsp-guard` tells agents to use for real text searches.

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

- **Changed:** planning results are shown in the current chat, with explicit user approval requested through `ask` without requiring plan mode.
- **Changed:** `rules/how-means-plan.md` also recognises Vietnamese "how" phrasing ("làm sao", "như thế nào", "cách nào").
- **Changed:** `rules/ask-user.md` keeps waits short: facts are looked up before a phase's first question, every independent question goes into one dialog, and nothing but the lookups the answers require runs between rounds.
- **Added:** `rules/agent-sessions.md`: never answer another session's dialog or type into it, report a stall in chat instead of waiting, and report progress only from verified output.

### 0.15.0 — 2026-10-26

- **Added:** read-only `/kb` commands to inspect knowledge-base status, search notes, list scopes, view memory and check index consistency.


### 0.14.0 — 2026-10-27

- **Added:** `kb_remember` and `kb_recall` tools to save and search memory notes without hand-editing `MEMORY.md`.
- **Added:** one knowledge base per folder. `/starter kb` adds, replaces or removes knowledge bases; the memory index, tools and commit gate follow the session's folder. Existing single-knowledge-base installs keep working unchanged.
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
