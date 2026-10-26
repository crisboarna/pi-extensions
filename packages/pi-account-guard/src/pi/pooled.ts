import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { pooledProviderIds } from "../core/pooled.ts";

/** The provider ids in the model registry that pi-multiprovider pools; for the `/guard` status view. */
export function pooledProviders(ctx: ExtensionContext): string[] {
	return pooledProviderIds(
		ctx.modelRegistry.getAll().map((model) => model.provider),
		(id) => ctx.modelRegistry.getProvider(id),
	);
}
