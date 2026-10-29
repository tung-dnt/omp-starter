import { expect, test } from "bun:test";
import { BYPASS, decide, onTreeSearches } from "./lsp-guard";

test("only unpiped rg/grep over paths a language server covers are candidates", () => {
	expect(onTreeSearches('rg -n "func ApproveSticker" internal')).toHaveLength(1);
	expect(onTreeSearches('cd /r && grep -n "creatingLinked\\|MULTI_ORG" app/Controllers/Http/C.js | head')).toHaveLength(1);
	// Searches of scratch copies, SQL, docs, logs, artifacts and dependencies are text by construction.
	expect(onTreeSearches('grep -n "creatingLinkedCampaign\\|MULTI_ORG" /tmp/pac2-orig-CampaignController.js | head -40')).toEqual([]);
	expect(onTreeSearches('rg -n "CREATE TABLE stickers" -A25 internal/external/db/migrations/')).toEqual([]);
	expect(onTreeSearches('rg -n -A12 -e "--- FAIL|panic:" artifact://1293')).toEqual([]);
	expect(onTreeSearches('grep -n "^#" design.md README.md')).toEqual([]);
	expect(onTreeSearches('rg -n "isolationLevel" node_modules/knex/lib')).toEqual([]);
	// A grep reading another command's output is not a lookup.
	expect(onTreeSearches("go test ./... 2>&1 | grep FAIL")).toEqual([]);
	// No path means the current tree.
	expect(onTreeSearches('rg -n "getUserRoles"')).toHaveLength(1);
});

test("a coding subagent's symbol lookup is blocked at p >= 0.85 and allowed below it", async () => {
	const cmd = 'rg -n "func ApproveSticker" internal';
	expect(await decide(cmd, "task", async () => 0.93)).toEqual({ block: true, p: 0.93 });
	expect(await decide(cmd, "task-builder", async () => 0.8)).toEqual({ block: false, p: 0.8 });
});

test("uncertainty always lets the command run: no judge answer, bypass marker, other agents, off-tree searches", async () => {
	let asked = 0;
	const judge = async () => {
		asked++;
		return 0.99;
	};
	const cmd = 'rg -n "func ApproveSticker" internal';
	expect((await decide(cmd, "task", async () => undefined)).block).toBe(false);
	expect((await decide(`${cmd} ${BYPASS}`, "task", judge)).block).toBe(false);
	expect((await decide(cmd, "scout", judge)).block).toBe(false);
	expect((await decide(cmd, undefined, judge)).block).toBe(false);
	expect((await decide('rg -n "x" /tmp/copy.go', "task", judge)).block).toBe(false);
	expect(asked).toBe(0);
});
