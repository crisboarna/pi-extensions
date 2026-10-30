// Opt-in: runs real pi in a pseudo-terminal (`npm run test:smoke`). A file the model read shows up as a Recent ref in the Trigger's list
// (DESIGN.md section 11), a pick inserts a path Placeholder, and the file form sends only a file the session used.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { probeRun } from "../support/probe-run.ts";
import { PtySession } from "../support/pty-session.ts";
import { QUIET_REPLY } from "../support/stub-provider.ts";

const EXTENSION = join(import.meta.dirname, "..", "..", "src", "index.ts");

/** Waits until `check` finds something; real pi answers on its own schedule. */
async function until<T>(check: () => T | undefined, timeoutMs = 30_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = check();
		if (value !== undefined) return value;
		if (Date.now() > deadline) throw new Error("timed out waiting for the model to receive the message");
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

describe("Recent refs in real pi", () => {
	it("lists a file the model read, inserts its path, and sends the file only when the session used it", async () => {
		const run = probeRun("none", { STUB_QUIET: "1", STUB_TOOL_CALL: JSON.stringify({ name: "read", arguments: { path: "src/api.ts" } }) });
		mkdirSync(join(run.dir, "src"));
		writeFileSync(join(run.dir, "src", "api.ts"), "export const api = 1;\n");
		writeFileSync(join(run.dir, ".env"), "SECRET=1\n");
		const agentDir = join(mkdtempSync(join(tmpdir(), "context-refs-agent-")), "agent");
		mkdirSync(agentDir, { recursive: true });
		const tui = new PtySession({ ...run.options, extensions: [EXTENSION], env: { ...run.options.env, PI_CODING_AGENT_DIR: agentDir } });
		await tui.ready();
		const sentTexts = () => run.received().map((received) => received.text);
		try {
			tui.type("look at the api\r");
			await tui.waitForScreen((screen) => screen.includes(QUIET_REPLY));

			tui.type("#");
			const open = await tui.waitForScreen((screen) => screen.includes("↺ src/api.ts"));
			assert.match(open, /↺ src\/api\.ts\s+recent · read/);
			tui.type("\t");
			await tui.waitForScreen((screen) => screen.includes("[ref:src/api.ts]") && !screen.includes("recent ·"));
			tui.type(" now\r");
			await until(() => sentTexts().find((text) => text === "src/api.ts now"));

			tui.type("see [ref:file:src/api.ts] and [ref:file:.env]\r");
			const sent = await until(() => sentTexts().find((text) => text.startsWith("see [ref:file:src/api.ts] and [ref:file:.env]")));
			assert.ok(sent.includes('<context-ref name="src/api.ts" kind="file" path="src/api.ts" bytes="22">\nexport const api = 1;\n'), sent);
			assert.ok(!sent.includes("SECRET"), "a file nothing in the session used is not read");
			assert.ok(!sent.includes('name=".env"'), sent);
		} finally {
			await tui.close();
		}
	});
});
