# omp-starter

A first-run setup plugin for [omp (Oh My Pi)](https://omp.sh) on macOS. The first time you open omp after installing it, it asks a few questions and sets up:

| Step | What it does |
|---|---|
| **agent-skills** *(optional)* | Installs [tung-dnt/agent-skills](https://github.com/tung-dnt/agent-skills): engineering-workflow skills, agents and `/spec` `/plan` `/build` `/review` `/ship` commands. |
| **Knowledge base** | Uses an Obsidian vault as omp's knowledge base and long-term memory. Lets you pick a vault Obsidian already knows about, writes an `AGENTS.md` that loads the memory index into every session, and optionally adds a commit gate. |
| **Remote access** | Sets up [Paseo](https://paseo.sh) so you can start and drive omp sessions from your phone: installs it if missing, enables its omp provider, binds it to your Tailscale address, sets a daemon password, and starts it at login. |

Every step can be skipped.

## Install

```sh
omp plugin marketplace add tung-dnt/omp-starter
omp plugin install starter@omp-starter
omp
```

Before the knowledge-base step, open Obsidian once so your vault is registered (and synced, if it lives in iCloud). Before the remote step, install [Tailscale](https://tailscale.com) and sign in; without it, the wizard falls back to Paseo's end-to-end-encrypted relay.

## Knowledge base

- **Vault:** chosen from Obsidian's own vault list, or any folder you type.
- **Knowledge-base folder:** a folder inside the vault (default `KnowledgeBase`). It is created with an empty `_memory/MEMORY.md` if missing.
- **Space-free link:** omp's `@` imports stop at spaces, so a vault path containing spaces gets a `~/.omp-kb` symlink.
- **Always-loaded notes:** optional list of notes (relative paths) imported into every session, e.g. your coding standards.
- **Scope:** every omp session (`~/.omp/agent/AGENTS.md`) or only sessions under one folder (`<folder>/AGENTS.md`). An existing file is backed up before it's replaced.
- **Memory:** the generated `AGENTS.md` imports `_memory/MEMORY.md` (one line per note) and tells the agent how to save new memories as notes in `_memory/`.
- **Commit gate (optional):** blocks the agent's `git commit` under the chosen folder until it has written a knowledge-base note in that session. `[skip-mem]` in the commit message bypasses it.

The plugin also ships a `knowledge-base` skill for searching and creating notes in the knowledge base.

## Remote access

After setup, on your phone:

1. Install **Paseo – Pocket Engineer**.
2. With Tailscale on: Paseo → Settings → Add host → Direct connection → your Mac's Tailscale name, port `6767`, SSL off, and the password the wizard showed you.
3. New workspace → pick a project → agent **Oh My Pi**.

Paseo runs your installed `omp`, so your config, plugins, skills and `AGENTS.md` all apply.

## Commands

- `/starter`: rerun every step.
- `/starter skills`, `/starter kb`, `/starter remote`: rerun one step.

Answers are stored in `~/.omp/agent/omp-starter.json`. Delete a key to be asked again at the next start. The wizard only runs automatically in the interactive TUI: not in `omp -p`, Paseo sessions, or subagents.

## agent-skills `/resume` hint

If agent-skills is installed, the plugin also ports its Claude Code SessionStart hook: when a session starts in a repository with claimed tasks, the agent is told to run `/resume`.

## License

MIT
