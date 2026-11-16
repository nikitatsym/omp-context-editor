import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { missingMethods } from "./apply";
import type { Draft } from "./draft";
import { runEditor } from "./ui";

const TUI_ONLY = "/edit-context works only in the interactive TUI";

/** Why the session must not be rewritten right now, or undefined when it is idle. */
export function busyReason(ctx: ExtensionContext, compacting: boolean): string | undefined {
	if (!ctx.isIdle()) return "a turn is running";
	if (ctx.hasPendingMessages()) return "messages are queued";
	const jobs = ctx.getAsyncJobSnapshot();
	if (jobs && jobs.running.length > 0) return "background jobs are running";
	if (jobs && (jobs.delivery.queued > 0 || jobs.delivery.delivering || jobs.delivery.pendingJobIds.length > 0)) {
		return "background job results are not delivered yet";
	}
	if (compacting) return "compaction is running";
	return undefined;
}

export default function contextEditor(pi: ExtensionAPI): void {
	const drafts = new Map<string, Draft>();
	// The extension API exposes no compaction state; idle and auto compaction announce themselves with these events.
	let compacting = false;
	pi.on("auto_compaction_start", () => {
		compacting = true;
	});
	pi.on("auto_compaction_end", () => {
		compacting = false;
	});

	pi.registerCommand("edit-context", {
		description: "Edit, delete or insert messages of the current branch; saves them as a new branch",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui" || !ctx.hasUI) {
				ctx.ui.notify(TUI_ONLY, "error");
				// notify does nothing outside the TUI; the error reaches the extension error channel instead.
				throw new Error(TUI_ONLY);
			}
			const busy = () => busyReason(ctx, compacting);
			const reason = busy();
			if (reason) {
				ctx.ui.notify(`Agent is busy (${reason}); run /edit-context when it is idle`, "warning");
				return;
			}
			const missing = missingMethods(ctx);
			if (missing.length > 0) {
				ctx.ui.notify(`omp internals changed: missing ${missing.join(", ")}. Nothing was written.`, "error");
				return;
			}
			await runEditor(ctx, drafts, busy);
		},
	});
}
