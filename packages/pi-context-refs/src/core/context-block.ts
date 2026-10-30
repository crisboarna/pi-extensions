import { foldName } from "./names.ts";

/** The attributes every Context block starts with: a File names its path, a Dynamic Ref its source. */
type BlockHead = { name: string; kind: "file"; path: string } | { name: string; kind: "dynamic"; source: string };

/** A Context block that carries content. `exit` is a Dynamic Ref's non-zero exit code. */
export type BlockContent = BlockHead & {
	body: string;
	exit?: number | undefined;
	/** The cap that cut the content, when it was cut. */
	truncated?: string | undefined;
};

/** A Failure note: a Context block with an empty body and the reason in `error`. */
export type FailureContent = BlockHead & {
	error: string;
};

/** The text of a file: a byte order mark at the start is dropped and control characters are stripped, except tab, newline and carriage return. */
export function sanitizeText(bytes: Uint8Array): string {
	// TextDecoder drops a leading byte order mark by default; invalid UTF-8 becomes U+FFFD.
	return new TextDecoder().decode(bytes).replace(/(?![\t\n\r])\p{Cc}/gu, "");
}

/** `<context-ref>` with the body raw between a newline after the opening tag and a newline before the closing tag. `bytes` is the body's length in UTF-8. */
export function contextBlock(block: BlockContent): string {
	const exit = block.exit === undefined ? "" : ` exit="${block.exit}"`;
	const truncated = block.truncated === undefined ? "" : ` truncated="${attributeValue(block.truncated)}"`;
	return element(block, Buffer.byteLength(block.body, "utf8"), exit + truncated, block.body);
}

/** A Context block with an empty body that says why the Expansion could not be produced. */
export function failureNote(note: FailureContent): string {
	return element(note, 0, ` error="${attributeValue(note.error)}"`, "");
}

function element(head: BlockHead, bytes: number, tail: string, body: string): string {
	const origin = head.kind === "file" ? `path="${attributeValue(head.path)}"` : `source="${attributeValue(head.source)}"`;
	const attributes = `name="${attributeValue(head.name)}" kind="${head.kind}" ${origin} bytes="${bytes}"${tail}`;
	return `<context-ref ${attributes}>\n${body}\n</context-ref>`;
}

function attributeValue(value: string): string {
	return value
		.replace(/\p{Cc}/gu, " ")
		.replace(/&/g, "&amp;")
		.replace(/"/g, "&quot;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

/** The case-folded names of the Context blocks that already open a line of `text`, so a resent message does not get them twice. */
export function namesWithBlock(text: string): Set<string> {
	const names = new Set<string>();
	for (const match of text.matchAll(/^<context-ref name="([^"]*)"/gm)) names.add(foldName(match[1] ?? ""));
	return names;
}
