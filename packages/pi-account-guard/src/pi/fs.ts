import { readFileSync, realpathSync } from "node:fs";

function isAbsent(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException).code;
	return code === "ENOENT" || code === "ENOTDIR";
}

/** The file text, or `undefined` when the file does not exist; any other failure throws. */
export function readTextIfPresent(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch (error) {
		if (isAbsent(error)) return undefined;
		throw error;
	}
}

/** The native real path, or `undefined` when the path does not exist; any other failure throws. */
export function realpathIfPresent(path: string): string | undefined {
	try {
		return realpathSync.native(path);
	} catch (error) {
		if (isAbsent(error)) return undefined;
		throw error;
	}
}
