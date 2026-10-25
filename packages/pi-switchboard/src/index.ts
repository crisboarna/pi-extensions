import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Runtime } from "./runtime.ts";

/**
 * pi-switchboard: a decision classifier picks a tier for each piece of work,
 * the active profile maps the tier to models, and a strategy picks one.
 * See DESIGN.md.
 */
export default function switchboard(pi: ExtensionAPI): void {
	const runtime = new Runtime(pi);
	runtime.entryPath = fileURLToPath(import.meta.url);
	runtime.bootstrap();

	pi.on("session_start", async (_event, ctx) => {
		await runtime.onSessionStart(ctx);
	});
	pi.on("model_select", (event, ctx) => {
		runtime.onModelSelect(event.model, ctx);
	});
	pi.on("after_provider_response", (event) => {
		runtime.onAfterProviderResponse(event.status, event.headers);
	});
	pi.on("message_end", (event, ctx) => {
		const message = event.message as { role?: string };
		if (message.role !== "assistant") return undefined;
		const rewrite = runtime.onAssistantMessage(event.message as never, ctx);
		return rewrite ? { message: { ...event.message, ...rewrite } as typeof event.message } : undefined;
	});
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "subagent") return undefined;
		try {
			await runtime.onSubagentCall(event.toolCallId, event.input as Record<string, unknown>, ctx);
		} catch (error) {
			ctx.ui.notify(`pi-switchboard: subagent routing skipped: ${error instanceof Error ? error.message : String(error)}`, "warning");
		}
		return undefined;
	});
	pi.on("tool_result", (event) => {
		if (event.toolName === "subagent") runtime.onSubagentResult(event.toolCallId, event.details);
		return undefined;
	});
	pi.on("session_shutdown", () => {
		runtime.shutdown();
	});
}
