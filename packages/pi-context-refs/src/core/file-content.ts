import { sanitizeText } from "./context-block.ts";

/** An image to attach to the message, in the shape pi's `input` event takes. */
export interface ImageContent {
	type: "image";
	data: string;
	mimeType: string;
}

/** What pi's `truncateHead` returns, as far as the Expansion reads it. */
export interface HeadCut {
	content: string;
	truncated: boolean;
	truncatedBy: "lines" | "bytes" | null;
	totalLines: number;
	outputLines: number;
	firstLineExceedsLimit: boolean;
	maxBytes: number;
	maxLines: number;
}

/** Keeps the first lines of a text that fit the caps; pi's read tool uses the same function. Without options it applies pi's default caps. */
export type TruncateHead = (content: string, options?: { maxBytes?: number; maxLines?: number }) => HeadCut;

/** An image larger than this is not attached. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const BINARY_SNIFF_BYTES = 8192;

/** What a File's bytes turn into: text for a Context block (cut at a cap when `truncated` is set), an image to attach, or the reason it cannot be sent. */
export type FileContent = { text: string; truncated?: string } | { image: ImageContent } | { failure: string };

/** What decides a File's content: its bytes and display path, the image type pi recognises for it (if any), and the Ref's own `max_bytes`. */
export interface FileSource {
	bytes: Uint8Array;
	path: string;
	mimeType: string | null;
	maxBytes: number | undefined;
}

/** Decides what a File sends. A `maxBytes` of the Ref replaces the byte cap and lifts the line cap. */
export function fileContent(source: FileSource, truncateHead: TruncateHead): FileContent {
	const { bytes, path, mimeType, maxBytes } = source;
	if (mimeType !== null) {
		if (bytes.length > MAX_IMAGE_BYTES) return { failure: `${path} is an image over 5 MB; resize it and try again` };
		return { image: { type: "image", data: Buffer.from(bytes).toString("base64"), mimeType } };
	}
	if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return { failure: `${path} is a binary file and cannot be sent as text` };
	const cut = truncateHead(sanitizeText(bytes), maxBytes === undefined ? undefined : { maxBytes, maxLines: Number.POSITIVE_INFINITY });
	if (!cut.truncated) return { text: cut.content };
	const cap = cut.truncatedBy === "lines" ? `${cut.maxLines} lines` : capSize(cut.maxBytes);
	return { text: `${cut.content}${cutNote(cut, cap)}`, truncated: cap };
}

/** The closing line of a cut File: how much is shown and where the read tool continues. */
function cutNote(cut: HeadCut, cap: string): string {
	if (cut.firstLineExceedsLimit) return `[Truncated at ${cap}: line 1 is longer than the cap, so nothing is shown. Read it in parts with bash.]`;
	const note = `[Truncated at ${cap}: showing lines 1-${cut.outputLines} of ${cut.totalLines}. Use the read tool with offset=${cut.outputLines + 1} to read the rest.]`;
	return `\n${note}`;
}

function capSize(bytes: number): string {
	if (bytes % (1024 * 1024) === 0) return `${bytes / (1024 * 1024)} MB`;
	return bytes % 1024 === 0 ? `${bytes / 1024} KB` : `${bytes} bytes`;
}
