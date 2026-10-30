// The real pi-tui Editor with `#` autocomplete providers stacked the way pi stacks them
// (DESIGN.md sections 4 and 16.1): the last one registered is asked first, and a token it
// does not claim falls through to the next.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EditorHarness } from "../support/editor-harness.ts";
import { issuesProvider, refsProvider } from "../support/probe-autocomplete.ts";

const REFS = ["ref:api", "ref:agents", "ref:diff", "ref:src/api.ts", "ref:src/util/paths.ts"];
const ISSUES = ["#42 crash on start", "#123 slow picker"];

/** Issues registered first, refs last, so refs is the outermost provider and is asked first. */
const chained = () => new EditorHarness([issuesProvider(ISSUES), refsProvider(REFS)]);

describe("# autocomplete through addAutocompleteProvider", () => {
	it("opens the refs list on a bare #, ahead of the provider registered before it", async () => {
		const editor = chained();
		await editor.type("#");
		assert.ok(editor.listOpen);
		assert.match(editor.screen, /ref:api/);
		assert.doesNotMatch(editor.screen, /#42/, "the earlier provider is not asked while the later one answers");
	});

	it("narrows the list as the token grows, and claims #text only while a row matches", async () => {
		const editor = chained();
		await editor.type("#ag");
		assert.ok(editor.listOpen);
		assert.match(editor.screen, /ref:agents/);
		assert.doesNotMatch(editor.screen, /ref:api/);
		await editor.type("x");
		assert.equal(editor.listOpen, false, "nothing matches #agx and no other provider claims it");
	});

	it("falls a numeric token through to the provider registered before", async () => {
		const editor = chained();
		await editor.type("#4");
		assert.ok(editor.listOpen);
		assert.match(editor.screen, /#42 crash on start/);
		assert.doesNotMatch(editor.screen, /ref:/);
	});

	it("falls an unmatched token through, and closes the list when nobody claims it", async () => {
		const editor = chained();
		await editor.type("#zzz");
		assert.equal(editor.listOpen, false);
		assert.equal(editor.text, "#zzz");
	});

	it("opens nothing for # followed by a space, so a Markdown heading is left alone", async () => {
		const editor = chained();
		await editor.type("# heading");
		assert.equal(editor.listOpen, false);
		assert.equal(editor.text, "# heading");
	});

	it("keeps the list open while a token of / characters still matches a row, and closes it when none does", async () => {
		const editor = chained();
		await editor.type("#sr");
		assert.ok(editor.listOpen);
		await editor.type("c/");
		assert.ok(editor.listOpen, "typing / keeps the open list");
		assert.match(editor.screen, /ref:src\/api\.ts/);
		await editor.type("ut");
		assert.ok(editor.listOpen);
		assert.match(editor.screen, /ref:src\/util\/paths\.ts/);
		assert.doesNotMatch(editor.screen, /ref:src\/api\.ts/);
		await editor.type("x");
		assert.equal(editor.listOpen, false, "no row matches #src/utx");
	});

	it("replaces the typed token with the provider's text when a row is picked", async () => {
		const editor = chained();
		await editor.type("see #ag");
		assert.match(editor.screen, /ref:agents/);
		await editor.press("\t");
		assert.equal(editor.text, "see [ref:agents]");
		assert.equal(editor.listOpen, false);
	});
});
