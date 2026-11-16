import type { ExtensionCommandContext, SessionManager } from "@oh-my-pi/pi-coding-agent";
import type { AgentMessage } from "./branch";
import type { Plan, Step } from "./plan";

/** Internal SessionManager methods the editor reads and writes with (omp 18.20.2). */
export const REQUIRED_METHODS = [
	"getBranch",
	"getLeafId",
	"getLabel",
	"getSessionId",
	"branch",
	"resetLeaf",
	"appendMessage",
	"appendCustomEntry",
	"appendCustomMessageEntry",
	"appendThinkingLevelChange",
	"appendModelChange",
	"appendServiceTierChange",
	"appendModeChange",
	"appendTtsrInjection",
	"appendCredentialPin",
	"appendSessionInit",
	"branchWithSummary",
	"appendLabelChange",
	"flush",
] as const;

export type WritableSessionManager = Pick<SessionManager, (typeof REQUIRED_METHODS)[number]>;
export type NavigateTree = ExtensionCommandContext["navigateTree"];
type AppendableMessage = Parameters<SessionManager["appendMessage"]>[0];

/** Names of the methods `ctx` and its session manager lack, as `object.method`. */
export function missingMethods(ctx: Pick<ExtensionCommandContext, "sessionManager" | "navigateTree">): string[] {
	const missing = REQUIRED_METHODS.filter(name => typeof Reflect.get(ctx.sessionManager, name) !== "function").map(
		name => `sessionManager.${name}`,
	);
	if (typeof Reflect.get(ctx, "navigateTree") !== "function") missing.push("ctx.navigateTree");
	return missing;
}

/** The live session manager behind `ctx.sessionManager`; call after {@link missingMethods} came back empty. */
export function writableSessionManager(ctx: Pick<ExtensionCommandContext, "sessionManager">): WritableSessionManager {
	// Typed read-only for extensions, but at runtime it is the session's own SessionManager.
	const live = ctx.sessionManager as unknown as WritableSessionManager;
	return live;
}

function appendable(message: AgentMessage): AppendableMessage {
	if (message.role === "compactionSummary" || message.role === "branchSummary") {
		throw new Error(`A ${message.role} message is not a session message entry`);
	}
	return message;
}

function appendStep(sm: WritableSessionManager, step: Step, ids: readonly string[]): string {
	switch (step.op) {
		case "message":
			return sm.appendMessage(appendable(step.message));
		case "custom_message":
			return sm.appendCustomMessageEntry(
				step.customType,
				step.content,
				step.display,
				step.details,
				step.attribution,
				step.timestamp,
			);
		case "custom":
			return sm.appendCustomEntry(step.customType, step.data);
		case "thinking_level_change":
			return sm.appendThinkingLevelChange(step.thinkingLevel, step.configured);
		case "model_change":
			return sm.appendModelChange(step.model, step.role, step.resolvedModelIsFallback);
		case "service_tier_change":
			return sm.appendServiceTierChange(step.serviceTier);
		case "mode_change":
			return sm.appendModeChange(step.mode, step.data);
		case "ttsr_injection":
			return sm.appendTtsrInjection(step.injectedRules);
		case "credential_pin":
			return sm.appendCredentialPin(step.provider, step.hash);
		case "branch_summary":
			return sm.branchWithSummary(sm.getLeafId(), step.summary, step.details, step.fromExtension);
		case "session_init":
			return sm.appendSessionInit(step.init);
		case "label":
			return sm.appendLabelChange(ids[step.target], step.label);
	}
}

/** Makes `leafId` the last entry of the file again, so a restart opens its branch; its label stays as it is. */
function pinLeaf(sm: WritableSessionManager, leafId: string): void {
	sm.appendLabelChange(leafId, sm.getLabel(leafId));
}

export type ApplyResult =
	/** The session now runs on the new branch. */
	| { status: "switched"; newLeaf: string }
	/** Another extension cancelled the switch; the new branch is in the file, the session stays on the old one. */
	| { status: "cancelled"; newLeaf: string }
	/** The switch reported success but the session ended up elsewhere. */
	| { status: "diverged"; newLeaf: string; leaf: string | null };

/**
 * Writes the plan as a new branch grown from `plan.forkParentId`, then switches the session to it.
 * The appends run without awaiting, so nothing else can write between them.
 */
export async function applyPlan(sm: WritableSessionManager, navigateTree: NavigateTree, plan: Plan): Promise<ApplyResult> {
	const oldLeaf = sm.getLeafId();
	if (oldLeaf === null) throw new Error("The session has no active branch");
	if (plan.forkParentId === null) sm.resetLeaf();
	else sm.branch(plan.forkParentId);
	const ids: string[] = [];
	try {
		for (const step of plan.steps) ids.push(appendStep(sm, step, ids));
	} catch (error) {
		sm.branch(oldLeaf);
		pinLeaf(sm, oldLeaf);
		const step = plan.steps[ids.length];
		const source = "source" in step && step.source ? ` (copy of entry ${step.source})` : "";
		throw new Error(`Writing step ${ids.length + 1} of ${plan.steps.length}${source} failed`, { cause: error });
	}
	const newLeaf = sm.getLeafId();
	if (newLeaf === null || newLeaf !== ids[ids.length - 1]) throw new Error("The new branch does not end at its last entry");
	// navigateTree is a no-op when the target is already the leaf, so the leaf goes back first (memory only).
	sm.branch(oldLeaf);
	await sm.flush();
	const navigation = await navigateTree(newLeaf, { summarize: false });
	if (navigation.cancelled) {
		pinLeaf(sm, oldLeaf);
		await sm.flush();
		return { status: "cancelled", newLeaf };
	}
	const leaf = sm.getLeafId();
	return leaf === newLeaf ? { status: "switched", newLeaf } : { status: "diverged", newLeaf, leaf };
}
