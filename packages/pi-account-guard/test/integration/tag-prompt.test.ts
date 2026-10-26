import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { registerGuard } from "../../src/pi/hooks.ts";
import { attachDialogs, type FakeModel } from "../support/fake-dialogs.ts";
import { createFakeHost, createFakeSession } from "../support/fake-pi.ts";
import { attachTagDialogs, KEY } from "../support/tag-dialogs.ts";

const CONFIG_PATH = "/home/me/.pi/agent/account-guard.json";

const acmeMid: FakeModel = { provider: "acme", id: "mid" };
const models: FakeModel[] = [
	acmeMid,
	{ provider: "beta", id: "small", auth: { usingOAuth: true, status: { configured: true, source: "stored" } } },
];

interface RigOptions {
	/** The file text; `undefined` is a missing file. */
	file?: string;
	mode?: "tui" | "rpc";
	multiPassLabels?: Record<string, string>;
}

/** A guard in a personal place (the default zone) and a session on `acme/mid`, an Unknown account unless the file tags it. */
function rig({ file, mode = "rpc", multiPassLabels = {} }: RigOptions = {}) {
	const host = createFakeHost();
	const session = createFakeSession({ cwd: "/srv/app", hasUI: true, model: acmeMid });
	const dialogs = attachDialogs(host, session, models);
	const tag = attachTagDialogs(session, mode);
	const files = { text: file as string | undefined, writes: [] as string[] };
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
		multiPassLabel: (provider) => multiPassLabels[provider],
		writeStderr: () => undefined,
		setExitCode: () => undefined,
	});
	const input = (text = "my prompt") => host.fire("input", { text, source: "interactive" }, session.ctx);
	const entries = (type: string) => host.entries.filter((entry) => entry.customType === type);
	return { host, session, dialogs, tag, files, input, entries };
}

const written = (files: { text: string | undefined }) => JSON.parse(files.text ?? "null");

