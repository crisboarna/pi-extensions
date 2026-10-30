import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseTailBlocks } from "./collapse.ts";

/** How a file was used: read, or edited (an `edit` or a `write`). */
export type Use = "read" | "edit";

/** One file the session used: its absolute path, its latest use and when that was (milliseconds since the epoch). */
export interface UsedFile {
	path: string;
	use: Use;
	at: number;
}

/** What turns a path as typed or as a tool got it into an absolute one, and tells pi's temporary files apart. */
export interface PathEnv {
	cwd: string;
	home: string;
	tmpdir: string;
}

/** At most this many files are kept; the oldest go first. */
export const MAX_RECENT = 200;

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

const USE_OF_TOOL: ReadonlyMap<string, Use> = new Map([
	["read", "read"],
	["edit", "edit"],
	["write", "edit"],
]);

/** Whether `path` is `root` or lies under it. */
function isInside(path: string, root: string): boolean {
	const inside = relative(root, path);
	return inside === "" || (inside !== ".." && !inside.startsWith(`..${sep}`) && !isAbsolute(inside));
}

/** The absolute path a tool or a message means by `raw`, the way pi resolves it: unicode spaces, a leading `@`, `~`, `file://`, then the working directory. */
export function resolveUsedPath(raw: string, env: Pick<PathEnv, "cwd" | "home">): string | undefined {
	let text = raw.replace(UNICODE_SPACES, " ");
	if (text.startsWith("@")) text = text.slice(1);
	if (text.trim() === "") return undefined;
	if (text === "~") text = env.home;
	else if (text.startsWith("~/")) text = join(env.home, text.slice(2));
	if (text.startsWith("file://")) {
		try {
			text = fileURLToPath(text);
		} catch {
			return undefined;
		}
	}
	return resolve(env.cwd, text);
}

/** A Placeholder ends at `]` and holds one line, and a quoted path has no `"` inside; a path with such a character cannot be carried. */
const CARRIABLE = /^[^\]"\p{Cc}]+$/u;

/** Pi writes its pasted images, bash overflow and similar files to `pi-…` entries of the temporary directory; they are not the user's files. */
function isPiTempFile(path: string, env: PathEnv): boolean {
	if (isInside(path, env.cwd) || !isInside(path, env.tmpdir)) return false;
	return relative(env.tmpdir, path)
		.split(sep)
		.some((part) => part.startsWith("pi-"));
}

/** The file a successful `read`, `edit` or `write` call used, or undefined for any other call, a path outside the working directory, or one a Placeholder cannot carry. */
export function toolUse(toolName: string, input: unknown, env: PathEnv): { path: string; use: Use } | undefined {
	const use = USE_OF_TOOL.get(toolName);
	const raw = typeof input === "object" && input !== null ? (input as { path?: unknown }).path : undefined;
	if (use === undefined || typeof raw !== "string") return undefined;
	const path = resolveUsedPath(raw, env);
	if (path === undefined || path === resolve(env.cwd) || !isInside(path, env.cwd) || !CARRIABLE.test(path)) return undefined;
	return { path, use };
}

// `@path` or `@"path with spaces"`, after the start of the text or a space or an opening bracket; and the `<file name="...">` line pi writes for a file given on the command line.
const AT_PATH = /(?<![^\s([{])@(?:"([^"\n]+)"|([^\s"'<>]+))/gu;
const FILE_TAG = /^<file name="([^"\n]+)">/gm;
const TRAILING_PUNCTUATION = /[.,;:!?)\]}]+$/;

/** The files a sent message points at with `@path` or a command-line `<file name>`, wherever they are, each once, in order. Pi's temporary files are left out, and so is the text of the Context blocks at the end of the message. */
export function messagePaths(sent: string, env: PathEnv): string[] {
	const text = parseTailBlocks(sent).prose;
	const raw: Array<{ at: number; path: string }> = [];
	for (const match of text.matchAll(AT_PATH)) raw.push({ at: match.index, path: match[1] ?? (match[2] ?? "").replace(TRAILING_PUNCTUATION, "") });
	for (const match of text.matchAll(FILE_TAG)) raw.push({ at: match.index, path: match[1] ?? "" });
	const paths = raw
		.sort((a, b) => a.at - b.at)
		.map(({ path }) => resolveUsedPath(path, env))
		.filter((path): path is string => path !== undefined && CARRIABLE.test(path) && !isPiTempFile(path, env));
	return [...new Set(paths)];
}

/** The session's files, kept in memory only. */
export interface UsedFiles {
	/** Notes a use. A use older than one already noted does not move the file back in time. */
	record(path: string, use: Use, at: number): void;
	/** Forgets everything, then notes `uses`; calling it twice with the same uses gives the same files. */
	rebuild(uses: Iterable<{ path: string; use: Use; at: number }>): void;
	/** The files, newest use first. */
	files(): UsedFile[];
	has(path: string): boolean;
}

