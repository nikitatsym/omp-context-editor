import type { ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { applyPlan, type WritableSessionManager, writableSessionManager } from "./apply";
import { buildRows, collapse, describeContent, type Row, roleName } from "./branch";
import { Draft, editedSlots, type Insert, type InsertRole, rowLabels, summarize } from "./draft";
import { buildPlan, type Plan, type PlanInput } from "./plan";

const SAVE_KEEP_TAIL = "Save, keep the tail";
const SAVE_CUT = "Save, cut after the last change";
const BACK_TO_EDITING = "Back to editing";
const EDIT_TEXT = "Edit text";
const INSERT_AFTER = "Insert message after";
const REVERT = "Revert this change";
const BACK = "Back";
const KEEP_EDITING = "Keep editing";
const SAVE_CHANGES = "Save changes...";
const DISCARD = "Discard changes";
const USER_MESSAGE = "User message";
const ASSISTANT_MESSAGE = "Assistant message";
const SUMMARY_LINES = 12;

// Built-in transcript cards that draw these custom messages from `details`, not from the edited content.
const DETAILS_RENDERED_TYPES: Record<string, true> = {
	"irc:incoming": true,
	"irc:autoreply": true,
	"irc:relay": true,
	"irc:workpool": true,
	advisor: true,
	"lsp-late-diagnostic": true,
	"launch-completion": true,
};

type Item = { label: string; key: string } & (
	| { kind: "save" }
	| { kind: "row"; row: Row }
	| { kind: "insert"; row: Row; insert: Insert }
);

type Ctx = ExtensionCommandContext;

function rowTags(row: Row, draft: Draft): string {
	const tags: string[] = [];
	if (row.notSent) tags.push(`[not sent: ${row.notSent}]`);
	if (draft.edits.has(row.entry.id)) tags.push("[edited]");
	if (draft.deletes.has(row.entry.id)) tags.push("[deleted]");
	return tags.length > 0 ? ` ${tags.join(" ")}` : "";
}

function listItems(rows: readonly Row[], draft: Draft): Item[] {
	const labels = rowLabels(rows, draft);
	const items: Item[] = [];
	if (draft.size > 0) items.push({ kind: "save", key: "save", label: `Save changes (${draft.size})` });
	for (let index = rows.length - 1; index >= 0; index--) {
		const row = rows[index];
		const inserts = draft.insertsAfter(row.entry.id);
		for (let position = inserts.length - 1; position >= 0; position--) {
			const insert = inserts[position];
			const label = `${labels.get(insert.id)} ${insert.role} [new]: ${collapse(insert.text)}`;
			items.push({ kind: "insert", key: insert.id, label, row, insert });
		}
		const content = describeContent(row, editedSlots(row, draft.edits.get(row.entry.id)));
		const label = `${labels.get(row.entry.id)} ${roleName(row)}${rowTags(row, draft)}: ${content}`;
		items.push({ kind: "row", key: row.entry.id, label, row });
	}
	return items;
}

async function askText(ctx: Ctx, title: string, prefill: string): Promise<string | undefined> {
	const text = await ctx.ui.editor(title, prefill);
	if (text === undefined) return undefined;
	if (text.trim().length === 0) {
		ctx.ui.notify("Empty text is not allowed; use Delete to remove a message", "warning");
		return undefined;
	}
	return text;
}

async function editRow(ctx: Ctx, draft: Draft, row: Row, label: string): Promise<void> {
	const slots = editedSlots(row, draft.edits.get(row.entry.id));
	let slot = slots[0];
	if (slots.length > 1) {
		const choices = slots.map((candidate, index) => `Block ${index + 1}: ${collapse(candidate.text, 80)}`);
		const choice = await ctx.ui.select(`${label} has ${slots.length} text blocks; pick one to edit`, choices);
		if (choice === undefined) return;
		slot = slots[choices.indexOf(choice)];
	}
	const text = await askText(ctx, `Edit ${label} ${roleName(row)}`, slot.text);
	if (text === undefined) return;
	draft.setText(row, slot.block, text);
	if (row.customType !== undefined && DETAILS_RENDERED_TYPES[row.customType] === true) {
		ctx.ui.notify(
			`The transcript draws ${row.customType} messages from their metadata and keeps showing the old text; the model gets the new text.`,
			"warning",
		);
	}
}

async function insertAfter(ctx: Ctx, draft: Draft, row: Row, label: string, after?: Insert): Promise<void> {
	const kind = await ctx.ui.select(`Insert after ${label}`, [USER_MESSAGE, ASSISTANT_MESSAGE]);
	if (kind === undefined) return;
	const role: InsertRole = kind === USER_MESSAGE ? "user" : "assistant";
	const text = await askText(ctx, `New ${role} message after ${label}`, "");
	if (text === undefined) return;
	draft.addInsert(row.entry.id, role, text, after?.id);
}

async function rowActions(ctx: Ctx, draft: Draft, row: Row, label: string): Promise<void> {
	const id = row.entry.id;
	const options: string[] = [];
	if (draft.deletes.has(id)) options.push(REVERT);
	else {
		if (!row.notSent && row.slots.length > 0) options.push(EDIT_TEXT);
		const deleteLabel = row.resultCount > 0 ? `Delete with ${row.resultCount} tool result(s)` : "Delete";
		options.push(deleteLabel);
		if (!row.notSent) options.push(INSERT_AFTER);
		if (draft.edits.has(id)) options.push(REVERT);
	}
	options.push(BACK);
	const content = describeContent(row, editedSlots(row, draft.edits.get(id)));
	const choice = await ctx.ui.select(`${label} ${roleName(row)}${rowTags(row, draft)}\n${collapse(content, 400)}`, options);
	if (choice === EDIT_TEXT) await editRow(ctx, draft, row, label);
	else if (choice === INSERT_AFTER) await insertAfter(ctx, draft, row, label);
	else if (choice === REVERT) draft.revert(id);
	else if (choice?.startsWith("Delete")) draft.delete(id);
}

async function insertActions(ctx: Ctx, draft: Draft, row: Row, insert: Insert, label: string): Promise<void> {
	const choice = await ctx.ui.select(`${label} ${insert.role} [new]\n${collapse(insert.text, 400)}`, [
		EDIT_TEXT,
		INSERT_AFTER,
		REVERT,
		BACK,
	]);
	if (choice === EDIT_TEXT) {
		const text = await askText(ctx, `Edit ${label} ${insert.role}`, insert.text);
		if (text !== undefined) draft.setInsertText(insert.id, text);
	} else if (choice === INSERT_AFTER) await insertAfter(ctx, draft, row, label, insert);
	else if (choice === REVERT) draft.revert(insert.id);
}

function planInput(ctx: Ctx, sm: WritableSessionManager, draft: Draft): Omit<PlanInput, "keepTail"> {
	const model = ctx.model;
	return {
		branch: sm.getBranch(),
		labelOf: entryId => sm.getLabel(entryId),
		draft,
		attribution: model ? { api: model.api, provider: model.provider, model: model.id } : undefined,
		now: Date.now(),
	};
}

/** Prunes the draft against the current branch; false when nothing is left to save. */
function refreshDraft(ctx: Ctx, sm: WritableSessionManager, draft: Draft): boolean {
	const dropped = draft.prune(buildRows(sm.getBranch()));
	if (dropped > 0) ctx.ui.notify(`Dropped ${dropped} staged change(s) that no longer apply`, "warning");
	return draft.size > 0;
}

function summaryTitle(draft: Draft, rows: readonly Row[], keep: Plan | undefined, cut: Plan | undefined, refusals: string[]): string {
	const lines = summarize(rows, draft);
	const shown = lines.slice(0, SUMMARY_LINES);
	if (lines.length > shown.length) shown.push(`... and ${lines.length - shown.length} more`);
	const title = [`Save ${draft.size} change(s) as a new branch:`, ...shown, ""];
	if (keep) title.push(`Keep the tail: copied entries: ${keep.copied}, of them after the last change: ${keep.tail}.`);
	if (cut) title.push(`Cut: copied entries: ${cut.copied}, left out after the last change: ${cut.tail}.`);
	title.push(...refusals);
	if (draft.deletes.size > 0) title.push("Todo, checkpoint and model-mention state is rebuilt from the new branch.");
	return title.join("\n");
}

/** Shows the summary and writes the chosen variant; true when the draft was written. */
async function save(ctx: Ctx, sm: WritableSessionManager, draft: Draft, busy: () => string | undefined): Promise<boolean> {
	const busyNow = busy();
	if (busyNow) {
		ctx.ui.notify(`Agent is busy (${busyNow}); save when it is idle`, "warning");
		return false;
	}
	if (!refreshDraft(ctx, sm, draft)) return false;
	const input = planInput(ctx, sm, draft);
	const keep = buildPlan({ ...input, keepTail: true });
	const cut = buildPlan({ ...input, keepTail: false });
	const refusals = [
		...(keep.ok ? [] : [`Keeping the tail is not possible: ${keep.reason}`]),
		...(cut.ok ? [] : [`Cutting is not possible: ${cut.reason}`]),
	];
	if (!keep.ok && !cut.ok) {
		ctx.ui.notify(refusals.join(" "), "error");
		return false;
	}
	const options = [...(keep.ok ? [SAVE_KEEP_TAIL] : []), ...(cut.ok ? [SAVE_CUT] : []), BACK_TO_EDITING];
	const title = summaryTitle(draft, buildRows(input.branch), keep.ok ? keep.plan : undefined, cut.ok ? cut.plan : undefined, refusals);
	const choice = await ctx.ui.select(title, options, { initialIndex: 0 });
	if (choice !== SAVE_KEEP_TAIL && choice !== SAVE_CUT) return false;

	// The branch may have moved while the summary was open: check and plan again right before writing.
	const busyAtWrite = busy();
	if (busyAtWrite) {
		ctx.ui.notify(`Agent is busy (${busyAtWrite}); nothing was written`, "warning");
		return false;
	}
	if (!refreshDraft(ctx, sm, draft)) return false;
	const planned = buildPlan({ ...planInput(ctx, sm, draft), keepTail: choice === SAVE_KEEP_TAIL });
	if (!planned.ok) {
		ctx.ui.notify(`Nothing was written: ${planned.reason}`, "error");
		return false;
	}
	const changes = draft.size;
	const result = await applyPlan(sm, (targetId, options) => ctx.navigateTree(targetId, options), planned.plan);
	if (result.status === "switched") {
		ctx.ui.notify(
			`Saved ${changes} change(s) as a new branch (copied entries: ${planned.plan.copied}). The previous branch is kept in /tree.`,
			"info",
		);
	} else if (result.status === "cancelled") {
		ctx.ui.notify(
			'The new branch was written, but another extension cancelled switching to it. The session stays on the previous branch; the new one is in /tree, labelled "edited".',
			"warning",
		);
	} else {
		ctx.ui.notify(
			`The new branch was written, but the session is at ${result.leaf ?? "no entry"} instead of ${result.newLeaf}. Open /tree and pick the entry labelled "edited".`,
			"error",
		);
	}
	return true;
}

/** What Esc in the main list leads to: back to the list, or out of the command. */
async function onEscape(ctx: Ctx, sm: WritableSessionManager, draft: Draft, busy: () => string | undefined): Promise<"list" | "close" | "saved" | "discarded"> {
	const choice = await ctx.ui.select(
		`${draft.size} staged change(s) are not saved`,
		[SAVE_CHANGES, KEEP_EDITING, DISCARD],
		{ initialIndex: 1 },
	);
	if (choice === undefined) {
		ctx.ui.notify("Staged changes are kept; run /edit-context to continue", "info");
		return "close";
	}
	if (choice === SAVE_CHANGES) return (await save(ctx, sm, draft, busy)) ? "saved" : "list";
	if (choice === DISCARD) {
		const sure = await ctx.ui.confirm("Discard changes", `Drop all ${draft.size} staged change(s)?`);
		return sure ? "discarded" : "list";
	}
	return "list";
}

/** The `/edit-context` dialog loop; the draft of this session survives closing it. */
export async function runEditor(ctx: Ctx, drafts: Map<string, Draft>, busy: () => string | undefined): Promise<void> {
	const sm = writableSessionManager(ctx);
	const sessionId = sm.getSessionId();
	const draft = drafts.get(sessionId) ?? new Draft();
	if (draft.size > 0) refreshDraft(ctx, sm, draft);
	drafts.delete(sessionId);
	if (buildRows(sm.getBranch()).length === 0) {
		ctx.ui.notify("No messages after the latest compaction or /clear.", "info");
		return;
	}
	let cursor: string | undefined;
	try {
		while (true) {
			const rows = buildRows(sm.getBranch());
			const items = listItems(rows, draft);
			const firstRow = items.findIndex(item => item.kind !== "save");
			const cursorIndex = items.findIndex(item => item.key === cursor);
			const title = `Edit context - ${rows.length} messages, ${draft.size} staged`;
			const choice = await ctx.ui.select(
				title,
				items.map(item => item.label),
				{ initialIndex: cursorIndex >= 0 ? cursorIndex : firstRow, helpText: "Enter: choose  Esc: close" },
			);
			if (choice === undefined) {
				if (draft.size === 0) return;
				const next = await onEscape(ctx, sm, draft, busy);
				if (next === "saved" || next === "discarded") {
					draft.clear();
					return;
				}
				if (next === "close") return;
				continue;
			}
			const item = items.find(candidate => candidate.label === choice);
			if (!item) throw new Error(`Unknown list entry: ${choice}`);
			cursor = item.key;
			if (item.kind === "save") {
				if (await save(ctx, sm, draft, busy)) {
					draft.clear();
					return;
				}
				continue;
			}
			const labels = rowLabels(rows, draft);
			if (item.kind === "row") await rowActions(ctx, draft, item.row, labels.get(item.row.entry.id) ?? "");
			else await insertActions(ctx, draft, item.row, item.insert, labels.get(item.insert.id) ?? "");
		}
	} finally {
		if (draft.size > 0) drafts.set(sessionId, draft);
	}
}
