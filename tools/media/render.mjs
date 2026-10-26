// Renders a package's media manifest inside the media image (tools/docker/media.Dockerfile).
//
//   node /repo/tools/media/render.mjs /work
//
// /work is the package's media folder: manifest.json lists the outputs, src/
// holds the HTML pages. A "png" item is a screenshot of a page. An
// "animation" item records the page from the moment the renderer calls
// window.play() until it resolves, then encodes an MP4 (H.264) and a GIF.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(`${process.env.MEDIA_MODULES ?? "/opt/media/node_modules"}/`);
const { chromium } = require("playwright");

const dir = process.argv[2] ?? "/work";
const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
const only = process.argv.slice(3);
const browser = await chromium.launch();

/** Fails the render on a script error in the page, with the page's own message. */
function watch(page, item) {
	page.on("pageerror", (error) => {
		console.error(`media: ${item.page}: ${error.message}`);
		process.exitCode = 1;
	});
}

const pageUrl = (item) => `${pathToFileURL(join(dir, "src", item.page)).href}${item.query ? `?${item.query}` : ""}`;

async function still(item) {
	const context = await browser.newContext({ viewport: { width: item.width, height: item.height }, deviceScaleFactor: item.scale ?? 2 });
	const page = await context.newPage();
	watch(page, item);
	await page.goto(pageUrl(item));
	await page.evaluate(() => document.fonts.ready);
	await page.screenshot({ path: join(dir, item.out) });
	await context.close();
}

async function animation(item) {
	const videos = mkdtempSync(join(tmpdir(), "media-"));
	const size = { width: item.width, height: item.height };
	const context = await browser.newContext({ viewport: size, recordVideo: { dir: videos, size } });
	const started = Date.now();
	const page = await context.newPage();
	watch(page, item);
	await page.goto(pageUrl(item));
	await page.evaluate(() => document.fonts.ready);
	await page.waitForTimeout(300);
	const offset = (Date.now() - started) / 1000;
	await page.evaluate(() => window.play());
	await page.waitForTimeout(item.tailMs ?? 500);
	await context.close();
	const [video] = readdirSync(videos).filter((name) => name.endsWith(".webm"));
	const source = join(videos, video);
	const base = join(dir, item.out);
	const trim = ["-ss", offset.toFixed(2)];
	execFileSync("ffmpeg", [
		"-loglevel",
		"error",
		"-y",
		...trim,
		"-i",
		source,
		"-an",
		"-c:v",
		"libx264",
		"-preset",
		"slow",
		"-crf",
		String(item.crf ?? 30),
		"-pix_fmt",
		"yuv420p",
		"-movflags",
		"+faststart",
		`${base}.mp4`,
	]);
	const gif = item.gif ?? { width: 720, fps: 12 };
	const filters = `fps=${gif.fps},scale=${gif.width}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4`;
	execFileSync("ffmpeg", ["-loglevel", "error", "-y", ...trim, "-i", source, "-filter_complex", filters, `${base}.gif`]);
	rmSync(videos, { recursive: true, force: true });
}

for (const item of manifest.items) {
	if (only.length > 0 && !only.includes(item.out)) continue;
	const started = Date.now();
	if (item.kind === "png") await still(item);
	else if (item.kind === "animation") await animation(item);
	else throw new Error(`unknown media kind ${item.kind}`);
	const outputs = item.kind === "png" ? [item.out] : [`${item.out}.mp4`, `${item.out}.gif`];
	const sizes = outputs.map((out) => `${out} ${Math.round(statSync(join(dir, out)).size / 1024)} KB`).join(", ");
	console.log(`media: ${sizes} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
}
await browser.close();
