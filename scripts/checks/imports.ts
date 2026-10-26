// Checks every import in the packages against the package boundaries.
//
// - A relative import must stay inside its own package and name an existing
//   file with its extension (pi loads TypeScript through jiti, Node strips
//   types; neither guesses extensions).
// - A Node built-in must use the `node:` prefix.
// - A bare import in published code must be declared in that package's
//   dependencies or peerDependencies; one package never reaches into another
//   by path. Tests may also use the root devDependencies.
// - typebox is only aliased by pi for `typebox`, `typebox/value` and
//   `typebox/compile`; any other subpath loads a second copy.
// - Deep imports into pi's packages are listed in ALLOWED_HOST_SUBPATHS after
//   checking that they load under pi, because pi does not alias every subpath.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, resolve } from "node:path";
import { HOST_PROVIDED, listPackages, type Manifest, ROOT, readJson, reporter } from "../lib/repo.ts";

const TYPEBOX_ALIASED = new Set(["typebox", "typebox/value", "typebox/compile", "@sinclair/typebox", "@sinclair/typebox/value", "@sinclair/typebox/compile"]);
const ALLOWED_HOST_SUBPATHS = new Set([
	// Used by pi-switchboard's hosted-classifier adapter; loads under pi 1.4 (verified live on the main session).
	"@earendil-works/pi-ai/api/typesafe-system-one",
]);
const SOURCE = /\.(ts|mts|cts|mjs|js)$/;
const BUILTINS = new Set(builtinModules.filter((name) => !name.startsWith("_")));

const report = reporter("imports");
const rootDev = new Set(Object.keys(readJson<Manifest>(join(ROOT, "package.json")).devDependencies ?? {}));

function specifiers(text: string): string[] {
	const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
	const found: string[] = [];
	const patterns = [
		/\bfrom\s*["']([^"']+)["']/g,
		/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
		/^\s*import\s*["']([^"']+)["']/gm,
		/\bimport\(\s*"([^"]+)"\s*\)\./g,
	];
	for (const pattern of patterns) for (const match of code.matchAll(pattern)) if (match[1]) found.push(match[1]);
	return [...new Set(found)];
}

function packageName(specifier: string): string {
	const parts = specifier.split("/");
	return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? specifier);
}

function walk(dir: string): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir, { recursive: true, encoding: "utf8" })
		.map((file) => join(dir, file))
		.filter((file) => SOURCE.test(file) && !file.includes("/node_modules/") && !file.includes("/fixtures/"));
}

for (const pkg of listPackages()) {
	const declared = new Set([...Object.keys(pkg.manifest.dependencies ?? {}), ...Object.keys(pkg.manifest.peerDependencies ?? {})]);
	const published = ["src", "bin"].flatMap((folder) => walk(join(pkg.path, folder)));
	const tests = ["test", "scripts"].flatMap((folder) => walk(join(pkg.path, folder)));
	for (const file of [...published, ...tests]) {
		const isTest = !published.includes(file);
		const at = file.slice(ROOT.length);
		for (const specifier of specifiers(readFileSync(file, "utf8"))) {
			if (specifier.startsWith(".")) {
				const target = resolve(dirname(file), specifier);
				if (!target.startsWith(`${pkg.path}/`)) report.fail(`${at}: "${specifier}" leaves packages/${pkg.dir}; import another package by its name`);
				else if (!existsSync(target)) report.fail(`${at}: "${specifier}" does not exist (relative imports need the file extension)`);
				else if (!isTest && !target.startsWith(join(pkg.path, "src")) && !target.startsWith(join(pkg.path, "bin")) && !target.endsWith(".json"))
					report.fail(`${at}: published code imports "${specifier}", which is outside src/ and bin/`);
				continue;
			}
			if (specifier.startsWith("node:")) continue;
			if (BUILTINS.has(packageName(specifier))) {
				report.fail(`${at}: use "node:${specifier}" for the Node built-in`);
				continue;
			}
			const name = packageName(specifier);
			if (name === pkg.manifest.name) continue;
			if ((name === "typebox" || name === "@sinclair/typebox") && !TYPEBOX_ALIASED.has(specifier))
				report.fail(`${at}: "${specifier}" is not aliased by pi; use typebox, typebox/value or typebox/compile`);
			if (HOST_PROVIDED.includes(name) && specifier !== name && !TYPEBOX_ALIASED.has(specifier) && !ALLOWED_HOST_SUBPATHS.has(specifier))
				report.fail(`${at}: deep import "${specifier}" into a pi package; verify it loads under pi, then add it to ALLOWED_HOST_SUBPATHS`);
			if (declared.has(name)) continue;
			if (isTest && rootDev.has(name)) continue;
			report.fail(`${at}: "${name}" is not declared in packages/${pkg.dir}/package.json${isTest ? " or the root devDependencies" : ""}`);
		}
	}
}

report.finish('fix the import named above, or declare the package it needs (host-provided pi packages go in peerDependencies as "*").');
