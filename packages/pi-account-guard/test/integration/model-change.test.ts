import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { registerGuard } from "../../src/pi/hooks.ts";
import { attachDialogs, type FakeModel } from "../support/fake-dialogs.ts";
import { createFakeHost, createFakeSession } from "../support/fake-pi.ts";

const CONFIG_PATH = "/home/me/.pi/agent/account-guard.json";

const acmeMid: FakeModel = { provider: "acme", id: "mid" };
const betaMid: FakeModel = { provider: "beta", id: "mid", auth: { usingOAuth: true, status: { configured: true, source: "stored" } } };
const models: FakeModel[] = [
	acmeMid,
	{ provider: "acme", id: "big" },
	{ provider: "beta", id: "small", auth: { usingOAuth: true, status: { configured: true, source: "stored" } } },
	betaMid,
	{ provider: "gamma", id: "g1", auth: { status: { configured: true, source: "environment", label: "GAMMA_KEY" } } },
];

const config = {
	accounts: [
		{ provider: "acme", source: "stored-key", zones: ["work"] },
		{ provider: "beta", source: "oauth", zones: ["personal"] },
		{ provider: "gamma", source: "env:GAMMA_KEY", zones: ["personal"] },
	],
};

/** A guard in a personal place; the session starts on `beta/mid` (a Match) with a turn running. */
function rig({ hasUI = true, fileText = JSON.stringify(config) }: { hasUI?: boolean; fileText?: string | undefined } = {}) {
	const host = createFakeHost();
	const session = createFakeSession({ cwd: "/srv/app", hasUI, model: betaMid, idle: false });
	const dialogs = attachDialogs(host, session, models);
	const state = { idle: false };
	session.ctx.isIdle = () => state.idle;
	const stderr: string[] = [];
	const exitCodes: number[] = [];
	registerGuard(dialogs.pi as never, {
		home: "/home/me",
		configPath: CONFIG_PATH,
		readConfigText: () => fileText,
		realpath: (path) => path,
		readRemoteUrls: () => ({ ok: true, urls: [] }),
		writeStderr: (text) => void stderr.push(text),
		setExitCode: (code) => void exitCodes.push(code),
	});
	/** Changes the model the way pi does, then fires `model_select` with the model before the change. */
	const changeModel = async (next: FakeModel, previous: FakeModel | undefined = session.ctx.model) => {
		session.ctx.model = next;
		await host.fire("model_select", { type: "model_select", model: next, previousModel: previous, source: "set" }, session.ctx);
	};
	const settle = () => {
		state.idle = true;
		return host.fire("agent_settled", { type: "agent_settled", aborted: true }, session.ctx);
	};
	const entries = (type: string) => host.entries.filter((entry) => entry.customType === type);
	return { host, session, dialogs, state, stderr, exitCodes, changeModel, settle, entries };
}

