// Writes each package's benchmark page and charts from the recorded runs.
//
//   node scripts/charts.ts           write packages/<name>/docs/benchmarks.md and packages/<name>/docs/benchmarks/*.svg
//   node scripts/charts.ts --check   fail if any of them differs from what the data gives
//
// The data is benchmarks/<package>/<name>/results.json, written by `node scripts/bench.ts --write benchmarks`. Nothing here is edited by hand.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { type BenchResult, benchmarkFiles } from "./lib/benchmark-pages.ts";
import { ROOT } from "./lib/repo.ts";

/** Every recorded result, in a fixed order. */
export function readResults(root = ROOT): BenchResult[] {
	const base = join(root, "benchmarks");
	if (!existsSync(base)) return [];
	return readdirSync(base, { recursive: true, encoding: "utf8" })
		.map((file) => file.split("\\").join("/"))
		.filter((file) => file.endsWith("/results.json"))
		.sort()
		.map((file) => JSON.parse(readFileSync(join(base, file), "utf8")) as BenchResult);
}

/** The files that differ from what the data gives, by path. */
export function staleFiles(root = ROOT): string[] {
	return Object.entries(benchmarkFiles(readResults(root)))
		.filter(([path, content]) => !existsSync(join(root, path)) || readFileSync(join(root, path), "utf8") !== content)
		.map(([path]) => path);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const files = benchmarkFiles(readResults());
	if (Object.keys(files).length === 0) throw new Error("no results to draw: run `node scripts/bench.ts --write benchmarks` first");
	if (process.argv.includes("--check")) {
		const stale = staleFiles();
		for (const path of stale) console.error(`charts: ${path} differs from the data; run npm run charts`);
		process.exitCode = stale.length > 0 ? 1 : 0;
	} else {
		for (const [path, content] of Object.entries(files)) {
			mkdirSync(dirname(join(ROOT, path)), { recursive: true });
			writeFileSync(join(ROOT, path), content);
		}
		console.log(`charts: wrote ${Object.keys(files).length} files`);
	}
}
