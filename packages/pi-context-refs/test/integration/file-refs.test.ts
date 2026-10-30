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

describe("File limits at the fake pi host", () => {
	const numbered = (count: number) => Array.from({ length: count }, (_, index) => `${String(index + 1).padStart(9, "0")}\n`).join("");
	const write = (name: string, content: string | Uint8Array) => writeFileSync(join(project, "src", name), content);
	const attributes = (text: string) => text.match(/<context-ref ([^>]*)>/)?.[1] ?? "";
	const body = (text: string) => text.slice(text.indexOf(">\n") + 2, text.lastIndexOf("\n</context-ref>"));

	beforeEach(() => {
		writeLibrary([
			file("big", "src/big.txt"),
			{ ...file("wide", "src/wide.txt"), max_bytes: 200_000 },
			file("bin", "src/bin.dat"),
			file("shot", "src/shot.png"),
			file("huge", "src/huge.png"),
		]);
	});

	for (const mode of ["tui", "print", "json", "rpc"] as const) {
		it(`cuts a file one line past 2000 and still sends it in ${mode} mode`, async () => {
			write("big.txt", numbered(2001));
			const { send, s } = await session(mode);
			const sent = await send("#big");
			assert.equal(
				attributes(sent.text),
				`name="big" kind="file" path="src/big.txt" bytes="${Buffer.byteLength(body(sent.text))}" truncated="2000 lines"`,
			);
			assert.ok(
				body(sent.text).endsWith("\n[Truncated at 2000 lines: showing lines 1-2000 of 2001. Use the read tool with offset=2001 to read the rest.]"),
			);
			assert.deepEqual(s.notices, []);
			assert.deepEqual(stderr, []);
		});
	}

	it("sends a file of exactly 2000 lines and one of exactly 50 KB whole", async () => {
		const { send } = await session("print");
		write("big.txt", numbered(2000));
		assert.equal(body((await send("#big")).text), numbered(2000));
		write("big.txt", "x".repeat(99).concat("\n").repeat(512));
		assert.ok(!attributes((await send("#big")).text).includes("truncated"));
		write("big.txt", "x".repeat(99).concat("\n").repeat(512).concat("y"));
		assert.match(attributes((await send("#big")).text), /truncated="50 KB"$/);
	});

	it("honours a Ref's max_bytes: 3000 lines under 200 KB are not cut", async () => {
		write("wide.txt", numbered(3000));
		const { send } = await session("print");
		assert.equal(body((await send("#wide")).text), numbered(3000));
	});

	it("fails a binary file by mode: the draft comes back in the TUI, a Failure note elsewhere", async () => {
		write("bin.dat", new Uint8Array([1, 2, 0, 3]));
		const reason = "src/bin.dat is a binary file and cannot be sent as text";
		const tui = await session("tui");
		assert.deepEqual(await tui.send("#bin"), { action: "handled" });
		assert.deepEqual(tui.s.notices, [{ message: `pi-context-refs: #bin: ${reason}`, type: "error" }]);
		const print = await session("print");
		assert.match((await print.send("#bin")).text, /bytes="0" error="src\/bin\.dat is a binary file and cannot be sent as text"/);
		assert.deepEqual(stderr, [`pi-context-refs: #bin: ${reason}\n`]);
	});

	describe("an image", () => {
		const png = (extra = 0) => {
			const header = Buffer.alloc(33);
			Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header);
			header.writeUInt32BE(13, 8);
			header.write("IHDR", 12, "ascii");
			return Buffer.concat([header, Buffer.alloc(extra, 1)]);
		};

		it("is attached through the input event's images, unresized, next to the images already there", async () => {
			write("shot.png", png());
			const { send } = await session("print");
			const earlier = { type: "image", data: "AAAA", mimeType: "image/jpeg" };
			const sent = await send("look #shot", { images: [earlier] });
			assert.equal(sent.text, `look #shot\n\n${block('name="shot" kind="file" path="src/shot.png" bytes="0"', "")}`);
			assert.deepEqual(sent.images, [earlier, { type: "image", data: png().toString("base64"), mimeType: "image/png" }]);
		});

		it("fails over 5 MB with a hint to resize, in the TUI as a refused send", async () => {
			write("huge.png", png(5 * 1024 * 1024));
			const { send, s } = await session("tui");
			assert.deepEqual(await send("#huge"), { action: "handled" });
			assert.deepEqual(s.notices, [{ message: "pi-context-refs: #huge: src/huge.png is an image over 5 MB; resize it and try again", type: "error" }]);
		});
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
