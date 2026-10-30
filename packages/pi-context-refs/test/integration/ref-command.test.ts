import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createJiti } from "jiti";
import { createFakeHost, createFakeSession } from "../support/fake-pi.ts";

const INDEX = join(import.meta.dirname, "..", "..", "src", "index.ts");

let agentDir = "";
let project = "";
const realStderrWrite = process.stderr.write.bind(process.stderr);

beforeEach(() => {
	const root = mkdtempSync(join(tmpdir(), "context-refs-command-"));
	agentDir = join(root, "agent");
	project = join(root, "project");
	mkdirSync(agentDir);
	mkdirSync(project);
	process.env.PI_CODING_AGENT_DIR = agentDir;
});

afterEach(() => {
	process.stderr.write = realStderrWrite;
	rmSync(join(agentDir, ".."), { recursive: true, force: true });
});

const libraryFile = () => join(agentDir, "pi-context-refs.json");
const writeLibrary = (document: Record<string, unknown>) => writeFileSync(libraryFile(), JSON.stringify({ version: 1, ...document }));
const readLibrary = () =>
	JSON.parse(readFileSync(libraryFile(), "utf8")) as { version: number; $schema?: string; refs: Array<Record<string, unknown>> } & Record<string, unknown>;
const refNames = () => readLibrary().refs.map((ref) => ref.name);

/** Loads the extension through jiti, as pi does, and runs its factory against a fake host. */
async function boot() {
	const jiti = createJiti(import.meta.url, { moduleCache: false });
	// The coverage run imports natively: V8 coverage cannot map code that jiti transforms back to the source files.
	const factory = (
		process.env.CONTEXT_REFS_NATIVE_IMPORT === "1" ? ((await import(INDEX)) as { default: unknown }).default : await jiti.import(INDEX, { default: true })
	) as (pi: unknown) => unknown;
	const host = createFakeHost();
	await factory(host.pi);
	return host;
}

type Host = Awaited<ReturnType<typeof boot>>;
type Dialogs = Partial<{
	confirm: (title: string, message: string) => Promise<boolean>;
	select: (title: string, options: string[]) => Promise<string | undefined>;
	input: (title: string, placeholder?: string) => Promise<string | undefined>;
	editor: (title: string, prefill?: string) => Promise<string | undefined>;
}>;

/** A session. With `dialogs` it has a UI (the TUI or RPC) and those dialogs answer; without, it is print or JSON mode. */
function session(dialogs?: Dialogs) {
	const fake = createFakeSession({ cwd: project, hasUI: dialogs !== undefined });
	Object.assign(fake.ctx.ui, dialogs ?? {});
	return fake;
}

/** Runs `/ref <args>`; returns what went to stderr. */
async function ref(host: Host, fake: ReturnType<typeof session>, args: string): Promise<string> {
	const chunks: string[] = [];
	process.stderr.write = ((chunk: string | Uint8Array) => {
		chunks.push(String(chunk));
		return true;
	}) as typeof process.stderr.write;
	try {
		await host.commands.get("ref")?.handler(args, fake.ctx);
	} finally {
		process.stderr.write = realStderrWrite;
	}
	return chunks.join("");
}

const sent = async (host: Host, fake: ReturnType<typeof session>, text: string) =>
	(await host.fire("input", { type: "input", text, source: "interactive" }, fake.ctx)) as { text: string } | undefined;

const last = (fake: ReturnType<typeof session>) => fake.notices.at(-1);

describe("/ref registration", () => {
	it("registers the ref command and no longer the scaffold's stub", async () => {
		const host = await boot();
		assert.equal(host.commands.has("ref"), true);
		assert.equal(host.commands.has("context-refs"), false);
	});

	it("completes subcommands, Ref names, kinds and in= values", async () => {
		writeLibrary({ refs: [{ name: "api", kind: "path", path: "a" }] });
		const host = await boot();
		const command = host.commands.get("ref") as unknown as { getArgumentCompletions(prefix: string): Array<{ value: string }> | null };
		assert.deepEqual(
			command.getArgumentCompletions("")?.map((item) => item.value),
			["list", "add", "edit", "remove"],
		);
		assert.deepEqual(
			command.getArgumentCompletions("edit a")?.map((item) => item.value),
			["edit api"],
		);
		assert.deepEqual(
			command.getArgumentCompletions("add x f")?.map((item) => item.value),
			["add x file"],
		);
		assert.deepEqual(
			command.getArgumentCompletions("remove api in=")?.map((item) => item.value),
			["remove api in=global"],
		);
	});

	it("completes with no Ref names when the library is missing or does not parse", async () => {
		const host = await boot();
		const command = host.commands.get("ref") as unknown as { getArgumentCompletions(prefix: string): unknown };
		assert.equal(command.getArgumentCompletions("edit "), null);
		writeFileSync(libraryFile(), "{ half saved");
		assert.equal(command.getArgumentCompletions("edit "), null);
	});
});

