---
description: Use xd://lsp navigation instead of rg/grep when searching for a code symbol (TS/JS, Go, Rust, C/C++); judged by TypeSafe Jev, set up with /starter jev
scope: tool:bash
agents: [main, task-builder, task, code-reviewer, test-engineer]
condition:
  - '(?<!\|\s{0,3})\b(?:rg|grep)\b(?![^\n]*# text-search)'
question: "`content` is the arguments of a shell command an AI coding agent ran. Is the agent using rg or grep to find where a named code symbol (a function, method, type, interface, class, variable or constant, e.g. `useCreateMode(`, `export function inspectConfig`, `^func Test`) is defined or used in source code? Answer no when the pattern looks for text no language server indexes: a log or test-output line, a message string, SQL, a config key, a version number, a docs heading, or output piped from another command."
interruptMode: never
---

You just used rg/grep to look up a code symbol. For TypeScript/JavaScript, Go, Rust and C/C++ the language server answers this precisely and resolves imports, aliases, re-exports and overloads that text search misses. Make the next symbol lookup with it; the call is one step, no schema lookup needed:

- `write` to `xd://lsp` (or the `lsp` tool, if you have it) with JSON content, using absolute paths:
  - who uses it: `{"action":"references","file":"/abs/repo/internal/x.go","line":42,"symbol":"ApproveSticker"}`
  - where it is defined: same shape with `"action":"definition"` (or `implementation`, `type_definition`)
  - find it by name: `{"action":"symbols","file":"*","query":"ApproveSticker"}`; one file's symbols: `{"action":"symbols","file":"/abs/repo/internal/x.go"}`
  - rename: `{"action":"rename","file":"…","line":42,"symbol":"Old","new_name":"New"}`
- `line` must be a line where the symbol appears; read it first rather than guessing.

Keep rg/grep for text a language server doesn't index (SQL, log lines, message strings, config keys, docs), for files outside the project's source, and when `{"action":"status"}` shows no server for the language.
