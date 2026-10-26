// Opt-in: runs real pi (`npm run test:smoke`). Needs no network and no credentials.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { GUARD_EXTENSION, RpcSession, runPrint, type RpcRecord } from "../support/pi-process.ts";
import { STUB_MODEL, STUB_PROVIDER, STUB_REPLY } from "../support/stub-provider.ts";

const isUiRequest = (method: string) => (record: RpcRecord) => record.type === "extension_ui_request" && record.method === method;

interface Workspace {
	agentDir: string;
	place: string;
	env: Record<string, string>;
	requests(): string[];
	configFiles(): string[];
}

function workspace(config?: unknown): Workspace {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "account-guard-tag-")));
	const agentDir = join(root, "agent");
	const place = join(root, "place");
	mkdirSync(agentDir);
	mkdirSync(place);
	const requestLog = join(root, "requests.txt");
	if (config !== undefined) writeFileSync(join(agentDir, "account-guard.json"), JSON.stringify(config));
	return {
		agentDir,
		place,
		env: { PI_CODING_AGENT_DIR: agentDir, STUB_REQUEST_LOG: requestLog },
		requests: () => (existsSync(requestLog) ? readFileSync(requestLog, "utf8").split("\n").filter(Boolean) : []),
		configFiles: () => readdirSync(agentDir).filter((name) => name.startsWith("account-guard")),
	};
}

describe("tag prompt over RPC (DESIGN.md section 10.1)", () => {
	it("serves a select of single zones, writes the first tag to a new file and sends the turn without a resubmit", async () => {
		const space = workspace();
		const rpc = new RpcSession({ extensions: [GUARD_EXTENSION], env: space.env, cwd: space.place });
		try {
			rpc.send({ id: "p1", type: "prompt", message: "hello" });
			const select = await rpc.waitFor(isUiRequest("select"));
			assert.equal(select.title, "This place is personal. Which zones does stub · fallback key belong to?");
			assert.deepEqual(select.options, ["work", "personal", "Several zones…"]);
			assert.deepEqual(space.requests(), [], "nothing is sent while the prompt is open");
			rpc.send({ type: "extension_ui_response", id: select.id, value: "personal" });
			await rpc.waitFor((record) => record.type === "agent_settled");
			assert.ok(JSON.stringify(rpc.records).includes(STUB_REPLY));
			assert.deepEqual(space.requests(), [STUB_MODEL]);
			assert.deepEqual(space.configFiles(), ["account-guard.json"], "no temporary file is left behind");
			assert.equal(
				readFileSync(join(space.agentDir, "account-guard.json"), "utf8"),
				`${JSON.stringify({ zones: ["work", "personal"], defaultZone: "personal", accounts: [{ provider: STUB_PROVIDER, source: "fallback", zones: ["personal"] }], places: [] }, null, 2)}\n`,
			);
			assert.equal(rpc.records.filter(isUiRequest("select")).length, 1, "the turn is not blocked again");
		} finally {
			await rpc.close();
		}
	});

	it("asks Several zones through an input and asks again on a bad name", async () => {
		const space = workspace();
		const rpc = new RpcSession({ extensions: [GUARD_EXTENSION], env: space.env, cwd: space.place });
		try {
			rpc.send({ id: "p1", type: "prompt", message: "hello" });
			const select = await rpc.waitFor(isUiRequest("select"));
			rpc.send({ type: "extension_ui_response", id: select.id, value: "Several zones…" });
			const first = await rpc.waitFor(isUiRequest("input"));
			rpc.send({ type: "extension_ui_response", id: first.id, value: "wrk" });
			const second = await rpc.waitFor((record) => isUiRequest("input")(record) && record.id !== first.id);
			assert.match(String(second.title), /^Not a declared zone: wrk\./);
			rpc.send({ type: "extension_ui_response", id: second.id, value: "work, personal" });
			await rpc.waitFor((record) => record.type === "agent_settled");
			assert.deepEqual(space.requests(), [STUB_MODEL]);
			assert.deepEqual(JSON.parse(readFileSync(join(space.agentDir, "account-guard.json"), "utf8")).accounts, [{ provider: STUB_PROVIDER, source: "fallback", zones: ["work", "personal"] }]);
		} finally {
			await rpc.close();
		}
	});

	it("falls to the Block select on Cancel and writes no file", async () => {
		const space = workspace();
		const rpc = new RpcSession({ extensions: [GUARD_EXTENSION], env: space.env, cwd: space.place });
		try {
			rpc.send({ id: "p1", type: "prompt", message: "hello" });
			const tag = await rpc.waitFor(isUiRequest("select"));
			rpc.send({ type: "extension_ui_response", id: tag.id, cancelled: true });
			const block = await rpc.waitFor((record) => isUiRequest("select")(record) && record.id !== tag.id);
			assert.match(String(block.title), /^BLOCKED {2}stub \(fallback\) has no zone tag/);
			assert.deepEqual(space.configFiles(), []);
			assert.deepEqual(space.requests(), []);
		} finally {
			await rpc.close();
		}
	});
});

describe("process Override (DESIGN.md section 10)", () => {
	const ALLOW = { PI_ACCOUNT_GUARD_ALLOW_UNKNOWN: "1" };

	it("lets an Unknown account through in print mode with one warning on stderr and exit 0", async () => {
		const space = workspace();
		const result = await runPrint("hello", { env: { ...space.env, ...ALLOW }, cwd: space.place });
		assert.equal(result.code, 0, result.stderr);
		assert.equal(result.stdout.trim(), STUB_REPLY);
		assert.match(result.stderr, /^guard: PI_ACCOUNT_GUARD_ALLOW_UNKNOWN=1 lets turns through to accounts with no zone tag, starting with stub \(fallback\)\./);
		assert.deepEqual(space.requests(), [STUB_MODEL]);
		assert.deepEqual(space.configFiles(), [], "the process Override writes nothing");
	});

	it("never lets a tagged account that fails to Match through", async () => {
		const space = workspace({ accounts: [{ provider: STUB_PROVIDER, source: "fallback", zones: ["work"] }] });
		const result = await runPrint("hello", { env: { ...space.env, ...ALLOW }, cwd: space.place });
		assert.equal(result.code, 77);
		assert.equal(result.stdout, "");
		assert.match(result.stderr, /^BLOCKED stub \(fallback\) is zone work/);
		assert.deepEqual(space.requests(), []);
	});

	it("is named in the headless Unknown message", async () => {
		const space = workspace();
		const result = await runPrint("hello", { env: space.env, cwd: space.place });
		assert.equal(result.code, 77);
		assert.match(result.stderr, /\nor set PI_ACCOUNT_GUARD_ALLOW_UNKNOWN=1 for this process\.\n$/);
	});

	it("lets an Unknown account through over RPC with no dialog", async () => {
		const space = workspace();
		const rpc = new RpcSession({ extensions: [GUARD_EXTENSION], env: { ...space.env, ...ALLOW }, cwd: space.place });
		try {
			rpc.send({ id: "p1", type: "prompt", message: "hello" });
			await rpc.waitFor((record) => record.type === "agent_settled");
			assert.deepEqual(space.requests(), [STUB_MODEL]);
			assert.equal(rpc.records.filter(isUiRequest("select")).length, 0);
			const warning = await rpc.waitFor(isUiRequest("notify"));
			assert.equal(warning.notifyType, "warning");
		} finally {
			await rpc.close();
		}
	});
});
