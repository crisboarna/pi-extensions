// Checks what each package would publish, without publishing.
//
// `npm pack --dry-run` lists the tarball's files. The list must match the
// committed snapshot in scripts/pack-snapshots/<package>.txt, so a new or
// dropped file in a release is a reviewed diff, and it must never contain
// tests, secrets or local state.
//
//   node scripts/checks/pack.ts           check
//   node scripts/checks/pack.ts --update  rewrite the snapshots
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { listPackages, ROOT, reporter } from "../lib/repo.ts";

const SNAPSHOTS = join(ROOT, "scripts", "pack-snapshots");
const DENY = [
	/(^|\/)test\//,
	/\.test\.[cm]?[jt]s$/,
	/(^|\/)\.env/,
	/\.(pem|key|p12)$/,
	/(^|\/)node_modules\//,
	/(^|\/)coverage\//,
	/(^|\/)docs\/plans\//,
	/\.DS_Store$/,
	/\.log$/,
];
const MAX_UNPACKED_BYTES = 2_000_000;

const report = reporter("pack");
const update = process.argv.includes("--update");
mkdirSync(SNAPSHOTS, { recursive: true });

for (const { dir, manifest } of listPackages()) {
	if (manifest.private === true) continue;
	const output = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts", "--workspace", manifest.name], { cwd: ROOT, encoding: "utf8" });
	const [pack] = JSON.parse(output) as Array<{ files: Array<{ path: string }>; unpackedSize: number }>;
	if (!pack) throw new Error(`npm pack returned nothing for ${manifest.name}`);
	const files = pack.files.map((entry) => entry.path).sort();
	for (const file of files) if (DENY.some((pattern) => pattern.test(file))) report.fail(`${manifest.name}: would publish ${file}`);
	if (pack.unpackedSize > MAX_UNPACKED_BYTES) report.fail(`${manifest.name}: ${pack.unpackedSize} bytes unpacked, budget ${MAX_UNPACKED_BYTES}`);
	const snapshot = join(SNAPSHOTS, `${dir}.txt`);
	const text = `${files.join("\n")}\n`;
	if (update) {
		writeFileSync(snapshot, text);
		continue;
	}
	if (!existsSync(snapshot)) {
		report.fail(`${manifest.name}: no snapshot; run node scripts/checks/pack.ts --update and review it`);
		continue;
	}
	const expected = readFileSync(snapshot, "utf8").trim().split("\n");
	for (const file of files) if (!expected.includes(file)) report.fail(`${manifest.name}: new file in the tarball: ${file}`);
	for (const file of expected) if (!files.includes(file)) report.fail(`${manifest.name}: file no longer in the tarball: ${file}`);
}

if (update) console.log("pack: snapshots rewritten; review the diff");
else report.finish("change package.json files (or the source tree), then run node scripts/checks/pack.ts --update and commit the reviewed snapshot.");
