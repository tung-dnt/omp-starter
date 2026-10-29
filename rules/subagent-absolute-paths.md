---
description: Subagents pass absolute paths to read/edit/write/glob/lsp; those tools resolve relative paths from the session's directory, not where bash cd'ed.
alwaysApply: true
agents: ["!(main)"]
---

# File tools take absolute paths

Your file tools (`read`, `edit`, `write`, `glob`, and `lsp` or `xd://lsp`) resolve a relative path against the session's working directory, which may be a parent folder of the repository your task is in. A `cd` in `bash` does not move them. Pass these tools absolute paths (the repository root from your brief or `git rev-parse --show-toplevel`, plus the file) from your first call. Relative paths stay fine inside `bash` after a `cd`.
