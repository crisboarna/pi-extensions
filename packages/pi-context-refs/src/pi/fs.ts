import { mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
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

/** The real path of an existing path, following symlinks, or undefined when it cannot be resolved. */
export function realpathIfPresent(path: string): string | undefined {
	try {
		return realpathSync(path);
	} catch {
		return undefined;
	}
}

/** Where the symlink at `path` points, as written, or undefined when the path is not a symlink. A link that points at nothing still answers. */
export function linkTargetIfSymlink(path: string): string | undefined {
	try {
		return readlinkSync(path);
	} catch {
		return undefined;
	}
}

/** Whether the path is a regular file, following symlinks; false for a missing file, a directory or anything that cannot be examined. */
export function isFilePresent(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}
