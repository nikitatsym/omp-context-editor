import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { AgentMessage } from "../src/branch";
import contextEditor from "../src/index";
import { BranchBuilder, basicBranch, replay, thinking } from "./fixtures";

type Answer = string | undefined | ((options: string[]) => string | undefined);
type Step = { kind: "select" | "editor" | "confirm"; answer: Answer | boolean };

/** Plays a fixed script of dialog answers and records what the command showed. */
class ScriptedUI {
	readonly selects: { title: string; options: string[] }[] = [];
	readonly editors: { title: string; prefill: string | undefined }[] = [];
	readonly notes: [string, string | undefined][] = [];
	readonly script: Step[] = [];

	#next(kind: Step["kind"]): Step["answer"] {
		const step = this.script.shift();
		if (!step) throw new Error(`unexpected ${kind}: the script is over`);
		if (step.kind !== kind) throw new Error(`expected ${step.kind}, got ${kind}`);
		return step.answer;
	}

	select = async (title: string, options: unknown[]) => {
		const labels = options.map(String);
		this.selects.push({ title, options: labels });
		const answer = this.#next("select");
		return typeof answer === "function" ? answer(labels) : (answer as string | undefined);
	};
	editor = async (title: string, prefill?: string) => {
		this.editors.push({ title, prefill });
		return this.#next("editor") as string | undefined;
	};
	confirm = async () => this.#next("confirm") as boolean;
	notify = (message: string, type?: string) => {
		this.notes.push([message, type]);
	};
}

const pick =
	(prefix: string) =>
	(options: string[]): string => {
		const found = options.find(option => option.startsWith(prefix));
		if (!found) throw new Error(`no option starting with "${prefix}" in ${JSON.stringify(options)}`);
		return found;
	};
const select = (answer: Answer): Step => ({ kind: "select", answer });
const editor = (text: string | undefined): Step => ({ kind: "editor", answer: text });
const confirm = (yes: boolean): Step => ({ kind: "confirm", answer: yes });
const ESC: Step = { kind: "select", answer: undefined };

interface Harness {
	run: () => Promise<void>;
	ui: ScriptedUI;
	sm: SessionManager;
	ctx: Record<string, unknown>;
	emit: (event: string) => void;
}

function harness(entries = basicBranch().entries): Harness {
	const handlers = new Map<string, () => void>();
	let command: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
	const fakePi = {
		on: (event: string, handler: () => void) => handlers.set(event, handler),
		registerCommand: (name: string, options: { handler: typeof command }) => {
			expect(name).toBe("edit-context");
			command = options.handler;
		},
	};
	// Only the two registration methods are used by the factory.
	const pi = fakePi as unknown as ExtensionAPI;
	contextEditor(pi);
	const sm = SessionManager.inMemory(tmpdir());
	replay(sm, entries);
	const ui = new ScriptedUI();
	const ctx: Record<string, unknown> = {
		mode: "tui",
		hasUI: true,
		ui,
		sessionManager: sm,
		model: { api: "openai-completions", provider: "litellm", id: "gpt-test" },
		isIdle: () => true,
		hasPendingMessages: () => false,
		getAsyncJobSnapshot: () => null,
		navigateTree: async (target: string) => {
			sm.branch(target);
			return { cancelled: false };
		},
	};
	return {
		ui,
		sm,
		ctx,
		emit: event => handlers.get(event)?.(),
		run: () => {
			if (!command) throw new Error("command not registered");
			// The command reads only the members set above.
			const commandCtx = ctx as unknown as ExtensionCommandContext;
			return command("", commandCtx);
		},
	};
}

function contextTexts(sm: SessionManager): string[] {
	return sm.buildSessionContext().messages.flatMap((message: AgentMessage) => {
		if (message.role !== "user" && message.role !== "assistant") return [];
		const content = message.content;
		if (typeof content === "string") return [`${message.role}:${content}`];
		const text = content.flatMap(block => (block.type === "text" ? [block.text] : [])).join("|");
		return text ? [`${message.role}:${text}`] : [];
	});
}

