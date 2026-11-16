import { describe, expect, test } from "bun:test";
import { type AgentMessage, buildRows, type Row } from "../src/branch";
import { Draft } from "../src/draft";
import { type Attribution, buildPlan, type Plan, type PlanInput, type Step } from "../src/plan";
import { BranchBuilder, basicBranch, COPIED_USAGE, thinking, toolCall, usage } from "./fixtures";

const MODEL: Attribution = { api: "openai-responses", provider: "litellm", model: "glm-test" };

function rowOf(b: BranchBuilder, id: string): Row {
	const row = buildRows(b.entries).find(candidate => candidate.entry.id === id);
	if (!row) throw new Error(`no row ${id}`);
	return row;
}

function plan(b: BranchBuilder, draft: Draft, overrides: Partial<PlanInput> = {}): Plan {
	const result = buildPlan({
		branch: b.entries,
		labelOf: b.labelOf,
		draft,
		keepTail: true,
		attribution: MODEL,
		now: 0,
		...overrides,
	});
	if (!result.ok) throw new Error(result.reason);
	return result.plan;
}

function refusal(b: BranchBuilder, draft: Draft, overrides: Partial<PlanInput> = {}): string {
	const result = buildPlan({ branch: b.entries, labelOf: b.labelOf, draft, keepTail: true, attribution: MODEL, now: 0, ...overrides });
	if (result.ok) throw new Error("expected a refusal");
	return result.reason;
}

const sources = (p: Plan) => p.steps.map(step => ("source" in step ? step.source : undefined));
const labels = (p: Plan) =>
	p.steps.flatMap(step => (step.op === "label" ? [[sources(p)[step.target] ?? `step${step.target}`, step.label]] : []));

function messageOf(p: Plan, source: string): AgentMessage {
	const step = p.steps.find(candidate => candidate.op === "message" && candidate.source === source);
	if (step?.op !== "message") throw new Error(`no message copy of ${source}`);
	return step.message;
}

function sourceMessage(b: BranchBuilder, id: string): AgentMessage {
	const entry = b.entries.find(candidate => candidate.id === id);
	if (entry?.type !== "message") throw new Error(`no message ${id}`);
	return entry.message;
}

describe("edits", () => {
	test("user text as a string", () => {
		const b = basicBranch();
		const draft = new Draft();
		draft.setText(rowOf(b, "e7"), -1, "what is 17+26?");
		const copy = messageOf(plan(b, draft), "e7");
		expect(copy.role === "user" && copy.content).toBe("what is 17+26?");
	});

	test("user text blocks; images stay", () => {
		const b = new BranchBuilder();
		const image = { type: "image" as const, data: "AAAA", mimeType: "image/png" };
		b.user([{ type: "text", text: "first" }, image, { type: "text", text: "second" }]);
		const draft = new Draft();
		draft.setText(rowOf(b, "e1"), 2, "SECOND");
		const copy = messageOf(plan(b, draft), "e1");
		expect(copy.role === "user" && copy.content).toEqual([{ type: "text", text: "first" }, image, { type: "text", text: "SECOND" }]);
	});

	test("assistant text next to signed thinking: only the edited block loses its signature, payload goes", () => {
		const b = new BranchBuilder();
		b.user("q");
		b.assistant(
			[
				thinking("reasoning", "sig-think"),
				{ type: "text", text: "one", textSignature: "ts-one" },
				{ type: "text", text: "two", textSignature: "ts-two" },
			],
			{ providerPayload: { type: "openaiResponsesHistory", provider: "openai", items: [] } as never },
		);
		const draft = new Draft();
		draft.setText(rowOf(b, "e2"), 2, "TWO");
		const copy = messageOf(plan(b, draft), "e2");
		if (copy.role !== "assistant") throw new Error("not assistant");
		expect(copy.content).toEqual([
			{ type: "thinking", thinking: "reasoning", thinkingSignature: "sig-think" },
			{ type: "text", text: "one", textSignature: "ts-one" },
			{ type: "text", text: "TWO" },
		]);
		expect("providerPayload" in copy).toBe(false);
	});

	test("an edited user message with a provider payload loses it", () => {
		const b = new BranchBuilder();
		b.message({ role: "user", content: "hi", timestamp: 1, providerPayload: { type: "x" } as never });
		const draft = new Draft();
		draft.setText(rowOf(b, "e1"), -1, "hello");
		expect("providerPayload" in messageOf(plan(b, draft), "e1")).toBe(false);
	});

	test("unchanged messages are copied as they are, except for their billing", () => {
		const b = basicBranch();
		const draft = new Draft();
		draft.setText(rowOf(b, "e2"), -1, "read probe2.txt");
		const p = plan(b, draft);
		const original = sourceMessage(b, "e6");
		const copy = messageOf(p, "e6");
		expect(copy).not.toBe(original);
		expect({ ...copy, usage: undefined }).toEqual({ ...original, usage: undefined });
		expect(copy.role === "assistant" && copy.usage).toStrictEqual(COPIED_USAGE);
		expect(original.role === "assistant" && original.usage).toStrictEqual(usage(0.01));
	});

	test("task results keep tokens but lose cost, credits and premium requests", () => {
		const b = new BranchBuilder();
		b.user("q");
		b.assistant([toolCall("t", "task")]);
		b.toolResult("t", "task", "done", { usage: usage(1) });
		const draft = new Draft();
		draft.setText(rowOf(b, "e1"), -1, "Q");
		const copy = messageOf(plan(b, draft), "e3");
		expect(copy.role === "toolResult" && copy.details).toStrictEqual({ usage: COPIED_USAGE });
	});

	test("custom message content", () => {
		const b = new BranchBuilder();
		b.user("q");
		b.customMessage("irc:incoming", [{ type: "text", text: "old note" }], { from: "peer", message: "old note" });
		const draft = new Draft();
		draft.setText(rowOf(b, "e2"), 0, "new note");
		const step = plan(b, draft).steps.find(candidate => candidate.op === "custom_message");
		expect(step).toMatchObject({
			op: "custom_message",
			customType: "irc:incoming",
			content: [{ type: "text", text: "new note" }],
			details: { from: "peer", message: "old note" },
			display: true,
			source: "e2",
		});
	});
});

