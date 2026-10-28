// End to end in real pi with no model server: the stand-in models fail as each
// test scripts, and the suite checks what README "When a subscription runs dry"
// and docs/strategies-and-failover.md promise. pi does not retry a usage-limit
// error itself, so those paths run only in pi-switchboard. Unscripted, the
// stand-in classifier answers `implement` at depth 1, which runs on the
// standard tier: alpha/mid, then beta/mid. A later turn on the light tier uses
// the tier-pinned model, because a tier lower than the last decision's is held
// for one decision. Runs in `npm run test:e2e`, and so in CI.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { Turn } from "./support/pi-rpc.ts";
import { routingConfig, type Standins, startStandins } from "./support/standins.ts";

const answeredBy = (turn: Turn) => turn.replies.map((reply) => `${reply.provider}/${reply.model}`);
const finalOf = (turn: Turn) => turn.replies.at(-1);
const USAGE_LIMIT = "You have hit your usage limit. Try again in ~30 min.";

describe("failover in real pi, with stand-in models that fail as scripted", { timeout: 300_000 }, () => {
	let s: Standins;
	const explain = (text: string) => s.runDir.explain(text);

	before(async () => {
		s = await startStandins("failover");
	});

	after(async () => {
		await s?.close();
	});

	it("moves a rate-limited turn to another member of the tier; that model sits out, the account's other models do not", async () => {
		const { pi } = await s.open("rate-limit", routingConfig(s.classifier), {
			script: { models: { "alpha/mid": [{ error: "429 Too Many Requests: rate limit exceeded" }] } },
		});
		const turn = await pi.prompt("fix the build");
		assert.deepEqual(answeredBy(turn), ["alpha/mid", "beta/mid"], explain(JSON.stringify(turn.replies)));
		assert.equal(finalOf(turn)?.stopReason, "stop");
		const text = await pi.command("/tier explain");
		assert.match(text, /^\s+✗ alpha\/mid: cooling down \(rate limit\)$/mu, explain(text));
		await pi.setModel("switchboard", "work.light");
		assert.deepEqual(answeredBy(await pi.prompt("rename the file")), ["alpha/small"], explain("alpha's other models sat out too"));
	});

	it("benches every model of an account after a usage limit, moves to the other account, and keeps the original error", async () => {
		const { pi } = await s.open("usage-limit", routingConfig(s.classifier), { script: { models: { "alpha/mid": [{ error: USAGE_LIMIT }] } } });
		const turn = await pi.prompt("fix the build");
		assert.deepEqual(answeredBy(turn), ["alpha/mid", "beta/mid"], explain(JSON.stringify(turn.replies)));
		assert.equal(finalOf(turn)?.stopReason, "stop");
		const text = await pi.command("/tier explain");
		assert.match(text, /You have hit your usage limit\. Try again in ~30 min\./u, explain(text));
		await pi.setModel("switchboard", "work.light");
		assert.deepEqual(answeredBy(await pi.prompt("rename the file")), ["beta/small"], explain("alpha/small ran though its account is out"));
	});

	it("borrows from the tier above when every member of the tier is out", async () => {
		const rateLimited = [{ error: "429 Too Many Requests: rate limit exceeded" }];
		const { pi } = await s.open("borrow", routingConfig(s.classifier), { script: { models: { "alpha/mid": rateLimited, "beta/mid": rateLimited } } });
		const turn = await pi.prompt("fix the build");
		assert.deepEqual(answeredBy(turn), ["alpha/mid", "beta/mid", "alpha/big"], explain(JSON.stringify(turn.replies)));
		assert.equal(finalOf(turn)?.stopReason, "stop");
		const text = await pi.command("/tier explain");
		assert.match(text, /borrowed from/u, explain(text));
	});

	it("ends the turn naming the earliest reset when every tier is out, and auto-continue resumes after it", async () => {
		const soon = "You have hit your usage limit. Try again in 3 seconds.";
		const config = routingConfig(s.classifier, { exhaustion: { borrow: ["up", "down"], autoContinue: true, maxWaitMs: 60_000 } });
		const { pi } = await s.open("exhausted", config, { script: { models: { "alpha/mid": [{ error: soon }], "beta/mid": [{ error: soon }] } } });
		const first = await pi.prompt("fix the build");
		assert.deepEqual(answeredBy(first), ["alpha/mid", "beta/mid"], explain(JSON.stringify(first.replies)));
		assert.equal(finalOf(first)?.stopReason, "error", explain("a model answered though both accounts were out"));
		const mark = pi.mark();
		const second = await pi.prompt("fix the build");
		assert.match(second.notices, /every model is cooling down; earliest reset /u, explain(second.notices));
		assert.match(second.notices, /will send "continue" at /u, explain(second.notices));
		// pi-switchboard waits for the reset plus 5 s, then sends "continue" as a new turn.
		const settled = await pi.waitForRecord((record) => record.type === "agent_settled", 30_000, pi.mark(), "the continued turn");
		const resumed = pi.recordsSince(mark).slice(0, settled - mark + 1);
		const answered = resumed.filter((record) => record.type === "message_end" && (record.message as { stopReason?: string })?.stopReason === "stop");
		assert.ok(answered.length > 0, explain("no model answered after the reset"));
	});

	it("moves on after an auth error and benches that account; keeps the member after a context overflow", async () => {
		const auth = await s.open("auth", routingConfig(s.classifier), {
			script: { models: { "alpha/mid": [{ error: "401 Unauthorized: invalid api key" }] } },
		});
		const turn = await auth.pi.prompt("fix the build");
		assert.deepEqual(answeredBy(turn), ["alpha/mid", "beta/mid"], explain(JSON.stringify(turn.replies)));
		assert.equal(finalOf(turn)?.stopReason, "stop");
		await auth.pi.setModel("switchboard", "work.light");
		assert.deepEqual(answeredBy(await auth.pi.prompt("rename the file")), ["beta/small"], explain("alpha/small ran though its account failed auth"));

		const overflow = await s.open("overflow", routingConfig(s.classifier), {
			script: { models: { "alpha/mid": [{ error: "prompt is too long: 250000 tokens > 200000 maximum" }] } },
		});
		const long = await overflow.pi.prompt("fix the build");
		assert.deepEqual(answeredBy(long), ["alpha/mid"], explain(`the overflow failed over: ${JSON.stringify(long.replies)}`));
		assert.equal(finalOf(long)?.stopReason, "error");
		// Not benched: the next turn runs on the same member, which answers now.
		const next = await overflow.pi.prompt("fix the build, in fewer words");
		assert.deepEqual(answeredBy(next), ["alpha/mid"], explain(`the member was benched: ${JSON.stringify(next.replies)}`));
		assert.equal(finalOf(next)?.stopReason, "stop");
	});
});
