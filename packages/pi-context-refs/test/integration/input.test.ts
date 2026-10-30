import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createJiti } from "jiti";
import { createFakeHost, createFakeSession } from "../support/fake-pi.ts";

const INDEX = join(import.meta.dirname, "..", "..", "src", "index.ts");

let agentDir = "";
let project = "";
let stderr: string[] = [];
const realStderrWrite = process.stderr.write.bind(process.stderr);

beforeEach(() => {
	const root = mkdtempSync(join(tmpdir(), "context-refs-input-"));
	agentDir = join(root, "agent");
	project = join(root, "project");
	mkdirSync(agentDir);
	mkdirSync(project);
	process.env.PI_CODING_AGENT_DIR = agentDir;
	stderr = [];
	// Keep only what the package writes; everything else (the test reporter) goes through.
	process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
		if (typeof chunk === "string" && chunk.startsWith("pi-context-refs:")) {
			stderr.push(chunk);
			return true;
		}
		return (realStderrWrite as (...args: unknown[]) => boolean)(chunk, ...rest);
	}) as typeof process.stderr.write;
});

afterEach(() => {
	process.stderr.write = realStderrWrite;
	rmSync(join(agentDir, ".."), { recursive: true, force: true });
});

const libraryFile = () => join(agentDir, "pi-context-refs.json");
const writeLibrary = (refs: unknown[]) => writeFileSync(libraryFile(), JSON.stringify({ version: 1, $schema: "x", refs }));

/** Loads the extension through jiti, as pi does, and runs its factory against a fake host. */
async function boot() {
	const jiti = createJiti(import.meta.url, { moduleCache: false });
	// The coverage run imports natively: V8 coverage cannot map code that jiti transforms back to the source files.
	const factory = (
		process.env.CONTEXT_REFS_NATIVE_IMPORT === "1" ? ((await import(INDEX)) as { default: unknown }).default : await jiti.import(INDEX, { default: true })
	) as (pi: unknown) => unknown;
	assert.equal(typeof factory, "function", "src/index.ts default-exports the extension factory");
	const host = createFakeHost();
	await factory(host.pi);
	return host;
}

type Mode = "tui" | "print" | "json" | "rpc";
const hasUI = (mode: Mode): boolean => mode === "tui" || mode === "rpc";
const source = (mode: Mode): string => (mode === "rpc" ? "rpc" : "interactive");

async function send(host: Awaited<ReturnType<typeof boot>>, session: ReturnType<typeof createFakeSession>, text: string, extra: Record<string, unknown> = {}) {
	return host.fire("input", { type: "input", text, source: "interactive", ...extra }, session.ctx);
}

const snippet = (name: string, text: string) => ({ name, kind: "snippet", text });

describe("extension load", () => {
	it("registers only the session_start, session_tree, session_shutdown, tool_result and input handlers", async () => {
		const host = await boot();
		assert.deepEqual(host.handledEvents().sort(), ["input", "session_shutdown", "session_start", "session_tree", "tool_result"]);
		assert.deepEqual(
			host.calls.filter((call) => call.method !== "on").map((call) => call.method),
			["registerCommand", "registerMarkdownTransformer"],
		);
	});

	it("no longer registers the scaffold's stub command", async () => {
		const host = await boot();
		assert.equal(host.commands.has("context-refs"), false);
	});
});

