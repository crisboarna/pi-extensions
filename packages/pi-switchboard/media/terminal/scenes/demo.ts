// The scripted session behind the hero video and the terminal clips. Only the
// classifier's answers and the providers' replies are scripted; pi,
// pi-switchboard and pi-subagents decide and run everything else live. One
// account (provider-a) reaches its usage limit when the worker child uses it.
import type { LlmRequest, Reply } from "../../../../../tools/media/terminal-kit/fake-llm.ts";
import type { SceneScript } from "../setup.ts";

const agentOf = (request: LlmRequest) => /<active_agent name="([\w-]+)"/u.exec(request.system)?.[1];

const FAN_OUT: Reply = {
	text: "I'll split this three ways and run them in parallel.\n",
	toolCalls: [
		{
			name: "subagent",
			arguments: {
				workflow: "parallel",
				args: {
					tasks: [
						{ agent: "scout", task: "find where uploads are retried" },
						{ agent: "worker", task: "add exponential backoff to the upload retry loop" },
						{ agent: "reviewer", task: "review the retry change for race conditions" },
					],
				},
			},
		},
	],
};

function child(request: LlmRequest): Reply {
	switch (agentOf(request)) {
		case "scout":
			return { text: "Retries live in src/upload/client.ts:2, a fixed loop of 3 attempts with no delay.", wordMs: 20 };
		case "worker":
			if (request.provider === "provider-a")
				return { error: { status: 429, message: "You have reached your usage limit for this plan. It resets at 14:00." } };
			return { text: "Added exponential backoff to upload(): 200 ms, doubling, capped at 5 s, with jitter.", wordMs: 25 };
		case "reviewer":
			return { text: "No race: attempts run one after another and share no state. Jitter avoids thundering herds.", wordMs: 35 };
		default:
			return { text: "Done." };
	}
}

function main(request: LlmRequest): Reply {
	const ask = request.lastUser;
	if (ask.includes("pi_subagents_notice"))
		return { text: "All three finished: the scout found the loop, the worker added backoff, the reviewer found no races.", wordMs: 40 };
	if (ask.includes("rename foo")) return { text: "Renamed foo to bar in src/utils.ts (1 change).", wordMs: 20 };
	if (ask.includes("caching layer"))
		return {
			text: "Plan: a read-through cache in front of price(), keyed by SKU, 60 s TTL with stale-while-revalidate, invalidated by the pricing events topic. Two risks: cache stampedes on cold keys and stale prices during promotions.",
			wordMs: 55,
		};
	if (ask.includes("upload retries") && request.toolResults === 0) return FAN_OUT;
	if (ask.includes("summarize")) return { text: "acme-shop: an upload client with retries and a pricing API client.", wordMs: 20 };
	if (ask.includes("failing")) return { text: "The price test expects cents; price() returns dollars. Fixed the assertion.", wordMs: 35 };
	if (ask.includes("checkout")) return { text: "Plan for checkout v2: split cart, payment and fulfilment into three steps.", wordMs: 50 };
	return { text: "Done.", wordMs: 30 };
}

export const scene: SceneScript = {
	answers: [
		{ match: "rename foo", work: "mechanical", confidence: 0.96, depth: 0.2, risky: 0.04 },
		{ match: "caching layer", work: "plan", confidence: 0.94, depth: 1.8, risky: 0.3 },
		{ match: "upload retries", work: "review", confidence: 0.92, depth: 1.1, risky: 0.2 },
		{ match: "find where uploads", work: "research", confidence: 0.94, depth: 0.4, risky: 0.05 },
		{ match: "add exponential backoff", work: "implement", confidence: 0.9, depth: 1.0, risky: 0.15 },
		{ match: "race conditions", work: "review", confidence: 0.95, depth: 1.7, risky: 0.4 },
		{ match: "summarize", work: "mechanical", confidence: 0.93, depth: 0.3, risky: 0.02 },
		{ match: "failing", work: "implement", confidence: 0.91, depth: 0.9, risky: 0.2 },
		{ match: "checkout", work: "plan", confidence: 0.62, depth: 1.6, risky: 0.4 },
	],
	llm: (request) => (/<active_agent name=/u.test(request.system) ? child(request) : main(request)),
};
