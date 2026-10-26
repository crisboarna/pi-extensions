import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { accountKey, type AccountKey } from "../core/account.ts";
import { CLAUDE_BRIDGE_PROVIDER, claudeBridgeSource, type ClaudeBridgeEnvironment } from "../core/claude-bridge.ts";

type PiModel = NonNullable<ExtensionContext["model"]>;

/** Where the claude-bridge resolver reads its environment; `registerGuard` sets it once from its injected dependencies. */
let claudeBridgeEnvironment: ClaudeBridgeEnvironment = { env: {}, home: "/", usesApiKeyHelper: () => false };

export function configureClaudeBridgeResolver(environment: ClaudeBridgeEnvironment): void {
	claudeBridgeEnvironment = environment;
}

/** The Account key of a model, built from pi's public auth snapshot; claude-bridge gets its own resolver (DESIGN.md section 6). */
export function accountOfModel(ctx: ExtensionContext, model: PiModel): AccountKey {
	if (model.provider === CLAUDE_BRIDGE_PROVIDER) return { provider: model.provider, source: claudeBridgeSource(claudeBridgeEnvironment) };
	return accountKey({
		provider: model.provider,
		usingOAuth: ctx.modelRegistry.isUsingOAuth(model),
		status: ctx.modelRegistry.getProviderAuthStatus(model.provider),
	});
}
