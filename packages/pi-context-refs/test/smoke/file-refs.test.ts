// Opt-in: runs real pi (`npm run test:smoke`). File Refs reach the model as Context blocks (print), a failed one
// becomes a Failure note and a notification (RPC), and in the TUI it cancels the send and restores the draft (pty).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { crc32, deflateSync } from "node:zlib";
import { RpcSession, runPrint } from "../support/pi-process.ts";
import { probeRun } from "../support/probe-run.ts";
import { PtySession } from "../support/pty-session.ts";
import { replyFor } from "../support/stub-provider.ts";

const EXTENSION = join(import.meta.dirname, "..", "..", "src", "index.ts");
const REFS = [
	{ name: "api", kind: "file", path: "src/api.ts" },
	{ name: "empty", kind: "file", path: "src/empty.txt" },
	{ name: "gone", kind: "file", path: "src/gone.ts" },
	{ name: "dir", kind: "file", path: "src" },
];
const API = "export const api = 1;\n";
const block = (attributes: string, body: string) => `<context-ref ${attributes}>\n${body}\n</context-ref>`;
const API_BLOCK = block('name="api" kind="file" path="src/api.ts" bytes="22"', API);
const GONE_NOTE = block('name="gone" kind="file" path="src/gone.ts" bytes="0" error="src/gone.ts does not exist"', "");

