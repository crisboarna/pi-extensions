// The node:crypto function pi-context-refs' core imports (createHash, for the
// Approval of a Project library command), for the browser. Approvals are not on
// the explainer's path: it treats every command as approved. Calling this fails
// loudly instead of returning a hash that nothing could check.

/** Not available in the page. */
export function createHash(_algorithm: string): never {
	throw new Error("createHash is not available in the browser explainer; Approvals are not part of it");
}
