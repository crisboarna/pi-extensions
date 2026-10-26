import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { registerGuard } from "../../src/pi/hooks.ts";
import { attachDialogs, type FakeModel } from "../support/fake-dialogs.ts";
import { createFakeHost, createFakeSession } from "../support/fake-pi.ts";
import { attachTagDialogs, KEY } from "../support/tag-dialogs.ts";

const CONFIG_PATH = "/home/me/.pi/agent/account-guard.json";

const acmeMid: FakeModel = { provider: "acme", id: "mid" };
const betaSmall: FakeModel = { provider: "beta", id: "small", auth: { usingOAuth: true, status: { configured: true, source: "stored" } } };
const gammaEnv: FakeModel = { provider: "gamma", id: "g1", auth: { status: { configured: true, source: "environment", label: "GAMMA_KEY" } } };
const models = [acmeMid, betaSmall, gammaEnv];

interface RigOptions {
	/** The file text; `undefined` is a missing file. */
	file?: string;
	mode?: "tui" | "rpc" | "print";
	/** The current model; `null` for none. */
	model?: FakeModel | null;
	models?: FakeModel[];
	pooled?: string[];
}

/** A guard in a personal place (the default zone) and a session on `acme/mid`, which is a stored key (`acme (stored-key)`). */
function rig({ file, mode = "rpc", model = acmeMid, models: available = models, pooled }: RigOptions = {}) {
	const host = createFakeHost();
	const hasUI = mode !== "print";
	const session = createFakeSession({ cwd: "/srv/app", hasUI, model });
	const dialogs = attachDialogs(host, session, available);
	const tagDialogs = attachTagDialogs(session, mode);
	const files = { text: file as string | undefined, writes: [] as string[] };
	const stderr: string[] = [];
	const exitCodes: number[] = [];
	registerGuard(dialogs.pi as never, {
		home: "/home/me",
		configPath: CONFIG_PATH,
		readConfigText: () => files.text,
		realpath: (path) => path,
		readRemoteUrls: () => ({ ok: true, urls: [] }),
		writeConfigText: (path, text) => {
			assert.equal(path, CONFIG_PATH);
			files.writes.push(text);
			files.text = text;
		},
		writeStderr: (text) => void stderr.push(text),
		setExitCode: (code) => void exitCodes.push(code),
		...(pooled ? { pooledProviders: () => pooled } : {}),
	});
	const guard = (args = "") => host.commands.get("guard")!.handler(args, session.ctx);
	const notices = () => session.notices.map((notice) => notice.message);
	return { host, session, dialogs, tagDialogs, files, stderr, exitCodes, guard, notices };
}

const accounts = (files: { text: string | undefined }) => JSON.parse(files.text ?? "null").accounts;

