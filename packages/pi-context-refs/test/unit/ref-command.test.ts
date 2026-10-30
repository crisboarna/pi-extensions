import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { libraryProblem, parseRefArguments, splitWords } from "../../src/core/ref-command.ts";

const words = (line: string) => {
	const result = splitWords(line);
	return "error" in result ? result : result.words.map((word) => word.text);
};

describe("splitWords", () => {
	it("splits on whitespace and drops the extra", () => {
		assert.deepEqual(words("  a   b\tc "), ["a", "b", "c"]);
	});

	it("keeps quoted text together, single quotes literal and double quotes with backslash escapes", () => {
		assert.deepEqual(words(`git log --format="%h %s" 'a b'`), ["git", "log", "--format=%h %s", "a b"]);
		assert.deepEqual(words(String.raw`"say \"hi\" \\ done" 'x\y' "a\b"`), [String.raw`say "hi" \ done`, String.raw`x\y`, String.raw`a\b`]);
	});

	it("lets a backslash outside quotes escape the next character", () => {
		assert.deepEqual(words(String.raw`a\ b c\"d`), ["a b", 'c"d']);
	});

	it("joins adjacent quoted and bare parts into one word and keeps an empty quoted word", () => {
		assert.deepEqual(words(`pre"fix ed"post ''`), ["prefix edpost", ""]);
	});

	it("reports an unterminated quote", () => {
		assert.deepEqual(words(`a "b c`), { error: "a double quote is not closed" });
		assert.deepEqual(words(`a 'b c`), { error: "a single quote is not closed" });
	});

	it("reports whether a word starts with a quote", () => {
		const result = splitWords(`desc=x "desc=y"`);
		assert.deepEqual("words" in result ? result.words.map((word) => word.quoted) : [], [false, true]);
	});
});

const parse = (args: string) => parseRefArguments(args);

describe("parseRefArguments: list", () => {
	it("is list with no arguments or with the word list", () => {
		assert.deepEqual(parse(""), { ok: true, command: { name: "list" } });
		assert.deepEqual(parse("  list "), { ok: true, command: { name: "list" } });
	});

	it("reads tag= and in=", () => {
		assert.deepEqual(parse("list tag=Docs in=global"), { ok: true, command: { name: "list", tag: "Docs", library: "global" } });
	});

	it("rejects a tag that is not a tag, with the list usage", () => {
		for (const bad of ["tag=", "tag=a!b", "tag=docs.", "tag=a:b"]) {
			const result = parse(`list ${bad}`);
			assert.equal(result.ok, false, bad);
			assert.match(result.ok ? "" : result.error, /^tag: a tag /, bad);
			assert.match(result.ok ? "" : (result.usage ?? ""), /^\/ref list /, bad);
		}
	});

	it("rejects anything else with the usage", () => {
		const result = parse("list nonsense");
		assert.equal(result.ok, false);
		assert.match(result.ok ? "" : result.error, /"nonsense"/);
		assert.match(result.ok ? "" : (result.usage ?? ""), /^\/ref list /);
	});
});

describe("parseRefArguments: add", () => {
	it("reads name, kind, target words and key=value fields in any position", () => {
		const result = parse('add api file src/api.ts desc="The API" tags=a,b in=global');
		assert.deepEqual(result, {
			ok: true,
			command: {
				name: "add",
				refName: "api",
				kind: "file",
				target: ["src/api.ts"],
				fields: [
					{ key: "description", value: "The API" },
					{ key: "tags", value: "a,b" },
				],
				library: "global",
			},
		});
	});

	it("keeps the words of a Snippet or a command as the target, including words with an equals sign", () => {
		const snippet = parse("add terse snippet Answer in one sentence. a=b");
		assert.equal(snippet.ok && snippet.command.name === "add" ? snippet.command.target.join("|") : "", "Answer|in|one|sentence.|a=b");
		const command = parse("add tests dynamic npm test -- --grep=foo timeout=30");
		assert.equal(command.ok && command.command.name === "add" ? command.command.target.join("|") : "", "npm|test|--|--grep=foo");
		assert.deepEqual(command.ok && command.command.name === "add" ? command.command.fields : [], [{ key: "timeout", value: "30" }]);
	});

	it("treats a quoted word that looks like a field as target text", () => {
		const result = parse(`add t snippet "desc=not a field"`);
		assert.deepEqual(result.ok && result.command.name === "add" ? result.command.target : [], ["desc=not a field"]);
		assert.deepEqual(result.ok && result.command.name === "add" ? result.command.fields : [], []);
	});

	it("passes quoting through to the argv of a command target", () => {
		const result = parse(`add log dynamic git log "--format=%h %s" -n 5`);
		assert.deepEqual(result.ok && result.command.name === "add" ? result.command.target : [], ["git", "log", "--format=%h %s", "-n", "5"]);
	});

	it("leaves out what is missing so a dialog can ask for it", () => {
		assert.deepEqual(parse("add"), { ok: true, command: { name: "add", target: [], fields: [] } });
		assert.deepEqual(parse("add api"), { ok: true, command: { name: "add", refName: "api", target: [], fields: [] } });
		assert.deepEqual(parse("add api path"), { ok: true, command: { name: "add", refName: "api", kind: "path", target: [], fields: [] } });
	});

	it("accepts the other field names a Ref has", () => {
		const result = parse("add x dynamic ls cwd=src max_output=2048 scope.path=src scope.remote=github.com/a/b");
		assert.deepEqual(result.ok && result.command.name === "add" ? result.command.fields.map((field) => field.key) : [], [
			"cwd",
			"max_output",
			"scope.path",
			"scope.remote",
		]);
	});

	it("reports an unterminated quote with the usage", () => {
		const result = parse(`add x snippet "oops`);
		assert.equal(result.ok, false);
		assert.match(result.ok ? "" : result.error, /double quote/);
		assert.match(result.ok ? "" : (result.usage ?? ""), /^\/ref add /);
	});
});

