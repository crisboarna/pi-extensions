import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

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

/** Writes the file through a temporary file in the same directory and a rename, so a reader never sees half a file. Creates missing directories. */
export function writeTextAtomically(path: string, text: string): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.tmp`;
	try {
		writeFileSync(temporary, text, "utf8");
		renameSync(temporary, path);
	} catch (error) {
		rmSync(temporary, { force: true });
		throw error;
	}
}
