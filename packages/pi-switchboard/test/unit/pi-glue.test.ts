import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	agentFromMessages,
	blendedPrice,
	catalogView,
	conflictingRouter,
	engineCatalog,
	estimateTokens,
	queryPlanPhase,
	type RegistryLike,
} from "../../src/router/pi-glue.ts";

const MODELS = [
	{ provider: "acme", id: "mid", contextWindow: 128_000, cost: { input: 2, output: 8 } },
	{ provider: "acme", id: "free" },
	{ provider: "zen", id: "one", cost: { output: 4 } },
];
function registry(oauthChecks: string[] = []): RegistryLike {
	return {
		find: (provider, id) => MODELS.find((m) => m.provider === provider && m.id === id),
		getAll: () => MODELS,
		getProvider: (name) => (name === "acme" || name === "zen" ? {} : undefined),
		getProviderAuthStatus: (provider) => ({ configured: provider === "acme" }),
		isUsingOAuth: (model: never) => {
			oauthChecks.push((model as { provider: string }).provider);
			return (model as { provider: string }).provider === "acme";
		},
	};
}

describe("catalogs", () => {
	it("blends prices 3:1 and leaves them out when the model has none", () => {
		assert.equal(blendedPrice({ input: 2, output: 8 }), 3.5);
		assert.equal(blendedPrice({ output: 4 }), 1);
		assert.equal(blendedPrice({}), undefined);
		assert.equal(blendedPrice(undefined), undefined);
	});

	it("reads windows, prices, auth and providers, and caches the OAuth check per provider", () => {
		const checks: string[] = [];
		const catalog = engineCatalog(registry(checks));
		assert.deepEqual(catalog.find("acme", "mid"), { contextWindow: 128_000, price: 3.5 });
		assert.deepEqual(catalog.find("acme", "free"), {});
		assert.equal(catalog.find("acme", "gone"), undefined);
		assert.equal(catalog.hasAuth("zen"), false);
		assert.equal(catalog.isProvider("nope"), false);
		assert.equal(catalog.subscription("acme"), true);
		assert.equal(catalog.subscription("acme"), true);
		assert.equal(catalog.subscription("ghost"), false);
		assert.deepEqual(checks, ["acme"]);
		const view = catalogView(registry());
		assert.deepEqual([view.find("acme", "mid"), view.find("acme", "free"), view.find("x", "y")], [{ contextWindow: 128_000 }, {}, undefined]);
		assert.deepEqual([view.hasAuth("acme"), view.isProvider("zen")], [true, true]);
	});
});

describe("queryPlanPhase", () => {
	it("returns the phase Plannotator reports, unknown for anything else, and answers only once", async () => {
		const answer = (response: unknown, twice = false) => ({
			emit: (_channel: string, data: unknown) => {
				const respond = (data as { respond(value: unknown): void }).respond;
				respond(response);
				if (twice) respond({ status: "handled", result: { phase: "idle" } });
			},
		});
		assert.equal(await queryPlanPhase(answer({ status: "handled", result: { phase: "planning" } }, true)), "planning");
		assert.equal(await queryPlanPhase(answer({ status: "handled", result: { phase: "dreaming" } })), "unknown");
		assert.equal(await queryPlanPhase(answer({ status: "unhandled" })), "unknown");
		assert.equal(await queryPlanPhase(answer(undefined)), "unknown");
	});

	it("is unknown when nobody answers or the bus throws", async () => {
		assert.equal(await queryPlanPhase({ emit: () => {} }, 5), "unknown");
		assert.equal(
			await queryPlanPhase({
				emit: () => {
					throw new Error("no bus");
				},
			}),
			"unknown",
		);
	});
});

describe("message helpers", () => {
	it("finds the agent name only in system messages", () => {
		assert.equal(agentFromMessages([{ role: "user", content: '<active_agent name="scout" />' }]), undefined);
		assert.equal(
			agentFromMessages([
				{ role: "system", content: "no agent" },
				{ role: "system", content: '<active_agent name="scout" />' },
			]),
			"scout",
		);
	});

	it("estimates tokens and survives values JSON cannot encode", () => {
		assert.equal(estimateTokens([{ text: "12345678" }]), Math.ceil('[{"text":"12345678"}]'.length / 4));
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		assert.equal(estimateTokens([circular]), 0);
	});
});

describe("conflictingRouter", () => {
	it("finds the conflicting router as a string or object package entry, and nothing otherwise", () => {
		const dir = mkdtempSync(join(tmpdir(), "switchboard-settings-"));
		assert.equal(conflictingRouter(dir), undefined, "no settings file");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "settings.json"), JSON.stringify({ packages: ["npm:pi-lens", { source: "npm:@alexeiled/pi-model-router" }] }));
		assert.equal(conflictingRouter(dir), "@alexeiled/pi-model-router");
		writeFileSync(join(dir, "settings.json"), JSON.stringify({ packages: [3, null, "npm:@alexeiled/pi-model-router@1"] }));
		assert.equal(conflictingRouter(dir), "@alexeiled/pi-model-router");
		writeFileSync(join(dir, "settings.json"), JSON.stringify({}));
		assert.equal(conflictingRouter(dir), undefined);
	});
});
