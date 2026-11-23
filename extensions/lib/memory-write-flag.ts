// Whether this session saved a memory the commit gate accepts: a successful `retain`, `learn` or `memory_edit`.
// Set and read by the commit gate. omp evaluates each extension's imports separately, so module state is not shared
// between extensions: the flag lives on `globalThis` under a registry symbol instead. One process serves the main
// session and its subagents, so a subagent's write satisfies the parent's commit.
const KEY = Symbol.for("omp-starter.memory-written");
const store = globalThis as typeof globalThis & { [KEY]?: boolean };

export const memoryWritten = (): boolean => store[KEY] === true;
export const markMemoryWritten = (): void => {
	store[KEY] = true;
};
export const resetMemoryWritten = (): void => {
	store[KEY] = false;
};
