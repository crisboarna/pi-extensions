// The "loop" item of tools/media/render.mjs: the checks before ffmpeg runs, the filter graph, and one real render when ffmpeg is installed.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { frameHeight, loopFilters, loopProblem, renderLoop } from "../tools/media/loop.mjs";

const item = { out: "hero-loop", from: ["a", "b"], speed: 4 };

describe("loopProblem", () => {
	/** The problem of `item` with `extra` fields over it; the fields are deliberately wrong, so the type is bypassed. */
	const problem = (extra: object, exists: (path: string) => boolean = () => true): string => String(loopProblem({ ...item, ...extra } as never, exists));

	it("accepts a loop whose clips are rendered", () => {
		assert.equal(
			loopProblem(item, () => true),
			undefined,
		);
	});

	it("names a missing or empty list, a bad speed and a clip that is not rendered yet", () => {
		assert.match(problem({ from: [] }), /"from" must list/u);
		assert.match(problem({ from: undefined }), /"from" must list/u);
		for (const speed of [undefined, 0, -2, Number.NaN, "4"]) assert.match(problem({ speed }), /"speed" must be a number above 0/u, String(speed));
		assert.match(
			problem({}, (path) => path.endsWith("a.mp4")),
			/no MP4 for b/u,
		);
	});
});

describe("loopFilters", () => {
	it("fits every clip into one frame, so clips of different shapes can be joined", () => {
		const graph = loopFilters(item, { width: 720, height: 404, fps: 8, colors: 64 });
		assert.equal(graph.match(/pad=720:404/gu)?.length, 2);
		assert.match(graph, /setpts=PTS\/4/u);
		assert.match(graph, /concat=n=2:v=1:a=0/u);
	});
});

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0 && spawnSync("ffprobe", ["-version"]).status === 0;

describe("renderLoop", { skip: hasFfmpeg ? false : "ffmpeg is not installed" }, () => {
	it("joins clips of different shapes into one GIF", () => {
		const dir = mkdtempSync(join(tmpdir(), "media-loop-"));
		try {
			for (const [name, size] of [
				["a", "320x180"],
				["b", "200x200"],
			] as const)
				execFileSync("ffmpeg", [
					"-loglevel",
					"error",
					"-y",
					"-f",
					"lavfi",
					"-i",
					`testsrc=size=${size}:rate=10:duration=1`,
					"-pix_fmt",
					"yuv420p",
					join(dir, `${name}.mp4`),
				]);
			assert.equal(frameHeight(join(dir, "a.mp4"), 160), 90);
			renderLoop(item, dir);
			assert.ok(existsSync(join(dir, "hero-loop.gif")) && statSync(join(dir, "hero-loop.gif")).size > 0);
			assert.throws(() => renderLoop({ ...item, from: ["a", "missing"] }, dir), /no MP4 for missing/u);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