describe("model_select during a turn", () => {
	it("aborts the turn and says a failover was blocked, naming the new account and the place", async () => {
		const r = rig();
		await r.changeModel(acmeMid);
		assert.equal(r.session.aborts, 1);
		assert.deepEqual(r.session.notices, [
			{
				message: "guard: failover blocked, model changed to acme (stored-key) [work] during a turn in a personal place (/srv/app). Turn aborted.",
				type: "error",
			},
		]);
		assert.deepEqual(
			r.entries("guard.block").map((entry) => entry.data.cause),
			["zone-mismatch"],
		);
	});

	it("does nothing when the new model matches the place", async () => {
		const r = rig();
		await r.changeModel({ provider: "gamma", id: "g1", auth: { status: { configured: true, source: "environment", label: "GAMMA_KEY" } } }, betaMid);
		assert.equal(r.session.aborts, 0);
		assert.deepEqual(r.session.notices, []);
	});

	it("does nothing when the agent is idle: the next input or run start Blocks", async () => {
		const r = rig();
		r.state.idle = true;
		await r.changeModel(acmeMid);
		assert.equal(r.session.aborts, 0);
		assert.deepEqual(r.session.notices, []);
		await r.settle();
		assert.deepEqual(r.dialogs.selects, []);
	});

	it("evaluates the context model, not the model of the event", async () => {
		const r = rig();
		// A nested emission: the event still names the blocked model, but the session is back on a match.
		r.session.ctx.model = betaMid;
		await r.host.fire("model_select", { type: "model_select", model: acmeMid, previousModel: betaMid, source: "set" }, r.session.ctx);
		assert.equal(r.session.aborts, 0);
	});

	it("lets a session Override through", async () => {
		const r = rig();
		await r.changeModel(acmeMid);
		r.dialogs.selectAnswers.push(/^Allow for session/);
		await r.settle();
		await r.changeModel(betaMid);
		r.state.idle = false;
		await r.changeModel(acmeMid);
		assert.equal(r.session.aborts, 1, "the second change to the allowed account is not aborted");
	});

	it("announces once when nested emissions abort twice", async () => {
		const r = rig();
		await r.changeModel(acmeMid);
		await r.changeModel(acmeMid, acmeMid);
		assert.equal(r.session.aborts, 2);
		assert.equal(r.session.notices.length, 1);
		assert.equal(r.entries("guard.block").length, 1);
	});

	it("aborts and reports a failing check instead of letting the turn run", async () => {
		const r = rig();
		(r.session.ctx.modelRegistry as { getProviderAuthStatus: () => never }).getProviderAuthStatus = () => {
			throw new Error("auth lookup failed");
		};
		await r.changeModel(acmeMid);
		assert.equal(r.session.aborts, 1);
		assert.match(r.session.notices[0]!.message, /the model_select handler failed \(auth lookup failed\)/);
		assert.equal(r.entries("guard.error").length, 1);
	});
});

describe("the select once idle", () => {
	it("opens when the aborted turn settles, previous account first, without Allow once", async () => {
		const r = rig();
		await r.changeModel(acmeMid);
		assert.equal(r.dialogs.selects.length, 0, "nothing opens while the turn is still running");
		await r.settle();
		assert.equal(r.dialogs.selects.length, 1);
		assert.equal(r.dialogs.selects[0]!.title, "BLOCKED  acme (stored-key) is zone work\nPlace /srv/app -> zone personal");
		assert.deepEqual(r.dialogs.selects[0]!.options, [
			"Switch to beta (oauth) -> mid  [personal]",
			"Switch to gamma (env:GAMMA_KEY) -> g1  [personal]",
			"Allow for session: acme (stored-key)",
			"Cancel",
		]);
	});

	it("puts the previous account first even when it is not first in the config", async () => {
		const r = rig();
		r.session.ctx.model = { provider: "gamma", id: "g1", auth: { status: { configured: true, source: "environment", label: "GAMMA_KEY" } } };
		await r.changeModel(acmeMid);
		await r.settle();
		assert.deepEqual(r.dialogs.selects[0]!.options.slice(0, 2), [
			"Switch to gamma (env:GAMMA_KEY) -> g1  [personal]",
			"Switch to beta (oauth) -> small  [personal]",
		]);
	});

	it("Switch sets the model and does not resume the aborted turn", async () => {
		const r = rig();
		await r.changeModel(acmeMid);
		r.dialogs.selectAnswers.push(/^Switch to beta/);
		await r.settle();
		assert.deepEqual(r.dialogs.modelChanges, ["beta/mid"]);
		assert.equal(r.session.notices.at(-1)!.message, "Switched to beta (oauth). The aborted turn is not resumed.");
		assert.deepEqual(r.host.sentMessages, []);
		assert.deepEqual(r.session.editorTexts, []);
	});

	it("Allow for session logs the Override and shows it in the footer", async () => {
		const r = rig();
		await r.changeModel(acmeMid);
		r.dialogs.selectAnswers.push(/^Allow for session/);
		await r.settle();
		assert.equal(r.session.statuses.get("guard"), "guard OVERRIDE acme in personal");
		assert.deepEqual(
			r.entries("guard.allow_session").map((entry) => entry.data.account),
			[{ provider: "acme", source: "stored-key" }],
		);
		assert.deepEqual(r.dialogs.modelChanges, []);
	});

	it("Cancel and no answer leave the model as it is", async () => {
		for (const answer of [/^Cancel$/, undefined]) {
			const r = rig();
			await r.changeModel(acmeMid);
			r.dialogs.selectAnswers.push(answer);
			await r.settle();
			assert.deepEqual(r.dialogs.modelChanges, []);
			assert.equal(r.session.ctx.model, acmeMid);
			assert.deepEqual(r.session.editorTexts, []);
			// The next user turn is blocked by `input`.
			r.state.idle = true;
			assert.deepEqual(await r.host.fire("input", { text: "again", source: "interactive" }, r.session.ctx), { action: "handled" });
		}
	});

	it("opens once per aborted turn", async () => {
		const r = rig();
		await r.changeModel(acmeMid);
		await r.settle();
		await r.settle();
		assert.equal(r.dialogs.selects.length, 1);
	});

	it("does not open when the model is back on a match by the time the run settles", async () => {
		const r = rig();
		await r.changeModel(acmeMid);
		r.session.ctx.model = betaMid;
		await r.settle();
		assert.deepEqual(r.dialogs.selects, []);
	});

	it("does not repeat the Block of a user turn that arrives before the run settles", async () => {
		const r = rig();
		await r.changeModel(acmeMid);
		r.dialogs.selectAnswers.push(/^Cancel$/);
		await r.host.fire("input", { text: "retry", source: "extension" }, r.session.ctx);
		await r.settle();
		assert.equal(r.dialogs.selects.length, 1, "only the select of the input Block");
	});

	it("does not open for a session start in between", async () => {
		const r = rig();
		await r.changeModel(acmeMid);
		await r.host.fire("session_start", { type: "session_start", reason: "new" }, r.session.ctx);
		await r.settle();
		assert.deepEqual(r.dialogs.selects, []);
	});

	it("reports a failing select instead of throwing", async () => {
		const r = rig();
		await r.changeModel(acmeMid);
		r.session.ctx.ui.select = async () => {
			throw new Error("dialog failed");
		};
		await r.settle();
		assert.match(r.session.notices.at(-1)!.message, /the agent_settled handler failed \(dialog failed\)/);
	});
});

