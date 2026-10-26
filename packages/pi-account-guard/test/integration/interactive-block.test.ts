import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { registerGuard } from "../../src/pi/hooks.ts";
import { attachDialogs, type FakeModel } from "../support/fake-dialogs.ts";
import { createFakeHost, createFakeSession } from "../support/fake-pi.ts";

const CONFIG_PATH = "/home/me/.pi/agent/account-guard.json";

const acmeMid: FakeModel = { provider: "acme", id: "mid" };
const models: FakeModel[] = [
	acmeMid,
	{ provider: "acme", id: "big" },
	{ provider: "beta", id: "small", auth: { usingOAuth: true, status: { configured: true, source: "stored" } } },
	{ provider: "beta", id: "mid", auth: { usingOAuth: true, status: { configured: true, source: "stored" } } },
	{ provider: "gamma", id: "g1", auth: { status: { configured: true, source: "environment", label: "GAMMA_KEY" } } },
	{ provider: "gamma", id: "g2", auth: { status: { configured: true, source: "environment", label: "GAMMA_KEY" } } },
];

const config = {
	accounts: [
		{ provider: "acme", source: "stored-key", zones: ["work"] },
		{ provider: "beta", source: "oauth", zones: ["personal"] },
		{ provider: "gamma", source: "env:GAMMA_KEY", zones: ["personal", "work"] },
		{ provider: "delta", source: "oauth", zones: ["personal"] },
	],
};

/** A guard in a personal place, a TUI session on `acme/mid` (tagged work, so it Blocks), and scripted dialogs. */
function rig(fileText: string | undefined = JSON.stringify(config)) {
	const host = createFakeHost();
	const session = createFakeSession({ cwd: "/srv/app", hasUI: true, model: acmeMid });
	const dialogs = attachDialogs(host, session, models);
	const file = { text: fileText };
	const stderr: string[] = [];
	registerGuard(dialogs.pi as never, {
		home: "/home/me",
		configPath: CONFIG_PATH,
		readConfigText: () => file.text,
		realpath: (path) => path,
		readRemoteUrls: () => ({ ok: true, urls: [] }),
		writeStderr: (text) => void stderr.push(text),
		setExitCode: () => undefined,
	});
	const input = (text = "my prompt") => host.fire("input", { text, source: "interactive" }, session.ctx);
	const entries = (type: string) => host.entries.filter((entry) => entry.customType === type);
	return { host, session, dialogs, file, stderr, input, entries };
}

describe("Block select", () => {
	it("shows the Switch rows with their zones, then both Overrides, then Cancel", async () => {
		const r = rig();
		await r.input();
		assert.equal(r.dialogs.selects.length, 1);
		assert.equal(r.dialogs.selects[0]!.title, "BLOCKED  acme (stored-key) is zone work\nPlace /srv/app -> zone personal");
		assert.deepEqual(r.dialogs.selects[0]!.options, [
			"Switch to beta (oauth) -> mid  [personal]",
			"Switch to gamma (env:GAMMA_KEY) -> g1  [personal, work]",
			"Allow once: this turn to acme (stored-key)",
			"Allow for session: acme (stored-key)",
			"Cancel",
		]);
	});

	it("writes a guard.block entry naming the account, place and zone", async () => {
		const r = rig();
		await r.input();
		assert.deepEqual(r.entries("guard.block"), [
			{ customType: "guard.block", data: { account: { provider: "acme", source: "stored-key" }, cause: "zone-mismatch", place: { path: "/srv/app", zone: "personal" } } },
		]);
	});

	it("also logs a headless Block", async () => {
		const r = rig();
		(r.session.ctx as { hasUI: boolean }).hasUI = false;
		await r.input();
		assert.equal(r.entries("guard.block").length, 1);
		assert.equal(r.dialogs.selects.length, 0);
		assert.equal(r.stderr.length, 1);
	});
});

