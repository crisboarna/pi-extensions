import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	APPROVALS_SCHEMA_URL,
	approvalState,
	approvalsFor,
	definitionLines,
	definitionOf,
	definitionText,
	hashDefinition,
	readApprovals,
	updateApprovals,
	withApproval,
	withoutApprovals,
} from "../../src/core/approval.ts";

const command = (argv: string[], extra: Record<string, unknown> = {}) => ({ name: "tests", kind: "dynamic" as const, command: argv, ...extra });
const url = (target: string) => ({ name: "spec", kind: "dynamic" as const, url: target });
const PROJECT = "/work/app";

function rig(initial?: string) {
	const disk: { text: string | undefined; writes: string[] } = { text: initial, writes: [] };
	const file = {
		path: "/agent/pi-context-refs-approvals.json",
		read: () => disk.text,
		write: (text: string) => {
			disk.writes.push(text);
			disk.text = text;
		},
	};
	return { disk, file };
}

describe("definitionOf", () => {
	it("is the argv and the directory the command runs in", () => {
		assert.deepEqual(definitionOf(command(["npm", "test"]), PROJECT), { source: "command", argv: ["npm", "test"], cwd: PROJECT });
	});

	it("is the URL alone for a URL Ref", () => {
		assert.deepEqual(definitionOf(url("https://example.com/spec.md"), PROJECT), { source: "url", url: "https://example.com/spec.md" });
	});
});

describe("hashDefinition", () => {
	const hash = (argv: string[], cwd = PROJECT) => hashDefinition(definitionOf(command(argv), cwd));

	it("is a SHA-256 in hex that is the same for the same definition", () => {
		assert.match(hash(["git", "log"]), /^[0-9a-f]{64}$/);
		assert.equal(hash(["git", "log"]), hash(["git", "log"]));
	});

	it("changes with any argument, the order of the arguments and the directory", () => {
		const base = hash(["git", "log"]);
		assert.notEqual(hash(["git", "log", "-1"]), base);
		assert.notEqual(hash(["log", "git"]), base);
		assert.notEqual(hash(["git", "log"], "/work/app/sub"), base);
	});

	it("tells a split argument from a joined one", () => {
		assert.notEqual(hash(["sh", "-c", "a b"]), hash(["sh", "-c", "a", "b"]));
		assert.notEqual(hash(["a b"]), hash(["a", "b"]));
	});

	it("tells a command from a URL, and one URL from another", () => {
		assert.notEqual(
			hashDefinition(definitionOf(url("https://example.com/a"), PROJECT)),
			hashDefinition(definitionOf(url("https://example.com/b"), PROJECT)),
		);
		assert.notEqual(
			hashDefinition({ source: "command", argv: ["https://example.com/a"], cwd: PROJECT }),
			hashDefinition({ source: "url", url: "https://example.com/a" }),
		);
	});

	it("does not depend on the Ref's name, its limits or its description", () => {
		const plain = definitionOf(command(["make"]), PROJECT);
		const dressed = definitionOf(command(["make"], { name: "other", timeout: 60, max_output: 1024, description: "d", tags: ["ci"] }), PROJECT);
		assert.equal(hashDefinition(dressed), hashDefinition(plain));
	});
});

describe("the definition as text", () => {
	it("shows the source, the argv and the directory of a command", () => {
		assert.deepEqual(definitionLines({ source: "command", argv: ["git", "log", "--format=a b"], cwd: PROJECT }), [
			"source: command",
			'argv: git log "--format=a b"',
			`cwd: ${PROJECT}`,
		]);
	});

	it("shows the source and the URL of a URL Ref", () => {
		assert.deepEqual(definitionLines({ source: "url", url: "https://example.com/x" }), ["source: url", "url: https://example.com/x"]);
	});

	it("writes control characters as escapes, so an escape sequence cannot redraw the dialog", () => {
		const lines = definitionLines({ source: "command", argv: ["echo", "\u001b[2Jx\ny", "\u001bplain"], cwd: `${PROJECT}\u0007` });
		assert.equal(lines[1], 'argv: echo "\\u001b[2Jx\\ny" \\u001bplain');
		assert.equal(lines[2], `cwd: ${PROJECT}\\u0007`);
		assert.equal(/\p{Cc}/u.test(lines.join("")), false);
	});

	it("is one line in a list", () => {
		assert.equal(definitionText({ source: "command", argv: ["git", "log"], cwd: PROJECT }), `command git log (in ${PROJECT})`);
		assert.equal(definitionText({ source: "url", url: "https://example.com/x" }), "url https://example.com/x");
	});
});

describe("the definition shown in a dialog", () => {
	it("writes control and invisible formatting characters as \\u escapes, so a repository cannot disguise the command", () => {
		const lines = definitionLines({ source: "command", argv: ["foo\u202ebar", "zero\u200bwidth", "line\u2028break", "esc\u001b[2J"], cwd: "/work/app" });
		assert.equal(lines[1], 'argv: foo\\u202ebar zero\\u200bwidth "line\\u2028break" "esc\\u001b[2J"');
	});

	it("does the same to a URL and to the list text", () => {
		assert.equal(definitionLines({ source: "url", url: "https://a\u2066.example/" })[1], "url: https://a\\u2066.example/");
		assert.equal(definitionText({ source: "url", url: "https://a\u200f.example/" }), "url https://a\\u200f.example/");
	});
});

