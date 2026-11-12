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

describe("/guard check text for a virtual model whose router lists its members", () => {
	const virtual = { provider: "switchboard", source: "env:virtual" };
	const spare = { provider: "spare", source: "oauth" };
	const tagged = {
		...config,
		accounts: [
			{ ...acme, zones: ["work"] },
			{ ...spare, zones: ["personal"] },
		],
	};
	const member = (provider: string, account: typeof acme | undefined) => ({ ref: { provider, id: "mid" }, account });

	it("lists each member with its account and decides on all of them", () => {
		const text = checkText({ ...context, place: work, account: virtual, config, members: { status: "members", members: [member("acme", acme)] } });
		assert.equal(
			text,
			[
				"guard check (nothing is written)",
				" Place     ~/work/api -> work (rule 1: remote */acme-corp/*)",
				" Account   switchboard (env:virtual) -> unknown  ? Unknown (no zone tag)",
				" Members   acme/mid: acme (env:ACME_KEY) -> work  ✓ Match",
				" Verdict   a turn here would go",
			].join("\n"),
		);
	});

	it("names the member whose account is in another zone", () => {
		const text = checkText({
			...context,
			place: work,
			account: virtual,
			config: tagged,
			members: { status: "members", members: [member("acme", acme), member("spare", spare)] },
		});
		assert.match(text, /Members {3}acme\/mid: acme \(env:ACME_KEY\) -> work {2}✓ Match\n {11}spare\/mid: spare \(oauth\) -> personal {2}✗ no Match/u);
		assert.match(text, /Verdict {3}a turn here would be blocked: spare \(oauth\) is zone personal, this place is work$/u);
	});

	it("blocks on a member pi does not list, and on a router that cannot list its members", () => {
		const unlisted = checkText({
			...context,
			place: work,
			account: virtual,
			config,
			members: { status: "members", members: [member("ghost", undefined)] },
		});
		assert.match(unlisted, /Members {3}ghost\/mid: not listed by pi {2}! cannot decide/u);
		assert.match(unlisted, /Verdict {3}a turn here would be blocked: switchboard routes to ghost\/mid, which pi does not list$/u);
		const invalid = checkText({
			...context,
			place: work,
			account: virtual,
			config,
			members: { status: "invalid", reason: "switchboard could not list its members: config is invalid" },
		});
		assert.match(invalid, /Members {3}unknown \(switchboard could not list its members: config is invalid\)/u);
		assert.match(invalid, /Verdict {3}a turn here would be blocked: switchboard could not list its members: config is invalid$/u);
	});
});
