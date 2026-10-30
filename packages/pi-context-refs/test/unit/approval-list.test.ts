import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatApprovals } from "../../src/core/approval-list.ts";

const approval = (name: string) => ({
	project: "/work/app",
	name,
	hash: "h",
	definition: `command ${name} (in /work/app)`,
	approvedAt: "2026-10-30T10:00:00.000Z",
});

describe("formatApprovals", () => {
	it("says there is nothing to show", () => {
		assert.equal(formatApprovals({ project: "/work/app", approved: [], pending: [] }), "Approvals for /work/app\n\nApproved: none\nPending: none");
	});

	it("lists each Approval with its definition and date, and each pending Ref with how to approve it", () => {
		const text = formatApprovals({
			project: "/work/app",
			approved: [{ approval: approval("tests"), status: "current" }],
			pending: [{ name: "lint", definition: "command eslint (in /work/app)" }],
		});
		assert.equal(
			text,
			[
				"Approvals for /work/app",
				"",
				"Approved (1):",
				"  tests  command tests (in /work/app)  approved 2026-10-30T10:00:00.000Z",
				"",
				"Pending (1):",
				"  lint  command eslint (in /work/app)  approve it with /ref approve lint",
			].join("\n"),
		);
	});

	it("says when an Approval no longer matches the Ref, or the Ref is gone", () => {
		const text = formatApprovals({
			project: "/work/app",
			approved: [
				{ approval: approval("changed"), status: "changed" },
				{ approval: approval("gone"), status: "removed" },
			],
			pending: [],
		});
		assert.match(text, /^ {2}changed {2}.*approved 2026.*; the Ref has changed since, so it is pending again$/m);
		assert.match(text, /^ {2}gone {2}.*approved 2026.*; the Ref is not in the Project library/m);
	});

	it("says why there is no Project library to look at in an untrusted project", () => {
		const text = formatApprovals({ project: "/work/app", approved: [], pending: [], untrusted: true });
		assert.match(text, /Project library: not loaded\. pi does not trust this project/);
	});

	it("writes control characters in a name as escapes", () => {
		const text = formatApprovals({ project: "/work/app", approved: [{ approval: approval("a\u001b[2Jb"), status: "current" }], pending: [] });
		assert.equal(/\p{Cc}/u.test(text.replace(/\n/g, "")), false);
	});
});
