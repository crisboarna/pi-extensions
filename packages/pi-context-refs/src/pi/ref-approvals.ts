import {
	type Approval,
	type ApprovalState,
	approvalState,
	approvalsFor,
	definitionLines,
	definitionText,
	hashDefinition,
	readApprovals,
	visible,
} from "../core/approval.ts";
import { type ApprovalListing, formatApprovals } from "../core/approval-list.ts";
import { projectRefProblem } from "../core/confine.ts";
import { type CommandRef, isCommandRef } from "../core/dynamic.ts";
import { refDefinition } from "../core/expand.ts";
import type { Ref } from "../core/library.ts";
import { foldName } from "../core/names.ts";
import type { RefCommand } from "../core/ref-command.ts";
import { isUrlRef, type UrlRef } from "../core/url.ts";
import { approvalsFile, dropApprovals, projectKey, recordApproval } from "./approvals.ts";
import { type Run, readListed, type Target, untrustedText } from "./ref-run.ts";

/** A Ref whose Source runs or fetches something, which is what an Approval covers. */
export type SourceRef = CommandRef | UrlRef;

export const needsApproval = (ref: Ref): ref is SourceRef => ref.kind === "dynamic" && (isCommandRef(ref) || isUrlRef(ref));

const definitionOfRef = (run: Run, ref: SourceRef) => refDefinition(ref, run.place);

/** The Approvals on disk, or none when the file cannot be read. */
function storedApprovals(run: Run): Approval[] {
	const read = readApprovals(approvalsFile(run.deps));
	return read.ok ? read.approvals : [];
}

/** The Dynamic Refs with a command or URL in the Project library. Empty when the library is not loaded. */
function projectSourceRefs(run: Run): SourceRef[] {
	if (!run.trusted) return [];
	return readListed(run.files.project, (ref) => projectRefProblem(ref, run.place)).listed.refs.filter(needsApproval);
}

/** The Approval state of a Project library Ref for `/ref list`: undefined for a Ref that needs none. */
export function approvalStateOf(run: Run): (ref: Ref) => ApprovalState | undefined {
	const project = projectKey(run.deps, run.ctx.cwd);
	const approvals = storedApprovals(run);
	return (ref) => (needsApproval(ref) ? approvalState(approvals, project, ref.name, hashDefinition(definitionOfRef(run, ref))) : undefined);
}

/** `/ref approvals`: this project's Approvals and the Project Dynamic Refs waiting for one. */
export function showApprovals(run: Run): void {
	const read = readApprovals(approvalsFile(run.deps));
	if (!read.ok) {
		run.say(read.error, "error");
		return;
	}
	const project = projectKey(run.deps, run.ctx.cwd);
	const refs = projectSourceRefs(run);
	const listing: ApprovalListing = {
		project,
		approved: approvalsFor(read.approvals, project).map((approval) => {
			const ref = refs.find((candidate) => foldName(candidate.name) === foldName(approval.name));
			const status = ref === undefined ? "removed" : hashDefinition(definitionOfRef(run, ref)) === approval.hash ? "current" : "changed";
			return { approval, status };
		}),
		pending: refs
			.filter((ref) => approvalState(read.approvals, project, ref.name, hashDefinition(definitionOfRef(run, ref))) === "pending")
			.map((ref) => ({ name: ref.name, definition: definitionText(definitionOfRef(run, ref)) })),
		...(run.trusted ? {} : { untrusted: true }),
	};
	run.say(formatApprovals(listing));
}

/** `/ref approve <name>`: shows the exact definition and records an Approval after a confirm. It never works without a UI, so a script cannot approve a repository's Refs. */
export async function approveRef(run: Run, command: Extract<RefCommand, { name: "approve" }>): Promise<void> {
	const { ctx } = run;
	if (!ctx.hasUI)
		return run.say("/ref approve needs a confirm in pi's UI, and there is none here. Run it in pi: there is no way to approve without a UI.", "error");
	if (!run.trusted) return run.say(untrustedText(run), "error");
	const refs = projectSourceRefs(run);
	const project = projectKey(run.deps, ctx.cwd);
	const stored = storedApprovals(run);
	const isPending = (ref: SourceRef): boolean => approvalState(stored, project, ref.name, hashDefinition(definitionOfRef(run, ref))) === "pending";
	let name = command.refName;
	if (name === undefined) {
		const waiting = refs.filter(isPending).map((ref) => ref.name);
		if (waiting.length === 0) return run.say("No Project Dynamic Ref is waiting for an Approval");
		name = await ctx.ui.select("Approve which Ref?", waiting);
		if (name === undefined) return run.say("Cancelled");
	}
	const ref = refs.find((candidate) => foldName(candidate.name) === foldName(name));
	if (!ref) return run.say(`no command or URL Ref named "${name}" in the Project library (${run.files.project.path})`, "error");
	if (!isPending(ref)) return run.say(`"${ref.name}" is already approved as it is defined now`);
	const definition = definitionOfRef(run, ref);
	const verb = definition.source === "command" ? "run" : "fetch";
	const confirmed = await ctx.ui.confirm(
		`Approve #${ref.name}?`,
		[
			`From the Project library ${visible(run.files.project.path)}.`,
			...definitionLines(definition),
			"",
			`It will ${verb} this at every send, without asking, until the definition changes.`,
		].join("\n"),
	);
	if (!confirmed) return run.say(`Did not approve "${ref.name}"`);
	const saved = recordApproval(run.deps, project, ref.name, definition);
	run.say(saved.ok ? `Approved "${ref.name}"` : saved.error, saved.ok ? "info" : "error");
}

