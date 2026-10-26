import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_CONFIG } from "../../src/core/config.ts";
import { createConfigState } from "../../src/core/config-state.ts";

const valid = JSON.stringify({ accounts: [{ provider: "acme", source: "oauth", zones: ["work"] }] });
const validConfig = { ...DEFAULT_CONFIG, accounts: [{ provider: "acme", source: "oauth", zones: ["work"] }] };

function stateOver(file: { text: string | undefined; failure?: Error }) {
	return createConfigState(() => {
		if (file.failure) throw file.failure;
		return file.text;
	});
}

describe("createConfigState", () => {
	it("reads a missing file as the default config", () => {
		assert.deepEqual(stateOver({ text: undefined }).load(), { result: { ok: true, config: DEFAULT_CONFIG } });
	});

	it("reads the file live on every load", () => {
		const file = { text: valid as string | undefined };
		const state = stateOver(file);
		assert.deepEqual(state.load().result, { ok: true, config: validConfig });
		file.text = "{}";
		assert.deepEqual(state.load().result, { ok: true, config: DEFAULT_CONFIG });
	});

	it("is invalid when the first read is malformed and there is no valid copy", () => {
		const snapshot = stateOver({ text: "{ nope" }).load();
		assert.equal(snapshot.result.ok, false);
		assert.equal(snapshot.warning, undefined);
	});

	it("falls back to the last valid copy when the file turns malformed, warning once", () => {
		const file = { text: valid as string | undefined };
		const state = stateOver(file);
		state.load();
		file.text = JSON.stringify({ colour: 1 });
		const first = state.load();
		assert.deepEqual(first.result, { ok: true, config: validConfig });
		assert.deepEqual(first.warning, { errors: [{ path: "", message: 'unknown field "colour"' }] });
		const second = state.load();
		assert.deepEqual(second.result, { ok: true, config: validConfig });
		assert.equal(second.warning, undefined);
		assert.deepEqual(second.fallback, first.fallback, "every read that falls back reports the errors, the warning only the first");
		assert.deepEqual(first.fallback, { errors: [{ path: "", message: 'unknown field "colour"' }] });
	});

	it("falls back when the file cannot be read", () => {
		const file: { text: string | undefined; failure?: Error } = { text: valid };
		const state = stateOver(file);
		state.load();
		file.failure = new Error("EACCES");
		const snapshot = state.load();
		assert.deepEqual(snapshot.result, { ok: true, config: validConfig });
		assert.deepEqual(snapshot.warning, { errors: [{ path: "", message: "cannot read the file: EACCES" }] });
	});

	it("uses the fixed file again once it is valid", () => {
		const file = { text: valid as string | undefined };
		const state = stateOver(file);
		state.load();
		file.text = "{ nope";
		state.load();
		file.text = "{}";
		assert.deepEqual(state.load(), { result: { ok: true, config: DEFAULT_CONFIG } });
	});

	it("forgets the last valid copy on reset", () => {
		const file = { text: valid as string | undefined };
		const state = stateOver(file);
		state.load();
		state.reset();
		file.text = "{ nope";
		assert.equal(state.load().result.ok, false);
	});

	it("never offers the last valid copy to a writer: a malformed file refuses the write", () => {
		const file = { text: valid as string | undefined };
		const state = stateOver(file);
		state.load();
		file.text = "{ nope";
		assert.equal(state.load().result.ok, true);
		assert.equal(state.readForWrite().ok, false);
		file.text = valid;
		assert.deepEqual(state.readForWrite(), { ok: true, config: validConfig });
	});
});
