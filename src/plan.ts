import type { CustomMessageEntry, SessionEntry, SessionManager } from "@oh-my-pi/pi-coding-agent";
import { type AgentMessage, type AssistantMessage, buildRows, isRecord, type Row } from "./branch";
import type { Draft, Insert } from "./draft";

export const EDITED_LABEL = "edited";
const SESSION_EXIT = "session_exit";

/** Model the inserted assistant messages are attributed to. */
export interface Attribution {
	api: AssistantMessage["api"];
	provider: AssistantMessage["provider"];
	model: string;
}

type SessionInit = Parameters<SessionManager["appendSessionInit"]>[0];
type ServiceTier = Extract<SessionEntry, { type: "service_tier_change" }>["serviceTier"];
type TextContent = CustomMessageEntry["content"];

/** One append on the new branch; `source` is the copied entry id, absent for inserts. */
export type Step =
	| { op: "message"; message: AgentMessage; source?: string }
	| {
			op: "custom_message";
			customType: string;
			content: TextContent;
			display: boolean;
			details: unknown;
			attribution: CustomMessageEntry["attribution"];
			timestamp: number;
			source: string;
	  }
	| { op: "custom"; customType: string; data: unknown; source: string }
	| { op: "thinking_level_change"; thinkingLevel?: string; configured?: string; source: string }
	| { op: "model_change"; model: string; role?: string; resolvedModelIsFallback: boolean; source: string }
	| { op: "service_tier_change"; serviceTier: ServiceTier; source: string }
	| { op: "mode_change"; mode: string; data?: Record<string, unknown>; source: string }
	| { op: "ttsr_injection"; injectedRules: string[]; source: string }
	| { op: "credential_pin"; provider: string; hash: string; source: string }
	| { op: "branch_summary"; summary: string; details: unknown; fromExtension?: boolean; source: string }
	| { op: "session_init"; init: SessionInit; source: string }
	/** Label on the entry created by step `target`. */
	| { op: "label"; target: number; label: string };

export interface PlanInput {
	branch: readonly SessionEntry[];
	labelOf: (entryId: string) => string | undefined;
	draft: Draft;
	keepTail: boolean;
	/** Required when the draft inserts an assistant message. */
	attribution?: Attribution;
	/** Timestamp base for inserts with no earlier entry on the branch. */
	now: number;
}

export interface Plan {
	/** Entry the new branch grows from; null starts a new root. */
	forkParentId: string | null;
	steps: Step[];
	/** Existing entries copied onto the new branch. */
	copied: number;
	/** Entries after the last change that are carried over when the tail is kept and left out when cut. */
	tail: number;
}

export type PlanResult = { ok: true; plan: Plan } | { ok: false; reason: string };

/** Like omp's own fork reset (`resetUsageCost`): billing goes, token counts stay. */
function zeroCost(usage: unknown): void {
	if (!isRecord(usage) || !isRecord(usage.cost)) return;
	const cost = usage.cost;
	for (const key of Object.keys(cost)) cost[key] = 0;
	delete usage.credits;
	delete usage.premiumRequests;
}

/** Copies must not count their spend again in the session usage totals. */
function zeroMessageCost(message: AgentMessage): void {
	if (message.role === "assistant") zeroCost(message.usage);
	else if (message.role === "toolResult" && message.toolName === "task" && isRecord(message.details)) {
		zeroCost(message.details.usage);
	}
}

function editedContent(content: TextContent, blocks: ReadonlyMap<number, string>): TextContent {
	if (typeof content === "string") {
		const text = blocks.get(-1);
		if (text === undefined || blocks.size !== 1) throw new Error("Text content has a single editable block");
		return text;
	}
	for (const [index, text] of blocks) {
		const block = content[index];
		if (block?.type !== "text") throw new Error(`Content block ${index} is not text`);
		block.text = text;
		delete block.textSignature;
	}
	return content;
}

/** Applies edits to a copied message; a provider payload would replay the original text, so it goes. */
function editMessage(message: AgentMessage, blocks: ReadonlyMap<number, string>): void {
	if (message.role === "user") {
		message.content = editedContent(message.content, blocks);
		delete message.providerPayload;
		return;
	}
	if (message.role !== "assistant") throw new Error(`A ${message.role} message cannot be edited`);
	for (const [index, text] of blocks) {
		const block = message.content[index];
		if (block?.type !== "text") throw new Error(`Content block ${index} is not text`);
		block.text = text;
		delete block.textSignature;
	}
	delete message.providerPayload;
}