for (const mode of ["tui", "print", "json", "rpc"] as const) {
	describe(`a typed ref in ${mode} mode`, () => {
		const fresh = async () => {
			writeLibrary([
				snippet("terse", "Be brief."),
				{ name: "agents", kind: "path", path: "AGENTS.md" },
				{ name: "docs", kind: "path", path: join(homedir(), "docs") },
			]);
			const host = await boot();
			const session = createFakeSession({ cwd: project, hasUI: hasUI(mode) });
			await host.fire("session_start", { type: "session_start", reason: "startup" }, session.ctx);
			return { host, session };
		};
		const prompt = async (text: string, extra: Record<string, unknown> = {}) => {
			const { host, session } = await fresh();
			return send(host, session, text, { source: source(mode), ...extra });
		};

		it("expands a Snippet, inline", async () => {
			assert.deepEqual(await prompt("Answer #terse please"), { action: "transform", text: "Answer Be brief. please" });
		});

		it("expands a [ref:name] Placeholder the same way", async () => {
			assert.deepEqual(await prompt("Answer [ref:terse] please"), { action: "transform", text: "Answer Be brief. please" });
		});

		it("expands a Path relative to the working directory, or absolute outside it", async () => {
			assert.deepEqual(await prompt("read #agents and #docs"), { action: "transform", text: `read AGENTS.md and ${join(homedir(), "docs")}` });
		});

		it("lets text with no match through untouched", async () => {
			for (const text of ["#1 priority", "issue #42", "#unknown", "# heading", "[ref:unknown]", "plain"])
				assert.equal(await prompt(text), undefined, text);
		});

		it("keeps the images of the message it rewrites", async () => {
			const images = [{ type: "image", data: "AA==", mimeType: "image/png" }];
			assert.deepEqual(await prompt("#terse", { images }), { action: "transform", text: "Be brief.", images });
		});

		it("expands a steer and a follow-up when they are sent", async () => {
			for (const streamingBehavior of ["steer", "followUp"]) {
				assert.deepEqual(await prompt("#terse", { streamingBehavior }), { action: "transform", text: "Be brief." }, streamingBehavior);
			}
		});

		it("leaves a message that another extension injected alone", async () => {
			assert.equal(await prompt("#terse", { source: "extension" }), undefined);
		});
	});
}

describe("the library file", () => {
	const session = (ui: boolean) => createFakeSession({ cwd: project, hasUI: ui });

	it("is an empty library when it does not exist: nothing expands, nothing is reported", async () => {
		const host = await boot();
		const s = session(true);
		await host.fire("session_start", { type: "session_start", reason: "startup" }, s.ctx);
		assert.equal(await send(host, s, "#terse"), undefined);
		assert.deepEqual(s.notices, []);
		assert.deepEqual(stderr, []);
	});

	it("is read again before each send, so an edit on disk shows up without /reload", async () => {
		writeLibrary([snippet("terse", "Be brief.")]);
		const host = await boot();
		const s = session(false);
		await host.fire("session_start", { type: "session_start", reason: "startup" }, s.ctx);
		assert.deepEqual(await send(host, s, "#terse #long"), { action: "transform", text: "Be brief. #long" });
		writeLibrary([snippet("terse", "Be very brief."), snippet("long", "Be thorough.")]);
		assert.deepEqual(await send(host, s, "#terse #long"), { action: "transform", text: "Be very brief. Be thorough." });
		writeLibrary([]);
		assert.equal(await send(host, s, "#terse"), undefined);
	});

	it("skips an invalid Ref with one warning naming the file and the JSON path, shown once in the TUI", async () => {
		writeLibrary([{ name: "bad name", kind: "snippet", text: "x" }, snippet("terse", "Be brief.")]);
		const host = await boot();
		const s = session(true);
		await host.fire("session_start", { type: "session_start", reason: "startup" }, s.ctx);
		assert.equal(s.notices.length, 1);
		assert.match(
			s.notices[0]?.message ?? "",
			new RegExp(`^pi-context-refs: ${libraryFile().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\$\\.refs\\[0\\]\\.name: `),
		);
		assert.equal(s.notices[0]?.type, "warning");
		assert.deepEqual(await send(host, s, "#terse"), { action: "transform", text: "Be brief." });
		await send(host, s, "again");
		assert.equal(s.notices.length, 1, "the warning is not repeated on later sends");
		assert.deepEqual(stderr, []);
	});

	it("writes the same warning once to stderr in print mode, and notifies nothing", async () => {
		writeLibrary([{ name: "bad name", kind: "snippet", text: "x" }]);
		const host = await boot();
		const s = session(false);
		await host.fire("session_start", { type: "session_start", reason: "startup" }, s.ctx);
		await send(host, s, "hello");
		assert.equal(stderr.length, 1);
		assert.match(stderr[0] ?? "", /^pi-context-refs: .*pi-context-refs\.json \$\.refs\[0\]\.name: .*\n$/);
		assert.deepEqual(s.notices, []);
	});

	it("reports a warning for a file that appears after the session started", async () => {
		const host = await boot();
		const s = session(true);
		await host.fire("session_start", { type: "session_start", reason: "startup" }, s.ctx);
		writeLibrary([{ name: "bad name", kind: "snippet", text: "x" }]);
		await send(host, s, "hello");
		assert.equal(s.notices.length, 1);
	});

	it("keeps the last good copy when the file stops parsing, and says so once", async () => {
		writeLibrary([snippet("terse", "Be brief.")]);
		const host = await boot();
		const s = session(true);
		await host.fire("session_start", { type: "session_start", reason: "startup" }, s.ctx);
		writeFileSync(libraryFile(), "{ half saved");
		assert.deepEqual(await send(host, s, "#terse"), { action: "transform", text: "Be brief." });
		assert.equal(s.notices.length, 1);
		assert.match(s.notices[0]?.message ?? "", /does not parse.*keeping the last good copy/);
		await send(host, s, "#terse");
		assert.equal(s.notices.length, 1);
	});

	it("starts a new session with a fresh set of warnings", async () => {
		writeLibrary([{ name: "bad name", kind: "snippet", text: "x" }]);
		const host = await boot();
		const first = session(true);
		await host.fire("session_start", { type: "session_start", reason: "startup" }, first.ctx);
		const second = session(true);
		await host.fire("session_start", { type: "session_start", reason: "new" }, second.ctx);
		assert.equal(first.notices.length, 1);
		assert.equal(second.notices.length, 1);
	});
});