/** `/ref revoke <name|all>`: drops Approvals of this project. It needs no confirm. */
export async function revokeApproval(run: Run, command: Extract<RefCommand, { name: "revoke" }>): Promise<void> {
	const { ctx } = run;
	const project = projectKey(run.deps, ctx.cwd);
	let name = command.refName;
	if (name === undefined) {
		if (!ctx.hasUI) return run.say("a name is needed when there is no UI\n/ref revoke <name|all>", "error");
		const read = readApprovals(approvalsFile(run.deps));
		if (!read.ok) return run.say(read.error, "error");
		const approved = approvalsFor(read.approvals, project).map((approval) => approval.name);
		if (approved.length === 0) return run.say("This project has no Approvals");
		name = await ctx.ui.select("Revoke which Approval?", [...approved, "all"]);
		if (name === undefined) return run.say("Cancelled");
	}
	const dropped = dropApprovals(run.deps, project, name === "all" ? undefined : name);
	if (!dropped.ok) return run.say(dropped.error, "error");
	if (name === "all")
		return run.say(dropped.dropped === 0 ? "This project has no Approvals" : `Revoked ${dropped.dropped} Approval${dropped.dropped === 1 ? "" : "s"}`);
	run.say(dropped.dropped === 0 ? `"${name}" has no Approval in this project` : `Revoked the Approval of "${name}"`);
}

/** What saving a Ref asks about its Approval. */
export type ApprovalDecision = { save: true; approve?: SourceRef } | { save: false };

/**
 * A Project library command or URL Ref saved from the TUI or an RPC client is saved and approved in one confirm that shows its exact definition.
 * Without a UI it is saved with no Approval. A Ref that needs none, or whose definition is approved already, is saved without a question.
 */
export async function decideApproval(run: Run, target: Target, ref: Ref): Promise<ApprovalDecision> {
	if (target.library !== "project" || !needsApproval(ref) || !run.ctx.hasUI) return { save: true };
	const definition = definitionOfRef(run, ref);
	const project = projectKey(run.deps, run.ctx.cwd);
	if (approvalState(storedApprovals(run), project, ref.name, hashDefinition(definition)) === "approved") return { save: true };
	const verb = definition.source === "command" ? "run" : "fetch";
	const confirmed = await run.ctx.ui.confirm(
		`Save #${ref.name} and approve it?`,
		[
			`This saves the Ref in the Project library ${visible(run.files.project.path)} and approves exactly this definition.`,
			...definitionLines(definition),
			"",
			`It will ${verb} this at every send, without asking, until the definition changes.`,
		].join("\n"),
	);
	return confirmed ? { save: true, approve: ref } : { save: false };
}

/** Records the Approval a confirm gave, and says so for the result line. */
export function recordDecided(run: Run, ref: SourceRef): { note: string } | { error: string } {
	const saved = recordApproval(run.deps, projectKey(run.deps, run.ctx.cwd), ref.name, definitionOfRef(run, ref));
	return saved.ok ? { note: "; approved this definition" } : { error: `${saved.error}; the Ref is saved but not approved` };
}

/** Drops the Approvals of a Ref that was removed or renamed in the Project library. Returns a warning to add to the result line, or an empty string. */
export function forgetApproval(run: Run, target: Target, name: string): string {
	if (target.library !== "project") return "";
	const dropped = dropApprovals(run.deps, projectKey(run.deps, run.ctx.cwd), name);
	return dropped.ok ? "" : `; ${dropped.error}`;
}
