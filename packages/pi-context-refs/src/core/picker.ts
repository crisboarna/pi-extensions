import type { Ref } from "./library.ts";
import { foldName } from "./names.ts";
import { ageNote, matchRecent, type PathEnv, placeholderTarget, resolveUsedPath, rowPath, type UsedFile } from "./recent.ts";
import { plain, targetSummary } from "./ref-list.ts";
import { bundleMembers, type Layer } from "./resolve.ts";
import { findRefTokens } from "./tokens.ts";

/** Where a picker row sits: its layer, the Recent refs, or the Bundles at the end. Rows are kept together by section, in this order. */
type Section = Layer | "recent" | "bundle";

const SECTION_ORDER: readonly Section[] = ["scoped", "project", "global", "builtin", "recent", "bundle"];

/** The mark in front of each row's name. A Built-in Ref's row also says "built-in" in its description. */
const MARK: Record<Section, string> = { scoped: "◆", project: "■", global: "●", builtin: "○", recent: "↺", bundle: "⧉" };

const DESCRIPTION_LIMIT = 60;

/** A bare Trigger shows this many Recent refs; a query searches all of them. */
const BARE_RECENT_ROWS = 10;

/** One line of the picker. `value` says what a pick inserts (see `applyPick`). */
export interface PickerRow {
	section: Section;
	name: string;
	kind: string;
	description: string;
	mark: string;
	value: string;
}

/** The files the session used, as the picker needs them. */
export interface RecentSource {
	/** Newest use first. */
	files: readonly UsedFile[];
	env: Pick<PathEnv, "cwd" | "home">;
	/** The time the notes ("5 min ago") count from. */
	now: number;
	/** Whether the file exists; a missing one is hidden. Asked only of files that answer the query. */
	present: (path: string) => boolean;
}

export interface PickerSource {
	/** The Visible Refs, in the order scoped, project, global, Built-in. */
	visible: ReadonlyMap<string, Ref>;
	layers: ReadonlyMap<string, Layer>;
	/** Whether the session's directory is in a git work tree; the Built-in Refs are hidden when it is not. */
	inWorkTree: boolean;
	/** The session's Recent refs; none when it has not used any file. */
	recent?: RecentSource;
}

const REF_VALUE = "pi-context-refs:ref:";
const BUNDLE_VALUE = "pi-context-refs:bundle:";
const RECENT_VALUE = "pi-context-refs:recent:";

/** How well `name` answers `query`, 0 being best, or undefined for no match. Both are case-folded. */
function closeness(name: string, query: string): number | undefined {
	if (query === "") return 0;
	if (name === query) return 0;
	if (name.startsWith(query)) return 1;
	return name.includes(query) ? 2 : undefined;
}

function refCloseness(ref: Ref, query: string): number | undefined {
	const byName = closeness(foldName(ref.name), query);
	if (byName !== undefined) return byName;
	const byTag = ref.tags?.map((tag) => closeness(foldName(tag), query)).find((score) => score !== undefined);
	return byTag === undefined ? undefined : 3 + byTag;
}

/** A Bundle answers `tag:<tag>` and the bare text of its Tag. */
function bundleCloseness(tag: string, query: string): number | undefined {
	const folded = foldName(tag);
	return query.startsWith("tag:") ? closeness(folded, query.slice("tag:".length)) : closeness(folded, query);
}

function refRow(ref: Ref, layer: Layer): PickerRow {
	const described = plain(ref.description ?? "") || plain(targetSummary(ref));
	const description = layer === "builtin" ? `built-in · ${described}` : described;
	return { section: layer, name: ref.name, kind: ref.kind, description, mark: MARK[layer], value: `${REF_VALUE}${ref.name}` };
}

function bundleRow(tag: string, members: readonly Ref[]): PickerRow {
	const names = members.map((member) => member.name).join(", ");
	const listed = names.length > DESCRIPTION_LIMIT ? `${names.slice(0, DESCRIPTION_LIMIT)}…` : names;
	const count = `${members.length} ${members.length === 1 ? "Ref" : "Refs"}`;
	return {
		section: "bundle",
		name: `tag:${tag}`,
		kind: "bundle",
		description: `${count}: ${listed}`,
		mark: MARK.bundle,
		value: `${BUNDLE_VALUE}${members.map((member) => member.name).join(",")}`,
	};
}

