import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type AccountKey, accountKey } from "../core/account.ts";
import { CLAUDE_BRIDGE_PROVIDER, type ClaudeBridgeEnvironment, claudeBridgeSource } from "../core/claude-bridge.ts";

type PiModel = NonNullable<ExtensionContext["model"]>;

/** The Account key of a model. */
export type AccountOfModel = (ctx: ExtensionContext, model: PiModel) => AccountKey;

/** Builds the Account key of a model from pi's public auth snapshot; claude-bridge gets its own resolver over `claudeBridge` (DESIGN.md section 6). */
export function createAccountResolver(claudeBridge: ClaudeBridgeEnvironment): AccountOfModel {
	return (ctx, model) => {
		if (model.provider === CLAUDE_BRIDGE_PROVIDER) return { provider: model.provider, source: claudeBridgeSource(claudeBridge) };
		return accountKey({
			provider: model.provider,
			usingOAuth: ctx.modelRegistry.isUsingOAuth(model),
			status: ctx.modelRegistry.getProviderAuthStatus(model.provider),
		});
	};
}
