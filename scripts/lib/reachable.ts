// Which files of a package its entry points load. A package is published from its `files` list, and a module that is loaded lazily, on a
// path no smoke test takes, can be left out of that list and still pass every test that runs from the repository. Following the relative
// imports from the entry points says which files must be in the tarball. Pure apart from reading source files.
import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

const CODE = /\.(?:ts|mts|cts|mjs|js)$/;

/** The module specifiers a source file names: static imports and exports, dynamic imports with a literal, and bare `import "x"`. */
export function specifiers(text: string): string[] {
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

/**
 * The files `entries` (paths relative to `root`) load, themselves included, following relative imports through source files. A file that
 * does not exist is left out (the imports check reports it); an import of a file that is not code, such as JSON, is reached but not read.
 * Paths come back relative to `root`, with `/`, sorted.
 */
export function reachableFiles(root: string, entries: string[]): string[] {
	const seen = new Set<string>();
	const queue = entries.map((entry) => resolve(root, entry));
	for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
		if (seen.has(file) || !existsSync(file)) continue;
		seen.add(file);
		if (!CODE.test(file)) continue;
		for (const specifier of specifiers(readFileSync(file, "utf8"))) if (specifier.startsWith(".")) queue.push(resolve(dirname(file), specifier));
	}
	return [...seen].map((file) => relative(root, file).split("\\").join("/")).sort();
}

/** The files the entry points load that the tarball does not hold: what a user would hit as "cannot find module". */
export function missingFromPack(reachable: string[], packed: string[]): string[] {
	const held = new Set(packed);
	return reachable.filter((file) => !held.has(file));
}
