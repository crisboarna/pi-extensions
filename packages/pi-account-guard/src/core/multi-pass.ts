/**
 * The pi-multi-pass label of a provider id, read from the text of its `multi-pass.json`. pi-multi-pass registers each extra account as `<provider>-<index>`.
 * The label is only a display hint, so a missing or unexpected file means no label.
 */
export function multiPassLabel(text: string | undefined, providerId: string): string | undefined {
	if (text === undefined) return undefined;
	let file: unknown;
	try {
		file = JSON.parse(text);
	} catch {
		return undefined;
	}
	const subscriptions = (file as { subscriptions?: unknown } | null)?.subscriptions;
	if (!Array.isArray(subscriptions)) return undefined;
	for (const entry of subscriptions as Array<{ provider?: unknown; index?: unknown; label?: unknown } | null>) {
		if (entry && `${entry.provider}-${entry.index}` === providerId && typeof entry.label === "string") return entry.label;
	}
	return undefined;
}
