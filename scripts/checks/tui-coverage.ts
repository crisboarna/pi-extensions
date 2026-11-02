// Checks that every place a package takes keys or draws interactive UI has a keystroke test in real pi.
//
// A source file that calls `ui.custom`, a dialog (`ui.select`, `ui.confirm`, `ui.input` or `ui.editor`), `setEditorComponent`,
// `registerShortcut`, `addAutocompleteProvider` or `onTerminalInput` handles input, or draws rows, that unit tests with
// fakes cannot prove works in pi's TUI (a dialog can lose its question off a small screen). Each such file must be named
// in a `// covers:` header of a test under `test/tui/` (the suites that run real interactive pi on a virtual terminal),
// and each name in a header must be a source file that exists, so the headers cannot rot into claims about nothing.
//
//   // covers: src/pi/overlay.ts, src/pi/running.ts
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { listPackages, reporter } from "../lib/repo.ts";

const INTERACTIVE = /\b(?:ui\.(?:custom|select|confirm|input|editor)|setEditorComponent|registerShortcut|addAutocompleteProvider|onTerminalInput)\b/;
const COVERS = /^\/\/ covers:\s*(.+)$/gm;

function files(dir: string, suffix: string): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return files(path, suffix);
		return entry.name.endsWith(suffix) ? [path] : [];
	});
}

const report = reporter("tui-coverage");
for (const pkg of listPackages()) {
	const required = files(join(pkg.path, "src"), ".ts")
		.filter((file) => INTERACTIVE.test(readFileSync(file, "utf8")))
		.map((file) => file.slice(pkg.path.length + 1));
	const covered = new Map<string, string>();
	for (const test of files(join(pkg.path, "test", "tui"), ".test.ts")) {
		const name = test.slice(pkg.path.length + 1);
		for (const match of readFileSync(test, "utf8").matchAll(COVERS)) {
			for (const target of (match[1] ?? "").split(",").map((part) => part.trim())) {
				if (target) covered.set(target, name);
			}
		}
	}
	for (const file of required) {
		if (!covered.has(file)) report.fail(`${pkg.dir}: ${file} takes keys or draws UI, but no test/tui test names it in a "// covers:" header`);
	}
	for (const [target, test] of covered) {
		if (!existsSync(join(pkg.path, target))) report.fail(`${pkg.dir}: ${test} says it covers ${target}, which does not exist`);
	}
}
report.finish(
	"add a test under test/tui that presses keys in real pi (see packages/pi-account-guard/test/tui), and name the source file in its `// covers:` header; if a file only matched the pattern and takes no keys, reword the call so it does not, never add a header without a test",
);
