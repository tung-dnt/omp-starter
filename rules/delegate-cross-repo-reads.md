---
description: When the main session reads or searches source code by absolute path, remind it to delegate cross-repo source mapping to scouts
scope: [tool:read, tool:bash]
agents: [main]
condition:
  - '(?:^|(?<=[\s"''=]))(?:~|/)(?!tmp/|dev/|proc/|usr/|etc/|opt/homebrew/)(?![^\s"'':\\]*(?:/\.|node_modules/))[^\s"'':\\]*/[^/\s"'':\\]+\.(?:tsx?|jsx?|mjs|cjs|go|sql|py|rs|java|kt|cs|php|rb)(?=[\s"'':\\]|$)'
  - '(?<!\|\s{0,3})\b(?:rg|grep)\b(?:[^|;&\n"\\]|\\[^n])*\s(?:\\?["''])?(?:~|/)(?!tmp/|dev/|proc/|usr/|etc/|opt/homebrew/)(?![^\s"''\\]*(?:/\.|node_modules/))[^\s"''\\]*/'
interruptMode: never
---

You just read or searched source code by absolute path from the main session. If this is part of an investigation across two or more repositories, stop mapping code here: follow `rules/cross-repo-investigation` and the `end-to-end-technical-flow-report` skill. Fan out one `scout` per repo with a brief (question, repo path, revision, known facts) and have each write `local://<repo>-trace.md` with `path:start-end`, symbol, a short excerpt and an evidence label. Then read the reports, and open only the cited range of a claim you doubt.

Carry on without delegating when this read is the cited range of a scout's claim, a file the user named, or code in the one repo this session is editing.
