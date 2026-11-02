import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { buildSite, sitePackages } from "../tools/site/build.ts";
import { IMAGE_SIZE, pagePaths, pageUrl, SITE_URL } from "../tools/site/social.ts";

describe("the family site", () => {
	const out = mkdtempSync(join(tmpdir(), "site-test-"));
	let problems: string[] = [];
	before(() => {
		problems = buildSite(out);
	});
	after(() => rmSync(out, { recursive: true, force: true }));

	it("builds with every link, image and anchor resolving", () => {
		assert.deepEqual(problems, []);
	});

	it("has a landing card, an overview and every docs page for each package", () => {
		const landing = readFileSync(join(out, "index.html"), "utf8");
		for (const pkg of sitePackages()) {
			assert.match(landing, new RegExp(`href="${pkg.folder}/index.html"`));
			assert.match(landing, new RegExp(`pi install npm:${pkg.name}`));
			for (const page of pkg.pages) assert.ok(existsSync(join(out, page.out)), page.out);
		}
	});

	it("gives every package the same card on the landing page", () => {
		const landing = readFileSync(join(out, "index.html"), "utf8");
		const packages = sitePackages();
		assert.equal(packages.length, 3);
		const cards = landing.match(/<article class="card[^"]*"[\s\S]*?<\/article>/g) ?? [];
		assert.equal(cards.length, packages.length);
		for (const [index, card] of cards.entries()) {
			const pkg = packages[index];
			assert.ok(pkg);
			assert.match(card, new RegExp(`<span class="chip">0${index + 1}</span>`));
			assert.match(card, /<dl class="stats">.*Docs.*ADRs.*Demos/);
			assert.match(card, new RegExp(`data-copy="pi install npm:${pkg.name}"`));
			assert.match(card, new RegExp(`href="${pkg.folder}/index\\.html">Overview`));
			assert.match(card, /Explainer|No explainer yet/);
			assert.match(card, /Run live|No live demo yet/);
		}
	});

	it("opens every package page with the same head block, and says what is missing", () => {
		for (const pkg of sitePackages()) {
			const page = readFileSync(join(out, pkg.folder, "index.html"), "utf8");
			assert.match(page, /<section class="pkg-head"/);
			assert.match(page, /<h2>Try it in the browser<\/h2>/);
			assert.equal(/The explainer<\/a>|The explainer: not available/.test(page), true, pkg.folder);
			assert.equal(/Run it live<\/a>|Run it live: not available/.test(page), true, pkg.folder);
		}
	});

	it("sets the stored theme before the stylesheets load, so it never flashes", () => {
		const landing = readFileSync(join(out, "index.html"), "utf8");
		assert.match(landing, /<html lang="en" data-theme="dark">/);
		assert.ok(landing.indexOf("localStorage.getItem") < landing.indexOf('rel="stylesheet"'));
		assert.match(landing, /id="theme-toggle"[^>]*aria-label="Switch to light theme"/);
	});

	it("labels the cells of every table so a narrow screen can show them as cards", () => {
		const page = readFileSync(join(out, "pi-account-guard", "docs", "commands.html"), "utf8");
		assert.match(page, /<td[^>]* data-label="[^"]+"/);
	});

	it("writes a worker that keeps the pages and leaves out video and the live demo", () => {
		const worker = readFileSync(join(out, "sw.js"), "utf8");
		assert.doesNotMatch(worker, /__VERSION__|__PRECACHE__/);
		// Safari does not support COEP credentialless, so the live pages would never become isolated there.
		assert.match(worker, /"Cross-Origin-Embedder-Policy", "require-corp"/);
		assert.doesNotMatch(worker, /["']credentialless["']/);
		const listed = JSON.parse(/const PRECACHE = (\[.*\]);/.exec(worker)?.[1] ?? "[]") as string[];
		assert.ok(listed.includes("index.html") && listed.includes("assets/site.css") && listed.includes("assets/site.js"));
		for (const pkg of sitePackages()) assert.ok(listed.includes(`${pkg.folder}/index.html`), pkg.folder);
		assert.deepEqual(
			listed.filter((file) => /\.(mp4|gz)$|^vendor\/|(^|\/)try\//.test(file)),
			[],
		);
		assert.ok(!existsSync(join(out, "assets", "sw.js")));
	});

	it("serves media from the site, starts the hero muted on load, and leaves out the npm badges", () => {
		const guard = readFileSync(join(out, "pi-account-guard", "index.html"), "utf8");
		assert.match(guard, /<video controls autoplay muted loop playsinline preload="auto" poster="media\/hero\.png" src="media\/hero\.mp4"/);
		// A browser does not autoplay a video below the fold, so the hero sits right under the title.
		assert.match(guard, /<\/h1>\n<div class="hero-video"><video /);
		for (const pkg of sitePackages()) {
			const page = readFileSync(join(out, pkg.folder, "index.html"), "utf8");
			const videos = page.match(/<video [^>]*>/g) ?? [];
			// A package with a demo video must show it as the hero, whatever its README's alt text holds (pi-context-refs' has [ref:api]).
			const hasDemo = existsSync(new URL(`../packages/${pkg.folder}/media/hero.mp4`, import.meta.url));
			if (hasDemo) assert.ok(videos[0], `${pkg.folder}: its demo is a video on the page, not a picture`);
			if (videos[0]) assert.match(videos[0], /autoplay muted loop playsinline/, `${pkg.folder}: the hero starts on load`);
			for (const later of videos.slice(1)) assert.match(later, /controls preload="none"/, pkg.folder);
		}
		const switchboard = readFileSync(join(out, "pi-switchboard", "index.html"), "utf8");
		assert.match(switchboard, /<track kind="captions" srclang="en" label="Narration" src="media\/hero\.vtt" default><\/video>/);
		assert.ok(existsSync(join(out, "pi-switchboard", "media", "hero.vtt")));
		assert.doesNotMatch(guard, /raw\.githubusercontent\.com|img\.shields\.io|scorecard\.dev|github\.io\/pi-extensions\/badges/);
		assert.ok(existsSync(join(out, "pi-account-guard", "media", "hero.mp4")));
	});

	const builtPages = () =>
		pagePaths(
			(readdirSync(out, { recursive: true }) as string[]).map((file) => file.split("\\").join("/")).filter((file) => statSync(join(out, file)).isFile()),
		);

	it("gives every page exactly one canonical address, the one the sitemap lists", () => {
		const pages = builtPages();
		assert.ok(pages.length > 30, `found only ${pages.length} pages`);
		for (const path of pages) {
			const html = readFileSync(join(out, path), "utf8");
			const canonical = html.match(/<link rel="canonical" href="([^"]+)">/g) ?? [];
			assert.equal(canonical.length, 1, `${path}: ${canonical.length} canonical links`);
			assert.ok(canonical[0]?.includes(`href="${pageUrl(path)}"`), `${path}: canonical is ${canonical[0]}`);
			assert.ok(html.includes(`<meta property="og:url" content="${pageUrl(path)}">`), `${path}: og:url`);
			assert.match(html, /<meta property="og:title" content="[^"]+">/, path);
			assert.match(html, /<meta name="twitter:card" content="summary(_large_image)?">/, path);
		}
	});

	it("points every preview image at a file the build holds, 1200 by 630", () => {
		let seen = 0;
		for (const path of builtPages()) {
			const html = readFileSync(join(out, path), "utf8");
			const image = html.match(/<meta property="og:image" content="([^"]+)">/)?.[1];
			if (!image) {
				assert.match(html, /twitter:card" content="summary"/, `${path}: no image, so the small card`);
				continue;
			}
			seen += 1;
			assert.ok(image.startsWith(`${SITE_URL}/`), image);
			assert.ok(html.includes(`<meta name="twitter:image" content="${image}">`), `${path}: twitter:image matches`);
			const file = join(out, image.slice(SITE_URL.length + 1));
			assert.ok(existsSync(file), `${path}: ${image} is not in the build`);
			const header = readFileSync(file).subarray(0, 24);
			assert.equal(header.readUInt32BE(16), IMAGE_SIZE.width, `${image} width`);
			assert.equal(header.readUInt32BE(20), IMAGE_SIZE.height, `${image} height`);
		}
		assert.ok(seen >= sitePackages().length, "every package page has a preview");
	});

	it("lists in the sitemap exactly the pages that were built", () => {
		const listed = [...readFileSync(join(out, "sitemap.xml"), "utf8").matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]).sort();
		assert.deepEqual(listed, builtPages().map(pageUrl).sort());
		assert.equal(new Set(listed).size, listed.length, "no address twice");
	});

	it("lists every page's Markdown source in llms.txt", () => {
		const llms = readFileSync(join(out, "llms.txt"), "utf8");
		assert.match(llms, /^# pi-extensions\n\n> Extensions for pi/);
		for (const pkg of sitePackages())
			for (const page of pkg.pages) {
				const source = page.source.replace(/^packages\//, "");
				assert.ok(llms.includes(`](${source})`), source);
				assert.ok(existsSync(join(out, source)), source);
			}
	});
});
