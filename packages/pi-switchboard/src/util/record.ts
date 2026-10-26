/** The value stored under `key`, created with `init` and stored first when missing. */
export function entryOf<T>(record: Record<string, T>, key: string, init: () => NoInfer<T>): T {
	const existing = record[key];
	if (existing !== undefined) return existing;
	const created = init();
	record[key] = created;
	return created;
}