describe("refusals", () => {
	test("outside the TUI the command fails loudly", async () => {
		const h = harness();
		h.ctx.mode = "print";
		h.ctx.hasUI = false;
		await expect(h.run()).rejects.toThrow("/edit-context works only in the interactive TUI");
	});

	test.each([
		["a turn is running", (h: Harness) => (h.ctx.isIdle = () => false)],
		["messages are queued", (h: Harness) => (h.ctx.hasPendingMessages = () => true)],
		[
			"background jobs are running",
			(h: Harness) =>
				(h.ctx.getAsyncJobSnapshot = () => ({
					running: [{}],
					recent: [],
					delivery: { queued: 0, delivering: false, pendingJobIds: [] },
				})),
		],
		[
			"background job results are not delivered yet",
			(h: Harness) =>
				(h.ctx.getAsyncJobSnapshot = () => ({
					running: [],
					recent: [],
					delivery: { queued: 1, delivering: false, pendingJobIds: ["j1"] },
				})),
		],
		["compaction is running", (h: Harness) => h.emit("auto_compaction_start")],
	])("busy: %s", async (reason, makeBusy) => {
		const h = harness();
		makeBusy(h);
		await h.run();
		expect(h.ui.notes).toEqual([[`Agent is busy (${reason}); run /edit-context when it is idle`, "warning"]]);
		expect(h.ui.selects).toEqual([]);
	});

	test("compaction end makes the command available again", async () => {
		const h = harness();
		h.emit("auto_compaction_start");
		h.emit("auto_compaction_end");
		h.ui.script.push(ESC);
		await h.run();
		expect(h.ui.selects.length).toBe(1);
	});

	test("missing internals are named and nothing is written", async () => {
		const h = harness();
		const entriesBefore = h.sm.getEntries().length;
		h.ctx.navigateTree = undefined;
		await h.run();
		expect(h.ui.notes).toEqual([["omp internals changed: missing ctx.navigateTree. Nothing was written.", "error"]]);
		expect(h.sm.getEntries().length).toBe(entriesBefore);
	});

	test("a branch without messages after the boundary has nothing to edit", async () => {
		const b = new BranchBuilder();
		b.add({ type: "model_change", model: "litellm/x" });
		const h = harness(b.entries);
		await h.run();
		expect(h.ui.notes).toEqual([["No messages after the latest compaction or /clear.", "info"]]);
	});
});

describe("list", () => {
	test("newest first, unique numbered labels, save entry on top once something is staged", async () => {
		const h = harness();
		h.ui.script.push(
			select(pick("#1 ")),
			select(pick("Delete")),
			ESC,
			select(pick("Discard")),
			confirm(true),
		);
		await h.run();
		const [first, second] = h.ui.selects;
		expect(first.title).toBe("Edit context - 5 messages, 0 staged");
		expect(first.options).toEqual([
			"#5 assistant: 42",
			"#4 user: what is 17+25?",
			"#3 assistant: The codeword is MANGO-3.",
			"#2 assistant: tools: read (+1 result)",
			"#1 user: read probe1.txt",
		]);
		expect(second.options).toEqual(["Edit text", "Delete", "Insert message after", "Back"]);
		expect(h.ui.selects[2].options).toEqual([
			"Save changes (1)",
			"#5 assistant: 42",
			"#4 user: what is 17+25?",
			"#3 assistant: The codeword is MANGO-3.",
			"#2 assistant: tools: read (+1 result)",
			"#1 user [deleted]: read probe1.txt",
		]);
	});

	test("turns omp does not send can only be deleted", async () => {
		const b = new BranchBuilder();
		b.user("q");
		b.text("partial", { stopReason: "aborted" });
		const h = harness(b.entries);
		h.ui.script.push(select(pick("#2 ")), ESC, ESC);
		await h.run();
		expect(h.ui.selects[0].options[0]).toBe("#2 assistant [not sent: aborted]: partial");
		expect(h.ui.selects[1].options).toEqual(["Delete", "Back"]);
	});
});

