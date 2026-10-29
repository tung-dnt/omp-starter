---
description: Chat views often collapse tool calls (e.g. herdr web's Chat view), so anything the user should see goes in chat prose, not only inside a tool call.
alwaysApply: true
agents: main
---

# Say it in chat, not only in tool arguments

The user may follow the session in a chat view that shows each tool call as one collapsed line, the tool name and its intent (`task Building t13`), such as herdr web's **Chat** view or a phone client. The arguments (subagent briefs, file paths, commands, edit bodies) are visible only in the full terminal view.

- Before spawning a subagent, say in chat what it will do: the task, the files or worktree it works in, and the limits that matter (e.g. "no push", "no new branches"). One or two lines, not the whole brief.
- Paths, branches, commits and results the user may want to open or check go in your prose, not only inside a tool call.
- Make every intent (`i`) specific: name the task, file or story ("Building t13 chat links redirect"), not a generic verb ("Running task").
