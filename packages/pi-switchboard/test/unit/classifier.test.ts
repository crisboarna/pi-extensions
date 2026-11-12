import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type ClassifyFn, runClassifierChain } from "../../src/classifier/chain.ts";
import { buildEvidence, clip, type TranscriptMessage } from "../../src/classifier/evidence.ts";
import { BUILTIN_QUESTIONS, toWireQuestions } from "../../src/classifier/questions.ts";
import { createRedactor } from "../../src/classifier/redact.ts";
import { isLocalUrl, WarmupTracker } from "../../src/classifier/warmup.ts";
import { keepEventLoopAlive } from "../support/keep-alive.ts";

keepEventLoopAlive();

const limits = { maxTokens: 4000, requestTokens: 2500, toolErrors: { max: 5, chars: 200 } };
const user = (text: string): TranscriptMessage => ({ role: "user", content: text });
const tool = (name: string, isError: boolean, text = ""): TranscriptMessage => ({
	role: "toolResult",
	toolName: name,
	isError,
	content: [{ type: "text", text }],
});
const assistant = (): TranscriptMessage => ({ role: "assistant", content: [{ type: "text", text: "ok" }] });

describe("redaction", () => {
	const redact = createRedactor({ home: "/home/dev", extra: ["internal-\\d+"] });

	it("masks common secret shapes and the home directory", () => {
		const out = redact(
			"cat /home/dev/.env: Authorization: Bearer abc.def-ghi token=supersecret1 key ghp_abcdefghijklmnopqrstuvwxyz AKIAABCDEFGHIJKLMNOP " +
				"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N internal-42",
		);
		assert.ok(out.includes("~/.env"));
		for (const secret of ["abc.def-ghi", "supersecret1", "ghp_", "AKIAABCD", "eyJhbGci", "internal-42"]) assert.ok(!out.includes(secret), secret);
	});

	it("leaves ordinary text and paths alone", () => {
		const text = "src/runs/shared/child-session.ts failed: expected 3 got 4 in parseConfigurationFromEnvironmentVariables";
		assert.equal(redact(text), text);
	});

	it("masks long random-looking runs and long hex", () => {
		assert.equal(redact("x Zm9vYmFyQmF6UXV4MTIzNDU2Nzg5MEFCQ0RFRkdISUpLTE1OT1BRUg y"), "x «redacted» y");
		assert.equal(redact("sha 0123456789abcdef0123456789abcdef"), "sha «redacted»");
	});

	// The fake secrets below are built from parts, so the source holds no secret-shaped string for the repository's secret scan to report.
	const fake = (...parts: string[]) => parts.join("");

	it("masks provider keys and tokens by their prefix", () => {
		for (const [secret, kind] of [
			[fake("sk-", "ant-api03-abcdefghijklmnopqrstuvwx"), "OpenAI or Anthropic key"],
			[fake("AIza", "SyA-abcdefghijklmnopqrstuvwxyz12345"), "Google API key"],
			[fake("npm_", "abcdefghijklmnopqrstuvwxyz0123456789"), "npm token"],
			[fake("glpat", "-abcdefghijklmnopqrst"), "GitLab token"],
		] as const) {
			assert.equal(redact(`use ${secret} here`), "use «redacted» here", kind);
		}
	});

	it("masks the password in a URL and keeps the rest of it", () => {
		assert.equal(redact("DATABASE_URL postgres://admin:hunter2@db.internal:5432/app"), "DATABASE_URL postgres://«redacted»@db.internal:5432/app");
		assert.equal(redact("see https://example.com/a:b@c"), "see https://example.com/a:b@c", "a colon and an at sign in the path are not credentials");
	});

	it("masks a secret whose name ends in a secret word", () => {
		assert.equal(redact(fake("aws_secret_access_key", "=", "wJalrXUtnFEMIK7MDENGbPxRfiCY")), "aws_secret_access_key=«redacted»");
		assert.equal(redact(fake("MY_TOKEN", ": ", "abcdef123456")), "MY_TOKEN: «redacted»");
	});

	it("masks a bare AWS secret access key", () => {
		assert.equal(redact(fake("sec", "ret ", "wJalrXUtn", "FEMI/K7MD", "ENG/bPxRf", "iCYEXAMPLEKEY end")), "secret «redacted» end");
	});

	it("leaves a long path that mixes case and digits alone", () => {
		const path = "packages/Pi2Switchboard/src/Router/Engine4Tests";
		assert.equal(path.length >= 40, true);
		assert.equal(redact(`open ${path}`), `open ${path}`);
	});

	it("replaces the home directory only as a whole path", () => {
		const own = createRedactor({ home: "/Users/alice" });
		assert.equal(own("/Users/alice/x and /Users/alice"), "~/x and ~");
		assert.equal(own("/Users/alicebob/x"), "/Users/alicebob/x");
	});
});

