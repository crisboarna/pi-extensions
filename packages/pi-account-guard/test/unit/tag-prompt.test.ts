import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { accountInWords, bypassNudge, parseZoneList, tagPromptTitle, zonesNamedInLabel } from "../../src/core/tag-prompt.ts";

describe("accountInWords", () => {
	it("shows the provider id and the auth source in words", () => {
		assert.equal(accountInWords({ provider: "acme", source: "oauth" }), "acme · OAuth login");
		assert.equal(accountInWords({ provider: "acme", source: "stored-key" }), "acme · saved API key");
		assert.equal(accountInWords({ provider: "acme", source: "env:ACME_KEY" }), "acme · environment variable ACME_KEY");
		assert.equal(accountInWords({ provider: "acme", source: "models-json-key" }), "acme · key in models.json");
		assert.equal(accountInWords({ provider: "acme", source: "models-json-command" }), "acme · command in models.json");
		assert.equal(accountInWords({ provider: "acme", source: "claude-config:~/.claude-work" }), "acme · Claude Code login ~/.claude-work");
	});

	it("shows an auth source it does not know as it is", () => {
		assert.equal(accountInWords({ provider: "acme", source: "future-source" }), "acme · future-source");
	});

	it("adds a pi-multi-pass label as a hint", () => {
		assert.equal(accountInWords({ provider: "acme-2", source: "oauth" }, "Work"), "acme-2 · OAuth login (multi-pass: Work)");
	});
});

describe("tagPromptTitle", () => {
	it("states the zone of the place and asks for the zones of the account", () => {
		assert.equal(
			tagPromptTitle({ provider: "acme-2", source: "oauth" }, "personal", "Work"),
			"This place is personal. Which zones does acme-2 · OAuth login (multi-pass: Work) belong to?",
		);
	});
});

describe("parseZoneList", () => {
	const declared = ["work", "personal", "lab"];

	it("reads comma-separated zone names, trimming blanks and repeats", () => {
		assert.deepEqual(parseZoneList(" work, lab ,,work", declared), { ok: true, zones: ["work", "lab"] });
	});

	it("asks again when no zone is given", () => {
		assert.deepEqual(parseZoneList("  , ", declared), { ok: false, message: "Name at least one zone." });
	});

	it("names every zone that is not declared and lists the declared ones", () => {
		assert.deepEqual(parseZoneList("work, wrk, Lab", declared), { ok: false, message: 'Not a declared zone: wrk, Lab. Declared zones: work, personal, lab.' });
	});

	it("refuses the reserved unknown zone", () => {
		assert.equal(parseZoneList("unknown", declared).ok, false);
	});
});

describe("zonesNamedInLabel", () => {
	const declared = ["work", "personal"];

	it("finds a zone as a whole word, ignoring case", () => {
		assert.deepEqual(zonesNamedInLabel("Work seat", declared), ["work"]);
		assert.deepEqual(zonesNamedInLabel("my PERSONAL login", declared), ["personal"]);
		assert.deepEqual(zonesNamedInLabel("team-work", declared), ["work"]);
		assert.deepEqual(zonesNamedInLabel("Work/Personal", declared), ["work", "personal"]);
	});

	it("does not find a zone inside a longer word", () => {
		assert.deepEqual(zonesNamedInLabel("Network", declared), []);
		assert.deepEqual(zonesNamedInLabel("workshop", declared), []);
		assert.deepEqual(zonesNamedInLabel("impersonal", declared), []);
		assert.deepEqual(zonesNamedInLabel("work_2", declared), []);
	});

	it("takes a zone name with regular expression characters literally", () => {
		assert.deepEqual(zonesNamedInLabel("anything", ["a.b", "c+"]), []);
		assert.deepEqual(zonesNamedInLabel("the a.b seat", ["a.b", "c+"]), ["a.b"]);
	});
});

describe("bypassNudge", () => {
	it("is silent without a label", () => {
		assert.equal(bypassNudge({ account: { provider: "acme", source: "oauth" }, multiPassLabel: undefined, chosen: ["personal"], declared: ["work", "personal"] }), undefined);
	});

	it("is silent when the chosen zones cover every zone the label names", () => {
		assert.equal(bypassNudge({ account: { provider: "acme-2", source: "oauth" }, multiPassLabel: "Work seat", chosen: ["work", "personal"], declared: ["work", "personal"] }), undefined);
	});

	it("is silent when the label names no zone", () => {
		assert.equal(bypassNudge({ account: { provider: "acme-2", source: "oauth" }, multiPassLabel: "Network", chosen: ["personal"], declared: ["work", "personal"] }), undefined);
	});

	it("asks a confirm naming the label, the zones left out and the chosen zones", () => {
		assert.deepEqual(bypassNudge({ account: { provider: "acme-2", source: "oauth" }, multiPassLabel: "Work seat", chosen: ["personal"], declared: ["work", "personal"] }), {
			title: "Tag as personal?",
			message: 'The pi-multi-pass label of acme-2 · OAuth login is "Work seat", which names zone work, but you chose personal. Tag it anyway?',
		});
	});
});
