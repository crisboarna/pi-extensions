import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { triggerProblem, triggerQuery } from "../../src/core/trigger.ts";

describe("triggerProblem", () => {
	it("accepts one character that pi does not use", () => {
		for (const trigger of ["#", "$", "%", "&", "+", "~", "é"]) assert.equal(triggerProblem(trigger), undefined, trigger);
	});

	it("rejects /, @, ! and whitespace", () => {
		for (const trigger of ["/", "@", "!"]) assert.match(triggerProblem(trigger) ?? "", /cannot be .*pi uses/, trigger);
		for (const trigger of [" ", "\t", "\n"]) assert.match(triggerProblem(trigger) ?? "", /whitespace/);
	});

	it("rejects anything but one character", () => {
		assert.match(triggerProblem("") ?? "", /one character/);
		assert.match(triggerProblem("##") ?? "", /one character/);
	});
});

describe("triggerQuery", () => {
	const table: Array<{ name: string; before: string; trigger?: string; query: string | undefined }> = [
		{ name: "a bare Trigger is an empty query", before: "#", query: "" },
		{ name: "the text after the Trigger is the query", before: "see #ap", query: "ap" },
		{ name: "a path and a dot belong to the query", before: "#src/api.ts", query: "src/api.ts" },
		{ name: "a space ends the token, so a Markdown heading opens nothing", before: "# heading", query: undefined },
		{ name: "a space after the query ends the token", before: "#api ", query: undefined },
		{ name: "a Trigger inside a word is not one", before: "page#api", query: undefined },
		{ name: "a Trigger after a path separator is not one", before: "src/#a", query: undefined },
		{ name: "a Trigger after a letter is not one", before: "C#sharp", query: undefined },
		{ name: "a Trigger after an open bracket is one", before: "(#ap", query: "ap" },
		{ name: "a second Trigger in a row is not one", before: "##", query: undefined },
		{ name: "a second Trigger in the query ends it", before: "#a#b", query: undefined },
		{ name: "text with no Trigger is not a token", before: "hello", query: undefined },
		{ name: "another Trigger character works the same way", before: "see $ap", trigger: "$", query: "ap" },
		{ name: "another Trigger leaves # alone", before: "see #ap", trigger: "$", query: undefined },
		{ name: "a doubled custom Trigger is not one", before: "$$", trigger: "$", query: undefined },
		{ name: "a Trigger after a space on the line is one", before: "a b #", query: "" },
	];
	for (const { name, before, trigger = "#", query } of table) {
		it(name, () => assert.equal(triggerQuery(before, trigger), query));
	}
});
