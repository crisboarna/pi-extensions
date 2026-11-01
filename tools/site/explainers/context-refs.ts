// pi-context-refs' ref playground for the site: the package's own core reads a
// library, offers the picker rows, expands a draft message into the text the
// model receives, and collapses it into the transcript line, as a send would.
// Pure and in memory: files come from a map and commands from a canned table
// (git does not run in the page), so the answers are the core's, on made-up
// project data. Import ./buffer-shim.ts first in a page: the core needs Buffer.
import "./buffer-shim.ts";
import { builtinRefs } from "../../../packages/pi-context-refs/src/core/builtins.ts";
import { collapseTail } from "../../../packages/pi-context-refs/src/core/collapse.ts";
import { type ExpandEnv, expandRefs } from "../../../packages/pi-context-refs/src/core/expand.ts";
import type { HeadCut, TruncateHead } from "../../../packages/pi-context-refs/src/core/file-content.ts";
import { parseLibrary } from "../../../packages/pi-context-refs/src/core/library.ts";
import { foldName } from "../../../packages/pi-context-refs/src/core/names.ts";
import { pickerRows } from "../../../packages/pi-context-refs/src/core/picker.ts";
import { formatList, readSettings, settingsProblems } from "../../../packages/pi-context-refs/src/core/ref-list.ts";
import { bundleMembers, type Layer, resolveRefs } from "../../../packages/pi-context-refs/src/core/resolve.ts";
import { findRefTokens } from "../../../packages/pi-context-refs/src/core/tokens.ts";

/** A file's text, or a line repeated `lines` times (`{n}` is the line number) so a big file stays short in the page. */
export type FileSpec = string | { line: string; lines: number };

export interface RefQuestion {
	/** The text of pi-context-refs.json (the Global library). */
	libraryText: string;
	/** The project's files by path relative to the project directory. */
	files: Record<string, FileSpec>;
	/** What a command prints, by its argv joined with spaces (`git diff`). */
	commandOutput: Record<string, string>;
	/** The draft message. */
	message: string;
	/** What is typed after `#` in the picker. */
	query: string;
	/** Whether the project directory is in a git work tree; the Built-in Refs need one. */
	inWorkTree: boolean;
}

export interface TokenReport {
	/** The token as typed, `#api` or `[ref:api]`. */
	text: string;
	/** `resolved` names a Visible Ref or a Bundle with members; `unknown` stays in the message as typed. */
	status: "resolved" | "unknown";
	/** What it resolved to: the Ref's kind, or `bundle`. */
	kind?: string;
}

export interface PickerLine {
	mark: string;
	name: string;
	kind: string;
	description: string;
	section: string;
}

export type RefAnswer =
	| {
			ok: true;
			warnings: string[];
			picker: PickerLine[];
			tokens: TokenReport[];
			/** The message with its inline Refs and the Context blocks after it: what the model receives. */
			text: string;
			/** The same message as the transcript shows it, each block as one line. */
			collapsed: string;
			failures: Array<{ name: string; reason: string }>;
			/** What `/ref list` prints. */
			listText: string;
	  }
	| { ok: false; error: string };

const PROJECT = "/work/project";
const HOME = "/home/you";
const LIBRARY_FILE = "~/.pi/agent/pi-context-refs.json";
const encoder = new TextEncoder();

const fileText = (spec: FileSpec): string =>
	typeof spec === "string" ? spec : Array.from({ length: spec.lines }, (_, index) => spec.line.replaceAll("{n}", String(index + 1))).join("\n");

