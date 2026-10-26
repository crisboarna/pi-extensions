import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { logData } from "../core/block-dialog.ts";
import { createConfigWriter, type ConfigWriter } from "../core/config-writer.ts";
import type { ConfigState } from "../core/config-state.ts";
import type { BlockCause } from "../core/decide.ts";
import { processOverrideWarning } from "../core/messages.ts";
import { isPooledProvider } from "../core/pooled.ts";
import { PROCESS_OVERRIDE_VARIABLE, processOverrideActive, processOverrideCovers } from "../core/process-override.ts";
import { runTagPrompt } from "./tag-prompt.ts";

type UnknownAccountCause = Extract<BlockCause, { kind: "unknown-account" }>;

/** Session log entry type of a turn the process Override let through. */
const ALLOW_UNKNOWN_ENTRY = "guard.allow_unknown";

export interface UnknownAccountDeps {
	configPath: string;
	/** The environment the process Override is read from. */
	env?: Record<string, string | undefined>;
	/** Replaces the file atomically; without it the Tag prompt is not offered. */
	writeConfigText?(path: string, text: string): void;
	/** The pi-multi-pass label of a provider id, shown as a hint in the Tag prompt. */
	multiPassLabel?(provider: string): string | undefined;
	writeStderr(text: string): void;
}

export interface UnknownAccountGate {
	/** Whether the process Override covers the Block; has no side effects, so every hook can ask. */
	covers(cause: BlockCause, ctx: ExtensionContext): cause is UnknownAccountCause;
	/** Lets the turn through when the process Override covers the Block: logs the turn and warns once per session. */
	letThrough(cause: BlockCause, ctx: ExtensionContext): boolean;
	/** Offers the Tag prompt for an Unknown account; resolves `true` when a tag was written, so the caller checks again. */
	tag(cause: BlockCause, ctx: ExtensionContext): Promise<boolean>;
	/** A new session warns again. */
	reset(): void;
}

/** What the guard does with an Unknown account before the Block select: the process Override and the Tag prompt (DESIGN.md section 10). */
export function createUnknownAccountGate(pi: ExtensionAPI, deps: UnknownAccountDeps, configState: ConfigState): UnknownAccountGate {
	const { writeConfigText } = deps;
	const writer: ConfigWriter | undefined = writeConfigText && createConfigWriter({ readForWrite: configState.readForWrite, writeText: (text) => writeConfigText(deps.configPath, text) });
	const configFile = deps.configPath.slice(deps.configPath.lastIndexOf("/") + 1);
	let warned = false;

	const covers = (cause: BlockCause, ctx: ExtensionContext): cause is UnknownAccountCause => processOverrideCovers(cause) && processOverrideActive(deps.env?.[PROCESS_OVERRIDE_VARIABLE], ctx.mode);

	return {
		covers,
		letThrough(cause, ctx) {
			if (!covers(cause, ctx)) return false;
			pi.appendEntry(ALLOW_UNKNOWN_ENTRY, logData(cause, cause.place));
			if (!warned) {
				warned = true;
				const warning = processOverrideWarning(cause.account);
				if (ctx.hasUI) ctx.ui.notify(warning, "warning");
				else deps.writeStderr(`${warning}\n`);
			}
			return true;
		},
		async tag(cause, ctx) {
			if (cause.kind !== "unknown-account" || !ctx.hasUI || !writer) return false;
			// The prompt is disabled while the file is malformed, even when a last valid copy still decides the checks (DESIGN.md section 7).
			const live = configState.readForWrite();
			if (!live.ok) return false;
			const zones = await runTagPrompt({
				ctx,
				account: cause.account,
				placeZone: cause.place.zone,
				config: live.config,
				multiPassLabel: deps.multiPassLabel?.(cause.account.provider),
				pooled: isPooledProvider(ctx.modelRegistry.getProvider(cause.account.provider)),
				writer,
				configFile,
			});
			return zones !== undefined;
		},
		reset() {
			warned = false;
		},
	};
}