/** The absolute paths that saved Path and File Refs point at, so their files are not offered a second time. */
function savedTargets(visible: ReadonlyMap<string, Ref>, env: Pick<PathEnv, "cwd" | "home">): Set<string> {
	const targets = new Set<string>();
	for (const ref of visible.values()) {
		const target = ref.kind === "path" || ref.kind === "file" ? resolveUsedPath(ref.path, env) : undefined;
		if (target !== undefined) targets.add(target);
	}
	return targets;
}

/** The Recent rows for `query`, newest use first: a bare Trigger gets the newest few, a query every file that answers it. Missing files and saved Refs' targets are left out. */
function recentRows(source: PickerSource, recent: RecentSource, query: string): PickerRow[] {
	const saved = savedTargets(source.visible, recent.env);
	const rows: PickerRow[] = [];
	for (const file of matchRecent(recent.files, query, recent.env)) {
		if (query === "" && rows.length === BARE_RECENT_ROWS) break;
		if (saved.has(file.path) || !recent.present(file.path)) continue;
		rows.push({
			section: "recent",
			name: rowPath(file.path, recent.env),
			kind: "recent",
			description: ageNote(file, recent.now),
			mark: MARK.recent,
			value: `${RECENT_VALUE}${placeholderTarget(file.path, recent.env)}`,
		});
	}
	return rows;
}

/** The Tags of the Visible Refs, each once under its first spelling, in order of first appearance. */
function tagsOf(visible: ReadonlyMap<string, Ref>): string[] {
	const seen = new Map<string, string>();
	for (const ref of visible.values()) for (const tag of ref.tags ?? []) if (!seen.has(foldName(tag))) seen.set(foldName(tag), tag);
	return [...seen.values()];
}

/** The rows that answer `query` (what was typed after the Trigger), kept together by section and in relevance order within one. A bare Trigger (`""`) gives every row. */
export function pickerRows(source: PickerSource, query: string): PickerRow[] {
	const folded = foldName(query);
	const scored: Array<{ row: PickerRow; score: number; at: number }> = [];
	for (const [key, ref] of source.visible) {
		const layer = source.layers.get(key);
		if (layer === undefined || (layer === "builtin" && !source.inWorkTree)) continue;
		const score = refCloseness(ref, folded);
		if (score !== undefined) scored.push({ row: refRow(ref, layer), score, at: scored.length });
	}
	for (const tag of tagsOf(source.visible)) {
		const score = bundleCloseness(tag, folded);
		if (score !== undefined) scored.push({ row: bundleRow(tag, bundleMembers(source.visible, tag)), score, at: scored.length });
	}
	if (source.recent) for (const row of recentRows(source, source.recent, query)) scored.push({ row, score: 0, at: scored.length });
	const section = (row: PickerRow) => SECTION_ORDER.indexOf(row.section);
	return scored.sort((a, b) => section(a.row) - section(b.row) || a.score - b.score || a.at - b.at).map(({ row }) => row);
}

/** What a row's `value` puts between `[ref:` and `]`: Ref names, or a Recent ref's path. Undefined when the value is not one of this package's rows. */
function pickedNames(value: string): string[] | undefined {
	if (value.startsWith(REF_VALUE)) return [value.slice(REF_VALUE.length)];
	if (value.startsWith(RECENT_VALUE)) return [value.slice(RECENT_VALUE.length)];
	return value.startsWith(BUNDLE_VALUE) ? value.slice(BUNDLE_VALUE.length).split(",") : undefined;
}

/** The editor's text after a pick. */
export interface Completion {
	lines: string[];
	cursorLine: number;
	cursorCol: number;
}

/**
 * Replaces the typed Trigger token (`typed`, which ends at the cursor) with the Placeholder of a Ref, or one Placeholder per member of
 * a Bundle that the draft does not already have. Returns undefined for a value that is not one of this package's rows.
 */
export function applyPick(lines: readonly string[], cursorLine: number, cursorCol: number, value: string, typed: string): Completion | undefined {
	const names = pickedNames(value);
	if (names === undefined) return undefined;
	const line = lines[cursorLine] ?? "";
	const start = cursorCol - typed.length;
	const rest = [...lines];
	rest[cursorLine] = line.slice(0, start) + line.slice(cursorCol);
	const present = new Set(
		findRefTokens(rest.join("\n"))
			.filter((token) => token.form !== "bundle")
			.map((token) => foldName(token.target)),
	);
	const inserted = names
		.filter((name) => !present.has(foldName(name)))
		.map((name) => `[ref:${name}]`)
		.join(" ");
	rest[cursorLine] = line.slice(0, start) + inserted + line.slice(cursorCol);
	return { lines: rest, cursorLine, cursorCol: start + inserted.length };
}
