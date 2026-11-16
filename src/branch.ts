import type { CustomMessageEntry, SessionEntry, SessionMessageEntry } from "@oh-my-pi/pi-coding-agent";

export type AgentMessage = SessionMessageEntry["message"];
export type AssistantMessage = Extract<AgentMessage, { role: "assistant" }>;
export type UserMessage = Extract<AgentMessage, { role: "user" }>;
export type RowEntry = SessionMessageEntry | CustomMessageEntry;

// omp custom types whose context handling (session-context.ts, messages.ts, exit-diagnostics.ts) this module mirrors.
export const TOOL_EXECUTION_START = "tool_execution_start";
const INTERRUPTED_THINKING = "interrupted-thinking";
const CONTEXT_HIDDEN_CUSTOM_TYPES: Record<string, true> = { "prewalk-plan": true, "vibe-mode-context": true };

const PREVIEW_CHARS = 100;

/** One editable text piece of a message: `block` is the content index, or -1 when the content is a plain string. */
export interface TextSlot {
	block: number;
	text: string;
}

/** A message the editor lists: a user or assistant message, or a custom message the model sees. */
export interface Row {
	entry: RowEntry;
	/** Position on the branch (root first). */
	index: number;
	role: "user" | "assistant" | "custom";
	customType?: string;
	slots: TextSlot[];
	images: number;
	/** Set when omp never sends this turn to the model (`buildSessionContext` drops it). */
	notSent?: "aborted" | "error";
	toolNames: string[];
	/** Branch positions removed by deleting this row: the message, its tool results and execution markers. */
	unit: number[];
	resultCount: number;
	/** Branch position after which an insert "after this row" goes. */
	anchorIndex: number;
}

/** First branch position after the latest compaction or `/clear` boundary. */
export function visibleStart(branch: readonly SessionEntry[]): number {
	for (let index = branch.length - 1; index >= 0; index--) {
		const type = branch[index].type;
		if (type === "compaction" || type === "reset_boundary") return index + 1;
	}
	return 0;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function textSlots(content: unknown): TextSlot[] {
	if (typeof content === "string") return [{ block: -1, text: content }];
	if (!Array.isArray(content)) return [];
	const slots: TextSlot[] = [];
	content.forEach((block: unknown, index) => {
		if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
			slots.push({ block: index, text: block.text });
		}
	});
	return slots;
}

function imageCount(content: unknown): number {
	if (!Array.isArray(content)) return 0;
	return content.filter((block: unknown) => isRecord(block) && block.type === "image").length;
}

/** Mirrors omp `isEmptyErrorTurn`: an error turn with no output that omp never replays. */
function isEmptyErrorTurn(message: AssistantMessage): boolean {
	if (message.stopReason !== "error") return false;
	return !message.content.some(block => {
		switch (block.type) {
			case "text":
				return block.text.trim().length > 0;
			case "thinking":
				return block.thinking.trim().length > 0 || (block.thinkingSignature?.trim().length ?? 0) > 0;
			case "redactedThinking":
				return block.data.trim().length > 0;
			case "fallback":
				return false;
			default:
				return true;
		}
	});
}

function isModelVisibleCustomMessage(entry: CustomMessageEntry): boolean {
	const content: unknown = entry.content;
	return (typeof content === "string" || Array.isArray(content)) && CONTEXT_HIDDEN_CUSTOM_TYPES[entry.customType] !== true;
}

/** Whether `entry` becomes a message of the model context, before the aborted/error filter. */
function producesContextMessage(entry: SessionEntry): boolean {
	if (entry.type === "message") {
		const message = entry.message;
		return !(message.role === "assistant" && (message.retryRecovery || isEmptyErrorTurn(message)));
	}
	if (entry.type === "custom_message") return isModelVisibleCustomMessage(entry);
	return entry.type === "branch_summary" && entry.summary.length > 0;
}

function notSentReason(branch: readonly SessionEntry[], index: number, message: AssistantMessage): Row["notSent"] {
	if (message.retryRecovery || isEmptyErrorTurn(message)) return message.stopReason === "aborted" ? "aborted" : "error";
	if (message.stopReason !== "aborted" && message.stopReason !== "error") return undefined;
	for (let next = index + 1; next < branch.length; next++) {
		const entry = branch[next];
		if (!producesContextMessage(entry)) continue;
		// omp keeps an interrupted turn followed by its continuity note (session-context.ts).
		if (entry.type === "custom_message" && entry.customType === INTERRUPTED_THINKING) return undefined;
		break;
	}
	return message.stopReason;
}

