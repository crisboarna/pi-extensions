import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RemoteUrls } from "../../src/core/place.ts";
import { registerGuard } from "../../src/pi/hooks.ts";
import { attachDialogs, type FakeModel } from "../support/fake-dialogs.ts";
import { createFakeHost, createFakeSession } from "../support/fake-pi.ts";
import { attachTagDialogs } from "../support/tag-dialogs.ts";

const CONFIG_PATH = "/home/me/.pi/agent/account-guard.json";
const acmeMid: FakeModel = { provider: "acme", id: "mid" };

interface RigOptions {
	/** The file text; `undefined` is a missing file. */
	file?: object | string;
	mode?: "rpc" | "print";
	cwd?: string;
	remotes?: RemoteUrls;
}

/** A guard whose session on `acme/mid` (a stored key) works in `/home/me/proj`, with `acme` tagged work unless the file says otherwise. */
function rig({ file, mode = "rpc", cwd = "/home/me/proj", remotes = { ok: true, urls: [] } }: RigOptions = {}) {
	const host = createFakeHost();
	const session = createFakeSession({ cwd, hasUI: mode !== "print", model: acmeMid });
	const dialogs = attachDialogs(host, session, [acmeMid]);
	const tagDialogs = attachTagDialogs(session, mode);
	const files = { text: (typeof file === "object" ? JSON.stringify(file) : file) as string | undefined, writes: [] as string[] };
	const stderr: string[] = [];
	const exitCodes: number[] = [];
	registerGuard(dialogs.pi as never, {
		home: "/home/me",
		configPath: CONFIG_PATH,
		readConfigText: () => files.text,
		realpath: (path) => path,
		readRemoteUrls: () => remotes,
		writeConfigText: (_path, text) => {
			files.writes.push(text);
			files.text = text;
		},
		writeStderr: (text) => void stderr.push(text),
		setExitCode: (code) => void exitCodes.push(code),
	});
	const guard = (args = "") => host.commands.get("guard")!.handler(args, session.ctx);
	const start = () => host.fire("session_start", { reason: "startup" }, session.ctx);
	/** Whether a user turn passes the guard now. */
	const turnPasses = async () => (await host.fire("input", { text: "hi", source: "interactive" }, session.ctx)) === undefined;
	const footer = () => session.statuses.get("guard");
	const notices = () => session.notices.map((notice) => notice.message);
	const config = () => JSON.parse(files.text ?? "null");
	return { host, session, dialogs, tagDialogs, files, stderr, exitCodes, guard, start, turnPasses, footer, notices, config };
}

const tagged = { accounts: [{ provider: "acme", source: "stored-key", zones: ["work"] }] };
const rules = (r: { config(): { places: unknown[] } }) => r.config().places;

