# omp-starter

A first-run setup plugin for [omp (Oh My Pi)](https://omp.sh) on macOS. The first time you open omp after installing it, it asks a few questions and sets up the steps below. On a fresh omp install it waits until omp's own setup screens are done (or until your first prompt), so its questions get keyboard focus:

| Step | What it does |
|---|---|
| **agent-skills** *(optional)* | Installs [tung-dnt/agent-skills](https://github.com/tung-dnt/agent-skills): engineering-workflow skills, agents and `/spec` `/plan` `/build` `/review` `/ship` commands. Once installed, `/starter skills` offers to update it. |
| **Model routing** *(Claude-first)* | Saves `claude` and `codex` subscription presets without requiring a login. When the required Claude models are available, also routes work to Opus, Sonnet, Haiku and Fable by job, with matching effort levels; otherwise keeps the current routing. Using a preset requires its provider login. |
| **TypeSafe Jev judge** *(optional)* | Routes omp's `judge` role to TypeSafe Jev after checking your API key, and stores the key in `~/.omp/agent/.env` (mode 600). Jev then answers `question` rules and picks the thinking level per prompt. Offered on a brand-new install; existing installs run `/starter jev`. See [TypeSafe Jev judge](#typesafe-jev-judge-starter-jev). |
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

Applied with `omp config set` after you confirm, on any subscription. Setup always saves the four model presets and the settings that name no concrete model: effort, cycle order, per-agent overrides (role aliases such as `@tiny`), LSP diagnostics after every edit (`lsp.diagnosticsOnEdit`), and repeating rule reminders (`ttsr.repeatMode: after-gap`, `ttsr.repeatGap: 10`). It then applies active routing for the first subscription whose models are all available: Claude (table below), otherwise Codex (the `codex` preset's roles). With neither, active routing stays unchanged. Role assignments, named presets and per-agent overrides are merged into your existing settings; same-named entries are replaced.

| Work | Model | Effort |
|---|---|---|
| Main session | Opus 5.5 | `auto` (Haiku classifies each prompt; `ultrathink` forces `max`) |
| Plan mode, `reviewer` | Opus 5.5 | `high` |
| Coding subagents (`task`, agent-skills builders/testers) | Sonnet 5.5 | `high`; the parent can raise a slice to `max` |
| Commits, `code-reviewer` | Sonnet 5.5 | default |
| Exploration (`scout`), mechanical edits (`sonic`), titles, classifiers | Haiku 5.5 | default |
| Security agents | Opus 5.5 | `high` (never Fable) |
| `deep` agent | Opus 5.5 for a run's first consult, then Fable 5.2 | `high` |

The idea: spend effort on the plan, since it runs once and feeds every coding slice. Keep coders at a `high` floor and use `max` only for concurrency, migrations and shared contracts. Fallbacks stay within the subscription: Fable 5.2 → Fable 5.1 → Opus → Sonnet on Claude, Astra → Sol on Codex. The one exception is Antigravity: a failed or exhausted Gemini request falls back to Haiku 5.5. A subscription limit stops the session instead of switching to paid API usage.

Ctrl+P cycles `smol` → `default` → `slow`. `deep` is left out on purpose: switching the main model mid-session drops the previous model's thinking state and the prompt cache, so a long session would pay for its whole context again. Reach Fable through the `deep` agent, or start a fresh `claude-fable-lead` session.

### Subscription presets

The model step saves four complete role setups, even when no provider is logged in:

| Preset | Main session | Planning / deep consultation | Helpers |
|---|---|---|---|
| `claude` | Opus 5.5 (`auto`) | Opus 5.5 / Fable 5.2 (`high`) | Sonnet 5.5; Haiku 5.5 for exploration, tiny work and judgments |
| `claude-gemini` | Opus 5.5 (`auto`) | Opus 5.5 / Fable 5.2 (`high`) | Sonnet 5.5; Gemini 3.8 Flash (Antigravity) for exploration and tiny work; Haiku 5.5 judges |
| `claude-fable-lead` | Fable 5.2 (`high`) | Fable 5.2 (`high`) | Same as `claude` |
| `codex` | GPT-6.1 Sol (`auto`) | GPT-6.1 Sol / GPT-6 Astra (`high`) | GPT-6 Luna; `high` for tasks, `low` for tiny work and judgments |

Existing installs: update the plugin and run `/starter models` to save the presets. Restart open sessions to load the routing changes, then switch inside omp:

```text
/modelpreset switch codex
/modelpreset switch claude
/modelpreset switch claude-gemini
/modelpreset switch claude-fable-lead
```

`/modelpreset` opens the picker. Switching replaces the model-role setup, not just the main conversation model; the security agents follow `@slow` rather than staying pinned to Claude. Other agent overrides and explicitly requested models are not part of a preset.

`claude-fable-lead` saves `defaultThinkingLevel: high`; the other presets save `auto`. The advisor uses Luna or Sonnet at `medium`. Presets do not change authentication, enable the advisor, or bypass subscription quotas. Use `/login openai-codex` for the Codex subscription, `/login anthropic` for Claude and `/login google-antigravity` for Gemini. No API key is installed by this step. The escalation router selects Fable only in Anthropic sessions and Astra only in OpenAI Codex sessions; other providers are untouched. Setup saves every subscription's fallback chains, so switching presets does not require rerunning setup.

`claude-gemini` moves only the `tiny` role (`scout`, `sonic`, `state-investigator`) onto the Antigravity quota. Coding, review, commits and judgments stay on Claude. On Terminal-Bench 4.0 (Vals, 2026-11-09), Gemini 3.8 Flash scores 19.7% against Haiku 5.5's 36.4% and Sonnet 5.5's 64.1%, and it is slower (about 81 vs 164 tok/s). The Antigravity subscription offers only Flash-tier Gemini models.

**Do:** switch to `claude-gemini` when Claude quota is tight and the work is exploration-heavy.

**Don't:** use it on repositories whose data rules forbid sending code to Google (for example NHS/patient-data code without IG approval). Scouts read whatever the parent points them at.

`claude-fable-lead` puts Fable 5.2 at `high` effort in the main session for one large job: a big rewrite, a 3D or game build, or a problem Opus at `high` already failed. Fable plans and reviews; Sonnet and Haiku subagents still do the coding and exploration. Plan mode stays on Fable, so entering it doesn't switch models. The `fable-router` daily cap counts only `deep` and review spawns, not the main session, so the router warns once per session when Fable is leading.

**Do:** start a new session, run `/modelpreset switch claude-fable-lead`, state what done looks like and how to check it, then switch back to `claude` when the job ends.

**Don't:** switch to it in the middle of a long session (run `/compact` or start fresh first), or leave it active for routine work: every turn spends Fable quota.

### Fable / Astra escalation

Neither escalation model is the default outside the `claude-fable-lead` preset. The `fable-router` extension uses Fable for an active Anthropic model and Astra for an active OpenAI Codex model:

- **Stuck:** the same command fails twice in one run (searches like `grep` that just find nothing don't count, also after a leading `cd <dir> &&`). The agent is told it may delegate to the read-only `deep` agent. The notice is advisory: expected failures, such as a red test, and "don't spawn agents" instructions take precedence.
- **Risky review:** a `reviewer` or `code-reviewer` starts while the git diff touches migrations, `*.sql`, auth/RBAC, infra or CI workflows. The diff checked is that of the session folder's repo plus every repo the session or its subagents edited with `write`/`edit`, so a session started in a parent folder such as `~/projects` still escalates.
- **Ladder:** a run's first `deep` consult goes to Opus (Sol on Codex) at `high` effort and does not count toward the cap; the next `deep` consult in the same run goes to Fable (Astra). A new user prompt starts a new run. A session already led by Fable skips the Opus step. The stuck notice still fires when the cap is used up, as long as the free Opus step is left.

Every routed escalation spawn counts toward its subscription's daily cap. Claude uses `FABLE_ROUTER_DAILY_CAP` (default 5), tracked in `~/.omp/agent/fable-router.json`, then falls back to Opus. Codex uses `ASTRA_ROUTER_DAILY_CAP` (default 5), tracked separately in `~/.omp/agent/astra-router.json`, then falls back to Sol. A lock file beside each counter keeps concurrent sessions from passing the cap. The task panel shows the escalation reason or cap fallback. The `deep` agent stays read-only, and security agents stay on `@slow`.

**Do:** delegate an unexpectedly stuck investigation to `deep`, with evidence and the commands already tried. Keep routine work on Sol/Luna or Opus/Sonnet.

**Don't:** make Astra/Fable the default, repeatedly escalate expected red tests, or treat the local daily counter as the provider's subscription quota.

**Verify:** run `bun test extensions/fable-router.test.ts extensions/lib/routing.test.ts`. After `/starter models`, the Claude `deep` role is `anthropic/claude-fable-5-2:high`, `cycleOrder` has no `deep`, and the Codex preset's `deep` role is `openai-codex/gpt-6-astra:high`. Restart open sessions after updating the plugin.

### TypeSafe Jev judge (`/starter jev`)

Optional. It sends judged tool calls and your prompts to TypeSafe (processed in the US), so skip it if your data rules don't allow that. With a Jev judge, omp's `find` tool (`find.enabled: auto`) also turns on and sends source excerpts to TypeSafe; the step asks whether to turn `find` off.

1. If `TYPESAFE_API_KEY` is already in the environment it is used and never written to disk. Otherwise the step asks for the key (the input is not masked) and saves it to `~/.omp/agent/.env` with mode 600, replacing an earlier `TYPESAFE_API_KEY` line and keeping the rest. omp loads that file into its process, so bash and eval children (for example agent-skills' `jev.sh`) see the key too.
2. The key is checked with one tiny Jev request. A rejected or unreachable key stops the step with nothing changed.
3. `modelRoles.judge` and the `judge` of the saved `claude`/`codex` presets become `typesafe/jev-1.14.0`, with `@tiny` as fallback; `ttsr.judge` stays `auto`. `/starter models` keeps Jev as the judge while this step is on.
4. The step asks whether to set `find.enabled: off`. Choose it for repositories whose data rules don't cover sending source to TypeSafe; any other answer leaves `find` as it is.

Rerunning `/starter jev` offers to turn Jev off: the presets' own judges come back, and the key stays in `~/.omp/agent/.env`.

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

**Which JavaScript debugger.** One `dap.json` serves every project, so both JavaScript debuggers are installed. omp picks `js-debug-adapter` for JavaScript and TypeScript whenever no adapter is named, even in a project whose only lockfile is `bun.lock` (checked with omp 18.12.5). So in Bun projects (`bun.lock`, `bun.lockb` or `bunfig.toml`) pass `adapter: "bun-debug-adapter"` to the `debug` tool. The Bun debugger starts paused (`stopOnEntry` on by default) because Bun 1.4.4 ignores its own pause-at-start setting: set breakpoints, then continue.

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

The plugin ships an always-on rule (`rules/ask-user.md`): the lead's decisions go to you instead of being decided for you. You own framing, high-level design (architecture, data model, API contracts, cross-system boundaries), invariants, risk and acceptance, so gaps in those, and in scope, are asked. The agent owns low-level design, code structure, test design and mechanics, and records each non-trivial choice with the rejected alternative in the PR's decision log. Facts that tools, code or docs can answer are settled by the agent. Every question goes through omp's `ask` tool as one HTML form per turn, never only in prose; a round's independent questions share the form. Each question is a fieldset whose legend names the decision and the concrete thing it concerns, followed by context (what is decided, why now, what it hinges on). Each option gives its main pro and con and whether it is easy to reverse, and the recommended option is preselected. Paths you may want to open also go in chat, since many clients make nothing inside the form clickable.

A second always-on rule (`rules/how-means-plan.md`): a request that is itself a how-question ("how do I …", or in Vietnamese "làm sao …", "như thế nào …", "cách nào …") is treated as planning and discussion. The agent investigates read-only, presents options, trade-offs and a recommendation, and asks before building anything. An instruction that merely mentions "how" ("fix X and show me how") is carried out.

There is no per-task design approval: the agent owns low-level design and records its choices in the PR's decision log.

A fourth always-on rule (`rules/ticket-tracking.md`): native todo is the sole mutable progress checklist for the active session. Plans and decisions remain in static artifacts; native execution is not test proof. Issue trackers such as Jira are never commented on unless you ask, and any status transition is asked first.

A fifth always-on rule (`rules/say-it-in-chat.md`): chat views that collapse tool calls to their one-line intent (herdr web's Chat view, for one) hide subagent briefs and paths, so the agent says in chat what a subagent will do (task, files, limits like "no push") and puts paths, branches and results in its prose, not only in tool arguments.

A sixth always-on rule (`rules/agent-sessions.md`): when the agent coordinates other agent sessions (tmux or herdr panes, terminals running omp or Claude), it never answers their `ask` dialogs or sends keystrokes to them; only you answer dialogs. It doesn't wait on a session with no event that will end the wait: it stops and says in chat what is blocked. Progress is reported from verified output, never from a session showing `running`, and building goes to subagents rather than extra top-level sessions.

A seventh always-on rule (`rules/cross-repo-investigation.md`): an investigation that spans two or more repositories settles its scope, then fans out one `scout` per repo. Each scout writes `local://<repo>-trace.md` with `path:start-end`, the symbol, a short excerpt and an evidence label; the main session reads those reports and opens only the cited range of a claim it doubts. Its turns carry the whole conversation, so a file read there costs many times a scout's read.

An eighth always-on rule (`rules/subagent-absolute-paths.md`) loads in every subagent and never in the main session: `read`, `edit`, `write`, `glob` and `lsp` resolve relative paths from the session's directory, not from where `bash` `cd`'ed, so subagents pass them absolute paths. Before it, subagents of a session started in a parent folder of the repo lost a turn on each relative `read`/`lsp` call that came back "not found".

`extensions/cross-repo-reads.ts` reminds the main session of the cross-repo scout fan-out once it has read source from a second repository: a `read` of a source file, `rg`/`grep` over a repo folder, or `cat`/`head`/`sed`… of a source file, with relative paths resolved from the session's folder or the command's `cd`. It reminds again only when a further repo appears. A session working in one repo never sees it. Docs, `node_modules`, hidden folders (`~/.omp`, a vault), files outside any git repo (such as `/tmp` scratch files) and system folders don't count, nor do subagents' reads.

`extensions/blast-radius.ts` appends a short **Blast radius** block to an `edit` or `write` result when the change alters an exported symbol in a TS/JS or Go file. A symbol counts as changed when its signature does: the parameters and return type of a function or method (including an exported arrow-function `const`), or the whole declaration of an `interface`/`type`/`enum`/Go `type`. The block lists that symbol's references in other files, from the language server the `lsp` tool already runs, so no second server starts. A removed or renamed export can no longer be asked about, so its uses come from `git grep -w` over tracked files and are labelled `text matches`. Body-only edits, reformatting and new exports add nothing. Limits: 3 changed and 3 removed symbols per call, 8 locations per symbol, 700 characters, 6 s. A slow or missing server, or any error, adds nothing and never changes the edit's own result. The block holds paths and line numbers only, never code. It runs in every agent. Turn it off with omp's extension toggle.

The `ask`-based rules load in the main session only, except `ticket-tracking`, which also loads in agent-skills' `task-builder`. Other subagents can't use the `ask` tool, so they don't carry these rules.

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

## Release notes

### 0.37.0 — 2026-11-21

- **Added:** the lead loop: after `/build` the harness drives verify → test → proof → independent review → push → acceptance → PR from check receipts keyed by HEAD, stops after three failed runs of a stage or three non-clean reviews with a `deep` diagnosis and a notification, and blocks the main session's `ask` while it runs.
- **Added:** briefs carry `- AC1: …` criteria and plans a `## Proof` list; one approval dialog shows each AC with how it is proven or why it is unprovable. A proof test must fail on the base commit and pass on HEAD.
- **Added:** `checks:` per repository in `hard-gates.md`, a `check` op on the `lead` tool, `## Evidence` and `## Unproven` in the PR body, and PR checks for receipts and a clean review at HEAD.
- **Added:** `/story <jira-key>` without a brief: the agent drafts `brief.md` from the ticket and you approve it with the plan.
- **Changed:** the `code-reviewer` runs on the `slow` role. Existing installs: add `checks:` for each repository to `hard-gates.md`, and `- AC<n>:` lines to open briefs. Use agent-skills 0.9.0, which drops its `verification` tool.

### 0.36.0 — 2026-11-18

- **Changed:** the system map moved from one `system-map.md` into each repository's project note, `<kb>/projects/<repo>.md`. `/starter lead` no longer creates `system-map.md`, and `/story` no longer needs one. Existing installs: move each service into its repository's note, drop the `repo:` field, and delete `system-map.md`. Use agent-skills 0.8.2.
- **Added:** a plan is approved, and built, only when every repository in it has a project note with a `services:` block.
- **Added:** the approval dialog and the story prompt show how fresh the notes are: the `updated:` date and the count of `(inferred — verify)` markers, for the plan's project notes and for your own notes in the policy folder.
- **Changed:** you are notified when an agent changes a note's `services:` block, not on every edit of the file; an agent that leaves an old `updated:` date is told to set it.

### 0.35.0 — 2026-11-18

- **Added:** a knowledge base can keep the lead files in folders it already has: `lead: { stories, policy, templates }` on its entry in `omp-starter.json`. Without the setting nothing moves.
- **Changed:** the workflow is on once `hard-gates.md` exists, the file the hard gates and the PR check already looked for. A `lead/` folder without it no longer has `/story` and `/build` checked.

### 0.34.0 — 2026-11-18

- **Added:** the lead-driven workflow. `/starter lead` creates `lead/` in the knowledge base; nothing is enforced before that, and `OMP_STARTER_LEAD=off` turns it off. It needs agent-skills 0.8.0 for the matching `/story`, `/build`, `/task` and `/ship` commands.
  - `/story <id>` and `/build [id]` are checked before they run: brief and system map first, approved plan before building.
  - The `lead` tool: one plan approval (`approve`), queued hard gates (`gate`), PR status (`status`), escaped bugs (`retro`). Every decision is a dialog only you can answer.
  - Hard gates on writes, commits, pushes and PRs; a repository fence; a PR body check; a builder cap; notifications (`OMP_STARTER_NOTIFY_CMD` or macOS).
  - After the approval you are out of the loop: stories default to `mode: async` (gates queue instead of asking), and agents keep `plan.md` and `system-map.md` current.
  - `scripts/arch-graph.ts` with `templates/arch-graph.yml` (structural graph in `docs/arch/`, checked at commit and in CI) and `scripts/lead-replay.ts` (the same tasks with the harness on and off).
- **Removed:** `rules/lld-before-build.md`: there is no design approval per task.
- **Changed:** `rules/ask-user.md` asks you only about your decisions (framing, high-level design, invariants, risk, acceptance); low-level design is the agent's.

### 0.33.0 — 2026-11-17

- **Added:** `blast-radius` extension. After an `edit`/`write` changes an exported TS/JS or Go signature, the result lists the symbol's references in other files (language server; `git grep` for removed exports). Agents learn what an edit breaks without having to remember to ask `lsp` for references.

### 0.32.1 — 2026-11-17

- **Fixed:** `cross-repo-reads` no longer ignores every path under `/tmp`. On Linux that hid git repos cloned there (and failed CI, whose test homes live in `/tmp`), while macOS resolves `/tmp` to `/private/tmp` and counted them. Files outside any git repo still don't count.

### 0.32.0 — 2026-11-17

- **Changed:** `/starter jev` says that omp's `find` tool turns on with a Jev judge and sends source excerpts to TypeSafe, and asks whether to set `find.enabled: off`.
- **Changed:** `rules/ask-user.md` matches omp 18.22's HTML-form `ask` tool and asks only on real choices; facts and one-answer mechanics are settled and reported. The rule no longer refers to a Jev delegation rule this plugin doesn't ship.
- **Changed:** `rules/how-means-plan.md` applies to how-questions only, not to instructions that mention "how".
- **Changed:** `rules/cross-repo-investigation.md` no longer points at a skill that isn't installed.
- **Changed:** the cross-repo reminder is now `extensions/cross-repo-reads.ts`. It fires when the main session reads source from a second repository, rather than on any read by absolute path. `rules/delegate-cross-repo-reads.md` is removed.
- **Changed:** with Jev on, `lsp-symbol-judged` loads in the main session only. Coding subagents keep `lsp-guard`, so each grep is judged once instead of twice.
- **Fixed:** `fable-router` counts `cd <dir> && rg …` with no match as a probe, not a stuck command. Risky-review escalation also checks repos edited in the session, so it works from a parent folder that isn't a repo. The daily escalation counter is updated under a lock.
- **Changed:** development pins `@oh-my-pi/pi-coding-agent` 18.22.0.
- **Changed:** the `deep` role and escalations use Fable 5.2 (`anthropic/claude-fable-5-2`). Fallbacks: Fable 5.2 → Fable 5.1 → Opus.
- **Added:** a `claude-fable-lead` preset: Fable 5.2 at `high` effort leads a fresh session for one large job, with plan mode on Fable and Sonnet/Haiku subagents unchanged. `fable-router` warns once per session when Fable leads, because the daily cap does not count main-session use.
- **Changed:** escalation ladder. A run's first `deep` consult runs on Opus (Sol on Codex) at `high` effort and is not counted; later consults in the run go to Fable (Astra) under the daily cap. Stuck notices ask for what done looks like and how to verify it, and `agents/deep.md` restates that finish line first.
- **Changed:** `cycleOrder` no longer includes `deep`: switching the main model mid-session drops thinking state and the prompt cache.
- **Changed:** `rules/agent-sessions.md` and `rules/ticket-tracking.md` give the reason behind their remaining absolute instructions.
- Existing installs: update, then rerun `/starter models`.

### 0.31.0 — 2026-11-11

- **Added:** a `claude-gemini` preset: the `claude` setup with the `tiny` role (`scout`, `sonic`, `state-investigator`) on Gemini 3.8 Flash through the Antigravity subscription. Coding, review, commits and judgments stay on Claude. Setup also saves an Antigravity fallback chain (`google-antigravity/*` → Haiku 5.5). Existing installs: update, then rerun `/starter models`. Don't use it where your data rules forbid sending code to Google.

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
