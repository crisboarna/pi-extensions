// End to end in real pi with no model server: prompts on `switchboard/auto`
// go through pi-switchboard installed from its tarball, a stand-in classifier
// answers as each test scripts, and stand-in models answer with their own
// name. Each test checks which model answered and what `/tier explain` says.
// Runs in `npm run test:e2e`, and so in CI.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { routingConfig, type Standins, startStandins } from "./support/standins.ts";

const answeredBy = (turn: { replies: Array<{ provider: string; model: string }> }) => turn.replies.map((reply) => `${reply.provider}/${reply.model}`);

describe("routing in real pi, with a stand-in classifier and stand-in models", { timeout: 300_000 }, () => {
	let s: Standins;
	const explain = (text: string) => s.runDir.explain(text);

	before(async () => {
		s = await startStandins("routing");
	});

	after(async () => {
		await s?.close();
	});

	it("runs a confident review on the tier the built-in rules give, and explain shows why", async () => {
		const { pi, requests } = await s.open("review", routingConfig(s.classifier));
		s.classifier.reply({ choices: { work: "review" } });
		const turn = await pi.prompt("review the diff");
		assert.deepEqual(answeredBy(turn), ["alpha/big"], explain(JSON.stringify(turn.replies)));
		assert.equal(turn.replies[0]?.text, "standin alpha/big");
		assert.deepEqual(
			requests().map((request) => [request.model, request.user]),
			[["alpha/big", "review the diff"]],
		);
		const text = await pi.command("/tier explain");
		assert.match(text, /^answers: work=review \(0\.95\), depth=1\.00, risky=0\.05$/mu, explain(text));
		assert.match(text, /^rules: builtin rule 2; gate 0\.95 vs 0\.8 on \[work\] passed$/mu, explain(text));
		assert.match(text, /^tier: deep → deep: rule 2$/mu, explain(text));
		assert.match(text, /^model: alpha\/big(:\w+)?$/mu, explain(text));
		assert.deepEqual(pi.errors, []);
	});

	it("runs an answer below the threshold on the fallback tier, and explain says why", async () => {
		const { pi } = await s.open("unsure", routingConfig(s.classifier));
		s.classifier.reply({ choices: { work: "review" }, confidence: 0.5 });
		const turn = await pi.prompt("review the diff");
		assert.deepEqual(answeredBy(turn), ["alpha/mid"], explain(JSON.stringify(turn.replies)));
		const text = await pi.command("/tier explain");
		assert.match(text, /^rules: builtin rule 2; gate 0\.50 vs 0\.8 on \[work\] failed$/mu, explain(text));
		assert.match(text, /^tier: standard → standard: confidence 0\.50 below 0\.8; rule 2 wanted deep$/mu, explain(text));
	});

	it("completes on the fallback tier when the classifier refuses the connection, hangs, or answers after the decision budget", async () => {
		const cases = [
			{ label: "refused", reply: { refuse: true as const }, config: {} },
			{ label: "hung", reply: { hang: true as const }, config: {} },
			{
				label: "late",
				reply: { delayMs: 2500, answer: { choices: { work: "review" } } },
				config: { classifiers: [{ model: "judge/s1", timeoutMs: 5000 }], classification: { threshold: 0.8, decisionBudgetMs: 1000 } },
			},
		];
		for (const { label, reply, config } of cases) {
			const { pi } = await s.open(label, routingConfig(s.classifier, config));
			s.classifier.reply(reply);
			const turn = await pi.prompt("review the diff");
			assert.deepEqual(answeredBy(turn), ["alpha/mid"], explain(`${label}: ${JSON.stringify(turn.replies)}`));
			const text = await pi.command("/tier explain");
			assert.match(text, /^classifier: none answered/mu, explain(`${label}:\n${text}`));
			assert.match(text, /^tier: \S+ → standard: /mu, explain(`${label}:\n${text}`));
			assert.equal(s.classifier.requests.length, 1, explain(`${label}: the classifier was asked once`));
		}
	});

	it("redacts a secret before the classifier sees the request; the model gets the prompt unchanged", async () => {
		const secret = "sk-AbCdEf1234567890XyZw9876";
		const prompt = `review the change that rotates ${secret}`;
		const { pi, requests } = await s.open("redacted", routingConfig(s.classifier));
		await pi.prompt(prompt);
		const asked = s.classifier.requests.map((request) => String(request.state.request));
		assert.equal(asked.length, 1);
		assert.ok(!asked[0]?.includes(secret), explain(`the classifier saw the secret: ${asked[0]}`));
		assert.match(asked[0] ?? "", /«redacted»/u, explain(asked[0] ?? ""));
		assert.deepEqual(
			requests().map((request) => request.user),
			[prompt],
		);
	});

	it("runs a tier-pinned model on that tier without asking the classifier", async () => {
		const { pi } = await s.open("pinned", routingConfig(s.classifier), { model: ["switchboard", "work.light"] });
		const turn = await pi.prompt("review the diff");
		assert.deepEqual(answeredBy(turn), ["alpha/small"], explain(JSON.stringify(turn.replies)));
		assert.equal(s.classifier.requests.length, 0, explain("the classifier was asked"));
	});

	it("keeps the previous member for the next turn while it is healthy, unless the strategy re-picks per request", async () => {
		const rotating = (granularity: string) => {
			const config = routingConfig(s.classifier);
			const work = (config.profiles as { work: { tiers: { standard: Record<string, unknown> } } }).work;
			work.tiers.standard.strategy = { name: "round-robin", granularity };
			return config;
		};
		const kept = await s.open("kept", rotating("session"));
		const first = answeredBy(await kept.pi.prompt("fix the build"));
		const second = answeredBy(await kept.pi.prompt("now fix the tests"));
		assert.deepEqual(second, first, explain(`session granularity re-picked: ${first} then ${second}`));
		const repicked = await s.open("repicked", rotating("request"));
		const one = answeredBy(await repicked.pi.prompt("fix the build"));
		const two = answeredBy(await repicked.pi.prompt("now fix the tests"));
		assert.notDeepEqual(two, one, explain(`request granularity kept ${one}: the test cannot tell keeping from chance`));
	});

	it("warns once, at the first request, about a llama.cpp classifier pi has not listed, and runs on the fallback tier", async () => {
		const config = routingConfig(s.classifier, { classifierProviders: [], classifiers: [{ model: "llama.cpp/some-chat-model", timeoutMs: 1500 }] });
		const { pi } = await s.open("llama-unlisted", config, { env: { LLAMA_BASE_URL: "http://127.0.0.1:9" } });
		const warning =
			"pi-switchboard: classifier llama.cpp/some-chat-model is not listed by pi's llama.cpp provider: is its server running with the model loaded? Its decisions fall back to the fallback tier.";
		assert.ok(!pi.notices.some((notice) => notice.message === warning), explain("warned at session start, before pi's provider could list it"));
		const turn = await pi.prompt("review the diff");
		assert.deepEqual(answeredBy(turn), ["alpha/mid"], explain(JSON.stringify(turn.replies)));
		await pi.prompt("and the tests");
		assert.equal(pi.notices.filter((notice) => notice.message === warning).length, 1, explain(pi.notices.map((n) => n.message).join("\n")));
	});
});
