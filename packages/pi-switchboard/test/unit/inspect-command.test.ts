import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createRedactor } from "../../src/classifier/redact.ts";
import { openFile, writeInspector } from "../../src/commands/inspect.ts";
import { LiveWriter } from "../../src/live/live.ts";
import { readEntries } from "../../src/timeline/parse.ts";

const FIXTURE = join(import.meta.dirname, "..", "fixtures", "session-routed.jsonl");

describe("/tier inspect", () => {
	it("writes the inspector for a live session from its entries, including child mirrors", () => {
		const dataDir = mkdtempSync(join(tmpdir(), "switchboard-inspect-"));
		const live = join(dataDir, "live");
		mkdirSync(live, { recursive: true });
		const writer = new LiveWriter({ dir: live, session: "child-1", parent: "p", redact: createRedactor() });
		writer.update({ agent: "scout", launchDecisionId: "d_3", model: "acme/small" });
		writer.append({ kind: "task", text: "scan the repo" });
		writer.finish("done");

		const out = writeInspector({ entries: readEntries(FIXTURE), sessionId: "sess/1", dataDir });
		assert.equal(out, join(dataDir, "inspect", "sess_1.html"), "the session id is made filename-safe");
		const html = readFileSync(out, "utf8");
		assert.match(html, /Switchboard inspector/u);
		assert.match(html, /transcript mirror/u);
		assert.match(html, /scan the repo/u);
	});

	it("honours an explicit output path", () => {
		const dir = mkdtempSync(join(tmpdir(), "switchboard-inspect-"));
		const out = join(dir, "nested", "report.html");
		assert.equal(writeInspector({ entries: readEntries(FIXTURE), sessionId: "s", dataDir: dir, out }), out);
		assert.ok(existsSync(out));
	});

	it("reports when the platform opener cannot start", async (t) => {
		if (process.platform === "win32") return t.skip("the Windows opener exists");
		assert.equal(await openFile(join(tmpdir(), "x.html"), "win32"), false);
	});
});
