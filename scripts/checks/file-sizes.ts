// A line-count ratchet over package source and tests.
//
// New files must fit a cap (600 lines for source, 1,200 for tests). Files
// already over the cap are listed in scripts/file-size-baseline.json and may
// not grow past their recorded size plus 10% (at least 25 lines). Splitting a
// file and running --update-baseline lowers the entry; every raise is a
// visible baseline diff in the same commit as the growth.
//
//   node scripts/checks/file-sizes.ts                    check
//   node scripts/checks/file-sizes.ts --update-baseline  rewrite the baseline from disk
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ROOT, repoFiles, reporter } from "../lib/repo.ts";

const CAPS = { source: 600, test: 1200 };
const BASELINE = join(ROOT, "scripts", "file-size-baseline.json");
const SOURCE = /^packages\/[^/]+\/.*\.(ts|mts|mjs|js)$/;

const kind = (file: string): "source" | "test" => (/\/test\/|\.test\.(ts|mjs)$/.test(file) ? "test" : "source");
const allowance = (lines: number): number => Math.max(Math.ceil(lines * 0.1), 25);
const lineCount = (file: string): number => readFileSync(join(ROOT, file), "utf8").split("\n").length - 1;

const files = repoFiles().filter((file) => SOURCE.test(file) && !file.includes("/fixtures/") && !file.endsWith(".d.ts"));
const baseline: Record<string, number> = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")) : {};

if (process.argv.includes("--update-baseline")) {
	const next: Record<string, number> = {};
	for (const file of files.sort()) {
		const lines = lineCount(file);
		if (lines > CAPS[kind(file)]) next[file] = lines;
	}
	mkdirSync(dirname(BASELINE), { recursive: true });
	writeFileSync(BASELINE, `${JSON.stringify(next, null, "\t")}\n`);
	console.log(`file-sizes: baseline rewritten with ${Object.keys(next).length} file(s)`);
	process.exit(0);
}

const report = reporter("file-sizes");
for (const file of files) {
	const lines = lineCount(file);
	const recorded = baseline[file];
	if (recorded === undefined) {
		if (lines > CAPS[kind(file)]) report.fail(`${file}: ${lines} lines; new ${kind(file)} files are capped at ${CAPS[kind(file)]}`);
	} else if (lines > recorded + allowance(recorded)) {
		report.fail(`${file}: ${lines} lines; baseline ${recorded} allows up to ${recorded + allowance(recorded)}`);
	}
}
for (const file of Object.keys(baseline)) if (!files.includes(file)) report.fail(`${file}: in the baseline but gone; run --update-baseline`);

report.finish("split the file by responsibility. Raise the baseline (--update-baseline) only on purpose, in the same commit.");
