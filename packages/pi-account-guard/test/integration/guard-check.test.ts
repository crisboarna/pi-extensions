import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RemoteUrls } from "../../src/core/place.ts";
import { registerGuard } from "../../src/pi/hooks.ts";
import { attachDialogs, type FakeModel } from "../support/fake-dialogs.ts";
import { createFakeHost, createFakeSession } from "../support/fake-pi.ts";

const acmeMid: FakeModel = { provider: "acme", id: "mid" };
const DIRECTORIES = new Set(["/home/me/garden", "/home/me/work/api"]);
const REMOTES: Record<string, RemoteUrls> = {
	"/home/me/work/api": { ok: true, urls: ["git@github.com:acme-corp/api.git"] },
	"/home/me/garden": { ok: true, urls: [] },
};
const FILE = {
	accounts: [{ provider: "acme", source: "stored-key", zones: ["work"] }],
	places: [{ remote: "*/acme-corp/*", zone: "work" }],
};

/** A guard in `/home/me/garden` on `acme/mid` (a stored key, tagged work), with a work repository at `~/work/api`. */
function rig({ file = FILE as object | string, mode = "rpc" as "rpc" | "print" } = {}) {
	const host = createFakeHost();
	const session = createFakeSession({ cwd: "/home/me/garden", hasUI: mode !== "print", model: acmeMid });
	const dialogs = attachDialogs(host, session, [acmeMid]);
	const files = { text: typeof file === "object" ? JSON.stringify(file) : file, writes: [] as string[] };
	const stderr: string[] = [];
	const exitCodes: number[] = [];
	registerGuard(dialogs.pi as never, {
		home: "/home/me",
		configPath: "/home/me/.pi/agent/account-guard.json",
		readConfigText: () => files.text,
		realpath: (path) => (DIRECTORIES.has(path) ? path : undefined),
		readRemoteUrls: (cwd) => REMOTES[cwd] ?? { ok: false, reason: `not a repository: ${cwd}` },
		writeConfigText: (_path, text) => void files.writes.push(text),
		writeStderr: (text) => void stderr.push(text),
		setExitCode: (code) => void exitCodes.push(code),
	});
	const guard = (args: string) => host.commands.get("guard")!.handler(args, session.ctx);
	const last = () => session.notices.at(-1);
	return { session, files, stderr, exitCodes, guard, last };
}

describe("/guard check", () => {
	it("names the rule that decides another directory and says the current account would pass there", async () => {
		const r = rig();
		await r.guard("check ~/work/api");
		assert.equal(r.last()?.type, "info");
		assert.match(r.last()!.message, /^guard check \(nothing is written\)$/m);
		assert.match(r.last()!.message, /^ Place {5}~\/work\/api -> work \(rule 1: remote \*\/acme-corp\/\*\)$/m);
		assert.match(r.last()!.message, /^ Verdict {3}a turn here would go$/m);
		assert.deepEqual(r.files.writes, []);
	});

	it("checks here against the default zone, and a named account that has no tag", async () => {
		const r = rig();
		await r.guard("check here");
		assert.match(r.last()!.message, /Verdict {3}a turn here would be blocked: acme \(stored-key\) is zone work, this place is personal/);
		await r.guard("check here acme oauth");
		assert.match(r.last()!.message, /Account {3}acme \(oauth\) -> unknown[\s\S]*Verdict {3}the tag prompt would ask for the zones of acme \(oauth\) first/);
		assert.deepEqual(r.files.writes, []);
	});

	it("fails with the usage without a path, and names a directory that does not exist", async () => {
		const r = rig();
		await r.guard("check");
		assert.equal(r.last()?.type, "error");
		assert.match(r.last()!.message, /Usage: \/guard check <path\|here> \[provider \[source\]\]/);
		await r.guard("check ~/nowhere");
		assert.match(r.last()!.message, /guard: \/home\/me\/nowhere does not exist/);
	});

	it("refuses while the config is malformed, naming the errors", async () => {
		const r = rig({ file: "{ not json" });
		await r.guard("check ~/work/api");
		assert.equal(r.last()?.type, "error");
		assert.match(r.last()!.message, /guard: cannot check while account-guard\.json is invalid/);
	});

	it("prints nothing without a UI, like the status", async () => {
		const r = rig({ mode: "print" });
		await r.guard("check ~/work/api");
		assert.deepEqual([r.stderr, r.exitCodes], [[], []]);
	});
});
