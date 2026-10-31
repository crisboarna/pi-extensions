// Checks that files deliberately copied between packages are still the same file.
//
// Packages cannot import each other (docs: AGENTS.md, Package boundaries), so a helper that every package's
// tests need exists once per package. A copy that is fixed or extended in one package and not the others is
// a bug that no test sees: the other packages keep running the old behaviour. Add a path to COPIES only for a
// file that is meant to stay byte for byte identical; files that differ per package on purpose do not belong here.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { listPackages, reporter } from "../lib/repo.ts";

/** Package-relative paths. Every package that has the file must hold the same bytes as the others. */
const COPIES = ["test/support/virtual-terminal.ts"];

const report = reporter("copies");
const packages = listPackages();
for (const file of COPIES) {
	const holders = packages
		.filter((pkg) => existsSync(join(pkg.path, file)))
		.map((pkg) => ({
			dir: pkg.dir,
			hash: createHash("sha256")
				.update(readFileSync(join(pkg.path, file)))
				.digest("hex"),
		}));
	const [first, ...rest] = holders;
	if (!first) continue;
	const differing = rest.filter((holder) => holder.hash !== first.hash);
	if (differing.length === 0) continue;
	const same = holders.filter((holder) => holder.hash === first.hash).map((holder) => holder.dir);
	report.fail(`${file}: the copy in ${differing.map((holder) => holder.dir).join(", ")} is not the copy in ${same.join(", ")}`);
}
report.finish(
	"copy the intended version over the others (`cp packages/<good>/<file> packages/<other>/<file>`), or, if the file is meant to differ per package, remove it from COPIES in scripts/checks/copies.ts",
);