describe("/guard place add", () => {
	it("adds the directory of this place at the top with full arguments, and the session uses the new zone at once", async () => {
		const r = rig({ file: tagged });
		await r.start();
		assert.equal(r.footer(), "guard personal ✗ acme is work");
		await r.guard("place add path=here zone=work");
		assert.deepEqual(rules(r), [{ path: "~/proj", zone: "work" }]);
		assert.deepEqual(r.notices(), ["Added rule 1: ~/proj -> work."]);
		assert.equal(r.footer(), "guard work ✓");
		assert.equal(await r.turnPasses(), true);
		assert.equal(r.dialogs.selects.length + r.dialogs.confirms.length, 0);
	});

	it("writes the home directory as ~", async () => {
		const r = rig({ file: tagged, cwd: "/home/me" });
		await r.guard("place add path=here zone=work");
		assert.deepEqual(rules(r), [{ path: "~", zone: "work" }]);
	});

	it("takes a path, a remote or both as typed, and a position", async () => {
		const r = rig({ file: { ...tagged, places: [{ path: "/a", zone: "work" }, { path: "/b", zone: "work" }] } });
		await r.guard("place add path=~/code remote=*/Acme/* zone=personal at=2");
		assert.deepEqual(rules(r), [{ path: "/a", zone: "work" }, { path: "~/code", remote: "*/Acme/*", zone: "personal" }, { path: "/b", zone: "work" }]);
		await r.guard("place add remote=host/org/* zone=work at=4");
		assert.deepEqual(rules(r).at(-1), { remote: "host/org/*", zone: "work" });
	});

	it("changes the zone of this place only when the new rule decides it", async () => {
		const r = rig({ file: tagged });
		await r.start();
		await r.guard("place add path=/elsewhere zone=work");
		assert.equal(r.footer(), "guard personal ✗ acme is work");
		await r.guard("place add path=/elsewhere zone=work at=1");
		assert.equal(r.footer(), "guard personal ✗ acme is work");
	});

	it("does not pick up a hand edit of the rules until the next session start", async () => {
		const r = rig({ file: tagged });
		await r.start();
		r.files.text = JSON.stringify({ ...tagged, places: [{ path: "/home/me/proj", zone: "work" }] });
		assert.equal(await r.turnPasses(), false, "the cached zone is still personal");
		await r.start();
		assert.equal(await r.turnPasses(), true);
	});

	describe("with dialogs", () => {
		const remotes: RemoteUrls = { ok: true, urls: ["git@github.com:Acme/api.git", "https://gitlab.com/acme/web.git"] };

		it("shows which rule decides the place, then offers the directory, a remote or both, then a zone", async () => {
			const r = rig({ file: { ...tagged, places: [{ path: "/home/**", zone: "personal" }] }, remotes });
			r.dialogs.selectAnswers.push(/^This directory and below/, /^work$/);
			await r.guard("place add");
			assert.deepEqual(r.dialogs.selects[0], {
				title: "~/proj -> personal (rule 1: /home/**)\nWhat should the new rule match?",
				options: ["This directory and below (~/proj)", "One of its remotes", "This directory and one of its remotes"],
			});
			assert.deepEqual(r.dialogs.selects[1], { title: "Which zone does the new rule give?", options: ["work", "personal"] });
			assert.deepEqual(rules(r), [{ path: "~/proj", zone: "work" }, { path: "/home/**", zone: "personal" }]);
		});

		it("picks one remote of the place from the list, normalized", async () => {
			const r = rig({ file: tagged, remotes });
			r.dialogs.selectAnswers.push(/^One of its remotes/, /gitlab/, /^work$/);
			await r.guard("place add");
			assert.deepEqual(r.dialogs.selects[1], { title: "Which remote?", options: ["github.com/Acme/api", "gitlab.com/acme/web"] });
			assert.deepEqual(rules(r), [{ remote: "gitlab.com/acme/web", zone: "work" }]);
		});

		it("takes the directory and a remote together", async () => {
			const r = rig({ file: tagged, remotes });
			r.dialogs.selectAnswers.push(/^This directory and one of/, /github/, /^work$/);
			await r.guard("place add");
			assert.deepEqual(rules(r), [{ path: "~/proj", remote: "github.com/Acme/api", zone: "work" }]);
		});

		it("offers only the directory when the place has no remote, and says when git cannot tell", async () => {
			const none = rig({ file: tagged });
			await none.guard("place add");
			assert.deepEqual(none.dialogs.selects[0]!.options, ["This directory and below (~/proj)"]);
			const broken = rig({ file: tagged, remotes: { ok: false, reason: "git failed: boom" } });
			await broken.guard("place add");
			assert.match(broken.dialogs.selects[0]!.title, /\nIts remotes cannot be read: git failed: boom\.\n/);
		});

		it("asks only for what the arguments leave out", async () => {
			const r = rig({ file: tagged });
			r.dialogs.selectAnswers.push(/^work$/);
			await r.guard("place add path=/x");
			assert.deepEqual(r.dialogs.selects.map((select) => select.title), ["Which zone does the new rule give?"]);
			const s = rig({ file: tagged });
			s.dialogs.selectAnswers.push(/^This directory/);
			await s.guard("place add zone=work");
			assert.deepEqual(rules(s), [{ path: "~/proj", zone: "work" }]);
		});

		it("writes nothing when any dialog is cancelled", async () => {
			for (const answers of [[], [/^This directory/], [/^One of/], [/^One of/, /github/]]) {
				const r = rig({ file: tagged, remotes });
				r.dialogs.selectAnswers.push(...answers);
				await r.guard("place add");
				assert.deepEqual(r.files.writes, []);
				assert.deepEqual(r.session.notices, []);
			}
		});
	});

	describe("refuses", () => {
		it("a zone that is not declared", async () => {
			const r = rig({ file: tagged });
			await r.guard("place add path=here zone=lab");
			assert.deepEqual(r.session.notices, [{ message: "guard: did not add the rule. Not a declared zone: lab. Declared zones: work, personal.\nUsage: /guard place add [path=<path|here>] [remote=<glob>] [zone=<zone>] [at=<n>]", type: "error" }]);
			assert.deepEqual(r.files.writes, []);
		});

		it("a position outside the list, and unknown arguments", async () => {
			const r = rig({ file: tagged });
			await r.guard("place add path=here zone=work at=2");
			assert.match(r.notices()[0]!, /^guard: 2 is not a position from 1 to 1\./);
			await r.guard("place add here work");
			assert.match(r.notices()[1]!, /^guard: the arguments are not path=, remote=, zone= and at=, each once\./);
			assert.deepEqual(r.files.writes, []);
		});

		it("a path that is not absolute, naming the file error", async () => {
			const r = rig({ file: tagged });
			await r.guard("place add path=relative/dir zone=work");
			assert.match(r.notices()[0]!, /^guard: did not add the rule\.\naccount-guard\.json: places\[0\]\.path: must be absolute or start with ~/);
			assert.deepEqual(r.files.writes, []);
		});

		it("a malformed file", async () => {
			const r = rig({ file: "{ nope" });
			await r.guard("place add path=here zone=work");
			assert.match(r.notices()[0]!, /^guard: did not add the rule\. The file is malformed/);
			assert.equal(r.files.text, "{ nope");
		});
	});

	describe("without a UI", () => {
		it("adds silently with full arguments, and the session uses the new zone", async () => {
			const r = rig({ file: tagged, mode: "print" });
			await r.start();
			assert.equal(await r.turnPasses(), false);
			r.stderr.length = 0;
			r.exitCodes.length = 0;
			await r.guard("place add path=here zone=work");
			assert.deepEqual([r.stderr, r.exitCodes, r.session.notices], [[], [], []]);
			assert.equal(await r.turnPasses(), true);
		});

		it("fails with the usage when a condition or the zone is missing", async () => {
			const r = rig({ file: tagged, mode: "print" });
			await r.guard("place add zone=work");
			await r.guard("place add path=here");
			assert.match(r.stderr[0]!, /^guard: name a condition\.\nUsage: \/guard place add/);
			assert.match(r.stderr[1]!, /^guard: name the zone\.\nUsage: \/guard place add/);
			assert.deepEqual(r.exitCodes, [2, 2]);
			assert.deepEqual(r.files.writes, []);
		});
	});
});

