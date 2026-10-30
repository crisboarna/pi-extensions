import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";

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
