// Fails on `as unknown as` in published package code (src/ and bin/).
//
// AGENTS.md forbids it: a double cast tells the compiler to stop checking, so a change in pi's types that
// breaks the code compiles anyway. Narrow with a check, or type the value with pi's own type. Biome already
// rejects `any` and non-null assertions; it has no rule for this one. Tests may use it, for fakes of pi.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { listPackages, ROOT, reporter } from "../lib/repo.ts";

const SOURCE = /\.(ts|mts|cts|mjs|js)$/;
const DOUBLE_CAST = /\bas\s+unknown\s+as\b/g;

function walk(dir: string): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir, { recursive: true, encoding: "utf8" })
		.map((file) => join(dir, file))
		.filter((file) => SOURCE.test(file) && !file.includes("/node_modules/"));
}

const report = reporter("casts");
for (const pkg of listPackages()) {
	for (const file of ["src", "bin"].flatMap((folder) => walk(join(pkg.path, folder)))) {
		const text = readFileSync(file, "utf8");
		for (const match of text.matchAll(DOUBLE_CAST)) {
			const line = text.slice(0, match.index).split("\n").length;
			report.fail(`${relative(ROOT, file)}:${line}: \`as unknown as\``);
		}
	}
}
report.finish("type the value with pi's own type, or narrow it with a check; `as unknown as` is allowed only in tests (AGENTS.md, Pi runtime rules)");
