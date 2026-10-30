import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createJiti } from "jiti";
import { createFakeHost, createFakeSession } from "../support/fake-pi.ts";

const INDEX = join(import.meta.dirname, "..", "..", "src", "index.ts");

let agentDir = "";
let project = "";
const realStderrWrite = process.stderr.write.bind(process.stderr);

beforeEach(() => {
	const root = mkdtempSync(join(tmpdir(), "context-refs-transcript-"));
	agentDir = join(root, "agent");
	project = join(root, "project");
	mkdirSync(agentDir);
	mkdirSync(project);
	process.env.PI_CODING_AGENT_DIR = agentDir;
});

afterEach(() => {
	process.stderr.write = realStderrWrite;
	rmSync(join(agentDir, ".."), { recursive: true, force: true });
});

const writeLibrary = (refs: unknown[]) => writeFileSync(join(agentDir, "pi-context-refs.json"), JSON.stringify({ version: 1, $schema: "x", refs }));

/** Loads the extension through jiti, as pi does, and runs its factory against a fake host. */
async function boot() {
	const jiti = createJiti(import.meta.url, { moduleCache: false });
	// The coverage run imports natively: V8 coverage cannot map code that jiti transforms back to the source files.
	const factory = (
		process.env.CONTEXT_REFS_NATIVE_IMPORT === "1" ? ((await import(INDEX)) as { default: unknown }).default : await jiti.import(INDEX, { default: true })
	) as (pi: unknown) => unknown;
	const host = createFakeHost();
	await factory(host.pi);
	return host;
}

type Transformer = (markdown: string, context: { messageType: string; isStreaming: boolean; availableWidth: number }) => string;

describe("the Markdown transformer", () => {
	async function transformer(): Promise<Transformer> {
		const host = await boot();
		const registered = host.calls.filter((call) => call.method === "registerMarkdownTransformer");
		assert.equal(registered.length, 1, "one transformer is registered");
		return registered[0]?.args[0] as Transformer;
	}
	const context = (messageType: string) => ({ messageType, isStreaming: false, availableWidth: 80 });

	it("collapses the Context blocks the input handler wrote into the user message, and keeps the prose and its Placeholders", async () => {
		mkdirSync(join(project, "src"));
		writeFileSync(join(project, "src", "api.ts"), "export const api = 1;\n".repeat(200));
		writeLibrary([
			{ name: "api", kind: "file", path: "src/api.ts" },
			{ name: "agents", kind: "path", path: "AGENTS.md" },
		]);
		const host = await boot();
		const s = createFakeSession({ cwd: project, mode: "print" });
		await host.fire("session_start", { type: "session_start", reason: "startup" }, s.ctx);
		const sent = await host.fire("input", { type: "input", text: "Review [ref:api] against [ref:agents]", source: "interactive" }, s.ctx);
		assert.match(sent.text, /^Review \[ref:api\] against AGENTS\.md\n\n<context-ref name="api"/);
		const shown = (await transformer())(sent.text, context("user"));
		assert.equal(shown, "Review [ref:api] against AGENTS.md\n\n▸ ref api (file, 4.3 KB)");
	});

	it("never touches assistant text, even when it quotes a Context block", async () => {
		const quoted = 'Here is the format:\n\n<context-ref name="api" kind="file" path="a" bytes="1">\nx\n</context-ref>';
		const transform = await transformer();
		assert.equal(transform(quoted, context("assistant")), quoted);
		assert.equal(transform(quoted, context("assistant-thinking")), quoted);
	});

	it("leaves a user message without Context blocks as it is", async () => {
		const plain = "no blocks, just #text and [ref:x]";
		assert.equal((await transformer())(plain, context("user")), plain);
	});
});

type Entry = { type: "message"; id: string; message: Record<string, unknown> };
const user = (content: unknown): Entry => ({ type: "message", id: "u", message: { role: "user", content, timestamp: 0 } });
const assistant = (text: string): Entry => ({ type: "message", id: "a", message: { role: "assistant", content: [{ type: "text", text }], timestamp: 0 } });
const other: Entry = { type: "message", id: "t", message: { role: "toolResult", content: [{ type: "text", text: "tool output" }], timestamp: 0 } };

const BLOCK_BODY = "SECRET-BODY-LINE\n</context-ref> not the end";
const SENT = `Review [ref:api]\n\n<context-ref name="api" kind="file" path="src/api.ts" bytes="${Buffer.byteLength(BLOCK_BODY)}">\n${BLOCK_BODY}\n</context-ref>`;

/** A custom component as the TUI would show it: the frames it rendered and a way to press keys. */
interface Shown {
	component: { render(width: number): string[]; handleInput(data: string): void };
	closed: Promise<void>;
}

/** A session whose branch holds `entries`. In the TUI `ui.custom` builds the component and `shown` holds it. */
function sentSession(mode: "tui" | "rpc" | "print", entries: Entry[]) {
	const fake = createFakeSession({ cwd: project, mode });
	const ctx = fake.ctx;
	ctx.sessionManager = { getBranch: () => entries };
	const shown: Shown[] = [];
	ctx.ui.custom = (factory: (...args: unknown[]) => Shown["component"]) => {
		const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
		let close = () => {};
		const closed = new Promise<void>((resolve) => {
			close = resolve;
		});
		const component = factory({ terminal: { rows: 12 }, requestRender: () => {} }, theme, {}, () => close());
		shown.push({ component, closed });
		return closed;
	};
	return { ...fake, shown };
}

