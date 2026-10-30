import { type Approval, visible } from "./approval.ts";
import { UNTRUSTED } from "./ref-list.ts";

/** An Approval and how it relates to the Ref in the Project library now. */
export interface ListedApproval {
	approval: Approval;
	/** `current`: the Ref still has this definition. `changed`: the Ref was edited since. `removed`: no such Ref in the Project library. */
	status: "current" | "changed" | "removed";
}

export interface ApprovalListing {
	project: string;
	approved: ListedApproval[];
	/** The Project Dynamic Refs that have no Approval of their current definition. */
	pending: Array<{ name: string; definition: string }>;
	/** True when the Project library is not loaded because pi does not trust the project. */
	untrusted?: boolean;
}

const STATUS_NOTE: Record<ListedApproval["status"], string> = {
	current: "",
	changed: "; the Ref has changed since, so it is pending again",
	removed: "; the Ref is not in the Project library any more",
};

/** The plain-text block of `/ref approvals`: this project's Approvals, then the Refs waiting for one. */
export function formatApprovals(listing: ApprovalListing): string {
	const { approved, pending } = listing;
	const lines = [`Approvals for ${visible(listing.project)}`, ""];
	if (listing.untrusted) lines.push(`Project library: not loaded. ${UNTRUSTED}`, "");
	if (approved.length === 0) lines.push("Approved: none");
	else {
		lines.push(`Approved (${approved.length}):`);
		for (const { approval, status } of approved) {
			lines.push(`  ${visible(approval.name)}  ${visible(approval.definition)}  approved ${visible(approval.approvedAt)}${STATUS_NOTE[status]}`);
		}
	}
	if (pending.length === 0) lines.push("Pending: none");
	else {
		lines.push("", `Pending (${pending.length}):`);
		for (const ref of pending) lines.push(`  ${visible(ref.name)}  ${ref.definition}  approve it with /ref approve ${visible(ref.name)}`);
	}
	return lines.join("\n");
}
