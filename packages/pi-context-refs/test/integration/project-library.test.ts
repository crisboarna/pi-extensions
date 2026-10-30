// The Project library, Scoped Refs and precedence, at the fake pi host with a fake trust answer and temporary git repositories.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
let stderr: string[] = [];
const realStderrWrite = process.stderr.write.bind(process.stderr);
const realPath = process.env.PATH;

beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "context-refs-project-")));
	agentDir = join(root, "agent");
	project = join(root, "project");
	mkdirSync(agentDir);
	mkdirSync(project);
	process.env.PI_CODING_AGENT_DIR = agentDir;
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
	process.env.PATH = realPath;
	rmSync(root, { recursive: true, force: true });
});

const write = (file: string, content: string) => {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, content);
};
const globalLibrary = (refs: unknown[]) => write(join(agentDir, "pi-context-refs.json"), JSON.stringify({ version: 1, refs }));
const projectLibrary = (refs: unknown[], cwd = project) => write(join(cwd, ".pi", "pi-context-refs.json"), JSON.stringify({ version: 1, refs }));
const snippet = (name: string, text: string, scope?: Record<string, string>) => ({ name, kind: "snippet", text, ...(scope && { scope }) });

async function boot() {
	const jiti = createJiti(import.meta.url, { moduleCache: false });
	const factory = (
		process.env.CONTEXT_REFS_NATIVE_IMPORT === "1" ? ((await import(INDEX)) as { default: unknown }).default : await jiti.import(INDEX, { default: true })
	) as (pi: unknown) => unknown;
	const host = createFakeHost();
	await factory(host.pi);
	return host;
}

/** What the model would get for `text` in a session started at `cwd`. */
async function expansion(text: string, options: { cwd?: string; trusted?: boolean } = {}): Promise<string> {
	const host = await boot();
	const session = createFakeSession({ cwd: options.cwd ?? project, trusted: options.trusted ?? true });
	await host.fire("session_start", { type: "session_start", reason: "startup" }, session.ctx);
	const result = (await host.fire("input", { type: "input", text, source: "interactive" }, session.ctx)) as { text: string } | undefined;
	return result?.text ?? text;
}

describe("the Project library", () => {
	it("loads from <cwd>/.pi/pi-context-refs.json in a trusted project", async () => {
		projectLibrary([snippet("rules", "Use tabs.")]);
		assert.equal(await expansion("#rules"), "Use tabs.");
	});

	it("does not load in an untrusted project, and nothing is read from it", async () => {
		projectLibrary([snippet("rules", "Use tabs.")]);
		assert.equal(await expansion("#rules", { trusted: false }), "#rules");
		assert.deepEqual(stderr, []);
	});

	it("never reads a parent directory's library", async () => {
		projectLibrary([snippet("rules", "Use tabs.")], root);
		const sub = join(project, "packages", "a");
		mkdirSync(sub, { recursive: true });
		assert.equal(await expansion("#rules", { cwd: sub }), "#rules");
		assert.equal(await expansion("#rules", { cwd: root }), "Use tabs.");
	});

	it("reloads the file before each send, so a pull shows up without /reload", async () => {
		const host = await boot();
		const session = createFakeSession({ cwd: project });
		await host.fire("session_start", { type: "session_start", reason: "startup" }, session.ctx);
		const send = async () =>
			((await host.fire("input", { type: "input", text: "#rules", source: "interactive" }, session.ctx)) as { text: string } | undefined)?.text;
		assert.equal(await send(), undefined);
		projectLibrary([snippet("rules", "one")]);
		assert.equal(await send(), "one");
		projectLibrary([snippet("rules", "two")]);
		assert.equal(await send(), "two");
	});

	it("warns once about a Project library that does not parse, naming the file", async () => {
		write(join(project, ".pi", "pi-context-refs.json"), "{ half saved");
		const host = await boot();
		const session = createFakeSession({ cwd: project });
		await host.fire("session_start", { type: "session_start", reason: "startup" }, session.ctx);
		await host.fire("input", { type: "input", text: "hello", source: "interactive" }, session.ctx);
		assert.equal(stderr.length, 1);
		assert.match(stderr[0] ?? "", /\.pi\/pi-context-refs\.json does not parse/);
	});
});

