// Generates media/src/data.json (and data.js for the pages): what the README
// animations and the cover show, produced by the package's real core on the
// demo repository and library, so every row, block and size on screen is one
// pi-context-refs would produce.
//
//   node media/data.ts
//
// Called by: package.json ("media" script); read by media/src/*.html.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builtinRefs } from "../src/core/builtins.ts";
import { collapseTail, formatSize, parseTailBlocks } from "../src/core/collapse.ts";
import { type ExpandEnv, expandRefs } from "../src/core/expand.ts";
import type { HeadCut } from "../src/core/file-content.ts";
import { validateRef } from "../src/core/library.ts";
import { pickerRows } from "../src/core/picker.ts";
import { resolveRefs } from "../src/core/resolve.ts";
import { createDemoRepository, LIBRARY } from "./terminal/setup.ts";

const dir = mkdtempSync(join(tmpdir(), "context-refs-media-"));
createDemoRepository(dir);

const refs = LIBRARY.map((entry, index) => {
	const checked = validateRef(entry, `refs[${index}]`);
	if ("problems" in checked) throw new Error(`demo ref ${entry.name} is invalid: ${checked.problems.join("; ")}`);
	return checked.ref;
});
const layered = resolveRefs({ global: refs, project: [], builtin: builtinRefs(true) }, { cwd: dir, home: dir, realpath: (path) => path, remotes: () => [] });

const truncateHead = (content: string): HeadCut => {
	const lines = content.split("\n").length;
	return {
		content,
		truncated: false,
		truncatedBy: null,
		totalLines: lines,
		outputLines: lines,
		firstLineExceedsLimit: false,
		maxBytes: 50 * 1024,
		maxLines: 2000,
	};
};
const env: ExpandEnv = {
	cwd: dir,
	home: dir,
	readFile: async (path, limit) => readFileSync(path).subarray(0, limit),
	truncateHead,
	imageType: async () => null,
	layers: layered.layers,
	approve: async () => ({ allowed: true }),
	runCommand: async (request) => {
		const [command, ...args] = request.argv;
		const run = spawnSync(command ?? "", args, { cwd: request.cwd, encoding: "utf8" });
		return { stdout: run.stdout, stderr: run.stderr, code: run.status ?? 1, killed: false };
	},
	isGitWorkTree: async () => true,
	fetchUrl: async () => {
		throw new Error("the demo has no URL refs");
	},
};

/** A message expanded the way a send would, with its transcript form and the blocks it carries. */
async function send(message: string) {
	const expansion = await expandRefs(message, layered.visible, env);
	const { prose, blocks } = parseTailBlocks(expansion.text);
	const bodies = expansion.text
		.split(/<context-ref [^>]*>\n/)
		.slice(1)
		.map((part) => part.split("\n</context-ref>")[0] ?? "");
	return {
		message,
		prose: prose.trimEnd(),
		blocks: blocks.map((block, index) => ({
			name: block.name,
			kind: block.kind,
			size: formatSize(block.bytes),
			head: (bodies[index] ?? "").split("\n").slice(0, 7),
		})),
		collapsed: collapseTail(expansion.text).split("\n").filter(Boolean),
	};
}

const rows = pickerRows({ visible: layered.visible, layers: layered.layers, inWorkTree: true }, "").map((row) => ({
	mark: row.mark,
	name: row.name,
	kind: row.kind,
	description: row.description,
	section: row.section,
}));
const typed = await send("Why does [ref:api] retry twice?");
const builtin = await send("Review #diff");
const first = typed.collapsed.at(-1) ?? "";
const data = {
	picker: { rows },
	typed,
	builtin,
	cover: `Why does [ref:api] retry twice?  ${first}`,
};
rmSync(dir, { recursive: true, force: true });
const json = JSON.stringify(data, null, "\t");
writeFileSync(join(import.meta.dirname, "src", "data.json"), `${json}\n`);
// Pages opened from file:// cannot fetch JSON, so they load the same data as a one-line script; data.json is the readable copy.
writeFileSync(join(import.meta.dirname, "src", "data.js"), `window.MEDIA = ${JSON.stringify(data)};\n`);
console.log(`media data: ${data.cover}`);
