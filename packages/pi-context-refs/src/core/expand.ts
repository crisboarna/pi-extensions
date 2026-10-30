import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { contextBlock, failureNote, namesWithBlock, sanitizeText } from "./context-block.ts";
import type { FileRef, PathRef, Ref } from "./library.ts";
import { foldName } from "./names.ts";
import { findRefTokens } from "./tokens.ts";

/** What an Expansion needs from outside: the session's working directory, the home directory and a way to read a file. */
export interface ExpandEnv {
	cwd: string;
	home: string;
	/** The bytes of a file. It rejects with the system's error, whose `code` says why (`ENOENT`, `EISDIR`, ...). */
	readFile: (path: string) => Promise<Uint8Array>;
}

/** A File or Dynamic Ref whose Expansion could not be produced. */
export interface RefFailure {
	name: string;
	reason: string;
}

/** The message to send, and the Refs that could not be read. Each failed Ref also has a Failure note in `text`. */
export interface Expansion {
	text: string;
	failures: RefFailure[];
}

/**
 * Replaces each ref token that names a Visible Path or Snippet Ref by its Expansion, and adds one Context block per File Ref after the text,
 * in order of first appearance. Tokens that name a File stay in the text. Other tokens stay as typed.
 */
export async function expandRefs(text: string, visible: ReadonlyMap<string, Ref>, env: ExpandEnv): Promise<Expansion> {
	let prose = "";
	let copiedUpTo = 0;
	const files = new Map<string, FileRef>();
	const alreadySent = namesWithBlock(text);
	for (const token of findRefTokens(text)) {
		const ref = visible.get(foldName(token.target));
		if (ref?.kind === "file") {
			const folded = foldName(ref.name);
			if (!alreadySent.has(folded)) files.set(folded, ref);
			continue;
		}
		const expansion = ref ? inlineExpansion(ref, env) : undefined;
		if (expansion === undefined) continue;
		prose += text.slice(copiedUpTo, token.start) + expansion;
		copiedUpTo = token.end;
	}
	prose += text.slice(copiedUpTo);

	const blocks = await Promise.all([...files.values()].map((ref) => fileBlock(ref, env)));
	const failures = blocks.flatMap((block) => ("reason" in block ? [{ name: block.name, reason: block.reason }] : []));
	return { text: [prose, ...blocks.map((block) => block.text)].join("\n\n"), failures };
}

/** The inline text of a Snippet or Path; undefined for the kinds that become Context blocks. */
function inlineExpansion(ref: Ref, env: ExpandEnv): string | undefined {
	if (ref.kind === "snippet") return ref.text;
	if (ref.kind === "path") return pathText(ref, env);
	return undefined;
}

/** The target relative to the working directory when it lies inside it, absolute otherwise. */
function pathText(ref: PathRef | FileRef, env: ExpandEnv): string {
	const absolute = absolutePath(ref, env);
	const inside = relative(env.cwd, absolute);
	if (inside === "") return ".";
	return inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside) ? absolute : inside;
}

function absolutePath(ref: PathRef | FileRef, env: ExpandEnv): string {
	return resolve(env.cwd, expandHome(ref.path, env.home));
}

type FileBlock = { name: string; text: string } | { name: string; text: string; reason: string };

/** The file's current text as a Context block, or a Failure note and the reason. */
async function fileBlock(ref: FileRef, env: ExpandEnv): Promise<FileBlock> {
	const path = pathText(ref, env);
	try {
		const body = sanitizeText(await env.readFile(absolutePath(ref, env)));
		return { name: ref.name, text: contextBlock({ name: ref.name, kind: "file", path, body }) };
	} catch (error) {
		const reason = readFailure(path, error);
		return { name: ref.name, text: failureNote({ name: ref.name, kind: "file", path, error: reason }), reason };
	}
}

function readFailure(path: string, error: unknown): string {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	if (code === "ENOENT") return `${path} does not exist`;
	if (code === "EISDIR") return `${path} is a directory; save it as a Path Ref, or as a Dynamic Ref that runs ["ls", ...]`;
	return `${path} cannot be read (${code ?? (error instanceof Error ? error.message : String(error))})`;
}

function expandHome(path: string, home: string): string {
	if (path === "~") return home;
	return path.startsWith("~/") ? join(home, path.slice(2)) : path;
}
