import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseRefArguments, splitWords } from "../../src/core/ref-command.ts";

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

describe("parseRefArguments: unknown subcommand", () => {
	it("names the subcommands that exist", () => {
		const result = parse("frobnicate");
		assert.equal(result.ok, false);
		assert.match(result.ok ? "" : result.error, /unknown subcommand "frobnicate"/);
		assert.match(result.ok ? "" : (result.usage ?? ""), /list.*add.*edit.*remove/s);
	});
});
