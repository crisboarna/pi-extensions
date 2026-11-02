// The search index is what a reader's query is matched against, so what goes into it matters: the page's words, not its scripts; the page's title,
// readable; a stable order; and a bounded size per page so the one download the browser makes stays quick.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { MAX_TEXT, searchEntry, searchIndex, textOfHtml } from "../tools/site/search.ts";

const page = (title: string, main: string) =>
	`<!doctype html><html><head><title>${title}</title></head><body><header>menu</header><main id="main" tabindex="-1">${main}</main><footer>foot</footer></body></html>`;

describe("textOfHtml", () => {
	test("keeps what lies outside the tags and cannot be fooled by a tag split in two", () => {
		assert.equal(textOfHtml("<p>one <b>two</b></p>"), "one two");
		assert.equal(textOfHtml("<<script>script>alert(1)"), "scriptalert(1)");
		assert.ok(!textOfHtml("<<script>script>alert(1)").includes("<"));
	});
});

describe("searchEntry", () => {
	test("takes the title and the main content only, collapsing whitespace", () => {
		const entry = searchEntry("pi-demo/index.html", page("pi-demo: a demo", "<h1>Hello</h1>\n\n<p>some   text</p>"));
		assert.deepEqual(entry, { title: "pi-demo: a demo", url: "pi-demo/index.html", text: "Hello some text" });
	});

	test("leaves out the header and footer, and scripts and styles inside the content", () => {
		const entry = searchEntry("a.html", page("t", "<p>words</p><script>var secret = 1;</script><style>.x{color:red}</style><p>more</p>"));
		assert.equal(entry?.text, "words more");
	});

	test("reads the entities a page writes as the characters a reader types", () => {
		const entry = searchEntry("a.html", page("Fish &amp; chips", "<p>a &lt; b &amp;&amp; c &quot;d&quot; it&#39;s</p>"));
		assert.equal(entry?.title, "Fish & chips");
		assert.equal(entry?.text, `a < b && c "d" it's`);
	});

	test("cuts a long page to the limit, so the index stays small", () => {
		const entry = searchEntry("a.html", page("t", `<p>${"word ".repeat(2000)}</p>`));
		assert.equal(entry?.text.length, MAX_TEXT);
	});

	test("a page with no title has no entry, and a page with no main content has an empty text", () => {
		assert.equal(searchEntry("a.html", "<html><body><main>x</main></body></html>"), undefined);
		assert.equal(searchEntry("a.html", "<html><head><title>t</title></head><body>x</body></html>")?.text, "");
	});
});

describe("searchIndex", () => {
	test("is JSON of the entries in path order, whatever the order of the pages", () => {
		const a = { path: "a/index.html", html: page("A", "<p>alpha</p>") };
		const b = { path: "b.html", html: page("B", "<p>beta</p>") };
		const untitled = { path: "c.html", html: "<html></html>" };
		const forward = searchIndex([a, b, untitled]);
		assert.equal(searchIndex([untitled, b, a]), forward);
		assert.deepEqual(JSON.parse(forward), [
			{ title: "A", url: "a/index.html", text: "alpha" },
			{ title: "B", url: "b.html", text: "beta" },
		]);
	});
});
