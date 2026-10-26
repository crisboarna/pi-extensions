import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ClassifyFn } from "../../src/classifier/chain.ts";
import type { TranscriptMessage } from "../../src/classifier/evidence.ts";
import { normalizeConfig } from "../../src/config/normalize.ts";
import type { RawConfig } from "../../src/config/types.ts";
import { type EngineDeps, ExhaustedError, type RouteInput, type RouterState, SwitchboardEngine } from "../../src/router/engine.ts";
import type { Answers } from "../../src/rules/types.ts";
import { MemoryHealthStore } from "../../src/selection/health.ts";
import { seededRng } from "../../src/util/runtime.ts";

const RAW: RawConfig = {
	classifiers: [{ model: "local/judge", timeoutMs: 500, threshold: 0.8 }],
	profiles: {
		main: {
			tiers: {
				light: { rank: 1, members: ["acme/small:low"] },
				standard: { rank: 2, members: ["acme/mid", "zen/mid:medium"], strategy: "ordered" },
				deep: { rank: 3, members: ["acme/big:high"] },
			},
			fallbackTier: "standard",
			baselineTier: "light",
		},
		other: { tiers: { only: { rank: 1, members: ["zen/one"] } } },
	},
	profileSelection: { default: "main", rules: [{ matchProvider: "zen*", profile: "other" }] },
	subagents: { agents: { scout: { maxTier: "standard" } } },
};

const WINDOWS: Record<string, number> = {
	"acme/small": 32_000,
	"acme/mid": 128_000,
	"zen/mid": 128_000,
	"acme/big": 400_000,
	"zen/one": 64_000,
	"acme-2/mid": 128_000,
};

function answers(work: string, workConfidence = 0.95, depth = 1, risky = 0.1): Answers {
	return {
		work: { type: "choice", choice: work, probabilities: {}, confidence: workConfidence },
		depth: { type: "score", score: depth, confidence: 0.4 },
		risky: { type: "bool", probability: risky },
	};
}

function engine(options: { classify?: ClassifyFn; raw?: RawConfig; now?: () => number } = {}) {
	const config = normalizeConfig(options.raw ?? RAW);
	let now = Date.UTC(2026, 9, 25, 12);
	const deps: EngineDeps = {
		config,
		missingConfig: false,
		catalog: {
			find: (provider, id) => {
				const contextWindow = WINDOWS[`${provider}/${id}`];
				return contextWindow ? { contextWindow } : undefined;
			},
			hasAuth: () => true,
			isProvider: (name) => ["acme", "acme-2", "zen"].includes(name),
			subscription: () => true,
		},
		store: new MemoryHealthStore(),
		classify: options.classify ?? (async () => ({ stopReason: "stop", answers: answers("implement") })),
		clock: { now: options.now ?? (() => now) },
		rng: seededRng(3),
		cwd: "/work/repo",
		home: "/home/dev",
		planPhase: async () => "executing",
		globalProfile: () => undefined,
		subscriptions: () => [{ provider: "acme", index: 2 }],
	};
	const e = new SwitchboardEngine(deps);
	return { e, deps, advance: (ms: number) => (now += ms) };
}

const user = (text: string): TranscriptMessage => ({ role: "user", content: text });
const toolError = (tool: string): TranscriptMessage => ({ role: "toolResult", toolName: tool, isError: true, content: [{ type: "text", text: "failed" }] });

function input(extra: Partial<RouteInput> = {}): RouteInput {
	return { virtualId: "auto", selectedThinking: "medium", reason: "user", messages: [user("do the thing")], scope: "main", ...extra };
}

