import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { accountKey, type AccountKey } from "../core/account.ts";

type PiModel = NonNullable<ExtensionContext["model"]>;

/** The Account key of a model, built from pi's public auth snapshot. */
export function accountOfModel(ctx: ExtensionContext, model: PiModel): AccountKey {
	return accountKey({
		provider: model.provider,
		usingOAuth: ctx.modelRegistry.isUsingOAuth(model),
		status: ctx.modelRegistry.getProviderAuthStatus(model.provider),
	});
}
