// Which knowledge bases (by `kbRef`) were written in this session. Set by the commit gate (write/edit
// into a KB) and by kb_remember; read by the gate. omp evaluates each extension's imports separately,
// so module state is not shared between extensions: the set lives on `globalThis` under a registry
// symbol instead. One process serves the main session and its subagents, so a subagent's KB write
// satisfies the parent's commit.
const KEY = Symbol.for("omp-starter.kb-written");
const store = globalThis as typeof globalThis & { [KEY]?: Set<string> };
const written = (store[KEY] ??= new Set<string>());

export const kbWritten = (kbRef: string): boolean => written.has(kbRef);
export const markKbWritten = (kbRef: string): void => {
	written.add(kbRef);
};
export const resetKbWritten = (): void => {
	written.clear();
};
