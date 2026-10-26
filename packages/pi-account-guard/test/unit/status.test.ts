import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_CONFIG } from "../../src/core/config.ts";
import { grantOnce, grantSession, NO_OVERRIDES } from "../../src/core/overrides.ts";
import { ruleText, statusText, type StatusInput } from "../../src/core/status.ts";

const anthropic = { provider: "anthropic", source: "oauth" };
const config = {
	...DEFAULT_CONFIG,
	accounts: [{ ...anthropic, zones: ["work"] }],
	places: [{ remote: "*/Acme/*", zone: "work" }, { path: "~/Projects/pi/**", zone: "personal" }],
};
const place = { ok: true as const, path: "/home/me/Projects/pi/diary", zone: "personal", ruleIndex: 1 };

const input = (over: Partial<StatusInput> = {}): StatusInput => ({
	home: "/home/me",
	configPath: "/home/me/.pi/agent/account-guard.json",
	cwd: "/home/me/Projects/pi/diary",
	place,
	account: anthropic,
	config: { ok: true, config },
	fallbackErrors: undefined,
	overrides: NO_OVERRIDES,
	pooledProviders: ["openai-pool"],
	untagged: [{ provider: "openai-codex-3", source: "oauth" }],
	...over,
});

describe("statusText", () => {
	it("prints the documented block", () => {
		assert.equal(
			statusText(input()),
			[
				"guard status",
				" Place     ~/Projects/pi/diary -> personal (rule 2: ~/Projects/pi/**)",
				" Account   anthropic (oauth) -> work  ✗ no Match",
				" Overrides session: none; allow-once: none",
				" Config    ~/.pi/agent/account-guard.json (valid)",
				" Zones     work, personal (default: personal)",
				" Pooled    pi-multiprovider: openai-pool (warns only)",
				" Untagged  openai-codex-3 (oauth)",
				"",
				"(edit: /guard tag | place | zone ...)",
			].join("\n"),
		);
	});

	it("says the default zone decided a place no rule matched", () => {
		assert.match(statusText(input({ place: { ok: true, path: "/home/me/x", zone: "personal" } })), /^ Place {5}~\/x -> personal \(default zone\)$/m);
	});

	it("shows a Match, an Unknown account and no model", () => {
		assert.match(statusText(input({ place: { ...place, zone: "work" } })), /^ Account {3}anthropic \(oauth\) -> work {2}✓ Match$/m);
		assert.match(statusText(input({ account: { provider: "new", source: "oauth" } })), /^ Account {3}new \(oauth\) -> unknown {2}\? Unknown \(no zone tag\)$/m);
		assert.match(statusText(input({ account: undefined })), /^ Account {3}no model selected$/m);
	});

	it("lists both Overrides", () => {
		const overrides = grantSession(grantOnce(NO_OVERRIDES, anthropic, place), anthropic, place);
		assert.match(statusText(input({ overrides })), /^ Overrides session: anthropic \(oauth\) in personal; allow-once: anthropic \(oauth\)$/m);
	});

	it("says none when nothing is pooled or untagged", () => {
		const text = statusText(input({ pooledProviders: [], untagged: [] }));
		assert.match(text, /^ Pooled {4}none$/m);
		assert.match(text, /^ Untagged {2}none$/m);
	});

	it("names the errors and the copy in use when the file is malformed", () => {
		const text = statusText(input({ fallbackErrors: [{ path: "accounts[0]", message: "must be an object" }] }));
		assert.match(text, /^ Config {4}~\/\.pi\/agent\/account-guard\.json \(invalid, last valid copy in use\)\n {11}account-guard\.json: accounts\[0\]: must be an object$/m);
		assert.match(text, /^ Zones {5}work, personal/m);
	});

	it("says there is no valid copy and the zone of the place is unknown", () => {
		const text = statusText(input({ config: { ok: false, errors: [{ path: "", message: "invalid JSON: x" }] }, place: { ok: false, reason: "the config is invalid" } }));
		assert.match(text, /^ Place {5}~\/Projects\/pi\/diary -> unknown \(the config is invalid\)$/m);
		assert.match(text, /^ Config {4}.* \(invalid, no valid copy, turns blocked\)\n {11}account-guard\.json: invalid JSON: x$/m);
		assert.match(text, /^ Zones {5}unknown \(config invalid\)$/m);
		assert.match(text, /^ Account {3}anthropic \(oauth\) -> unknown {2}! cannot decide$/m);
	});
});

describe("ruleText", () => {
	it("shows the path, the remote, or both", () => {
		assert.equal(ruleText({ path: "~/a", zone: "work" }), "~/a");
		assert.equal(ruleText({ remote: "*/x/*", zone: "work" }), "remote */x/*");
		assert.equal(ruleText({ path: "~/a", remote: "*/x/*", zone: "work" }), "~/a + remote */x/*");
	});
});
