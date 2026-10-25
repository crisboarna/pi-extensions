import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { matchGlob } from "../../src/util/glob.ts";
import { formatModelRef, parseModelRef, shiftThinking, splitAccountProvider } from "../../src/util/model-ref.ts";
import { newId, seededRng } from "../../src/util/runtime.ts";

describe("model refs", () => {
	it("parses provider, id and thinking", () => {
		assert.deepEqual(parseModelRef("prov/model-a:high"), { provider: "prov", id: "model-a", thinking: "high" });
		assert.deepEqual(parseModelRef("prov/model-a"), { provider: "prov", id: "model-a" });
	});

	it("keeps slashes and unknown suffixes inside the id", () => {
		assert.deepEqual(parseModelRef("gw/@cf/vendor/clf"), { provider: "gw", id: "@cf/vendor/clf" });
		assert.deepEqual(parseModelRef("gw/name:tag"), { provider: "gw", id: "name:tag" });
	});

	it("rejects strings that are not model refs", () => {
		assert.equal(parseModelRef("nomodel"), undefined);
		assert.equal(parseModelRef("/x"), undefined);
		assert.equal(parseModelRef("x/"), undefined);
	});

	it("round-trips through formatModelRef", () => {
		assert.equal(formatModelRef({ provider: "p", id: "m", thinking: "low" }), "p/m:low");
	});

	it("shifts thinking and clamps at the ends", () => {
		assert.equal(shiftThinking("medium", 1), "high");
		assert.equal(shiftThinking("high", 2), "xhigh");
		assert.equal(shiftThinking("low", -5), "off");
	});

	it("splits account providers only when the base exists", () => {
		const known = new Set(["acme"]);
		assert.deepEqual(splitAccountProvider("acme-2", (n) => known.has(n)), { base: "acme", index: 2 });
		assert.deepEqual(splitAccountProvider("model-9", (n) => known.has(n)), { base: "model-9" });
	});
});

describe("glob", () => {
	it("matches * and ? case-insensitively", () => {
		assert.ok(matchGlob("acme*", "ACME-2"));
		assert.ok(matchGlob("*/big-?", "p/big-1"));
		assert.ok(!matchGlob("acme", "acme-2"));
		assert.ok(matchGlob("a.b", "a.b") && !matchGlob("a.b", "axb"));
	});
});

describe("runtime helpers", () => {
	it("seeded rng repeats", () => {
		const a = seededRng(7);
		const b = seededRng(7);
		const xs = Array.from({ length: 5 }, () => a.next());
		assert.deepEqual(xs, Array.from({ length: 5 }, () => b.next()));
		assert.ok(xs.every((x) => x >= 0 && x < 1));
	});

	it("ids sort by time", () => {
		const rng = seededRng(1);
		const first = newId("d_", { now: () => 1_000 }, rng);
		const second = newId("d_", { now: () => 2_000 }, rng);
		assert.ok(first < second);
		assert.match(first, /^d_[0-9a-z]{18}$/u);
	});
});
