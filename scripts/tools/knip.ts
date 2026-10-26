// Dead-code analysis with knip, run from the image built from
// tools/docker/knip.Dockerfile: unused files, exports, types and
// dependencies, and unlisted ones. Configuration: knip.json.
//
//   node scripts/tools/knip.ts [knip options]
//
// knip's cache lives in .cache/knip so repeated runs (and CI, which caches
// .cache/) only re-analyse changed files.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { runTool } from "../lib/docker.ts";
import { ROOT } from "../lib/repo.ts";

const cache = join(ROOT, ".cache", "knip");
mkdirSync(cache, { recursive: true });
const status = runTool({ name: "knip", dockerfile: "knip.Dockerfile" }, ["--no-progress", "--cache", "--cache-location", "/cache", ...process.argv.slice(2)], {
	mounts: [`${cache}:/cache`],
});
if (status !== 0) console.error("\nknip: delete what is unused, or wire it up; ignore entries in knip.json need a reason in the commit.");
process.exitCode = status;
