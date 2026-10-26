import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { BlockCause } from "../../src/core/decide.ts";
import { PROCESS_OVERRIDE_VARIABLE, processOverrideActive, processOverrideCovers } from "../../src/core/process-override.ts";

const account = { provider: "acme", source: "oauth" };
const place = { ok: true as const, path: "/p", zone: "personal" };

describe("processOverrideActive", () => {
	it("is on for the value 1 in print, json and rpc", () => {
		for (const mode of ["print", "json", "rpc"] as const) assert.equal(processOverrideActive("1", mode), true, mode);
	});

	it("is never on in the TUI, so a shell profile cannot silence the tag prompt", () => {
		assert.equal(processOverrideActive("1", "tui"), false);
	});

	it("is off for any other value, an unset variable and a mode it does not know", () => {
		for (const value of [undefined, "", "0", "true", "yes", " 1"]) assert.equal(processOverrideActive(value, "print"), false, String(value));
		assert.equal(processOverrideActive("1", undefined), false);
	});

	it("is named PI_ACCOUNT_GUARD_ALLOW_UNKNOWN", () => {
		assert.equal(PROCESS_OVERRIDE_VARIABLE, "PI_ACCOUNT_GUARD_ALLOW_UNKNOWN");
	});
});

describe("processOverrideCovers", () => {
	it("covers an Unknown account", () => {
		assert.equal(processOverrideCovers({ kind: "unknown-account", account, place }), true);
	});

	it("never covers a tagged account that fails to Match, nor an undecidable case", () => {
		const causes: BlockCause[] = [
			{ kind: "zone-mismatch", account, accountZones: ["work"], place },
			{ kind: "config-invalid", account, errors: [] },
			{ kind: "place-undecidable", account, reason: "git failed" },
			{ kind: "internal-error", account, reason: "boom" },
		];
		for (const cause of causes) assert.equal(processOverrideCovers(cause), false, cause.kind);
	});
});