/** A valid 1x1 PNG, so pi's own image handling accepts it. */
function onePixelPng(): Buffer {
	const chunk = (type: string, data: Buffer) => {
		const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
		const length = Buffer.alloc(4);
		length.writeUInt32BE(data.length);
		const crc = Buffer.alloc(4);
		crc.writeUInt32BE(crc32(body));
		return Buffer.concat([length, body, crc]);
	};
	const header = Buffer.alloc(13);
	header.writeUInt32BE(1, 0);
	header.writeUInt32BE(1, 4);
	header.set([8, 2, 0, 0, 0], 8);
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", header),
		chunk("IDAT", deflateSync(Buffer.from([0, 255, 0, 0]))),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

/** A run of the real extension in a project with `src/api.ts` and `src/empty.txt`, and a library of File Refs in its agent directory. */
function run(env: Record<string, string> = {}) {
	const probe = probeRun("none", env);
	mkdirSync(join(probe.dir, "src"));
	writeFileSync(join(probe.dir, "src", "api.ts"), API);
	writeFileSync(join(probe.dir, "src", "empty.txt"), "");
	const agentDir = join(mkdtempSync(join(tmpdir(), "context-refs-agent-")), "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "pi-context-refs.json"), JSON.stringify({ version: 1, refs: REFS }));
	return { ...probe, options: { ...probe.options, extensions: [EXTENSION], env: { ...probe.options.env, PI_CODING_AGENT_DIR: agentDir } } };
}

describe("a File Ref in print mode (DESIGN.md sections 8 and 9)", () => {
	it("reaches the model as a Context block after the prose, with the Placeholder still in the prose", async () => {
		const probe = run();
		const result = await runPrint("Review [ref:api] and #empty, #api again.", probe.options);
		assert.equal(result.code, 0, result.stderr);
		const text = `Review [ref:api] and #empty, #api again.\n\n${API_BLOCK}\n\n${block('name="empty" kind="file" path="src/empty.txt" bytes="0"', "")}`;
		assert.deepEqual(probe.received(), [{ text, images: 0 }]);
		assert.equal(result.stdout.trim(), replyFor({ text, images: 0 }));
		assert.equal(result.stderr, "");
	});

	it("sends a Failure note and warns on stderr when the file is missing", async () => {
		const probe = run();
		const result = await runPrint("Look at #gone", probe.options);
		assert.equal(result.code, 0, result.stderr);
		assert.deepEqual(probe.received(), [{ text: `Look at #gone\n\n${GONE_NOTE}`, images: 0 }]);
		assert.equal(result.stderr, "pi-context-refs: #gone: src/gone.ts does not exist\n");
	});

	it("fails a directory with a hint", async () => {
		const probe = run();
		const result = await runPrint("Look at #dir", probe.options);
		assert.equal(result.code, 0, result.stderr);
		assert.match(result.stderr, /^pi-context-refs: #dir: src is a directory; save it as a Path Ref, or as a Dynamic Ref that runs \["ls", \.\.\.\]\n$/);
	});
});

describe("a large File Ref in print mode (DESIGN.md section 9.4)", () => {
	it("reaches the model cut at 2000 lines, marked truncated, with the note that says where to continue", async () => {
		const probe = run();
		const lines = Array.from({ length: 2500 }, (_, index) => `line ${index + 1}`);
		writeFileSync(join(probe.dir, "src", "big.txt"), `${lines.join("\n")}\n`);
		const agentFile = join(probe.options.env.PI_CODING_AGENT_DIR ?? "", "pi-context-refs.json");
		writeFileSync(agentFile, JSON.stringify({ version: 1, refs: [{ name: "big", kind: "file", path: "src/big.txt" }] }));
		const result = await runPrint("Summarise #big", probe.options);
		assert.equal(result.code, 0, result.stderr);
		const [received] = probe.received();
		const kept = lines.slice(0, 2000).join("\n");
		const note = "[Truncated at 2000 lines: showing lines 1-2000 of 2500. Use the read tool with offset=2001 to read the rest.]";
		const body = `${kept}\n${note}`;
		assert.equal(
			received?.text,
			`Summarise #big\n\n<context-ref name="big" kind="file" path="src/big.txt" bytes="${Buffer.byteLength(body)}" truncated="2000 lines">\n${body}\n</context-ref>`,
		);
		assert.equal(result.stderr, "");
	});
});

describe("an image File Ref in print mode (DESIGN.md section 9.4)", () => {
	it("reaches the model as an image with an empty block naming it", async () => {
		const probe = run();
		writeFileSync(join(probe.dir, "src", "shot.png"), onePixelPng());
		writeFileSync(
			join(probe.options.env.PI_CODING_AGENT_DIR ?? "", "pi-context-refs.json"),
			JSON.stringify({ version: 1, refs: [{ name: "shot", kind: "file", path: "src/shot.png" }] }),
		);
		const result = await runPrint("Look at #shot", probe.options);
		assert.equal(result.code, 0, result.stderr);
		assert.deepEqual(probe.received(), [{ text: `Look at #shot\n\n${block('name="shot" kind="file" path="src/shot.png" bytes="0"', "")}`, images: 1 }]);
	});
});

describe("a File Ref in RPC mode (DESIGN.md section 12)", () => {
	it("sends a Failure note and notifies the client, for a prompt and a follow-up", async () => {
		const probe = run({ STUB_DELAY_MS: "700" });
		const rpc = new RpcSession(probe.options);
		try {
			rpc.send({ id: "p1", type: "prompt", message: "first #gone" });
			const notice = await rpc.waitFor((record) => record.type === "extension_ui_request" && record.method === "notify");
			assert.equal(notice.message, "pi-context-refs: #gone: src/gone.ts does not exist");
			assert.equal(notice.notifyType, "warning");
			await rpc.waitFor((record) => record.type === "agent_start");
			rpc.send({ id: "f1", type: "follow_up", message: "then #api" });
			await rpc.waitFor((record) => record.type === "agent_settled", 60_000);
			assert.deepEqual(
				probe.received().map((received) => received.text),
				[`first #gone\n\n${GONE_NOTE}`, `then #api\n\n${API_BLOCK}`],
			);
			assert.ok(
				!rpc.records.some((record) => record.type === "extension_ui_request" && record.method === "set_editor_text"),
				"RPC does not restore a draft",
			);
		} finally {
			await rpc.close();
		}
	});
});

describe("a File Ref in the TUI (DESIGN.md section 12)", () => {
	it("cancels the send for a missing file, puts the draft back in the editor and shows the reason", async () => {
		const probe = run({ STUB_QUIET: "1" });
		const tui = new PtySession(probe.options);
		try {
			await tui.ready();
			tui.type("Look at #gone\r");
			const screen = await tui.waitForScreen((text) => text.includes("src/gone.ts does not exist"));
			assert.ok(screen.includes("Look at #gone"), `the draft is back:\n${screen}`);
			assert.deepEqual(probe.received(), [], "no request reached the model");
			tui.type("!");
			await tui.waitForScreen((text) => text.includes("Look at #gone!"));
		} finally {
			await tui.close();
		}
	});

	it("sends the file to the model when it can be read", async () => {
		const probe = run({ STUB_QUIET: "1" });
		const tui = new PtySession(probe.options);
		try {
			await tui.ready();
			tui.type("Look at #api\r");
			await tui.waitForScreen(() => probe.received().length === 1);
			assert.deepEqual(probe.received(), [{ text: `Look at #api\n\n${API_BLOCK}`, images: 0 }]);
		} finally {
			await tui.close();
		}
	});
});
