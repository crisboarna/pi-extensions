import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeConfig } from "../../src/config/normalize.ts";
import type { RawConfig } from "../../src/config/types.ts";
import { answerMembers, MEMBERS_CHANNEL, routableMembers } from "../../src/router/members.ts";

const RAW: RawConfig = {
	profiles: {
		work: { tiers: { light: { rank: 1, members: ["acme/small"] }, deep: { rank: 2, members: ["acme/big:high", "zen/big"] } } },
		home: { tiers: { only: { rank: 1, members: ["solo/mid", { model: "off/mid", enabled: false }] } } },
	},
	profileSelection: { default: "work" },
};
const providers = new Set(["acme", "acme-2", "zen", "solo", "off"]);
const isProvider = (name: string) => providers.has(name);
const subscriptions = [{ provider: "acme", index: 2 }] as never;
const list = (raw: RawConfig, id: string) => routableMembers(normalizeConfig(raw), id, subscriptions, isProvider)?.map((m) => `${m.provider}/${m.id}`);

describe("routableMembers", () => {
	it("lists every enabled member of every profile for the auto model, with the account siblings failover may use", () => {
		assert.deepEqual(list(RAW, "auto"), ["acme/small", "acme-2/small", "acme/big", "acme-2/big", "zen/big", "solo/mid"]);
	});

	it("lists the whole profile for a profile model and for a tier model, since a tier may borrow from the others", () => {
		assert.deepEqual(list(RAW, "home"), ["solo/mid"]);
		assert.deepEqual(list(RAW, "work.light"), ["acme/small", "acme-2/small", "acme/big", "acme-2/big", "zen/big"]);
	});

	it("leaves the siblings out when neither failover nor subagent affinity can reach them", () => {
		const raw = { ...RAW, failover: { accountSiblings: "off" as const }, subagents: { accountAffinity: "none" as const } };
		assert.deepEqual(list(raw, "work"), ["acme/small", "acme/big", "zen/big"]);
	});

	it("answers nothing for a model that is not its own", () => {
		assert.equal(list(RAW, "nope"), undefined);
		assert.equal(list(RAW, "nope.light"), undefined);
	});
});

describe("answerMembers", () => {
	const config = normalizeConfig(RAW);
	const ask = (request: unknown, members = () => routableMembers(config, (request as { id: string }).id, subscriptions, isProvider)) => {
		const answers: unknown[] = [];
		answerMembers({ ...(request as object), respond: (value: unknown) => answers.push(value) > 0 }, config.virtualModel.provider, members);
		return answers;
	};

	it("uses the channel the guard listens on", () => {
		assert.equal(MEMBERS_CHANNEL, "switchboard:members:v1");
	});

	it("answers for its own virtual model", () => {
		assert.deepEqual(ask({ provider: "switchboard", id: "home" }), [{ members: [{ provider: "solo", id: "mid" }] }]);
	});

	it("stays silent for a physical model or another provider's", () => {
		assert.deepEqual(ask({ provider: "acme", id: "small" }), []);
		assert.deepEqual(ask({ provider: "switchboard", id: "nope" }), []);
	});

	it("answers with an error rather than throwing, so the guard Blocks instead of seeing silence", () => {
		const broken = () => {
			throw new Error("config is invalid");
		};
		assert.deepEqual(ask({ provider: "switchboard", id: "auto" }, broken), [{ error: "config is invalid" }]);
	});

	it("ignores a request that is not shaped like one", () => {
		for (const request of [null, "x", { provider: "switchboard" }, { provider: "switchboard", id: "auto", respond: "no" }])
			assert.doesNotThrow(() => answerMembers(request, "switchboard", () => []));
	});
});