describe("deletes", () => {
	test("deleting a tool unit removes the call, marker and result and nothing else", () => {
		const b = basicBranch();
		const draft = new Draft();
		draft.delete("e3");
		const p = plan(b, draft);
		expect(p.forkParentId).toBe("e2");
		expect(sources(p)).toEqual(["e6", "e7", "e8", undefined]);
	});

	test("deletion only: the first copy after the deleted unit gets the label", () => {
		const b = basicBranch();
		const draft = new Draft();
		draft.delete("e3");
		expect(labels(plan(b, draft))).toEqual([["e6", "edited"]]);
	});

	test("deleting the last message and cutting leaves nothing to save", () => {
		const b = basicBranch();
		const draft = new Draft();
		draft.delete("e8");
		expect(refusal(b, draft, { keepTail: false })).toContain("use /tree");
		expect(refusal(b, draft, { keepTail: true })).toContain("use /tree");
	});
});

describe("inserts", () => {
	test("user and assistant inserts: shape, attribution, timestamps between neighbours", () => {
		const b = basicBranch();
		const draft = new Draft();
		draft.addInsert("e7", "assistant", "Noted: TEAL.");
		draft.addInsert("e7", "user", "PS", draft.inserts[0].id);
		const p = plan(b, draft);
		expect(p.forkParentId).toBe("e7");
		const [assistant, user] = p.steps;
		const before = sourceMessage(b, "e7").timestamp;
		const after = sourceMessage(b, "e8").timestamp;
		expect(assistant).toEqual({
			op: "message",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "Noted: TEAL." }],
				api: "openai-responses",
				provider: "litellm",
				model: "glm-test",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: "stop",
				timestamp: before + 1,
			},
		});
		expect(user).toEqual({
			op: "message",
			message: { role: "user", content: [{ type: "text", text: "PS" }], attribution: "user", timestamp: before + 2 },
		});
		expect(before + 2).toBeLessThan(after);
		expect(sources(p)).toEqual([undefined, undefined, "e8", undefined, undefined]);
		expect(labels(p)).toEqual([
			["step0", "edited"],
			["step1", "edited"],
		]);
	});

	test("an insert after an assistant with tool calls goes after its last result", () => {
		const b = basicBranch();
		const draft = new Draft();
		draft.addInsert("e3", "user", "between");
		const p = plan(b, draft, { keepTail: false });
		expect(p.forkParentId).toBe("e5");
		expect(sources(p)).toEqual([undefined, undefined]);
	});

	test("inserts at the fork point come before the copies", () => {
		const b = basicBranch();
		const draft = new Draft();
		draft.addInsert("e6", "user", "inserted");
		draft.setText(rowOf(b, "e8"), 0, "forty-two");
		const p = plan(b, draft);
		expect(p.forkParentId).toBe("e6");
		expect(sources(p).slice(0, 3)).toEqual([undefined, "e7", "e8"]);
	});

	test("an assistant insert needs the current model", () => {
		const b = basicBranch();
		const draft = new Draft();
		draft.addInsert("e8", "assistant", "x");
		expect(refusal(b, draft, { attribution: undefined })).toContain("current model");
	});
});

