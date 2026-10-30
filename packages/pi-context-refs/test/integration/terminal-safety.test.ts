// Text that comes from a repository or a file never reaches a notification or a dialog with its control characters, at the fake pi host.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createJiti } from "jiti";
import { createFakeHost, createFakeSession } from "../support/fake-pi.ts";

const INDEX = join(import.meta.dirname, "..", "..", "src", "index.ts");
const ESC = String.fromCharCode(27);

let root = "";
let agentDir = "";
let project = "";
const savedEnv = { ...process.env };

beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "context-refs-safety-")));
	agentDir = join(root, "agent");
	// A directory name may hold an escape sequence; the project path appears in notices and dialogs.
	project = join(root, `proj${ESC}[31mect`);
	mkdirSync(agentDir);
	mkdirSync(project);
	process.env.PI_CODING_AGENT_DIR = agentDir;
});

afterEach(() => {
	for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
	Object.assign(process.env, savedEnv);
	rmSync(root, { recursive: true, force: true });
});

const write = (file: string, content: string) => {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, content);
};
const projectLibrary = (refs: unknown[]) => write(join(project, ".pi", "pi-context-refs.json"), JSON.stringify({ version: 1, refs }));
const globalLibrary = (refs: unknown[]) => write(join(agentDir, "pi-context-refs.json"), JSON.stringify({ version: 1, refs }));

async function boot() {
	const jiti = createJiti(import.meta.url, { moduleCache: false });
	const factory = (
		process.env.CONTEXT_REFS_NATIVE_IMPORT === "1" ? ((await import(INDEX)) as { default: unknown }).default : await jiti.import(INDEX, { default: true })
	) as (pi: unknown) => unknown;
	const host = createFakeHost();
	await factory(host.pi);
	return host;
}

const started = async (host: Awaited<ReturnType<typeof boot>>, session: ReturnType<typeof createFakeSession>) =>
	host.fire("session_start", { type: "session_start", reason: "startup" }, session.ctx);
const noEscape = (text: string) => assert.equal(text.includes(ESC), false, JSON.stringify(text));

describe("notifications", () => {
	it("show a Project library warning that quotes a path from the repository without its control characters", async () => {
		projectLibrary([{ name: "leak", kind: "path", path: `/etc/${ESC}[31mevil` }]);
		const host = await boot();
		const session = createFakeSession({ cwd: project, mode: "tui" });
		await started(host, session);
		assert.ok(session.notices.length > 0);
		for (const notice of session.notices) noEscape(notice.message);
	});

	it("show the reason a send was refused without the control characters of the path in it", async () => {
		globalLibrary([{ name: "gone", kind: "file", path: `/nonexistent/${ESC}[31mx` }]);
		const host = await boot();
		const session = createFakeSession({ cwd: project, mode: "tui" });
		await started(host, session);
		const result = await host.fire("input", { type: "input", text: "#gone", source: "interactive" }, session.ctx);
		assert.deepEqual(result, { action: "handled" });
		const [notice] = session.notices.slice(-1);
		assert.match(notice?.message ?? "", /does not exist/);
		noEscape(notice?.message ?? "");
	});

	it("show the output of /ref without the control characters of the project path in it", async () => {
		projectLibrary([]);
		const host = await boot();
		const session = createFakeSession({ cwd: project, mode: "tui" });
		await started(host, session);
		await host.commands.get("ref")?.handler("approve nothing", session.ctx);
		const [notice] = session.notices.slice(-1);
		assert.match(notice?.message ?? "", /no command or URL Ref named "nothing"/);
		noEscape(notice?.message ?? "");
	});
});

describe("Approval dialogs", () => {
	const tests = { name: "tests", kind: "dynamic", command: [process.execPath, "-e", "0"] };

	it("write the control characters of the project path as escapes in the question of a send", async () => {
		projectLibrary([tests]);
		const host = await boot();
		const session = createFakeSession({ cwd: project, mode: "tui" });
		const questions: string[] = [];
		session.ctx.ui.select = async (question: string) => {
			questions.push(question);
			return "Deny";
		};
		await started(host, session);
		await host.fire("input", { type: "input", text: "#tests", source: "interactive" }, session.ctx);
		assert.equal(questions.length, 1);
		assert.match(questions[0] ?? "", /command line only, not the files it runs/);
		noEscape(questions[0] ?? "");
		assert.ok((questions[0] ?? "").includes("\\u001b"), JSON.stringify(questions));
	});

	it("write them as escapes in the confirm of /ref approve", async () => {
		projectLibrary([tests]);
		const host = await boot();
		const session = createFakeSession({ cwd: project, mode: "tui" });
		const messages: string[] = [];
		session.ctx.ui.confirm = async (_title: string, message: string) => {
			messages.push(message);
			return false;
		};
		await started(host, session);
		await host.commands.get("ref")?.handler("approve tests", session.ctx);
		assert.equal(messages.length, 1);
		assert.match(messages[0] ?? "", /command line only, not the files it runs/);
		noEscape(messages[0] ?? "");
		assert.ok((messages[0] ?? "").includes("\\u001b"), JSON.stringify(messages));
	});
});
