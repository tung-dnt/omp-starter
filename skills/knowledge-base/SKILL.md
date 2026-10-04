---
name: knowledge-base
description: Search, create, and link notes in the Obsidian knowledge base configured by omp-starter. Use when the user wants to find, write, or organize knowledge-base notes.
---

# Knowledge base

## Location

The knowledge base root is the `KB root` path in your context (written by omp-starter into `AGENTS.md`, e.g. `~/.omp-kb/KnowledgeBase`). Everything below is relative to it. If no KB root is in context, use the `ask` tool with options such as "Run `/starter kb`" and "Use a vault path I give you" (the user types the path via the dialog's free-text answer).

## Conventions

- Obsidian `[[wikilinks]]` (`[[Note Title]]`) link notes; `[[name]]` resolves to `name.md` anywhere in the vault.
- Put related links at the bottom of a note. Index notes are lists of `[[wikilinks]]`.
- Follow the vault's existing naming and folder structure. Look at neighbouring notes before creating one.
- Memory notes live in `_memory/` and are indexed in `_memory/MEMORY.md`; see the memory rules in your context.

Task notes under the vault's projects folder (e.g. `Projects/<repo>/stories/…/_tasks/*.md`) belong to agent-skills' `work-state.sh`. Don't hand-edit their frontmatter; change status and fields through `work-state.sh` commands.

## Workflows

### Find notes

Use the `grep` / `glob` tools on the KB root: filename globs for titles, content regex for text, and `\[\[Note Title\]\]` for backlinks.

### Create a note

1. Pick a filename that matches the vault's existing style.
2. Start with YAML frontmatter:
   ```yaml
   ---
   date: <YYYY-MM-DD>
   type: note        # note | plan | reference | idea
   tags: [<topic>]
   source: omp
   ---
   ```
3. Body starts with `# Title`.
4. Add `[[wikilinks]]` to related notes at the bottom, and add the note to any relevant index note.

Write with the `write`/`edit` tools, not shell redirection, so omp can track the change.
