import { foldName } from "./names.ts";
import { LAYER_PHRASE, type Layer, type LayeredRefs, type PlacedRef } from "./resolve.ts";

/** The two library files a Ref can be saved in. */
export type LibraryName = "global" | "project";

export const libraryOf = (layer: Layer): LibraryName => (layer === "project" ? "project" : "global");

/** The Ref called `name` in a library, as it applies here; undefined when it is not there or its scope does not match here. */
export function findPlaced(layered: LayeredRefs, library: LibraryName, name: string): PlacedRef | undefined {
	const wanted = foldName(name);
	return layered.applicable.find((entry) => entry.layer !== "builtin" && libraryOf(entry.layer) === library && foldName(entry.ref.name) === wanted);
}

const where = (entry: PlacedRef): string => `"${entry.ref.name}" in ${LAYER_PHRASE[entry.layer]}`;
const hiddenBy = (layered: LayeredRefs, placed: PlacedRef) => layered.shadowed.find((entry) => entry.ref === placed.ref);
const hiding = (layered: LayeredRefs, placed: PlacedRef) => layered.shadowed.filter((entry) => entry.by === placed);

/** The end of a result line for a Ref just saved: what it shadows, or what shadows it. Empty when the name is new. */
export function addedConsequence(layered: LayeredRefs, library: LibraryName, name: string): string {
	const placed = findPlaced(layered, library, name);
	if (!placed) return "; its scope does not match here, so it is not Visible here";
	const hider = hiddenBy(layered, placed);
	if (hider) return `; it is shadowed by ${where(hider.by)}, so #${hider.by.ref.name} still means that one here`;
	const hidden = hiding(layered, placed);
	return hidden.length > 0 ? `; it shadows ${hidden.map(where).join(" and ")}` : "";
}

/** What removing a Ref changes for the Refs around it, for the confirm; empty when nothing. */
export function removalConsequence(layered: LayeredRefs, placed: PlacedRef): string {
	const hider = hiddenBy(layered, placed);
	if (hider) return `It is shadowed by ${where(hider.by)}, so removing it changes nothing you can see.`;
	const hidden = hiding(layered, placed);
	return hidden.length > 0 ? `It shadows ${hidden.map(where).join(" and ")}; removing it makes that Ref Visible.` : "";
}