describe("before_agent_start", () => {
	const start = (r: ReturnType<typeof rig>, event: Record<string, unknown> = { type: "before_agent_start", messageType: "user", prompt: "hi" }) =>
		r.host.fire("before_agent_start", event, r.session.ctx);

	it("passes a matching model", async () => {
		const r = rig();
		await start(r);
		assert.equal(r.session.aborts, 0);
	});

	it("aborts the run before it is sent when an idle-time switch left a non-matching account", async () => {
		const r = rig();
		r.session.ctx.model = acmeMid;
		await start(r);
		assert.equal(r.session.aborts, 1);
		assert.deepEqual(r.session.notices, [
			{
				message:
					"guard: blocked before sending, the model is acme (stored-key) [work] in a personal place (/srv/app). Run aborted, no request was sent.",
				type: "error",
			},
		]);
		assert.deepEqual(
			r.entries("guard.block").map((entry) => entry.data.cause),
			["zone-mismatch"],
		);
		assert.deepEqual(r.dialogs.selects, [], "the select belongs to the next input");
	});

	it("also checks a run started by a custom message with triggerTurn", async () => {
		const r = rig();
		r.session.ctx.model = acmeMid;
		await start(r, { type: "before_agent_start", messageType: "custom", message: { customType: "x", content: "y", display: false } });
		assert.equal(r.session.aborts, 1);
	});

	it("passes once an Override covers the account", async () => {
		const r = rig();
		await r.changeModel(acmeMid);
		r.dialogs.selectAnswers.push(/^Allow for session/);
		await r.settle();
		r.session.aborts = 0;
		await start(r);
		assert.equal(r.session.aborts, 0);
	});

	it("does nothing without a model", async () => {
		const r = rig();
		r.session.ctx.model = undefined;
		await start(r);
		assert.equal(r.session.aborts, 0);
	});

	it("aborts and reports a failing check", async () => {
		const r = rig();
		(r.session.ctx.modelRegistry as { isUsingOAuth: () => never }).isUsingOAuth = () => {
			throw new Error("boom");
		};
		await start(r);
		assert.equal(r.session.aborts, 1);
		assert.match(r.session.notices[0]!.message, /the before_agent_start handler failed \(boom\)/);
	});
});

