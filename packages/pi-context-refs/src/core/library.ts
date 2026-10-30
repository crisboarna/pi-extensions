import { foldName, nameProblem } from "./names.ts";

export type RefKind = "path" | "file" | "snippet" | "dynamic";

/** Where a Global library Ref applies: a directory or glob, a git remote, or both. */
export interface RefScope {
	path?: string;
	remote?: string;
}

interface RefFields {
	name: string;
	description?: string;
	tags?: string[];
	scope?: RefScope;
}

export interface PathRef extends RefFields {
	kind: "path";
	path: string;
}

export interface FileRef extends RefFields {
	kind: "file";
	path: string;
	max_bytes?: number;
}

export interface SnippetRef extends RefFields {
	kind: "snippet";
	text: string;
}

export interface DynamicRef extends RefFields {
	kind: "dynamic";
	command?: string[];
	url?: string;
	cwd?: string;
	timeout?: number;
	max_output?: number;
}

export type Ref = PathRef | FileRef | SnippetRef | DynamicRef;

/** A library file read for the session: the valid Refs in file order, and one warning for each Ref that was skipped. */
export interface LoadedLibrary {
	ok: true;
	refs: Ref[];
	warnings: string[];
}

/** A library file that cannot be used at all. */
export interface UnusableLibrary {
	ok: false;
	error: string;
}

const KINDS: readonly RefKind[] = ["path", "file", "snippet", "dynamic"];
const COMMON_FIELDS = ["name", "kind", "description", "tags", "scope"];
const FIELDS_BY_KIND: Record<RefKind, readonly string[]> = {
	path: [...COMMON_FIELDS, "path"],
	file: [...COMMON_FIELDS, "path", "max_bytes"],
	snippet: [...COMMON_FIELDS, "text"],
	dynamic: [...COMMON_FIELDS, "command", "url", "cwd", "timeout", "max_output"],
};
const EVERY_FIELD = new Set(Object.values(FIELDS_BY_KIND).flat());
const MAX_BYTES_CEILING = 1024 * 1024;
const MAX_OUTPUT_CEILING = 1024 * 1024;
const TIMEOUT_CEILING_SECONDS = 120;

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === "string" && value.length > 0;
/** A key from the file, safe to put in a warning that a terminal will show. */
const safeKey = (key: string): string => key.replace(/\p{Cc}/gu, "?");

/** An extra rule a library applies to each valid Ref: the field and the reason the Ref is refused, or undefined to accept it. */
export type RefCheck = (ref: Ref) => { field: string; message: string } | undefined;

/** Reads library file text. A file that does not parse is unusable; a Ref that does not validate, or that `refCheck` refuses, is skipped with a warning. */
export function parseLibrary(text: string, file: string, refCheck?: RefCheck): LoadedLibrary | UnusableLibrary {
	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch (error) {
		return { ok: false, error: `${file} does not parse: ${error instanceof Error ? error.message : String(error)}` };
	}
	if (!isObject(data)) return { ok: false, error: `${file} must be a JSON object` };
	if (data.version !== 1) return { ok: false, error: `${file} $.version must be 1` };
	if (data.refs !== undefined && !Array.isArray(data.refs)) return { ok: false, error: `${file} $.refs must be a list` };
	const refs: Ref[] = [];
	const warnings: string[] = [];
	const firstByName = new Map<string, { index: number; name: string }>();
	for (const [index, entry] of (data.refs ?? []).entries()) {
		const checked = checkRef(entry, `$.refs[${index}]`);
		const refused = checked.ref && refCheck?.(checked.ref);
		if (refused) checked.problems.push(`$.refs[${index}].${refused.field}: ${refused.message}`);
		if (!checked.ref || refused) {
			warnings.push(`${file} ${checked.problems.join("; ")}`);
			continue;
		}
		const folded = foldName(checked.ref.name);
		const first = firstByName.get(folded);
		if (first) {
			warnings.push(
				`${file} $.refs[${index}].name: "${checked.ref.name}" repeats "${first.name}" at $.refs[${first.index}], names are case-insensitive; the first one is kept`,
			);
			continue;
		}
		firstByName.set(folded, { index, name: checked.ref.name });
		refs.push(checked.ref);
	}
	return { ok: true, refs, warnings };
}

interface Checked {
	ref?: Ref;
	problems: string[];
}

/** Checks one Ref the way the loader does. A Ref that fails is described by problems that start with `at`. */
export function validateRef(entry: unknown, at: string): { ref: Ref } | { problems: string[] } {
	const checked = checkRef(entry, at);
	return checked.ref ? { ref: checked.ref } : { problems: checked.problems };
}