describe("parseRefArguments: edit and remove", () => {
	it("reads edit with a name and key=value pairs, and splits out in=", () => {
		assert.deepEqual(parse("edit api name=api2 desc= tags=x,y in=global"), {
			ok: true,
			command: {
				name: "edit",
				refName: "api",
				fields: [
					{ key: "name", value: "api2" },
					{ key: "description", value: "" },
					{ key: "tags", value: "x,y" },
				],
				library: "global",
			},
		});
	});

	it("accepts edit with a name only, and with nothing", () => {
		assert.deepEqual(parse("edit api"), { ok: true, command: { name: "edit", refName: "api", fields: [] } });
		assert.deepEqual(parse("edit"), { ok: true, command: { name: "edit", fields: [] } });
	});

	it("rejects an edit word that is not key=value or a field a Ref does not have", () => {
		for (const args of ["edit api loose", "edit api colour=red", "edit api kind=path"]) {
			const result = parse(args);
			assert.equal(result.ok, false, args);
			assert.match(result.ok ? "" : (result.usage ?? ""), /^\/ref edit /, args);
		}
	});

	it("reads remove with a name and in=", () => {
		assert.deepEqual(parse("remove api in=global"), { ok: true, command: { name: "remove", refName: "api", library: "global" } });
		assert.deepEqual(parse("remove"), { ok: true, command: { name: "remove" } });
	});

	it("rejects extra words after remove", () => {
		const result = parse("remove a b");
		assert.equal(result.ok, false);
		assert.match(result.ok ? "" : (result.usage ?? ""), /^\/ref remove /);
	});
});

describe("parseRefArguments: sent", () => {
	it("takes no arguments", () => {
		assert.deepEqual(parse("sent"), { ok: true, command: { name: "sent" } });
		const result = parse("sent now");
		assert.equal(result.ok, false);
		assert.match(result.ok ? "" : result.error, /"now"/);
		assert.equal(result.ok ? "" : result.usage, "/ref sent");
	});
});

describe("parseRefArguments: approvals, approve and revoke", () => {
	it("reads approvals with no arguments", () => {
		assert.deepEqual(parse("approvals"), { ok: true, command: { name: "approvals" } });
		const result = parse("approvals now");
		assert.equal(result.ok, false);
		assert.equal(result.ok ? "" : result.usage, "/ref approvals");
	});

	it("reads the name to approve or revoke, which may be left out for a dialog to ask", () => {
		assert.deepEqual(parse("approve tests"), { ok: true, command: { name: "approve", refName: "tests" } });
		assert.deepEqual(parse("approve"), { ok: true, command: { name: "approve" } });
		assert.deepEqual(parse("revoke tests"), { ok: true, command: { name: "revoke", refName: "tests" } });
		assert.deepEqual(parse("revoke all"), { ok: true, command: { name: "revoke", refName: "all" } });
		assert.deepEqual(parse("revoke"), { ok: true, command: { name: "revoke" } });
	});

	it("has no form that approves everything or takes a library", () => {
		for (const line of ["approve a b", "approve in=project", "revoke a b", "revoke in=project"]) {
			const result = parse(line);
			assert.equal(result.ok, false, line);
			assert.match(result.ok ? "" : (result.usage ?? ""), /^\/ref (approve <name>|revoke <name\|all>)$/, line);
		}
	});
});

describe("parseRefArguments: unknown subcommand", () => {
	it("names the subcommands that exist", () => {
		const result = parse("frobnicate");
		assert.equal(result.ok, false);
		assert.match(result.ok ? "" : result.error, /unknown subcommand "frobnicate"/);
		assert.match(result.ok ? "" : (result.usage ?? ""), /list.*add.*edit.*remove.*approvals.*approve.*revoke.*sent/s);
	});
});

describe("a command with no name", () => {
	it("reads in= and key=value as options, not as the name", () => {
		assert.deepEqual(parse("edit in=project"), { ok: true, command: { name: "edit", fields: [], library: "project" } });
		assert.deepEqual(parse("remove in=global"), { ok: true, command: { name: "remove", library: "global" } });
		assert.deepEqual(parse("edit desc=x"), { ok: true, command: { name: "edit", fields: [{ key: "description", value: "x" }] } });
	});

	it("still reads a quoted word that looks like an option as the name", () => {
		assert.deepEqual(parse('edit "in=x"'), { ok: true, command: { name: "edit", refName: "in=x", fields: [] } });
	});
});

describe("libraryProblem", () => {
	const problem = (args: string) => {
		const parsed = parse(args);
		assert.equal(parsed.ok, true, args);
		return parsed.ok ? libraryProblem(parsed.command) : undefined;
	};

	it("accepts the libraries each subcommand can use", () => {
		for (const args of [
			"list in=global",
			"list in=project",
			"add a path x in=here",
			"add a path x in=project",
			"edit a in=here",
			"remove a in=project",
			"remove a",
			"list",
		]) {
			assert.equal(problem(args), undefined, args);
		}
	});

	it("refuses an unknown library, and here where it cannot apply, naming the libraries that can", () => {
		assert.equal(problem("list in=elsewhere"), 'unknown library "elsewhere"; the libraries are: global, project');
		assert.equal(problem("remove a in=here"), 'unknown library "here"; the libraries are: global, project');
		assert.equal(problem("add a path x in=nope"), 'unknown library "nope"; the libraries are: global, project, here');
	});
});
