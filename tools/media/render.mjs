// Renders a package's media manifest inside the media image (tools/docker/media.Dockerfile).
//
//   node /repo/tools/media/render.mjs /repo/packages/<name>/media
//
// The argument is the package's media folder (mounted writable): manifest.json lists the outputs, src/
// holds the HTML pages. A "png" item is a screenshot of a page. An
// "animation" item records the page from the moment the renderer calls
// window.play() until it resolves, then encodes an MP4 (H.264) and a GIF; with
// `still: true` the page saves one frame as `<out>.png` by calling
// window.__stageStill() at the moment that shows the idea best.
// A "terminal" item is an animation whose page drives a real program in a
// pseudo-terminal (see stage-server.mjs and stage/stage.js): the module named
// by `setup` prepares the program and returns how to start it, and the page
// can save one frame as `<out>.png` with stage.still(). A page may define
// window.prepare(), which runs before the recording's start (for example to
// start the program), so the video begins at window.play(). An animation or
// terminal item with a `narration` file gets a spoken voice over a music bed
// and a .vtt next to its MP4 (see narration.mjs); its page calls stage.say().
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { mixNarration, prepareNarration } from "./narration.mjs";
import { startStage } from "./stage-server.mjs";

const MODULES = process.env.MEDIA_MODULES ?? "/opt/media/node_modules";
const require = createRequire(`${MODULES}/`);
const { chromium } = require("playwright");

const dir = process.argv[2];
if (!dir) throw new Error("usage: render.mjs <media folder> [output ...]");
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

/** Lets the page save the frame on screen as `<out>.png`, or `<out>-<name>.png`. */
const exposeStill = (page, item) =>
	page.exposeFunction("__stageStill", (name) => page.screenshot({ path: join(dir, name ? `${item.out}-${name}.png` : `${item.out}.png`) }));

async function terminal(item) {
	const { default: setup } = await import(pathToFileURL(join(dir, item.setup)).href);
	const scene = await setup(item);
	const stage = await startStage({ mediaDir: dir, modulesDir: MODULES, spawnSpec: scene.spawn });
	try {
		await animation(item, `${stage.url}/src/${item.page}`, async (page) => {
			await page.exposeFunction("__stageType", (text) => page.keyboard.type(text));
			await page.exposeFunction("__stagePress", (key) => page.keyboard.press(key));
			await exposeStill(page, item);
		});
	} finally {
		stage.close();
		await scene.close?.();
	}
}

async function animation(item, url = pageUrl(item), prepare = async () => {}) {
	// A narrated item's lines are synthesized first, so the page can wait for each one.
	const narration = item.narration ? await prepareNarration(item, dir) : undefined;
	const marks = [];
	const videos = mkdtempSync(join(tmpdir(), "media-"));
	const size = { width: item.width, height: item.height };
	const context = await browser.newContext({ viewport: size, recordVideo: { dir: videos, size } });
	const started = Date.now();
	const page = await context.newPage();
	watch(page, item);
	if (narration) {
		// stage.say(id): marks when the line starts and tells the page how long to wait.
		await page.exposeFunction("__stageSay", (id) => {
			const line = narration.lines[id];
			if (!line) throw new Error(`no line "${id}" in ${item.narration}`);
			marks.push({ id, at: (Date.now() - started) / 1000 });
			return Math.round((line.seconds + narration.pause) * 1000);
		});
	}
	await prepare(page);
	await page.goto(url);
	await page.evaluate(() => document.fonts.ready);
	await page.evaluate(() => window.prepare?.());
	await page.waitForTimeout(300);
	const offset = (Date.now() - started) / 1000;
	await page.evaluate(() => window.play());
	await page.waitForTimeout(item.tailMs ?? 500);
	// Closing the context can take seconds while the recording keeps the last frame; the video ends here.
	const ended = (Date.now() - started) / 1000;
	await context.close();
	const [video] = readdirSync(videos).filter((name) => name.endsWith(".webm"));
	const source = join(videos, video);
	const base = join(dir, item.out);
	const trim = ["-ss", offset.toFixed(2), "-t", (ended - offset).toFixed(2)];
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
	if (narration) {
		const level = mixNarration(
			base,
			marks.map(({ id, at }) => ({ id, at: at - offset })),
			narration,
		);
		console.log(`media: ${item.out} narration: ${marks.length} lines, voice ${level.voiceLufs} LUFS, music ${level.musicLufs} LUFS`);
	}
	if (item.gif === false) return void rmSync(videos, { recursive: true, force: true });
	const gif = item.gif ?? { width: 720, fps: 12 };
	// Flat terminal text compresses far better without dithering; animations with gradients keep it.
	const dither = gif.dither === "none" ? "dither=none" : "dither=bayer:bayer_scale=4";
	const filters = `fps=${gif.fps},scale=${gif.width}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=${gif.colors ?? 96}:stats_mode=diff[p];[b][p]paletteuse=${dither}:diff_mode=rectangle`;
	// From the MP4, not the raw capture: Playwright's recording is noisy, and noise defeats GIF compression.
	execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-i", `${base}.mp4`, "-filter_complex", filters, `${base}.gif`]);
	rmSync(videos, { recursive: true, force: true });
}

for (const item of manifest.items) {
	if (only.length > 0 && !only.includes(item.out)) continue;
	const started = Date.now();
	if (item.kind === "png") await still(item);
	else if (item.kind === "animation") await animation(item, pageUrl(item), (page) => exposeStill(page, item));
	else if (item.kind === "terminal") await terminal(item);
	else throw new Error(`unknown media kind ${item.kind}`);
	const outputs =
		item.kind === "png"
			? [item.out]
			: [
					`${item.out}.mp4`,
					...(item.gif === false ? [] : [`${item.out}.gif`]),
					...(item.still ? [`${item.out}.png`] : []),
					...(item.narration ? [`${item.out}.vtt`] : []),
				];
	const sizes = outputs.map((out) => `${out} ${Math.round(statSync(join(dir, out)).size / 1024)} KB`).join(", ");
	console.log(`media: ${sizes} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
}
await browser.close();
