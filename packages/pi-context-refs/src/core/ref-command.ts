import { tagProblem } from "./names.ts";

/** One word of a `/ref` line after shell-style quoting. `quoted` is true when the word starts with a quote, so `"desc=x"` is text and `desc="x"` is a field. */
export interface Word {
	text: string;
	quoted: boolean;
}

/** A `key=value` pair of a `/ref` line. `desc` is stored as `description`. */
export interface Field {
	key: string;
	value: string;
}

export type RefCommand =
	| { name: "list"; tag?: string; library?: string }
	| { name: "add"; refName?: string; kind?: string; target: string[]; fields: Field[]; library?: string }
	| { name: "edit"; refName?: string; fields: Field[]; library?: string }
	| { name: "remove"; refName?: string; library?: string };

export type ParsedArguments = { ok: true; command: RefCommand } | { ok: false; error: string; usage?: string };

export const USAGE = {
	list: "/ref list [tag=<tag>] [in=<library>]",
	add: "/ref add <name> <kind> <target…> [desc=<text>] [tags=a,b] [in=<library>] [key=value…]",
	edit: "/ref edit <name> [key=value…]",
	remove: "/ref remove <name> [in=<library>]",
} as const;

export const SUBCOMMANDS = Object.keys(USAGE);

export const SUBCOMMAND_HELP: Record<string, string> = {
	list: "Show the settings, the Refs and any load warnings",
	add: "Save a Ref: /ref add <name> <kind> <target…>",
	edit: "Edit a Ref in the JSON editor, or with key=value",
	remove: "Remove a Ref",
};

export const KINDS = ["path", "file", "snippet", "dynamic"];

/** The libraries `in=` can name. */
export const LIBRARY_NAMES = ["global"];

/** Fields `/ref add` and `/ref edit` take as `key=value`. A word with another key before the `=` is target text in `/ref add`. */
export const ADD_KEYS = ["desc", "description", "tags", "cwd", "max_bytes", "timeout", "max_output", "scope.path", "scope.remote"];
export const EDIT_KEYS = [...ADD_KEYS, "name", "path", "text", "url", "command"];

/** Splits a line into words with shell-style quoting. Nothing is ever run: this is only how the words are cut. */
export function splitWords(line: string): { words: Word[] } | { error: string } {
	const words: Word[] = [];
	let current: Word | undefined;
	let index = 0;
	const append = (character: string): void => {
		current ??= { text: "", quoted: false };
		current.text += character;
	};
	while (index < line.length) {
		const character = line[index] ?? "";
		index += 1;
		if (/\s/.test(character)) {
			if (current) words.push(current);
			current = undefined;
		} else if (character === "'" || character === '"') {
			current ??= { text: "", quoted: true };
			const closed = readQuoted(line, index, character);
			if (closed === undefined) return { error: `a ${character === "'" ? "single" : "double"} quote is not closed` };
			current.text += closed.text;
			index = closed.next;
		} else if (character === "\\" && index < line.length) {
			append(line[index] ?? "");
			index += 1;
		} else {
			append(character);
		}
	}
	if (current) words.push(current);
	return { words };
}

/** The text inside a quote that opened just before `from`, and where reading goes on. Double quotes honour `\"` and `\\`; single quotes are literal. */
function readQuoted(line: string, from: number, quote: string): { text: string; next: number } | undefined {
	let text = "";
	for (let index = from; index < line.length; index += 1) {
		const character = line[index] ?? "";
		if (character === quote) return { text, next: index + 1 };
		const escaped = line[index + 1];
		if (quote === '"' && character === "\\" && (escaped === '"' || escaped === "\\")) {
			text += escaped;
			index += 1;
		} else {
			text += character;
		}
	}
	return undefined;
}

/** Reads the arguments of `/ref`. Missing arguments are left out, not rejected: the caller asks for them in a dialog, or fails with the usage. */
export function parseRefArguments(args: string): ParsedArguments {
	const split = splitWords(args);
	if ("error" in split) {
		const usage = usageFor(args.trim().split(/\s+/)[0] ?? "");
		return { ok: false, error: split.error, ...(usage !== undefined && { usage }) };
	}
	const [first, ...rest] = split.words;
	const subcommand = first?.text ?? "list";
	switch (subcommand) {
		case "list":
			return parseList(rest);
		case "add":
			return parseAdd(rest);
		case "edit":
			return parseEdit(rest);
		case "remove":
			return parseRemove(rest);
		default:
			return { ok: false, error: `unknown subcommand "${subcommand}"`, usage: SUBCOMMANDS.map((name) => USAGE[name as keyof typeof USAGE]).join("\n") };
	}
}

function usageFor(subcommand: string): string | undefined {
	return subcommand in USAGE ? USAGE[subcommand as keyof typeof USAGE] : undefined;
}

const keyOf = (word: Word): string | undefined => (word.quoted ? undefined : /^([a-z_.]+)=/.exec(word.text)?.[1]);
const valueAfter = (word: Word, key: string): string => word.text.slice(key.length + 1);
const normalizeKey = (key: string): string => (key === "desc" ? "description" : key);

type Failure = { ok: false; error: string; usage: string };
const failure = (subcommand: keyof typeof USAGE, error: string): Failure => ({ ok: false, error, usage: USAGE[subcommand] });

function parseList(words: Word[]): ParsedArguments {
	const command: RefCommand = { name: "list" };
	for (const word of words) {
		const key = keyOf(word);
		if (key === "tag") {
			const value = valueAfter(word, key);
			const bad = tagProblem(value);
			if (bad) return failure("list", `tag: ${bad}`);
			command.tag = value;
		} else if (key === "in") command.library = valueAfter(word, key);
		else return failure("list", `unexpected "${word.text}"`);
	}
	return { ok: true, command };
}

function parseAdd(words: Word[]): ParsedArguments {
	const positional: string[] = [];
	const fields: Field[] = [];
	let library: string | undefined;
	for (const word of words) {
		const key = keyOf(word);
		if (key === "in") library = valueAfter(word, key);
		else if (key !== undefined && ADD_KEYS.includes(key)) fields.push({ key: normalizeKey(key), value: valueAfter(word, key) });
		else positional.push(word.text);
	}
	const [refName, kind, ...target] = positional;
	return {
		ok: true,
		command: {
			name: "add",
			...(refName !== undefined && { refName }),
			...(kind !== undefined && { kind }),
			target,
			fields,
			...(library !== undefined && { library }),
		},
	};
}

function parseEdit(words: Word[]): ParsedArguments {
	const [first, ...rest] = words;
	const fields: Field[] = [];
	let library: string | undefined;
	for (const word of rest) {
		const key = keyOf(word);
		if (key === "in") library = valueAfter(word, key);
		else if (key !== undefined && EDIT_KEYS.includes(key)) fields.push({ key: normalizeKey(key), value: valueAfter(word, key) });
		else
			return failure(
				"edit",
				key === undefined
					? `"${word.text}" is not key=value`
					: `"${key}" is not a field you can set; kind is fixed when a Ref is saved, so remove it and add it again`,
			);
	}
	return { ok: true, command: { name: "edit", ...(first !== undefined && { refName: first.text }), fields, ...(library !== undefined && { library }) } };
}

function parseRemove(words: Word[]): ParsedArguments {
	const [first, ...rest] = words;
	let library: string | undefined;
	for (const word of rest) {
		const key = keyOf(word);
		if (key === "in") library = valueAfter(word, key);
		else return failure("remove", `unexpected "${word.text}"`);
	}
	return { ok: true, command: { name: "remove", ...(first !== undefined && { refName: first.text }), ...(library !== undefined && { library }) } };
}
