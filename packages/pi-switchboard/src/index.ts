import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { mergeProposal, proposeConfig } from "./autotier/propose.ts";
import { textOf } from "./classifier/evidence.ts";
import { openFile, writeInspector } from "./commands/inspect.ts";
import { registerTierCommand } from "./commands/tier.ts";
import { findProjectConfig, readJson, userConfigPath } from "./config/load.ts";
import { explain, summarize } from "./record/describe.ts";
import { DECISION_TYPE, type DecisionEntry } from "./record/types.ts";
import { Runtime } from "./runtime.ts";
import { runTierEditor, saveWithConfirmation } from "./tui/editor.ts";
import { openNavigator, startWidget } from "./tui/pi-tui.ts";

/**
 * pi-switchboard: a decision classifier picks a tier for each piece of work,
 * the active profile maps the tier to models, and a strategy picks one.
 * See DESIGN.md.
 */
export default function switchboard(pi: ExtensionAPI): void {
	const runtime = new Runtime(pi);
	runtime.entryPath = fileURLToPath(import.meta.url);
	runtime.bootstrap();

	pi.registerEntryRenderer<DecisionEntry>(DECISION_TYPE, (entry, { expanded }, theme) => {
		const decision = entry.data;
		if (!decision) return undefined;
		const head = theme.fg(decision.kind === "fallback" || decision.kind === "inactive" ? "warning" : "dim", summarize(decision));
		const body =
			expanded || runtime.config.ui.entries === "expanded"
				? `\n${explain(decision)
						.map((line) => theme.fg("dim", `  ${line}`))
						.join("\n")}`
				: "";
		return new Text(head + body, 0, 0);
	});

	registerTierCommand(runtime, {
		watch: async (_args, ctx) => openNavigator(runtime, ctx),
		inspect: async (args, ctx) => {
			const outIndex = args.indexOf("-o");
			const sessionFile = ctx.sessionManager.getSessionFile();
			const out = writeInspector({
				entries: ctx.sessionManager.getEntries(),
				sessionId: ctx.sessionManager.getSessionId(),
				...(sessionFile ? { sessionFile } : {}),
				dataDir: runtime.dir,
				...(outIndex >= 0 && args[outIndex + 1] ? { out: args[outIndex + 1] as string } : {}),
			});
			const opened = args.includes("--open") ? await openFile(out) : undefined;
			ctx.ui.notify(`Inspector written to ${out}${opened === false ? " (could not open it; open the file yourself)" : ""}`, "info");
		},
		init: async (_args, ctx) => {
			const path = userConfigPath(runtime.agentDir);
			const existing = readJson(path).value;
			const isProvider = (name: string) => ctx.modelRegistry.getProvider(name) !== undefined;
			const models = ctx.modelRegistry
				.getAvailable()
				.filter((m) => !runtime.isVirtual(m.provider))
				.map((m) => ({ provider: m.provider, id: m.id, contextWindow: m.contextWindow, maxTokens: m.maxTokens, cost: m.cost }));
			const current = ctx.model && !runtime.isVirtual(ctx.model.provider) ? `${ctx.model.provider}/${ctx.model.id}` : runtime.engine.originModel;
			const proposal = proposeConfig(models, {
				hints: runtime.config.autoTier.nameHints,
				...(current ? { current } : {}),
				isAccount: (provider) => /-\d+$/u.test(provider) && isProvider(provider.replace(/-\d+$/u, "")),
				classifierProviders: runtime.config.classifierProviders,
				classifiers: runtime.config.classifiers,
			});
			if (!proposal.classifiers?.length)
				ctx.ui.notify(
					"No classifier configured yet: add a local System One server under classifierProviders and classifiers (see the README).",
					"warning",
				);
			const next = existing ? mergeProposal(existing, proposal) : proposal;
			await saveWithConfirmation(ctx.ui, path, existing ?? {}, next);
		},
		models: async (args, ctx) => {
			const project = findProjectConfig(ctx.cwd);
			const target = args.includes("--project")
				? (project ?? `${ctx.cwd}/.pi/pi-switchboard.json`)
				: args.includes("--global")
					? userConfigPath(runtime.agentDir)
					: await ctx.ui.select("Edit which config?", [userConfigPath(runtime.agentDir), project ?? `${ctx.cwd}/.pi/pi-switchboard.json`]);
			if (!target) return;
			const raw = readJson(target).value ?? { version: 1 };
			const models = ctx.modelRegistry
				.getAvailable()
				.filter((m) => !runtime.isVirtual(m.provider))
				.map((m) => `${m.provider}/${m.id}`)
				.sort();
			await runTierEditor(ctx.ui, { path: target, raw, models });
		},
	});
	pi.registerShortcut(runtime.config.ui.navigator.shortcut as never, {
		description: "pi-switchboard navigator",
		handler: async (ctx) => openNavigator(runtime, ctx),
	});
	let stopWidget = () => {};

	pi.on("session_start", async (_event, ctx) => {
		await runtime.onSessionStart(ctx);
		stopWidget();
		stopWidget = startWidget(runtime, ctx);
	});
	pi.on("model_select", (event, ctx) => {
		runtime.onModelSelect(event.model, ctx);
	});
	pi.on("after_provider_response", (event) => {
		runtime.onAfterProviderResponse(event.status, event.headers);
	});
	pi.on("message_start", (event) => {
		if ((event.message as { role?: string }).role === "assistant") runtime.live?.streamStarted();
	});
	pi.on("turn_start", () => {
		if (runtime.live) runtime.live.update({ turn: runtime.live.status.turn + 1 });
	});
	pi.on("message_end", (event, ctx) => {
		const message = event.message as {
			role?: string;
			content?: unknown;
			provider?: string;
			model?: string;
			usage?: never;
			errorMessage?: string;
			stopReason?: string;
		};
		if (runtime.live) {
			if (message.role === "user") runtime.live.append({ kind: "task", text: textOf(message.content as never) });
			if (message.role === "assistant") {
				runtime.live.assistant({
					text: textOf(message.content as never),
					...(message.provider ? { provider: message.provider } : {}),
					...(message.model ? { model: message.model } : {}),
					...(message.usage ? { usage: message.usage } : {}),
					...(message.errorMessage ? { error: message.errorMessage } : {}),
				});
				if (message.stopReason === "error") runtime.live.update({ status: "error" });
			}
		}
		if (message.role !== "assistant") return undefined;
		const rewrite = runtime.onAssistantMessage(event.message as never, ctx);
		return rewrite ? { message: { ...event.message, ...rewrite } as typeof event.message } : undefined;
	});
	pi.on("tool_call", async (event, ctx) => {
		if (runtime.live) {
			runtime.live.update({ currentTool: event.toolName });
			runtime.live.append({ kind: "tool-call", tool: event.toolName, text: JSON.stringify(event.input ?? {}) });
		}
		if (event.toolName !== "subagent") return undefined;
		try {
			await runtime.onSubagentCall(event.toolCallId, event.input as Record<string, unknown>, ctx);
		} catch (error) {
			ctx.ui.notify(`pi-switchboard: subagent routing skipped: ${error instanceof Error ? error.message : String(error)}`, "warning");
		}
		return undefined;
	});
	pi.on("tool_result", (event) => {
		if (runtime.live) {
			runtime.live.update({ currentTool: undefined });
			runtime.live.append({ kind: "tool-result", tool: event.toolName, isError: event.isError === true, text: textOf(event.content as never) });
		}
		if (event.toolName === "subagent") runtime.onSubagentResult(event.toolCallId, event.details);
		return undefined;
	});
	pi.on("session_shutdown", () => {
		stopWidget();
		runtime.shutdown();
	});
}