/** Stands in for pi's truncateHead: keeps whole lines within 2000 lines and 50 KB, or the caps it is given. */
export const truncateHead: TruncateHead = (content, options) => {
	const maxBytes = options?.maxBytes ?? 50 * 1024;
	const maxLines = options?.maxLines ?? 2000;
	const lines = content.split("\n");
	const total = encoder.encode(content).length;
	const whole = (): HeadCut => ({
		content,
		truncated: false,
		truncatedBy: null,
		totalLines: lines.length,
		outputLines: lines.length,
		firstLineExceedsLimit: false,
		maxBytes,
		maxLines,
	});
	if (lines.length <= maxLines && total <= maxBytes) return whole();
	const kept: string[] = [];
	let bytes = 0;
	for (const line of lines) {
		const size = encoder.encode(line).length + (kept.length > 0 ? 1 : 0);
		if (kept.length >= maxLines || bytes + size > maxBytes) break;
		kept.push(line);
		bytes += size;
	}
	return {
		content: kept.join("\n"),
		truncated: true,
		truncatedBy: kept.length >= maxLines ? "lines" : "bytes",
		totalLines: lines.length,
		outputLines: kept.length,
		firstLineExceedsLimit: kept.length === 0,
		maxBytes,
		maxLines,
	};
};

function missing(path: string): Error {
	return Object.assign(new Error(`${path}: no such file`), { code: "ENOENT" });
}

/** The core's outside world: the question's files and canned commands; every command counts as approved, URL Refs are not supported. */
function environment(question: RefQuestion, layers: ReadonlyMap<string, Layer>): ExpandEnv {
	const files = new Map(Object.entries(question.files).map(([path, spec]) => [`${PROJECT}/${path.replace(/^\.?\//, "")}`, fileText(spec)]));
	return {
		cwd: PROJECT,
		home: HOME,
		readFile: async (path, limit) => {
			const text = files.get(path);
			if (text === undefined) throw missing(path);
			return encoder.encode(text).subarray(0, limit);
		},
		truncateHead,
		imageType: async () => null,
		layers,
		approve: async () => ({ allowed: true }),
		runCommand: async (request) => {
			const output = question.commandOutput[request.argv.join(" ")];
			return output === undefined
				? { stdout: "", stderr: `the page has no canned output for "${request.argv.join(" ")}"`, code: 1, killed: false }
				: { stdout: output, stderr: "", code: 0, killed: false };
		},
		isGitWorkTree: async () => question.inWorkTree,
		fetchUrl: async () => {
			throw new Error("URL refs are not supported in the page");
		},
	};
}

export async function explainMessage(question: RefQuestion): Promise<RefAnswer> {
	const library = parseLibrary(question.libraryText, LIBRARY_FILE);
	if (!library.ok) return { ok: false, error: library.error };
	const settings = readSettings(question.libraryText);
	const place = { cwd: PROJECT, home: HOME, realpath: (path: string) => path, remotes: () => [] };
	const layered = resolveRefs({ global: library.refs, project: [], builtin: builtinRefs(settings.builtins) }, place);

	const picker = pickerRows({ visible: layered.visible, layers: layered.layers, inWorkTree: question.inWorkTree }, question.query).map((row) => ({
		mark: row.mark,
		name: row.name,
		kind: row.kind,
		description: row.description,
		section: row.section,
	}));
	const tokens = findRefTokens(question.message).map((token): TokenReport => {
		const text = question.message.slice(token.start, token.end);
		if (token.form === "bundle")
			return bundleMembers(layered.visible, token.target).length > 0 ? { text, status: "resolved", kind: "bundle" } : { text, status: "unknown" };
		const ref = layered.visible.get(foldName(token.target));
		return ref ? { text, status: "resolved", kind: ref.kind } : { text, status: "unknown" };
	});

	const expansion = await expandRefs(question.message, layered.visible, environment(question, layered.layers));
	const listText = formatList({
		file: LIBRARY_FILE,
		refs: library.refs,
		warnings: library.warnings,
		settings,
		sessionTrigger: settings.trigger,
		project: { file: ".pi/pi-context-refs.json", refs: [], warnings: [] },
		place,
		filter: {},
	});
	return {
		ok: true,
		warnings: [...settingsProblems(question.libraryText), ...library.warnings],
		picker,
		tokens,
		text: expansion.text,
		collapsed: collapseTail(expansion.text),
		failures: expansion.failures,
		listText,
	};
}