describe("evidence", () => {
	it("collects the request, tool outcomes, short errors and the edit flag", () => {
		const evidence = buildEvidence({
			messages: [
				user("old"),
				tool("read", false),
				user("fix the failing build"),
				assistant(),
				tool("bash", true, "npm ERR! missing script: build"),
				tool("edit", false),
			],
			scope: "main",
			planPhase: "executing",
			limits,
		});
		assert.equal(evidence.state.request, "fix the failing build");
		assert.deepEqual(evidence.state.toolOutcomes, [
			{ tool: "bash", ok: false },
			{ tool: "edit", ok: true },
		]);
		assert.deepEqual(evidence.state.toolErrors, [{ tool: "bash", error: "npm ERR! missing script: build" }]);
		assert.equal(evidence.state.editsThisTask, true);
		assert.deepEqual(evidence.state.previousTask, { edits: false, toolErrors: 0 });
		assert.equal(evidence.digest.length, 16);
	});

	it("keeps the head and tail of a long request within the budget", () => {
		const long = `START ${"x".repeat(50_000)} END`;
		const evidence = buildEvidence({
			messages: [user(long)],
			scope: "main",
			planPhase: "unknown",
			limits: { ...limits, maxTokens: 500, requestTokens: 400 },
		});
		const request = String(evidence.state.request);
		assert.ok(request.startsWith("START") && request.endsWith("END"));
		assert.match(request, /tokens omitted/u);
		assert.ok(evidence.tokens <= 520, `tokens ${evidence.tokens}`);
		assert.equal(evidence.truncated, true);
	});

	it("bounds tool errors and redacts them", () => {
		const errors = Array.from({ length: 8 }, (_, i) => tool(`t${i}`, true, `fail ${i} token=abcdefgh123 ${"y".repeat(500)}`));
		const evidence = buildEvidence({ messages: [user("go"), ...errors], scope: "main", planPhase: "idle", limits });
		const listed = evidence.state.toolErrors as Array<{ tool: string; error: string }>;
		assert.equal(listed.length, 5);
		assert.equal(listed[0]?.tool, "t3");
		assert.ok(listed.every((entry) => entry.error.length <= 200 && !entry.error.includes("abcdefgh123")));
	});

	it("describes subagent tasks with their agent", () => {
		const evidence = buildEvidence({
			messages: [],
			request: "scan the repo",
			scope: "subagent",
			agent: { name: "scout", tools: ["read", "grep"] },
			planPhase: "unknown",
			limits,
		});
		assert.deepEqual(evidence.state.agent, { name: "scout", tools: ["read", "grep"] });
		assert.equal(evidence.state.request, "scan the repo");
	});

	it("clip leaves short text untouched", () => {
		assert.deepEqual(clip("short", 100), { text: "short", truncated: false });
	});
});

describe("questions", () => {
	it("strips our labels before sending", () => {
		const wire = toWireQuestions(BUILTIN_QUESTIONS);
		assert.equal("labels" in (wire.depth ?? {}), false);
		assert.ok("labels" in (BUILTIN_QUESTIONS.depth ?? {}));
	});
});

