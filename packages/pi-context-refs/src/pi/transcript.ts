import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { collapseTail } from "../core/collapse.ts";

/** Shows each Context block of a sent message as one line in the live transcript. The stored message and the model keep the full text. */
export function registerTranscript(pi: ExtensionAPI): void {
	pi.registerMarkdownTransformer((markdown, context) => (context.messageType === "user" ? collapseTail(markdown) : markdown));
}