describe("tag prompt over RPC", () => {
	it("opens before the Block select with the place zone, the account in words, a select of single zones and a Several zones entry", async () => {
		const r = rig();
		await r.input();
		assert.deepEqual(r.dialogs.selects[0], {
			title: "This place is personal. Which zones does acme · saved API key belong to?",
			options: ["work", "personal", "Several zones…"],
		});
	});

	it("creates the file with the defaults spelled out, 2-space indented, and proceeds on a Match without a resubmit", async () => {
		const r = rig();
		r.dialogs.selectAnswers.push(/^personal$/);
		assert.equal(await r.input(), undefined, "the handler lets the turn through");
		assert.equal(r.dialogs.selects.length, 1, "no Block select");
		assert.equal(
			r.files.text,
			JSON.stringify({ zones: ["work", "personal"], defaultZone: "personal", accounts: [{ provider: "acme", source: "stored-key", zones: ["personal"] }], places: [] }, null, 2) + "\n",
		);
		assert.deepEqual(r.session.notices, [{ message: "Tagged acme (stored-key) as personal.", type: "info" }]);
		assert.deepEqual(r.session.editorTexts, []);
		assert.equal(r.entries("guard.block").length, 0);
	});

	it("keeps the other entries of an existing file, and the next turn matches without a prompt", async () => {
		const r = rig({ file: '{"zones":["work","personal"],"accounts":[{"provider":"beta","source":"oauth","zones":["personal"],"note":"n"}],"places":[{"path":"/x","zone":"work"}]}' });
		r.dialogs.selectAnswers.push(/^personal$/);
		await r.input();
		assert.deepEqual(written(r.files), {
			zones: ["work", "personal"],
			defaultZone: "personal",
			accounts: [{ provider: "beta", source: "oauth", zones: ["personal"], note: "n" }, { provider: "acme", source: "stored-key", zones: ["personal"] }],
			places: [{ path: "/x", zone: "work" }],
		});
		assert.equal(await r.input(), undefined);
		assert.equal(r.dialogs.selects.length, 1);
	});

	it("falls to the normal Block when the tag does not Match, with the new tag in the title", async () => {
		const r = rig();
		r.dialogs.selectAnswers.push(/^work$/, /^Cancel$/);
		assert.deepEqual(await r.input("typed"), { action: "handled" });
		assert.equal(r.dialogs.selects[1]!.title, "BLOCKED  acme (stored-key) is zone work\nPlace /srv/app -> zone personal");
		assert.deepEqual(written(r.files).accounts, [{ provider: "acme", source: "stored-key", zones: ["work"] }]);
		assert.deepEqual(r.session.editorTexts, ["typed"]);
		assert.equal(r.entries("guard.block").length, 1);
	});

	it("falls to the normal Block on Cancel and writes nothing", async () => {
		const r = rig();
		r.dialogs.selectAnswers.push(undefined, /^Cancel$/);
		assert.deepEqual(await r.input(), { action: "handled" });
		assert.match(r.dialogs.selects[1]!.title, /^BLOCKED {2}acme \(stored-key\) has no zone tag/);
		assert.deepEqual(r.files.writes, []);
	});

	it("takes several zones from an input, asks again on a bad name and on no zones, then proceeds", async () => {
		const r = rig();
		r.dialogs.selectAnswers.push(/^Several zones/);
		r.tag.inputAnswers.push("wrk", "  ", "work, personal");
		assert.equal(await r.input(), undefined);
		assert.equal(r.tag.inputs.length, 3);
		assert.match(r.tag.inputs[1]!.title, /^Not a declared zone: wrk\. Declared zones: work, personal\.\nThis place is personal\./);
		assert.match(r.tag.inputs[2]!.title, /^Name at least one zone\.\nThis place is personal\./);
		assert.deepEqual(written(r.files).accounts, [{ provider: "acme", source: "stored-key", zones: ["work", "personal"] }]);
		assert.equal(r.session.notices[0]!.message, "Tagged acme (stored-key) as work, personal.");
	});

	it("falls to the normal Block when the input is closed", async () => {
		const r = rig();
		r.dialogs.selectAnswers.push(/^Several zones/, undefined);
		r.tag.inputAnswers.push(undefined);
		await r.input();
		assert.deepEqual(r.files.writes, []);
		assert.match(r.dialogs.selects[1]!.title, /has no zone tag/);
	});

	it("is not shown while the config is malformed, even with a last valid copy", async () => {
		const r = rig({ file: '{"accounts":[]}' });
		await r.host.fire("session_start", { reason: "startup" }, r.session.ctx);
		r.files.text = "{ nope";
		await r.input();
		assert.equal(r.dialogs.selects.length, 1);
		assert.match(r.dialogs.selects[0]!.title, /^BLOCKED {2}acme \(stored-key\) has no zone tag/);
		assert.deepEqual(r.files.writes, []);
		assert.equal(r.files.text, "{ nope");
	});

	it("does not tag an account that already has a tag", async () => {
		const r = rig({ file: JSON.stringify({ accounts: [{ provider: "acme", source: "stored-key", zones: ["work"] }] }) });
		r.dialogs.selectAnswers.push(/^Cancel$/);
		await r.input();
		assert.equal(r.dialogs.selects.length, 1);
		assert.match(r.dialogs.selects[0]!.title, /is zone work/);
	});

	it("reports a refused write and falls to the normal Block", async () => {
		const r = rig();
		r.dialogs.selectAnswers.push(/^personal$/, /^Cancel$/);
		// The file turns malformed between the check and the write.
		const select = r.session.ctx.ui.select;
		r.session.ctx.ui.select = async (title: string, options: string[]) => {
			const answer = await select(title, options);
			if (title.startsWith("This place is")) r.files.text = "{ nope";
			return answer;
		};
		await r.input();
		assert.deepEqual(r.files.writes, []);
		assert.equal(r.files.text, "{ nope");
		const error = r.session.notices.find((notice) => notice.type === "error");
		assert.match(error?.message ?? "", /^guard: did not tag acme \(stored-key\)\.\naccount-guard\.json: invalid JSON/);
		assert.match(r.dialogs.selects[1]!.title, /^BLOCKED {2}acme \(stored-key\) has no zone tag/, "the last valid copy still decides");
	});
});

