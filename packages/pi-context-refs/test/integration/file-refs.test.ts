import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createJiti } from "jiti";
import { createFakeHost, createFakeSession } from "../support/fake-pi.ts";

const INDEX = join(import.meta.dirname, "..", "..", "src", "index.ts");

let agentDir = "";
let project = "";
let stderr: string[] = [];
const realStderrWrite = process.stderr.write.bind(process.stderr);

beforeEach(() => {
	const root = mkdtempSync(join(tmpdir(), "context-refs-files-"));
	agentDir = join(root, "agent");
	project = join(root, "project");
	mkdirSync(agentDir);
	mkdirSync(join(project, "src"), { recursive: true });
	process.env.PI_CODING_AGENT_DIR = agentDir;
	stderr = [];
	// Keep only what the package writes; everything else (the test reporter) goes through.
	process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
		if (typeof chunk === "string" && chunk.startsWith("pi-context-refs:")) {
			stderr.push(chunk);
			return true;
		}
		return (realStderrWrite as (...args: unknown[]) => boolean)(chunk, ...rest);
	}) as typeof process.stderr.write;
});

afterEach(() => {
	process.stderr.write = realStderrWrite;
	rmSync(join(agentDir, ".."), { recursive: true, force: true });
});

const writeLibrary = (refs: unknown[]) => writeFileSync(join(agentDir, "pi-context-refs.json"), JSON.stringify({ version: 1, $schema: "x", refs }));
const file = (name: string, path: string) => ({ name, kind: "file", path });
const block = (attributes: string, body: string) => `<context-ref ${attributes}>\n${body}\n</context-ref>`;

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

type Mode = "tui" | "print" | "json" | "rpc";

/** A started session in `mode` and a function that sends one input through the extension. */
async function session(mode: Mode) {
	const host = await boot();
	const s = createFakeSession({ cwd: project, mode });
	await host.fire("session_start", { type: "session_start", reason: "startup" }, s.ctx);
	const send = (text: string, extra: Record<string, unknown> = {}) =>
		host.fire("input", { type: "input", text, source: mode === "rpc" ? "rpc" : "interactive", ...extra }, s.ctx);
	return { s, send };
}

for (const mode of ["tui", "print", "json", "rpc"] as const) {
	describe(`a File Ref in ${mode} mode`, () => {
		beforeEach(() => {
			writeFileSync(join(project, "src", "api.ts"), "export const api = 1;\n");
			writeLibrary([file("api", "src/api.ts"), file("empty", "src/empty.txt"), file("gone", "src/gone.ts"), file("dir", "src")]);
			writeFileSync(join(project, "src", "empty.txt"), "");
		});

		it("keeps the Placeholder in the prose and adds the file's text as a Context block after a blank line", async () => {
			const { send } = await session(mode);
			const sent = await send("Review [ref:api] please");
			assert.deepEqual(sent, {
				action: "transform",
				text: `Review [ref:api] please\n\n${block('name="api" kind="file" path="src/api.ts" bytes="22"', "export const api = 1;\n")}`,
			});
		});

		it("expands a typed #name the same way and gives one block when the Ref is used twice", async () => {
			const { send } = await session(mode);
			const sent = await send("#api and [ref:api] and #API");
			assert.equal(sent.text.match(/<context-ref /g)?.length, 1);
			assert.ok(sent.text.startsWith('#api and [ref:api] and #API\n\n<context-ref name="api" kind="file" path="src/api.ts" bytes="22">'));
		});

		it("reads the file again on every send", async () => {
			const { send } = await session(mode);
			await send("#api");
			writeFileSync(join(project, "src", "api.ts"), "changed");
			assert.ok((await send("#api")).text.endsWith(block('name="api" kind="file" path="src/api.ts" bytes="7"', "changed")));
		});

		it("gives an empty file an empty block with bytes 0", async () => {
			const { send } = await session(mode);
			assert.equal((await send("#empty")).text, `#empty\n\n${block('name="empty" kind="file" path="src/empty.txt" bytes="0"', "")}`);
		});

		it("does not expand a Ref whose block is already in the message", async () => {
			const { send, s } = await session(mode);
			const resent = `Review [ref:api]\n\n${block('name="api" kind="file" path="src/api.ts" bytes="3"', "old")}`;
			assert.equal(await send(resent), undefined);
			assert.deepEqual(s.notices, []);
		});

		it("expands a steer and a follow-up when they are sent", async () => {
			const { send } = await session(mode);
			for (const streamingBehavior of ["steer", "followUp"])
				assert.match((await send("#api", { streamingBehavior })).text, /<context-ref name="api"/, streamingBehavior);
		});

		it("never fails on a token that matches no Ref", async () => {
			const { send, s } = await session(mode);
			assert.equal(await send("#1 priority, issue #42, #unknown, [ref:nope]"), undefined);
			assert.deepEqual(s.notices, []);
			assert.deepEqual(stderr, []);
		});
	});
}

