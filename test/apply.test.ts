import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { applyPlan, missingMethods, type NavigateTree, type WritableSessionManager } from "../src/apply";
import { type AgentMessage, buildRows, type Row } from "../src/branch";
import { Draft } from "../src/draft";
import { buildPlan, type Plan } from "../src/plan";
import { basicBranch, replay } from "./fixtures";

const MODEL = { api: "anthropic-messages", provider: "litellm", model: "claude-test" } as const;

/** Records every write and keeps leaf semantics like SessionManager: appends become the leaf. */
class RecordingSessionManager {
	readonly calls: unknown[][] = [];
	leaf: string | null;
	failOnAppend = 0;
	#appends = 0;

	constructor(leaf: string) {
		this.leaf = leaf;
	}

	#append(name: string, args: unknown[]): string {
		this.#appends++;
		if (this.#appends === this.failOnAppend) throw new Error("disk full");
		this.calls.push([name, ...args]);
		this.leaf = `n${this.#appends}`;
		return this.leaf;
	}

	getLeafId = () => this.leaf;
	getLabel = (_id: string): string | undefined => undefined;
	branch = (id: string) => {
		this.calls.push(["branch", id]);
		this.leaf = id;
	};
	resetLeaf = () => {
		this.calls.push(["resetLeaf"]);
		this.leaf = null;
	};
	flush = async () => {
		this.calls.push(["flush"]);
	};
	appendMessage = (message: AgentMessage) => this.#append("appendMessage", [message.role]);
	appendLabelChange = (target: string, label: string | undefined) => this.#append("appendLabelChange", [target, label]);
}

function writable(fake: RecordingSessionManager): WritableSessionManager {
	// The fake implements only what these plans call; a missing method would throw in the test.
	const sm = fake as unknown as WritableSessionManager;
	return sm;
}

function planFor(
	branch: readonly SessionEntry[],
	labelOf: (id: string) => string | undefined,
	draftOf: (rows: readonly Row[]) => Draft,
	keepTail = true,
): Plan {
	const draft = draftOf(buildRows(branch));
	const result = buildPlan({ branch, labelOf, draft, keepTail, attribution: MODEL, now: 0 });
	if (!result.ok) throw new Error(result.reason);
	return result.plan;
}

function editAnswer(rows: readonly Row[]): Draft {
	const draft = new Draft();
	draft.setText(rows[2], 1, "The codeword is KIWI-7.");
	return draft;
}

describe("applyPlan with a recording session manager", () => {
	const b = basicBranch();
	const plan = planFor(b.entries, b.labelOf, editAnswer);

	test("forks, appends, labels, restores the leaf, flushes, then switches to the new leaf", async () => {
		const fake = new RecordingSessionManager("e8");
		const navigate: NavigateTree = async (target, options) => {
			fake.calls.push(["navigateTree", fake.leaf, target, options]);
			fake.leaf = target;
			return { cancelled: false };
		};
		const result = await applyPlan(writable(fake), navigate, plan);
		expect(fake.calls).toEqual([
			["branch", "e5"],
			["appendMessage", "assistant"],
			["appendMessage", "user"],
			["appendMessage", "assistant"],
			["appendLabelChange", "n1", "edited"],
			["branch", "e8"],
			["flush"],
			["navigateTree", "e8", "n4", { summarize: false }],
		]);
		expect(result).toEqual({ status: "switched", newLeaf: "n4" });
	});

	test("a cancelled switch pins the old leaf so a restart stays on the old branch", async () => {
		const fake = new RecordingSessionManager("e8");
		const result = await applyPlan(writable(fake), async () => ({ cancelled: true }), plan);
		expect(fake.calls.slice(-3)).toEqual([["flush"], ["appendLabelChange", "e8", undefined], ["flush"]]);
		expect(result).toEqual({ status: "cancelled", newLeaf: "n4" });
	});

	test("a switch that lands elsewhere is reported", async () => {
		const fake = new RecordingSessionManager("e8");
		const result = await applyPlan(writable(fake), async () => ({ cancelled: false }), plan);
		expect(result).toEqual({ status: "diverged", newLeaf: "n4", leaf: "e8" });
	});

	test("a failing append restores and pins the old leaf and names the step", async () => {
		const fake = new RecordingSessionManager("e8");
		fake.failOnAppend = 2;
		let navigated = false;
		const error = await applyPlan(writable(fake), async () => {
			navigated = true;
			return { cancelled: false };
		}, plan).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toBe("Writing step 2 of 4 (copy of entry e7) failed");
		expect(((error as Error).cause as Error).message).toBe("disk full");
		expect(fake.calls).toEqual([
			["branch", "e5"],
			["appendMessage", "assistant"],
			["branch", "e8"],
			["appendLabelChange", "e8", undefined],
		]);
		expect(navigated).toBe(false);
	});

	test("missing internals are listed by name", () => {
		const sessionManager = { getBranch() {} };
		const ctx = { sessionManager, navigateTree: undefined } as never;
		const missing = missingMethods(ctx);
		expect(missing).toContain("sessionManager.appendLabelChange");
		expect(missing).toContain("ctx.navigateTree");
		expect(missing).not.toContain("sessionManager.getBranch");
	});
});

