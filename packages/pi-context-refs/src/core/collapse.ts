import { unescapeAttribute } from "./context-block.ts";

/** A Context block read from the tail of a message. */
export interface TailBlock {
	name: string;
	kind: string;
	/** The declared length of the body in UTF-8 bytes. */
	bytes: number;
	/** True for a Failure note. */
	failed: boolean;
}

/** A message split into its prose and the run of Context blocks at its end. `prose` is everything before the first block, separator included. */
export interface TailParse {
	prose: string;
	blocks: TailBlock[];
}

const OPENING = Buffer.from('<context-ref name="');
const CLOSING = Buffer.from("\n</context-ref>");
const HEAD =
	/^<context-ref name="([^"\p{Cc}]*)" kind="(file|dynamic)"(?: (?:path|source)="[^"]*")? bytes="(\d+)"(?: exit="[^"]*")?(?: truncated="[^"]*")?( error="[^"]*")?>$/u;
const LINE_FEED = 0x0a;
const WHITESPACE = [0x20, 0x09, LINE_FEED, 0x0d];

/**
 * Finds the run of Context blocks this package wrote at the end of `text`. A block's body is as long as its `bytes` says, so a body that contains
 * a closing tag cannot end the block early. Blocks that text other than blocks follows are not a tail and are not returned.
 */
export function parseTailBlocks(text: string): TailParse {
	const bytes = Buffer.from(text);
	for (let at = bytes.indexOf(OPENING); at !== -1; at = bytes.indexOf(OPENING, at + 1)) {
		if (at > 0 && bytes[at - 1] !== LINE_FEED) continue;
		const blocks = readRun(bytes, at);
		if (blocks) return { prose: bytes.subarray(0, at).toString(), blocks };
	}
	return { prose: text, blocks: [] };
}

/** The blocks that run from `from` to the end of `bytes`, or undefined when something else is in the way. */
function readRun(bytes: Buffer, from: number): TailBlock[] | undefined {
	const blocks: TailBlock[] = [];
	let at = from;
	for (;;) {
		const read = readBlock(bytes, at);
		if (!read) return undefined;
		blocks.push(read.block);
		at = read.end;
		while (at < bytes.length && WHITESPACE.includes(bytes[at] ?? 0)) at += 1;
		if (at === bytes.length) return blocks;
		if (bytes[at - 1] !== LINE_FEED) return undefined;
	}
}

function readBlock(bytes: Buffer, at: number): { block: TailBlock; end: number } | undefined {
	if (!bytes.subarray(at, at + OPENING.length).equals(OPENING)) return undefined;
	const headEnd = bytes.indexOf(LINE_FEED, at);
	if (headEnd === -1) return undefined;
	const head = HEAD.exec(bytes.subarray(at, headEnd).toString());
	if (!head) return undefined;
	const bodyEnd = headEnd + 1 + Number(head[3]);
	if (!bytes.subarray(bodyEnd, bodyEnd + CLOSING.length).equals(CLOSING)) return undefined;
	return {
		block: { name: unescapeAttribute(head[1] ?? ""), kind: head[2] ?? "", bytes: Number(head[3]), failed: head[4] !== undefined },
		end: bodyEnd + CLOSING.length,
	};
}

/** A size as people read it: bytes below 1 KB, then KB and MB with one decimal. */
export function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** `text` with each tail Context block as one line: name, kind and size. The prose, with its Placeholders, is returned as it was. */
export function collapseTail(text: string): string {
	const { prose, blocks } = parseTailBlocks(text);
	if (blocks.length === 0) return text;
	return prose + blocks.map((block) => `▸ ref ${block.name} (${block.kind}, ${block.failed ? "failed" : formatSize(block.bytes)})`).join("\n");
}