describe("Switch", () => {
	it("sets the model, keeps the model id the target offers, and sends the same prompt", async () => {
		const r = rig();
		r.dialogs.selectAnswers.push(/^Switch to beta/);
		assert.deepEqual(await r.input(), { action: "continue" });
		assert.deepEqual(r.dialogs.modelChanges, ["beta/mid"]);
		assert.deepEqual(r.session.notices, [{ message: "Switched to beta (oauth), sending.", type: "info" }]);
		assert.deepEqual(r.session.editorTexts, []);
		assert.equal(await r.input(), undefined, "the next turn matches");
		assert.equal(r.dialogs.selects.length, 1);
	});

	it("uses the first model of the target and says so when the current id is not offered", async () => {
		const r = rig();
		r.dialogs.selectAnswers.push(/^Switch to gamma/);
		assert.deepEqual(await r.input(), { action: "continue" });
		assert.deepEqual(r.dialogs.modelChanges, ["gamma/g1"]);
		assert.equal(r.session.notices[0]!.message, "Switched to gamma (env:GAMMA_KEY) using model g1 (mid not offered), sending.");
	});

	it("never switches by itself", async () => {
		const r = rig();
		await r.input();
		assert.deepEqual(r.dialogs.modelChanges, []);
	});
});

describe("Cancel", () => {
	it("puts the typed prompt back in the editor", async () => {
		const r = rig();
		r.dialogs.selectAnswers.push(/^Cancel$/);
		assert.deepEqual(await r.input("typed text"), { action: "handled" });
		assert.deepEqual(r.session.editorTexts, ["typed text"]);
		assert.deepEqual(r.dialogs.modelChanges, []);
	});

	it("counts no answer as Cancel", async () => {
		const r = rig();
		r.dialogs.selectAnswers.push(undefined);
		assert.deepEqual(await r.input("typed text"), { action: "handled" });
		assert.deepEqual(r.session.editorTexts, ["typed text"]);
	});

	it("stays blocked on the next turn", async () => {
		const r = rig();
		await r.input();
		await r.input();
		assert.equal(r.dialogs.selects.length, 2);
	});
});

describe("Allow once", () => {
	it("asks a confirm naming the account and the place zone, then passes the turn and logs it", async () => {
		const r = rig();
		r.dialogs.selectAnswers.push(/^Allow once/);
		r.dialogs.confirmAnswers.push(true);
		assert.deepEqual(await r.input(), { action: "continue" });
		assert.deepEqual(r.dialogs.confirms, [{ title: "Allow once?", message: "Send ONE turn to acme (stored-key), zone work, from a personal place (/srv/app)." }]);
		assert.equal(r.entries("guard.allow_once").length, 1);
		assert.deepEqual(r.entries("guard.allow_once")[0]!.data.place, { path: "/srv/app", zone: "personal" });
		assert.deepEqual(r.session.editorTexts, []);
	});

	it("counts a declined confirm as Cancel", async () => {
		const r = rig();
		r.dialogs.selectAnswers.push(/^Allow once/);
		r.dialogs.confirmAnswers.push(false);
		assert.deepEqual(await r.input("typed text"), { action: "handled" });
		assert.deepEqual(r.session.editorTexts, ["typed text"]);
		assert.equal(r.entries("guard.allow_once").length, 0);
	});

	it("covers the confirmed account until agent_end, then Blocks again", async () => {
		const r = rig();
		r.dialogs.selectAnswers.push(/^Allow once/);
		r.dialogs.confirmAnswers.push(true);
		await r.input();
		assert.equal(await r.input(), undefined, "same turn: no second dialog");
		assert.equal(r.dialogs.selects.length, 1);
		await r.host.fire("agent_end", { messages: [] }, r.session.ctx);
		await r.input();
		assert.equal(r.dialogs.selects.length, 2, "the next turn Blocks again");
	});

	it("does not cover a later switch to another non-matching account", async () => {
		const r = rig(JSON.stringify({ accounts: [{ provider: "acme", source: "stored-key", zones: ["work"] }, { provider: "beta", source: "oauth", zones: ["work"] }] }));
		r.dialogs.selectAnswers.push(/^Allow once/);
		r.dialogs.confirmAnswers.push(true);
		await r.input();
		r.session.ctx.model = models[2];
		await r.input();
		assert.equal(r.dialogs.selects.length, 2);
		assert.match(r.dialogs.selects[1]!.title, /^BLOCKED {2}beta \(oauth\) is zone work/);
	});
});

