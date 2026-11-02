// Opt-in: runs real pi (`npm run test:smoke`). Needs no network and no credentials.
// The other smoke tests read what reached the model through a stub provider inside pi. These run pi's own OpenAI client against a server on 127.0.0.1 and read the
// request body that really left pi, so what a ref expands to is shown on the wire: the text the model is sent, not only the text pi handed to its provider.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { FAKE_MODEL, FAKE_PROVIDER, FAKE_REPLY, type FakeOpenAI, modelsJson, startFakeOpenAI } from "../support/fake-openai.ts";

const EXTENSION = join(import.meta.dirname, "..", "..", "src", "index.ts");
const PI_BIN = process.env.PI_BIN ?? "pi";
const CREDENTIAL_ENV = /(?:API_KEY|TOKEN|SECRET|CREDENTIALS|AUTH)/i;

const servers: FakeOpenAI[] = [];
after(async () => {
	await Promise.all(servers.map((server) => server.close()));
});

interface Run {
	code: number | null;
	stdout: string;
	stderr: string;
	fake: FakeOpenAI;
}

/** Runs `pi -p <prompt>` in a fresh place holding `files`, with `refs` as the global library, against a fresh fake server. */
async function runTurn(prompt: string, refs: unknown[], files: Record<string, string> = {}): Promise<Run> {
	const fake = await startFakeOpenAI();
	servers.push(fake);
	const root = realpathSync(mkdtempSync(join(tmpdir(), "context-refs-wire-")));
	const agentDir = join(root, "agent");
	const place = join(root, "place");
	mkdirSync(agentDir);
	mkdirSync(place);
	for (const [name, content] of Object.entries(files)) writeFileSync(join(place, name), content);
	writeFileSync(join(agentDir, "models.json"), modelsJson(fake.baseUrl));
	writeFileSync(join(agentDir, "pi-context-refs.json"), JSON.stringify({ version: 1, refs }));
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !CREDENTIAL_ENV.test(key)) env[key] = value;
	const child = spawn(PI_BIN, ["-ne", "-e", EXTENSION, "--provider", FAKE_PROVIDER, "--model", FAKE_MODEL, "--no-session", "-p", prompt], {
		cwd: place,
		env: { ...env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" },
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

/** The text of the last user message of the one turn that reached the server. */
function sentText(run: Run): string {
	assert.equal(run.fake.completions().length, 1, `${run.fake.completions().length} turns reached the server; stderr: ${run.stderr}`);
	const turn = run.fake.completions()[0];
	assert.ok(turn, "a completion request reached the server");
	const messages = (turn.body as { messages: Array<{ role: string; content: unknown }> }).messages;
	const last = messages.filter((message) => message.role === "user").at(-1);
	assert.ok(last, "the request has a user message");
	if (typeof last.content === "string") return last.content;
	return (last.content as Array<{ type: string; text?: string }>).flatMap((part) => (part.type === "text" ? [part.text ?? ""] : [])).join("");
}

describe("refs on the wire, with pi's own OpenAI client", () => {
	it("sends a snippet's text where the #name was, and a placeholder the same way", async () => {
		const run = await runTurn("Explain #terse and [ref:terse].", [{ name: "terse", kind: "snippet", text: "Answer in one sentence." }]);
		assert.equal(run.code, 0, run.stderr);
		assert.equal(run.stdout.trim(), FAKE_REPLY);
		assert.equal(sentText(run), "Explain Answer in one sentence. and Answer in one sentence..");
	});

	it("keeps the #name in the text and sends a file ref's content after it, in a context block", async () => {
		const run = await runTurn("Review #notes please.", [{ name: "notes", kind: "file", path: "notes.md" }], {
			"notes.md": "WIRE-FILE-MARKER line one\nline two\n",
		});
		assert.equal(run.code, 0, run.stderr);
		const text = sentText(run);
		assert.match(text, /<context-ref name="notes" kind="file"/);
		assert.ok(text.includes("WIRE-FILE-MARKER line one"), text);
		assert.ok(text.startsWith("Review #notes please."), "the sentence is sent as typed");
		assert.match(text, /bytes="35">\nWIRE-FILE-MARKER line one\nline two\n\n<\/context-ref>$/);
	});

	it("sends text that matches no ref exactly as typed", async () => {
		const typed = "#1 priority, issue #42, #unknown, # heading, [ref:unknown]";
		const run = await runTurn(typed, [{ name: "terse", kind: "snippet", text: "x" }]);
		assert.equal(run.code, 0, run.stderr);
		assert.equal(sentText(run), typed);
	});

	it("sends one request for one prompt, and nothing for the library file itself", async () => {
		const run = await runTurn("#terse", [{ name: "terse", kind: "snippet", text: "Be brief." }]);
		assert.equal(run.code, 0, run.stderr);
		assert.equal(run.fake.requests.length, 1, JSON.stringify(run.fake.requests.map((request) => request.path)));
		assert.ok(!JSON.stringify(run.fake.requests).includes("pi-context-refs.json"), "the library file is not sent");
	});
});
