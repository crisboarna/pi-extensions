import { type Ref, validateRef } from "./library.ts";
import { type Field, splitWords } from "./ref-command.ts";

type Json = Record<string, unknown>;
export type EditResult = { ok: true; ref: Ref } | { ok: false; error: string };

const WHOLE_NUMBER_FIELDS = ["max_bytes", "timeout", "max_output"];

/** A Ref as `/ref add` saves it: the kind decides what the target words mean. Fields set after the target, in the order given. */
export function buildRef(input: { refName: string; kind: string; target: string[]; fields: Field[] }): EditResult {
	const { refName, kind, target } = input;
	const base: Json = { name: refName, kind, ...targetFields(kind, target) };
	return applyFields(base, input.fields);
}

function targetFields(kind: string, target: string[]): Json {
	if (target.length === 0) return {};
	if (kind === "path" || kind === "file") return { path: target.join(" ") };
	if (kind === "snippet") return { text: target.join(" ") };
	if (kind !== "dynamic") return {};
	const [only] = target;
	return target.length === 1 && only !== undefined && /^https?:\/\//i.test(only) ? { url: only } : { command: target };
}

/** The Ref with the fields set, or the reason it cannot be saved. A field with an empty value is removed. The result is checked the way the loader checks a Ref. */
export function applyFields(ref: Json, fields: Field[]): EditResult {
	const next: Json = { ...ref };
	for (const field of fields) {
		const problem = setField(next, field);
		if (problem) return { ok: false, error: problem };
	}
	const checked = validateRef(next, "ref");
	return "ref" in checked ? { ok: true, ref: checked.ref } : { ok: false, error: checked.problems.join("; ") };
}

/** Sets one field on `ref`; returns a problem with the value itself, or undefined. */
function setField(ref: Json, { key, value }: Field): string | undefined {
	if (key.startsWith("scope.")) return setScopeKey(ref, key.slice("scope.".length), value);
	if (value === "" && key !== "name") {
		delete ref[key];
	} else if (key === "tags") {
		ref.tags = value
			.split(",")
			.map((tag) => tag.trim())
			.filter((tag) => tag !== "");
	} else if (key === "command") {
		const split = splitWords(value);
		if ("error" in split) return `command: ${split.error}`;
		ref.command = split.words.map((word) => word.text);
	} else if (WHOLE_NUMBER_FIELDS.includes(key)) {
		if (!/^\d+$/.test(value)) return `${key} must be a whole number`;
		ref[key] = Number(value);
	} else {
		ref[key] = value;
	}
	if (key === "url") delete ref.command;
	if (key === "command") delete ref.url;
	return undefined;
}

function setScopeKey(ref: Json, key: string, value: string): string | undefined {
	const scope: Json = typeof ref.scope === "object" && ref.scope !== null && !Array.isArray(ref.scope) ? { ...ref.scope } : {};
	if (value === "") delete scope[key];
	else scope[key] = value;
	if (Object.keys(scope).length === 0) delete ref.scope;
	else ref.scope = scope;
	return undefined;
}

/** A Ref as the JSON editor shows it. */
export function jsonOf(ref: unknown): string {
	return JSON.stringify(ref, null, 2);
}