describe("/guard status", () => {
	const file = JSON.stringify({
		accounts: [
			{ provider: "acme", source: "stored-key", zones: ["work"] },
			{ provider: "old", source: "oauth", zones: ["personal"] },
		],
		places: [
			{ remote: "*/Acme/*", zone: "work" },
			{ path: "/srv/**", zone: "personal" },
		],
	});
	const expected = [
		"guard status",
		" Place     /srv/app -> personal (rule 2: /srv/**)",
		" Account   acme (stored-key) -> work  ✗ no Match",
		" Overrides session: none; allow-once: none",
		" Config    ~/.pi/agent/account-guard.json (valid)",
		" Zones     work, personal (default: personal)",
		" Pooled    pi-multiprovider: openai-pool (warns only)",
		" Untagged  beta (oauth), gamma (env:GAMMA_KEY)",
		" Missing   old (oauth) [personal]",
		"",
		"(edit: /guard tag | place | zone ...)",
	].join("\n");

	it("prints the documented block through notify, identically in the TUI and over RPC", async () => {
		const texts: string[] = [];
		for (const mode of ["tui", "rpc"] as const) {
			const r = rig({ file, mode, pooled: ["openai-pool"] });
			await r.guard();
			assert.deepEqual(r.session.notices, [{ message: expected, type: "info" }]);
			texts.push(r.session.notices[0]!.message);
		}
		assert.equal(texts[0], texts[1]);
	});

	it("omits the Missing row when every tag belongs to a configured account", async () => {
		const r = rig({ file: JSON.stringify({ accounts: [{ provider: "acme", source: "stored-key", zones: ["work"] }] }) });
		await r.guard();
		assert.doesNotMatch(r.notices()[0]!, /Missing/);
	});

	it("lists no pooled provider by default, and says none", async () => {
		const r = rig({ file });
		await r.guard();
		assert.match(r.notices()[0]!, /^ Pooled {4}none$/m);
	});

	it("prints nothing without a UI", async () => {
		const r = rig({ file, mode: "print" });
		await r.guard();
		assert.deepEqual(r.session.notices, []);
		assert.deepEqual(r.stderr, []);
		assert.deepEqual(r.exitCodes, []);
	});

	it("shows the session Override and the allow-once account", async () => {
		const r = rig({ file });
		r.dialogs.selectAnswers.push(/^Allow for session/);
		await r.host.fire("input", { text: "hi", source: "interactive" }, r.session.ctx);
		await r.guard();
		assert.match(r.notices().at(-1)!, /^ Overrides session: acme \(stored-key\) in personal; allow-once: none$/m);
	});

	it("shows a malformed file with the last valid copy in use", async () => {
		const r = rig({ file });
		await r.host.fire("session_start", { reason: "startup" }, r.session.ctx);
		r.files.text = "{ nope";
		await r.guard();
		assert.match(
			r.notices().at(-1)!,
			/^ Config {4}~\/\.pi\/agent\/account-guard\.json \(invalid, last valid copy in use\)\n {11}account-guard\.json: invalid JSON/m,
		);
	});

	it("is the same with no file: defaults, every configured account untagged", async () => {
		const r = rig();
		await r.guard();
		const text = r.notices()[0]!;
		assert.match(text, /^ Place {5}\/srv\/app -> personal \(default zone\)$/m);
		assert.match(text, /^ Untagged {2}acme \(stored-key\), beta \(oauth\), gamma \(env:GAMMA_KEY\)$/m);
		assert.match(text, /^ Account {3}acme \(stored-key\) -> unknown {2}\? Unknown \(no zone tag\)$/m);
	});
});