describe("Project library confinement", () => {
	it("skips a Path or File Ref that points outside the project, with a warning naming the file and the JSON path", async () => {
		projectLibrary([
			{ name: "ssh", kind: "path", path: "~/.ssh/id_ed25519" },
			{ name: "up", kind: "file", path: "../outside.txt" },
			{ name: "ok", kind: "path", path: "src/a.ts" },
		]);
		assert.equal(await expansion("#ssh #up #ok"), "#ssh #up src/a.ts");
		assert.equal(stderr.length, 2);
		assert.match(stderr[0] ?? "", /\.pi\/pi-context-refs\.json \$\.refs\[0\]\.path: .*outside the project/);
		assert.match(stderr[1] ?? "", /\$\.refs\[1\]\.path: .*outside the project/);
	});

	it("skips a Ref whose path goes through a symlink to somewhere outside", async () => {
		const secret = join(root, "secret");
		write(join(secret, "key"), "s3cret");
		symlinkSync(secret, join(project, "link"));
		projectLibrary([{ name: "key", kind: "file", path: "link/key" }]);
		const text = await expansion("#key");
		assert.equal(text, "#key");
		assert.doesNotMatch(text, /s3cret/);
		assert.match(stderr[0] ?? "", /\$\.refs\[0\]\.path: .*outside the project/);
	});

	it("skips a Ref whose path is a symlink that points at nothing, outside the project", async () => {
		symlinkSync(join(root, "not-there", "key"), join(project, "dangling"));
		projectLibrary([{ name: "key", kind: "file", path: "dangling" }]);
		assert.equal(await expansion("#key"), "#key");
		assert.match(stderr[0] ?? "", /\$\.refs\[0\]\.path: .*outside the project/);
	});

	it("skips a Dynamic Ref whose cwd is outside the project", async () => {
		projectLibrary([{ name: "out", kind: "dynamic", command: ["ls"], cwd: ".." }]);
		await expansion("#out");
		assert.match(stderr[0] ?? "", /\$\.refs\[0\]\.cwd: .*outside the project/);
	});

	it("does not confine the Global library", async () => {
		globalLibrary([{ name: "ssh", kind: "path", path: "~/.ssh/config" }]);
		assert.match(await expansion("#ssh"), /\.ssh\/config$/);
		assert.deepEqual(stderr, []);
	});
});

describe("Scoped Refs", () => {
	it("appear where a path scope matches, for a directory subtree and for a glob", async () => {
		const sub = join(project, "src", "deep");
		mkdirSync(sub, { recursive: true });
		globalLibrary([
			snippet("tree", "in tree", { path: project }),
			snippet("glob", "in glob", { path: join(root, "pro*", "src", "**") }),
			snippet("elsewhere", "no", { path: join(root, "other") }),
		]);
		assert.equal(await expansion("#tree #glob #elsewhere", { cwd: sub }), "in tree in glob #elsewhere");
		assert.equal(await expansion("#tree", { cwd: root }), "#tree");
	});

	it("appear in a repository whose remote matches, whatever the scheme and case", async () => {
		initRepo(project, { origin: "git@GitHub.com:Acme/App.git" });
		globalLibrary([snippet("mine", "acme", { remote: "github.com/acme/app" }), snippet("other", "no", { remote: "github.com/acme/other" })]);
		assert.equal(await expansion("#mine #other"), "acme #other");
	});

	it("need both the path and the remote when both are given", async () => {
		initRepo(project, { origin: "https://github.com/acme/app.git" });
		globalLibrary([
			snippet("both", "yes", { path: project, remote: "github.com/acme/app" }),
			snippet("wrongpath", "no", { path: join(root, "x"), remote: "github.com/acme/app" }),
			snippet("wrongremote", "no", { path: project, remote: "github.com/acme/zzz" }),
		]);
		assert.equal(await expansion("#both #wrongpath #wrongremote"), "yes #wrongpath #wrongremote");
	});

	it("hide a remote-scoped Ref when git fails or the directory is not a repository", async () => {
		globalLibrary([snippet("mine", "acme", { remote: "github.com/acme/app" }), snippet("plain", "kept", { path: project })]);
		assert.equal(await expansion("#mine #plain"), "#mine kept");
		initRepo(project, { origin: "https://github.com/acme/app.git" });
		const empty = join(root, "no-git");
		mkdirSync(empty);
		process.env.PATH = empty;
		assert.equal(await expansion("#mine #plain"), "#mine kept");
		process.env.PATH = realPath;
		assert.equal(await expansion("#mine #plain"), "acme kept");
	});
});

describe("precedence", () => {
	it("is Scoped Ref, then Project library, then unscoped Global Ref", async () => {
		globalLibrary([snippet("a", "global-a"), snippet("b", "global-b"), snippet("c", "scoped-c", { path: project }), snippet("c2", "x")]);
		projectLibrary([snippet("b", "project-b"), snippet("c", "project-c"), snippet("d", "project-d")]);
		assert.equal(await expansion("#a #b #c #d"), "global-a project-b scoped-c project-d");
	});

	it("falls back to the lower layer when the Scoped Ref's scope does not match", async () => {
		globalLibrary([snippet("c", "scoped-c", { path: join(root, "other") })]);
		projectLibrary([snippet("c", "project-c")]);
		assert.equal(await expansion("#c"), "project-c");
	});

	it("lets an unscoped Global Ref win again when the project is untrusted", async () => {
		globalLibrary([snippet("b", "global-b")]);
		projectLibrary([snippet("b", "project-b")]);
		assert.equal(await expansion("#b", { trusted: false }), "global-b");
	});
});