function messageTimestamp(entry: SessionEntry): number | undefined {
	if (entry.type === "message") return entry.message.timestamp;
	if (entry.type === "custom_message") return Date.parse(entry.timestamp);
	return undefined;
}

function insertMessage(insert: Insert, timestamp: number, attribution: Attribution | undefined): AgentMessage {
	if (insert.role === "user") {
		return { role: "user", content: [{ type: "text", text: insert.text }], attribution: "user", timestamp };
	}
	if (!attribution) throw new Error("An inserted assistant message needs the current model");
	return {
		role: "assistant",
		content: [{ type: "text", text: insert.text }],
		api: attribution.api,
		provider: attribution.provider,
		model: attribution.model,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp,
	};
}

/** Labels move with their targets; title, usage and process-exit records describe the old branch. */
function carriedOver(entry: SessionEntry): boolean {
	if (entry.type === "custom") return entry.customType !== SESSION_EXIT;
	return entry.type !== "label" && entry.type !== "title_change" && entry.type !== "model_usage";
}

/** Copy of `entry` as a step, `null` when the entry is not carried over, or a refusal reason. */
function copyStep(entry: SessionEntry, blocks: ReadonlyMap<number, string> | undefined): Step | null | string {
	if (!carriedOver(entry)) return null;
	const source = entry.id;
	const type: string = entry.type;
	switch (entry.type) {
		case "message": {
			const message = structuredClone(entry.message);
			if (blocks) editMessage(message, blocks);
			zeroMessageCost(message);
			return { op: "message", message, source };
		}
		case "custom_message": {
			const content = structuredClone(entry.content);
			return {
				op: "custom_message",
				customType: entry.customType,
				content: blocks ? editedContent(content, blocks) : content,
				display: entry.display,
				details: structuredClone(entry.details),
				attribution: entry.attribution,
				timestamp: Date.parse(entry.timestamp),
				source,
			};
		}
		case "custom":
			return { op: "custom", customType: entry.customType, data: structuredClone(entry.data), source };
		case "thinking_level_change":
			return {
				op: "thinking_level_change",
				thinkingLevel: entry.thinkingLevel ?? undefined,
				configured: entry.configured ?? undefined,
				source,
			};
		case "model_change":
			return {
				op: "model_change",
				model: entry.model,
				role: entry.role,
				resolvedModelIsFallback: entry.resolvedModelIsFallback ?? false,
				source,
			};
		case "service_tier_change":
			return { op: "service_tier_change", serviceTier: structuredClone(entry.serviceTier), source };
		case "mode_change":
			return { op: "mode_change", mode: entry.mode, data: structuredClone(entry.data), source };
		case "ttsr_injection":
			return { op: "ttsr_injection", injectedRules: [...entry.injectedRules], source };
		case "credential_pin":
			return { op: "credential_pin", provider: entry.provider, hash: entry.hash, source };
		case "branch_summary":
			return {
				op: "branch_summary",
				summary: entry.summary,
				details: structuredClone(entry.details),
				fromExtension: entry.fromExtension,
				source,
			};
		case "session_init": {
			const {
				type: _type,
				id: _id,
				parentId: _parentId,
				timestamp: _timestamp,
				runtime: _runtime,
				activeLeafId: _activeLeafId,
				...init
			} = entry;
			// Older files store the system prompt as one joined string.
			const systemPrompt = typeof init.systemPrompt === "string" ? [init.systemPrompt] : init.systemPrompt;
			return { op: "session_init", init: structuredClone({ ...init, systemPrompt }), source };
		}
		default:
			return `entry ${source} has type "${type}", which cannot be copied`;
	}
}

