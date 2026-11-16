import { describe, expect, test } from "bun:test";
import { buildRows, describeContent } from "../src/branch";
import { BranchBuilder, basicBranch, thinking, toolCall } from "./fixtures";

const ids = (b: BranchBuilder) => buildRows(b.entries).map(row => row.entry.id);

describe("visible area", () => {
	test("rows start after the latest compaction; its kept area is not listed", () => {
		const b = new BranchBuilder();
		b.user("old question");
		b.text("old answer");
		const kept = b.user("kept question");
		b.text("kept answer");
		b.compaction(kept.id);
		const after = b.user("new question");
		expect(ids(b)).toEqual([after.id]);
	});

	test("a /clear boundary after the compaction wins", () => {
		const b = new BranchBuilder();
		const kept = b.user("kept");
		b.compaction(kept.id);
		b.user("between");
		b.resetBoundary();
		const after = b.text("after clear");
		expect(ids(b)).toEqual([after.id]);
	});

	test("a compaction after a /clear boundary wins", () => {
		const b = new BranchBuilder();
		b.resetBoundary();
		const kept = b.user("before compaction");
		b.compaction(kept.id);
		const after = b.user("after compaction");
		expect(ids(b)).toEqual([after.id]);
	});

	test("without a boundary every message is listed", () => {
		expect(ids(basicBranch())).toEqual(["e2", "e3", "e6", "e7", "e8"]);
	});
});

describe("rows", () => {
	test("only user, assistant and model-visible custom messages are rows", () => {
		const b = new BranchBuilder();
		b.custom("todo_hud_state", {});
		b.message({ role: "developer", content: "system note", timestamp: b.time });
		const user = b.user("hi");
		b.customMessage("prewalk-plan", "hidden from the model");
		const irc = b.customMessage("irc:incoming", "ping", { from: "peer", message: "ping" });
		const answer = b.text("hello");
		expect(ids(b)).toEqual([user.id, irc.id, answer.id]);
	});

	test("aborted, error and retry-recovery turns are marked as not sent", () => {
		const b = new BranchBuilder();
		b.user("q");
		const aborted = b.text("partial", { stopReason: "aborted" });
		const failed = b.text("half", { stopReason: "error" });
		const empty = b.assistant([], { stopReason: "error" });
		const retried = b.text("retry", { retryRecovery: { attempt: 1 } as never });
		const fine = b.text("ok");
		const rows = new Map(buildRows(b.entries).map(row => [row.entry.id, row.notSent]));
		expect(rows.get(aborted.id)).toBe("aborted");
		expect(rows.get(failed.id)).toBe("error");
		expect(rows.get(empty.id)).toBe("error");
		expect(rows.get(retried.id)).toBe("error");
		expect(rows.get(fine.id)).toBeUndefined();
	});

	test("an aborted turn followed by its interrupted-thinking note is sent", () => {
		const b = new BranchBuilder();
		b.user("q");
		const aborted = b.assistant([thinking("deep thought")], { stopReason: "aborted" });
		b.custom("session_exit", {});
		b.customMessage("interrupted-thinking", "continuity", undefined, false);
		expect(buildRows(b.entries).find(row => row.entry.id === aborted.id)?.notSent).toBeUndefined();
	});

	test("content description shows text, images and tools", () => {
		const b = new BranchBuilder();
		b.user([
			{ type: "text", text: "look\n\n at   this" },
			{ type: "image", data: "AAAA", mimeType: "image/png" },
		]);
		b.assistant([toolCall("c1", "read"), toolCall("c2", "bash")]);
		b.toolResult("c1", "read", "x");
		b.toolResult("c2", "bash", "y");
		b.assistant([thinking("only thinking", "sig")]);
		const [user, tools, thinkingOnly] = buildRows(b.entries);
		expect(describeContent(user, user.slots)).toBe("look at this [1 image]");
		expect(describeContent(tools, tools.slots)).toBe("tools: read, bash (+2 results)");
		expect(describeContent(thinkingOnly, thinkingOnly.slots)).toBe("(thinking only)");
	});
});

describe("tool units", () => {
	const unitIds = (b: BranchBuilder, assistantId: string) =>
		buildRows(b.entries)
			.find(row => row.entry.id === assistantId)
			?.unit.map(index => b.entries[index].id);

	test("one call: the call, its marker and its result", () => {
		const b = basicBranch();
		expect(unitIds(b, "e3")).toEqual(["e3", "e4", "e5"]);
	});

	test("parallel calls form one unit; results may be interleaved with custom entries and messages", () => {
		const b = new BranchBuilder();
		b.user("q");
		const call = b.assistant([toolCall("a", "read"), toolCall("b", "grep")]);
		const markerA = b.marker("a", "read");
		const markerB = b.marker("b", "grep");
		const resultA = b.toolResult("a", "read", "1");
		b.custom("date-cwd-reminder", {});
		b.customMessage("irc:incoming", "hello", { message: "hello" });
		const resultB = b.toolResult("b", "grep", "2");
		b.text("done");
		expect(unitIds(b, call.id)).toEqual([call.id, markerA.id, markerB.id, resultA.id, resultB.id]);
		const row = buildRows(b.entries).find(candidate => candidate.entry.id === call.id);
		expect(row?.resultCount).toBe(2);
	});

	test("a call without a result is a unit of one", () => {
		const b = new BranchBuilder();
		b.user("q");
		const call = b.assistant([toolCall("lost", "bash")], { stopReason: "aborted" });
		b.user("again");
		expect(unitIds(b, call.id)).toEqual([call.id]);
	});

	test("results of other calls are not part of the unit", () => {
		const b = new BranchBuilder();
		b.user("q");
		const first = b.assistant([toolCall("one", "read")]);
		const firstResult = b.toolResult("one", "read", "1");
		const second = b.assistant([toolCall("two", "read")]);
		const secondResult = b.toolResult("two", "read", "2");
		b.toolResult("orphan", "read", "3");
		expect(unitIds(b, first.id)).toEqual([first.id, firstResult.id]);
		expect(unitIds(b, second.id)).toEqual([second.id, secondResult.id]);
	});

	test("an insert after a row inside a call/result span goes after the span", () => {
		const b = new BranchBuilder();
		b.user("q");
		b.assistant([toolCall("a", "read")]);
		const note = b.customMessage("irc:incoming", "while reading", { message: "while reading" });
		const result = b.toolResult("a", "read", "1");
		const row = buildRows(b.entries).find(candidate => candidate.entry.id === note.id);
		expect(row && b.entries[row.anchorIndex].id).toBe(result.id);
	});
});