async function refSent(session: ReturnType<typeof sentSession>, action?: (shown: Shown[]) => Promise<void> | void) {
	const host = await boot();
	await host.fire("session_start", { type: "session_start", reason: "startup" }, session.ctx);
	const chunks: string[] = [];
	process.stderr.write = ((chunk: string | Uint8Array) => {
		chunks.push(String(chunk));
		return true;
	}) as typeof process.stderr.write;
	try {
		const running = host.commands.get("ref")?.handler("sent", session.ctx);
		await action?.(session.shown);
		await running;
	} finally {
		process.stderr.write = realStderrWrite;
	}
	return chunks.join("");
}

describe("/ref sent", () => {
	it("prints the full last user message on stderr in print mode", async () => {
		const s = sentSession("print", [user("an earlier message"), assistant("an answer"), user(SENT), assistant("a later answer"), other]);
		assert.equal(await refSent(s), `${SENT}\n`);
		assert.deepEqual(s.notices, []);
	});

	it("reads the text parts of a message that also holds an image", async () => {
		const s = sentSession("print", [
			user([
				{ type: "text", text: "first" },
				{ type: "image", data: "AAAA", mimeType: "image/png" },
				{ type: "text", text: "second" },
			]),
		]);
		assert.equal(await refSent(s), "first\nsecond\n");
	});

	it("is plain notify text for an RPC client", async () => {
		const s = sentSession("rpc", [user(SENT)]);
		assert.equal(await refSent(s), "");
		assert.deepEqual(s.notices, [{ message: SENT, type: "info" }]);
		assert.deepEqual(s.shown, []);
	});

	it("says so when nothing has been sent in this session", async () => {
		const s = sentSession("print", [assistant("hello"), other]);
		assert.equal(await refSent(s), "No message has been sent in this session\n");
	});

	it("shows the full text in a read-only dialog in the TUI, not as a notice", async () => {
		const s = sentSession("tui", [user("older"), assistant("answer"), user(SENT)]);
		let frame: string[] = [];
		await refSent(s, async (shown) => {
			const [dialog] = shown;
			assert.ok(dialog, "the dialog opened");
			frame = dialog.component.render(60);
			dialog.component.handleInput("\x1b");
			await dialog.closed;
		});
		assert.deepEqual(s.notices, []);
		const text = frame.join("\n");
		assert.ok(text.includes("Review [ref:api]"));
		assert.ok(text.includes('<context-ref name="api" kind="file" path="src/api.ts"'));
		assert.ok(text.includes("SECRET-BODY-LINE"));
		assert.ok(!text.includes("older"));
		assert.ok(
			frame.every((line) => line.length <= 60),
			"no line is wider than the terminal",
		);
	});

	it("scrolls the dialog when the message is longer than the terminal, and closes on enter", async () => {
		const long = Array.from({ length: 40 }, (_unused, index) => `line ${index}`).join("\n");
		const s = sentSession("tui", [user(long)]);
		await refSent(s, async (shown) => {
			const [dialog] = shown;
			assert.ok(dialog);
			const first = dialog.component.render(60);
			assert.ok(first.length <= 12, "it fits the 12-row terminal");
			assert.ok(first.join("\n").includes("line 0"));
			assert.ok(!first.join("\n").includes("line 39"));
			dialog.component.handleInput("\x1b[B");
			assert.ok(!dialog.component.render(60).join("\n").includes("line 0\n"), "down moves the window");
			dialog.component.handleInput("\x1b[F");
			assert.ok(dialog.component.render(60).join("\n").includes("line 39"), "end shows the last line");
			dialog.component.handleInput("\x1b[H");
			assert.ok(dialog.component.render(60).join("\n").includes("line 0"), "home goes back");
			dialog.component.handleInput("\x1b[6~");
			dialog.component.handleInput("\x1b[5~");
			dialog.component.handleInput("\r");
			await dialog.closed;
		});
	});

	it("strips terminal control characters from what the dialog draws", async () => {
		const s = sentSession("tui", [user("red \x1b[31mtext\x07\x1b]0;title\x07 end")]);
		await refSent(s, async (shown) => {
			const [dialog] = shown;
			assert.ok(dialog);
			const drawn = dialog.component.render(60).join("\n");
			assert.ok(!drawn.includes("\x1b"));
			assert.ok(!drawn.includes("\x07"));
			assert.ok(drawn.includes("text"));
			dialog.component.handleInput("q");
			await dialog.closed;
		});
	});

	it("rejects extra words with the usage", async () => {
		const s = sentSession("print", [user(SENT)]);
		const host = await boot();
		const chunks: string[] = [];
		process.stderr.write = ((chunk: string | Uint8Array) => {
			chunks.push(String(chunk));
			return true;
		}) as typeof process.stderr.write;
		await host.commands.get("ref")?.handler("sent now", s.ctx);
		assert.equal(chunks.join(""), 'unexpected "now"\n/ref sent\n');
	});
});