/** Positions spanned by the draft's changes on the branch, or undefined when nothing is staged. */
function changeSpan(rows: readonly Row[], draft: Draft): { first: number; last: number } | undefined {
	let first = Number.POSITIVE_INFINITY;
	let last = Number.NEGATIVE_INFINITY;
	for (const row of rows) {
		const id = row.entry.id;
		if (draft.edits.has(id)) {
			first = Math.min(first, row.index);
			last = Math.max(last, row.index);
		}
		if (draft.deletes.has(id)) {
			first = Math.min(first, row.unit[0]);
			last = Math.max(last, row.unit[row.unit.length - 1]);
		}
		if (draft.insertsAfter(id).length > 0) {
			first = Math.min(first, row.anchorIndex + 1);
			last = Math.max(last, row.anchorIndex);
		}
	}
	return Number.isFinite(first) ? { first, last } : undefined;
}

/**
 * Steps that write the draft as a new branch: copies of the changed region (and of the tail when kept),
 * with edits applied, deleted units left out, inserts placed, and labels last so the new leaf is a label.
 */
export function buildPlan(input: PlanInput): PlanResult {
	const { branch, draft } = input;
	const rows = buildRows(branch);
	const span = changeSpan(rows, draft);
	if (!span) return { ok: false, reason: "Nothing is staged." };
	if (input.attribution === undefined && draft.inserts.some(insert => insert.role === "assistant")) {
		return { ok: false, reason: "No current model to attribute the inserted assistant message to." };
	}
	const end = input.keepTail ? branch.length - 1 : span.last;

	const deleted = new Set<number>();
	const insertsAt = new Map<number, Insert[]>();
	const editsAt = new Map<number, ReadonlyMap<number, string>>();
	for (const row of rows) {
		if (draft.deletes.has(row.entry.id)) for (const index of row.unit) deleted.add(index);
		const inserts = draft.insertsAfter(row.entry.id);
		if (inserts.length > 0) insertsAt.set(row.anchorIndex, [...(insertsAt.get(row.anchorIndex) ?? []), ...inserts]);
		const blocks = draft.edits.get(row.entry.id);
		if (blocks) editsAt.set(row.index, blocks);
	}

	let lastTimestamp: number | undefined;
	for (let index = span.first - 1; index >= 0 && lastTimestamp === undefined; index--) {
		lastTimestamp = messageTimestamp(branch[index]);
	}
	if (lastTimestamp === undefined && span.first > 0) lastTimestamp = Date.parse(branch[span.first - 1].timestamp);

	const steps: Step[] = [];
	const labels: { target: number; label: string }[] = [];
	let copied = 0;
	let changed = 0;
	let firstCopy: number | undefined;

	const emitInserts = (position: number) => {
		for (const insert of insertsAt.get(position) ?? []) {
			const timestamp = (lastTimestamp ?? input.now) + 1;
			lastTimestamp = timestamp;
			steps.push({ op: "message", message: insertMessage(insert, timestamp, input.attribution) });
			labels.push({ target: steps.length - 1, label: EDITED_LABEL });
			changed++;
		}
	};

	emitInserts(span.first - 1);
	for (let index = span.first; index <= end; index++) {
		const entry = branch[index];
		if (!deleted.has(index)) {
			const blocks = editsAt.get(index);
			const step = copyStep(entry, blocks);
			if (typeof step === "string") return { ok: false, reason: step };
			if (step) {
				steps.push(step);
				copied++;
				const target = steps.length - 1;
				firstCopy ??= target;
				const existing = input.labelOf(entry.id);
				if (existing !== undefined) labels.push({ target, label: existing });
				else if (blocks) labels.push({ target, label: EDITED_LABEL });
				if (blocks) changed++;
				lastTimestamp = messageTimestamp(entry) ?? lastTimestamp;
			}
		}
		emitInserts(index);
	}

	if (steps.length === 0) return { ok: false, reason: "Nothing to save: the result is the branch point itself; use /tree." };
	// Only deletions: the region starts at the first deleted unit, so its first copy stands where that unit was.
	if (changed === 0 && firstCopy !== undefined && !labels.some(label => label.target === firstCopy)) {
		labels.push({ target: firstCopy, label: EDITED_LABEL });
	}
	labels.sort((a, b) => a.target - b.target);
	for (const label of labels) steps.push({ op: "label", target: label.target, label: label.label });

	return {
		ok: true,
		plan: {
			forkParentId: span.first > 0 ? branch[span.first - 1].id : null,
			steps,
			copied,
			tail: branch.slice(span.last + 1).filter(carriedOver).length,
		},
	};
}