describe("engine: user turns", () => {
	it("classifies, applies rules and picks a member of the tier", async () => {
		const { e } = engine({ classify: async () => ({ stopReason: "stop", answers: answers("plan") }) });
		const out = await e.route(input());
		assert.deepEqual([out.provider, out.id, out.thinking], ["acme", "big", "high"]);
		assert.equal(out.decision?.kind, "classified");
		assert.equal(out.decision?.tier.chosen, "deep");
		assert.equal(out.decision?.rules?.gate.threshold, 0.8, "classifier threshold applies");
		assert.equal(out.state?.tier, "deep");
		assert.equal(out.state?.task, 1);
		assert.ok(out.decision?.evidence?.digest);
	});

	it("shifts thinking by the selected level", async () => {
		const { e } = engine({ classify: async () => ({ stopReason: "stop", answers: answers("plan") }) });
		const out = await e.route(input({ selectedThinking: "low" }));
		assert.equal(out.thinking, "medium", "high shifted down one step");
	});

	it("falls back when the classifier fails and records why", async () => {
		const { e } = engine({ classify: async () => ({ stopReason: "error", errorMessage: "connection refused" }) });
		const out = await e.route(input());
		assert.equal(out.decision?.tier.chosen, "standard");
		assert.equal(out.decision?.kind, "fallback");
		assert.equal(out.decision?.classifier?.failure, "classifier-error");
		assert.equal(out.decision?.classifier?.attempts[0]?.error, "connection refused");
	});

	it("uses the baseline tier in dry-run but still classifies", async () => {
		const { e } = engine({ classify: async () => ({ stopReason: "stop", answers: answers("plan") }) });
		e.controls.dryRun = true;
		const out = await e.route(input());
		assert.equal(out.decision?.tier.chosen, "light");
		assert.equal(out.decision?.tier.candidate, "deep");
		assert.equal(out.decision?.dryRun, true);
	});

	it("skips the classifier when pinned", async () => {
		let calls = 0;
		const { e } = engine({
			classify: async () => {
				calls++;
				return { stopReason: "stop", answers: answers("plan") };
			},
		});
		e.controls.pin = { target: "@bottom", subagents: false };
		const out = await e.route(input());
		assert.equal(out.decision?.kind, "pinned");
		assert.equal(out.id, "small");
		assert.equal(calls, 0);
	});

	it("selects the profile from the origin model", async () => {
		const { e } = engine();
		e.originModel = "zen/whatever";
		const out = await e.route(input());
		assert.equal(out.decision?.profile.name, "other");
		assert.equal(out.decision?.profile.source, "match");
	});

	it("routes a tier-pinned model in a subagent without classifying, capped tiers ignored for pinned", async () => {
		let calls = 0;
		const { e } = engine({
			classify: async () => {
				calls++;
				return { stopReason: "stop", answers: answers("plan") };
			},
		});
		const out = await e.route(input({ virtualId: "main.light", scope: "subagent", agent: "scout" }));
		assert.equal(out.decision?.kind, "launch-tier");
		assert.equal(out.decision?.tier.chosen, "light");
		assert.equal(calls, 0);
	});

	it("is inactive without profiles: uses the previous model, or explains", async () => {
		const { e } = engine({ raw: {} });
		const out = await e.route(input({ previous: { provider: "acme", id: "mid", thinking: "high" } }));
		assert.equal(out.decision?.kind, "inactive");
		assert.equal(out.id, "mid");
		await assert.rejects(e.route(input()), /inactive: no profiles configured/u);
	});
});

