import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkPath, checkText } from "../../src/core/check.ts";
import { DEFAULT_CONFIG } from "../../src/core/config.ts";
import { CHECK_USAGE, parseCheckArguments } from "../../src/core/guard-command.ts";

const acme = { provider: "acme", source: "env:ACME_KEY" };
const config = {
	...DEFAULT_CONFIG,
	accounts: [{ ...acme, zones: ["work"] }],
	places: [{ remote: "*/acme-corp/*", zone: "work" }],
};
const context = { home: "/home/me", configPath: "/home/me/.pi/agent/account-guard.json" };
const work = { ok: true as const, path: "/home/me/work/api", zone: "work", ruleIndex: 0 };
const personal = { ok: true as const, path: "/home/me/garden", zone: "personal" };

describe("/guard check arguments", () => {
	it("reads a path and an optional provider and source", () => {
		assert.deepEqual(parseCheckArguments(["~/work/api"]), { path: "~/work/api" });
		assert.deepEqual(parseCheckArguments(["here", "acme"]), { path: "here", provider: "acme" });
		assert.deepEqual(parseCheckArguments(["/srv", "acme", "oauth"]), { path: "/srv", provider: "acme", source: "oauth" });
		assert.equal(parseCheckArguments([]), undefined);
		assert.equal(parseCheckArguments(["a", "b", "c", "d"]), undefined);
		assert.match(CHECK_USAGE, /^\/guard check <path\|here> \[provider \[source\]\]$/);
	});

	it("resolves here, ~, absolute and relative paths against the session directory", () => {
		assert.equal(checkPath("here", "/home/me/garden", "/home/me"), "/home/me/garden");
		assert.equal(checkPath("~/work/api", "/home/me/garden", "/home/me"), "/home/me/work/api");
		assert.equal(checkPath("/srv/app", "/home/me/garden", "/home/me"), "/srv/app");
		assert.equal(checkPath("../work/api/", "/home/me/garden", "/home/me"), "/home/me/work/api");
	});
});

describe("/guard check text", () => {
	it("names the deciding rule, the zone, the account and that a turn would go", () => {
		const text = checkText({ ...context, place: work, account: acme, config });
		assert.equal(
			text,
			[
				"guard check (nothing is written)",
				" Place     ~/work/api -> work (rule 1: remote */acme-corp/*)",
				" Account   acme (env:ACME_KEY) -> work  ✓ Match",
				" Verdict   a turn here would go",
			].join("\n"),
		);
	});

	it("says a turn would be blocked, or ask for a tag first, and why", () => {
		assert.match(
			checkText({ ...context, place: personal, account: acme, config }),
			/Place {5}~\/garden -> personal \(default zone\)[\s\S]*Verdict {3}a turn here would be blocked: acme \(env:ACME_KEY\) is zone work, this place is personal/,
		);
		const spare = { provider: "spare", source: "oauth" };
		assert.match(
			checkText({ ...context, place: personal, account: spare, config }),
			/Verdict {3}the tag prompt would ask for the zones of spare \(oauth\) first/,
		);
	});

	it("says when it cannot decide, and when there is no account", () => {
		const unknown = { ok: false as const, reason: "git failed" };
		assert.match(
			checkText({ ...context, place: unknown, account: acme, config }),
			/Place {5}unknown \(git failed\)[\s\S]*Verdict {3}a turn here would be blocked: cannot decide this place's zone \(git failed\)/,
		);
		assert.match(
			checkText({ ...context, place: work, account: undefined, config }),
			/Account {3}no model selected[\s\S]*Verdict {3}no account to check: select a model, or name one/,
		);
	});
});