describe("/guard tag", () => {
	it("tags the given account in full arguments, with no dialog, and creates the file", async () => {
		const r = rig();
		await r.guard("tag beta oauth work,personal");
		assert.deepEqual(accounts(r.files), [{ provider: "beta", source: "oauth", zones: ["work", "personal"] }]);
		assert.deepEqual(r.session.notices, [{ message: "Tagged beta (oauth) as work, personal.", type: "info" }]);
		assert.equal(r.dialogs.selects.length + r.dialogs.confirms.length, 0);
	});

	it("takes the current source of a provider when no source is given", async () => {
		const r = rig();
		await r.guard("tag gamma work");
		assert.deepEqual(accounts(r.files), [{ provider: "gamma", source: "env:GAMMA_KEY", zones: ["work"] }]);
	});

	it("defaults to the current Account and asks for the zones with a select over RPC", async () => {
		const r = rig({ mode: "rpc" });
		r.dialogs.selectAnswers.push(/^work$/);
		await r.guard("tag");
		assert.equal(r.dialogs.selects[0]!.title, "Which zones does acme · saved API key belong to?");
		assert.deepEqual(r.dialogs.selects[0]!.options, ["work", "personal", "Several zones…"]);
		assert.deepEqual(accounts(r.files), [{ provider: "acme", source: "stored-key", zones: ["work"] }]);
	});

	it("asks for the zones with a checklist in the TUI", async () => {
		const r = rig({ mode: "tui" });
		r.tagDialogs.customKeys.push([KEY.down, KEY.space, KEY.enter]);
		await r.guard("tag");
		assert.deepEqual(accounts(r.files), [{ provider: "acme", source: "stored-key", zones: ["personal"] }]);
	});

	it("leaves the file alone when the zone dialog is cancelled", async () => {
		const r = rig();
		await r.guard("tag");
		assert.deepEqual(r.files.writes, []);
		assert.deepEqual(r.session.notices, []);
	});

	it("rejects a zone that is not declared, naming the usage, and writes nothing", async () => {
		const r = rig();
		await r.guard("tag acme stored-key lab");
		assert.deepEqual(r.files.writes, []);
		assert.deepEqual(r.session.notices, [
			{
				message:
					"guard: did not tag acme (stored-key). Not a declared zone: lab. Declared zones: work, personal.\nUsage: /guard tag [provider [source] [zones]]",
				type: "error",
			},
		]);
	});

	it("shows old to new and asks to confirm when it changes the zones of a tagged account", async () => {
		const r = rig({ file: JSON.stringify({ accounts: [{ provider: "acme", source: "stored-key", zones: ["work"], note: "seat" }] }) });
		r.dialogs.confirmAnswers.push(true);
		await r.guard("tag acme stored-key work,personal");
		assert.deepEqual(r.dialogs.confirms, [{ title: "Change the zones of acme (stored-key)?", message: "work -> work, personal" }]);
		assert.deepEqual(accounts(r.files), [{ provider: "acme", source: "stored-key", zones: ["work", "personal"], note: "seat" }]);
	});

	it("writes nothing when the change is declined", async () => {
		const r = rig({ file: JSON.stringify({ accounts: [{ provider: "acme", source: "stored-key", zones: ["work"] }] }) });
		r.dialogs.confirmAnswers.push(false);
		await r.guard("tag acme stored-key personal");
		assert.deepEqual(r.files.writes, []);
	});

	it("asks no confirm when the zones are already the tag", async () => {
		const r = rig({ file: JSON.stringify({ accounts: [{ provider: "acme", source: "stored-key", zones: ["work", "personal"] }] }) });
		await r.guard("tag acme stored-key personal,work");
		assert.equal(r.dialogs.confirms.length, 0);
		assert.deepEqual(r.files.writes, []);
		assert.deepEqual(r.notices(), ["acme (stored-key) is already tagged as personal, work."]);
	});

	it("refuses and names the errors when the file is malformed", async () => {
		const r = rig({ file: "{ nope" });
		await r.guard("tag acme stored-key work");
		assert.deepEqual(r.files.writes, []);
		assert.equal(r.files.text, "{ nope");
		assert.match(
			r.notices()[0]!,
			/^guard: did not tag\. The file is malformed, and the guard never writes over a malformed file\.\naccount-guard\.json: invalid JSON/,
		);
		assert.equal(r.session.notices[0]!.type, "error");
	});

	it("is read live, so the next turn matches at once", async () => {
		const r = rig();
		await r.guard("tag acme stored-key personal");
		assert.equal(await r.host.fire("input", { text: "hi", source: "interactive" }, r.session.ctx), undefined);
		assert.equal(r.dialogs.selects.length, 0);
	});

	describe("pickers", () => {
		const file = JSON.stringify({
			accounts: [
				{ provider: "beta", source: "oauth", zones: ["work"] },
				{ provider: "old", source: "stored-key", zones: ["personal"] },
			],
		});

		it("list the configured providers at their current source and every file entry, marking the unconfigured", async () => {
			const r = rig({ file, model: null });
			await r.guard("tag");
			assert.equal(r.dialogs.selects[0]!.title, "Which account?");
			assert.deepEqual(r.dialogs.selects[0]!.options, [
				"acme (stored-key)  [untagged]",
				"beta (oauth)  [work]",
				"gamma (env:GAMMA_KEY)  [untagged]",
				"old (stored-key)  [personal]  (not configured now)",
			]);
			assert.deepEqual(r.files.writes, [], "a cancelled picker writes nothing");
		});

		it("tag the picked account", async () => {
			const r = rig({ file, model: null });
			r.dialogs.selectAnswers.push(/^gamma/, /^personal$/);
			await r.guard("tag");
			assert.deepEqual(accounts(r.files).at(-1), { provider: "gamma", source: "env:GAMMA_KEY", zones: ["personal"] });
		});

		it("ask for the source when a provider has several file entries and none is configured now", async () => {
			const r = rig({
				file: JSON.stringify({
					accounts: [
						{ provider: "delta", source: "oauth", zones: ["work"] },
						{ provider: "delta", source: "stored-key", zones: ["personal"] },
					],
				}),
			});
			r.dialogs.selectAnswers.push(/^delta \(oauth\)/);
			r.dialogs.confirmAnswers.push(false);
			await r.guard("tag delta personal");
			assert.deepEqual(r.dialogs.selects[0]!.options, [
				"delta (oauth)  [work]  (not configured now)",
				"delta (stored-key)  [personal]  (not configured now)",
			]);
			assert.equal(r.dialogs.confirms[0]!.message, "work -> personal");
		});

		it("use the configured source of a provider whose file entry has another source", async () => {
			const r = rig({ file: JSON.stringify({ accounts: [{ provider: "gamma", source: "oauth", zones: ["work"] }] }) });
			await r.guard("tag gamma personal");
			assert.deepEqual(accounts(r.files).at(-1), { provider: "gamma", source: "env:GAMMA_KEY", zones: ["personal"] });
		});
	});

	describe("without a UI", () => {
		it("fails with the usage when no account is named and no model is selected", async () => {
			const r = rig({ mode: "print", model: null });
			await r.guard("tag");
			assert.deepEqual(r.stderr, ["guard: no model is selected and no account was named.\nUsage: /guard tag [provider [source] [zones]]\n"]);
			assert.deepEqual(r.exitCodes, [2]);
		});

		it("fails with the usage when the zones are missing", async () => {
			const r = rig({ mode: "print" });
			await r.guard("tag");
			assert.deepEqual(r.stderr, ["guard: name the zones of acme (stored-key).\nUsage: /guard tag [provider [source] [zones]]\n"]);
			assert.deepEqual(r.exitCodes, [2]);
			assert.deepEqual(r.files.writes, []);
		});

		it("fails with the usage when a provider has several sources", async () => {
			const r = rig({
				mode: "print",
				file: JSON.stringify({
					accounts: [
						{ provider: "delta", source: "oauth", zones: ["work"] },
						{ provider: "delta", source: "stored-key", zones: ["work"] },
					],
				}),
			});
			await r.guard("tag delta work");
			assert.match(r.stderr[0]!, /^guard: name the source, one of: oauth, stored-key\.\nUsage: \/guard tag/);
			assert.deepEqual(r.exitCodes, [2]);
		});

		it("tags silently with full arguments", async () => {
			const r = rig({ mode: "print" });
			await r.guard("tag acme stored-key work");
			assert.deepEqual(accounts(r.files), [{ provider: "acme", source: "stored-key", zones: ["work"] }]);
			assert.deepEqual([r.stderr, r.exitCodes, r.session.notices], [[], [], []]);
		});

		it("cannot confirm a change, so it fails and writes nothing", async () => {
			const r = rig({ mode: "print", file: JSON.stringify({ accounts: [{ provider: "acme", source: "stored-key", zones: ["work"] }] }) });
			await r.guard("tag acme stored-key personal");
			assert.match(r.stderr[0]!, /^guard: acme \(stored-key\) is tagged work; changing it needs a confirm/);
			assert.deepEqual(r.exitCodes, [2]);
			assert.deepEqual(r.files.writes, []);
		});
	});
});