describe("/ref list", () => {
	const refs = [
		{ name: "api", kind: "file", path: "src/api.ts", tags: ["docs"] },
		{ name: "terse", kind: "snippet", text: "Be brief." },
	];

	it("prints one block to stderr in print mode and through notify in the TUI and RPC, the same text", async () => {
		writeLibrary({ trigger: "$", refs });
		const host = await boot();
		const print = session();
		await host.fire("session_start", { type: "session_start", reason: "startup" }, print.ctx);
		const stderr = await ref(host, print, "");
		assert.deepEqual(print.notices, []);
		assert.match(stderr, /Global library .*pi-context-refs\.json \(2 Refs\)/);
		assert.match(stderr, /^ {2}api {2}file {2}\[docs\] {2}src\/api\.ts$/m);
		assert.match(stderr, /^ {2}terse {2}snippet {2}"Be brief\."$/m);
		assert.match(stderr, /^trigger: \$$/m);

		const tui = session({});
		await host.fire("session_start", { type: "session_start", reason: "startup" }, tui.ctx);
		assert.equal(await ref(host, tui, "list"), "");
		assert.equal(tui.notices.length, 1);
		assert.equal(`${tui.notices[0]?.message}\n`, stderr);
	});

	it("shows settings defaults and an empty library when the file is missing", async () => {
		const host = await boot();
		const stderr = await ref(host, session(), "list");
		assert.match(stderr, /^trigger: #$/m);
		assert.match(stderr, /^builtins: on$/m);
		assert.match(stderr, /\(no Refs\)/);
	});

	it("notes that a trigger changed since the session started needs /reload", async () => {
		writeLibrary({ refs });
		const host = await boot();
		const fake = session({});
		await host.fire("session_start", { type: "session_start", reason: "startup" }, fake.ctx);
		writeLibrary({ trigger: "$", refs });
		await ref(host, fake, "");
		assert.match(last(fake)?.message ?? "", /^trigger: \$ in the file, # in this session; run \/reload to use it$/m);
	});

	it("filters by tag and by library", async () => {
		writeLibrary({ refs });
		const host = await boot();
		const tagged = await ref(host, session(), "list tag=docs");
		assert.match(tagged, /^ {2}api /m);
		assert.doesNotMatch(tagged, /^ {2}terse /m);
		assert.match(await ref(host, session(), "list in=global"), /^ {2}terse /m);
		assert.match(await ref(host, session(), "list in=elsewhere"), /unknown library "elsewhere"; the libraries are: global/);
	});

	it("lists load warnings, and a file that does not parse", async () => {
		writeLibrary({ refs: [{ name: "bad name", kind: "snippet", text: "x" }, ...refs] });
		const host = await boot();
		assert.match(await ref(host, session(), ""), /Warnings:\n {2}.*pi-context-refs\.json \$\.refs\[0\]\.name: /);
		writeFileSync(libraryFile(), "{ half saved");
		assert.match(await ref(host, session(), ""), /pi-context-refs\.json does not parse: .*; no Refs are loaded/);
	});

	it("shows a file that cannot be read as a warning", async () => {
		mkdirSync(libraryFile());
		const host = await boot();
		assert.match(await ref(host, session(), ""), /pi-context-refs\.json could not be read: .*; no Refs are loaded/);
	});
});

describe("/ref add", () => {
	it("saves each kind to the Global library, creating the file with version, $schema and a 2-space indent", async () => {
		const host = await boot();
		const fake = session();
		await ref(host, fake, "add agents path AGENTS.md");
		await ref(host, fake, "add api file src/api.ts max_bytes=2048");
		await ref(host, fake, 'add terse snippet "Answer in one sentence." desc="Keep it short" tags=style,short');
		await ref(host, fake, "add page dynamic https://example.com/status");
		const text = readFileSync(libraryFile(), "utf8");
		assert.match(text, /^\{\n {2}"version": 1,\n {2}"\$schema": "https:\/\/.*pi-context-refs\.schema\.json",\n {2}"refs": \[\n/);
		assert.ok(text.endsWith("}\n"));
		assert.deepEqual(readLibrary().refs, [
			{ name: "agents", kind: "path", path: "AGENTS.md" },
			{ name: "api", kind: "file", path: "src/api.ts", max_bytes: 2048 },
			{ name: "terse", kind: "snippet", text: "Answer in one sentence.", description: "Keep it short", tags: ["style", "short"] },
			{ name: "page", kind: "dynamic", url: "https://example.com/status" },
		]);
		assert.deepEqual(readdirSync(agentDir), ["pi-context-refs.json"], "no temporary file is left");
	});

	it("reports what it saved, to stderr in print mode and through notify in the TUI", async () => {
		const host = await boot();
		assert.match(await ref(host, session(), "add a path x"), /Added path Ref "a" to the Global library/);
		const tui = session({});
		await ref(host, tui, "add b path x");
		assert.deepEqual(last(tui), { message: 'Added path Ref "b" to the Global library', type: "info" });
	});

	it("reloads this session's library at once, so the new Ref expands in the next message", async () => {
		const host = await boot();
		const fake = session({});
		await ref(host, fake, 'add terse snippet "Answer in one sentence."');
		assert.deepEqual(await sent(host, fake, "Explain #terse"), { action: "transform", text: "Explain Answer in one sentence." });
	});

	it("stores a Dynamic command as an argv array parsed with shell-style quoting and runs nothing", async () => {
		const host = await boot();
		const marker = join(project, "ran");
		await ref(host, session(), `add danger dynamic sh -c "echo hi > ${marker}; echo $(whoami) | cat" timeout=5`);
		assert.deepEqual(readLibrary().refs, [
			{ name: "danger", kind: "dynamic", command: ["sh", "-c", `echo hi > ${marker}; echo $(whoami) | cat`], timeout: 5 },
		]);
		assert.equal(existsSync(marker), false);
	});

	it("keeps version, $schema, the settings and unknown keys, and Refs that are invalid", async () => {
		const bad = { name: "bad name", kind: "snippet", text: "x" };
		writeFileSync(
			libraryFile(),
			'{"$schema":"mine","version":1,"trigger":"$","builtins":["log"],"future":{"a":1},"refs":[{"name":"bad name","kind":"snippet","text":"x"}]}',
		);
		const host = await boot();
		await ref(host, session(), "add a path x");
		const document = readLibrary();
		assert.deepEqual(Object.keys(document), ["$schema", "version", "trigger", "builtins", "future", "refs"]);
		assert.equal(document.$schema, "mine");
		assert.deepEqual(document.future, { a: 1 });
		assert.deepEqual(document.refs, [bad, { name: "a", kind: "path", path: "x" }]);
	});

	it("refuses a name that is already in the library, whatever its case, pointing to /ref edit, and overwrites nothing", async () => {
		writeLibrary({ refs: [{ name: "API", kind: "path", path: "a" }] });
		const before = readFileSync(libraryFile(), "utf8");
		const host = await boot();
		const stderr = await ref(host, session(), "add api path b");
		assert.match(stderr, /"api" is already in the Global library as "API"; change it with \/ref edit API/);
		assert.equal(readFileSync(libraryFile(), "utf8"), before);
	});

	it("refuses to write a file that does not parse, and leaves it as it was", async () => {
		writeFileSync(libraryFile(), "{ half saved");
		const host = await boot();
		const stderr = await ref(host, session(), "add a path x");
		assert.match(stderr, /pi-context-refs\.json does not parse/);
		assert.equal(readFileSync(libraryFile(), "utf8"), "{ half saved");
	});

	it("reports an invalid Ref with the field, and writes nothing", async () => {
		const host = await boot();
		assert.match(await ref(host, session(), "add bad! path x"), /ref\.name: /);
		assert.match(await ref(host, session(), "add x folder y"), /ref\.kind: must be one of path, file, snippet, dynamic/);
		assert.match(await ref(host, session(), "add x snippet y max_bytes=5"), /ref\.max_bytes: is not used by a snippet Ref/);
		assert.equal(existsSync(libraryFile()), false);
	});

	it("rejects a library other than the Global one", async () => {
		const host = await boot();
		const stderr = await ref(host, session(), "add a path x in=project");
		assert.match(stderr, /unknown library "project"; the libraries are: global/);
		assert.equal(existsSync(libraryFile()), false);
	});

	it("fails with its usage when arguments are missing and there is no UI", async () => {
		const host = await boot();
		for (const args of ["add", "add a", "add a path"]) {
			const stderr = await ref(host, session(), args);
			assert.match(stderr, /\/ref add <name> <kind> <target…>/, args);
		}
		assert.equal(existsSync(libraryFile()), false);
	});

	it("shows the usage for a quote that is not closed", async () => {
		const host = await boot();
		const stderr = await ref(host, session(), 'add a snippet "oops');
		assert.match(stderr, /a double quote is not closed/);
		assert.match(stderr, /\/ref add <name> <kind> <target…>/);
	});

	it("asks in dialogs for what is missing when there is a UI", async () => {
		const asked: string[] = [];
		const fake = session({
			input: async (title) => {
				asked.push(title);
				return title.startsWith("Name") ? "log" : "git log --oneline -5";
			},
			select: async (title, options) => {
				asked.push(`${title}: ${options.join(",")}`);
				return "dynamic";
			},
		});
		const host = await boot();
		await ref(host, fake, "add");
		assert.deepEqual(readLibrary().refs, [{ name: "log", kind: "dynamic", command: ["git", "log", "--oneline", "-5"] }]);
		assert.equal(asked.length, 3);
		assert.match(asked[1] ?? "", /^Kind: path,file,snippet,dynamic$/);
	});

	it("stops quietly when a dialog is cancelled", async () => {
		const fake = session({ input: async () => undefined, select: async () => undefined });
		const host = await boot();
		await ref(host, fake, "add");
		assert.equal(existsSync(libraryFile()), false);
		assert.deepEqual(last(fake), { message: "Cancelled; nothing was saved", type: "info" });
	});
});

describe("/ref edit", () => {
	const refs = () => [
		{ name: "api", kind: "file", path: "src/api.ts", description: "The API" },
		{ name: "terse", kind: "snippet", text: "Be brief." },
	];

	it("changes fields headless with key=value, keeping the rest of the file", async () => {
		writeLibrary({ trigger: "$", refs: refs() });
		const host = await boot();
		const stderr = await ref(host, session(), "edit api path=src/v2.ts tags=a,b desc=");
		assert.match(stderr, /Edited file Ref "api"/);
		const document = readLibrary();
		assert.equal(document.trigger, "$");
		assert.deepEqual(document.refs[0], { name: "api", kind: "file", path: "src/v2.ts", tags: ["a", "b"] });
		assert.deepEqual(document.refs[1], refs()[1]);
	});

	it("renames a Ref unless the new name clashes with another, whatever its case", async () => {
		writeLibrary({ refs: refs() });
		const host = await boot();
		assert.match(await ref(host, session(), "edit api name=TERSE"), /"TERSE" is already in the Global library as "terse"; edit that one instead/);
		assert.deepEqual(refNames(), ["api", "terse"]);
		assert.match(await ref(host, session(), "edit api name=api2"), /Renamed "api" to "api2"/);
		assert.deepEqual(refNames(), ["api2", "terse"]);
		assert.match(await ref(host, session(), "edit api2 name=API2"), /Renamed|Edited/, "changing only the case is not a clash with itself");
		assert.deepEqual(refNames(), ["API2", "terse"]);
	});

	it("reports a value that makes the Ref invalid and writes nothing", async () => {
		writeLibrary({ refs: refs() });
		const before = readFileSync(libraryFile(), "utf8");
		const host = await boot();
		assert.match(await ref(host, session(), "edit api url=http://x"), /ref\.url: is not used by a file Ref/);
		assert.match(await ref(host, session(), "edit api max_bytes=lots"), /max_bytes must be a whole number/);
		assert.match(await ref(host, session(), "edit api kind=path"), /"kind" is not a field you can set/);
		assert.equal(readFileSync(libraryFile(), "utf8"), before);
	});

	it("says when no Ref has the name", async () => {
		writeLibrary({ refs: refs() });
		const host = await boot();
		assert.match(await ref(host, session(), "edit nope path=x"), /no Ref named "nope" in the Global library/);
	});

	it("fails with its usage when there is no UI and nothing says what to change", async () => {
		writeLibrary({ refs: refs() });
		const host = await boot();
		assert.match(await ref(host, session(), "edit api"), /\/ref edit <name> \[key=value…\]/);
		assert.match(await ref(host, session(), "edit"), /\/ref edit <name> \[key=value…\]/);
	});

	it("opens the Ref as pretty JSON in the editor and saves what was edited", async () => {
		writeLibrary({ refs: refs() });
		const seen: Array<{ title: string; prefill?: string }> = [];
		const fake = session({
			editor: async (title, prefill) => {
				seen.push({ title, ...(prefill !== undefined && { prefill }) });
				return prefill?.replace("src/api.ts", "src/other.ts");
			},
		});
		const host = await boot();
		await ref(host, fake, "edit api");
		assert.equal(seen.length, 1);
		assert.equal(seen[0]?.prefill, JSON.stringify(refs()[0], null, 2));
		assert.deepEqual(readLibrary().refs[0], { name: "api", kind: "file", path: "src/other.ts", description: "The API" });
		assert.match(last(fake)?.message ?? "", /Edited file Ref "api"/);
	});

	it("reopens the editor with the error and the edited text when the result is invalid or does not parse, until it is valid", async () => {
		writeLibrary({ refs: refs() });
		const seen: Array<{ title: string; prefill?: string }> = [];
		const answers = [
			'{ "name": "api", "kind": "file" ',
			JSON.stringify({ name: "api", kind: "file", path: "" }),
			JSON.stringify({ name: "terse", kind: "file", path: "x" }),
			JSON.stringify({ name: "api", kind: "file", path: "ok.ts" }),
		];
		const fake = session({
			editor: async (title, prefill) => {
				seen.push({ title, ...(prefill !== undefined && { prefill }) });
				return answers[seen.length - 1];
			},
		});
		const host = await boot();
		await ref(host, fake, "edit api");
		assert.equal(seen.length, 4);
		assert.match(seen[1]?.title ?? "", /not valid JSON/);
		assert.equal(seen[1]?.prefill, answers[0]);
		assert.match(seen[2]?.title ?? "", /ref\.path: /);
		assert.match(seen[3]?.title ?? "", /"terse" is already in the Global library/);
		assert.equal(seen[3]?.prefill, answers[2]);
		assert.deepEqual(readLibrary().refs[0], { name: "api", kind: "file", path: "ok.ts" });
	});

	it("changes nothing when the editor is cancelled or the text is untouched", async () => {
		writeLibrary({ refs: refs() });
		const before = readFileSync(libraryFile(), "utf8");
		const host = await boot();
		const cancelled = session({ editor: async () => undefined });
		await ref(host, cancelled, "edit api");
		assert.deepEqual(last(cancelled), { message: "Cancelled; nothing was changed", type: "info" });
		const untouched = session({ editor: async (_title, prefill) => prefill });
		await ref(host, untouched, "edit api");
		assert.deepEqual(last(untouched), { message: 'Nothing changed in "api"', type: "info" });
		assert.equal(readFileSync(libraryFile(), "utf8"), before);
	});

	it("stops when the file does not parse by the time the editor returns", async () => {
		writeLibrary({ refs: refs() });
		const fake = session({
			editor: async (_title, prefill) => {
				writeFileSync(libraryFile(), "{ half saved");
				return prefill?.replace("The API", "New");
			},
		});
		const host = await boot();
		await ref(host, fake, "edit api");
		assert.match(last(fake)?.message ?? "", /pi-context-refs\.json does not parse/);
		assert.equal(readFileSync(libraryFile(), "utf8"), "{ half saved");
	});

	it("says so when the Ref was removed while the editor was open", async () => {
		writeLibrary({ refs: refs() });
		const fake = session({
			editor: async (_title, prefill) => {
				writeLibrary({ refs: [refs()[1]] });
				return prefill?.replace("The API", "New");
			},
		});
		const host = await boot();
		await ref(host, fake, "edit api");
		assert.match(last(fake)?.message ?? "", /no Ref named "api" in the Global library/);
	});

	it("asks which Ref when the name is missing and there is a UI", async () => {
		writeLibrary({ refs: refs() });
		let options: string[] = [];
		const fake = session({
			select: async (_title, choices) => {
				options = choices;
				return "terse";
			},
			editor: async (_title, prefill) => prefill?.replace("Be brief.", "Be very brief."),
		});
		const host = await boot();
		await ref(host, fake, "edit");
		assert.deepEqual(options, ["api", "terse"]);
		assert.equal(readLibrary().refs[1]?.text, "Be very brief.");
	});
});

describe("/ref remove", () => {
	const refs = () => [
		{ name: "api", kind: "file", path: "src/api.ts" },
		{ name: "terse", kind: "snippet", text: "Be brief." },
		{ name: "log", kind: "dynamic", command: ["git", "log"] },
	];

	it("confirms in the TUI showing the kind, the library and the target, and removes on yes", async () => {
		writeLibrary({ trigger: "$", refs: refs() });
		const asked: Array<{ title: string; message: string }> = [];
		const fake = session({
			confirm: async (title, message) => {
				asked.push({ title, message });
				return true;
			},
		});
		const host = await boot();
		await ref(host, fake, "remove terse");
		assert.equal(asked.length, 1);
		assert.match(asked[0]?.title ?? "", /Remove "terse"\?/);
		assert.match(asked[0]?.message ?? "", /snippet/);
		assert.match(asked[0]?.message ?? "", /Global library/);
		assert.match(asked[0]?.message ?? "", /"Be brief\."/);
		assert.match(asked[0]?.message ?? "", /lost for good/);
		assert.deepEqual(refNames(), ["api", "log"]);
		assert.equal(readLibrary().trigger, "$");
		assert.deepEqual(last(fake), { message: 'Removed "terse" from the Global library', type: "info" });
	});

	it("keeps the Ref when the confirm is refused", async () => {
		writeLibrary({ refs: refs() });
		const fake = session({ confirm: async () => false });
		const host = await boot();
		await ref(host, fake, "remove api");
		assert.deepEqual(refNames(), ["api", "terse", "log"]);
		assert.deepEqual(last(fake), { message: 'Kept "api"', type: "info" });
	});

	it("runs as typed with no UI", async () => {
		writeLibrary({ refs: refs() });
		const host = await boot();
		const stderr = await ref(host, session(), "remove API in=global");
		assert.match(stderr, /Removed "api" from the Global library/);
		assert.deepEqual(refNames(), ["terse", "log"]);
	});

	it("stops expanding a removed Ref in the next message", async () => {
		writeLibrary({ refs: refs() });
		const host = await boot();
		const fake = session();
		assert.deepEqual(await sent(host, fake, "#terse"), { action: "transform", text: "Be brief." });
		await ref(host, fake, "remove terse");
		assert.equal(await sent(host, fake, "#terse"), undefined);
	});

	it("says when no Ref has the name, and fails with its usage when the name is missing and there is no UI", async () => {
		writeLibrary({ refs: refs() });
		const host = await boot();
		assert.match(await ref(host, session(), "remove nope"), /no Ref named "nope" in the Global library/);
		assert.match(await ref(host, session(), "remove"), /\/ref remove <name> \[in=<library>\]/);
		assert.deepEqual(refNames(), ["api", "terse", "log"]);
	});

	it("refuses a file that does not parse and leaves it as it was", async () => {
		writeFileSync(libraryFile(), "{ half saved");
		const host = await boot();
		assert.match(await ref(host, session(), "remove api"), /pi-context-refs\.json does not parse/);
		assert.equal(readFileSync(libraryFile(), "utf8"), "{ half saved");
	});

	it("asks which Ref when the name is missing and there is a UI", async () => {
		writeLibrary({ refs: refs() });
		const fake = session({ select: async () => "log", confirm: async () => true });
		const host = await boot();
		await ref(host, fake, "remove");
		assert.deepEqual(refNames(), ["api", "terse"]);
	});

	it("can remove an entry that is not a valid Ref, showing what it holds", async () => {
		writeLibrary({ refs: [{ name: "bad name", kind: "snippet", text: "x" }] });
		let message = "";
		const fake = session({
			confirm: async (_title, text) => {
				message = text;
				return true;
			},
		});
		const host = await boot();
		await ref(host, fake, 'remove "bad name"');
		assert.match(message, /not a valid Ref/);
		assert.deepEqual(readLibrary().refs, []);
	});
});

describe("/ref unknown subcommand", () => {
	it("lists the usage", async () => {
		const host = await boot();
		const stderr = await ref(host, session(), "frobnicate");
		assert.match(stderr, /unknown subcommand "frobnicate"/);
		assert.match(stderr, /\/ref list .*\n\/ref add .*\n\/ref edit .*\n\/ref remove /);
	});
});
