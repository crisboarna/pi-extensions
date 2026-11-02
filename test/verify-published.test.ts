// The check after a publish decides from facts it reads (the remote, the registry, an install, real pi), so the decision is a pure function and is tested
// here with invented facts: each way a "successful" publish can still be wrong has a case, and the case that is right has none of them.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { COMMANDS } from "../scripts/lib/pi-rpc.ts";
import { type Facts, PROVENANCE, parsePublished, problemsWith, readUntil, tagOf } from "../scripts/release/verify-published.ts";

const SWITCHBOARD = { name: "@crisboarna/pi-switchboard", version: "0.1.0" };

/** Facts for a release that is as it should be, for the package given. */
function good(published = SWITCHBOARD): Facts {
	return {
		tag: true,
		latest: published.version,
		provenance: PROVENANCE,
		audit: { ok: true, detail: "audited 2 packages; 2 packages have verified registry signatures" },
		pi: { answered: true, commands: (COMMANDS[published.name] ?? []).map((name) => ({ name, source: `npm:${published.name}` })), stderr: "" },
	};
}

describe("problemsWith", () => {
	test("a release that is as it should be has no problem, for every package that has commands to register", () => {
		for (const name of Object.keys(COMMANDS)) assert.deepEqual(problemsWith({ name, version: "1.2.3" }, good({ name, version: "1.2.3" })), [], name);
	});

	test("names a missing git tag, and says nothing about the tag when it is not being checked", () => {
		assert.deepEqual(problemsWith(SWITCHBOARD, { ...good(), tag: false }), [
			"@crisboarna/pi-switchboard@0.1.0: the git tag @crisboarna/pi-switchboard@0.1.0 is not on the remote",
		]);
		assert.deepEqual(problemsWith(SWITCHBOARD, { ...good(), tag: undefined }), []);
	});

	test("names a latest that is another version, or absent", () => {
		assert.match(problemsWith(SWITCHBOARD, { ...good(), latest: "0.0.9" })[0] ?? "", /npm's latest is 0\.0\.9, not this version/);
		assert.match(problemsWith(SWITCHBOARD, { ...good(), latest: undefined })[0] ?? "", /npm's latest is missing/);
	});

	test("names a missing or different provenance attestation", () => {
		assert.match(problemsWith(SWITCHBOARD, { ...good(), provenance: undefined })[0] ?? "", /no provenance attestation on npm \(found none\)/);
		assert.match(problemsWith(SWITCHBOARD, { ...good(), provenance: "https://example.test/other" })[0] ?? "", /found https:\/\/example\.test\/other/);
	});

	test("carries npm's own words when the signature audit fails", () => {
		const problems = problemsWith(SWITCHBOARD, { ...good(), audit: { ok: false, detail: "1 package has an invalid attestation" } });
		assert.deepEqual(problems, ["@crisboarna/pi-switchboard@0.1.0: npm audit signatures failed on a clean install: 1 package has an invalid attestation"]);
	});

	test("a pi that did not start says so with what it printed, and nothing is said about commands", () => {
		const problems = problemsWith(SWITCHBOARD, { ...good(), pi: { answered: false, commands: [], stderr: "  Error: cannot find module x  " } });
		assert.equal(problems.length, 1);
		assert.match(problems[0] ?? "", /pi did not answer get_commands with it installed from npm Error: cannot find module x$/);
	});

	test("a package that loads but registers none of its commands fails for each one it lacks", () => {
		const problems = problemsWith(SWITCHBOARD, { ...good(), pi: { answered: true, commands: [], stderr: "" } });
		assert.deepEqual(problems, [
			"@crisboarna/pi-switchboard@0.1.0: pi installed it from npm but it registers no /tier",
			"@crisboarna/pi-switchboard@0.1.0: pi installed it from npm but it registers no /skill:pi-switchboard",
		]);
	});

	test("a command that came from somewhere else than the npm install does not count", () => {
		const facts = good();
		facts.pi.commands = [
			{ name: "tier", source: "local:./packages/pi-switchboard" },
			{ name: "skill:pi-switchboard", source: undefined },
		];
		const problems = problemsWith(SWITCHBOARD, facts);
		assert.equal(problems.length, 2);
		assert.match(problems[0] ?? "", /\/tier came from local:\.\/packages\/pi-switchboard, not from the npm install/);
		assert.match(problems[1] ?? "", /\/skill:pi-switchboard came from no source/);
	});

	test("a package with no entry in COMMANDS is a problem, not a pass: nothing says what it must register", () => {
		const unknown = { name: "@crisboarna/pi-new", version: "0.1.0" };
		const problems = problemsWith(unknown, good(unknown));
		assert.deepEqual(problems, [
			"@crisboarna/pi-new@0.1.0: list the commands it registers in COMMANDS in scripts/lib/pi-rpc.ts (an empty list if it has none)",
		]);
	});

	test("reports every problem at once, so one run says everything that is wrong", () => {
		const problems = problemsWith(SWITCHBOARD, {
			tag: false,
			latest: "0.0.1",
			provenance: undefined,
			audit: { ok: false, detail: "x" },
			pi: { answered: true, commands: [], stderr: "" },
		});
		assert.equal(problems.length, 4 + 2);
	});
});

describe("parsePublished", () => {
	test("reads the published-packages output", () => {
		assert.deepEqual(
			parsePublished('[{"name":"@crisboarna/pi-switchboard","version":"0.1.0"},{"name":"@crisboarna/pi-account-guard","version":"0.2.0"}]'),
			[
				{ name: "@crisboarna/pi-switchboard", version: "0.1.0" },
				{ name: "@crisboarna/pi-account-guard", version: "0.2.0" },
			],
		);
	});

	test("refuses nothing, text, an empty list and an entry without a version, naming what is wrong", () => {
		assert.throws(() => parsePublished(undefined), /not JSON/);
		assert.throws(() => parsePublished("not json"), /not JSON/);
		assert.throws(() => parsePublished("[]"), /lists no package/);
		assert.throws(() => parsePublished('{"name":"x"}'), /lists no package/);
		assert.throws(() => parsePublished('[{"name":"x"}]'), /without a name and a version/);
	});
});

describe("tagOf", () => {
	test("is the tag changesets creates: the name, an at sign and the version", () => {
		assert.equal(tagOf(SWITCHBOARD), "@crisboarna/pi-switchboard@0.1.0");
	});
});

describe("readUntil", () => {
	const options = (sleeps: number[]) => ({ attempts: 5, delayMs: 15_000, sleep: async (ms: number) => void sleeps.push(ms) });

	test("reads once and does not wait when the first answer is the one wanted", async () => {
		const sleeps: number[] = [];
		let reads = 0;
		const value = await readUntil(
			() => ++reads,
			(n) => n === 1,
			options(sleeps),
		);
		assert.equal(value, 1);
		assert.deepEqual(sleeps, []);
	});

	test("waits between reads until the registry shows what is wanted, then stops", async () => {
		const sleeps: number[] = [];
		let reads = 0;
		const value = await readUntil(
			() => ++reads,
			(n) => n === 3,
			options(sleeps),
		);
		assert.equal(value, 3);
		assert.deepEqual(sleeps, [15_000, 15_000]);
	});

	test("gives up after the attempts it was given and returns the last answer, never waiting after the last", async () => {
		const sleeps: number[] = [];
		let reads = 0;
		const value = await readUntil(
			() => ++reads,
			() => false,
			options(sleeps),
		);
		assert.equal(value, 5);
		assert.equal(sleeps.length, 4);
	});

	test("a read that is async works the same way", async () => {
		const sleeps: number[] = [];
		let reads = 0;
		assert.equal(
			await readUntil(
				async () => ++reads,
				(n) => n >= 2,
				options(sleeps),
			),
			2,
		);
	});
});