describe("classifier chain", () => {
	const request = { state: { request: "x" }, questions: BUILTIN_QUESTIONS };
	const answers = { work: { type: "choice" as const, choice: "plan", probabilities: {}, confidence: 0.9 } };

	it("returns the first classifier that answers and records failed attempts", async () => {
		const classify: ClassifyFn = async (model) =>
			model === "a/one"
				? { stopReason: "error", errorMessage: "connection refused" }
				: { stopReason: "stop", answers, usage: { input: 10, output: 0, cost: { total: 0 } } };
		const result = await runClassifierChain(
			[
				{ model: "a/one", timeoutMs: 100 },
				{ model: "b/two", timeoutMs: 100, threshold: 0.8 },
			],
			request,
			{ classify, budgetMs: 1000 },
		);
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(result.model, "b/two");
		assert.equal(result.threshold, 0.8);
		assert.deepEqual(
			result.attempts.map((a) => [a.model, a.ok]),
			[
				["a/one", false],
				["b/two", true],
			],
		);
		assert.deepEqual(result.usage, { input: 10, output: 0, cost: 0 });
	});

	it("times out slow classifiers and marks cold ones", async () => {
		const classify: ClassifyFn = (_model, _request, { signal }) =>
			new Promise((resolve) => signal.addEventListener("abort", () => resolve({ stopReason: "aborted" })));
		const result = await runClassifierChain([{ model: "a/slow", timeoutMs: 20 }], request, { classify, budgetMs: 1000, isWarm: () => false });
		assert.equal(result.ok, false);
		if (result.ok) return;
		assert.equal(result.reason, "classifier-cold");
		assert.match(result.attempts[0]?.error ?? "", /timed out after 20 ms/u);
	});

	it("skips a remote classifier unless allowRemote is set, and records why", async () => {
		const called: string[] = [];
		const classify: ClassifyFn = async (model) => {
			called.push(model);
			return { stopReason: "stop", answers };
		};
		const blocked = await runClassifierChain(
			[
				{ model: "cloud/judge", timeoutMs: 100, remote: true },
				{ model: "local/judge", timeoutMs: 100 },
			],
			request,
			{ classify, budgetMs: 1000 },
		);
		assert.ok(blocked.ok && blocked.model === "local/judge");
		assert.deepEqual(called, ["local/judge"], "the remote classifier was never called");
		assert.match(blocked.attempts[0]?.error ?? "", /set allowRemote: true/u);
		const only = await runClassifierChain([{ model: "cloud/judge", timeoutMs: 100, remote: true }], request, { classify, budgetMs: 1000 });
		assert.equal(only.ok, false);
		assert.deepEqual(called, ["local/judge"]);
		const allowed = await runClassifierChain([{ model: "cloud/judge", timeoutMs: 100, remote: true, allowRemote: true }], request, {
			classify,
			budgetMs: 1000,
		});
		assert.ok(allowed.ok && allowed.model === "cloud/judge");
	});

	it("reports a missing classifier and an exhausted budget", async () => {
		const none = await runClassifierChain([], request, { classify: async () => ({ stopReason: "stop", answers }), budgetMs: 100 });
		assert.equal(none.ok ? "" : none.reason, "no-classifier");
		let now = 0;
		const clock = { now: () => now };
		const slow: ClassifyFn = async () => {
			now += 150;
			return { stopReason: "error", errorMessage: "boom" };
		};
		const result = await runClassifierChain(
			[
				{ model: "a/x", timeoutMs: 1000 },
				{ model: "b/y", timeoutMs: 1000 },
			],
			request,
			{ classify: slow, budgetMs: 100, clock },
		);
		assert.equal(result.ok ? "" : result.reason, "budget");
	});
});

describe("warm-up", () => {
	it("warms local classifiers once and keeps them warm on a timer", async () => {
		const calls: string[] = [];
		const intervals: Array<() => void> = [];
		const tracker = new WarmupTracker(
			async (model) => {
				calls.push(model);
				return { stopReason: "stop", answers: {} };
			},
			{ setInterval: (fn) => intervals.push(fn), clearInterval: () => {} },
		);
		await tracker.start([
			{ model: "local/a", local: true, keepWarmMs: 60_000 },
			{ model: "remote/b", local: false },
			{ model: "local/c", local: true, warmup: false },
		]);
		assert.deepEqual(calls, ["local/a"]);
		assert.equal(tracker.isWarm("local/a"), true);
		assert.equal(tracker.isWarm("local/c"), false);
		intervals[0]?.();
		await new Promise((resolve) => setImmediate(resolve));
		assert.deepEqual(calls, ["local/a", "local/a"]);
	});

	it("recognises loopback URLs", () => {
		assert.ok(isLocalUrl("http://127.0.0.1:1234/v1/"));
		assert.ok(isLocalUrl("http://localhost:8080"));
		assert.ok(isLocalUrl("http://[::1]:8000"));
		assert.ok(!isLocalUrl("https://api.example.com/v1"));
		assert.ok(!isLocalUrl(undefined));
		assert.ok(!isLocalUrl("127.0.0.1:1234"), "not a URL: no scheme");
	});

	it("counts every loopback address as local, in each form the URL parser gives", () => {
		for (const url of ["http://127.1.2.3/v1", "http://127.1/v1", "http://0.0.0.0:1234", "http://[::ffff:127.0.0.1]:1234", "http://LOCALHOST:1"])
			assert.ok(isLocalUrl(url), url);
	});

	it("does not count a hostname that only starts like a loopback address as local", () => {
		for (const url of [
			"http://127.attacker.example:8080/v1",
			"http://127.0.0.1.nip.io/v1",
			"http://localhost.evil.com/v1",
			"http://[::2]/v1",
			"http://192.168.1.10:1234/v1",
		])
			assert.ok(!isLocalUrl(url), url);
	});
});
