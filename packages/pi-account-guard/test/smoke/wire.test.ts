// Opt-in: runs real pi (`npm run test:smoke`). Needs no network and no credentials.
// The other smoke tests answer from a stub provider inside pi. These run pi's own OpenAI client against a server on 127.0.0.1 that records what reaches it,
// so "no turn was sent" is shown at the network, not only at the provider boundary: a blocked turn leaves no request, not even a probe.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { FAKE_MODEL, FAKE_PROVIDER, FAKE_REPLY, type FakeOpenAI, modelsJson, startFakeOpenAI } from "../support/fake-openai.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const GUARD_EXTENSION = join(ROOT, "src", "index.ts");
const PI_BIN = process.env.PI_BIN ?? "pi";
const CREDENTIAL_ENV = /(?:API_KEY|TOKEN|SECRET|CREDENTIALS|AUTH)/i;

/** The account pi builds for a provider whose key is in models.json. */
const FAKE_ACCOUNT = { provider: FAKE_PROVIDER, source: "models-json-key" };

interface Run {
	code: number | null;
	stdout: string;
	stderr: string;
	fake: FakeOpenAI;
}

const servers: FakeOpenAI[] = [];
after(async () => {
	await Promise.all(servers.map((server) => server.close()));
});

/** Runs `pi -p <prompt>` against a fresh fake server, in a fresh place, with `config` as the guard's file (none when undefined). */
async function runTurn(prompt: string, config: unknown, env: Record<string, string> = {}): Promise<Run> {
	const fake = await startFakeOpenAI();
	servers.push(fake);
	const root = realpathSync(mkdtempSync(join(tmpdir(), "account-guard-wire-")));
	const agentDir = join(root, "agent");
	const place = join(root, "place");
	mkdirSync(agentDir);
	mkdirSync(place);
	writeFileSync(join(agentDir, "models.json"), modelsJson(fake.baseUrl));
	if (config !== undefined) writeFileSync(join(agentDir, "account-guard.json"), JSON.stringify(config));
	const clean: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !CREDENTIAL_ENV.test(key)) clean[key] = value;
	const child = spawn(PI_BIN, ["-ne", "-e", GUARD_EXTENSION, "--provider", FAKE_PROVIDER, "--model", FAKE_MODEL, "--no-session", "-p", prompt], {
		cwd: place,
		env: { ...clean, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", ...env },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => {
		stdout += chunk;
	});
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	const code = await new Promise<number | null>((resolve, reject) => {
		child.on("error", reject);
		child.on("close", resolve);
	});
	return { code, stdout, stderr, fake };
}

describe("the guard at the network, with pi's own OpenAI client", () => {
	it("sends exactly one request, with the user's prompt, when the account matches the place", async () => {
		const run = await runTurn("hello from the wire test", { accounts: [{ ...FAKE_ACCOUNT, zones: ["personal"] }] });
		assert.equal(run.code, 0, run.stderr);
		assert.equal(run.stdout.trim(), FAKE_REPLY);
		assert.equal(run.fake.requests.length, 1, JSON.stringify(run.fake.requests.map((request) => request.path)));
		const turn = run.fake.completions()[0];
		assert.ok(turn, "a completion request reached the server");
		const sent = turn.body as { model: string; messages: Array<{ role: string; content: unknown }> };
		assert.equal(sent.model, FAKE_MODEL);
		const messages = sent.messages;
		assert.equal(messages.at(-1)?.role, "user");
		assert.ok(JSON.stringify(messages.at(-1)?.content).includes("hello from the wire test"));
	});

	it("sends nothing at all, and exits 77, when the account is tagged for another zone", async () => {
		const run = await runTurn("hello", { accounts: [{ ...FAKE_ACCOUNT, zones: ["work"] }] });
		assert.equal(run.code, 77);
		assert.equal(run.stdout, "");
		assert.match(run.stderr, /^BLOCKED fakeai \(models-json-key\) is zone work; this place/);
		assert.deepEqual(run.fake.requests, [], "not a turn, and not a probe either");
	});

	it("sends nothing when the account has no tag, and the message says what to add", async () => {
		const run = await runTurn("hello", undefined);
		assert.equal(run.code, 77);
		assert.match(run.stderr, /^BLOCKED fakeai \(models-json-key\) has no zone tag/);
		assert.ok(run.stderr.includes('{"provider":"fakeai","source":"models-json-key","zones":["personal"]}'), run.stderr);
		assert.deepEqual(run.fake.requests, []);
	});

	it("sends the turn only when the documented escape is set", async () => {
		const run = await runTurn("hello", undefined, { PI_ACCOUNT_GUARD_ALLOW_UNKNOWN: "1" });
		assert.equal(run.code, 0, run.stderr);
		assert.equal(run.fake.completions().length, 1);
	});
});
