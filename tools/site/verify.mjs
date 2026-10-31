// Opens every page of a built site in Chromium inside the media image and
// checks what a visitor would notice:
//   - no console error, no failed request, nothing loaded from another origin,
//     every image decoded;
//   - the hero video of each package page starts by itself, muted, on screen,
//     without the check calling play();
//   - no page scrolls sideways on a 375 px phone or a 3840 px display;
//   - the chosen theme survives a reload and is set before the first paint;
//   - after one visit, the pages render with the network off.
// It saves screenshots (both themes, phone and desktop) next to the site, in
// <site>/../site-shots.
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
const overviews = pages.filter((path) => path.endsWith("/index.html"));

const problems = [];
const browser = await chromium.launch();
const shot = (name) => join(shots, `${name.replace(/\//g, "-")}.png`);

/** A page in a context without the service worker, so every request is the page's own and is checked. */
async function crawl() {
	const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
	const page = await context.newPage();
	let current = "";
	// The site must stand on its own: anything it loads from elsewhere is a problem.
	await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, (route) => {
		problems.push(`${current}: loads ${route.request().url()}`);
		return route.abort();
	});
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
			await page.screenshot({ path: shot(path), fullPage: true });
		}
		if (path === "index.html" || path.endsWith("/index.html")) await page.screenshot({ path: shot(path), fullPage: false });
		if (path.endsWith("/index.html") && (await page.$("video"))) await checkHero(page, path);
		await checkOverflow(page, path);
	}
	await context.close();
}

/** The hero must be playing, muted, with its captions, and on screen: a browser does not autoplay a video below the fold. */
async function checkHero(page, path) {
	await page.waitForTimeout(2000);
	const hero = await page.$eval("video", (video) => {
		const box = video.getBoundingClientRect();
		return {
			playing: !video.paused && video.currentTime > 0.3,
			muted: video.muted,
			captions: video.textTracks.length,
			onScreen: box.top < innerHeight && box.bottom > 0,
		};
	});
	if (!hero.playing) problems.push(`${path}: the hero video did not start by itself`);
	if (!hero.muted) problems.push(`${path}: the hero video autoplays with sound`);
	if (!hero.onScreen) problems.push(`${path}: the hero video starts below the fold`);
	if (hero.captions === 0) problems.push(`${path}: the hero video has no captions`);
}

async function checkOverflow(page, path) {
	for (const [name, width, height] of [
		["phone", 375, 812],
		["4k", 3840, 2160],
	]) {
		await page.setViewportSize({ width, height });
		const wide = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
		if (wide > 1) problems.push(`${path}: scrolls sideways by ${wide}px at ${name} width`);
		if (name === "phone" && (path === "index.html" || overviews.includes(path))) await page.screenshot({ path: shot(`phone-${path}`), fullPage: false });
	}
	await page.setViewportSize({ width: 1280, height: 900 });
}

/** The toggle flips the theme and stores it; a reload then paints in it from the start. */
async function checkTheme() {
	const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
	const page = await context.newPage();
	await page.addInitScript(() => {
		document.addEventListener("readystatechange", () => {
			window.themeAtFirstState ??= document.documentElement.dataset.theme;
		});
	});
	await page.goto(`${base}/index.html`, { waitUntil: "load" });
	if ((await page.getAttribute("html", "data-theme")) !== "dark") problems.push("theme: the site does not start dark");
	await page.click("#theme-toggle");
	if ((await page.getAttribute("html", "data-theme")) !== "light") problems.push("theme: the toggle did not switch to light");
	if ((await page.getAttribute("#theme-toggle", "aria-label")) !== "Switch to dark theme") problems.push("theme: the toggle's label did not follow");
	await page.screenshot({ path: shot("index-light"), fullPage: false });
	await page.reload({ waitUntil: "load" });
	if ((await page.evaluate(() => window.themeAtFirstState)) !== "light") problems.push("theme: a reload painted before the stored theme was set");
	await page.goto(`${base}/pi-switchboard/index.html`, { waitUntil: "load" });
	if ((await page.getAttribute("html", "data-theme")) !== "light") problems.push("theme: another page did not keep the stored theme");
	await page.screenshot({ path: shot("pi-switchboard-index-light"), fullPage: false });
	await context.close();
}

/** One visit installs the worker; then the pages must render with the network off. */
async function checkOffline() {
	const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
	const page = await context.newPage();
	await page.goto(`${base}/index.html`, { waitUntil: "load" });
	const ready = await page.evaluate(() => navigator.serviceWorker.ready.then(() => true)).catch(() => false);
	if (!ready) return void problems.push("offline: the service worker did not install");
	await context.setOffline(true);
	for (const path of ["index.html", "", ...overviews, ...pages.filter((candidate) => candidate.includes("/docs/")).slice(0, 2)]) {
		await page.goto(`${base}/${path}`, { waitUntil: "load" }).catch((error) => problems.push(`offline: ${path || "/"} did not load: ${error.message}`));
		const shown = await page
			.evaluate(() => ({ title: document.querySelector("h1")?.textContent ?? "", background: getComputedStyle(document.body).backgroundColor }))
			.catch(() => ({ title: "", background: "" }));
		if (!shown.title) problems.push(`offline: ${path || "/"} has no title`);
		if (shown.background !== "rgb(7, 9, 12)") problems.push(`offline: ${path || "/"} lost its styles (${shown.background})`);
	}
	await context.close();
}

await crawl();
await checkTheme();
await checkOffline();
await browser.close();
server.close();
for (const problem of problems) console.error(`  - ${problem}`);
console.log(`site verify: ${pages.length} pages, ${problems.length} problem(s)`);
process.exitCode = problems.length > 0 ? 1 : 0;
