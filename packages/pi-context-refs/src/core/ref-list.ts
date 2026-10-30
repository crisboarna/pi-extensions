import type { Ref } from "./library.ts";
import { foldName } from "./names.ts";
import { LAYER_PHRASE, type Layer, resolveRefs } from "./resolve.ts";
import type { Place } from "./scope.ts";

/** The settings the Global library file holds next to its Refs. */
export interface Settings {
	trigger: string;
	/** `true` keeps every Built-in Ref, `false` turns them all off, a list turns those names off. */
	builtins: boolean | string[];
}

const DEFAULT_SETTINGS: Settings = { trigger: "#", builtins: true };
const SUMMARY_LIMIT = 60;

/** Reads `trigger` and `builtins` from library file text. Anything missing, malformed or of the wrong type gives the default. */
export function readSettings(text: string | undefined): Settings {
	let data: unknown;
	try {
		data = text === undefined ? undefined : JSON.parse(text);
	} catch {
		return { ...DEFAULT_SETTINGS };
	}
	if (typeof data !== "object" || data === null || Array.isArray(data)) return { ...DEFAULT_SETTINGS };
	const { trigger, builtins } = data as Record<string, unknown>;
	return {
		trigger: typeof trigger === "string" && trigger !== "" ? trigger : DEFAULT_SETTINGS.trigger,
		builtins:
			typeof builtins === "boolean" || (Array.isArray(builtins) && builtins.every((name) => typeof name === "string"))
				? builtins
				: DEFAULT_SETTINGS.builtins,
	};
}

/** Text from a file made safe for a terminal: control characters become spaces. */
const plain = (text: string): string =>
	text
		.replace(/\p{Cc}/gu, " ")
		.replace(/\s+/g, " ")
		.trim();

/** One line for a Ref: name, kind, tags, scope and a summary of its target. */
export function describeRef(ref: Ref): string {
	const parts = [ref.name, ref.kind];
	if (ref.tags && ref.tags.length > 0) parts.push(`[${ref.tags.join(", ")}]`);
	if (ref.scope)
		parts.push(
			`scope: ${Object.entries(ref.scope)
				.map(([key, value]) => `${key} ${value}`)
				.join(", ")}`,
		);
	parts.push(plain(targetSummary(ref)));
	return parts.map(plain).join("  ");
}

function targetSummary(ref: Ref): string {
	if (ref.kind === "path" || ref.kind === "file") return ref.path;
	if (ref.kind === "snippet") {
		const text = plain(ref.text);
		return `"${text.length > SUMMARY_LIMIT ? `${text.slice(0, SUMMARY_LIMIT)}…` : text}"`;
	}
	return ref.command ? ref.command.join(" ") : (ref.url ?? "");
}

/** A library file as `/ref list` shows it. */
export interface ListedLibrary {
	file: string;
	refs: readonly Ref[];
	warnings: string[];
	/** Set when the file cannot be used at all. */
	error?: string;
}

/** What `/ref list` shows. */
export interface ListInput extends ListedLibrary {
	settings: Settings;
	/** The Trigger this session started with; a different one in the file needs `/reload`. */
	sessionTrigger: string;
	/** The Project library: its Refs when the project is trusted, `untrusted` when it is not loaded for that reason. */
	project: (ListedLibrary & { untrusted?: never }) | { file: string; untrusted: true };
	place: Place;
	filter: { tag?: string; library?: "global" | "project" };
}

/** The plain-text block of `/ref list`: settings, Refs by layer, Shadowed Refs and load warnings. It is the same text in the TUI, RPC and print mode. */
export function formatList(input: ListInput): string {
	const { settings, filter, project } = input;
	const tag = filter.tag === undefined ? undefined : foldName(filter.tag);
	const tagged = (refs: readonly Ref[]): Ref[] =>
		tag === undefined ? [...refs] : refs.filter((ref) => ref.tags?.some((candidate) => foldName(candidate) === tag));
	const layered = resolveRefs({ global: input.refs, project: project.untrusted ? [] : project.refs }, input.place);
	const inLayer = (layer: Layer) => layered.applicable.filter((entry) => entry.layer === layer).map((entry) => entry.ref);
	const lines = ["pi-context-refs", triggerLine(settings.trigger, input.sessionTrigger), `builtins: ${builtinsText(settings.builtins)}`];
	const showGlobal = filter.library !== "project";
	const showProject = filter.library !== "global";
	const section = (title: string, refs: readonly Ref[]): void => {
		const shown = tagged(refs);
		lines.push("", `${title} (${countText(shown.length, refs.length, filter.tag)})`, ...shown.map((ref) => `  ${describeRef(ref)}`));
	};
	if (showGlobal && inLayer("scoped").length > 0) section(`Scoped Refs that apply here, in ${input.file}`, inLayer("scoped"));
	if (showProject) {
		if (project.untrusted) lines.push("", `Project library ${project.file}: not loaded. ${UNTRUSTED}`);
		else section(`Project library ${project.file}`, project.refs);
	}
	if (showGlobal) section(`Global library ${input.file}`, inLayer("global"));
	if (showGlobal && layered.scopedElsewhere.length > 0) section(`Scoped Refs that do not apply here, in ${input.file}`, layered.scopedElsewhere);
	const hidden = layered.shadowed.filter((entry) => tagged([entry.ref]).length > 0 && (entry.layer === "project" ? showProject : showGlobal));
	if (hidden.length > 0) {
		lines.push(
			"",
			"Shadowed Refs:",
			...hidden.map((entry) => `  ${plain(entry.ref.name)}  in ${LAYER_PHRASE[entry.layer]}, hidden by ${LAYER_PHRASE[entry.by.layer]}`),
		);
	}
	const warnings = [...(showGlobal ? libraryWarnings(input) : []), ...(showProject && !project.untrusted ? libraryWarnings(project) : [])];
	if (warnings.length > 0) lines.push("", "Warnings:", ...warnings.map((warning) => `  ${plain(warning)}`));
	return lines.join("\n");
}

/** Why the Project library is not loaded, and what to do about it. */
export const UNTRUSTED =
	"pi does not trust this project. Run /trust, then restart pi: a saved decision applies from the next start, because /trust does not change a running session.";

const libraryWarnings = (library: ListedLibrary): string[] =>
	library.error === undefined ? library.warnings : [...library.warnings, `${library.error}; no Refs are loaded`];

function triggerLine(trigger: string, sessionTrigger: string): string {
	return trigger === sessionTrigger
		? `trigger: ${plain(trigger)}`
		: `trigger: ${plain(trigger)} in the file, ${plain(sessionTrigger)} in this session; run /reload to use it`;
}

function builtinsText(builtins: boolean | string[]): string {
	if (builtins === true) return "on";
	return builtins === false ? "off" : `off for ${builtins.map(plain).join(", ")}`;
}

function countText(shown: number, total: number, tag: string | undefined): string {
	const noun = (count: number) => (count === 1 ? "1 Ref" : `${count === 0 ? "no" : count} Refs`);
	if (tag === undefined) return noun(total);
	return `${shown} of ${total} Refs, tag ${plain(tag)}`;
}
