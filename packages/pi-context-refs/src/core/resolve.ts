import type { Ref } from "./library.ts";
import { foldName } from "./names.ts";
import { type Place, scopeMatches } from "./scope.ts";

/** Where a Visible Ref comes from, highest precedence first (ADR 0002). */
export type Layer = "scoped" | "project" | "global" | "builtin";

/** A Ref and the layer it sits in. */
export interface PlacedRef {
	ref: Ref;
	layer: Layer;
}

/** The Refs of each library. The Global ones may carry a scope; the Built-in Refs sit below everything. */
export interface LayerSources {
	global: readonly Ref[];
	project: readonly Ref[];
	builtin?: readonly Ref[];
}

export interface LayeredRefs {
	/** The Visible Refs by case-folded name. */
	visible: Map<string, Ref>;
	/** The layer of each Visible Ref, by case-folded name. */
	layers: Map<string, Layer>;
	/** Every Ref that applies here, in precedence order and file order within a layer, Shadowed Refs included. */
	applicable: PlacedRef[];
	/** The Refs hidden by a Visible Ref of the same name, with the one that hides them. */
	shadowed: Array<PlacedRef & { by: PlacedRef }>;
	/** Global Refs whose scope does not match here. They are neither Visible nor Shadowed. */
	scopedElsewhere: Ref[];
}

/** The first Ref of each name, in list order, by case-folded name. */
export function visibleRefs(refs: readonly Ref[]): Map<string, Ref> {
	const visible = new Map<string, Ref>();
	for (const ref of refs) {
		const folded = foldName(ref.name);
		if (!visible.has(folded)) visible.set(folded, ref);
	}
	return visible;
}

/** Applies precedence: Scoped Ref, then Project library, then unscoped Global Ref, then Built-in Ref. Within one layer the first Ref of a name wins. */
export function resolveRefs(sources: LayerSources, place: Place): LayeredRefs {
	let remotes: readonly string[] | undefined;
	let asked = false;
	const once: Place = {
		...place,
		remotes: () => {
			if (!asked) remotes = place.remotes();
			asked = true;
			return remotes;
		},
	};
	const scoped: Ref[] = [];
	const unscoped: Ref[] = [];
	const scopedElsewhere: Ref[] = [];
	for (const ref of sources.global) {
		if (ref.scope === undefined) unscoped.push(ref);
		else if (scopeMatches(ref.scope, once)) scoped.push(ref);
		else scopedElsewhere.push(ref);
	}
	const applicable: PlacedRef[] = [
		...scoped.map((ref) => ({ ref, layer: "scoped" as const })),
		...sources.project.map((ref) => ({ ref, layer: "project" as const })),
		...unscoped.map((ref) => ({ ref, layer: "global" as const })),
		...(sources.builtin ?? []).map((ref) => ({ ref, layer: "builtin" as const })),
	];
	const winners = new Map<string, PlacedRef>();
	const shadowed: LayeredRefs["shadowed"] = [];
	for (const placed of applicable) {
		const folded = foldName(placed.ref.name);
		const winning = winners.get(folded);
		if (winning) shadowed.push({ ...placed, by: winning });
		else winners.set(folded, placed);
	}
	return {
		visible: new Map([...winners].map(([folded, placed]) => [folded, placed.ref])),
		layers: new Map([...winners].map(([folded, placed]) => [folded, placed.layer])),
		applicable,
		shadowed,
		scopedElsewhere,
	};
}
