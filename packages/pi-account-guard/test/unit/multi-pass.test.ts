import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { multiPassLabel } from "../../src/core/multi-pass.ts";

const text = JSON.stringify({
	subscriptions: [
		{ provider: "acme", index: 2, label: "Work" },
		{ provider: "acme", index: 3 },
		{ provider: "beta", index: 1, label: 7 },
	],
});

describe("multiPassLabel", () => {
	it("finds the label of a provider id registered as <provider>-<index>", () => {
		assert.equal(multiPassLabel(text, "acme-2"), "Work");
	});

	it("has no label for a subscription without one, a label that is not text, or an unknown id", () => {
		assert.equal(multiPassLabel(text, "acme-3"), undefined);
		assert.equal(multiPassLabel(text, "beta-1"), undefined);
		assert.equal(multiPassLabel(text, "acme"), undefined);
	});

	it("has no label for a missing, malformed or differently shaped file", () => {
		assert.equal(multiPassLabel(undefined, "acme-2"), undefined);
		assert.equal(multiPassLabel("{ nope", "acme-2"), undefined);
		assert.equal(multiPassLabel("[]", "acme-2"), undefined);
		assert.equal(multiPassLabel('{"subscriptions":{"a":1}}', "acme-2"), undefined);
		assert.equal(multiPassLabel('{"subscriptions":[null,3]}', "acme-2"), undefined);
	});
});
