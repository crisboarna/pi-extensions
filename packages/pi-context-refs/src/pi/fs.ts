import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";

/** The bytes of a file. Any failure rejects with the system's error. */
export const readFileBytes = (path: string): Promise<Uint8Array> => readFile(path);

/** The text of a file, or undefined when it does not exist. Any other failure throws. */
export function readTextIfPresent(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
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