function texts(messages: readonly AgentMessage[]): string[] {
	return messages.map(message => {
		if (!("content" in message)) return message.role;
		const content = message.content;
		const text =
			typeof content === "string"
				? content
				: content.flatMap(block => (block.type === "text" ? [block.text] : block.type === "toolCall" ? [`call:${block.name}`] : [])).join("|");
		return `${message.role}:${text}`;
	});
}

/** Switches like omp's navigateTree does for a label target: the leaf moves to the target. */
function navigateLike(sm: SessionManager, seen: { leafBefore?: string | null; targetType?: string }): NavigateTree {
	return async target => {
		seen.leafBefore = sm.getLeafId();
		seen.targetType = sm.getEntry(target)?.type;
		sm.branch(target);
		return { cancelled: false };
	};
}

describe("integration with the real SessionManager", () => {
	const dirs: string[] = [];
	afterAll(() => {
		for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
	});

	function mixedDraft(rows: readonly Row[]): Draft {
		const draft = new Draft();
		draft.setText(rows[0], -1, "read probe1.txt\nPS: my favourite planet is Neptune.");
		draft.delete(rows[1].entry.id);
		draft.setText(rows[2], 1, "The codeword is KIWI-7.");
		draft.addInsert(rows[4].entry.id, "assistant", "Noted for later: the secret color is TEAL.");
		return draft;
	}

	test("the new branch carries the edits; the old branch, usage totals and leaf semantics hold", async () => {
		const sm = SessionManager.inMemory(tmpdir());
		const original = replay(sm, basicBranch().entries);
		const oldLeaf = sm.getLeafId();
		const { cost: costBefore, premiumRequests: premiumBefore, input: inputBefore } = sm.getUsageStatistics();
		expect(premiumBefore).toBeGreaterThan(0);
		const branch = sm.getBranch();
		const plan = planFor(branch, id => sm.getLabel(id), mixedDraft);
		const seen: { leafBefore?: string | null; targetType?: string } = {};

		const result = await applyPlan(sm, navigateLike(sm, seen), plan);

		expect(result.status).toBe("switched");
		expect(seen).toEqual({ leafBefore: oldLeaf, targetType: "label" });
		expect(texts(sm.buildSessionContext().messages)).toEqual([
			"user:read probe1.txt\nPS: my favourite planet is Neptune.",
			"assistant:The codeword is KIWI-7.",
			"user:what is 17+25?",
			"assistant:42",
			"assistant:Noted for later: the secret color is TEAL.",
		]);
		expect(sm.getBranch(oldLeaf ?? undefined).map(entry => entry.id)).toEqual(original);
		const labelled = sm
			.getBranch()
			.filter(entry => sm.getLabel(entry.id) === "edited")
			.map(entry => (entry.type === "message" ? texts([entry.message])[0] : entry.type));
		expect(labelled).toEqual([
			"user:read probe1.txt\nPS: my favourite planet is Neptune.",
			"assistant:The codeword is KIWI-7.",
			"assistant:Noted for later: the secret color is TEAL.",
		]);
		const after = sm.getUsageStatistics();
		expect(after.cost).toBeCloseTo(costBefore, 10);
		expect(after.premiumRequests).toBe(premiumBefore);
		expect(after.input).toBeGreaterThan(inputBefore);
	});

	async function fileSession() {
		const dir = mkdtempSync(path.join(tmpdir(), "omp-context-editor-session-"));
		dirs.push(dir);
		const sm = SessionManager.create(dir, dir);
		replay(sm, basicBranch().entries);
		await sm.flush();
		const file = sm.getSessionFile();
		if (!file) throw new Error("no session file");
		return { sm, dir, file };
	}

	test("after a restart the session opens on the new branch", async () => {
		const { sm, dir, file } = await fileSession();
		const branch = sm.getBranch();
		const plan = planFor(branch, id => sm.getLabel(id), editAnswer, false);
		const result = await applyPlan(sm, navigateLike(sm, {}), plan);
		await sm.flush();

		const reopened = await SessionManager.open(file, dir, undefined, { suppressBreadcrumb: true });
		expect(reopened.getLeafId()).toBe(result.newLeaf);
		expect(texts(reopened.buildSessionContext().messages)).toEqual([
			"user:read probe1.txt",
			"assistant:call:read",
			"toolResult:MANGO-3",
			"assistant:The codeword is KIWI-7.",
		]);
	});

	test("after a cancelled switch a restart stays on the old branch", async () => {
		const { sm, dir, file } = await fileSession();
		const before = texts(sm.buildSessionContext().messages);
		const branch = sm.getBranch();
		const plan = planFor(branch, id => sm.getLabel(id), editAnswer);
		const result = await applyPlan(sm, async () => ({ cancelled: true }), plan);
		expect(result.status).toBe("cancelled");

		const reopened = await SessionManager.open(file, dir, undefined, { suppressBreadcrumb: true });
		expect(texts(reopened.buildSessionContext().messages)).toEqual(before);
		expect(reopened.getLabel(result.newLeaf)).toBeUndefined();
		const copies = reopened.getEntries().filter(entry => reopened.getLabel(entry.id) === "edited");
		expect(copies.length).toBe(1);
	});
});
