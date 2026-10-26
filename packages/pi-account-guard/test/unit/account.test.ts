import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { accountKey, describeAccount, sameAccount } from "../../src/core/account.ts";

const input = (overrides: Partial<Parameters<typeof accountKey>[0]> = {}) => ({
	provider: "acme",
	usingOAuth: false,
	status: { configured: true, source: "stored" },
	...overrides,
});

describe("accountKey", () => {
	it("names a stored login by oauth", () => {
		assert.deepEqual(accountKey(input({ usingOAuth: true })), { provider: "acme", source: "oauth" });
	});

	it("names a stored key by stored-key", () => {
		assert.deepEqual(accountKey(input()), { provider: "acme", source: "stored-key" });
	});

	it("names an environment variable by its name", () => {
		assert.deepEqual(accountKey(input({ status: { configured: true, source: "environment", label: "ACME_KEY" } })), { provider: "acme", source: "env:ACME_KEY" });
	});

	it("maps the model config and runtime sources", () => {
		assert.equal(accountKey(input({ status: { configured: true, source: "models_json_key" } })).source, "models-json-key");
		assert.equal(accountKey(input({ status: { configured: true, source: "models_json_command" } })).source, "models-json-command");
		assert.equal(accountKey(input({ status: { configured: true, source: "runtime" } })).source, "runtime");
		assert.equal(accountKey(input({ status: { configured: true, source: "fallback" } })).source, "fallback");
	});

	it("keeps the same provider id on different auth sources apart", () => {
		const login = accountKey(input({ usingOAuth: true }));
		const key = accountKey(input());
		const env = accountKey(input({ status: { configured: true, source: "environment", label: "ACME_KEY" } }));
		const otherEnv = accountKey(input({ status: { configured: true, source: "environment", label: "ACME_OTHER" } }));
		for (const [a, b] of [[login, key], [login, env], [key, env], [env, otherEnv]] as const) assert.equal(sameAccount(a, b), false);
		assert.equal(sameAccount(login, accountKey(input({ usingOAuth: true }))), true);
	});

	it("keeps a provider with no configured auth apart from every real source", () => {
		assert.deepEqual(accountKey(input({ status: { configured: false } })), { provider: "acme", source: "unconfigured" });
	});
});

describe("describeAccount", () => {
	it("shows the provider id and the source", () => {
		assert.equal(describeAccount({ provider: "acme", source: "oauth" }), "acme (oauth)");
	});
});
