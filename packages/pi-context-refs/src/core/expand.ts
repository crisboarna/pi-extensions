import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { contextBlock, failureNote, namesWithBlock } from "./context-block.ts";
import { type BlockResult, type CommandEnv, type CommandRef, dynamicBlock, isCommandRef } from "./dynamic.ts";
import { fileContent, type ImageContent, type TruncateHead } from "./file-content.ts";
import type { FileRef, PathRef, Ref } from "./library.ts";
import { foldName } from "./names.ts";
import { bundleMembers } from "./resolve.ts";
import { findRefTokens } from "./tokens.ts";
import { isUrlRef, type UrlEnv, type UrlRef, urlBlock } from "./url.ts";

/** What an Expansion needs from outside: the session's working directory, the home directory, a way to read a file, to run a command and to fetch a URL. */
export interface ExpandEnv extends CommandEnv, UrlEnv {
	cwd: string;
	home: string;
	/** The bytes of a file. It rejects with the system's error, whose `code` says why (`ENOENT`, `EISDIR`, ...). */
	readFile: (path: string) => Promise<Uint8Array>;
	/** Pi's `truncateHead`, which cuts a File at the caps of pi's read tool. */
	truncateHead: TruncateHead;
	/** The image type pi supports for the file at this path, or null. */
	imageType: (path: string) => Promise<string | null>;
	/** Cancels the commands and fetches that are running. */
	signal?: AbortSignal;
}

/** A File or Dynamic Ref whose Expansion could not be produced. */
export interface RefFailure {
	name: string;
	reason: string;
}

/** The message to send, the images to attach and the Refs that could not be read. Each failed Ref also has a Failure note in `text`. */
export interface Expansion {
	text: string;
	images: ImageContent[];
	failures: RefFailure[];
}

/**
 * Replaces each ref token that names a Visible Path or Snippet Ref, and each `#tag:<tag>` of a Bundle, by its Expansion, and adds one Context block
 * per File Ref and per Dynamic Ref after the text, in order of first appearance. Commands and fetches run in parallel. Tokens that name a File or a Dynamic Ref
 * stay in the text; a File or Dynamic member of a Bundle is only a block. Other tokens stay as typed.
 */
export async function expandRefs(text: string, visible: ReadonlyMap<string, Ref>, env: ExpandEnv): Promise<Expansion> {
	const tokens = findRefTokens(text);
	// A Bundle leaves out every member the message names itself, and every member an earlier Bundle gave.
	const given = new Set(tokens.filter((token) => token.form !== "bundle").map((token) => foldName(token.target)));
	const alreadySent = namesWithBlock(text);
	const blockRefs = new Map<string, BlockRef>();
	const addBlock = (ref: BlockRef): void => {
		const folded = foldName(ref.name);
		if (!alreadySent.has(folded)) blockRefs.set(folded, ref);
	};
	let prose = "";
	let copiedUpTo = 0;
	for (const token of tokens) {
		let expansion: string | undefined;
		if (token.form === "bundle") {
			expansion = bundleExpansion(token.target, visible, given, addBlock, env);
		} else {
			const ref = visible.get(foldName(token.target));
			const block = ref && blockRefOf(ref);
			if (block) addBlock(block);
			else expansion = ref ? inlineExpansion(ref, env) : undefined;
		}
		if (expansion === undefined) continue;
		// A Bundle with nothing left to add takes the space before it along, so no gap is left in the prose.
		const keep = expansion === "" && /[ \t]$/.test(text.slice(copiedUpTo, token.start)) ? token.start - 1 : token.start;
		prose += text.slice(copiedUpTo, keep) + expansion;
		copiedUpTo = token.end;
	}
	prose += text.slice(copiedUpTo);

	const blocks = await Promise.all(
		[...blockRefs.values()].map((ref) => {
			if (ref.kind === "file") return fileBlock(ref, env);
			return isUrlRef(ref) ? urlBlock(ref, env, env.signal) : dynamicBlock(ref, absolutePath({ path: ref.cwd ?? "." }, env), env, env.signal);
		}),
	);
	const failures = blocks.flatMap((block) => ("reason" in block ? [{ name: block.name, reason: block.reason }] : []));
	const images = blocks.flatMap((block) => (hasImage(block) ? [block.image] : []));
	return { text: [prose, ...blocks.map((block) => block.text)].join("\n\n"), images, failures };
}

/**
 * The inline members of a Bundle not yet given, each as it would be on its own, apart by a space; a File or Dynamic member goes to `addBlock` and adds no text.
 * Undefined when no Visible Ref carries the Tag.
 */
function bundleExpansion(
	tag: string,
	visible: ReadonlyMap<string, Ref>,
	given: Set<string>,
	addBlock: (ref: BlockRef) => void,
	env: ExpandEnv,
): string | undefined {
	const members = bundleMembers(visible, tag);
	if (members.length === 0) return undefined;
	const pieces: string[] = [];
	for (const member of members) {
		const folded = foldName(member.name);
		if (given.has(folded)) continue;
		given.add(folded);
		const block = blockRefOf(member);
		if (block) {
			addBlock(block);
			continue;
		}
		const inline = inlineExpansion(member, env);
		if (inline !== undefined) pieces.push(inline);
	}
	return pieces.join(" ");
}

/** A Ref whose Expansion is a Context block: a File, or a Dynamic Ref with a command or a URL. */
type BlockRef = FileRef | CommandRef | UrlRef;

function blockRefOf(ref: Ref): BlockRef | undefined {
	return ref.kind === "file" || isCommandRef(ref) || isUrlRef(ref) ? ref : undefined;
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

function absolutePath(ref: Pick<PathRef, "path">, env: ExpandEnv): string {
	return resolve(env.cwd, expandHome(ref.path, env.home));
}

type ImageBlock = { name: string; text: string; image: ImageContent };
type FileBlock = BlockResult | ImageBlock;

const hasImage = (block: FileBlock): block is ImageBlock => "image" in block;

/** The file's current text as a Context block (or an empty block and an image to attach), or a Failure note and the reason. */
async function fileBlock(ref: FileRef, env: ExpandEnv): Promise<FileBlock> {
	const path = pathText(ref, env);
	const head = { name: ref.name, kind: "file", path } as const;
	try {
		const absolute = absolutePath(ref, env);
		const bytes = await env.readFile(absolute);
		const content = fileContent({ bytes, path, mimeType: await env.imageType(absolute), maxBytes: ref.max_bytes }, env.truncateHead);
		if ("failure" in content) return failed(head, content.failure);
		if ("image" in content) return { name: ref.name, text: contextBlock({ ...head, body: "" }), image: content.image };
		return { name: ref.name, text: contextBlock({ ...head, body: content.text, truncated: content.truncated }) };
	} catch (error) {
		return failed(head, readFailure(path, error));
	}
}

function failed(head: { name: string; kind: "file"; path: string }, reason: string): FileBlock {
	return { name: head.name, text: failureNote({ ...head, error: reason }), reason };
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