describe("Allow for session", () => {
	it("passes the turn, logs it and shows the Override in the footer", async () => {
		const r = rig();
		r.dialogs.selectAnswers.push(/^Allow for session/);
		assert.deepEqual(await r.input(), { action: "continue" });
		assert.deepEqual(r.dialogs.confirms, [], "no second confirm");
		assert.equal(r.session.statuses.get("guard"), "guard OVERRIDE acme in personal");
		assert.equal(r.entries("guard.allow_session").length, 1);
		assert.equal(r.session.notices.length, 0, "no per-turn warning");
	});

	it("covers every later turn of that account, across agent_end", async () => {
		const r = rig();
		r.dialogs.selectAnswers.push(/^Allow for session/);
		await r.input();
		await r.host.fire("agent_end", { messages: [] }, r.session.ctx);
		assert.equal(await r.input(), undefined);
		assert.equal(r.dialogs.selects.length, 1);
	});

	it("Blocks a switch to another non-matching account", async () => {
		const r = rig(JSON.stringify({ accounts: [{ provider: "acme", source: "stored-key", zones: ["work"] }, { provider: "beta", source: "oauth", zones: ["work"] }] }));
		r.dialogs.selectAnswers.push(/^Allow for session/);
		await r.input();
		r.session.ctx.model = models[2];
		await r.input();
		assert.equal(r.dialogs.selects.length, 2);
	});

	it("is gone after a session change", async () => {
		const r = rig();
		r.dialogs.selectAnswers.push(/^Allow for session/);
		await r.input();
		for (const reason of ["new", "resume", "fork", "reload"]) {
			await r.host.fire("session_start", { reason }, r.session.ctx);
			assert.equal(r.session.statuses.get("guard"), "guard personal ✗ acme is work", reason);
			r.dialogs.selectAnswers.push(/^Allow for session/);
			await r.input();
			assert.equal(r.session.statuses.get("guard"), "guard OVERRIDE acme in personal", `${reason}: the Override was asked for again`);
		}
		assert.equal(r.dialogs.selects.length, 5);
	});

	it("is not written to disk", async () => {
		const r = rig();
		r.dialogs.selectAnswers.push(/^Allow for session/);
		await r.input();
		assert.equal(r.file.text, JSON.stringify(config));
	});
});

describe("undecidable Blocks", () => {
	it("name the cause, offer no Switch rows and keep the Overrides", async () => {
		const r = rig("{ not json");
		await r.input();
		const { title, options } = r.dialogs.selects[0]!;
		assert.match(title, /^BLOCKED {2}cannot read account-guard\.json\naccount-guard\.json: invalid JSON/);
		assert.deepEqual(options, ["Allow once: this turn to acme (stored-key)", "Allow for session: acme (stored-key)", "Cancel"]);
	});

	it("let the session Override through so a broken config never locks the user out", async () => {
		const r = rig("{ not json");
		r.dialogs.selectAnswers.push(/^Allow for session/);
		assert.deepEqual(await r.input(), { action: "continue" });
		assert.equal(await r.input(), undefined);
	});

	it("show the select for an untagged account", async () => {
		const r = rig(JSON.stringify({ accounts: [config.accounts[1]] }));
		await r.input();
		assert.match(r.dialogs.selects[0]!.title, /^BLOCKED {2}acme \(stored-key\) has no zone tag/);
	});
});
