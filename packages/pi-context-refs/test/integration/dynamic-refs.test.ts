import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createJiti } from "jiti";
import { createFakeHost, createFakeSession } from "../support/fake-pi.ts";

const INDEX = join(import.meta.dirname, "..", "..", "src", "index.ts");
const ESC = String.fromCharCode(27);

let root = "";
let agentDir = "";
let project = "";
let stderr: string[] = [];
const realStderrWrite = process.stderr.write.bind(process.stderr);
const savedEnv = { ...process.env };

beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "context-refs-dynamic-")));
	agentDir = join(root, "agent");
	project = join(root, "project");
	mkdirSync(agentDir);
	mkdirSync(project);
	process.env.PI_CODING_AGENT_DIR = agentDir;
	// Git reads nothing from the machine running the test, and never looks above the temporary directory.
	process.env.GIT_CONFIG_GLOBAL = "/dev/null";
	process.env.GIT_CONFIG_SYSTEM = "/dev/null";
	process.env.GIT_CEILING_DIRECTORIES = root;
	stderr = [];
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
	for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
	Object.assign(process.env, savedEnv);
	rmSync(root, { recursive: true, force: true });
});

const writeLibrary = (refs: unknown[], settings: Record<string, unknown> = {}) =>
	writeFileSync(join(agentDir, "pi-context-refs.json"), JSON.stringify({ version: 1, $schema: "x", ...settings, refs }));
/** A Dynamic Ref that runs a Node script: the child is `process.execPath`, so it is the same on every machine. */
const node = (name: string, script: string, ...args: string[]) => ({ name, kind: "dynamic", command: [process.execPath, "-e", script, ...args] });
const git = (...args: string[]) => execFileSync("git", args, { cwd: project, stdio: "pipe" }).toString();

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

type Mode = "tui" | "print" | "json" | "rpc";

async function session(mode: Mode, cwd = project) {
	const host = await boot();
	const s = createFakeSession({ cwd, mode });
	await host.fire("session_start", { type: "session_start", reason: "startup" }, s.ctx);
	const send = (text: string) => host.fire("input", { type: "input", text, source: mode === "rpc" ? "rpc" : "interactive" }, s.ctx);
	return { s, send };
}

/** The Context blocks of a sent message, with the attributes and the body of each. */
function blocksOf(sent: { text: string } | undefined): Array<{ attributes: string; body: string }> {
	return [...(sent?.text ?? "").matchAll(/<context-ref ([^>]*)>\n([\s\S]*?)\n<\/context-ref>/g)].map((match) => ({
		attributes: match[1] ?? "",
		body: match[2] ?? "",
	}));
}

const lastLine = (block: { body: string }) => block.body.trimEnd().split("\n").at(-1);

describe("how a command runs", () => {
	it("passes each argument as it is, with no shell to interpret it", async () => {
		const hostile = "$(echo pwned); `echo pwned` | cat > nope && echo * ";
		writeLibrary([node("echo", "console.log(process.argv[1])", hostile)]);
		const { send } = await session("print");
		const [block] = blocksOf(await send("#echo"));
		assert.ok(block?.body.endsWith(`\n${hostile}\n`), block?.body ?? "no block");
		assert.equal(existsSync(join(project, "nope")), false);
	});

	it("runs in the session directory, or in the Ref's cwd resolved against it", async () => {
		mkdirSync(join(project, "sub"));
		writeLibrary([node("here", "console.log(process.cwd())"), { ...node("there", "console.log(process.cwd())"), cwd: "sub" }]);
		const { send } = await session("print");
		const blocks = blocksOf(await send("#here #there"));
		assert.deepEqual(
			blocks.map((block) => lastLine(block)),
			[project, join(project, "sub")],
		);
	});

	it("inherits pi's environment", async () => {
		process.env.CONTEXT_REFS_PROBE = "from-pi";
		writeLibrary([node("env", "console.log(process.env.CONTEXT_REFS_PROBE)")]);
		const { send } = await session("print");
		assert.ok(blocksOf(await send("#env"))[0]?.body.endsWith("\nfrom-pi\n"));
	});

	it("runs again at every send and once per message, whatever the number of mentions", async () => {
		const counter = join(project, "count.txt");
		writeLibrary([node("count", "require('node:fs').appendFileSync(process.argv[1], 'x\\n'); console.log('ran')", counter)]);
		const { send } = await session("print");
		await send("#count #count [ref:count]");
		assert.equal(readFileSync(counter, "utf8"), "x\n");
		await send("#count");
		assert.equal(readFileSync(counter, "utf8"), "x\nx\n");
	});

	it("runs the Dynamic Refs of one message at the same time", async () => {
		// Each child waits for the other's marker, so they only finish if both are running.
		const rendezvous = (me: string, other: string) =>
			`const fs=require('node:fs'),p=require('node:path');const dir=process.argv[1];fs.writeFileSync(p.join(dir,'${me}'),'');` +
			`const end=Date.now()+4000;while(!fs.existsSync(p.join(dir,'${other}'))){if(Date.now()>end){console.log('alone');process.exit(1)}}console.log('met')`;
		writeLibrary([node("a", rendezvous("a", "b"), project), node("b", rendezvous("b", "a"), project)]);
		const { send } = await session("print");
		const blocks = blocksOf(await send("#a #b"));
		assert.deepEqual(
			blocks.map((block) => lastLine(block)),
			["met", "met"],
		);
	});

	it("sends a command that exits non-zero with its output and the code", async () => {
		writeLibrary([node("fail", "console.log('1 failing'); console.error('boom'); process.exit(3)")]);
		const { send } = await session("tui");
		const sent = await send("#fail");
		assert.equal(sent?.action, "transform");
		const [block] = blocksOf(sent);
		assert.match(block?.attributes ?? "", /^name="fail" kind="dynamic" source="[^"]*" bytes="\d+" exit="3"$/);
		assert.match(block?.body ?? "", /\(exit 3\)\n1 failing\nboom\n$/);
	});
});