describe("an Allow once grant", () => {
	// A model on an account with no tag: it Blocks, and no Override covers it.
	const deltaMid: FakeModel = { provider: "delta", id: "d1" };

	/** Idle on `acme/mid` (Blocked); the user chose Allow once at `input` and the turn is about to start. */
	async function grantedOnce() {
		const r = rig();
		r.state.idle = true;
		r.session.ctx.model = acmeMid;
		r.dialogs.selectAnswers.push(/^Allow once/);
		r.dialogs.confirmAnswers.push(true);
		assert.deepEqual(await r.host.fire("input", { text: "go", source: "interactive" }, r.session.ctx), { action: "continue" });
		return r;
	}

	/** After the grant ended, the same account in the same place Blocks again. */
	async function assertBlocksAgain(r: Awaited<ReturnType<typeof grantedOnce>>) {
		r.session.ctx.model = acmeMid;
		const before = r.dialogs.selects.length;
		assert.deepEqual(await r.host.fire("input", { text: "again", source: "interactive" }, r.session.ctx), { action: "handled" });
		assert.equal(r.dialogs.selects.length, before + 1, "the Block select opened");
	}

	it("ends with agent_end", async () => {
		const r = await grantedOnce();
		await r.host.fire("agent_end", {}, r.session.ctx);
		await assertBlocksAgain(r);
	});

	it("ends when before_agent_start aborts the run, which never reaches agent_end", async () => {
		const r = await grantedOnce();
		r.session.ctx.model = deltaMid;
		await r.host.fire("before_agent_start", { messageType: "user" }, r.session.ctx);
		assert.equal(r.session.aborts, 1);
		await assertBlocksAgain(r);
	});

	it("ends when the agent settles without an agent_end", async () => {
		const r = await grantedOnce();
		await r.settle();
		await assertBlocksAgain(r);
	});

	it("ends when a model change aborts the turn", async () => {
		const r = await grantedOnce();
		r.state.idle = false;
		await r.changeModel(deltaMid, acmeMid);
		assert.equal(r.session.aborts, 1);
		r.state.idle = true;
		await assertBlocksAgain(r);
	});

	it("ends when the user cancels a later Block", async () => {
		const r = await grantedOnce();
		r.session.ctx.model = deltaMid;
		assert.deepEqual(await r.host.fire("input", { text: "other", source: "interactive" }, r.session.ctx), { action: "handled" });
		await assertBlocksAgain(r);
	});
});

describe("headless", () => {
	it("writes the failover notice to stderr and exits 77 on a mid-turn change", async () => {
		const r = rig({ hasUI: false });
		await r.changeModel(acmeMid);
		assert.equal(r.session.aborts, 1);
		assert.deepEqual(r.stderr, [
			"guard: failover blocked, model changed to acme (stored-key) [work] during a turn in a personal place (/srv/app). Turn aborted.\n",
		]);
		assert.deepEqual(r.exitCodes, [77]);
		await r.settle();
		assert.deepEqual(r.dialogs.selects, []);
	});

	it("writes the Block message to stderr and exits 77 when before_agent_start finds a non-matching account", async () => {
		const r = rig({ hasUI: false });
		r.session.ctx.model = acmeMid;
		await r.host.fire("before_agent_start", { type: "before_agent_start", messageType: "user", prompt: "hi" }, r.session.ctx);
		assert.equal(r.session.aborts, 1);
		assert.equal(r.stderr.length, 1);
		assert.match(r.stderr[0]!, /^BLOCKED acme \(stored-key\) is zone work; this place\n\(\/srv\/app\) is zone personal\. No turn was sent\./);
		assert.deepEqual(r.exitCodes, [77]);
	});
});

describe("a simulated multi-pass rotation", () => {
	it("stops cleanly: one abort, one select, no automatic switch and no resumed turn", async () => {
		const r = rig();
		// multi-pass rotates inside agent_end by switching the model; the guard aborts and does not switch back.
		await r.host.fire("agent_end", { type: "agent_end", messages: [] }, r.session.ctx);
		await r.changeModel(acmeMid);
		await r.settle();
		assert.equal(r.session.aborts, 1);
		assert.equal(r.dialogs.selects.length, 1);
		assert.deepEqual(r.dialogs.modelChanges, []);
		assert.deepEqual(r.host.sentMessages, []);
		assert.equal(r.session.ctx.model, acmeMid);
	});
});
