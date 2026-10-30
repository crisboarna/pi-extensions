import { createHash } from "node:crypto";
import type { LibraryFile, WriteResult } from "./config-writer.ts";
import { type CommandRef, commandText, isCommandRef } from "./dynamic.ts";
import { foldName } from "./names.ts";
import type { UrlRef } from "./url.ts";

/** The schema an approvals file points to, so an editor can validate it. */
export const APPROVALS_SCHEMA_URL =
	"https://raw.githubusercontent.com/crisboarna/pi-extensions/main/packages/pi-context-refs/schema/pi-context-refs-approvals.schema.json";

/** What an Approval covers: the Source and what it runs or fetches. Nothing else about the Ref (name, limits, description) counts. */
export type Definition = { source: "command"; argv: string[]; cwd: string } | { source: "url"; url: string };

/** One Approval as the approvals file holds it. `definition` is `definitionText` of what was approved, for `/ref approvals`. */
export interface Approval {
	/** The canonical path of the project. */
	project: string;
	name: string;
	/** `hashDefinition` of the approved definition. */
	hash: string;
	definition: string;
	/** An ISO timestamp. */
	approvedAt: string;
}

export type ApprovalState = "approved" | "pending";

/** A Project library Dynamic Ref that is about to run, and its definition. */
export interface ApprovalRequest {
	ref: CommandRef | UrlRef;
	definition: Definition;
}

/** Whether a Dynamic Ref may run. A refusal says why, in words that go into the Failure note. */
export type Verdict = { allowed: true } | { allowed: false; reason: string };

/** The definition of a Dynamic Ref. `cwd` is the absolute directory a command runs in. */
export function definitionOf(ref: CommandRef | UrlRef, cwd: string): Definition {
	return isCommandRef(ref) ? { source: "command", argv: ref.command, cwd } : { source: "url", url: ref.url };
}

/** The SHA-256, in hex, of the definition as JSON with a fixed order of keys, so an argument can never run into the next one. */
export function hashDefinition(definition: Definition): string {
	const canonical =
		definition.source === "command" ? { source: "command", argv: definition.argv, cwd: definition.cwd } : { source: "url", url: definition.url };
	return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/** Control characters written as `\u00XX`, so text from a repository cannot move the cursor or recolour a dialog. */
const visible = (text: string): string => text.replace(/\p{Cc}/gu, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);

/** The definition as the lines an Approval dialog shows. */
export function definitionLines(definition: Definition): string[] {
	if (definition.source === "url") return ["source: url", `url: ${visible(definition.url)}`];
	return ["source: command", `argv: ${visible(commandText(definition.argv))}`, `cwd: ${visible(definition.cwd)}`];
}

/** The definition on one line, for lists. */
export function definitionText(definition: Definition): string {
	if (definition.source === "url") return `url ${visible(definition.url)}`;
	return `command ${visible(commandText(definition.argv))} (in ${visible(definition.cwd)})`;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const isApproval = (value: unknown): value is Approval =>
	isObject(value) && ["project", "name", "hash", "definition", "approvedAt"].every((key) => typeof value[key] === "string");

type Loaded = { ok: true; document: Record<string, unknown>; entries: unknown[] } | { ok: false; error: string };

function loadDocument(file: LibraryFile): Loaded {
	const fail = (reason: string): Loaded => ({ ok: false, error: `${file.path} ${reason}` });
	let text: string | undefined;
	try {
		text = file.read();
	} catch (error) {
		return fail(`could not be read: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (text === undefined) return { ok: true, document: { version: 1, $schema: APPROVALS_SCHEMA_URL }, entries: [] };
	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch (error) {
		return fail(`does not parse: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!isObject(data)) return fail("must be a JSON object");
	if (data.version !== 1) return fail("$.version must be 1");
	if (data.approvals !== undefined && !Array.isArray(data.approvals)) return fail("$.approvals must be a list");
	return { ok: true, document: data, entries: data.approvals ?? [] };
}

/** The Approvals on disk right now, or why the file cannot be used. Entries that are not Approvals are left out. */
export function readApprovals(file: LibraryFile): { ok: true; approvals: Approval[] } | { ok: false; error: string } {
	const loaded = loadDocument(file);
	return loaded.ok ? { ok: true, approvals: loaded.entries.filter(isApproval) } : loaded;
}

/**
 * The one way the package changes the approvals file: re-read, change, write atomically. Refuses, writing nothing, when the file does not parse.
 * Keys this version does not know, and entries it cannot read, are kept as they are.
 */
export function updateApprovals(file: LibraryFile, change: (approvals: Approval[]) => Approval[]): WriteResult {
	const loaded = loadDocument(file);
	if (!loaded.ok) return loaded;
	const changed = change(loaded.entries.filter(isApproval));
	const document = { ...loaded.document, approvals: [...loaded.entries.filter((entry) => !isApproval(entry)), ...changed] };
	try {
		file.write(`${JSON.stringify(document, null, 2)}\n`);
	} catch (error) {
		return { ok: false, error: `${file.path} could not be written: ${error instanceof Error ? error.message : String(error)}` };
	}
	return { ok: true };
}

/** Whether this exact definition of the Ref (names are case-insensitive) is approved for the project. */
export function approvalState(approvals: readonly Approval[], project: string, name: string, hash: string): ApprovalState {
	const folded = foldName(name);
	return approvals.some((approval) => approval.project === project && foldName(approval.name) === folded && approval.hash === hash) ? "approved" : "pending";
}

/** The Approvals of one project. */
export const approvalsFor = (approvals: readonly Approval[], project: string): Approval[] => approvals.filter((approval) => approval.project === project);

/** The list with the Approval added, replacing any Approval of the same project and Ref name, so a changed definition leaves no old consent behind. */
export function withApproval(approvals: readonly Approval[], approval: Approval): Approval[] {
	return [...withoutApprovals(approvals, approval.project, approval.name), approval];
}

/** The list without the Approvals of `name` in the project, or without every Approval of the project when there is no name. */
export function withoutApprovals(approvals: readonly Approval[], project: string, name?: string): Approval[] {
	const folded = name === undefined ? undefined : foldName(name);
	return approvals.filter((approval) => approval.project !== project || (folded !== undefined && foldName(approval.name) !== folded));
}
