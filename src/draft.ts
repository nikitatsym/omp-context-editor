import { collapse, describeContent, type Row, roleName, type TextSlot } from "./branch";

export type InsertRole = "user" | "assistant";

/** A message to insert after the row `anchor` (an entry id); inserts with one anchor keep their array order. */
export interface Insert {
	id: string;
	anchor: string;
	role: InsertRole;
	text: string;
}

/** Staged changes of one session, kept in memory until saved or discarded. */
export class Draft {
	/** Entry id -> text block (-1 for string content) -> new text. */
	readonly edits = new Map<string, Map<number, string>>();
	readonly deletes = new Set<string>();
	inserts: Insert[] = [];
	#insertSeq = 0;

	get size(): number {
		return this.edits.size + this.deletes.size + this.inserts.length;
	}

	/** Stage `text` for one block; text equal to the original unstages that block. */
	setText(row: Row, block: number, text: string): void {
		const original = row.slots.find(slot => slot.block === block);
		if (!original) throw new Error(`Entry ${row.entry.id} has no text block ${block}`);
		const blocks = this.edits.get(row.entry.id) ?? new Map<number, string>();
		if (text === original.text) blocks.delete(block);
		else blocks.set(block, text);
		if (blocks.size > 0) this.edits.set(row.entry.id, blocks);
		else this.edits.delete(row.entry.id);
	}

	delete(entryId: string): void {
		this.edits.delete(entryId);
		this.deletes.add(entryId);
	}

	/** Insert directly after the row `anchor`, or directly after the insert `after` when given. */
	addInsert(anchor: string, role: InsertRole, text: string, after?: string): Insert {
		this.#insertSeq++;
		const insert: Insert = { id: `insert-${this.#insertSeq}`, anchor, role, text };
		const position = after
			? this.inserts.findIndex(other => other.id === after) + 1
			: this.inserts.findIndex(other => other.anchor === anchor);
		if (after && position === 0) throw new Error(`Unknown insert ${after}`);
		if (position < 0) this.inserts.push(insert);
		else this.inserts.splice(position, 0, insert);
		return insert;
	}

	setInsertText(id: string, text: string): void {
		const insert = this.inserts.find(other => other.id === id);
		if (!insert) throw new Error(`Unknown insert ${id}`);
		insert.text = text;
	}

	/** Undo the change on an entry (edit or delete) or remove an insert. */
	revert(id: string): void {
		this.edits.delete(id);
		this.deletes.delete(id);
		this.inserts = this.inserts.filter(insert => insert.id !== id);
	}

	clear(): void {
		this.edits.clear();
		this.deletes.clear();
		this.inserts = [];
	}

	insertsAfter(anchor: string): Insert[] {
		return this.inserts.filter(insert => insert.anchor === anchor);
	}

	/** Drop changes whose entries are no longer listed on the branch; returns how many were dropped. */
	prune(rows: readonly Row[]): number {
		const listed = new Map(rows.map(row => [row.entry.id, row]));
		let dropped = 0;
		for (const [entryId, blocks] of this.edits) {
			const row = listed.get(entryId);
			if (row && !row.notSent && [...blocks.keys()].every(block => row.slots.some(slot => slot.block === block))) continue;
			this.edits.delete(entryId);
			dropped++;
		}
		for (const entryId of this.deletes) {
			if (listed.has(entryId)) continue;
			this.deletes.delete(entryId);
			dropped++;
		}
		const kept = this.inserts.filter(insert => listed.has(insert.anchor));
		dropped += this.inserts.length - kept.length;
		this.inserts = kept;
		return dropped;
	}
}

/** The row's text slots with staged edits applied. */
export function editedSlots(row: Row, blocks: ReadonlyMap<number, string> | undefined): TextSlot[] {
	if (!blocks) return row.slots;
	return row.slots.map(slot => ({ block: slot.block, text: blocks.get(slot.block) ?? slot.text }));
}

/** Labels of rows: `#n` counts listed messages from the oldest; inserts after row `#n` are `#n.1`, `#n.2`, ... */
export function rowLabels(rows: readonly Row[], draft: Draft): Map<string, string> {
	const labels = new Map<string, string>();
	rows.forEach((row, index) => {
		labels.set(row.entry.id, `#${index + 1}`);
		draft.insertsAfter(row.entry.id).forEach((insert, position) => {
			labels.set(insert.id, `#${index + 1}.${position + 1}`);
		});
	});
	return labels;
}

const QUOTE_CHARS = 60;
const QUOTE_LEAD = 20;

function quoted(text: string): string {
	return `"${collapse(text, QUOTE_CHARS)}"`;
}

/** Both texts quoted from shortly before their first difference, so a change late in a long text shows. */
function quotedChange(before: string, after: string): string {
	const flatBefore = collapse(before, Number.POSITIVE_INFINITY);
	const flatAfter = collapse(after, Number.POSITIVE_INFINITY);
	let common = 0;
	while (common < flatBefore.length && flatBefore[common] === flatAfter[common]) common++;
	const start = Math.max(0, common - QUOTE_LEAD);
	const lead = start > 0 ? "..." : "";
	return `${quoted(lead + flatBefore.slice(start))} -> ${quoted(lead + flatAfter.slice(start))}`;
}

/** One line per staged change, oldest message first: what it was and what it becomes. */
export function summarize(rows: readonly Row[], draft: Draft): string[] {
	const labels = rowLabels(rows, draft);
	const lines: string[] = [];
	for (const row of rows) {
		const label = labels.get(row.entry.id);
		const blocks = draft.edits.get(row.entry.id);
		if (blocks) {
			const before = row.slots.map(slot => slot.text).join(" ");
			const after = editedSlots(row, blocks)
				.map(slot => slot.text)
				.join(" ");
			lines.push(`${label} ${roleName(row)}: ${quotedChange(before, after)}`);
		}
		if (draft.deletes.has(row.entry.id)) {
			const results = row.resultCount > 0 ? ` with ${row.resultCount} tool result(s)` : "";
			lines.push(`${label} ${roleName(row)}: deleted${results}: ${collapse(describeContent(row, row.slots), 60)}`);
		}
		for (const insert of draft.insertsAfter(row.entry.id)) {
			lines.push(`${labels.get(insert.id)} ${insert.role}: new after ${label}: ${quoted(insert.text)}`);
		}
	}
	return lines;
}
