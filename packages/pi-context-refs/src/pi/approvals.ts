import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	type Approval,
	type ApprovalRequest,
	approvalCoverage,
	approvalState,
	type Definition,
	definitionLines,
	definitionText,
	hashDefinition,
	readApprovals,
	updateApprovals,
	type Verdict,
	visible,
	withApproval,
	withoutApprovals,
} from "../core/approval.ts";
import type { LibraryFile, WriteResult } from "../core/config-writer.ts";
import { printable } from "../core/text.ts";

/** What the Approvals need from outside pi, so tests can stand in for the machine. */
export interface ApprovalDeps {
	/** The approvals file, in the agent directory and never in a project. */
	approvalsPath: string;
	readText: (path: string) => string | undefined;
	/** Replaces the file atomically. */
	writeText: (path: string, text: string) => void;
	/** The real path of an existing path, or undefined when it does not exist. */
	realpath: (path: string) => string | undefined;
	/** Where a symlink points, as written, or undefined when the path is not a symlink. */
	linkTarget: (path: string) => string | undefined;
	now: () => Date;
}

const ONCE = "Run once";
const ALWAYS = "Always for this definition";
const DENY = "Deny";

export const approvalsFile = (deps: ApprovalDeps): LibraryFile => ({
	path: deps.approvalsPath,
	read: () => deps.readText(deps.approvalsPath),
	write: (text) => deps.writeText(deps.approvalsPath, text),
});

/** The canonical path of a project, which keys its Approvals. */
export const projectKey = (deps: Pick<ApprovalDeps, "realpath">, cwd: string): string => deps.realpath(cwd) ?? cwd;

/** Records an "always" Approval for exactly this definition of the Ref. */
export function recordApproval(deps: ApprovalDeps, project: string, name: string, definition: Definition): WriteResult {
	const approval: Approval = {
		project,
		name,
		hash: hashDefinition(definition),
		definition: definitionText(definition),
		approvedAt: deps.now().toISOString(),
	};
	return updateApprovals(approvalsFile(deps), (list) => withApproval(list, approval));
}

/** Drops the Approvals of `name` in the project, or all of the project's when there is no name. Says how many it dropped. */
export function dropApprovals(deps: ApprovalDeps, project: string, name?: string): { ok: true; dropped: number } | { ok: false; error: string } {
	let dropped = 0;
	const result = updateApprovals(approvalsFile(deps), (list) => {
		const kept = withoutApprovals(list, project, name);
		dropped = list.length - kept.length;
		return kept;
	});
	return result.ok ? { ok: true, dropped } : result;
}

/** Whether this exact definition of the Ref is approved for the project. An approvals file that cannot be read approves nothing. */
export function isApproved(deps: ApprovalDeps, project: string, name: string, definition: Definition): boolean {
	const read = readApprovals(approvalsFile(deps));
	return read.ok && approvalState(read.approvals, project, name, hashDefinition(definition)) === "approved";
}

/** The question an Approval dialog asks: the Ref, then the exact definition. */
export function approvalQuestion(name: string, project: string, definition: Definition): string {
	const verb = definition.source === "command" ? "run" : "fetch";
	return [
		`Allow the Project library Ref #${name} to ${verb} this?`,
		...definitionLines(definition),
		`project: ${visible(project)}`,
		"",
		approvalCoverage(definition),
	].join("\n");
}

/** Why a Ref is not approved where nothing can ask: print and JSON mode. The reason also reaches stderr as the warning for the failed Ref. */
export const notApprovedHere = (name: string): string => `it is not approved; approve it in pi with /ref approve ${name}`;

/**
 * Decides whether a Project library Dynamic Ref may run. An Approval of its exact definition is enough. Otherwise a session with a UI
 * (the TUI, and the client in RPC) asks: once, always for this definition, or deny. Print and JSON mode never ask.
 */
export function createApprover(ctx: ExtensionContext, deps: ApprovalDeps): (request: ApprovalRequest) => Promise<Verdict> {
	return async ({ ref, definition }) => {
		const project = projectKey(deps, ctx.cwd);
		if (isApproved(deps, project, ref.name, definition)) return { allowed: true };
		if (!ctx.hasUI) return { allowed: false, reason: notApprovedHere(ref.name) };
		const choice = await ctx.ui.select(approvalQuestion(ref.name, project, definition), [ONCE, ALWAYS, DENY]);
		if (choice === ONCE) return { allowed: true };
		if (choice !== ALWAYS) return { allowed: false, reason: choice === DENY ? "you denied it" : "you did not approve it" };
		const saved = recordApproval(deps, project, ref.name, definition);
		if (!saved.ok) ctx.ui.notify(printable(`pi-context-refs: ${saved.error}; this definition runs once and will ask again`), "warning");
		return { allowed: true };
	};
}

/** Like `createApprover`, but never asks and never records: a preview runs a Project library Ref only when its exact definition is approved already. */
export function createPreviewApprover(ctx: Pick<ExtensionContext, "cwd">, deps: ApprovalDeps): (request: ApprovalRequest) => Promise<Verdict> {
	return async ({ ref, definition }) =>
		isApproved(deps, projectKey(deps, ctx.cwd), ref.name, definition)
			? { allowed: true }
			: { allowed: false, reason: `it is not approved yet; sending asks for your approval, or approve it with /ref approve ${ref.name}` };
}