function checkRef(entry: unknown, at: string): Checked {
	if (!isObject(entry)) return { problems: [`${at}: must be an object`] };
	const problems: string[] = [];
	const problem = (field: string, message: string): void => void problems.push(`${at}${field ? `.${field}` : ""}: ${message}`);
	const name = checkName(entry.name, problem);
	const kind = KINDS.find((candidate) => candidate === entry.kind);
	if (!kind) problem("kind", `must be one of ${KINDS.join(", ")}`);
	for (const key of Object.keys(entry)) {
		if (!EVERY_FIELD.has(key)) problem(safeKey(key), "is not a known field");
		else if (kind && !FIELDS_BY_KIND[kind].includes(key)) problem(key, notUsedBy(key, kind));
	}
	checkCommon(entry, problem);
	if (kind) checkKind(entry, kind, problem);
	if (problems.length > 0 || name === undefined || !kind) return { problems };
	return { problems, ref: { ...entry, name, kind } as Ref };
}

type Report = (field: string, message: string) => void;

const notUsedBy = (key: string, kind: RefKind): string =>
	key === "cwd" && kind === "dynamic" ? "is only used with a command" : `is not used by a ${kind} Ref`;

function checkName(value: unknown, problem: Report): string | undefined {
	const bad = typeof value === "string" ? nameProblem(value) : "is required and must be text";
	if (typeof value !== "string" || bad) {
		problem("name", bad ?? "is required and must be text");
		return undefined;
	}
	return value;
}

function checkCommon(entry: Json, problem: Report): void {
	if (entry.description !== undefined && typeof entry.description !== "string") problem("description", "must be text");
	if (entry.tags !== undefined) checkTags(entry.tags, problem);
	if (entry.scope !== undefined) checkScope(entry.scope, problem);
}

function checkTags(tags: unknown, problem: Report): void {
	if (!Array.isArray(tags)) {
		problem("tags", "must be a list of names");
		return;
	}
	for (const [index, tag] of tags.entries()) {
		const bad = typeof tag === "string" ? nameProblem(tag) : "must be text";
		if (bad) problem(`tags[${index}]`, bad);
	}
}

function checkScope(scope: unknown, problem: Report): void {
	if (!isObject(scope)) {
		problem("scope", "must be an object");
		return;
	}
	if (Object.keys(scope).length === 0) {
		problem("scope", "needs a path, a remote or both");
		return;
	}
	for (const key of Object.keys(scope)) {
		if (key !== "path" && key !== "remote") problem(`scope.${safeKey(key)}`, "is not a known field");
		else if (!isText(scope[key])) problem(`scope.${key}`, "must be non-empty text");
	}
}

function checkKind(entry: Json, kind: RefKind, problem: Report): void {
	if (kind === "path" || kind === "file") {
		if (!isText(entry.path)) problem("path", `is required for a ${kind} Ref and must be non-empty text`);
		if (kind === "file") checkLimit(entry, "max_bytes", MAX_BYTES_CEILING, problem);
	} else if (kind === "snippet") {
		if (!isText(entry.text)) problem("text", "is required for a snippet Ref and must be non-empty text");
	} else {
		checkDynamic(entry, problem);
	}
}

function checkDynamic(entry: Json, problem: Report): void {
	const hasCommand = entry.command !== undefined;
	const hasUrl = entry.url !== undefined;
	if (hasCommand === hasUrl) problem("", "a dynamic Ref needs exactly one of command and url");
	if (hasCommand) checkCommand(entry.command, problem);
	if (hasUrl) checkUrl(entry.url, problem);
	if (hasUrl && entry.cwd !== undefined) problem("cwd", notUsedBy("cwd", "dynamic"));
	else if (entry.cwd !== undefined && !isText(entry.cwd)) problem("cwd", "must be non-empty text");
	checkLimit(entry, "timeout", TIMEOUT_CEILING_SECONDS, problem);
	checkLimit(entry, "max_output", MAX_OUTPUT_CEILING, problem);
}

function checkCommand(command: unknown, problem: Report): void {
	const valid = Array.isArray(command) && command.length > 0 && command.every((part) => typeof part === "string") && isText(command[0]);
	if (!valid) problem("command", "must be a non-empty list of text with a program first");
}

function checkUrl(url: unknown, problem: Report): void {
	const protocol = typeof url === "string" ? URL.parse(url)?.protocol : undefined;
	if (protocol !== "http:" && protocol !== "https:") problem("url", "must be an http or https URL");
}

function checkLimit(entry: Json, field: string, ceiling: number, problem: Report): void {
	const value = entry[field];
	if (value === undefined) return;
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > ceiling) problem(field, `must be a whole number from 1 to ${ceiling}`);
}
