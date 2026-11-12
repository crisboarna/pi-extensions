// The guard checks every member behind a virtual model when the router lists them on pi's event bus
// (`switchboard:members:v1`), and keeps checking the virtual model as its own account when nothing answers.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { registerGuard } from "../../src/pi/hooks.ts";
import { createFakeHost, createFakeSession } from "../support/fake-pi.ts";

const VIRTUAL = { provider: "switchboard", id: "auto" };
const MEMBERS = [
	{ provider: "acme", id: "mid" },
	{ provider: "acme-2", id: "mid" },
];
const stored = { status: { configured: true, source: "stored" } };
const virtualAuth = { status: { configured: true, source: "environment", label: "virtual" } };
const tag = (provider: string, source: string, zones: string[]) => ({ provider, source, zones });

function rig(accounts: unknown[], answer?: (request: { provider: string; id: string; respond(value: unknown): boolean }) => void) {
	const host = createFakeHost();
	const stderr: string[] = [];
	const exitCodes: number[] = [];
	if (answer) host.events.on("switchboard:members:v1", answer);
	registerGuard(host.pi as never, {
		home: "/home/me",
		configPath: "/home/me/.pi/agent/account-guard.json",
		readConfigText: () => JSON.stringify({ accounts }),
		realpath: (path) => path,
		readRemoteUrls: () => ({ ok: true, urls: [] }),
		writeStderr: (text) => void stderr.push(text),
		setExitCode: (code) => void exitCodes.push(code),
	});
	const s = createFakeSession({
		cwd: "/srv/app",
		model: VIRTUAL,
		models: MEMBERS,
		authByProvider: { switchboard: virtualAuth, acme: stored, "acme-2": stored },
	});
	const send = async () => {
		await host.fire("session_start", { reason: "startup" }, s.ctx);
		return host.fire("input", { text: "hello", source: "interactive" }, s.ctx);
	};
	return { host, s, stderr, exitCodes, send };
}

const members = (request: { provider: string; id: string; respond(value: unknown): boolean }) => {
	if (request.provider === VIRTUAL.provider && request.id === VIRTUAL.id) request.respond({ members: MEMBERS });
};

describe("a virtual model whose router lists its members", () => {
	it("lets the turn run when every member's account is in the place zone, though the virtual model is untagged", async () => {
		const r = rig([tag("acme", "stored-key", ["personal"]), tag("acme-2", "stored-key", ["personal"])], members);
		assert.equal(await r.send(), undefined);
		assert.deepEqual(r.stderr, []);
	});

	it("blocks when a failover member's account is in another zone, though the virtual model is tagged for this place", async () => {
		const r = rig(
			[tag("switchboard", "env:virtual", ["personal"]), tag("acme", "stored-key", ["personal"]), tag("acme-2", "stored-key", ["work"])],
			members,
		);
		assert.deepEqual(await r.send(), { action: "handled" });
		assert.match(r.stderr[0] ?? "", /^BLOCKED acme-2 \(stored-key\) is zone work/u);
		assert.deepEqual(r.exitCodes, [77]);
	});

	it("shows the members' decision in the footer, not the untagged virtual model's", async () => {
		for (const [zones, footer] of [
			[["personal"], "guard personal ✓"],
			[["work"], "guard personal ✗ acme-2 is work"],
		] as const) {
			const host = createFakeHost();
			host.events.on("switchboard:members:v1", members);
			registerGuard(host.pi as never, {
				home: "/home/me",
				configPath: "/home/me/.pi/agent/account-guard.json",
				readConfigText: () => JSON.stringify({ accounts: [tag("acme", "stored-key", ["personal"]), tag("acme-2", "stored-key", [...zones])] }),
				realpath: (path) => path,
				readRemoteUrls: () => ({ ok: true, urls: [] }),
				writeStderr: () => {},
				setExitCode: () => {},
			});
			const s = createFakeSession({
				cwd: "/srv/app",
				hasUI: true,
				model: VIRTUAL,
				models: MEMBERS,
				authByProvider: { switchboard: virtualAuth, acme: stored, "acme-2": stored },
			});
			await host.fire("session_start", { reason: "startup" }, s.ctx);
			assert.equal(s.statuses.get("guard"), footer);
		}
	});

	it("blocks when the router says it cannot list its members", async () => {
		const r = rig([tag("switchboard", "env:virtual", ["personal"])], (request) => request.respond({ error: "config is invalid" }));
		assert.deepEqual(await r.send(), { action: "handled" });
		assert.match(r.stderr.join(""), /switchboard could not list its members: config is invalid/u);
		assert.deepEqual(r.exitCodes, [77]);
	});

	it("blocks when the router answers with something that is not a member list", async () => {
		const r = rig([tag("switchboard", "env:virtual", ["personal"])], (request) => request.respond({ members: "acme/mid" }));
		assert.deepEqual(await r.send(), { action: "handled" });
		assert.deepEqual(r.exitCodes, [77]);
	});

	it("blocks when a member is a model pi does not list", async () => {
		const r = rig(
			[tag("switchboard", "env:virtual", ["personal"]), tag("acme", "stored-key", ["personal"]), tag("acme-2", "stored-key", ["personal"])],
			(request) => request.respond({ members: [...MEMBERS, { provider: "ghost", id: "x" }] }),
		);
		assert.deepEqual(await r.send(), { action: "handled" });
		assert.match(r.stderr.join(""), /ghost\/x/u);
	});

	it("ignores an answer that arrives after the check", async () => {
		let late: (() => void) | undefined;
		const r = rig([tag("switchboard", "env:virtual", ["personal"])], (request) => {
			late = () => request.respond({ members: [{ provider: "acme-2", id: "mid" }] });
		});
		assert.equal(await r.send(), undefined, "no answer during the check: the virtual model is checked as its own account");
		late?.();
		assert.deepEqual(r.stderr, []);
	});
});

describe("a virtual model with no router answering", () => {
	it("checks the virtual model as its own account, as before", async () => {
		const tagged = rig([tag("switchboard", "env:virtual", ["personal"]), tag("acme-2", "stored-key", ["work"])]);
		assert.equal(await tagged.send(), undefined);
		const untagged = rig([tag("acme", "stored-key", ["personal"])]);
		assert.deepEqual(await untagged.send(), { action: "handled" });
		assert.match(untagged.stderr[0] ?? "", /^BLOCKED switchboard \(env:virtual\) has no zone tag/u);
	});
});

describe("a physical model", () => {
	it("is checked alone, even when a router answers for its own virtual model", async () => {
		const host = createFakeHost();
		let asked = 0;
		host.events.on("switchboard:members:v1", () => void asked++);
		const stderr: string[] = [];
		registerGuard(host.pi as never, {
			home: "/home/me",
			configPath: "/home/me/.pi/agent/account-guard.json",
			readConfigText: () => JSON.stringify({ accounts: [tag("acme", "stored-key", ["personal"])] }),
			realpath: (path) => path,
			readRemoteUrls: () => ({ ok: true, urls: [] }),
			writeStderr: (text) => void stderr.push(text),
			setExitCode: () => {},
		});
		const s = createFakeSession({ cwd: "/srv/app", model: { provider: "acme", id: "mid" } });
		await host.fire("session_start", { reason: "startup" }, s.ctx);
		assert.equal(await host.fire("input", { text: "hello", source: "interactive" }, s.ctx), undefined);
		assert.ok(asked > 0, "the guard asks; only the router knows which models are its own");
		assert.deepEqual(stderr, []);
	});
});
