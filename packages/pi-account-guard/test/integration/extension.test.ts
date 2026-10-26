import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createJiti } from "jiti";
import { createFakeHost, createFakeSession } from "../support/fake-pi.ts";

const INDEX = join(import.meta.dirname, "..", "..", "src", "index.ts");

/** Loads the extension through jiti, as pi does, and runs its factory against a fake host. */
async function boot() {
	process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "account-guard-agent-"));
	const jiti = createJiti(import.meta.url, { moduleCache: false });
	// pi loads extensions through jiti, so that is the default. The coverage run imports natively instead:
	// V8 coverage cannot map code that jiti transforms back to the source files.
	const factory = (
		process.env.ACCOUNT_GUARD_NATIVE_IMPORT === "1" ? ((await import(INDEX)) as { default: unknown }).default : await jiti.import(INDEX, { default: true })
	) as (pi: unknown) => unknown;
	assert.equal(typeof factory, "function", "src/index.ts default-exports the extension factory");
	const host = createFakeHost();
	await factory(host.pi);
	return host;
}

describe("extension load", () => {
	it("loads through jiti and registers only the guard command and the session_start, input, model_select, before_agent_start, agent_settled and agent_end handlers", async () => {
		const host = await boot();
		assert.deepEqual(
			host.calls.filter((call) => call.method !== "on" && call.method !== "registerCommand"),
			[],
		);
		assert.deepEqual([...host.commands.keys()], ["guard"]);
		assert.deepEqual(host.handledEvents().sort(), ["agent_end", "agent_settled", "before_agent_start", "input", "model_select", "session_start"]);
		assert.equal(host.providers.size, 0);
	});

	it("asks the Tag prompt, then blocks an untagged account from the real wiring when the agent directory has no config", async () => {
		const host = await boot();
		const session = createFakeSession({ hasUI: true, cwd: tmpdir() });
		const titles: string[] = [];
		session.ctx.ui.select = async (title: string) => void titles.push(title);
		assert.equal(await host.fire("session_start", { reason: "startup" }, session.ctx), undefined);
		assert.deepEqual(await host.fire("input", { text: "hello", source: "interactive" }, session.ctx), { action: "handled" });
		assert.match(titles[0] ?? "", /^This place is personal\. Which zones does acme · saved API key belong to\?$/);
		assert.match(titles[1] ?? "", /^BLOCKED {2}acme \(stored-key\) has no zone tag/);
	});
});

describe("fake pi host", () => {
	it("runs registered handlers and keeps the last defined result", async () => {
		const host = createFakeHost();
		(host.pi.on as (...args: unknown[]) => unknown)("input", () => undefined);
		(host.pi.on as (...args: unknown[]) => unknown)("input", () => ({ action: "handled" }));
		assert.equal(host.handlerCount("input"), 2);
		assert.deepEqual(await host.fire("input", {}, {}), { action: "handled" });
	});

	it("records an unexpected API call", () => {
		const host = createFakeHost();
		(host.pi.registerShortcut as (...args: unknown[]) => unknown)("ctrl+g");
		assert.deepEqual(host.calls, [{ method: "registerShortcut", args: ["ctrl+g"] }]);
	});
});