describe("/guard place list", () => {
	const file = { ...tagged, places: [{ remote: "*/Acme/*", zone: "work" }, { path: "/home/**", zone: "personal" }, { path: "/home/me", zone: "work" }] };

	it("numbers the rules in file order and marks the one that decides this place", async () => {
		const r = rig({ file });
		await r.guard("place list");
		assert.deepEqual(r.session.notices, [
			{
				message: ["guard place rules", " 1. remote */Acme/* -> work", " 2. /home/** -> personal   <- decides this place", " 3. /home/me -> work", " default zone: personal"].join("\n"),
				type: "info",
			},
		]);
	});

	it("marks the default zone when no rule decides, and says when there are no rules", async () => {
		const r = rig({ file: tagged });
		await r.guard("place list");
		assert.equal(r.notices()[0], ["guard place rules", " no rules", " default zone: personal   <- decides this place"].join("\n"));
	});

	it("prints nothing without a UI, like the status", async () => {
		const r = rig({ file, mode: "print" });
		await r.guard("place list");
		assert.deepEqual([r.stderr, r.exitCodes, r.session.notices], [[], [], []]);
	});
});

describe("/guard place remove and move", () => {
	// Rule 1 does not match the place; rule 2 decides it (work); rule 3 would decide it as personal when rule 2 is gone.
	const file = {
		...tagged,
		defaultZone: "personal",
		places: [{ path: "/elsewhere", zone: "work" }, { path: "/home/me/proj", zone: "work" }, { path: "/home/me", zone: "personal" }],
	};

	it("removes a rule that does not decide this place with no confirm", async () => {
		const r = rig({ file });
		await r.guard("place remove 1");
		assert.equal(r.dialogs.confirms.length, 0);
		assert.deepEqual(rules(r), [{ path: "/home/me/proj", zone: "work" }, { path: "/home/me", zone: "personal" }]);
		assert.deepEqual(r.notices(), ["Removed rule 1 (/elsewhere -> work)."]);
	});

	it("confirms when removing the deciding rule would change this place's zone, then uses the new zone at once", async () => {
		const r = rig({ file });
		await r.start();
		r.dialogs.confirmAnswers.push(true);
		await r.guard("place remove 2");
		assert.deepEqual(r.dialogs.confirms, [{ title: "Remove rule 2?", message: "/home/me/proj -> work\nThis place changes from zone work to zone personal." }]);
		assert.equal(r.footer(), "guard personal ✗ acme is work");
		assert.equal(rules(r).length, 2);
	});

	it("writes nothing when the confirm is declined", async () => {
		const r = rig({ file });
		await r.guard("place remove 2");
		assert.deepEqual(r.files.writes, []);
	});

	it("asks no confirm when the deciding rule is removed but the next one gives the same zone", async () => {
		const r = rig({ file: { ...file, places: [{ path: "/home/me/proj", zone: "work" }, { path: "/home/me", zone: "work" }] } });
		await r.guard("place remove 1");
		assert.equal(r.dialogs.confirms.length, 0);
		assert.equal(rules(r).length, 1);
	});

	it("refuses a number outside the list or not a number", async () => {
		const r = rig({ file });
		await r.guard("place remove 4");
		await r.guard("place remove two");
		assert.match(r.notices()[0]!, /^guard: 4 is not a rule number; there are 3 rules\.\nUsage: \/guard place remove/);
		assert.match(r.notices()[1]!, /^guard: two is not a rule number/);
		assert.deepEqual(r.files.writes, []);
	});

	it("picks the rule from a list when no number is given", async () => {
		const r = rig({ file });
		r.dialogs.selectAnswers.push(/^1\./);
		await r.guard("place remove");
		assert.deepEqual(r.dialogs.selects[0], { title: "Which rule?", options: ["1. /elsewhere -> work", "2. /home/me/proj -> work", "3. /home/me -> personal"] });
		assert.equal(rules(r).length, 2);
	});

	it("moves a rule with no confirm when this place's zone stays", async () => {
		const r = rig({ file });
		await r.guard("place move 1 3");
		assert.equal(r.dialogs.confirms.length, 0);
		assert.deepEqual(rules(r).map((rule: any) => rule.path), ["/home/me/proj", "/home/me", "/elsewhere"]);
		assert.deepEqual(r.notices(), ["Moved rule 1 (/elsewhere -> work) to position 3."]);
	});

	it("confirms a move that changes this place's zone", async () => {
		const r = rig({ file });
		await r.start();
		r.dialogs.confirmAnswers.push(true);
		await r.guard("place move 3 1");
		assert.deepEqual(r.dialogs.confirms, [{ title: "Move rule 3 to position 1?", message: "/home/me -> personal\nThis place changes from zone work to zone personal." }]);
		assert.deepEqual(rules(r).map((rule: any) => rule.path), ["/home/me", "/elsewhere", "/home/me/proj"]);
		assert.equal(r.footer(), "guard personal ✗ acme is work");
	});

	it("asks for the rule and the position with dialogs", async () => {
		const r = rig({ file });
		r.dialogs.selectAnswers.push(/^1\./);
		r.tagDialogs.inputAnswers.push("2");
		await r.guard("place move");
		assert.deepEqual(r.tagDialogs.inputs, [{ title: "Move rule 1 to which position (1 to 3)?", placeholder: "1" }]);
		assert.deepEqual(rules(r).map((rule: any) => rule.path), ["/home/me/proj", "/elsewhere", "/home/me"]);
	});

	it("says so when the rule is already there, and refuses a bad position or half the arguments", async () => {
		const r = rig({ file });
		await r.guard("place move 2 2");
		await r.guard("place move 1 9");
		await r.guard("place move 1");
		assert.equal(r.notices()[0], "Rule 2 is already at position 2.");
		assert.match(r.notices()[1]!, /^guard: 9 is not a position from 1 to 3\./);
		assert.match(r.notices()[2]!, /^guard: name the rule and its new position\./);
		assert.deepEqual(r.files.writes, []);
	});

	describe("without a UI", () => {
		it("edits silently when this place's zone stays", async () => {
			const r = rig({ file, mode: "print" });
			await r.guard("place move 1 3");
			await r.guard("place remove 3");
			assert.deepEqual([r.stderr, r.exitCodes], [[], []]);
			assert.equal(r.files.writes.length, 2);
		});

		it("fails and writes nothing when the edit needs a confirm", async () => {
			const r = rig({ file, mode: "print" });
			await r.guard("place remove 2");
			assert.equal(r.stderr[0], "guard: this edit changes the zone of this place. This place changes from zone work to zone personal. It needs a confirm, so use a UI.\n");
			assert.deepEqual(r.exitCodes, [2]);
			assert.deepEqual(r.files.writes, []);
		});

		it("fails with the usage when the number is missing", async () => {
			const r = rig({ file, mode: "print" });
			await r.guard("place remove");
			assert.equal(r.stderr[0], "guard: name the rule number.\nUsage: /guard place remove [<n>]\n");
			assert.deepEqual(r.exitCodes, [2]);
		});
	});
});

