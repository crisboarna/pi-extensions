// The tags a page gives a search engine or a link preview. Each rule that a wrong address, a broken card or a doubled tag would break has a test:
// folders are addressed by their folder, a page with no image gets the small card, running the pass twice adds nothing, and the sitemap is stable.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { IMAGE_SIZE, pagePaths, pageUrl, SITE_URL, sitemap, withSocialTags } from "../tools/site/social.ts";

const page = (title = "pi-demo: a demo", description = "What it does &amp; why") =>
	`<!doctype html>\n<html><head>\n<title>${title}</title>\n<meta name="description" content="${description}">\n</head>\n<body></body></html>\n`;

describe("pageUrl", () => {
	test("addresses an index page by its folder and every other page by its file", () => {
		assert.equal(pageUrl("index.html"), `${SITE_URL}/`);
		assert.equal(pageUrl("pi-demo/index.html"), `${SITE_URL}/pi-demo/`);
		assert.equal(pageUrl("pi-demo/docs/faq.html"), `${SITE_URL}/pi-demo/docs/faq.html`);
		assert.equal(pageUrl("pi-demo/explain.html"), `${SITE_URL}/pi-demo/explain.html`);
	});
});

describe("pagePaths", () => {
	test("keeps the pages and leaves out the vendored runtime, the assets and the live demo's files", () => {
		const files = [
			"index.html",
			"pi-demo/index.html",
			"pi-demo/try.html",
			"pi-demo/try/snapshot.gz",
			"pi-demo/try/index.html",
			"vendor/webcontainer/x.html",
			"assets/site.css",
			"assets/page.html",
			"sw.js",
			"llms.txt",
		];
		assert.deepEqual(pagePaths(files), ["index.html", "pi-demo/index.html", "pi-demo/try.html"]);
	});

	test("sorts what it returns, so a build lists the same pages in the same order", () => {
		assert.deepEqual(pagePaths(["b.html", "a/index.html", "a.html"]), ["a.html", "a/index.html", "b.html"]);
	});
});

describe("withSocialTags", () => {
	test("adds the canonical link and the Open Graph and Twitter tags inside the head, from the page's own title and description", () => {
		const out = withSocialTags(page(), "pi-demo/index.html", `${SITE_URL}/pi-demo/media/cover.png`);
		const head = out.slice(out.indexOf("<head>"), out.indexOf("</head>"));
		assert.ok(head.includes(`<link rel="canonical" href="${SITE_URL}/pi-demo/">`));
		assert.ok(head.includes(`<meta property="og:url" content="${SITE_URL}/pi-demo/">`));
		assert.ok(head.includes('<meta property="og:title" content="pi-demo: a demo">'));
		assert.ok(head.includes('<meta property="og:description" content="What it does &amp; why">'), "the escaped text is reused, not escaped twice");
		assert.ok(head.includes('<meta name="twitter:card" content="summary_large_image">'));
		assert.ok(head.includes(`<meta property="og:image" content="${SITE_URL}/pi-demo/media/cover.png">`));
		assert.ok(head.includes(`<meta property="og:image:width" content="${IMAGE_SIZE.width}">`));
		assert.ok(head.includes(`<meta property="og:image:height" content="${IMAGE_SIZE.height}">`));
		assert.ok(head.includes(`<meta name="twitter:image" content="${SITE_URL}/pi-demo/media/cover.png">`));
		assert.ok(out.endsWith("<body></body></html>\n"), "the body is untouched");
	});

	test("a page with no image gets the small card and no image tags, never a large card with nothing in it", () => {
		const out = withSocialTags(page(), "index.html");
		assert.ok(out.includes('<meta name="twitter:card" content="summary">'));
		assert.ok(!out.includes("og:image") && !out.includes("twitter:image"));
	});

	test("running it twice adds nothing", () => {
		const once = withSocialTags(page(), "pi-demo/index.html", `${SITE_URL}/x.png`);
		assert.equal(withSocialTags(once, "pi-demo/index.html", `${SITE_URL}/x.png`), once);
		assert.equal(once.match(/rel="canonical"/g)?.length, 1);
	});

	test("refuses a page that has no title or no description, and names it", () => {
		assert.throws(() => withSocialTags("<html><head><title>t</title></head></html>", "a.html"), /a\.html: a page needs a title and a description/);
		assert.throws(() => withSocialTags('<html><head><meta name="description" content="d"></head></html>', "b.html"), /b\.html: a page needs a title/);
	});
});

describe("sitemap", () => {
	test("lists one address per page, in a fixed order, as valid sitemap XML", () => {
		const xml = sitemap(["pi-demo/index.html", "index.html", "pi-demo/docs/faq.html"]);
		assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'));
		assert.deepEqual(
			[...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]),
			[`${SITE_URL}/`, `${SITE_URL}/pi-demo/`, `${SITE_URL}/pi-demo/docs/faq.html`],
		);
		assert.ok(xml.endsWith("</urlset>\n"));
		assert.equal(sitemap(["b.html", "a.html"]), sitemap(["a.html", "b.html"]), "the order of the input does not change the file");
	});

	test("escapes characters XML treats as markup in an address", () => {
		assert.ok(sitemap(["a&b.html"]).includes("a&amp;b.html"));
	});
});
