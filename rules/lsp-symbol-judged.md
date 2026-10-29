---
description: Use xd://lsp navigation instead of rg/grep when searching for a code symbol (TS/JS, Go, Rust, C/C++); judged by TypeSafe Jev, set up with /starter jev
scope: tool:bash
agents: [main, task-builder, task]
condition:
  - '(?<!\|\s{0,3})\b(?:rg|grep)\b'
question: "`content` is the arguments of a shell command an AI coding agent ran. Is the agent using rg or grep to find where a named code symbol (a function, method, type, interface, class, variable or constant, e.g. `useCreateMode(`, `export function inspectConfig`, `^func Test`) is defined or used in source code? Answer no when the pattern looks for text no language server indexes: a log or test-output line, a message string, SQL, a config key, a version number, a docs heading, or output piped from another command."
interruptMode: never
---

You just used rg/grep to look up a code symbol. For TypeScript/JavaScript, Go, Rust and C/C++ a language server answers this precisely (typescript-language-server, gopls, rust-analyzer, clangd). Before reaching for text search again for a symbol:

- Where is it defined: `xd://lsp` `definition` (or `type_definition`, `implementation`; for Rust traits and C++ virtuals, `implementation` finds the impls/overrides).
- Who uses or calls it: `xd://lsp` `references`. It resolves imports, `use`/`#include`, aliases, re-exports, macros and overloads that text search misses, and skips comments and same-named strings.
- Find a symbol by name across the workspace: `xd://lsp` `symbols` with `file: "*"` and `query`.
- Renaming it across files: `xd://lsp` `rename`. Don't hand-edit every call site.

Pass `symbol` with `line` on project-aware servers; read the line first instead of guessing the line number. If `xd://lsp` `status` shows no server for the language (e.g. clangd without `compile_commands.json`, or rust-analyzer not installed), text search is the fallback.

Text search is still right for string literals, log messages, SQL/column names, config keys, i18n keys, file names, and files no server covers. If this search was one of those, carry on.
