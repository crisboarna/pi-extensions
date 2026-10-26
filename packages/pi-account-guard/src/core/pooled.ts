/** The private marker pi-multiprovider puts on the provider it lifts to pool several accounts under one id (DESIGN.md section 6). */
const LIFTED_MARKER = Symbol.for("pi-multiprovider.lifted-base");

/** Whether the provider object carries the pi-multiprovider marker. A pool only warns; it never Blocks. */
export function isPooledProvider(provider: object | undefined): boolean {
	return Boolean(provider) && Boolean((provider as Record<symbol, unknown>)[LIFTED_MARKER]);
}

/** The provider ids among `providerIds` that are pooled, each once, in first-seen order. */
export function pooledProviderIds(providerIds: Iterable<string>, providerOf: (id: string) => object | undefined): string[] {
	return [...new Set(providerIds)].filter((id) => isPooledProvider(providerOf(id)));
}

/** The extra lines of the Tag prompt for a pooled id (DESIGN.md section 6). */
export function pooledWarning(provider: string): string {
	return `${provider} pools several accounts (pi-multiprovider). Tag it only if all of them share one zone.`;
}
