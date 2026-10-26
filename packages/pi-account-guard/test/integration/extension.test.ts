import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createJiti } from "jiti";
import { createFakeHost, createFakeSession } from "../support/fake-pi.ts";

const INDEX = join(import.meta.dirname, "..", "..", "src", "index.ts");

/** Loads the extension through jiti, as pi does, and runs its factory against a fake host. */
async function boot() {
	const jiti = createJiti(import.meta.url, { moduleCache: false });
	const factory = (await jiti.import(INDEX, { default: true })) as (pi: unknown) => unknown;
	assert.equal(typeof factory, "function", "src/index.ts default-exports the extension factory");
	const host = createFakeHost();
	await factory(host.pi);
	return host;
}

describe("extension load", () => {
	it("loads through jiti without registering behaviour", async () => {
		const host = await boot();
		assert.deepEqual(host.calls, []);
		assert.deepEqual(host.handledEvents(), []);
		assert.equal(host.commands.size, 0);
		assert.equal(host.providers.size, 0);
	});

	it("leaves a session untouched when events fire", async () => {
		const host = await boot();
		const session = createFakeSession();
		assert.equal(await host.fire("session_start", { reason: "startup" }, session.ctx), undefined);
		assert.equal(await host.fire("input", { text: "hello", source: "interactive" }, session.ctx), undefined);
		assert.deepEqual(session.notices, []);
		assert.equal(session.aborts, 0);
	});
});

describe("fake pi host", () => {
	it("runs registered handlers and keeps the last defined result", async () => {
		const host = createFakeHost();
		(host.pi.on as Function)("input", () => undefined);
		(host.pi.on as Function)("input", () => ({ action: "handled" }));
		assert.equal(host.handlerCount("input"), 2);
		assert.deepEqual(await host.fire("input", {}, {}), { action: "handled" });
	});

	it("records an unexpected API call", () => {
		const host = createFakeHost();
		(host.pi.registerShortcut as Function)("ctrl+g");
		assert.deepEqual(host.calls, [{ method: "registerShortcut", args: ["ctrl+g"] }]);
	});
});
