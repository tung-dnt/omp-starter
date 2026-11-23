// Whether this session saved something the commit gate accepts: a memory-tool write (`retain`, `learn`,
// `memory_edit`) or a `write`/`edit` into a knowledge base. Set by the commit gate, read by the gate and by
// `/kb status`. omp evaluates each extension's imports separately, so module state is not shared between
// extensions: the flag lives on `globalThis` under a registry symbol instead. One process serves the main
// session and its subagents, so a subagent's write satisfies the parent's commit.
const KEY = Symbol.for("omp-starter.kb-written");
const store = globalThis as typeof globalThis & { [KEY]?: boolean };

export const kbWritten = (): boolean => store[KEY] === true;
export const markKbWritten = (): void => {
	store[KEY] = true;
};
export const resetKbWritten = (): void => {
	store[KEY] = false;
};
