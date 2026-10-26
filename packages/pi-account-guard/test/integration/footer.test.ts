import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RemoteUrls } from "../../src/core/place.ts";
import { registerGuard } from "../../src/pi/hooks.ts";
import { attachDialogs, type FakeModel } from "../support/fake-dialogs.ts";
import { createFakeHost, createFakeSession } from "../support/fake-pi.ts";

const acmeMid: FakeModel = { provider: "acme", id: "mid" };
const betaSmall: FakeModel = { provider: "beta", id: "small", auth: { usingOAuth: true, status: { configured: true, source: "stored" } } };
const models = [acmeMid, betaSmall];

interface RigOptions {
	file?: string;
	hasUI?: boolean;
	remotes?: RemoteUrls;
}

/** A guard in `/srv/app`, a personal place unless the file says otherwise, with a session on `acme/mid` (stored-key). */
function rig({ file, hasUI = true, remotes = { ok: true, urls: [] } }: RigOptions = {}) {
	const host = createFakeHost();
	const session = createFakeSession({ cwd: "/srv/app", hasUI, model: acmeMid });
	const dialogs = attachDialogs(host, session, models);
	const files = { text: file as string | undefined };
	registerGuard(dialogs.pi as never, {
		home: "/home/me",
		configPath: "/home/me/.pi/agent/account-guard.json",
		readConfigText: () => files.text,
		realpath: (path) => path,
		readRemoteUrls: () => remotes,
		writeConfigText: (_path, text) => void (files.text = text),
		writeStderr: () => undefined,
		setExitCode: () => undefined,
	});
	const start = (reason = "startup") => host.fire("session_start", { reason }, session.ctx);
	const footer = () => session.statuses.get("guard");
	return { host, session, dialogs, files, start, footer };
}

const tag = (zones: string[], account = { provider: "acme", source: "stored-key" }) => JSON.stringify({ accounts: [{ ...account, zones }] });

describe("the guard footer", () => {
	it("shows a Match", async () => {
		const r = rig({ file: tag(["personal"]) });
		await r.start();
		assert.equal(r.footer(), "guard personal ✓");
	});

	it("shows a No Match with the account and its zones", async () => {
		const r = rig({ file: tag(["work"]) });
		await r.start();
		assert.equal(r.footer(), "guard personal ✗ acme is work");
	});

	it("shows an Unknown account as untagged", async () => {
		const r = rig();
		await r.start();
		assert.equal(r.footer(), "guard personal ? untagged");
	});

	it("shows the session Override as soon as it is chosen, and drops it on a new session", async () => {
		const r = rig({ file: tag(["work"]) });
		await r.start();
		r.dialogs.selectAnswers.push(/^Allow for session/);
		await r.host.fire("input", { text: "hi", source: "interactive" }, r.session.ctx);
		assert.equal(r.footer(), "guard OVERRIDE acme in personal");
		await r.start("new");
		assert.equal(r.footer(), "guard personal ✗ acme is work");
	});

	it("shows the config as invalid with the last valid copy in use, and recovers when the file is fixed", async () => {
		const r = rig({ file: tag(["personal"]) });
		await r.start();
		r.files.text = "{ nope";
		await r.host.fire("input", { text: "hi", source: "interactive" }, r.session.ctx);
		assert.equal(r.footer(), "guard ! config invalid (last valid copy in use)");
		r.files.text = tag(["personal"]);
		await r.host.fire("input", { text: "hi", source: "interactive" }, r.session.ctx);
		assert.equal(r.footer(), "guard personal ✓");
	});

	it("shows the config as invalid with turns blocked when no valid copy exists", async () => {
		const r = rig({ file: "{ nope" });
		await r.start();
		assert.equal(r.footer(), "guard ! config invalid, turns blocked");
	});

	it("shows an undecidable place", async () => {
		const r = rig({ file: JSON.stringify({ places: [{ remote: "*/Acme/*", zone: "work" }] }), remotes: { ok: false, reason: "git failed" } });
		await r.start();
		assert.equal(r.footer(), "guard ! zone unknown (git failed)");
	});

	it("follows a model change", async () => {
		const r = rig({ file: tag(["personal"]) });
		await r.start();
		r.session.ctx.model = betaSmall;
		await r.host.fire("model_select", { model: betaSmall, previousModel: acmeMid, source: "set" }, r.session.ctx);
		assert.equal(r.footer(), "guard personal ? untagged");
		r.session.ctx.model = acmeMid;
		await r.host.fire("model_select", { model: acmeMid, previousModel: betaSmall, source: "set" }, r.session.ctx);
		assert.equal(r.footer(), "guard personal ✓");
	});

	it("follows a config change made through /guard tag and /guard untag", async () => {
		const r = rig();
		await r.start();
		assert.equal(r.footer(), "guard personal ? untagged");
		await r.host.commands.get("guard")!.handler("tag acme stored-key personal", r.session.ctx);
		assert.equal(r.footer(), "guard personal ✓");
		await r.host.commands.get("guard")!.handler("untag", r.session.ctx);
		assert.equal(r.footer(), "guard personal ? untagged");
	});

	it("follows a tag made in the Tag prompt", async () => {
		const r = rig();
		await r.start();
		r.dialogs.selectAnswers.push(/^work$/, /^Cancel$/);
		(r.session.ctx as { mode: string }).mode = "rpc";
		await r.host.fire("input", { text: "hi", source: "interactive" }, r.session.ctx);
		assert.equal(r.footer(), "guard personal ✗ acme is work");
	});

	it("notices a hand edit at the next turn", async () => {
		const r = rig({ file: tag(["personal"]) });
		await r.start();
		r.files.text = tag(["work"]);
		r.dialogs.selectAnswers.push(/^Cancel$/);
		await r.host.fire("input", { text: "hi", source: "interactive" }, r.session.ctx);
		assert.equal(r.footer(), "guard personal ✗ acme is work");
	});

	it("shows only the zone when no model is selected", async () => {
		const r = rig();
		r.session.ctx.model = undefined;
		await r.start();
		assert.equal(r.footer(), "guard personal ? no model");
	});

	it("says it cannot decide when the check throws", async () => {
		const r = rig();
		r.session.ctx.modelRegistry.getProviderAuthStatus = () => {
			throw new Error("auth lookup failed");
		};
		await r.start();
		assert.equal(r.footer(), "guard ! check failed");
	});

	it("is not drawn without a UI", async () => {
		const r = rig({ hasUI: false });
		await r.start();
		assert.equal(r.session.statuses.size, 0);
	});
});
