import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { completeArguments } from "../../src/core/ref-completions.ts";

const names = ["api", "Agents", "terse"];
const values = (prefix: string) => completeArguments(prefix, names)?.map((item) => item.value) ?? null;

describe("completeArguments", () => {
	it("completes the subcommand while it is the first word", () => {
		assert.deepEqual(values(""), ["list", "add", "edit", "remove"]);
		assert.deepEqual(values("e"), ["edit"]);
		assert.deepEqual(values("r"), ["remove"]);
		assert.equal(values("zzz"), null);
	});

	it("completes Ref names for edit and remove, case-insensitively, keeping the words before", () => {
		assert.deepEqual(values("edit "), ["edit api", "edit Agents", "edit terse"]);
		assert.deepEqual(values("remove a"), ["remove api", "remove Agents"]);
		assert.deepEqual(values("edit ag"), ["edit Agents"]);
		assert.equal(values("edit nothing"), null);
	});

	it("completes the kind of add as the third word", () => {
		assert.deepEqual(values("add x "), ["add x path", "add x file", "add x snippet", "add x dynamic"]);
		assert.deepEqual(values("add x s"), ["add x snippet"]);
	});

	it("does not guess a new Ref's name or its target", () => {
		assert.equal(values("add "), null);
		assert.equal(values("add x file src/"), null);
	});

	it("completes in= values for list, add, edit and remove", () => {
		assert.deepEqual(values("list in="), ["list in=global", "list in=project"]);
		assert.deepEqual(values("add x path a in=g"), ["add x path a in=global"]);
		assert.deepEqual(values("add x path a in="), ["add x path a in=global", "add x path a in=project", "add x path a in=here"]);
		assert.deepEqual(values("edit api desc=x in=h"), ["edit api desc=x in=here"]);
		assert.deepEqual(values("remove api in=pr"), ["remove api in=project"]);
		assert.equal(values("remove api in=h"), null, "here removes nothing, so remove does not offer it");
		assert.equal(values("remove api in=zzz"), null);
	});

	it("labels each item with its last word and describes a subcommand", () => {
		const items = completeArguments("e", names);
		assert.deepEqual(items?.[0], { value: "edit", label: "edit", description: "Edit a Ref in the JSON editor, or with key=value" });
		assert.equal(completeArguments("edit ap", names)?.[0]?.label, "api");
	});
});