describe("/guard zone add and remove", () => {
	it("adds a zone, and says so when it is declared", async () => {
		const r = rig({ file: tagged });
		await r.guard("zone add lab");
		assert.deepEqual(r.config().zones, ["work", "personal", "lab"]);
		await r.guard("zone add lab");
		assert.deepEqual(r.notices(), ["Added zone lab.", "Zone lab is already declared."]);
		assert.equal(r.files.writes.length, 1);
	});

	it("asks for the name with a dialog, and fails with the usage without a UI", async () => {
		const r = rig({ file: tagged });
		r.tagDialogs.inputAnswers.push(" lab ");
		await r.guard("zone add");
		assert.deepEqual(r.config().zones, ["work", "personal", "lab"]);
		const p = rig({ file: tagged, mode: "print" });
		await p.guard("zone add");
		assert.deepEqual(p.stderr, ["guard: name the zone.\nUsage: /guard zone add [<name>]\n"]);
		assert.deepEqual(p.exitCodes, [2]);
	});

	it("refuses a name with a comma and the reserved name", async () => {
		const r = rig({ file: tagged });
		await r.guard("zone add a,b");
		await r.guard("zone add unknown");
		assert.equal(r.notices()[0], "guard: did not add the zone. A zone name cannot contain a comma: a,b.");
		assert.match(r.notices()[1]!, /^guard: did not add zone unknown\.\naccount-guard\.json: zones\[2\]: "unknown" is reserved/);
		assert.deepEqual(r.files.writes, []);
	});

	describe("remove", () => {
		const file = {
			zones: ["work", "personal", "lab", "spare"],
			defaultZone: "personal",
			accounts: [{ provider: "acme", source: "stored-key", zones: ["work", "lab"] }],
			places: [{ path: "/a", zone: "work" }, { path: "/b", zone: "lab" }],
		};

		it("is refused while a tag, a rule or the default zone references the zone, and lists the references", async () => {
			const r = rig({ file });
			await r.guard("zone remove work");
			await r.guard("zone remove personal");
			assert.deepEqual(r.session.notices, [
				{ message: "guard: did not remove zone work. It is still referenced by:\n  tag acme (stored-key)\n  rule 1: /a -> work", type: "error" },
				{ message: "guard: did not remove zone personal. It is still referenced by:\n  the default zone", type: "error" },
			]);
			assert.deepEqual(r.files.writes, []);
		});

		it("removes a zone nothing references", async () => {
			const r = rig({ file });
			await r.guard("zone remove spare");
			assert.deepEqual(r.config().zones, ["work", "personal", "lab"]);
			assert.deepEqual(r.notices(), ["Removed zone spare."]);
		});

		it("picks the zone with a dialog, and refuses a zone that is not declared", async () => {
			const r = rig({ file });
			r.dialogs.selectAnswers.push(/^spare$/);
			await r.guard("zone remove");
			assert.deepEqual(r.dialogs.selects[0]!.options, ["work", "personal", "lab", "spare"]);
			assert.deepEqual(r.config().zones, ["work", "personal", "lab"]);
			await r.guard("zone remove nope");
			assert.match(r.notices().at(-1)!, /^guard: nope is not a declared zone\. Declared zones: work, personal, lab\.\nUsage: \/guard zone remove/);
		});

		it("fails with the usage and no UI when the zone is missing, and lists the references with no UI", async () => {
			const r = rig({ file, mode: "print" });
			await r.guard("zone remove");
			await r.guard("zone remove lab");
			assert.equal(r.stderr[0], "guard: name the zone.\nUsage: /guard zone remove [<zone>]\n");
			assert.equal(r.stderr[1], "guard: did not remove zone lab. It is still referenced by:\n  tag acme (stored-key)\n  rule 2: /b -> lab\n");
			assert.deepEqual(r.exitCodes, [2, 2]);
		});
	});
});

