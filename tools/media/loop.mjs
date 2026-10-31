// The "loop" media item: MP4s of other items joined into one silent GIF (see render.mjs).
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * @typedef {object} LoopItem
 * @property {string} out
 * @property {string[]} from The items whose MP4s are joined, in order.
 * @property {number} speed
 * @property {{ width?: number, fps?: number, colors?: number }} [gif]
 */

/**
 * Why a loop item cannot be rendered, or undefined. `exists` says whether a rendered MP4 is there.
 * @param {Partial<LoopItem> & { out: string }} item
 * @param {(path: string) => boolean} [exists]
 * @param {string} [dir]
 * @returns {string | undefined}
 */
export function loopProblem(item, exists = existsSync, dir = "") {
	if (!Array.isArray(item.from) || item.from.length === 0) return `loop ${item.out}: "from" must list the items to join`;
	if (typeof item.speed !== "number" || !Number.isFinite(item.speed) || item.speed <= 0)
		return `loop ${item.out}: "speed" must be a number above 0, not ${JSON.stringify(item.speed)}`;
	const missing = item.from.filter((name) => !exists(join(dir, `${name}.mp4`)));
	return missing.length > 0 ? `loop ${item.out}: no MP4 for ${missing.join(", ")}; list the loop after the items it joins, and render them first` : undefined;
}

/**
 * The ffmpeg filter graph that speeds each clip up, fits it into one `width` by `height` frame and joins them into a GIF with one palette.
 * @param {LoopItem} item
 * @param {{ width: number, height: number, fps: number, colors: number }} frame
 * @returns {string}
 */
export function loopFilters(item, { width, height, fps, colors }) {
	const fit = `scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1`;
	const scaled = item.from.map((_, i) => `[${i}:v]setpts=PTS/${item.speed},fps=${fps},${fit}[v${i}];`).join("");
	const joined = item.from.map((_, i) => `[v${i}]`).join("");
	return `${scaled}${joined}concat=n=${item.from.length}:v=1:a=0,split[a][b];[a]palettegen=max_colors=${colors}:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`;
}

/**
 * The frame height, even, that keeps the first clip's shape at `width`.
 * @param {string} mp4
 * @param {number} width
 * @returns {number}
 */
export function frameHeight(mp4, width) {
	const [w, h] = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", mp4], {
		encoding: "utf8",
	})
		.trim()
		.split(",")
		.map(Number);
	if (!w || !h) throw new Error(`could not read the size of ${mp4}`);
	return 2 * Math.round((width * h) / w / 2);
}

/**
 * Renders the loop item into `<dir>/<out>.gif`.
 * @param {LoopItem} item
 * @param {string} dir
 * @returns {void}
 */
export function renderLoop(item, dir) {
	const problem = loopProblem(item, existsSync, dir);
	if (problem !== undefined) throw new Error(problem);
	const { width = 720, fps = 8, colors = 64 } = item.gif ?? {};
	const inputs = item.from.flatMap((name) => ["-i", join(dir, `${name}.mp4`)]);
	const height = frameHeight(join(dir, `${item.from[0]}.mp4`), width);
	const filters = loopFilters(item, { width, height, fps, colors });
	execFileSync("ffmpeg", ["-loglevel", "error", "-y", ...inputs, "-filter_complex", filters, "-loop", "0", join(dir, `${item.out}.gif`)]);
}