describe("editing and saving", () => {
	test("edit a user message and save keeping the tail", async () => {
		const h = harness();
		h.ui.script.push(
			select(pick("#4 ")),
			select(pick("Edit text")),
			editor("what is 17+26?"),
			select(pick("Save changes")),
			select(pick("Save, keep the tail")),
		);
		await h.run();
		expect(h.ui.editors[0].prefill).toBe("what is 17+25?");
		expect(h.ui.selects[3].title).toContain('#4 user: "what is 17+25?" -> "what is 17+26?"');
		expect(h.ui.notes).toEqual([
			["Saved 1 change(s) as a new branch (copied entries: 2). The previous branch is kept in /tree.", "info"],
		]);
		expect(contextTexts(h.sm)).toEqual([
			"user:read probe1.txt",
			"assistant:The codeword is MANGO-3.",
			"user:what is 17+26?",
			"assistant:42",
		]);
	});

	test("several changes in one pass, one of them reverted, saved with a cut", async () => {
		const h = harness();
		h.ui.script.push(
			select(pick("#3 ")),
			select(pick("Edit text")),
			editor("The codeword is KIWI-7."),
			select(pick("#1 ")),
			select(pick("Edit text")),
			editor("read probe1.txt please"),
			select(pick("#3 ")),
			select(pick("Insert message after")),
			select(pick("Assistant message")),
			editor("Noted: TEAL."),
			select(pick("#1 ")),
			select(pick("Revert this change")),
			select(pick("Save changes (2)")),
			select(pick("Save, cut")),
		);
		await h.run();
		expect(h.ui.notes.at(-1)?.[1]).toBe("info");
		expect(contextTexts(h.sm)).toEqual(["user:read probe1.txt", "assistant:The codeword is KIWI-7.", "assistant:Noted: TEAL."]);
		const inserted = h.sm.getBranch().find(entry => entry.type === "message" && entry.message.role === "assistant" && entry.message.model === "gpt-test");
		expect(inserted && h.sm.getLabel(inserted.id)).toBe("edited");
	});

	test("Esc: keep editing returns to the list, closing keeps the draft, discard asks first", async () => {
		const h = harness();
		h.ui.script.push(
			select(pick("#5 ")),
			select(pick("Edit text")),
			editor("43"),
			ESC,
			select(pick("Keep editing")),
			ESC,
			ESC,
		);
		await h.run();
		expect(h.ui.selects[3].options).toEqual(["Save changes...", "Keep editing", "Discard changes"]);
		expect(h.ui.selects[4].title).toBe("Edit context - 5 messages, 1 staged");
		expect(h.ui.notes.at(-1)).toEqual(["Staged changes are kept; run /edit-context to continue", "info"]);

		h.ui.script.push(ESC, select(pick("Discard")), confirm(false), ESC, select(pick("Discard")), confirm(true));
		const shown = h.ui.selects.length;
		await h.run();
		expect(h.ui.selects[shown].options[1]).toBe("#5 assistant [edited]: 43");

		h.ui.script.push(ESC);
		await h.run();
		expect(h.ui.selects.at(-1)?.options[0]).toBe("#5 assistant: 42");
	});

	test("empty text is refused", async () => {
		const h = harness();
		h.ui.script.push(select(pick("#4 ")), select(pick("Edit text")), editor("  \n "), ESC);
		await h.run();
		expect(h.ui.notes).toEqual([["Empty text is not allowed; use Delete to remove a message", "warning"]]);
	});

	test("a message with several text blocks asks which block to edit", async () => {
		const b = new BranchBuilder();
		b.user("q");
		b.assistant([thinking("t", "sig"), { type: "text", text: "alpha" }, { type: "text", text: "beta" }]);
		const h = harness(b.entries);
		h.ui.script.push(
			select(pick("#2 ")),
			select(pick("Edit text")),
			select(pick("Block 2")),
			editor("BETA"),
			select(pick("Save changes")),
			select(pick("Save, keep")),
		);
		await h.run();
		expect(h.ui.selects[2].options).toEqual(["Block 1: alpha", "Block 2: beta"]);
		expect(h.ui.editors[0].prefill).toBe("beta");
		expect(contextTexts(h.sm)).toEqual(["user:q", "assistant:alpha|BETA"]);
	});

	test("editing an IRC message warns that the transcript keeps the old text", async () => {
		const b = new BranchBuilder();
		b.user("q");
		b.customMessage("irc:incoming", "ping from peer", { from: "peer", message: "ping from peer" });
		const h = harness(b.entries);
		h.ui.script.push(select(pick("#2 ")), select(pick("Edit text")), editor("pong"), ESC, ESC);
		await h.run();
		expect(h.ui.notes[0]).toEqual([
			"The transcript draws irc:incoming messages from their metadata and keeps showing the old text; the model gets the new text.",
			"warning",
		]);
	});

	test("a turn that starts while the summary is open stops the save and keeps the draft", async () => {
		const h = harness();
		h.ui.script.push(
			select(pick("#5 ")),
			select(pick("Edit text")),
			editor("43"),
			select(pick("Save changes")),
			select(options => {
				h.ctx.isIdle = () => false;
				return pick("Save, keep")(options);
			}),
			ESC,
			ESC,
		);
		const entriesBefore = h.sm.getEntries().length;
		await h.run();
		expect(h.ui.notes[0]).toEqual(["Agent is busy (a turn is running); nothing was written", "warning"]);
		expect(h.sm.getEntries().length).toBe(entriesBefore);
		h.ctx.isIdle = () => true;
		h.ui.script.push(ESC, select(pick("Keep editing")), ESC, ESC);
		await h.run();
		expect(h.ui.selects.at(-1)?.title).toBe("1 staged change(s) are not saved");
	});
});
