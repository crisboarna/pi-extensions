// Helpers for tests that read the source tree: file listing, import extraction
// and real-id detection.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

export const ROOT = join(import.meta.dirname, "..", "..");

/** Every file below `dir` whose name ends with `suffix`; an absent directory has none. */
export function files(dir: string, suffix: string): string[] {
	const out: string[] = [];
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return out;
	}
	for (const name of names) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) out.push(...files(path, suffix));
		else if (name.endsWith(suffix)) out.push(path);
	}
	return out;
}

/** Module specifiers named by static imports, re-exports, dynamic imports and require calls. */
export function importSpecifiers(source: string): string[] {
	const specifiers: string[] = [];
	const patterns = [
		/\b(?:import|export)\s[^"'`;]*?\bfrom\s*["']([^"']+)["']/g,
		/\bimport\s*["']([^"']+)["']/g,
		/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
		/\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
	];
	for (const pattern of patterns) for (const match of source.matchAll(pattern)) specifiers.push(match[1] as string);
	return specifiers;
}

/** The real provider and model ids that must never appear in `src/`. */
export function realIds(): string[] {
	const fixture = JSON.parse(readFileSync(join(ROOT, "test", "fixtures", "real-ids.json"), "utf8")) as { providers: string[]; models: string[] };
	return [...fixture.providers, ...fixture.models];
}

/** The ids from `ids` found in `text` as whole tokens, ignoring case. */
export function findIds(text: string, ids: string[]): string[] {
	const lower = text.toLowerCase();
	return ids.filter((id) => new RegExp(`(?<![a-z0-9-])${id.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z0-9-])`).test(lower));
}

/** Specifiers in a core file that reach pi: a host package, or a relative path out of `src/core`. */
export function coreViolations(file: string, source: string): string[] {
	const coreDir = join(ROOT, "src", "core");
	return importSpecifiers(source).filter((specifier) => {
		if (specifier.startsWith("@earendil-works/")) return true;
		if (!specifier.startsWith(".")) return false;
		const target = resolve(dirname(file), specifier);
		return target !== coreDir && !target.startsWith(`${coreDir}${sep}`);
	});
}
