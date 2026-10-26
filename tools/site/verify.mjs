// Opens every page of a built site in Chromium inside the media image: no
// console error, no failed request, every image decoded, and the hero video
// of each package page plays. Saves a screenshot of the landing page and of
// each package page next to the site, in <site>/../site-shots.
//
//   node /repo/tools/site/verify.mjs /site
import { createReadStream, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { extname, join, relative } from "node:path";

const require = createRequire(`${process.env.MEDIA_MODULES ?? "/opt/media/node_modules"}/`);
const { chromium } = require("playwright");

const root = process.argv[2];
if (!root || !existsSync(join(root, "index.html"))) throw new Error("usage: verify.mjs <built site>");
const shots = join(root, "..", "site-shots");
mkdirSync(shots, { recursive: true });

const TYPES = {
	".html": "text/html",
	".css": "text/css",
	".js": "text/javascript",
	".svg": "image/svg+xml",
	".png": "image/png",
	".gif": "image/gif",
	".mp4": "video/mp4",
	".txt": "text/plain",
	".md": "text/markdown",
	".json": "application/json",
	".vtt": "text/vtt",
};
const server = createServer((request, response) => {
	const path = join(root, decodeURIComponent(new URL(request.url, "http://site").pathname));
	const file = existsSync(path) && statSync(path).isDirectory() ? join(path, "index.html") : path;
	if (!file.startsWith(root) || !existsSync(file)) return void response.writeHead(404).end();
	response.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
	createReadStream(file).pipe(response);
}).listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

const pages = (function walk(dir) {
	return readdirSync(dir).flatMap((name) =>
		statSync(join(dir, name)).isDirectory() ? walk(join(dir, name)) : name.endsWith(".html") ? [join(dir, name)] : [],
	);
})(root).map((file) => relative(root, file));

const problems = [];
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
// The site must stand on its own: anything it loads from elsewhere is a problem.
await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, (route) => {
	problems.push(`${current}: loads ${route.request().url()}`);
	return route.abort();
});
let current = "";
page.on("console", (message) => message.type() === "error" && problems.push(`${current}: console: ${message.text()}`));
page.on("pageerror", (error) => problems.push(`${current}: ${error.message}`));
page.on("requestfailed", (request) => problems.push(`${current}: failed ${request.url()}`));
page.on("response", (response) => response.status() >= 400 && problems.push(`${current}: ${response.status()} ${response.url()}`));
for (const path of pages) {
	current = path;
	await page.goto(`${base}/${path}`, { waitUntil: "load" });
	const broken = await page.$$eval("img", (images) => images.filter((image) => image.complete && image.naturalWidth === 0).map((image) => image.src));
	for (const src of broken) problems.push(`${path}: image did not decode: ${src}`);
	if (path.endsWith("/explain.html")) {
		const answer = await page.waitForFunction(() => document.querySelector("#verdict")?.textContent, null, { timeout: 10000 }).catch(() => undefined);
		if (!answer) problems.push(`${path}: the explainer gave no answer`);
		await page.screenshot({ path: join(shots, `${path.replace(/\//g, "-")}.png`), fullPage: true });
	}
	if (path === "index.html" || path.endsWith("/index.html")) await page.screenshot({ path: join(shots, `${path.replace(/\//g, "-")}.png`), fullPage: false });
	if (path.endsWith("/index.html") && (await page.$("video"))) {
		const played = await page.$eval("video", async (video) => {
			video.muted = true;
			await video.play();
			await new Promise((resolve) => setTimeout(resolve, 1500));
			return video.currentTime;
		});
		if (!(played > 0.5)) problems.push(`${path}: the hero video did not play`);
	}
}
await browser.close();
server.close();
for (const problem of problems) console.error(`  - ${problem}`);
console.log(`site verify: ${pages.length} pages, ${problems.length} problem(s)`);
process.exitCode = problems.length > 0 ? 1 : 0;