describe("engine: in-flight leases", () => {
	const limited: RawConfig = {
		...RAW,
		profiles: {
			main: {
				tiers: {
					light: { rank: 1, members: ["acme/small"] },
					standard: { rank: 2, members: [{ model: "acme/mid", maxConcurrency: 1 }, "zen/mid"], strategy: "ordered" },
					deep: { rank: 3, members: ["acme/big"] },
				},
				fallbackTier: "standard",
			},
		},
	};
	const leasesOn = (store: MemoryHealthStore, key: string) => store.read().members[key]?.leases?.length ?? 0;

	it("holds a lease while a request streams and releases it when the request ends", async () => {
		const { e, deps } = engine();
		await e.route(input());
		e.beginRequest();
		assert.equal(leasesOn(deps.store as MemoryHealthStore, "acme/mid"), 1);
		e.beginRequest();
		assert.equal(leasesOn(deps.store as MemoryHealthStore, "acme/mid"), 1, "a new request replaces the lease");
		e.endRequest();
		assert.equal(leasesOn(deps.store as MemoryHealthStore, "acme/mid"), 0);
		e.endRequest();
	});

	it("lets another process see the request in flight and respect maxConcurrency", async () => {
		const first = engine({ raw: limited });
		await first.e.route(input());
		first.e.beginRequest();
		const second = engine({ raw: limited });
		second.deps.store = first.deps.store;
		const out = await second.e.route(input());
		assert.deepEqual([out.provider, out.id], ["zen", "mid"], "acme/mid is at its concurrency limit");
		first.e.endRequest();
		const third = engine({ raw: limited });
		third.deps.store = first.deps.store;
		assert.equal((await third.e.route(input())).provider, "acme", "free again once the request ended");
	});

	it("selects launch-mode members with the tier's strategy and health, and leases them", async () => {
		const raw: RawConfig = {
			...RAW,
			profiles: {
				main: {
					tiers: {
						light: { rank: 1, members: ["acme/small"] },
						standard: { rank: 2, members: ["acme/mid", "zen/mid", "acme-2/mid"], strategy: { name: "round-robin", granularity: "request" } },
						deep: { rank: 3, members: ["acme/big"] },
					},
				},
			},
		};
		const { e, deps } = engine({ raw });
		const profile = e.config.profiles.main;
		assert.ok(profile);
		const picks = [0, 1, 2, 3].map((task) => {
			const selected = e.selectForLaunch(profile, "standard", task, undefined);
			assert.ok(selected.ok);
			return selected.ok ? selected.member.key : "";
		});
		assert.deepEqual(picks, ["acme/mid", "zen/mid", "acme-2/mid", "acme/mid"], "round robin across launches");
		assert.equal(leasesOn(deps.store as MemoryHealthStore, "zen/mid"), 1, "each launch holds a lease");
		// The first member is cooling down: launches skip it.
		e.prepareFailover({ provider: "acme", id: "mid" }, "usage limit reached");
		const skipped = e.selectForLaunch(profile, "standard", 9, undefined);
		assert.ok(skipped.ok && skipped.member.provider !== "acme");
	});
});

describe("engine: remote classifiers", () => {
	it("never sends request text to a remote classifier without allowRemote, and falls back with the reason", async () => {
		const seen: string[] = [];
		const raw: RawConfig = { ...RAW, classifiers: [{ model: "cloud/judge", timeoutMs: 500 }] };
		const { e, deps } = engine({
			raw,
			classify: async (model) => {
				seen.push(model);
				return { stopReason: "stop", answers: answers("plan") };
			},
		});
		deps.isLocalClassifier = (model) => model.startsWith("local/");
		const out = await e.route(input());
		assert.equal(seen.length, 0, "the remote classifier was never called");
		assert.equal(out.decision?.kind, "fallback");
		assert.match(out.decision?.classifier?.attempts[0]?.error ?? "", /allowRemote/u);

		const allowed = engine({
			raw: { ...RAW, classifiers: [{ model: "cloud/judge", timeoutMs: 500, allowRemote: true }] },
			classify: async (model) => {
				seen.push(model);
				return { stopReason: "stop", answers: answers("plan") };
			},
		});
		allowed.deps.isLocalClassifier = () => false;
		assert.equal((await allowed.e.route(input())).decision?.kind, "classified");
		assert.deepEqual(seen, ["cloud/judge"]);
	});
});

