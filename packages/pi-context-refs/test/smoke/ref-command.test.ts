// Opt-in: runs real pi (`npm run test:smoke`). `/ref` works in print mode with full arguments, and a Ref it saves is used by the next run.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { type RpcRecord, RpcSession, runPrint } from "../support/pi-process.ts";
import { probeRun } from "../support/probe-run.ts";

const EXTENSION = join(import.meta.dirname, "..", "..", "src", "index.ts");

/** Runs of the real extension that share one agent directory, like separate `pi -p` calls by one user. */
function user() {
	const agentDir = join(mkdtempSync(join(tmpdir(), "context-refs-agent-")), "agent");
	mkdirSync(agentDir, { recursive: true });
	return {
		agentDir,
		async pi(prompt: string) {
			const probe = probeRun("none");
			const options = { ...probe.options, extensions: [EXTENSION], env: { ...probe.options.env, PI_CODING_AGENT_DIR: agentDir } };
			const result = await runPrint(prompt, options);
			return { ...result, received: probe.received() };
		},
	};
}

describe("/ref in print mode (DESIGN.md section 14)", () => {
	it("adds a Ref with `pi -p`, then the next message uses it", async () => {
		const me = user();
		const added = await me.pi('/ref add terse snippet "Answer in one sentence." desc="Keep it short" tags=style');
		assert.equal(added.code, 0, added.stderr);
		assert.match(added.stderr, /Added snippet Ref "terse" to the Global library/);
		assert.deepEqual(added.received, [], "a command does not reach the model");
		assert.equal(added.stdout, "", "its output goes to stderr, never stdout");
		const saved = JSON.parse(readFileSync(join(me.agentDir, "pi-context-refs.json"), "utf8"));
		assert.deepEqual(saved.refs, [{ name: "terse", kind: "snippet", text: "Answer in one sentence.", description: "Keep it short", tags: ["style"] }]);

		const used = await me.pi("Explain #terse");
		assert.equal(used.code, 0, used.stderr);
		assert.deepEqual(used.received, [{ text: "Explain Answer in one sentence.", images: 0 }]);
	});

	it("lists, edits and removes Refs, and fails with the usage when arguments are missing", async () => {
		const me = user();
		await me.pi("/ref add agents path AGENTS.md");
		const listed = await me.pi("/ref list");
		assert.match(listed.stderr, /^trigger: #$/m);
		assert.match(listed.stderr, /^ {2}agents {2}path {2}AGENTS\.md$/m);

		const edited = await me.pi("/ref edit agents path=docs/AGENTS.md");
		assert.match(edited.stderr, /Edited path Ref "agents"/);
		assert.deepEqual((await me.pi("See #agents")).received, [{ text: "See docs/AGENTS.md", images: 0 }]);

		const missing = await me.pi("/ref add agents");
		assert.match(missing.stderr, /\/ref add <name> <kind> <target…>/);

		const clash = await me.pi("/ref add AGENTS path x");
		assert.match(clash.stderr, /already in the Global library as "agents"; change it with \/ref edit agents/);

		const removed = await me.pi("/ref remove agents");
		assert.match(removed.stderr, /Removed "agents" from the Global library/);
		assert.deepEqual((await me.pi("See #agents")).received, [{ text: "See #agents", images: 0 }]);
	});
});

const isUiRequest = (method: string) => (record: RpcRecord) => record.type === "extension_ui_request" && record.method === method;

describe("/ref in RPC mode", () => {
	it("reports through notify and asks the client to confirm a removal", async () => {
		const me = user();
		const probe = probeRun("none");
		const rpc = new RpcSession({ ...probe.options, extensions: [EXTENSION], env: { ...probe.options.env, PI_CODING_AGENT_DIR: me.agentDir } });
		try {
			rpc.send({ id: "a", type: "prompt", message: "/ref add terse snippet Be brief." });
			const added = await rpc.waitFor(isUiRequest("notify"));
			assert.equal(added.message, 'Added snippet Ref "terse" to the Global library');
			rpc.send({ id: "r", type: "prompt", message: "/ref remove terse" });
			const confirm = await rpc.waitFor(isUiRequest("confirm"));
			assert.equal(confirm.title, 'Remove "terse"?');
			assert.match(String(confirm.message), /snippet Ref in the Global library/);
			rpc.send({ type: "extension_ui_response", id: confirm.id, confirmed: true });
			await rpc.waitFor((record) => isUiRequest("notify")(record) && record.message === 'Removed "terse" from the Global library');
		} finally {
			await rpc.close();
		}
		assert.deepEqual(JSON.parse(readFileSync(join(me.agentDir, "pi-context-refs.json"), "utf8")).refs, []);
	});
});