describe("a File Ref that cannot be read", () => {
	beforeEach(() => {
		writeLibrary([file("gone", "src/gone.ts"), file("dir", "src"), file("api", "src/api.ts")]);
		writeFileSync(join(project, "src", "api.ts"), "ok");
	});

	const gone = 'name="gone" kind="file" path="src/gone.ts" bytes="0" error="src/gone.ts does not exist"';

	describe("in the TUI", () => {
		it("cancels the send, puts the draft back and shows the reason", async () => {
			const { send, s } = await session("tui");
			const draft = "Look at [ref:gone] and #api";
			assert.deepEqual(await send(draft), { action: "handled" });
			assert.deepEqual(s.editorTexts, [draft]);
			assert.deepEqual(s.notices, [{ message: "pi-context-refs: #gone: src/gone.ts does not exist", type: "error" }]);
			assert.deepEqual(stderr, []);
		});

		it("restores the draft before it shows the reason, because the notice repaints the editor", async () => {
			const host = await boot();
			const order: string[] = [];
			const s = createFakeSession({ cwd: project, mode: "tui" });
			s.ctx.ui.setEditorText = () => order.push("setEditorText");
			s.ctx.ui.notify = () => order.push("notify");
			await host.fire("input", { type: "input", text: "#gone", source: "interactive" }, s.ctx);
			assert.deepEqual(order, ["setEditorText", "notify"]);
		});

		it("names every failed Ref in one notice", async () => {
			const { send, s } = await session("tui");
			await send("#gone #dir");
			assert.equal(s.notices.length, 1);
			assert.match(
				s.notices[0]?.message ?? "",
				/^pi-context-refs: #gone: src\/gone\.ts does not exist\n#dir: src is a directory; save it as a Path Ref, or as a Dynamic Ref that runs \["ls", \.\.\.\]$/,
			);
		});
	});

	for (const mode of ["print", "json"] as const) {
		describe(`in ${mode} mode`, () => {
			it("sends a Failure note and warns on stderr", async () => {
				const { send, s } = await session(mode);
				assert.deepEqual(await send("Look at #gone and #api"), {
					action: "transform",
					text: `Look at #gone and #api\n\n<context-ref ${gone}>\n\n</context-ref>\n\n${block('name="api" kind="file" path="src/api.ts" bytes="2"', "ok")}`,
				});
				assert.deepEqual(stderr, ["pi-context-refs: #gone: src/gone.ts does not exist\n"]);
				assert.deepEqual(s.notices, []);
				assert.deepEqual(s.editorTexts, []);
			});
		});
	}

	describe("in RPC mode", () => {
		it("sends a Failure note and notifies the client", async () => {
			const { send, s } = await session("rpc");
			assert.deepEqual(await send("Look at #gone"), { action: "transform", text: `Look at #gone\n\n<context-ref ${gone}>\n\n</context-ref>` });
			assert.deepEqual(s.notices, [{ message: "pi-context-refs: #gone: src/gone.ts does not exist", type: "warning" }]);
			assert.deepEqual(stderr, []);
			assert.deepEqual(s.editorTexts, []);
		});
	});

	it("fails a directory with a hint to use a Path Ref or a Dynamic ls Ref", async () => {
		const { send } = await session("print");
		const sent = await send("#dir");
		assert.match(sent.text, /error="src is a directory; save it as a Path Ref, or as a Dynamic Ref that runs \[&quot;ls&quot;, \.\.\.\]"/);
	});

	it("fails a file the process may not read, with the system's code", { skip: process.getuid?.() === 0 }, async () => {
		const locked = join(project, "src", "locked.txt");
		writeFileSync(locked, "secret");
		chmodSync(locked, 0o000);
		writeLibrary([file("locked", "src/locked.txt")]);
		const { send } = await session("print");
		assert.match((await send("#locked")).text, /error="src\/locked\.txt cannot be read \(EACCES\)"/);
		assert.equal(stderr.length, 1);
	});
});

for (const mode of ["tui", "print", "json", "rpc"] as const) {
	describe(`a #tag:<tag> Bundle with a File member in ${mode} mode`, () => {
		beforeEach(() => {
			writeFileSync(join(project, "src", "api.ts"), "export const api = 1;\n");
			writeLibrary([
				{ ...file("api", "src/api.ts"), tags: ["ctx"] },
				{ name: "terse", kind: "snippet", text: "Be brief.", tags: ["ctx"] },
				{ ...file("gone", "src/gone.ts"), tags: ["lost"] },
			]);
		});

		it("sends the File as a Context block after the prose, with the inline members in the prose", async () => {
			const { send } = await session(mode);
			assert.deepEqual(await send("Review #tag:ctx now"), {
				action: "transform",
				text: `Review Be brief. now\n\n${block('name="api" kind="file" path="src/api.ts" bytes="22"', "export const api = 1;\n")}`,
			});
		});

		it("gives one block when the message also names the File", async () => {
			const { send } = await session(mode);
			const sent = await send("#tag:ctx and [ref:api]");
			assert.equal(sent.text.match(/<context-ref /g)?.length, 1);
			assert.ok(sent.text.startsWith('Be brief. and [ref:api]\n\n<context-ref name="api"'), sent.text);
		});

		it("reports a member that cannot be read the way a File Ref is reported", async () => {
			const { send, s } = await session(mode);
			const sent = await send("#tag:lost");
			if (mode === "tui") {
				assert.deepEqual(sent, { action: "handled" });
				assert.deepEqual(s.editorTexts, ["#tag:lost"]);
			} else {
				assert.match(sent.text, /error="src\/gone\.ts does not exist"/);
			}
		});
	});
}