describe("bypass nudge", () => {
	const labelled = { acme: "Work seat" };

	it("asks one extra confirm when the label names a zone the chosen zones leave out; yes writes the tag", async () => {
		const r = rig({ multiPassLabels: labelled });
		r.dialogs.selectAnswers.push(/^personal$/);
		r.dialogs.confirmAnswers.push(true);
		assert.equal(await r.input(), undefined);
		assert.equal(r.dialogs.confirms.length, 1);
		assert.match(r.dialogs.selects[0]!.title, /Which zones does acme · saved API key \(multi-pass: Work seat\) belong to\?$/);
		assert.match(r.dialogs.confirms[0]!.message, /"Work seat", which names zone work, but you chose personal/);
		assert.deepEqual(written(r.files).accounts, [{ provider: "acme", source: "stored-key", zones: ["personal"] }]);
	});

	it("asks the zones again when the confirm is declined, and writes nothing until a tag is confirmed", async () => {
		const r = rig({ multiPassLabels: labelled });
		r.dialogs.selectAnswers.push(/^personal$/, /^work$/);
		r.dialogs.confirmAnswers.push(false);
		await r.input();
		assert.equal(r.dialogs.selects.length, 3, "two asks of the zones, then the Block select");
		assert.equal(r.dialogs.confirms.length, 1, "naming work needs no confirm");
		assert.deepEqual(written(r.files).accounts, [{ provider: "acme", source: "stored-key", zones: ["work"] }]);
	});

	it("asks no confirm when the chosen zones include the zone the label names", async () => {
		const r = rig({ multiPassLabels: labelled });
		r.dialogs.selectAnswers.push(/^Several zones/);
		r.tag.inputAnswers.push("work, personal");
		await r.input();
		assert.equal(r.dialogs.confirms.length, 0);
	});

	it("asks no confirm for a label that only contains the zone inside a longer word", async () => {
		const r = rig({ multiPassLabels: { acme: "Network" } });
		r.dialogs.selectAnswers.push(/^personal$/);
		assert.equal(await r.input(), undefined);
		assert.equal(r.dialogs.confirms.length, 0);
	});

	it("matches the whole word ignoring case", async () => {
		const r = rig({ multiPassLabels: { acme: "WORK" } });
		r.dialogs.selectAnswers.push(/^personal$/);
		r.dialogs.confirmAnswers.push(true);
		await r.input();
		assert.equal(r.dialogs.confirms.length, 1);
	});
});

describe("tag prompt in the TUI", () => {
	it("draws a checkbox list with nothing pre-checked and a title with the place zone", async () => {
		const r = rig({ mode: "tui" });
		r.tag.customKeys.push([KEY.escape]);
		r.dialogs.selectAnswers.push(/^Cancel$/);
		await r.input();
		assert.deepEqual(r.tag.customFrames[0]![0], [
			"This place is personal. Which zones does acme · saved API key belong to?",
			"",
			"> [ ] work",
			"  [ ] personal",
			"",
			"up/down move, space checks, enter confirms, esc cancels",
		]);
		assert.equal(r.dialogs.selects.length, 1, "Cancel falls to the Block select");
		assert.match(r.dialogs.selects[0]!.title, /has no zone tag/);
		assert.deepEqual(r.files.writes, []);
	});

	it("asks again when enter is pressed with nothing checked, then tags the checked zones and proceeds on a Match", async () => {
		const r = rig({ mode: "tui" });
		r.tag.customKeys.push([KEY.enter, KEY.down, KEY.space, KEY.enter]);
		assert.equal(await r.input(), undefined);
		assert.equal(r.tag.customFrames[0]![1]!.at(-1), "Check at least one zone, or press esc to cancel.");
		assert.deepEqual(written(r.files).accounts, [{ provider: "acme", source: "stored-key", zones: ["personal"] }]);
		assert.equal(r.dialogs.selects.length, 0);
	});

	it("tags several checked zones in list order", async () => {
		const r = rig({ mode: "tui" });
		r.tag.customKeys.push([KEY.down, KEY.space, KEY.up, KEY.space, KEY.enter]);
		await r.input();
		assert.deepEqual(written(r.files).accounts, [{ provider: "acme", source: "stored-key", zones: ["work", "personal"] }]);
	});

	it("asks the bypass nudge confirm too", async () => {
		const r = rig({ mode: "tui", multiPassLabels: { acme: "work" } });
		r.tag.customKeys.push([KEY.down, KEY.space, KEY.enter]);
		r.dialogs.confirmAnswers.push(true);
		await r.input();
		assert.equal(r.dialogs.confirms.length, 1);
	});
});