describe("readApprovals", () => {
	it("is empty when there is no file", () => {
		assert.deepEqual(readApprovals(rig().file), { ok: true, approvals: [] });
	});

	it("reads the Approvals and skips entries it cannot use", () => {
		const good = { project: PROJECT, name: "tests", hash: "a".repeat(64), definition: "command npm test", approvedAt: "2026-10-30T10:00:00.000Z" };
		const { file } = rig(JSON.stringify({ version: 1, approvals: [good, { project: 1 }, "x", null] }));
		assert.deepEqual(readApprovals(file), { ok: true, approvals: [good] });
	});

	it("says which file does not parse", () => {
		const result = readApprovals(rig("{").file);
		assert.equal(result.ok, false);
		assert.match(result.ok ? "" : result.error, /pi-context-refs-approvals\.json does not parse/);
	});

	it("says when the file cannot be read, is not an object, or has no list of Approvals", () => {
		const unreadable = rig();
		unreadable.file.read = () => {
			throw new Error("EACCES");
		};
		const reasons = [unreadable.file, rig("[]").file, rig(JSON.stringify({ version: 1, approvals: {} })).file].map((file) => {
			const result = readApprovals(file);
			return result.ok ? "" : result.error;
		});
		assert.match(reasons[0] ?? "", /could not be read: EACCES/);
		assert.match(reasons[1] ?? "", /must be a JSON object/);
		assert.match(reasons[2] ?? "", /\$\.approvals must be a list/);
	});

	it("refuses a file of another version", () => {
		const result = readApprovals(rig(JSON.stringify({ version: 2, approvals: [] })).file);
		assert.equal(result.ok, false);
		assert.match(result.ok ? "" : result.error, /\$\.version must be 1/);
	});
});

describe("updateApprovals", () => {
	const entry = (name: string, hash: string, project = PROJECT) => ({ project, name, hash, definition: "d", approvedAt: "2026-10-30T10:00:00.000Z" });

	it("creates the file with version and $schema, a 2-space indent and a final newline", () => {
		const { disk, file } = rig();
		assert.deepEqual(
			updateApprovals(file, (list) => [...list, entry("tests", "h1")]),
			{ ok: true },
		);
		assert.equal(disk.text, `${JSON.stringify({ version: 1, $schema: APPROVALS_SCHEMA_URL, approvals: [entry("tests", "h1")] }, null, 2)}\n`);
	});

	it("keeps keys it does not know and entries it cannot read", () => {
		const { disk, file } = rig(JSON.stringify({ version: 1, future: true, approvals: ["odd"] }));
		updateApprovals(file, (list) => [...list, entry("tests", "h1")]);
		assert.deepEqual(JSON.parse(disk.text ?? ""), { version: 1, future: true, approvals: ["odd", entry("tests", "h1")] });
	});

	it("refuses and writes nothing when the file does not parse", () => {
		const { disk, file } = rig("nope");
		const result = updateApprovals(file, (list) => list);
		assert.equal(result.ok, false);
		assert.deepEqual(disk.writes, []);
	});

	it("reports a write that fails", () => {
		const { file } = rig();
		file.write = () => {
			throw new Error("disk full");
		};
		const result = updateApprovals(file, (list) => [...list, entry("a", "h")]);
		assert.match(result.ok ? "" : result.error, /could not be written: disk full/);
	});
});

describe("approvalState", () => {
	const list = [
		{ project: PROJECT, name: "Tests", hash: "h1", definition: "d", approvedAt: "t" },
		{ project: "/other", name: "setup", hash: "h2", definition: "d", approvedAt: "t" },
	];

	it("is approved for the same project, name (any case) and hash", () => {
		assert.equal(approvalState(list, PROJECT, "tests", "h1"), "approved");
	});

	it("is pending when the hash differs, the name differs or the project differs", () => {
		assert.equal(approvalState(list, PROJECT, "tests", "changed"), "pending");
		assert.equal(approvalState(list, PROJECT, "other", "h1"), "pending");
		assert.equal(approvalState(list, "/work/app2", "tests", "h1"), "pending");
		assert.equal(approvalState(list, PROJECT, "setup", "h2"), "pending");
	});
});

describe("approvalsFor", () => {
	it("keeps only this project's Approvals", () => {
		const list = [
			{ project: PROJECT, name: "a", hash: "h", definition: "d", approvedAt: "t" },
			{ project: "/other", name: "b", hash: "h", definition: "d", approvedAt: "t" },
		];
		assert.deepEqual(
			approvalsFor(list, PROJECT).map((approval) => approval.name),
			["a"],
		);
	});
});

describe("withApproval", () => {
	const entry = (name: string, hash: string, project = PROJECT) => ({ project, name, hash, definition: "d", approvedAt: "t" });

	it("adds an Approval", () => {
		assert.deepEqual(withApproval([entry("a", "h1")], entry("b", "h2")), [entry("a", "h1"), entry("b", "h2")]);
	});

	it("replaces the Approval of the same project and name (any case), so an old definition does not stay approved", () => {
		const list = [entry("Tests", "old"), entry("tests", "other", "/other")];
		assert.deepEqual(withApproval(list, entry("tests", "new")), [entry("tests", "other", "/other"), entry("tests", "new")]);
	});
});

describe("withoutApprovals", () => {
	const entry = (name: string, project = PROJECT) => ({ project, name, hash: "h", definition: "d", approvedAt: "t" });
	const list = [entry("a"), entry("B"), entry("a", "/other")];

	it("drops the Approvals of one Ref of the project, whatever the case of its name", () => {
		assert.deepEqual(withoutApprovals(list, PROJECT, "b"), [entry("a"), entry("a", "/other")]);
	});

	it("drops every Approval of the project and no other when there is no name", () => {
		assert.deepEqual(withoutApprovals(list, PROJECT), [entry("a", "/other")]);
	});
});
