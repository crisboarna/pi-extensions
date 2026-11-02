// Writes the badge documents the READMEs show, from what the coverage run and the manifests say right now.
//
//   node scripts/badges.ts [out]        (default: badges)
//
// Run it after `npm run coverage`, which leaves coverage/lcov.info in each package. A package with no report gets no coverage badge, and the
// root coverage badge is left out too, so a stale or partial number is never shown as the family's.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { allBadges, type PackageFacts } from "./lib/badges.ts";
import { listPackages } from "./lib/repo.ts";

const out = resolve(process.argv[2] ?? "badges");

const facts: PackageFacts[] = listPackages()
	.filter(({ manifest }) => manifest.private !== true)
	.map(({ dir, path, manifest }) => {
		const lcov = join(path, "coverage", "lcov.info");
		const peers = manifest.peerDependencies ?? {};
		return {
			dir,
			nodeRange: manifest.engines?.node,
			piRange: peers["@earendil-works/pi-coding-agent"],
			dependencies: manifest.dependencies,
			lcov: existsSync(lcov) ? readFileSync(lcov, "utf8") : undefined,
		};
	});

const documents = allBadges(facts);
for (const [path, document] of Object.entries(documents)) {
	const file = join(out, path);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `${JSON.stringify(document)}\n`);
}
console.log(`badges: wrote ${Object.keys(documents).length} documents to ${out}`);
if (!("coverage.json" in documents)) console.log("badges: no root coverage badge (a package left no coverage/lcov.info)");
