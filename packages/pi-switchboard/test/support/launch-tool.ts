// Test-only extension: a no-argument tool that launches pi-subagents
// children through the real `subagent` tool, so the parent's tool_call hook
// and the child's routing run exactly as with a model-written call.
// LAUNCH_ASYNC=1 launches a background child instead of a foreground one.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function launchTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "launch_scout",
		label: "Launch scout",
		description: "Launches the scout subagent with a fixed task. Takes no arguments.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const outcome = await ctx.executeTool("subagent", {
				agent: "scout",
				task: process.env.LAUNCH_TASK ?? "Reply with the single word: scouted",
				async: process.env.LAUNCH_ASYNC === "1",
			});
			const callable = ctx.tools.map((tool) => tool.name).join(",");
			return { content: [{ type: "text", text: `${JSON.stringify(outcome).slice(0, 2000)}\ncallable: ${callable}` }], details: {} };
		},
	});
}