function toolCallIds(message: AssistantMessage): Set<string> {
	const ids = new Set<string>();
	for (const block of message.content) if (block.type === "toolCall") ids.add(block.id);
	return ids;
}

function unitMemberKind(entry: SessionEntry, callIds: ReadonlySet<string>): "result" | "marker" | undefined {
	if (entry.type === "message" && entry.message.role === "toolResult") {
		return callIds.has(entry.message.toolCallId) ? "result" : undefined;
	}
	if (entry.type === "custom" && entry.customType === TOOL_EXECUTION_START) {
		const data = entry.data;
		return isRecord(data) && typeof data.toolCallId === "string" && callIds.has(data.toolCallId) ? "marker" : undefined;
	}
	return undefined;
}

function rowFor(branch: readonly SessionEntry[], start: number, index: number): Row | undefined {
	const entry = branch[index];
	if (entry.type === "custom_message") {
		if (!isModelVisibleCustomMessage(entry)) return undefined;
		return {
			entry,
			index,
			role: "custom",
			customType: entry.customType,
			slots: textSlots(entry.content),
			images: imageCount(entry.content),
			toolNames: [],
			unit: [index],
			resultCount: 0,
			anchorIndex: index,
		};
	}
	if (entry.type !== "message") return undefined;
	const message = entry.message;
	if (message.role === "user") {
		return {
			entry,
			index,
			role: "user",
			slots: textSlots(message.content),
			images: imageCount(message.content),
			toolNames: [],
			unit: [index],
			resultCount: 0,
			anchorIndex: index,
		};
	}
	if (message.role !== "assistant") return undefined;
	const callIds = toolCallIds(message);
	const unit = [index];
	let resultCount = 0;
	if (callIds.size > 0) {
		for (let other = start; other < branch.length; other++) {
			if (other === index) continue;
			const kind = unitMemberKind(branch[other], callIds);
			if (!kind) continue;
			unit.push(other);
			if (kind === "result") resultCount++;
		}
		unit.sort((a, b) => a - b);
	}
	return {
		entry,
		index,
		role: "assistant",
		slots: textSlots(message.content),
		images: imageCount(message.content),
		notSent: notSentReason(branch, index, message),
		toolNames: message.content.flatMap(block => (block.type === "toolCall" ? [block.name] : [])),
		unit,
		resultCount,
		anchorIndex: unit[unit.length - 1],
	};
}

/** Rows after the visible boundary, oldest first. */
export function buildRows(branch: readonly SessionEntry[]): Row[] {
	const start = visibleStart(branch);
	const rows: Row[] = [];
	for (let index = start; index < branch.length; index++) {
		const row = rowFor(branch, start, index);
		if (row) rows.push(row);
	}
	// An insert inside a tool call/result span would split the pair, so it moves past the span.
	for (const row of rows) {
		for (const other of rows) {
			const end = other.unit[other.unit.length - 1];
			if (other.index < row.index && row.index < end) row.anchorIndex = Math.max(row.anchorIndex, end);
		}
	}
	return rows;
}

export function collapse(text: string, limit = PREVIEW_CHARS): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > limit ? `${flat.slice(0, limit - 3)}...` : flat;
}

/** One-line description of a message's content, given its (possibly edited) text slots. */
export function describeContent(row: Row, slots: readonly TextSlot[]): string {
	const parts: string[] = [];
	const text = slots.map(slot => slot.text).join(" ");
	if (text.trim().length > 0) parts.push(collapse(text));
	if (row.images > 0) parts.push(`[${row.images} image${row.images === 1 ? "" : "s"}]`);
	if (row.toolNames.length > 0) {
		const results = row.resultCount > 0 ? ` (+${row.resultCount} result${row.resultCount === 1 ? "" : "s"})` : "";
		parts.push(`tools: ${row.toolNames.join(", ")}${results}`);
	}
	if (parts.length === 0) return row.role === "assistant" ? "(thinking only)" : "(empty)";
	return parts.join(" ");
}

export function roleName(row: Pick<Row, "role" | "customType">): string {
	return row.role === "custom" ? `custom ${row.customType}` : row.role;
}
