// Checks that every README keeps the promises of docs/conventions/readme.md that a script can check: at most 8 badges on a line, none with a
// value typed into its address, and the Node and pi versions stated in the convention's words and matching what the manifests declare and
// CI tests. Package READMEs get all of it; the root README, which names no single package, gets the badge rules.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseRange } from "../lib/pi-versions.ts";
import { badgeProblems, majorMinor, versionProblems } from "../lib/readme-rules.ts";
import { listPackages, PI_PEER_RANGE, ROOT, reporter } from "../lib/repo.ts";

const report = reporter("readme");
const range = parseRange(PI_PEER_RANGE);

const rootReadme = join(ROOT, "README.md");
try {
	for (const problem of badgeProblems(readFileSync(rootReadme, "utf8"))) report.fail(`README.md: ${problem}`);
} catch {
	report.fail("README.md is missing");
}

for (const { dir, path, manifest } of listPackages()) {
	if (manifest.private === true) continue;
	const at = `packages/${dir}/README.md`;
	let readme: string;
	try {
		readme = readFileSync(join(path, "README.md"), "utf8");
	} catch {
		report.fail(`${at} is missing`);
		continue;
	}
	for (const problem of badgeProblems(readme)) report.fail(`${at}: ${problem}`);
	const node = /^>=(\d+\.\d+\.\d+)$/.exec(manifest.engines?.node ?? "")?.[1];
	if (!node) {
		report.fail(`${at}: engines.node must be ">=x.y.z" (manifests.ts reports this too)`);
		continue;
	}
	for (const problem of versionProblems(readme, { node: majorMinor(node), piMin: majorMinor(range.min), piBelow: majorMinor(range.below) }))
		report.fail(`${at}: ${problem}`);
}

report.finish(
	"see docs/conventions/readme.md: badges are one line of at most 8 with values read from a registry, CI or the repository; the versions come from the manifests.",
);
