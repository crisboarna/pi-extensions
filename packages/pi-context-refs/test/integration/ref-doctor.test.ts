// /ref doctor at the fake pi host, with real files and real git: what it says about a healthy setup and about each way a setup goes wrong, and that
// it only reads. The wording of each line is checked in test/unit/doctor.test.ts; here the facts behind the lines are.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createJiti } from "jiti";
import { createFakeHost, createFakeSession } from "../support/fake-pi.ts";
import { initRepo } from "../support/git-repo.ts";

const INDEX = join(import.meta.dirname, "..", "..", "src", "index.ts");

let root = "";
let agentDir = "";
let project = "";
const realStderrWrite = process.stderr.write.bind(process.stderr);
const savedEnv = { ...process.env };

beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "context-refs-doctor-")));
	agentDir = join(root, "agent");
	project = join(root, "project");
	mkdirSync(agentDir);
	mkdirSync(project);
	process.env.PI_CODING_AGENT_DIR = agentDir;
});

afterEach(() => {
	process.stderr.write = realStderrWrite;
	for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
	Object.assign(process.env, savedEnv);
	rmSync(root, { recursive: true, force: true });
});

const write = (file: string, content: string) => {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, content);
};
const globalFile = () => join(agentDir, "pi-context-refs.json");
const projectFile = () => join(project, ".pi", "pi-context-refs.json");
const approvalsFile = () => join(agentDir, "pi-context-refs-approvals.json");
const library = (file: string, refs: unknown[], extra: Record<string, unknown> = {}) => write(file, JSON.stringify({ version: 1, refs, ...extra }));
const marker = () => join(project, "ran.txt");
const touching = (name: string) => ({
	name,
	kind: "dynamic",
	command: [process.execPath, "-e", "require('node:fs').writeFileSync(process.argv[1], 'ran')", marker()],
});

async function boot() {
	const jiti = createJiti(import.meta.url, { moduleCache: false });
	const factory = (
		process.env.CONTEXT_REFS_NATIVE_IMPORT === "1" ? ((await import(INDEX)) as { default: unknown }).default : await jiti.import(INDEX, { default: true })
	) as (pi: unknown) => unknown;
	const host = createFakeHost();
	await factory(host.pi);
	return host;
}

type Host = Awaited<ReturnType<typeof boot>>;

/** Print mode (no UI) unless `ui` is set: the doctor's lines go to stderr there, and to a notice with a UI. */
function session(options: { ui?: boolean; trusted?: boolean } = {}) {
	const fake = createFakeSession({ cwd: project, hasUI: options.ui ?? false, trusted: options.trusted ?? true });
	if (options.ui) Object.assign(fake.ctx.ui, { confirm: async () => true });
	return fake;
}

async function doctor(host: Host, fake: ReturnType<typeof session>): Promise<string> {
	const chunks: string[] = [];
	process.stderr.write = ((chunk: string | Uint8Array) => {
		chunks.push(String(chunk));
		return true;
	}) as typeof process.stderr.write;
	try {
		await host.commands.get("ref")?.handler("doctor", fake.ctx);
	} finally {
		process.stderr.write = realStderrWrite;
	}
	return chunks.join("") + fake.notices.map((notice) => notice.message).join("\n");
}

/** Every file under `dir` with its size and text, so a run that changed nothing can be told from one that did. */
function snapshot(dir: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const name of readdirSync(dir, { recursive: true, encoding: "utf8" })) {
		const path = join(dir, name);
		if (statSync(path).isFile()) out[name] = readFileSync(path, "utf8");
	}
	return out;
}