describe("/guard zone rename", () => {
	const file = {
		zones: ["work", "personal"],
		defaultZone: "work",
		accounts: [{ provider: "acme", source: "stored-key", zones: ["work", "personal"], note: "seat" }, { provider: "beta", source: "oauth", zones: ["work"] }],
		places: [{ path: "/home/me/proj", zone: "work", note: "n" }, { path: "/b", zone: "personal" }],
	};

	it("rewrites the declaration, the tags, the rules and the default zone in one atomic write", async () => {
		const r = rig({ file });
		await r.start();
		await r.guard("zone rename work job");
		assert.equal(r.files.writes.length, 1);
		assert.deepEqual(r.config(), {
			zones: ["job", "personal"],
			defaultZone: "job",
			accounts: [{ provider: "acme", source: "stored-key", zones: ["job", "personal"], note: "seat" }, { provider: "beta", source: "oauth", zones: ["job"] }],
			places: [{ path: "/home/me/proj", zone: "job", note: "n" }, { path: "/b", zone: "personal" }],
		});
		assert.deepEqual(r.notices(), ["Renamed zone work to job."]);
	});

	it("keeps the session's Match, because tags and rules follow the new name", async () => {
		const r = rig({ file });
		await r.start();
		assert.equal(r.footer(), "guard work ✓");
		await r.guard("zone rename work job");
		assert.equal(r.footer(), "guard job ✓");
		assert.equal(await r.turnPasses(), true);
	});

	it("asks for the zone and the new name with dialogs", async () => {
		const r = rig({ file });
		r.dialogs.selectAnswers.push(/^personal$/);
		r.tagDialogs.inputAnswers.push("home");
		await r.guard("zone rename");
		assert.deepEqual(r.tagDialogs.inputs, [{ title: "New name of zone personal?", placeholder: "personal" }]);
		assert.deepEqual(r.config().zones, ["work", "home"]);
	});

	it("refuses a declared new name, an undeclared old name, a comma and half the arguments", async () => {
		const r = rig({ file });
		await r.guard("zone rename work personal");
		await r.guard("zone rename lab other");
		await r.guard("zone rename work a,b");
		await r.guard("zone rename work");
		assert.equal(r.notices()[0], "guard: did not rename zone work. Zone personal is already declared.");
		assert.match(r.notices()[1]!, /^guard: lab is not a declared zone/);
		assert.equal(r.notices()[2], "guard: did not rename zone work. A zone name cannot contain a comma: a,b.");
		assert.match(r.notices()[3]!, /^guard: name the zone and its new name\./);
		assert.deepEqual(r.files.writes, []);
	});

	it("fails with the usage and no UI when the names are missing", async () => {
		const r = rig({ file, mode: "print" });
		await r.guard("zone rename");
		assert.equal(r.stderr[0], "guard: name the zone.\nUsage: /guard zone rename [<old> <new>]\n");
	});
});

