// Throwaway probe extension for the assumed-behaviour tests. One scenario per run,
// chosen by PROBE_SCENARIO; observations go to the JSONL file at PROBE_LOG. It
// stands in for the package: nothing here is package code.
import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const PROBE_BODY = "PROBE-BODY-XYZ";
/** A 1x1 PNG, the smallest image the model can be sent. */
export const PROBE_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";

/** What a rewrite appends after the prose: one Context block, as the design frames it. */
export function probeBlock(): string {
	return `<context-ref name="probe" kind="file" path="p.txt" bytes="${Buffer.byteLength(PROBE_BODY)}">\n${PROBE_BODY}\n</context-ref>`;
}

function record(entry: Record<string, unknown>): void {
	if (process.env.PROBE_LOG) appendFileSync(process.env.PROBE_LOG, `${JSON.stringify(entry)}\n`);
}

const BLOCK = /<context-ref name="([^"]*)" kind="([^"]*)"[^>]* bytes="(\d+)"[^>]*>/;

/** Collapses the tail block of a user message, parsed by its declared byte length. */
function collapseTail(markdown: string): string {
	const open = BLOCK.exec(markdown);
	if (!open) return markdown;
	const [header, name, kind, bytes] = open;
	return `${markdown.slice(0, open.index)}▸ ref ${name} (${kind}, ${bytes} B)${markdown.slice(open.index + header.length + 1 + Number(bytes) + 1 + "</context-ref>".length)}`;
}

function rewrite(pi: ExtensionAPI, withImage: boolean): void {
	pi.on("input", async (event) => {
		record({ ran: "input", text: event.text, source: event.source, streamingBehavior: event.streamingBehavior });
		if (event.source === "extension" || event.text.startsWith("/")) return { action: "continue" };
		const images = withImage ? [{ type: "image" as const, data: PROBE_PNG, mimeType: "image/png" }] : undefined;
		return { action: "transform", text: `${event.text}\n\n${probeBlock()}`, ...(images ? { images } : {}) };
	});
}

export default function probe(pi: ExtensionAPI): void {
	switch (process.env.PROBE_SCENARIO) {
		case "rewrite":
			rewrite(pi, false);
			break;
		case "rewrite-image":
			rewrite(pi, true);
			break;
		case "transformer":
			rewrite(pi, false);
			pi.registerMarkdownTransformer((markdown, context) => {
				record({ ran: "transform", messageType: context.messageType, markdown });
				return context.messageType === "user" ? collapseTail(markdown) : markdown;
			});
			break;
		case "handled-refill":
			pi.on("input", async (event, ctx) => {
				record({ ran: "input", text: event.text });
				ctx.ui.setEditorText(`RESTORED ${event.text}`);
				// The design's failure path also shows the reason; that call is what makes pi repaint the editor.
				ctx.ui.notify("Probe: draft restored", "warning");
				return { action: "handled" };
			});
			break;
		case "confirm":
			pi.on("input", async (_event, ctx) => {
				const answer = await ctx.ui.confirm("Probe approval", "Run the probe?");
				record({ ran: "input", hasUI: ctx.hasUI, confirm: answer });
				return { action: "continue" };
			});
			break;
		case "command":
			pi.registerCommand("ref", {
				description: "Probe command",
				handler: async (args, ctx) => {
					record({ ran: "command", args, hasUI: ctx.hasUI });
					ctx.ui.notify(`probe notice for ${args}`, "info");
					process.stdout.write("probe stdout write\n");
					process.stderr.write("probe stderr write\n");
				},
			});
			pi.on("input", async (event) => {
				record({ ran: "input", text: event.text });
				return { action: "continue" };
			});
			break;
		case "trust":
			pi.on("session_start", async (_event, ctx) => {
				record({ ran: "session_start", trusted: ctx.isProjectTrusted() });
			});
			pi.on("input", async (_event, ctx) => {
				record({ ran: "input", trusted: ctx.isProjectTrusted() });
				return { action: "continue" };
			});
			break;
		case "tool-results":
			pi.on("tool_result", async (event) => {
				record({
					ran: "tool_result",
					toolName: event.toolName,
					toolCallId: event.toolCallId,
					parentToolCallId: event.parentToolCallId,
					input: event.input,
					isError: event.isError,
				});
			});
			pi.on("message_end", async (event) => {
				if (event.message.role === "toolResult")
					record({
						ran: "tool_message",
						toolName: event.message.toolName,
						isError: event.message.isError,
						content: event.message.content,
						nestedCalls: event.message.nestedCalls,
					});
			});
			break;
	}
}
