import type { SessionEntry, SessionManager } from "@oh-my-pi/pi-coding-agent";
import type { AgentMessage, AssistantMessage } from "../src/branch";

type Replayable = Pick<SessionManager, "appendModelChange" | "appendMessage" | "appendCustomEntry" | "appendCustomMessageEntry">;

/** Writes fixture entries into a real SessionManager through its appenders; returns the new ids in order. */
export function replay(sm: Replayable, entries: readonly SessionEntry[]): string[] {
	return entries.map(entry => {
		switch (entry.type) {
			case "model_change":
				return sm.appendModelChange(entry.model, entry.role);
			case "message":
				if (entry.message.role === "compactionSummary" || entry.message.role === "branchSummary") break;
				return sm.appendMessage(structuredClone(entry.message));
			case "custom":
				return sm.appendCustomEntry(entry.customType, structuredClone(entry.data));
			case "custom_message":
				return sm.appendCustomMessageEntry(entry.customType, structuredClone(entry.content), entry.display, structuredClone(entry.details), entry.attribution);
		}
		throw new Error(`replay does not support ${entry.type}`);
	});
}

type AssistantBlock = AssistantMessage["content"][number];
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type EntryFields = DistributiveOmit<SessionEntry, "id" | "parentId" | "timestamp">;

const START = Date.parse("2026-01-01T00:00:00.000Z");
const STEP_MS = 1000;

const TOKENS = { input: 100, output: 20, cacheRead: 50, cacheWrite: 10, totalTokens: 180 };
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

/** Usage with token counts and billing: cost, premium requests and credits. */
export function usage(cost: number) {
	return {
		...TOKENS,
		cost: { input: cost, output: cost, cacheRead: cost, cacheWrite: cost, total: cost * 4 },
		premiumRequests: 1,
		credits: { cost, committedCost: cost },
	};
}

/** What a copy keeps of {@link usage}: the token counts, with no billing. */
export const COPIED_USAGE = { ...TOKENS, cost: ZERO_COST };

/** Builds a linear branch of entries shaped like the ones omp writes; ids are e1, e2, ... in order. */
export class BranchBuilder {
	readonly entries: SessionEntry[] = [];

	get time(): number {
		return START + this.entries.length * STEP_MS;
	}

	add(fields: EntryFields): SessionEntry {
		const entry = {
			...fields,
			id: `e${this.entries.length + 1}`,
			parentId: this.entries.at(-1)?.id ?? null,
			timestamp: new Date(this.time).toISOString(),
		} as SessionEntry;
		this.entries.push(entry);
		return entry;
	}

	message(message: AgentMessage): SessionEntry {
		return this.add({ type: "message", message });
	}

	user(content: string | Extract<AgentMessage, { role: "user" }>["content"]): SessionEntry {
		return this.message({ role: "user", content, timestamp: this.time });
	}

	assistant(content: AssistantBlock[], extra: Partial<AssistantMessage> = {}): SessionEntry {
		return this.message({
			role: "assistant",
			content,
			api: "anthropic-messages",
			provider: "litellm",
			model: "claude-test",
			usage: usage(0.01),
			stopReason: content.some(block => block.type === "toolCall") ? "toolUse" : "stop",
			timestamp: this.time,
			...extra,
		});
	}

	text(text: string, extra: Partial<AssistantMessage> = {}): SessionEntry {
		return this.assistant([{ type: "text", text }], extra);
	}

	toolResult(toolCallId: string, toolName: string, text: string, details?: unknown): SessionEntry {
		return this.message({
			role: "toolResult",
			toolCallId,
			toolName,
			content: [{ type: "text", text }],
			details,
			isError: false,
			timestamp: this.time,
		});
	}

	marker(toolCallId: string, toolName: string): SessionEntry {
		return this.add({ type: "custom", customType: "tool_execution_start", data: { toolCallId, toolName } });
	}

	custom(customType: string, data?: unknown): SessionEntry {
		return this.add({ type: "custom", customType, data });
	}

	customMessage(customType: string, content: string | { type: "text"; text: string }[], details?: unknown, display = true): SessionEntry {
		return this.add({ type: "custom_message", customType, content, details, display, attribution: "agent" });
	}

	compaction(firstKeptEntryId: string): SessionEntry {
		return this.add({ type: "compaction", summary: "summary of earlier work", firstKeptEntryId, tokensBefore: 5000 });
	}

	resetBoundary(): SessionEntry {
		return this.add({ type: "reset_boundary" });
	}

	label(targetId: string, label: string): SessionEntry {
		return this.add({ type: "label", targetId, label });
	}

	/** Labels as `SessionManager.getLabel` resolves them for this branch. */
	labelOf = (entryId: string): string | undefined => {
		let found: string | undefined;
		for (const entry of this.entries) if (entry.type === "label" && entry.targetId === entryId) found = entry.label;
		return found;
	};
}

export function toolCall(id: string, name: string, args: Record<string, unknown> = {}): AssistantBlock {
	return { type: "toolCall", id, name, arguments: args };
}

export function thinking(text: string, signature?: string): AssistantBlock {
	return { type: "thinking", thinking: text, thinkingSignature: signature };
}

/** user -> assistant(read) -> result -> assistant answer -> user -> assistant answer */
export function basicBranch(): BranchBuilder {
	const b = new BranchBuilder();
	b.add({ type: "model_change", model: "litellm/claude-test" });
	b.user("read probe1.txt");
	b.assistant([thinking("plan", "sig-1"), toolCall("call-1", "read", { path: "probe1.txt" })]);
	b.marker("call-1", "read");
	b.toolResult("call-1", "read", "MANGO-3");
	b.assistant([thinking("done", "sig-2"), { type: "text", text: "The codeword is MANGO-3.", textSignature: "ts-1" }]);
	b.user("what is 17+25?");
	b.text("42");
	return b;
}
