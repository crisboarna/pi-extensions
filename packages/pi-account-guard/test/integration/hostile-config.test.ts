// The guard fails closed (ADR 0001): a config it cannot read or understand blocks the turn and names the cause, and never lets it through. The
// cases here are real files on a real disk read by the real reader, because what a file system does with a loop, a directory or a missing
// permission is not something a fake reader shows. Each case must block, say why, and leave the process alive.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { readTextIfPresent } from "../../src/pi/fs.ts";
import { registerGuard } from "../../src/pi/hooks.ts";
import { createFakeHost, createFakeSession } from "../support/fake-pi.ts";

let dir = "";
let file = "";

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "guard-hostile-"));
	file = join(dir, "account-guard.json");
});

afterEach(() => {
	try {
		chmodSync(file, 0o600);
	} catch {
		// the file is a directory, a link or missing
	}
	rmSync(dir, { recursive: true, force: true });
});

/** The byte order mark an editor can put in front of a file, built from its code point so that no source file holds the character itself. */
const BOM = String.fromCharCode(0xfeff);
const PERSONAL = { provider: "acme", source: "stored-key", zones: ["personal"] };

/** The guard over the real file: what one prompt does, what went to stderr and the exit codes set. */
async function prompt() {
	const host = createFakeHost();
	const stderr: string[] = [];
	const exitCodes: number[] = [];
	registerGuard(host.pi as never, {
		home: dir,
		configPath: file,
		readConfigText: readTextIfPresent,
		realpath: (path) => path,
		readRemoteUrls: () => ({ ok: true, urls: [] }),
		writeStderr: (text) => void stderr.push(text),
		setExitCode: (code) => void exitCodes.push(code),
	});
	const session = createFakeSession({ cwd: "/srv/app" });
	await host.fire("session_start", { reason: "startup" }, session.ctx);
	const started = Date.now();
	const outcome = await host.fire("input", { text: "hello", source: "interactive" }, session.ctx);
	return { outcome, stderr: stderr.join(""), exitCodes, milliseconds: Date.now() - started };
}

/** Writes `text` as the config and requires the turn to be blocked, with the cause in the message. */
async function blocks(text: string, cause: RegExp) {
	writeFileSync(file, text);
	const result = await prompt();
	assert.deepEqual(result.outcome, { action: "handled" }, "the turn is not sent");
	assert.deepEqual(result.exitCodes, [77]);
	assert.match(result.stderr, cause);
	return result;
}

describe("a config the guard cannot read or understand blocks the turn, and says why", () => {
	it("a byte order mark in front of valid JSON: a malformed file, not an accepted one", async () => {
		await blocks(`${BOM}${JSON.stringify({ accounts: [PERSONAL] })}`, /account-guard\.json: invalid JSON/);
	});

	it("a truncated file, as after an editor was killed mid-save", async () => {
		await blocks(JSON.stringify({ accounts: [PERSONAL] }).slice(0, 20), /invalid JSON/);
	});

	it("NUL bytes and text that is not JSON", async () => {
		await blocks("\u0000\u0000{{{{", /invalid JSON/);
	});

	for (const [name, text] of Object.entries({
		"a string": '"work"',
		null: "null",
		"a number": "42",
		"an array": "[]",
		"zones that are not an array": '{"zones":"work"}',
		"accounts that are an object": '{"accounts":{}}',
		"an account with no source": '{"accounts":[{"provider":"acme","zones":["work"]}]}',
		"a place rule with a relative path": '{"places":[{"path":"relative","zone":"work"}]}',
	})) {
		it(`${name} at the top level or in a field`, async () => {
			await blocks(text, /account-guard\.json: /);
		});
	}

	for (const key of ["__proto__", "constructor", "prototype", "toString"]) {
		it(`an unknown field named ${key} is refused, and nothing is added to every object`, async () => {
			await blocks(`{"${key}":{"zones":["work"],"polluted":true}}`, /unknown field/);
			assert.equal(({} as Record<string, unknown>).polluted, undefined, "Object.prototype is untouched");
			assert.equal(({} as Record<string, unknown>).zones, undefined);
		});
	}

	it("__proto__ inside an account is an unknown field too", async () => {
		await blocks('{"accounts":[{"provider":"acme","source":"stored-key","zones":["personal"],"__proto__":{"zones":["work"]}}]}', /unknown field/);
	});

	it("10 MB of text that is not JSON blocks the turn at once instead of hanging it", async () => {
		const result = await blocks("x".repeat(10 * 1024 * 1024), /invalid JSON/);
		assert.ok(result.milliseconds < 5000, `took ${result.milliseconds} ms`);
	});

	it("10 MB of valid JSON that is not a config blocks the turn at once", async () => {
		const result = await blocks(`["${"x".repeat(10 * 1024 * 1024)}"]`, /account-guard\.json: /);
		assert.ok(result.milliseconds < 5000, `took ${result.milliseconds} ms`);
	});

	it("a symlink that points at itself: the read fails, and a failed read is not a missing file", async () => {
		symlinkSync(file, file);
		const result = await prompt();
		assert.deepEqual(result.outcome, { action: "handled" });
		assert.match(result.stderr, /cannot read the file: ELOOP/);
	});

	it("a directory where the file should be", async () => {
		mkdirSync(file);
		const result = await prompt();
		assert.deepEqual(result.outcome, { action: "handled" });
		assert.match(result.stderr, /cannot read the file: EISDIR/);
	});

	it("a file nobody may read", { skip: process.getuid?.() === 0 ? "root can read it" : false }, async () => {
		writeFileSync(file, JSON.stringify({ accounts: [PERSONAL] }));
		chmodSync(file, 0o000);
		const result = await prompt();
		assert.deepEqual(result.outcome, { action: "handled" }, "an unreadable config does not become the defaults");
		assert.match(result.stderr, /cannot read the file: EACCES/);
	});

	it("a symlink to a file that is not there is a missing config: the defaults, under which an untagged account is blocked", async () => {
		symlinkSync(join(dir, "nowhere.json"), file);
		const result = await prompt();
		assert.deepEqual(result.outcome, { action: "handled" });
		assert.match(result.stderr, /has no zone tag/);
	});

	it("the next turn reads the file again: once it is fixed the turn goes", async () => {
		writeFileSync(file, "{ not json");
		assert.deepEqual((await prompt()).outcome, { action: "handled" });
		writeFileSync(file, JSON.stringify({ accounts: [PERSONAL] }));
		const fixed = await prompt();
		assert.equal(fixed.outcome, undefined);
		assert.deepEqual(fixed.exitCodes, []);
	});
});
