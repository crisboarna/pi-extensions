import type { Ref } from "./library.ts";
import { foldName } from "./names.ts";

/** The Refs that apply where the user is, by case-folded name. A Scoped Ref is left out until its scope is matched. */
export function visibleRefs(refs: readonly Ref[]): Map<string, Ref> {
	const visible = new Map<string, Ref>();
	for (const ref of refs) {
		const folded = foldName(ref.name);
		if (ref.scope === undefined && !visible.has(folded)) visible.set(folded, ref);
	}
	return visible;
}

/** The Bundle of `tag`: every Visible Ref that carries it, in the order of `visible`, which is scoped, project, global, then file order. */
export function bundleMembers(visible: ReadonlyMap<string, Ref>, tag: string): Ref[] {
	const folded = foldName(tag);
	return [...visible.values()].filter((ref) => ref.tags?.some((candidate) => foldName(candidate) === folded));
}
