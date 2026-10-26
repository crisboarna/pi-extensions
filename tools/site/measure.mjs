// Measures the live try-it pages in Chromium, Firefox and WebKit inside the
// media image, with network (the WebContainer runtime loads from StackBlitz):
// the site is served without isolation headers, as GitHub Pages serves it;
// each page is started from its button, timed to its ready prompt, then
// driven through its first steps. Prints one line per browser and page and
// saves a screenshot of each in <site>/../site-shots.
//
//   node /repo/tools/site/measure.mjs /site [browser ...]
import { createReadStream, existsSync, mkdirSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { extname, join } from "node:path";

const require = createRequire(`${process.env.MEDIA_MODULES ?? "/opt/media/node_modules"}/`);
const playwright = require("playwright");

const [root, ...browsers] = process.argv.slice(2);
if (!root) throw new Error("usage: measure.mjs <built site> [chromium|firefox|webkit ...]");
const shots = join(root, "..", "site-shots");
mkdirSync(shots, { recursive: true });
const TYPES = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".png": "image/png", ".gz": "application/gzip" };
const server = createServer((request, response) => {
	const file = join(root, decodeURIComponent(new URL(request.url, "http://site").pathname));
	if (!file.startsWith(root) || !existsSync(file) || statSync(file).isDirectory()) return void response.writeHead(404).end();
	response.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "content-length": statSync(file).size });
	createReadStream(file).pipe(response);
}).listen(8098);

/** What each page does once it runs, and the text that says it worked. */
const PAGES = {
	"pi-account-guard": {
		ready: /\$ |❯/,
		steps: [
			["cd ~/personal/garden-planner && pi --model acme/work-model\r", /guard personal/],
			["summarize the garden beds\r", /BLOCKED {2}acme \(env:ACME_WORK_KEY\) is zone work/],
			["\r", /bed 1 resting/],
			["\u0004", /❯/],
			['pi -p --model acme/work-model "summarize the garden beds"; echo "exit $?"\r', /exit 77/],
		],
	},
	"pi-switchboard": {
		ready: /\d+\.\d%\/\d+k/,
		steps: [["rename foo to bar in utils.ts\r", /Renamed foo to bar/]],
	},
};

const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`;
let failures = 0;
for (const name of browsers.length ? browsers : ["chromium", "firefox", "webkit"]) {
	const browser = await playwright[name].launch();
	for (const [folder, plan] of Object.entries(PAGES)) {
		if (!existsSync(join(root, folder, "try.html"))) continue;
		const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
		const page = await context.newPage();
		const bytes = new Map();
		page.on("requestfinished", async (request) => {
			const sizes = await request.sizes().catch(() => undefined);
			const response = await request.response().catch(() => undefined);
			if (!sizes || !response) return;
			// A body read as a stream (the snapshot) can report no size; its Content-Length says it.
			const body = Math.max(sizes.responseBodySize, Number((await response.headerValue("content-length").catch(() => null)) ?? 0));
			const host = new URL(request.url()).host.replace(/^127\.0\.0\.1:\d+$/, "this site");
			if (!host) return;
			bytes.set(host, (bytes.get(host) ?? 0) + body + sizes.responseHeadersSize);
		});
		const errors = [];
		page.on("pageerror", (error) => errors.push(error.message));
		const output = () => page.evaluate(() => window.TRY?.output ?? "").catch(() => "");
		const until = async (test, timeout) => {
			for (const end = Date.now() + timeout; Date.now() < end; await page.waitForTimeout(200)) if (await test()) return true;
			return false;
		};
		let result = "";
		try {
			await page.goto(`http://127.0.0.1:8098/${folder}/try.html`);
			// coi-serviceworker reloads the page once to make it cross-origin isolated.
			if (!(await until(() => page.evaluate(() => window.crossOriginIsolated).catch(() => false), 20000)))
				throw new Error("the page never became cross-origin isolated");
			const clicked = Date.now();
			await page.click("#start");
			const running = await until(async () => (await page.evaluate(() => window.TRY?.state).catch(() => "")) === "running", 120000);
			if (!running) throw new Error(`did not start: ${await page.evaluate(() => window.TRY?.error ?? document.getElementById("status")?.textContent)}`);
			if (!(await until(async () => plan.ready.test(await output()), 60000))) throw new Error("no ready prompt");
			const readyAfter = Date.now() - clicked;
			const times = await page.evaluate(() => window.TRY.times);
			const stepTimes = [];
			for (const [text, expected] of plan.steps) {
				const before = (await output()).length;
				const started = Date.now();
				await page.evaluate((typed) => window.TRY.type(typed), text);
				if (!(await until(async () => expected.test((await output()).slice(before)), 60000)))
					throw new Error(`no ${expected} after ${JSON.stringify(text)}`);
				stepTimes.push(seconds(Date.now() - started));
			}
			await page.waitForTimeout(600);
			const total = [...bytes.values()].reduce((sum, value) => sum + value, 0);
			const hosts = [...bytes.entries()].sort((a, b) => b[1] - a[1]).map(([host, value]) => `${host} ${(value / 1048576).toFixed(1)} MB`);
			result = `ready prompt ${seconds(readyAfter)} after the click (container ${seconds(times.booted - times.start)}, snapshot ${seconds(times.mounted - times.booted)}); ${(total / 1048576).toFixed(1)} MB transferred (${hosts.join(", ")}); steps ok in ${stepTimes.join(", ")}`;
		} catch (error) {
			failures++;
			result = `FAILED: ${error.message}${errors.length ? `; page errors: ${errors.join(" | ").slice(0, 400)}` : ""}`;
		}
		await page.screenshot({ path: join(shots, `live-${name}-${folder}.png`) }).catch(() => {});
		console.log(`${name} ${folder}: ${result}`);
		await context.close();
	}
	await browser.close();
}
server.close();
process.exitCode = failures ? 1 : 0;
