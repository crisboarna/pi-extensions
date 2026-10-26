// Opt-in: runs real pi (`npm run test:smoke`). Needs no network and no credentials.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { GUARD_EXTENSION, type RpcRecord, RpcSession } from "../support/pi-process.ts";
import { STUB_PROVIDER } from "../support/stub-provider.ts";

const isUiRequest = (method: string) => (record: RpcRecord) => record.type === "extension_ui_request" && record.method === method;

async function withGuard(config: object, body: (rpc: RpcSession, configFile: string, place: string) => Promise<void>): Promise<void> {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "account-guard-command-")));
	const agentDir = join(root, "agent");
	const place = join(root, "place");
	mkdirSync(agentDir);
	mkdirSync(place);
	const configFile = join(agentDir, "account-guard.json");
	writeFileSync(configFile, JSON.stringify(config));
	const rpc = new RpcSession({ extensions: [GUARD_EXTENSION], env: { PI_CODING_AGENT_DIR: agentDir }, cwd: place });
	try {
		await body(rpc, configFile, place);
	} finally {
		await rpc.close();
	}
}

const isUntagNotice = (record: RpcRecord) => isUiRequest("notify")(record) && record.message === `Untagged ${STUB_PROVIDER} (fallback) (was work).`;

describe("/guard over RPC", () => {
	it("prints the status block through notify and draws the footer", async () => {
		await withGuard({ accounts: [{ provider: STUB_PROVIDER, source: "fallback", zones: ["personal"] }] }, async (rpc) => {
			const footer = await rpc.waitFor((record) => isUiRequest("setStatus")(record) && record.statusKey === "guard" && record.statusText !== undefined);
			assert.equal(footer.statusText, "guard personal ✓");
			rpc.send({ id: "g1", type: "prompt", message: "/guard" });
			const status = await rpc.waitFor((record) => isUiRequest("notify")(record) && String(record.message).startsWith("guard status"));
			assert.match(String(status.message), /^ Place {5}.* -> personal \(default zone\)$/m);
			assert.match(String(status.message), /^ Account {3}stub \(fallback\) -> personal {2}✓ Match$/m);
			assert.match(String(status.message), /^ Untagged {2}none$/m);
		});
	});

	it("tags and untags with full arguments, and the footer follows", async () => {
		await withGuard({ accounts: [] }, async (rpc, configFile) => {
			rpc.send({ id: "g1", type: "prompt", message: `/guard tag ${STUB_PROVIDER} fallback work` });
			await rpc.waitFor((record) => isUiRequest("setStatus")(record) && record.statusText === "guard personal ✗ stub is work");
			assert.deepEqual(JSON.parse(readFileSync(configFile, "utf8")).accounts, [{ provider: STUB_PROVIDER, source: "fallback", zones: ["work"] }]);
			rpc.send({ id: "g2", type: "prompt", message: "/guard untag" });
			await rpc.waitFor(isUntagNotice);
			const footers = rpc.records
				.filter((record) => isUiRequest("setStatus")(record) && record.statusText !== undefined)
				.map((record) => record.statusText);
			assert.equal(footers.at(-1), "guard personal ? untagged");
			assert.deepEqual(JSON.parse(readFileSync(configFile, "utf8")).accounts, []);
		});
	});

	it("adds a place rule with full arguments, and the footer uses the new zone without a reload", async () => {
		await withGuard({ accounts: [{ provider: STUB_PROVIDER, source: "fallback", zones: ["work"] }] }, async (rpc, configFile, place) => {
			await rpc.waitFor((record) => isUiRequest("setStatus")(record) && record.statusText === "guard personal ✗ stub is work");
			rpc.send({ id: "g1", type: "prompt", message: "/guard place add path=here zone=work" });
			await rpc.waitFor((record) => isUiRequest("setStatus")(record) && record.statusText === "guard work ✓");
			assert.deepEqual(JSON.parse(readFileSync(configFile, "utf8")).places, [{ path: place, zone: "work" }]);
			rpc.send({ id: "g2", type: "prompt", message: "/guard place list" });
			const list = await rpc.waitFor((record) => isUiRequest("notify")(record) && String(record.message).startsWith("guard place rules"));
			assert.equal(list.message, `guard place rules\n 1. ${place} -> work   <- decides this place\n default zone: personal`);
		});
	});

	it("confirms a default zone change that moves this place, and refuses to remove a referenced zone", async () => {
		await withGuard({ accounts: [{ provider: STUB_PROVIDER, source: "fallback", zones: ["work"] }] }, async (rpc, configFile) => {
			rpc.send({ id: "g1", type: "prompt", message: "/guard zone remove work" });
			const refused = await rpc.waitFor(
				(record) => isUiRequest("notify")(record) && String(record.message).startsWith("guard: did not remove zone work"),
			);
			assert.equal(refused.message, `guard: did not remove zone work. It is still referenced by:\n  tag ${STUB_PROVIDER} (fallback)`);
			rpc.send({ id: "g2", type: "prompt", message: "/guard zone default work" });
			const confirm = await rpc.waitFor(isUiRequest("confirm"));
			assert.equal(confirm.title, "Change the default zone to work?");
			assert.match(String(confirm.message), /This place changes from zone personal to zone work\.$/);
			rpc.send({ type: "extension_ui_response", id: confirm.id, confirmed: true });
			await rpc.waitFor((record) => isUiRequest("setStatus")(record) && record.statusText === "guard work ✓");
			assert.equal(JSON.parse(readFileSync(configFile, "utf8")).defaultZone, "work");
		});
	});
});
