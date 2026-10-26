import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { BlockCause } from "../../src/core/decide.ts";
import { configFallbackWarning, handlerErrorNotice, headlessBlockMessage, processOverrideWarning } from "../../src/core/messages.ts";

const context = { home: "/home/me", configPath: "/home/me/.pi/agent/account-guard.json" };
const account = { provider: "acme", source: "oauth" };
const place = { ok: true as const, path: "/home/me/Projects/diary", zone: "personal" };

describe("headlessBlockMessage", () => {
	it("names the account, its zones, the place and its zone, and the fixes", () => {
		const cause: BlockCause = { kind: "zone-mismatch", account, accountZones: ["work"], place };
		assert.equal(
			headlessBlockMessage(cause, context),
			[
				"BLOCKED acme (oauth) is zone work; this place",
				"(~/Projects/diary) is zone personal. No turn was sent.",
				"",
				"Fix, any one of:",
				"  pi --model <an account in zone personal>",
				"  add a place rule if this directory belongs to zone work",
				"    in ~/.pi/agent/account-guard.json",
				"",
			].join("\n"),
		);
	});

	it("lists several account zones", () => {
		const cause: BlockCause = { kind: "zone-mismatch", account, accountZones: ["work", "lab"], place };
		const message = headlessBlockMessage(cause, context);
		assert.match(message, /^BLOCKED acme \(oauth\) is zones work, lab; this place/);
		assert.match(message, /belongs to zone work or lab\n/);
	});

	it("shows a config path outside the home directory in full", () => {
		const cause: BlockCause = { kind: "zone-mismatch", account, accountZones: ["work"], place };
		assert.match(
			headlessBlockMessage(cause, { home: "/home/me", configPath: "/tmp/agent/account-guard.json" }),
			/\n {4}in \/tmp\/agent\/account-guard\.json\n/,
		);
	});

	it("tells the user how to tag an unknown account", () => {
		const cause: BlockCause = { kind: "unknown-account", account, place };
		assert.equal(
			headlessBlockMessage(cause, context),
			[
				"BLOCKED acme (oauth) has no zone tag; place zone is personal.",
				"Add to ~/.pi/agent/account-guard.json accounts:",
				'  {"provider":"acme","source":"oauth","zones":["personal"]}',
				"or run pi, then: /guard tag acme oauth personal",
				"or set PI_ACCOUNT_GUARD_ALLOW_UNKNOWN=1 for this process.",
				"",
			].join("\n"),
		);
	});

	it("names the file and the error for an invalid config", () => {
		const cause: BlockCause = {
			kind: "config-invalid",
			account,
			errors: [
				{ path: "accounts[0]", message: "bad" },
				{ path: "", message: "invalid JSON: x" },
			],
		};
		assert.equal(
			headlessBlockMessage(cause, context),
			[
				"BLOCKED acme (oauth): cannot read ~/.pi/agent/account-guard.json. No turn was sent.",
				"  account-guard.json: accounts[0]: bad",
				"  account-guard.json: invalid JSON: x",
				"Fix the file, then run pi again.",
				"",
			].join("\n"),
		);
	});

	it("names the cause when the place zone is undecidable", () => {
		const cause: BlockCause = { kind: "place-undecidable", account, reason: "cannot resolve /gone" };
		assert.equal(
			headlessBlockMessage(cause, context),
			["BLOCKED acme (oauth): cannot decide this place's zone (cannot resolve /gone). No turn was sent.", ""].join("\n"),
		);
	});

	it("names an internal error as the cause", () => {
		const cause: BlockCause = { kind: "internal-error", account, reason: "boom" };
		assert.equal(headlessBlockMessage(cause, context), ["BLOCKED: the guard failed (boom). No turn was sent.", ""].join("\n"));
	});
});

describe("configFallbackWarning", () => {
	it("names the file, each error and the last valid copy", () => {
		assert.equal(
			configFallbackWarning([{ path: "accounts[1]", message: "bad" }], context),
			[
				"guard: cannot read ~/.pi/agent/account-guard.json; using the last valid copy for this session.",
				"  account-guard.json: accounts[1]: bad",
				"The guard does not write to the file until it is fixed.",
			].join("\n"),
		);
	});
});

describe("handlerErrorNotice", () => {
	it("names the handler and the reason", () => {
		assert.equal(handlerErrorNotice("session_start", "boom"), "guard: the session_start handler failed (boom).");
	});
});

describe("processOverrideWarning", () => {
	it("names the variable, the first account let through and that every turn is logged", () => {
		assert.equal(
			processOverrideWarning(account),
			"guard: PI_ACCOUNT_GUARD_ALLOW_UNKNOWN=1 lets turns through to accounts with no zone tag, starting with acme (oauth). Each turn is logged in the session.",
		);
	});
});