for (const mode of ["tui", "print", "json", "rpc"] as const) {
	describe(`a typed #tag:<tag> Bundle in ${mode} mode`, () => {
		const prompt = async (text: string) => {
			writeLibrary([
				{ name: "terse", kind: "snippet", text: "Be brief.", tags: ["style", "Docs"] },
				{ name: "agents", kind: "path", path: "AGENTS.md", tags: ["docs"] },
				{ name: "bad", kind: "snippet", text: "x", tags: ["no good"] },
				{ name: "readme", kind: "path", path: "README.md", tags: ["DOCS"] },
				snippet("loose", "Untagged."),
			]);
			const host = await boot();
			const session = createFakeSession({ cwd: project, hasUI: hasUI(mode) });
			await host.fire("session_start", { type: "session_start", reason: "startup" }, session.ctx);
			return { result: await send(host, session, text, { source: source(mode) }), session };
		};

		it("expands to every Visible member in file order, each as it would be on its own", async () => {
			assert.deepEqual((await prompt("Read #tag:docs first")).result, { action: "transform", text: "Read Be brief. AGENTS.md README.md first" });
		});

		it("does not repeat a member the message already names", async () => {
			assert.deepEqual((await prompt("#agents then #tag:docs")).result, { action: "transform", text: "AGENTS.md then Be brief. README.md" });
		});

		it("passes an unknown tag through unchanged", async () => {
			assert.equal((await prompt("see #tag:nope")).result, undefined);
		});

		it("skips a Ref with an invalid tag as a config error for that Ref alone", async () => {
			const { result, session } = await prompt("#tag:style #bad");
			assert.deepEqual(result, { action: "transform", text: "Be brief. #bad" });
			const reported = mode === "print" || mode === "json" ? stderr.join("") : session.notices.map((notice) => notice.message).join("\n");
			assert.match(reported, /\$\.refs\[2\]\.tags\[0\]: a tag uses only letters/);
		});
	});
}