describe("region and steps", () => {
	test("keep-tail copies everything after the first change; cut stops at the last change", () => {
		const b = basicBranch();
		const draft = new Draft();
		draft.setText(rowOf(b, "e6"), 1, "KIWI-7");
		const keep = plan(b, draft, { keepTail: true });
		const cut = plan(b, draft, { keepTail: false });
		expect(keep.forkParentId).toBe("e5");
		expect(sources(keep)).toEqual(["e6", "e7", "e8", undefined]);
		expect(keep.tail).toBe(2);
		expect(sources(cut)).toEqual(["e6", undefined]);
		expect(cut.copied).toBe(1);
	});

	test("a change on the first entry starts a new root", () => {
		const b = new BranchBuilder();
		b.user("only");
		const draft = new Draft();
		draft.setText(rowOf(b, "e1"), -1, "changed");
		expect(plan(b, draft).forkParentId).toBeNull();
	});

	test("every copyable entry type becomes its appender step; labels move, other records stay behind", () => {
		const b = new BranchBuilder();
		b.user("q");
		b.add({ type: "thinking_level_change", thinkingLevel: "high", configured: "auto" });
		b.add({ type: "model_change", model: "litellm/x", role: "default", resolvedModelIsFallback: true });
		b.add({ type: "service_tier_change", serviceTier: { openai: "priority" } as never });
		b.add({ type: "mode_change", mode: "plan", data: { file: "p.md" } });
		b.add({ type: "ttsr_injection", injectedRules: ["r1"] });
		b.add({ type: "credential_pin", provider: "anthropic", hash: "h" });
		b.add({ type: "branch_summary", fromId: "e1", summary: "explored", details: { a: 1 }, fromExtension: false });
		b.add({ type: "session_init", systemPrompt: "joined prompt", task: "t", tools: ["read"] });
		b.custom("todo_hud_state", { n: 1 });
		b.custom("session_exit", { reason: "quit" });
		b.add({ type: "title_change", title: "T", source: "auto" });
		b.add({
			type: "model_usage",
			purpose: "title",
			api: "anthropic-messages",
			provider: "litellm",
			model: "m",
			usage: usage(1),
			stopReason: "stop",
		});
		const answer = b.text("a");
		b.label(answer.id, "keep-me");
		const draft = new Draft();
		draft.setText(rowOf(b, "e1"), -1, "Q");
		const p = plan(b, draft);
		const ops = p.steps.map(step => step.op);
		expect(ops).toEqual([
			"message",
			"thinking_level_change",
			"model_change",
			"service_tier_change",
			"mode_change",
			"ttsr_injection",
			"credential_pin",
			"branch_summary",
			"session_init",
			"custom",
			"message",
			"label",
			"label",
		]);
		const byOp = (op: Step["op"]) => p.steps.find(step => step.op === op);
		expect(byOp("thinking_level_change")).toMatchObject({ thinkingLevel: "high", configured: "auto" });
		expect(byOp("model_change")).toMatchObject({ model: "litellm/x", role: "default", resolvedModelIsFallback: true });
		expect(byOp("mode_change")).toMatchObject({ mode: "plan", data: { file: "p.md" } });
		expect(byOp("branch_summary")).toMatchObject({ summary: "explored", details: { a: 1 }, fromExtension: false });
		expect(byOp("session_init")).toMatchObject({ init: { systemPrompt: ["joined prompt"], task: "t", tools: ["read"] } });
		expect(byOp("custom")).toMatchObject({ customType: "todo_hud_state", data: { n: 1 } });
		expect(labels(p)).toEqual([
			["e1", "edited"],
			[answer.id, "keep-me"],
		]);
	});

	test("an edited copy that already has a label keeps it and gets no edited label", () => {
		const b = basicBranch();
		b.label("e8", "answer");
		const draft = new Draft();
		draft.setText(rowOf(b, "e8"), 0, "43");
		expect(labels(plan(b, draft))).toEqual([["e8", "answer"]]);
	});

	test("the last step is always a label", () => {
		const b = basicBranch();
		for (const change of [
			(d: Draft) => d.setText(rowOf(b, "e2"), -1, "x"),
			(d: Draft) => {
				d.delete("e3");
				d.delete("e7");
			},
			(d: Draft) => d.addInsert("e8", "user", "more"),
		]) {
			const draft = new Draft();
			change(draft);
			for (const keepTail of [true, false]) {
				const steps = plan(b, draft, { keepTail }).steps;
				expect(steps.at(-1)?.op).toBe("label");
			}
		}
	});

	test("an unknown entry type in the copied region is refused without steps", () => {
		const b = basicBranch();
		b.add({ type: "mystery" } as never);
		b.user("after");
		const draft = new Draft();
		draft.setText(rowOf(b, "e7"), -1, "x");
		expect(refusal(b, draft, { keepTail: true })).toContain('type "mystery"');
		expect(sources(plan(b, draft, { keepTail: false }))).toEqual(["e7", undefined]);
	});

	test("nothing staged is refused", () => {
		expect(refusal(basicBranch(), new Draft())).toBe("Nothing is staged.");
	});
});
