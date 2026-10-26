import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FIRST_RUN_NOTICE } from "../../src/core/tour.ts";
import { registerGuard } from "../../src/pi/hooks.ts";
import { attachDialogs, type FakeModel } from "../support/fake-dialogs.ts";
import { createFakeHost, createFakeSession } from "../support/fake-pi.ts";

const CONFIG_PATH = "/home/me/.pi/agent/account-guard.json";
const MARKER_PATH = "/home/me/.pi/agent/account-guard.first-run";
const acmeMid: FakeModel = { provider: "acme", id: "mid" };

/** A guard over an in-memory agent folder; `files` maps a path to its text. */
function rig({ files = new Map<string, string>(), mode = "rpc" as "rpc" | "print" } = {}) {
	const host = createFakeHost();
	const session = createFakeSession({ cwd: "/home/me/garden", hasUI: mode !== "print", model: acmeMid });
	const dialogs = attachDialogs(host, session, [acmeMid]);
	const writes: string[] = [];
	registerGuard(dialogs.pi as never, {
		home: "/home/me",
		configPath: CONFIG_PATH,
		readConfigText: (path) => files.get(path),
		realpath: (path) => path,
		readRemoteUrls: () => ({ ok: true, urls: [] }),
		writeConfigText: (path, text) => {
			writes.push(path);
			files.set(path, text);
		},
		writeStderr: () => {},
		setExitCode: () => {},
		firstRun: {
			seen: () => files.has(MARKER_PATH),
			remember: () => {
				writes.push(MARKER_PATH);
				files.set(MARKER_PATH, "shown");
			},
		},
	});
	const start = () => host.fire("session_start", { reason: "startup" }, session.ctx);
	const shown = () => session.notices.filter((notice) => notice.message === FIRST_RUN_NOTICE).length;
	return { host, session, dialogs, files, writes, start, shown };
}

describe("the first-run notice", () => {
	it("shows once, and remembers that next to the config file", async () => {
		const files = new Map<string, string>();
		const first = rig({ files });
		await first.start();
		assert.equal(first.shown(), 1);
		assert.deepEqual(first.writes, [MARKER_PATH]);
		await first.start();
		const next = rig({ files });
		await next.start();
		assert.equal(first.shown() + next.shown(), 1);
	});

	it("stays quiet when a config file already exists, and without a UI", async () => {
		const configured = rig({ files: new Map([[CONFIG_PATH, "{}"]]) });
		await configured.start();
		assert.deepEqual([configured.shown(), configured.writes], [0, []]);
		const headless = rig({ mode: "print" });
		await headless.start();
		assert.deepEqual([headless.shown(), headless.writes], [0, []]);
	});
});

describe("/guard tour", () => {
	it("opens the steps and writes nothing", async () => {
		const r = rig({ files: new Map([[CONFIG_PATH, "{}"]]) });
		await r.start();
		r.dialogs.selectAnswers.push(/^Next/, /^Close$/);
		await r.host.commands.get("guard")!.handler("tour", r.session.ctx);
		assert.equal(r.dialogs.selects.length, 2);
		assert.match(r.dialogs.selects[1]!.title, /^pi-account-guard tour 2\/4: How a turn is checked/);
		assert.deepEqual(r.writes, []);
	});
});

describe("the first-run notice when the agent folder cannot be read", () => {
	it("skips the notice instead of failing the session", async () => {
		const host = createFakeHost();
		const session = createFakeSession({ cwd: "/home/me/garden", hasUI: true, model: acmeMid });
		const dialogs = attachDialogs(host, session, [acmeMid]);
		registerGuard(dialogs.pi as never, {
			home: "/home/me",
			configPath: CONFIG_PATH,
			readConfigText: () => undefined,
			realpath: (path) => path,
			readRemoteUrls: () => ({ ok: true, urls: [] }),
			writeStderr: () => {},
			setExitCode: () => {},
			firstRun: {
				seen: () => false,
				remember: () => {
					throw new Error("read-only file system");
				},
			},
		});
		await host.fire("session_start", { reason: "startup" }, session.ctx);
		assert.equal(session.notices.filter((notice) => notice.message === FIRST_RUN_NOTICE).length, 0);
	});
});