describe("the limits", () => {
	it("cuts output past 50 KB and says so", async () => {
		writeLibrary([node("big", "process.stdout.write('x'.repeat(200000))")]);
		const { send } = await session("print");
		const [block] = blocksOf(await send("#big"));
		assert.match(block?.attributes ?? "", /truncated="50 KB"$/);
		assert.match(block?.body ?? "", /^\$ .*\(truncated at 50 KB\)\nx{51200}$/);
	});

	it("lets max_output raise the cap", async () => {
		writeLibrary([{ ...node("big", "process.stdout.write('x'.repeat(200000))"), max_output: 1024 * 1024 }]);
		const { send } = await session("print");
		const [block] = blocksOf(await send("#big"));
		assert.equal(block?.attributes.includes("truncated"), false);
		assert.equal(block?.body.split("\n")[1]?.length, 200_000);
	});

	it("kills a command that outlives its timeout and reports the timeout", async () => {
		const pidFile = join(project, "pid.txt");
		writeLibrary([
			{ ...node("slow", "require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setTimeout(() => {}, 60000)", pidFile), timeout: 1 },
		]);
		const { send } = await session("print");
		const sent = await send("#slow");
		assert.match(sent?.text ?? "", /error="[^"]*timed out after 1 s"/);
		assert.match(stderr.join(""), /#slow: .*timed out after 1 s/);
		const pid = Number(readFileSync(pidFile, "utf8"));
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
	});
});

describe("failures", () => {
	beforeEach(() => {
		writeLibrary([
			{ name: "nope", kind: "dynamic", command: ["context-refs-no-such-program"] },
			{ name: "baddir", kind: "dynamic", command: [process.execPath, "-e", "1"], cwd: "missing" },
			node("blob", "process.stdout.write(Buffer.from([80, 75, 3, 4, 0, 0, 1, 2]))"),
			node("silent", "process.exit(1)"),
		]);
	});

	it("cancels a TUI send that cannot start a command, and gives the draft back with the reason", async () => {
		const { s, send } = await session("tui");
		assert.deepEqual(await send("see #nope"), { action: "handled" });
		assert.deepEqual(s.editorTexts, ["see #nope"]);
		assert.match(s.notices.at(-1)?.message ?? "", /#nope: context-refs-no-such-program cannot start: context-refs-no-such-program was not found/);
	});

	it("names the working directory when it is missing", async () => {
		const { send } = await session("print");
		assert.match((await send("#baddir"))?.text ?? "", /error="[^"]*cannot start: the directory .*missing does not exist"/);
	});

	it("treats a program that exits 1 in silence as an ordinary non-zero exit", async () => {
		const { send } = await session("print");
		const [block] = blocksOf(await send("#silent"));
		assert.match(block?.attributes ?? "", / exit="1"$/);
		assert.equal(stderr.length, 0);
	});

	for (const mode of ["print", "json", "rpc"] as const) {
		it(`sends a Failure note and warns, without cancelling, in ${mode} mode`, async () => {
			const { s, send } = await session(mode);
			const sent = await send("a #blob b");
			assert.equal(sent?.action, "transform");
			assert.match(sent?.text ?? "", /^a #blob b\n\n<context-ref name="blob" kind="dynamic" source="[^"]*" bytes="0" error="[^"]*wrote binary output">/);
			if (mode === "rpc") assert.match(s.notices.at(-1)?.message ?? "", /#blob: .*wrote binary output/);
			else assert.match(stderr.join(""), /#blob: .*wrote binary output/);
		});
	}
});

describe("the TUI while a command runs", () => {
	it("shows 'running #x…' and clears it when the command ends", async () => {
		writeLibrary([node("quick", "console.log('hi')")]);
		const { s, send } = await session("tui");
		await send("#quick");
		assert.deepEqual(s.statuses, [
			{ key: "pi-context-refs", text: "running #quick… (esc cancels)" },
			{ key: "pi-context-refs", text: undefined },
			{ key: "pi-context-refs", text: undefined },
		]);
	});

	it("shows no status outside the TUI", async () => {
		writeLibrary([node("quick", "console.log('hi')")]);
		const { s, send } = await session("rpc");
		await send("#quick");
		assert.deepEqual(s.statuses, []);
	});

	it("cancels the send on Esc, kills the commands and restores the draft", async () => {
		const pidFile = join(project, "pid.txt");
		writeLibrary([
			{ ...node("slow", "require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setTimeout(() => {}, 60000)", pidFile), timeout: 120 },
		]);
		const { s, send } = await session("tui");
		const sending = send("check #slow");
		while (!existsSync(pidFile) || readFileSync(pidFile, "utf8") === "") await new Promise((resolve) => setTimeout(resolve, 10));
		assert.match(s.statuses.at(-1)?.text ?? "", /running #slow/);
		assert.equal(s.pressKey("a"), false, "other keys are left alone");
		assert.equal(s.pressKey(ESC), true);
		assert.deepEqual(await sending, { action: "handled" });
		assert.deepEqual(s.editorTexts, ["check #slow"]);
		assert.match(s.notices.at(-1)?.message ?? "", /cancelled/);
		assert.equal(s.statuses.at(-1)?.text, undefined);
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.throws(() => process.kill(Number(readFileSync(pidFile, "utf8")), 0), { code: "ESRCH" });
		assert.equal(s.pressKey(ESC), false, "the listener is gone after the send");
	});
});

describe("Built-in Refs", () => {
	beforeEach(() => {
		git("init", "-q");
		git("config", "user.email", "test@example.com");
		git("config", "user.name", "Test");
		writeFileSync(join(project, "a.txt"), "one\n");
		git("add", "a.txt");
		git("commit", "-q", "-m", "first commit");
		writeFileSync(join(project, "a.txt"), "one\ntwo\n");
		writeFileSync(join(project, "b.txt"), "new\n");
		git("add", "b.txt");
	});

	it("#diff, #staged, #status and #log send git's output, with nothing saved", async () => {
		const { send } = await session("print");
		const [diff, staged, status, log] = blocksOf(await send("#diff #staged #status #log"));
		assert.match(diff?.body ?? "", /^\$ git diff\n[\s\S]*\+two/);
		assert.match(staged?.body ?? "", /^\$ git diff --staged\n[\s\S]*\+new/);
		assert.match(status?.body ?? "", /^\$ git status --short\n(?=[\s\S]*A {2}b\.txt)(?=[\s\S]* M a\.txt)/);
		assert.match(log?.body ?? "", /^\$ git log --oneline -20\n[0-9a-f]+ first commit\n$/);
	});

	it("sits below a saved Ref of the same name", async () => {
		writeLibrary([{ name: "log", kind: "snippet", text: "my log" }]);
		const { send } = await session("print");
		assert.equal((await send("see #log"))?.text, "see my log");
	});

	it("is turned off by builtins false, or by name in a list", async () => {
		writeLibrary([], { builtins: false });
		assert.equal(await (await session("print")).send("#diff #log"), undefined);
		writeLibrary([], { builtins: ["Log"] });
		const { send } = await session("print");
		const sent = await send("#diff #log");
		assert.deepEqual(
			blocksOf(sent).map((block) => block.body.split("\n")[0]),
			["$ git diff"],
		);
		assert.ok(sent?.text.startsWith("#diff #log\n\n"));
	});

	it("follows a change of the builtins setting at the next send", async () => {
		writeLibrary([]);
		const { send } = await session("print");
		assert.equal(blocksOf(await send("#status")).length, 1);
		writeLibrary([], { builtins: false });
		assert.equal(await send("#status"), undefined);
	});

	it("fails outside a git work tree with 'not a git repository', and never sends git's own error", async () => {
		const outside = join(root, "outside");
		mkdirSync(outside);
		const tui = await session("tui", outside);
		assert.deepEqual(await tui.send("#diff"), { action: "handled" });
		assert.equal(tui.s.notices.at(-1)?.message, "pi-context-refs: #diff: not a git repository");
		const print = await session("print", outside);
		const sent = await print.send("#diff");
		assert.match(sent?.text ?? "", /error="not a git repository"/);
		assert.equal(/fatal/i.test(sent?.text ?? ""), false);
		assert.match(stderr.join(""), /#diff: not a git repository/);
	});
});

describe("a Dynamic Ref with a URL", () => {
	it("is not run yet, and its token is sent as typed", async () => {
		writeLibrary([{ name: "page", kind: "dynamic", url: "http://127.0.0.1:1/" }]);
		const { send } = await session("print");
		assert.equal(await send("see #page"), undefined);
	});
});
