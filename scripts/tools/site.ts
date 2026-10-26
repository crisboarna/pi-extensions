// Builds the family site into site/dist and, with --verify, opens every page
// in Chromium inside the media image (tools/site/verify.mjs); with --measure,
// times the live try-it pages in Chromium, Firefox and WebKit, with network
// (tools/site/measure.mjs). The live pages need their snapshots first:
// node tools/site/snapshot.ts.
//
//   node scripts/tools/site.ts [--verify] [--measure]
import { join } from "node:path";
import { buildSite } from "../../tools/site/build.ts";
import { runTool } from "../lib/docker.ts";
import { ROOT } from "../lib/repo.ts";

const out = join(ROOT, "site", "dist");
const problems = buildSite(out);
for (const problem of problems) console.error(`  - ${problem}`);
if (problems.length > 0) {
	console.error(`site: ${problems.length} broken link(s)`);
	process.exit(1);
}
console.log("site: built site/dist");
if (process.argv.includes("--verify")) {
	process.exitCode = runTool({ name: "media", dockerfile: "media.Dockerfile" }, ["node", "/repo/tools/site/verify.mjs", "/repo/site/dist"], {
		mounts: [`${join(ROOT, "site")}:/repo/site`],
		asHostUser: true,
	});
}
if (process.argv.includes("--measure") && !process.exitCode) {
	process.exitCode = runTool({ name: "media", dockerfile: "media.Dockerfile" }, ["node", "/repo/tools/site/measure.mjs", "/repo/site/dist"], {
		mounts: [`${join(ROOT, "site")}:/repo/site`],
		asHostUser: true,
		network: true,
	});
}