describe("engine: continuation, escalation, retry and direct", () => {
	async function started(classifyWork = "implement") {
		const ctx = engine({ classify: async () => ({ stopReason: "stop", answers: answers(classifyWork) }) });
		const first = await ctx.e.route(input());
		return { ...ctx, state: first.state as RouterState, first };
	}

	it("keeps the previous model on continuation", async () => {
		const { e, state } = await started();
		const out = await e.route(input({ reason: "continuation", state, previous: { provider: "acme", id: "mid", thinking: "medium" } }));
		assert.deepEqual([out.id, out.thinking, out.state, out.decision], ["mid", "medium", undefined, undefined]);
	});

	it("escalates one rank after the same tool fails twice, once per task", async () => {
		const { e, state } = await started();
		const messages = [user("go"), toolError("bash"), toolError("bash")];
		const out = await e.route(input({ reason: "continuation", state, messages, previous: { provider: "acme", id: "mid" } }));
		assert.equal(out.decision?.kind, "escalated");
		assert.equal(out.id, "big");
		const again = await e.route(
			input({ reason: "continuation", state: out.state, messages: [...messages, toolError("bash")], previous: { provider: "acme", id: "big" } }),
		);
		assert.equal(again.decision, undefined, "no second escalation in the same task");
	});

	it("caps a subagent's escalation at its maximum tier", async () => {
		const { e } = engine();
		const first = await e.route(input({ virtualId: "main.standard", scope: "subagent", agent: "scout" }));
		const out = await e.route(
			input({
				reason: "continuation",
				scope: "subagent",
				agent: "scout",
				state: first.state,
				messages: [user("x"), toolError("a"), toolError("a")],
				previous: { provider: "acme", id: "mid" },
			}),
		);
		assert.equal(out.decision, undefined, "already at scout's maximum");
	});

	it("fails over to the next member on a rate limit and keeps the tier", async () => {
		const { e, state } = await started();
		const out = await e.route(
			input({ reason: "retry", state, failed: { provider: "acme", id: "mid", errorMessage: "429 Too Many Requests. Retry-After: 30" } }),
		);
		assert.equal(out.decision?.kind, "failover");
		assert.deepEqual([out.provider, out.id], ["zen", "mid"]);
		assert.equal(out.decision?.error?.class, "rate-limit");
		assert.equal(out.state?.tier, "standard");
	});

	it("benches a rate-limited member for the tier's cooldown.defaultMs when the provider gives no time", async () => {
		const raw: RawConfig = {
			...RAW,
			profiles: {
				main: {
					...RAW.profiles!.main!,
					tiers: {
						...RAW.profiles!.main!.tiers,
						standard: { rank: 2, members: ["acme/mid", "zen/mid:medium"], strategy: "ordered", cooldown: { defaultMs: 90_000 } },
					},
				},
			},
		};
		const { e, deps } = engine({ raw });
		const first = await e.route(input());
		const out = await e.route(
			input({ reason: "retry", state: first.state, failed: { provider: "acme", id: "mid", errorMessage: "429 Too Many Requests" } }),
		);
		assert.equal(out.decision?.error?.benchedUntil, new Date(deps.clock.now() + 90_000).toISOString());
		const explicit = await e.route(
			input({ reason: "retry", state: out.state, failed: { provider: "zen", id: "mid", errorMessage: "429 Too Many Requests. Retry-After: 20" } }),
		);
		assert.equal(explicit.decision?.error?.benchedUntil, new Date(deps.clock.now() + 20_000).toISOString(), "the provider's own time wins");
	});

	it("retries the same member on a first overload", async () => {
		const { e, state } = await started();
		const out = await e.route(input({ reason: "retry", state, failed: { provider: "acme", id: "mid", errorMessage: "529 overloaded_error" } }));
		assert.deepEqual([out.provider, out.id, out.decision], ["acme", "mid", undefined]);
	});

	it("borrows a higher tier when the whole tier is cooling down, then gives up with the earliest reset", async () => {
		const { e, state } = await started();
		const first = await e.route(input({ reason: "retry", state, failed: { provider: "acme", id: "mid", errorMessage: "rate limit" } }));
		const second = await e.route(input({ reason: "retry", state: first.state, failed: { provider: "zen", id: "mid", errorMessage: "rate limit" } }));
		assert.equal(second.decision?.kind, "borrowed");
		assert.equal(second.id, "big");
		const third = await e.route(input({ reason: "retry", state: second.state, failed: { provider: "acme", id: "big", errorMessage: "rate limit" } }));
		assert.equal(third.id, "small", "then borrows down");
		await assert.rejects(
			e.route(input({ reason: "retry", state: third.state, failed: { provider: "acme", id: "small", errorMessage: "rate limit" } })),
			ExhaustedError,
		);
	});

	it("uses an account sibling first when enabled", async () => {
		const raw = { ...RAW, failover: { accountSiblings: "on" as const } };
		const { e } = engine({ raw, classify: async () => ({ stopReason: "stop", answers: answers("implement") }) });
		const first = await e.route(input());
		const out = await e.route(input({ reason: "retry", state: first.state, failed: { provider: "acme", id: "mid", errorMessage: "rate limit" } }));
		assert.deepEqual([out.provider, out.id], ["acme-2", "mid"]);
		assert.equal(out.decision?.model.account, "acme-2");
	});

	it("records a quota failure that pi would not retry and fails over on the rewritten retry", async () => {
		const { e, state } = await started();
		const prepared = e.prepareFailover({ provider: "acme", id: "mid" }, "You have hit your ChatGPT usage limit (team plan). Try again in ~30 min.");
		assert.deepEqual(prepared, { errorClass: "quota", canFailOver: true });
		const out = await e.route(
			input({ reason: "retry", state, failed: { provider: "acme", id: "mid", errorMessage: "pi-switchboard: service temporarily unavailable" } }),
		);
		assert.equal(out.decision?.error?.class, "quota", "the original class wins over the rewritten text");
		assert.equal(out.id, "mid");
		assert.equal(out.provider, "zen");
	});

	it("benches the whole account on a usage limit, so other tiers on that account are skipped", async () => {
		const { e } = engine({ classify: async () => ({ stopReason: "stop", answers: answers("mechanical", 0.95, 0.1) }) });
		const first = await e.route(input());
		assert.equal(first.id, "small");
		const out = await e.route(
			input({
				reason: "retry",
				state: first.state,
				failed: { provider: "acme", id: "small", errorMessage: "Codex error: The usage limit has been reached" },
			}),
		);
		assert.equal(out.decision?.kind, "borrowed");
		assert.deepEqual([out.provider, out.id], ["zen", "mid"], "acme/mid is on the same exhausted account");
	});

	it("records a usage limit even when the engine has no current route", () => {
		const { e, deps } = engine();
		assert.deepEqual(e.prepareFailover({ provider: "acme", id: "mid" }, "The usage limit has been reached. Try again in ~20 min."), {
			errorClass: "quota",
			canFailOver: false,
		});
		assert.ok((deps.store.read().members["provider:acme"]?.cooldownUntil ?? 0) > deps.clock.now());
	});

	it("does not offer a failover when every model is on the exhausted account", async () => {
		const raw: RawConfig = {
			classifiers: [],
			profiles: { solo: { tiers: { a: { rank: 1, members: ["acme/small"] }, b: { rank: 2, members: ["acme/mid"] } } } },
			profileSelection: { default: "solo" },
		};
		const { e } = engine({ raw });
		await e.route(input());
		assert.deepEqual(e.prepareFailover({ provider: "acme", id: "mid" }, "The usage limit has been reached. Try again in ~20 min."), {
			errorClass: "quota",
			canFailOver: false,
		});
		await assert.rejects(
			e.route(input()),
			(error: unknown) => error instanceof ExhaustedError && /every model is cooling down/u.test(error.message),
			"the next turn sees the account benched",
		);
	});

	it("routes direct requests to the direct tier and moves up to fit the context", async () => {
		const { e } = await started();
		const small = await e.route(input({ reason: "direct", contextTokens: 10_000 }));
		assert.equal(small.id, "small");
		assert.equal(small.state, undefined, "direct requests store no state");
		const big = await e.route(input({ reason: "direct", contextTokens: 100_000 }));
		assert.equal(big.id, "mid");
		assert.match(big.decision?.tier.why ?? "", /moved up to fit/u);
	});

	it("maps members onto the parent's account with account affinity", async () => {
		const { e, deps } = engine({ classify: async () => ({ stopReason: "stop", answers: answers("implement") }) });
		deps.accountFor = (provider) => (provider === "acme" ? "acme-2" : provider);
		const out = await e.route(input());
		assert.deepEqual([out.provider, out.id], ["acme-2", "mid"]);
	});
});
