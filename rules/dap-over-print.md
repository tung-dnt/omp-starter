---
description: Consider xd://debug before adding print statements to investigate a bug (TS/JS, Go, Rust, C/C++)
scope: tool:edit(*.{ts,tsx,js,jsx,mjs,cjs,go,rs,c,cc,cpp,cxx,h,hh,hpp}), tool:write(*.{ts,tsx,js,jsx,mjs,cjs,go,rs,c,cc,cpp,cxx,h,hh,hpp})
agents: [main, task-builder]
condition:
  - '\bconsole\.(?:log|debug)\('
  - '\bfmt\.Print(?:ln|f)?\('
  - '\b(?:e?println|e?print|dbg)!\('
  - '(?<![\w.])(?:printf|puts)\(|\bfprintf\(\s*stderr\b|\bstd::(?:cout|cerr|clog)\b|\bstd::println\('
interruptMode: never
---

You just added a print call (`console.log`, `fmt.Print*`, `println!`/`eprintln!`/`dbg!`, `printf`/`fprintf(stderr, …)`, `std::cout`/`std::cerr`). If this is temporary print debugging (add print, rerun, read output, repeat), consider `xd://debug` instead: set a breakpoint, launch or attach, and inspect variables and the call stack in one run, without editing and reverting source.

- JS/TS: use `js-debug-adapter` (`/starter tools` installs it); launch the failing test or script under it.
- Rust, C/C++ and Go: omp has built-in `lldb-dap`, `codelldb`, `gdb` and `dlv` adapters (`/starter tools` installs CodeLLDB and Delve), but each needs its binary installed. If none is installed, print debugging is acceptable.

If the print is intended output (CLI output, a program's result, a permanent log line the code needs), ignore this. If it is temporary, remove it before finishing.