interface Times {
	read?: number;
	edit?: number;
	/** Arrival order, so equal times put the later use first. */
	order: number;
}

export function createUsedFiles(): UsedFiles {
	const times = new Map<string, Times>();
	let arrivals = 0;
	const latest = (entry: Times): UsedFile["use"] => ((entry.edit ?? Number.NEGATIVE_INFINITY) >= (entry.read ?? Number.NEGATIVE_INFINITY) ? "edit" : "read");
	const file = (path: string, entry: Times): UsedFile => {
		const use = latest(entry);
		return { path, use, at: entry[use] ?? 0 };
	};
	const newestFirst = (a: [string, Times], b: [string, Times]): number => file(...b).at - file(...a).at || b[1].order - a[1].order;

	const used: UsedFiles = {
		record(path, use, at) {
			if (!Number.isFinite(at)) return;
			const entry = times.get(path) ?? { order: 0 };
			entry[use] = Math.max(entry[use] ?? Number.NEGATIVE_INFINITY, at);
			entry.order = ++arrivals;
			times.set(path, entry);
			if (times.size > MAX_RECENT) {
				const oldest = [...times].sort(newestFirst).at(-1);
				if (oldest) times.delete(oldest[0]);
			}
		},
		rebuild(uses) {
			times.clear();
			for (const { path, use, at } of uses) used.record(path, use, at);
		},
		files: () => [...times].sort(newestFirst).map(([path, entry]) => file(path, entry)),
		has: (path) => times.has(path),
	};
	return used;
}

/**
 * Whether a `[ref:file:<path>]` Placeholder may read `path`: the session used it, it lies inside the working directory, and it still does after
 * following symlinks. A used file that is gone passes, since nothing can be read through it and the read then fails with a Failure note.
 */
export function isUsedProjectFile(path: string, cwd: string, used: Pick<UsedFiles, "has">, realpath: (path: string) => string | undefined): boolean {
	if (!used.has(path) || !isInside(path, cwd)) return false;
	const real = realpath(path);
	return real === undefined || isInside(real, realpath(cwd) ?? cwd);
}

/** The path as a row shows it: relative to the working directory inside it, `~/…` under home, absolute otherwise. */
export function rowPath(path: string, env: Pick<PathEnv, "cwd" | "home">): string {
	if (isInside(path, env.cwd)) return relative(env.cwd, path);
	return isInside(path, env.home) ? `~/${relative(env.home, path)}` : path;
}

/** The path as a Placeholder carries it: a root file gets `./` so that it always holds a `/`, and a path with spaces is quoted. */
export function placeholderTarget(path: string, env: Pick<PathEnv, "cwd" | "home">): string {
	const shown = rowPath(path, env);
	const written = shown.includes("/") ? shown : `./${shown}`;
	return /\s/u.test(written) ? `"${written}"` : written;
}

/** What a Placeholder target means when it is not a saved Ref's name: a path to print, or `file:<path>` for a file to send. Saved names never hold `/` or `:`. */
export function parseRecentTarget(target: string): { form: "path" | "file"; path: string } | undefined {
	const unquote = (text: string): string => (text.length >= 2 && text.startsWith('"') && text.endsWith('"') ? text.slice(1, -1) : text);
	if (target.startsWith("file:")) {
		const path = unquote(target.slice("file:".length));
		return path === "" ? undefined : { form: "file", path };
	}
	return target.includes("/") ? { form: "path", path: unquote(target) } : undefined;
}

/** The files, in the order given, whose shown path (or the path as a Placeholder writes it) contains `query`, ignoring case. A bare query keeps all of them. */
export function matchRecent(files: readonly UsedFile[], query: string, env: Pick<PathEnv, "cwd" | "home">): UsedFile[] {
	const wanted = query.toLowerCase();
	if (wanted === "") return [...files];
	return files.filter(({ path }) => {
		const shown = rowPath(path, env).toLowerCase();
		return shown.includes(wanted) || (!shown.includes("/") && `./${shown}`.includes(wanted));
	});
}

const MINUTE = 60_000;

/** "edited 5 min ago" or "read 2 h ago": the latest use and how long before `now` it was. */
export function ageNote(file: UsedFile, now: number): string {
	const ago = Math.max(0, now - file.at);
	const verb = file.use === "edit" ? "edited" : "read";
	if (ago < MINUTE) return `${verb} just now`;
	if (ago < 60 * MINUTE) return `${verb} ${Math.floor(ago / MINUTE)} min ago`;
	if (ago < 24 * 60 * MINUTE) return `${verb} ${Math.floor(ago / (60 * MINUTE))} h ago`;
	return `${verb} ${Math.floor(ago / (24 * 60 * MINUTE))} d ago`;
}
