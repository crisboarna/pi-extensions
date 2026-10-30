import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { showReadOnlyText } from "./text-viewer.ts";

/** The text of the last user message on the session branch, with everything the Expansion added. Undefined when no message was sent. */
export function lastSentText(ctx: ExtensionContext): string | undefined {
	for (const entry of ctx.sessionManager.getBranch().reverse()) {
		if (entry.type !== "message" || entry.message.role !== "user") continue;
		const { content } = entry.message;
		if (typeof content === "string") return content;
		return content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
	}
	return undefined;
}

/** `/ref sent`: a read-only dialog in the TUI, and `say` (notify text for RPC, stderr for print and JSON) everywhere else. */
export async function showSent(ctx: ExtensionContext, say: (text: string) => void): Promise<void> {
	const text = lastSentText(ctx);
	if (text === undefined) return say("No message has been sent in this session");
	if (ctx.mode === "tui") return showReadOnlyText(ctx, "Last message sent, as the model received it", text);
	say(text);
}
