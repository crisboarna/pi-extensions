// Throwaway probe extension for the assumed-behaviour smoke tests. One scenario per
// run, chosen by PROBE_SCENARIO; observations go to the JSONL file at PROBE_LOG.
import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SECOND_ONLY_MODEL, SECOND_PROVIDER } from "./second-provider.ts";
import { STUB_MODEL_2, STUB_PROVIDER } from "./stub-provider.ts";

function record(entry: Record<string, unknown>): void {
	if (process.env.PROBE_LOG) appendFileSync(process.env.PROBE_LOG, `${JSON.stringify(entry)}\n`);
}

export default function probe(pi: ExtensionAPI): void {
	switch (process.env.PROBE_SCENARIO) {
		case "throwing-handlers":
			pi.on("input", () => {
				record({ ran: "input" });
				throw new Error("probe: input handler throws");
			});
			pi.on("before_agent_start", () => {
				record({ ran: "before_agent_start" });
				throw new Error("probe: before_agent_start handler throws");
			});
			break;
		case "input-dialog":
			pi.on("input", async (_event, ctx) => {
				const choice = await ctx.ui.select("Probe dialog", ["Go", "Stop"]);
				record({ ran: "input", choice });
				return { action: "continue" };
			});
			break;
		case "input-handled-refill":
			pi.on("input", async (event, ctx) => {
				ctx.ui.setEditorText(event.text);
				return { action: "handled" };
			});
			break;
		case "exit-77":
			pi.on("input", async () => {
				process.stderr.write("probe: blocked\n");
				process.exitCode = 77;
				return { action: "handled" };
			});
			break;
		case "status":
			pi.on("session_start", async (_event, ctx) => {
				ctx.ui.setStatus("guard", "probe status");
			});
			break;
		case "abort-from-model-select":
			// Switch the model once the turn has started, so model_select fires mid-turn.
			pi.on("turn_start", async (_event, ctx) => {
				const target = ctx.modelRegistry.find(STUB_PROVIDER, STUB_MODEL_2);
				if (target) record({ switched: await pi.setModel(target) });
			});
			pi.on("model_select", async (event, ctx) => {
				record({ ran: "model_select", idle: ctx.isIdle(), eventModel: event.model.id, ctxModel: ctx.model?.id, source: event.source });
				ctx.abort();
			});
			break;
		case "idle-switch-then-abort":
			pi.on("model_select", async (event, ctx) => {
				record({ ran: "model_select", idle: ctx.isIdle(), ctxModel: ctx.model?.id, source: event.source });
			});
			pi.on("before_agent_start", async (event, ctx) => {
				record({ ran: "before_agent_start", ctxModel: ctx.model?.id, messageType: event.messageType, idle: ctx.isIdle() });
				ctx.abort();
			});
			break;
		// The three scenarios below switch to the second stub provider, which the guard test config tags with another zone.
		case "switch-account-at-turn-start": {
			let switched = false;
			pi.on("turn_start", async (_event, ctx) => {
				const target = ctx.modelRegistry.find(SECOND_PROVIDER, SECOND_ONLY_MODEL);
				if (switched || !target) return;
				switched = true;
				record({ switched: await pi.setModel(target) });
			});
			break;
		}
		case "switch-account-after-input":
			// Load after the guard: its `input` handler has already allowed the turn when this one switches the model.
			pi.on("input", async (_event, ctx) => {
				const target = ctx.modelRegistry.find(SECOND_PROVIDER, SECOND_ONLY_MODEL);
				if (target) record({ switched: await pi.setModel(target) });
				return { action: "continue" };
			});
			break;
		case "rotate-in-agent-end": {
			// What pi-multi-pass does: switch the model inside the awaited agent_end chain, then send the turn again.
			let rotated = false;
			pi.on("agent_end", async (_event, ctx) => {
				const target = ctx.modelRegistry.find(SECOND_PROVIDER, SECOND_ONLY_MODEL);
				if (rotated || !target) return;
				rotated = true;
				record({ ran: "agent_end", idle: ctx.isIdle() });
				record({ switched: await pi.setModel(target) });
				pi.sendUserMessage("retry");
			});
			pi.on("model_select", async (_event, ctx) => {
				record({ ran: "model_select", idle: ctx.isIdle() });
			});
			break;
		}
		case "command":
			pi.registerCommand("guard", {
				description: "Probe command",
				handler: async (args) => {
					record({ ran: "command", args });
				},
			});
			pi.on("input", async (event) => {
				record({ ran: "input", text: event.text });
				return { action: "continue" };
			});
			break;
		case "auth-status":
			pi.on("session_start", async (_event, ctx) => {
				record({ ran: "session_start", stubAuth: ctx.modelRegistry.getProviderAuthStatus(STUB_PROVIDER) });
			});
			break;
	}
}
