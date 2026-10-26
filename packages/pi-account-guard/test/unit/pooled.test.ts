import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isPooledProvider, pooledProviderIds, pooledWarning } from "../../src/core/pooled.ts";

const MARKER = Symbol.for("pi-multiprovider.lifted-base");
const lifted = () => ({ [MARKER]: { id: "base" } });

describe("isPooledProvider", () => {
	it("is true for a provider with the pi-multiprovider marker", () => {
		assert.equal(isPooledProvider(lifted()), true);
	});

	it("is false for a plain provider and for no provider", () => {
		assert.equal(isPooledProvider({ id: "acme" }), false);
		assert.equal(isPooledProvider(undefined), false);
	});
});

describe("pooledProviderIds", () => {
	it("lists each pooled id once, in first-seen order", () => {
		const providers: Record<string, object> = { acme: {}, "pool-b": lifted(), "pool-a": lifted() };
		assert.deepEqual(pooledProviderIds(["pool-b", "acme", "pool-a", "pool-b"], (id) => providers[id]), ["pool-b", "pool-a"]);
	});

	it("lists nothing when no provider is pooled", () => {
		assert.deepEqual(pooledProviderIds(["acme"], () => ({})), []);
	});
});

describe("pooledWarning", () => {
	it("says the id pools several accounts and when to tag it", () => {
		assert.equal(pooledWarning("pool-a"), "pool-a pools several accounts (pi-multiprovider). Tag it only if all of them share one zone.");
	});
});