describe("/guard untag", () => {
	const file = JSON.stringify({
		accounts: [
			{ provider: "acme", source: "stored-key", zones: ["work"], note: "n" },
			{ provider: "beta", source: "oauth", zones: ["personal"] },
		],
	});

	it("removes the current Account's tag with no confirm", async () => {
		const r = rig({ file });
		await r.guard("untag");
		assert.deepEqual(accounts(r.files), [{ provider: "beta", source: "oauth", zones: ["personal"] }]);
		assert.deepEqual(r.session.notices, [{ message: "Untagged acme (stored-key) (was work).", type: "info" }]);
		assert.equal(r.dialogs.confirms.length, 0);
	});

	it("removes the named account", async () => {
		const r = rig({ file });
		await r.guard("untag beta oauth");
		assert.deepEqual(
			accounts(r.files).map((account: { provider: string }) => account.provider),
			["acme"],
		);
	});

	it("makes the account Unknown, which Blocks with the tag prompt", async () => {
		const r = rig({ file: JSON.stringify({ accounts: [{ provider: "acme", source: "stored-key", zones: ["personal"] }] }) });
		await r.guard("untag");
		r.dialogs.selectAnswers.push(undefined, /^Cancel$/);
		await r.host.fire("input", { text: "hi", source: "interactive" }, r.session.ctx);
		assert.match(r.dialogs.selects[0]!.title, /^This place is personal\. Which zones does acme/);
	});

	it("says so when the account has no tag, and writes nothing", async () => {
		const r = rig({ file });
		await r.guard("untag gamma");
		assert.deepEqual(r.notices(), ["gamma (env:GAMMA_KEY) has no zone tag."]);
		assert.deepEqual(r.files.writes, []);
	});

	it("picks among the tagged accounts when no model is selected", async () => {
		const r = rig({ file, model: null });
		r.dialogs.selectAnswers.push(/^beta/);
		await r.guard("untag");
		assert.deepEqual(r.dialogs.selects[0]!.options, ["acme (stored-key)  [work]", "beta (oauth)  [personal]"]);
		assert.deepEqual(
			accounts(r.files).map((account: { provider: string }) => account.provider),
			["acme"],
		);
	});

	it("refuses extra words with the usage", async () => {
		const r = rig({ file });
		await r.guard("untag acme stored-key work");
		assert.deepEqual(r.session.notices, [{ message: "guard: too many arguments.\nUsage: /guard untag [provider [source]]", type: "error" }]);
		assert.deepEqual(r.files.writes, []);
	});

	it("fails with the usage and no UI when no model is selected", async () => {
		const r = rig({ file, mode: "print", model: null });
		await r.guard("untag");
		assert.match(r.stderr[0]!, /^guard: no model is selected and no account was named\.\nUsage: \/guard untag/);
		assert.deepEqual(r.exitCodes, [2]);
	});

	it("untags silently with no UI", async () => {
		const r = rig({ file, mode: "print" });
		await r.guard("untag");
		assert.deepEqual(
			accounts(r.files).map((account: { provider: string }) => account.provider),
			["beta"],
		);
		assert.deepEqual([r.stderr, r.exitCodes], [[], []]);
	});
});

describe("/guard", () => {
	it("fails with the usage on an unknown command", async () => {
		const r = rig();
		await r.guard("frobnicate");
		const usage = [
			"Usage:",
			"  /guard",
			"  /guard check <path|here> [provider [source]]",
			"  /guard tag [provider [source] [zones]]",
			"  /guard untag [provider [source]]",
			"  /guard place add [path=<path|here>] [remote=<glob>] [zone=<zone>] [at=<n>]",
			"  /guard place list",
			"  /guard place remove [<n>]",
			"  /guard place move [<n> <to>]",
			"  /guard zone add [<name>]",
			"  /guard zone remove [<zone>]",
			"  /guard zone rename [<old> <new>]",
			"  /guard zone default [<zone>]",
		].join("\n");
		assert.deepEqual(r.session.notices, [{ message: `guard: unknown command "frobnicate".\n${usage}`, type: "error" }]);
	});
});
