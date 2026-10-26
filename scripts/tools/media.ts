// Renders a package's README and gallery media in the media image: PNG
// stills and MP4 and GIF animations from the HTML pages under its media/src,
// as listed in its media/manifest.json.
//
//   node scripts/tools/media.ts packages/<name>/media [output ...]
import { existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { runTool } from "../lib/docker.ts";
import { ROOT } from "../lib/repo.ts";

const [target, ...only] = process.argv.slice(2);
const dir = target ? resolve(ROOT, target) : undefined;
if (!dir || !existsSync(join(dir, "manifest.json"))) {
	console.error("Usage: node scripts/tools/media.ts packages/<name>/media [output ...]  (the folder needs a manifest.json)");
	process.exit(1);
}
// The media folder is mounted writable at its own path inside the read-only repository mount, so pages
// reach the shared tools (/repo/tools/brand, /repo/tools/media) and scenes import them by relative path.
const mediaPath = `/repo/${relative(ROOT, dir)}`;
process.env.MEDIA_PACKAGE = `/repo/${relative(ROOT, dirname(dir))}`;
process.exitCode = runTool({ name: "media", dockerfile: "media.Dockerfile" }, ["node", "/repo/tools/media/render.mjs", mediaPath, ...only], {
	mounts: [`${dir}:${mediaPath}`],
	env: ["MEDIA_PACKAGE", "MEDIA_KEEP"],
	asHostUser: true,
});