describe("/ref doctor", () => {
	it("says everything looks right for a trusted repository with both libraries and nothing waiting", async () => {
		initRepo(project);
		library(globalFile(), [{ name: "api", kind: "file", path: "src/api.ts" }]);
		library(projectFile(), [{ name: "notes", kind: "path", path: "NOTES.md" }]);
		const host = await boot();
		const text = await doctor(host, session());
		assert.match(text, /^pi-context-refs doctor: everything looks right/);
		assert.match(text, /✓ Global library: 1 ref in /);
		assert.match(text, /✓ Project library: 1 ref in /);
		assert.match(text, /✓ approvals: none for this project/);
		assert.match(text, /✓ git: #diff, #staged, #status and #log work here/);
		assert.match(text, /✓ editor: this mode has no editor; typed refs still expand/);
		assert.match(text, /✓ trigger: # opens the list/);
		assert.match(text, new RegExp(`✓ pi \\S+, Node ${process.version.replace(/\./g, "\\.")}, without a UI`));
	});

	it("says a Project library is not loaded when pi does not trust the project, and loads nothing from it", async () => {
		library(projectFile(), [touching("tests")]);
		const host = await boot();
		const text = await doctor(host, session({ trusted: false }));
		assert.match(text, /! Project library: .*pi-context-refs\.json is not loaded because pi does not trust this project; run \/trust, then restart pi/);
		assert.doesNotMatch(text, /waits? for an Approval/, "an untrusted library's commands are not even counted");
		assert.equal(existsSync(marker()), false);
	});

	it("names a Global library that is not valid JSON", async () => {
		write(globalFile(), "{ not json");
		const host = await boot();
		const text = await doctor(host, session());
		assert.match(text, /^pi-context-refs doctor: 1 problem\(s\)/);
		assert.match(text, /✗ Global library: .*pi-context-refs\.json/);
	});

	it("names a Project library whose version it does not know", async () => {
		write(projectFile(), JSON.stringify({ version: 2, refs: [] }));
		const host = await boot();
		assert.match(await doctor(host, session()), /✗ Project library: .*version/);
	});

	it("names an approvals file that cannot be read, and treats every Project command as waiting", async () => {
		library(projectFile(), [touching("tests")]);
		write(approvalsFile(), "{ nope");
		const host = await boot();
		const text = await doctor(host, session());
		assert.match(text, /✗ approvals: .*; every Project command asks again until it is fixed or removed/);
		assert.match(text, /! 1 Project ref waits for an Approval: tests;/);
	});

	it("lists a Project command that has no Approval, and no longer lists it once it is approved", async () => {
		library(projectFile(), [touching("tests")]);
		const host = await boot();
		assert.match(
			await doctor(host, session()),
			/! 1 Project ref waits for an Approval: tests; send a message that names one from the TUI, or run \/ref approve <name>/,
		);
		await host.commands.get("ref")?.handler("approve tests", session({ ui: true }).ctx);
		const after = await doctor(host, session());
		assert.doesNotMatch(after, /waits? for an Approval/);
		assert.match(after, /✓ approvals: 1 for this project/);
	});

	it("says the built-in refs are hidden outside a git work tree", async () => {
		const host = await boot();
		assert.match(await doctor(host, session()), /! git: this directory is not inside a git work tree, so #diff, #staged, #status and #log are hidden/);
	});

	it("says which built-in refs the builtins setting turns off", async () => {
		initRepo(project);
		library(globalFile(), [], { builtins: ["diff"] });
		const host = await boot();
		assert.match(await doctor(host, session()), /✓ git: #staged, #status and #log work here; #diff are turned off by the builtins setting/);
	});

	it("says to look again while the editor is not wrapped, in a session with a UI", async () => {
		const host = await boot();
		assert.match(await doctor(host, session({ ui: true })), /! editor: not wrapped yet/);
	});

	it("says what to do when the trigger in the file is not the one this session started with", async () => {
		const host = await boot();
		const fake = session({ ui: true });
		await host.fire("session_start", { type: "session_start", reason: "startup" }, fake.ctx);
		library(globalFile(), [], { trigger: "%" });
		assert.match(await doctor(host, fake), /! trigger: the file says "%" but this session started with "#"; run \/reload/);
	});

	it("only reads: it writes no file and runs no command", async () => {
		initRepo(project);
		library(globalFile(), [{ name: "api", kind: "file", path: "src/api.ts" }]);
		library(projectFile(), [touching("tests")]);
		const host = await boot();
		const before = { agent: snapshot(agentDir), work: snapshot(project) };
		await doctor(host, session());
		await doctor(host, session({ ui: true }));
		assert.deepEqual({ agent: snapshot(agentDir), work: snapshot(project) }, before);
		assert.equal(existsSync(marker()), false);
	});

	it("never throws on a library it cannot read: the problem is a line, not an error", async () => {
		mkdirSync(globalFile());
		const host = await boot();
		assert.match(await doctor(host, session()), /✗ Global library: .*could not be read/);
	});
});
