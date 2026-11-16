import { describe, expect, test } from "bun:test";
import { buildRows, type Row } from "../src/branch";
import { Draft, rowLabels, summarize } from "../src/draft";
import { BranchBuilder, basicBranch } from "./fixtures";

function rowOf(rows: readonly Row[], id: string): Row {
	const row = rows.find(candidate => candidate.entry.id === id);
	if (!row) throw new Error(`no row ${id}`);
	return row;
}

describe("staging", () => {
	test("text equal to the original is not staged", () => {
		const rows = buildRows(basicBranch().entries);
		const draft = new Draft();
		draft.setText(rowOf(rows, "e7"), -1, "changed");
		expect(draft.size).toBe(1);
		draft.setText(rowOf(rows, "e7"), -1, "what is 17+25?");
		expect(draft.size).toBe(0);
	});

	test("deleting an edited message replaces the edit; revert undoes either", () => {
		const rows = buildRows(basicBranch().entries);
		const draft = new Draft();
		draft.setText(rowOf(rows, "e8"), 0, "43");
		draft.delete("e8");
		expect([draft.edits.size, draft.deletes.size]).toEqual([0, 1]);
		draft.revert("e8");
		expect(draft.size).toBe(0);
	});

	test("an insert after a row goes directly after it; an insert after an insert follows that insert", () => {
		const rows = buildRows(basicBranch().entries);
		const draft = new Draft();
		const first = draft.addInsert("e7", "user", "first");
		const top = draft.addInsert("e7", "user", "top");
		draft.addInsert("e7", "assistant", "after first", first.id);
		expect(draft.insertsAfter("e7").map(insert => insert.text)).toEqual(["top", "first", "after first"]);
		expect([...rowLabels(rows, draft)].filter(([id]) => id.startsWith("insert"))).toEqual([
			[top.id, "#4.1"],
			[first.id, "#4.2"],
			[draft.inserts[2].id, "#4.3"],
		]);
	});
});

describe("validation against the current branch", () => {
	test("changes to entries that left the branch or fell behind a new boundary are dropped", () => {
		const b = basicBranch();
		const draft = new Draft();
		const rows = buildRows(b.entries);
		draft.setText(rowOf(rows, "e2"), -1, "read probe2.txt");
		draft.delete("e3");
		draft.addInsert("e6", "user", "note");
		draft.setText(rowOf(rows, "e8"), 0, "43");

		b.compaction("e7");
		b.user("after compaction");
		expect(draft.prune(buildRows(b.entries))).toBe(4);
		expect(draft.size).toBe(0);
	});

	test("changes on another branch are dropped, changes still on the branch stay", () => {
		const b = basicBranch();
		const draft = new Draft();
		const rows = buildRows(b.entries);
		draft.setText(rowOf(rows, "e7"), -1, "17+26?");
		draft.setText(rowOf(rows, "e8"), 0, "43");
		const truncated = b.entries.slice(0, 7);
		expect(draft.prune(buildRows(truncated))).toBe(1);
		expect([...draft.edits.keys()]).toEqual(["e7"]);
	});

	test("an edit to a turn that is no longer sent is dropped", () => {
		const sent = new BranchBuilder();
		sent.user("q");
		const answer = sent.text("a");
		const draft = new Draft();
		draft.setText(rowOf(buildRows(sent.entries), answer.id), 0, "b");
		const aborted = new BranchBuilder();
		aborted.user("q");
		aborted.text("a", { stopReason: "aborted" });
		expect(draft.prune(buildRows(aborted.entries))).toBe(1);
	});
});

describe("summary", () => {
	test("shows what each change was and what it becomes", () => {
		const b = basicBranch();
		const rows = buildRows(b.entries);
		const draft = new Draft();
		draft.setText(rowOf(rows, "e6"), 1, "The codeword is KIWI-7.");
		draft.delete("e3");
		draft.addInsert("e7", "assistant", "Noted for later: TEAL.");
		expect(summarize(rows, draft)).toEqual([
			"#2 assistant: deleted with 1 tool result(s): tools: read (+1 result)",
			'#3 assistant: "The codeword is MANGO-3." -> "The codeword is KIWI-7."',
			'#4.1 assistant: new after #4: "Noted for later: TEAL."',
		]);
	});

	test("a change late in a long text is quoted from near the change", () => {
		const b = new BranchBuilder();
		const long = `${"word ".repeat(40)}end.`;
		b.user(long);
		const rows = buildRows(b.entries);
		const draft = new Draft();
		draft.setText(rows[0], -1, `${long} PS: AZURE-9.`);
		expect(summarize(rows, draft)).toEqual(['#1 user: "... word word word end." -> "... word word word end. PS: AZURE-9."']);
	});
});