describe("/guard zone default", () => {
	// The place falls to the default zone here, so changing the default changes the zone of this place.
	const file = { ...tagged, defaultZone: "personal", places: [{ path: "/elsewhere", zone: "work" }] };

	it("confirms when this place falls to the default and its zone would change, then uses the new zone at once", async () => {
		const r = rig({ file });
		await r.start();
		r.dialogs.confirmAnswers.push(true);
		await r.guard("zone default work");
		assert.deepEqual(r.dialogs.confirms, [{ title: "Change the default zone to work?", message: "It is personal now.\nThis place changes from zone personal to zone work." }]);
		assert.equal(r.config().defaultZone, "work");
		assert.equal(r.footer(), "guard work ✓");
		assert.equal(await r.turnPasses(), true);
	});

	it("writes nothing when the confirm is declined", async () => {
		const r = rig({ file });
		await r.guard("zone default work");
		assert.deepEqual(r.files.writes, []);
	});

	it("asks no confirm when a rule decides this place", async () => {
		const r = rig({ file: { ...file, places: [{ path: "/home/me", zone: "personal" }] } });
		await r.guard("zone default work");
		assert.equal(r.dialogs.confirms.length, 0);
		assert.equal(r.config().defaultZone, "work");
	});

	it("says so when the zone is already the default, and picks the zone with a dialog", async () => {
		const r = rig({ file: { ...file, places: [] } });
		await r.guard("zone default personal");
		assert.equal(r.notices()[0], "The default zone is already personal.");
		r.dialogs.selectAnswers.push(/^work$/);
		r.dialogs.confirmAnswers.push(true);
		await r.guard("zone default");
		assert.equal(r.config().defaultZone, "work");
	});

	it("fails and writes nothing without a UI when the edit needs a confirm", async () => {
		const r = rig({ file, mode: "print" });
		await r.guard("zone default work");
		assert.match(r.stderr[0]!, /^guard: this edit changes the zone of this place\. This place changes from zone personal to zone work\. It needs a confirm/);
		assert.deepEqual(r.exitCodes, [2]);
		assert.deepEqual(r.files.writes, []);
	});

	it("refuses a zone that is not declared", async () => {
		const r = rig({ file });
		await r.guard("zone default nope");
		assert.match(r.notices()[0]!, /^guard: nope is not a declared zone/);
	});
});

describe("/guard place and zone", () => {
	it("fail with the usage on a missing or unknown subcommand", async () => {
		const r = rig({ file: tagged });
		await r.guard("place");
		await r.guard("zone frobnicate");
		assert.match(r.notices()[0]!, /^guard: place needs add, list, remove or move\./);
		assert.match(r.notices()[1]!, /^guard: zone needs add, remove, rename or default\./);
	});
});
