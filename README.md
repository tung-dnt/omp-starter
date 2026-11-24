# omp-starter

A first-run setup plugin for [omp (Oh My Pi)](https://omp.sh) on macOS. The first time you open omp after installing it, it asks a few questions and sets up the steps below. On a fresh omp install it waits until omp's own setup screens are done (or until your first prompt), so its questions get keyboard focus:

| Step | What it does |
|---|---|
| **Skill kits** *(optional)* | A checkbox picker for any combination of [pstack](https://github.com/cursor/plugins/tree/main/pstack), [Matt Pocock's skills](https://github.com/mattpocock/skills), [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills), [ponytail](https://github.com/DietrichGebert/ponytail) and [spec-kit](https://github.com/github/spec-kit), with a warning when the chosen kits cover the same job. See [Skill kits](#skill-kits-starter-skills). |
| **Model routing** *(Claude-first)* | Saves `claude` and `codex` subscription presets without requiring a login. When the required Claude models are available, also routes work to Opus, Sonnet, Haiku and Fable by job, with matching effort levels; otherwise keeps the current routing. Using a preset requires its provider login. |
| **TypeSafe Jev judge** *(optional)* | Routes omp's `judge` role to TypeSafe Jev after checking your API key, and stores the key in `~/.omp/agent/.env` (mode 600). Jev then answers `question` rules and picks the thinking level per prompt. Offered on a brand-new install; existing installs run `/starter jev`. See [TypeSafe Jev judge](#typesafe-jev-judge-starter-jev). |
| **Memory** | Picks omp's memory backend (`off`, `local`, `hindsight`, `mnemopi`, `sharpshooter`), writes the matching memory rules into `~/.omp/agent/AGENTS.md`, and optionally adds a commit gate. omp itself owns the backend settings (`/settings` → Memory). Offered on a brand-new install; existing installs run `/starter memory`. See [Memory](#memory-starter-memory). |
| **Developer tools** *(optional)* | Sets up a language server (LSP) and a debugger (DAP) for JavaScript/TypeScript, Python, Go, Rust and C/C++ with the SDKs you already have. Offered on a brand-new install; existing installs run `/starter tools`. See [Language tooling](#language-tooling-starter-tools). |

Every step can be skipped.

## Install

```sh
omp plugin marketplace add tung-dnt/omp-starter
omp plugin install starter@omp-starter
omp
```

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

## Memory (`/starter memory`)

The step picks omp's memory backend and nothing else about it. omp already owns the backend and its settings: `memory.backend`, `/settings` → Memory, and `/memory`. omp-starter adds what omp lacks: the memory rules in `~/.omp/agent/AGENTS.md` and the commit gate.

| Backend | What it is | Agent memory tools |
|---|---|---|
| `off` | No memory subsystem | none |
| `local` | Local session summaries (`memory_summary.md`) | `learn` (with `autolearn`) |
| `hindsight` | Hindsight remote memory service | `retain`, `recall`, `reflect`, `learn` (with `autolearn`) |
| `mnemopi` | Local SQLite recall/retain | `retain`, `recall`, `reflect`, `memory_edit`, `learn` (with `autolearn`) |
| `sharpshooter` | Project decision files, consolidated in the background | none |

1. The select shows the current `memory.backend` (read with `omp config get`) and marks it. `omp config set memory.backend` runs only when you choose a different one.
2. For `hindsight` the step does not ask for the server. It tells you to set the URL and token in `/settings` → Memory, or export `HINDSIGHT_API_URL` and `HINDSIGHT_API_TOKEN` (which win over the settings and keep the token out of the settings file).
3. **Commit gate (optional):** offered when the backend has a write tool. You confirm it and name the folders (default `~/projects`).
4. The step then rewrites `~/.omp/agent/AGENTS.md` from the memory rules of the chosen backend and the gate rules. An existing different file is backed up after you confirm.

It runs automatically only on a brand-new install; existing installs opt in with `/starter memory`. The generated rules, per backend:

- **hindsight, mnemopi:** save a durable fact (decision, gotcha, convention, preference, resolved failure) with `retain` (or `learn`), search with `recall`, use `reflect` to synthesize an answer, update a stale memory instead of adding a contradicting one. mnemopi also names `memory_edit` for edit and forget.
- **local:** omp summarises sessions automatically; `learn` saves a fact when `autolearn` is on.
- **sharpshooter:** decision files are consolidated automatically; follow them unless the user overrides one.
- Every backend that stores something adds: never retain database query results, tool output that holds patient data, or secrets.

This plugin adds no memory tools, memory index or memory folder. Recommended Hindsight settings: `hindsight.autoRetain false` (session transcripts carry tool output) and `hindsight.recallTimeoutMs 5000`.

**Commit gate.** Blocks the agent's `git commit` under a gate folder until the session saved a memory: a successful `retain`, `learn` or `memory_edit` (whichever the backend has). File writes and edits never count. `[skip-mem]` in the commit message bypasses it, and so does an unattended build (`OMP_STARTER_UNATTENDED=1`). Only the `commit` subcommand is gated: `git commit-tree` or `git log --grep commit` pass. The gate checks the folder the commit really runs in (bash `cwd`, a leading `cd <dir> &&`, `git -C <dir>`). A save counts when the tool returns without an error. The block message names the tools of the current backend. A backend with no write tool has nothing that could satisfy the gate, so the gate never blocks. The setting lives in `memory.gateDirs` of `~/.omp/agent/omp-starter.json`.

| Do | Don't |
|---|---|
| Save a decision with who, what, when and why, and `recall` before asking about a past choice. | Retain database query results, tool output that holds patient data, or secrets. |
| Keep `hindsight.autoRetain` off: session transcripts carry tool output. | Retain a whole session transcript. |

**Verify:** `bun test extensions/memory-commit-gate.test.ts extensions/setup.test.ts extensions/lib/state.test.ts`.

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
- `/starter skills`, `/starter models`, `/starter jev`, `/starter memory`, `/starter tools`: rerun one step (`/starter skills` reopens the kit picker and offers updates for kept kits; `/starter memory` picks the memory backend and the commit gate; `/starter jev` turns Jev off when it is on).
- `/starter updates`: check installed/published versions of the installed skill kits and `starter@omp-starter`; confirm each plugin/scope before updating. pstack and Matt Pocock publish no version in their catalogs, so for them it prints the upgrade command instead.

Answers are stored in `~/.omp/agent/omp-starter.json`. Delete a key to be asked again at the next start. The wizard only runs automatically in the interactive TUI: not in `omp -p` or subagents.

### Confirmed plugin updates

Run `/starter updates` when you want to check. There is no added startup version request, polling timer, or background updater. `/starter skills` uses the same version-check/update helper for the kits you keep checked.

The updater reads structured native installation metadata and the two official public catalogs. A newer semantic version is offered with its `user` or `project` scope; equal/older versions are not reinstalled. Only confirmation permits refreshing that named marketplace and invoking native upgrade for that exact plugin/scope. Missing plugins and unmanaged npm/link/Git copies are not converted or overwritten.

| Do | Don't |
|---|---|
| Review the plugin ID, scope and available version, then confirm or decline. | Expect opening a session to check or install updates. |
| Restart the OMP session after a verified update to load new extension code. | Treat an on-disk update as an automatic reload of the running extension. |
| Read failures as unverified state and check again deliberately. | Interpret network, metadata or native-command errors as “already latest.” |

Native OMP remains responsible for configured marketplace sources and installation. Its version caches can be shared across scopes; a targeted scope does not guarantee a physically separate cache. Its independent `marketplace.autoUpdate` preference is not changed by this feature.

## Skill kits (`/starter skills`)

One form with a checkbox per kit. Checked kits get installed; an installed kit you uncheck is uninstalled after a confirm that names it. On a fresh install addy is preselected; after that the picker shows what is installed. At startup the step only records a kit you already have and never asks. Hosts that cannot draw a form get one yes/no question per kit.

| Kit | Installs | Notes |
|---|---|---|
| pstack | `pstack@cursor-plugins` (marketplace `cursor/plugins`) | omp's plugin loader skips 57 of pstack's 58 skills (their `disable-model-invocation` field), so the step adds `<plugins>/node_modules/pstack/skills` to `skills.customDirectories`. That link follows pstack upgrades. Uninstalling removes the entry. |
| Matt Pocock | `mattpocock-skills@mattpocock` (marketplace `mattpocock/skills`) | All 27 promoted skills load. |
| addy | `agent-skills@addy-agent-skills` (marketplace `addyosmani/agent-skills`) | All 26 skills load. |
| ponytail | `ponytail@ponytail` (marketplace `DietrichGebert/ponytail`) | Loads through its pi extension, so the least-code ladder is injected every session (no need for the model to pick the skill). Adds `/ponytail [lite\|full\|ultra\|off]`, `/ponytail-review`, `/ponytail-audit`, `/ponytail-debt`, `/ponytail-gain` and `/ponytail-help`. `ponytail-review` overlaps the other kits' code review skills. Validation, error handling and security stay untouched; in repos with a design system its "native platform feature" rung can conflict with reuse, so its "already in this codebase" rung should win. |
| spec-kit | `uv tool install specify-cli` | A CLI, no skills: run `specify init --here --integration omp` in a repo to add `/speckit.*` commands, `.specify/` and `specs/`. Needs [uv](https://docs.astral.sh/uv/); without it the step says so and installs nothing. |

**Overlap warning.** Before anything changes, kits that cover the same job are listed with their skills, and you choose **Install anyway** or **Change selection** (the picker reopens with your choice). Jobs checked: spec/requirements, plan/tasks, implementation, TDD, code review, debugging, stress-testing a plan, skill router, architecture and prototyping. Two names also clash: `tdd` and `teach` exist in pstack and Matt Pocock's kit; omp keeps pstack's as `/skill:tdd` and `/skill:teach` and namespaces Matt's as `mattpocock-skills/tdd` and `mattpocock-skills/teach`.

| Do | Don't |
|---|---|
| Pick one kit per job, or keep the overlap on purpose and say in your prompt which skill to use. | Install every kit and expect the model to choose consistently between four TDD skills. |
| Restart the session after the step: new plugins load at startup. | Remove a kit's files by hand: uncheck it so its `customDirectories` entry goes too. |

Unmanaged copies (npm, link, Git) and project-scope installs count as installed but are never converted or uninstalled; the step tells you to remove them where they were installed.

## Task tracking

Native session todo and task tools hold mutable progress. The active session is the single progress owner; a task run is execution, not proof that code is verified.

Keep plans, acceptance criteria, designs and decisions as static artifacts, and pass workers their approved artifact paths. Native todo/task state is session-local: it does not provide a shared project board, cross-session claims or automatic dependency scheduling. For durable cross-session project coordination, choose and maintain an external tracker deliberately; do not mirror native task status into notes.

## Asking questions

The plugin ships an always-on rule (`rules/ask-user.md`): the lead's decisions go to you instead of being decided for you. You own framing, high-level design (architecture, data model, API contracts, cross-system boundaries), invariants, risk and acceptance, so gaps in those, and in scope, are asked. The agent owns low-level design, code structure, test design and mechanics, and records each non-trivial choice with the rejected alternative in the PR's decision log. Facts that tools, code or docs can answer are settled by the agent. Every question goes through omp's `ask` tool as one HTML form per turn, never only in prose; a round's independent questions share the form. Each question is a fieldset whose legend names the decision and the concrete thing it concerns, followed by context (what is decided, why now, what it hinges on). Each option gives its main pro and con and whether it is easy to reverse, and the recommended option is preselected. Paths you may want to open also go in chat, since many clients make nothing inside the form clickable.

A second always-on rule (`rules/how-means-plan.md`): a request that is itself a how-question ("how do I …", or in Vietnamese "làm sao …", "như thế nào …", "cách nào …") is treated as planning and discussion. The agent investigates read-only, presents options, trade-offs and a recommendation, and asks before building anything. An instruction that merely mentions "how" ("fix X and show me how") is carried out.

There is no per-task design approval: the agent owns low-level design and records its choices in the PR's decision log.

A fourth always-on rule (`rules/ticket-tracking.md`): native todo is the sole mutable progress checklist for the active session. Plans and decisions remain in static artifacts; native execution is not test proof. Issue trackers such as Jira are never commented on unless you ask, and any status transition is asked first.

A fifth always-on rule (`rules/say-it-in-chat.md`): chat views that collapse tool calls to their one-line intent (herdr web's Chat view, for one) hide subagent briefs and paths, so the agent says in chat what a subagent will do (task, files, limits like "no push") and puts paths, branches and results in its prose, not only in tool arguments.

A sixth always-on rule (`rules/agent-sessions.md`): when the agent coordinates other agent sessions (tmux or herdr panes, terminals running omp or Claude), it never answers their `ask` dialogs or sends keystrokes to them; only you answer dialogs. It doesn't wait on a session with no event that will end the wait: it stops and says in chat what is blocked. Progress is reported from verified output, never from a session showing `running`, and building goes to subagents rather than extra top-level sessions.

A seventh always-on rule (`rules/cross-repo-investigation.md`): an investigation that spans two or more repositories settles its scope, then fans out one `scout` per repo. Each scout writes `local://<repo>-trace.md` with `path:start-end`, the symbol, a short excerpt and an evidence label; the main session reads those reports and opens only the cited range of a claim it doubts. Its turns carry the whole conversation, so a file read there costs many times a scout's read.

An eighth always-on rule (`rules/subagent-absolute-paths.md`) loads in every subagent and never in the main session: `read`, `edit`, `write`, `glob` and `lsp` resolve relative paths from the session's directory, not from where `bash` `cd`'ed, so subagents pass them absolute paths. Before it, subagents of a session started in a parent folder of the repo lost a turn on each relative `read`/`lsp` call that came back "not found".

`extensions/cross-repo-reads.ts` reminds the main session of the cross-repo scout fan-out once it has read source from a second repository: a `read` of a source file, `rg`/`grep` over a repo folder, or `cat`/`head`/`sed`… of a source file, with relative paths resolved from the session's folder or the command's `cd`. It reminds again only when a further repo appears. A session working in one repo never sees it. Docs, `node_modules`, hidden folders (`~/.omp`), files outside any git repo (such as `/tmp` scratch files) and system folders don't count, nor do subagents' reads.

`extensions/blast-radius.ts` appends a short **Blast radius** block to an `edit` or `write` result when the change alters an exported symbol in a TS/JS or Go file. A symbol counts as changed when its signature does: the parameters and return type of a function or method (including an exported arrow-function `const`), or the whole declaration of an `interface`/`type`/`enum`/Go `type`. The block lists that symbol's references in other files, from the language server the `lsp` tool already runs, so no second server starts. A removed or renamed export can no longer be asked about, so its uses come from `git grep -w` over tracked files and are labelled `text matches`. Body-only edits, reformatting and new exports add nothing. Limits: 3 changed and 3 removed symbols per call, 8 locations per symbol, 700 characters, 6 s. A slow or missing server, or any error, adds nothing and never changes the edit's own result. The block holds paths and line numbers only, never code. It runs in every agent. Turn it off with omp's extension toggle.

The `ask`-based rules load in the main session only, except `ticket-tracking`, which also loads in `task` subagents. Other subagents can't use the `ask` tool, so they don't carry these rules.

## Unattended builds

A build nobody watches is an omp session started with `OMP_STARTER_UNATTENDED=1`; the dispatcher that starts it sets it. With exactly that value, `extensions/unattended.ts` registers one hook. In any other session it registers nothing. The same value switches the commit gate off.

- **No questions.** The `ask` tool is refused: the agent decides and records the choice, with the alternative it rejected, in the pull request's `## Decision log`, or writes `stuck.md` in the spec folder and stops when the work cannot continue.
- **No commit gate.** `memory-commit-gate` lets every commit through, so a build needs no memory write to commit.

| Do | Don't |
|---|---|
| Record each decision, with the rejected alternative, in the PR's `## Decision log`. | Wait for an answer: nobody reads the session. |

**Verify:** `bun test extensions/unattended.test.ts extensions/memory-commit-gate.test.ts`.

## Safety kit

Four extensions that cover Claude Code features omp lacks. They need no wizard step; tune them by hand in `~/.omp/agent/omp-starter.json`.

### Path policy (`policy`)

`extensions/path-policy.ts` holds `read`, `grep`, `glob`, `ast_grep`, `write`, `edit` and `ast_edit` calls, including calls made from `eval`, that name a protected path. In the interactive main session it asks once per path ("Allow for this session?"); subagents, unattended and headless sessions are refused, because nobody can answer them.

| List | Default | Checked for |
|---|---|---|
| `secretReads` | `**/.env`, `**/.env.*`, `**/*.pem`, `**/*.key`, `~/.ssh/**`, `~/.aws/credentials`, `~/.omp/agent/secrets.yml`, `**/secrets.yml` | reads, searches and writes |
| `protectedWrites` | `**/.git/**`, `~/.zshrc`, `~/.bashrc`, `~/.profile`, `~/.zprofile`, `~/.omp/agent/config.yml`, `~/.omp/agent/keybindings.yml` | writes and edits |
| `allow` | `**/.env.example`, `**/.env.sample`, `**/.env.vault` | checked first; a match is never held |

A list you set replaces its default. `"policy": { "off": true }` turns it off. A symlink is judged by its target as well as its name. `bash` is not covered: put hard stops for shell commands in omp's `bash.patterns` (deny rules apply in every approval mode and in subagents). A search over a folder (`grep .`) is not held even when the folder holds a secret file; only paths that match a rule are.

### File undo (`/undo`)

omp's `checkpoint` and `rewind` prune the conversation only; they never touch files. `extensions/file-undo.ts` saves each file the first time a `write`, `edit` or `ast_edit` touches it during a prompt, and, in a git repo, a `git stash create` snapshot when the prompt starts (it does not change the work tree or the stash list).

| Command | Effect |
|---|---|
| `/undo` | Restores the files the last prompt's edit tools changed (deletes files they created). A file someone changed after the agent's edit is kept unless you confirm. Lists files that differ from the snapshot but were changed some other way (bash). |
| `/undo all` | Also restores those tracked files from the prompt's git snapshot, after one confirm. Untracked files made since are listed, never deleted. |
| `/undo list` | The saved prompts (up to 20) with age, file count and snapshot. |

History lives in memory: a new or switched session starts empty. `/undo` waits for the turn to end.

### Notifications (`notify`)

On macOS, `extensions/notify.ts` posts a desktop notification (through `osascript`) from the main interactive session when a turn that ran at least `minSeconds` (default 20) ends, when `ask` waits for your answer, and when a tool waits for approval. At most one per 5 seconds. `"notify": { "off": true }` turns it off; unattended sessions never notify.

### Timed prompts (`/every`)

omp's built-in loop mode repeats a prompt after each turn; `extensions/every.ts` sends one on a clock instead.

| Command | Effect |
|---|---|
| `/every 10m check CI on my PR` | Repeats the prompt every 10 minutes (minimum 60s). |
| `/every in 2h remind me to push` | Sends it once after 2 hours. |
| `/every list`, `/every stop <id>\|all` | Shows or cancels jobs. |

The model can do the same with the `schedule_prompt`, `list_scheduled_prompts` and `cancel_scheduled_prompt` tools (main session only, refused in unattended sessions). Durations: `30s`, `10m`, `2h`, `1d`, `1h30m`. At most 20 jobs; each expires after 7 days. A due prompt arrives as `[scheduled j1] …`, queued as a follow-up while a turn runs. Jobs are session-scoped: a new or switched session clears them and they end with the process. Missed ticks do not catch up.

**Verify:** `bun test extensions/path-policy.test.ts extensions/file-undo.test.ts extensions/notify.test.ts extensions/every.test.ts`.

### Workflow commands (`/epic`, `/story`, `/build`, `/quick-fix`)

The plugin ships four commands (`commands/*.md`), each reading its skill (`skills/<name>/SKILL.md`). They need the pstack skill kit (`/starter skills` → pstack); without it they say so and stop.

| Command | For |
|---|---|
| `/quick-fix <bug>` | One bug or small task: failing test, fix, evidence. |
| `/story <story or ticket>` | One vertical slice, one PR under about 400 lines: clarify, TDD, review, verify, PR. |
| `/epic <epic or ticket>` | Big work: a pstack multi-phase plan in `plans/<NNN-name>.md`, split into stories. Never implements. |
| `/build <repo> <branch> <plan> [story=N] [--feedback]` | Unattended build of a plan (or one story) to a draft PR, started by agent-dispatch. |

A file with the same name in `~/.omp/agent/commands/` or `~/.omp/agent/skills/` shadows the plugin's (omp ranks your own files first); delete it to get the plugin's version. Two extensions enforce the commands:

| Extension | When | What it does |
|---|---|---|
| `epic-guard` | From `/epic` until `/epic-done`, `/story` or `/build` | Refuses `write`, `edit` and `ast_edit` calls on repo files outside `plans/` (where `/epic` writes `plans/<NNN-name>.md`), in subagents too. Paths outside the repo pass. Saved in the session, so it survives a restart or resume, and carried into the fresh session that "Approve and execute" in Plan Review starts. |
| `plan-mode` | `/story` or `/epic` typed in the interactive TUI | Enters omp's plan mode before the turn, so clarifying, the acceptance criteria and the decisions are read-only and the plan goes to Plan Review. Approving it leaves plan mode: `/story` builds, `/epic` writes `plans/<NNN-name>.md` and commits it. Print, RPC and unattended sessions run both as before and confirm with `ask`. |

`epic-guard` leaves `bash` alone, so a shell write of code is not caught.

**Verify:** `bun test extensions/epic-guard.test.ts` (it also checks that every plan path the `epic` and `build` skills name is one the guard allows).

### Ship fence (`ship-fence`)

The guard `/ship` runs behind while it watches a pull request (see `plans/001-ship.md`). When the extension loads it names a state file for the omp process in `OMP_SHIP_FENCE` (under `~/.omp/agent/ship/fence/`) and puts `bin/ship-fence` first on `PATH`, before omp captures the environment its shells start from. `/ship` then arms and disarms the fence by rewriting that file, so the change reaches every shell at once. Unarmed, a `gh` or `git` call costs one `grep` of the file. A session started with `OMP_SHIP_FENCE` naming an armed state (an unattended trigger, or a test) is fenced from its first call.

| Layer | Checks while armed |
|---|---|
| `bin/ship-fence/{gh,git}` | Every `gh` and `git` process by its real argv, so scripts, eval cells and wrappers (`gh-blinx`, `rtk`) are covered. Refuses merge, approve, undraft, close and base changes; settings, secrets, aliases and extensions (gh and git); force pushes, deletes, tags and pushes to any branch but the watched one on `origin`; commits and merges that skip hooks; remote and hook config changes. `gh api` writes only comments, review replies, reviewer re-requests and resolving one review thread. A push is also refused when it carries a change to a protected file that differs both from how the branch held it at arming and from the base, however the file was edited. A call whose environment lost `OMP_SHIP_FENCE` is refused. The check runs with the `bun` found at load, or omp's own binary with `BUN_BE_BUN=1`. |
| `ship-fence` extension (`tool_call`) | `write`/`edit`/`ast_edit` on `.github/`, CODEOWNERS, `.env*` (not examples), `.npmrc`, AGENTS.md, CLAUDE.md, `.claude/`, `.mcp.json`, git hooks and the repo's git folders (a linked worktree's too), matched case-blind through symlinks; `conflict://` writes; `ast_edit` patterns or folders that hold such files; the fence's own files. Shell lines that reset `PATH`, `OMP_SHIP_FENCE` or git's config variables (`env -i`/`-u`, `command -p`, assignments, `export`/`unset`), or run `gh`/`git` by a path or a computed name; `api.github.com`; `gh auth token`. The github tool's non-draft PRs, force pushes and pushes to other branches. |

Every comment `/ship` posts must start with the line `<!-- omp-ship -->` and hold no @-mention, link, other HTML comment or closing keyword (`fixes #12`).

Limits: the fence is a guardrail against mistakes and simple injected instructions, not a sandbox. A script file that resets `PATH` itself, or a program that talks to GitHub without `gh` or `git`, is not seen. When omp's shell is bash, the rc snapshot it re-sources can put an rc file's `PATH` ahead of the shims (zsh, the macOS default, is not affected). GitHub branch protection and path rulesets are the backstop.

**Verify:** `bun test extensions/ship/`.

### Ship watch (`extensions/ship/watch.ts`)

The code that decides when `/ship` runs a model pass and which session may run it (`plans/001-ship.md`, story 3). It calls no model and no network; the `/ship` command will drive it from a 2-minute timer.

- **Ends** when the PR is merged or closed, its base branch changes, or the watch is 7 days old. At 24 passes in 24 hours it also answers "end" (`spend_cap`), but reading goes on, and the cap lifts as passes age out or when `/ship` is run again.
- **A pass starts** when the PR changed, at least 10 minutes after the last pass; or when the check the last pass set comes due: 2 minutes after a push, 30 minutes while checks run, otherwise an hour, each pushed back (doubling, up to a day) while nothing changes. Nothing starts a pass in the 2 minutes after a push.
- **One watch per PR**, in `~/.omp/agent/ship/watches/<owner>-<repo>-<n>.json`, written to a temp file and renamed into place, so a crash leaves the old one. A second live session on the same PR is refused and told which session holds it; an owner whose heartbeat is over 10 minutes old, or whose process is gone, is taken over. Running `/ship` again resumes the file and starts the pass count over.

`bun scripts/ship-watch-replay.ts` replays a scripted day of one PR through the engine and prints every pass, push and wait.

**Verify:** `bun test extensions/ship/watch.test.ts`.

## Usage report

A read-only report on how agents actually use the native todo, mined from omp's session transcripts. It calls no model and no network.

```bash
bun run usage                      # or: bun scripts/usage-report.ts
bun run usage --since 2026-10-15   # only sessions that started on or after that day
bun scripts/usage-report.ts --json /tmp/usage-report.json   # same numbers plus one row per session
# options: --sessions <dir> (default ~/.omp/agent/sessions)
```

It prints one markdown table per metric, for main sessions and subagents separately (todo duties belong to the main session), then a coverage line with files read, skipped files, malformed lines and schema versions.

| Metric | Question |
|---|---|
| M5 | Todo: did the session end with open items, how many edit/write/bash calls ran after the last todo update, how many turns held only `todo` calls? |
| M6 | How many `todo` calls were made, and in how many sessions? |

The numbering starts at M5: M1 to M4 measured memory notes that omp's memory backend now holds.

| Do | Don't |
|---|---|
| Read it as a trend: compare runs with `--since`. | Treat a count as a verdict: a session can end with open todo items for good reasons. |
| Write `--json` outside the repo, for example under `/tmp`. | Commit the JSON; session rows name your sessions and repos. |
| Check the coverage line first: skipped files and unresolved repos shrink what a table covers. | Compare numbers across omp upgrades without it; the transcript format can change (only schema version 3 is read). |

Limits: a session's repo comes from the origin URL of its working folder, so a folder deleted since is counted as "repo unresolved". The output holds counts, session file names, repo names and tool names; it never prints message text, tool arguments, command lines or file contents. Lines that are not needed for a metric are checked only for being a brace-delimited JSON object, not fully parsed. The report never writes to the sessions folder; its only write is the `--json` file.

## Release notes

### Unreleased (`feat/ship`)

- **Added:** `ship-fence`, the guard `/ship` will run behind: `gh`/`git` shims plus a tool-call check, armed and disarmed by rewriting a per-process state file, and a push check on protected files. Every session now puts `bin/ship-fence` first on `PATH`; unarmed, it passes calls straight through. See [Ship fence](#ship-fence-ship-fence). Story 1 of `plans/001-ship.md`.
- **Added:** the `/ship` watch engine, code only: from one read of the PR it decides to run a pass, wait, or end the watch (a 10-minute floor between passes the PR's changes start, checks 2 minutes after a push, 30 minutes while checks run and an hour when nothing runs, backing off while nothing changes, at most 24 passes a day, 7 days), and keeps one file per PR under `~/.omp/agent/ship/watches/` that refuses a second live session and takes over a stale one. Nothing calls it yet. See [Ship watch](#ship-watch-extensionsshipwatchts). Story 3 of `plans/001-ship.md`.

### 0.46.0 — 2026-11-24

- **Changed:** `/epic` starts in plan mode in the TUI, like `/story`: questions and the draft plan stay read-only and the plan is approved in Plan Review, where you can annotate it. Approval leaves plan mode, then `/epic` writes `plans/<NNN-name>.md` and commits it. `story-plan` is renamed `plan-mode`.
- **Fixed:** `epic-guard` turned off when Plan Review's "Approve and execute" started a fresh session; it now carries over that session.

### 0.45.0 — 2026-11-24

- **Added:** the workflow commands `/epic`, `/story`, `/build` and `/quick-fix` and their skills ship with the plugin (`commands/`, `skills/`), next to `epic-guard` and `story-plan`, so a change to a skill and its guard lands in one commit. See [Workflow commands](#workflow-commands-epic-story-build-quick-fix). They need the pstack kit.
- Existing installs: delete your own copies in `~/.omp/agent/commands/{epic,story,build,quick-fix}.md` and `~/.omp/agent/skills/{epic,story,build,quick-fix}/`, which shadow the plugin's.

### 0.44.1 — 2026-11-24

- **Fixed:** `epic-guard` allowed only spec-kit paths (`.specify/`, `specs/`), but `/epic` now writes a pstack plan to `plans/<NNN-name>.md`, so the guard refused `/epic`'s own plan. It now allows `plans/` only.

### 0.44.0 — 2026-11-24

- **Added:** `epic-guard`: `/epic` is spec-only until `/epic-done`, `/story` or `/build` (writes outside the spec-kit folders are refused, subagents included). `story-plan`: `/story` starts in plan mode in the TUI. See [Workflow commands](#workflow-commands-epic-story-build-quick-fix).
- Existing installs: nothing to do. The commands themselves live in your agent folder; the skill texts for `epic` and `story` there describe the new behaviour.

### 0.43.0 — 2026-11-24

- **Added:** ponytail as a skill kit in `/starter skills` (`ponytail@ponytail`, marketplace `DietrichGebert/ponytail`), with `ponytail-review` in the code review overlap check; `/starter` plugin updates also cover it.
- Existing installs: nothing to do. Run `/starter skills` to add or remove ponytail; an existing marketplace install of `ponytail@ponytail` is picked up as installed.

### 0.42.0 — 2026-11-24

- **Added:** safety kit, four extensions without a wizard step (see [Safety kit](#safety-kit)): `path-policy` holds reads and writes of secret and protected paths (asks in the main session, refuses in subagents and unattended sessions); `file-undo` adds `/undo`, restoring files the last prompt's edit tools changed, with a git snapshot for bash changes; `notify` posts macOS notifications when a long turn ends or omp waits for you; `every` adds `/every` and the `schedule_prompt` tools for timed prompts.
- Existing installs: nothing to do. To keep a path readable, add it to `policy.allow` in `~/.omp/agent/omp-starter.json`; to turn a part off, set `policy.off` or `notify.off`.

### 0.41.0 — 2026-11-23

- **Removed / Breaking:** Obsidian vault support. `/starter kb` and `/kb` are gone, along with the `knowledge-base` skill and the vault docs in the generated `AGENTS.md`. Knowledge and memory live in omp's memory backend (Hindsight); see [Memory](#memory-starter-memory).
- **Changed:** the commit gate is satisfied only by a successful `retain`, `learn` or `memory_edit`; a `write`/`edit` of a file, including a note, no longer counts. The extension is `memory-commit-gate`. `~/.omp/agent/AGENTS.md` holds the memory rules and the gate rules only.
- **Changed:** the legacy `kb` key of `omp-starter.json` is read once for its gate folders (when `memory` is absent) and is dropped from the state, so the next write removes it from disk.
- Existing installs: nothing to delete. Your vault and its `AGENTS.md` files stay where they are and nothing reads them; remove a per-folder `AGENTS.md` that only pointed at the vault, and rerun `/starter memory` to regenerate `~/.omp/agent/AGENTS.md` without the vault docs.

### 0.40.0 — 2026-11-23

- **Added:** `/starter memory`, a step that selects omp's memory backend (`off`, `local`, `hindsight`, `mnemopi`, `sharpshooter`), runs `omp config set memory.backend` only on a change, and writes the memory rules for that backend into `~/.omp/agent/AGENTS.md`. For Hindsight it points to `/settings` → Memory or `HINDSIGHT_API_URL`/`HINDSIGHT_API_TOKEN` instead of asking for a URL or token. Offered automatically only on a brand-new install.
- **Changed / Breaking:** the commit gate moved from the knowledge-base source (`kb.sources[].gateDir`) to the memory state (`memory.gateDirs`), and `/starter kb` no longer asks about it. Existing state is migrated automatically on read: each source's `gateDir` becomes one entry of `memory.gateDirs`, so commits stay blocked where they were, with no wizard rerun. The gate also accepts `memory_edit`, and a write into any configured knowledge base satisfies every gate folder.
- **Changed:** the vault is an optional docs add-on ("Knowledge base (Obsidian docs)"). The every-session `AGENTS.md` is composed from the vault docs, the memory rules of the backend and the gate rules; per-folder files hold docs only. `/kb status` also shows the memory backend and the gate.
- Existing installs: run `/starter memory` to record the backend and regenerate `~/.omp/agent/AGENTS.md` (an existing different file is backed up after you confirm); until then the migrated gate works and the backend is read live.

### 0.39.0 — 2026-11-23

- **Changed:** memory moves from the Obsidian vault to omp's built-in Hindsight backend (`memory.backend hindsight`). omp's `retain`, `recall`, `reflect` and `learn` replace `kb_remember` and `kb_recall`, and its auto-recall replaces the injected memory index. The generated `AGENTS.md` Memory section names `retain`/`learn` and `recall`, and says never to retain database query results, tool output that holds patient data, or secrets. `/starter kb` no longer creates `_memory/MEMORY.md`. The vault keeps docs, standards and projects.
- **Changed:** the commit gate also passes after a successful `retain` or `learn`, for every gated knowledge base. A `write`/`edit` into a knowledge base and `[skip-mem]` work as before.
- **Removed:** the `kb_remember` and `kb_recall` tools, the `kb-memory` extension (memory index injection), and the `/kb` subcommands `search`, `scopes`, `view` and `check`. `/kb status` stays and reports the vault, the commit gate and the other knowledge bases; omp's `/memory` inspects the memory backend.
- **Removed:** the usage-report metrics M1 to M4, the memory columns of M6 and the `--vault` option. M5 (todo hygiene) and the todo-call count stay.
- Existing installs: run `omp config set memory.backend hindsight`, then set `hindsight.apiUrl` and `hindsight.apiToken` (or export `HINDSIGHT_API_URL` and `HINDSIGHT_API_TOKEN`, which win over the settings and keep the token out of the settings file), `hindsight.autoRetain false` so session transcripts are not stored, and `hindsight.recallTimeoutMs 5000` so the recall at session start waits at most 5 s instead of the 30 s default. Then run `/starter kb` to regenerate `AGENTS.md`, or replace its Memory section by hand. The vault's `_memory/` folder is left as a read-only archive: nothing reads or writes it, and nothing imports its notes into Hindsight.

### 0.38.1 — 2026-11-23

- **Changed:** unattended builds only refuse `ask`, switched on by `OMP_STARTER_UNATTENDED=1` alone. The agent records each decision in the pull request's `## Decision log`, or writes `stuck.md` in the spec folder and stops.
- **Removed:** the unattended stop rule and its stop budget, and `OMP_STARTER_STORY`. Plans now live in each repository (spec-kit), so the vault `projects/<id>/plan.md` is no longer read. Existing installs: nothing to do; a dispatcher still setting `OMP_STARTER_STORY` is ignored.

### 0.38.0 — 2026-11-23

- **Added:** the skill-kit picker in `/starter skills`: checkboxes for pstack, Matt Pocock's skills, addyosmani/agent-skills and spec-kit, a warning listing the jobs and skill names the chosen kits share, and uninstall of an installed kit you uncheck (after a confirm). pstack's skills load through `skills.customDirectories`, which the step manages. See [Skill kits](#skill-kits-starter-skills).
- **Changed:** the addy kit is upstream `agent-skills@addy-agent-skills`; the fork `agent-skills@tung-agent-skills` is no longer installed or updated by `/starter`. `ticket-tracking` loads in `task` subagents instead of `task-builder`.
- **Removed:** the lead harness: the `lead` tool and `/starter lead`, hard gates, the repository fence, the input check on `/story` and `/build`, the loop controller, the PR body check, the builder cap and the lead notifications (`OMP_STARTER_LEAD`, `OMP_STARTER_LEAD_LOOP`, `OMP_STARTER_NOTIFY_CMD`), with `scripts/arch-graph.ts`, `templates/arch-graph.yml` and `scripts/lead-replay.ts`. Verification moves to a PR-stage panel outside this plugin.
- **Removed:** `lsp-guard` and the rules `lsp-symbol-search`, `lsp-symbol-judged` and `dap-over-print`. The Jev step now only routes the `judge` role; it no longer touches `ttsr.disabledRules`.
- **Added:** unattended builds (see [Unattended builds](#unattended-builds)). With `OMP_STARTER_UNATTENDED=1` and `OMP_STARTER_STORY=<id>`, `ask` is refused and the main session cannot stop until every repository in `<kb>/projects/<id>/plan.md` has an open pull request on its branch or `stuck.md` exists; after 20 refused stops the stop goes through and `stuck.md` says so.
- **Changed:** the commit gate lets every commit through while `OMP_STARTER_UNATTENDED=1`. `rules/ask-user.md` no longer mentions hard gates.
- Existing installs: nothing is deleted. The `lead/` folders in your knowledge base (hard gates, stories, templates) stay where they are and are no longer read; so is a `lead:` entry in `omp-starter.json`, which `/starter kb` drops when it rewrites that source. `lsp-symbol-search` may stay in `ttsr.disabledRules`, where it does nothing. Use agent-skills 0.10.0.

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
