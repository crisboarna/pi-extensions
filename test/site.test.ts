import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { buildSite, sitePackages } from "../tools/site/build.ts";

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

	it("serves media from the site, plays the hero as a video, and leaves out the npm badges", () => {
		const guard = readFileSync(join(out, "pi-account-guard", "index.html"), "utf8");
		assert.match(guard, /<video controls preload="none" poster="media\/hero\.png" src="media\/hero\.mp4"/);
		assert.doesNotMatch(guard, /raw\.githubusercontent\.com|img\.shields\.io/);
		assert.ok(existsSync(join(out, "pi-account-guard", "media", "hero.mp4")));
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
