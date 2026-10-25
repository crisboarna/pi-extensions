import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { mergeProposal, profileName, proposeConfig, rankModels } from "../../src/autotier/propose.ts";
import { normalizeConfig } from "../../src/config/normalize.ts";

const models = [
	{ provider: "acme", id: "acme-pro", cost: { input: 15, output: 75 }, contextWindow: 200_000 },
	{ provider: "acme", id: "acme-mid", cost: { input: 3, output: 15 }, contextWindow: 200_000 },
	{ provider: "acme", id: "acme-mini", cost: { input: 1, output: 5 }, contextWindow: 200_000 },
	{ provider: "zen", id: "zen-large", contextWindow: 400_000 },
	{ provider: "zen", id: "zen-flash", contextWindow: 400_000 },
	{ provider: "acme-2", id: "acme-pro", cost: { input: 15, output: 75 } },
	{ provider: "llama.cpp", id: "local-7b", contextWindow: 32_000 },
];

describe("auto-tiering", () => {
	it("ranks by price, then name hints, then context window", () => {
		assert.deepEqual(rankModels(models.slice(0, 3)).map((m) => m.id), ["acme-mini", "acme-mid", "acme-pro"]);
		assert.deepEqual(rankModels(models.slice(3, 5)).map((m) => m.id), ["zen-flash", "zen-large"], "unpriced models fall back to hints");
		assert.deepEqual(rankModels([{ provider: "x", id: "a", contextWindow: 8_000 }, { provider: "x", id: "b", contextWindow: 4_000 }]).map((m) => m.id), ["b", "a"]);
		assert.deepEqual(rankModels([{ provider: "x", id: "custom-one" }, { provider: "x", id: "custom-two" }], { large: ["one"] }).map((m) => m.id), ["custom-two", "custom-one"]);
	});

	it("proposes a profile per provider plus a mixed profile, skipping extra accounts", () => {
		const config = proposeConfig(models, { current: "zen/zen-large", isAccount: (p) => p === "acme-2" });
		assert.deepEqual(Object.keys(config.profiles ?? {}), ["acme", "llama-cpp", "zen", "all"]);
		assert.deepEqual(config.profiles?.acme?.tiers, {
			light: { rank: 1, members: ["acme/acme-mini:low"] },
			standard: { rank: 2, members: ["acme/acme-mid:medium"] },
			deep: { rank: 3, members: ["acme/acme-pro:high"] },
		});
		assert.deepEqual(Object.keys(config.profiles?.zen?.tiers ?? {}), ["light", "deep"], "two models, two tiers");
		assert.deepEqual(Object.keys(config.profiles?.["llama-cpp"]?.tiers ?? {}), ["standard"], "one model, one tier");
		assert.equal(config.profileSelection?.default, "zen");
		assert.deepEqual(config.profileSelection?.rules?.map((r) => r.matchProvider), ["acme*", "llama.cpp*", "zen*"]);
		assert.deepEqual(normalizeConfig(config).invalidProfiles, {}, "the proposal is a valid config");
	});

	it("adds profiles to an existing config without changing it", () => {
		const merged = mergeProposal({ profiles: { acme: { tiers: { only: { rank: 1, members: ["acme/acme-mid"] } } } }, profileSelection: { default: "acme" } }, proposeConfig(models));
		assert.deepEqual(Object.keys(merged.profiles?.acme?.tiers ?? {}), ["only"]);
		assert.ok(merged.profiles?.zen);
		assert.equal(merged.profileSelection?.default, "acme");
	});

	it("names profiles with the config's pattern", () => {
		assert.equal(profileName("Llama.CPP"), "llama-cpp");
	});

	it("keeps the hint list to single words", () => {
		const source = readFileSync(join(import.meta.dirname, "..", "..", "src", "autotier", "hints.ts"), "utf8");
		const words = [...source.matchAll(/"([^"]+)"/gu)].map((m) => m[1] ?? "");
		assert.ok(words.length > 5);
		for (const word of words) assert.match(word, /^[a-z]+$/u, `${word} is not a single lowercase word`);
	});
});
