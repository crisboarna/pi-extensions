// /ref with the Project library, Scoped Refs and precedence, at the fake pi host with a fake trust answer and temporary git repositories.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "context-refs-ref-project-")));
	agentDir = join(root, "agent");
	project = join(root, "project");
	mkdirSync(agentDir);
	mkdirSync(project);
	process.env.PI_CODING_AGENT_DIR = agentDir;
});

afterEach(() => {
	process.stderr.write = realStderrWrite;
	rmSync(root, { recursive: true, force: true });
});

const globalFile = () => join(agentDir, "pi-context-refs.json");
const projectFile = () => join(project, ".pi", "pi-context-refs.json");
const write = (file: string, content: string) => {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, content);
};
const globalLibrary = (refs: unknown[], extra: Record<string, unknown> = {}) => write(globalFile(), JSON.stringify({ version: 1, ...extra, refs }));
const projectLibrary = (refs: unknown[]) => write(projectFile(), JSON.stringify({ version: 1, refs }));
const readRefs = (file: string) => (JSON.parse(readFileSync(file, "utf8")) as { refs: Array<Record<string, unknown>> }).refs;
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

type Host = Awaited<ReturnType<typeof boot>>;
type Dialogs = Partial<{
	confirm: (title: string, message: string) => Promise<boolean>;
	select: (title: string, options: string[]) => Promise<string | undefined>;
	input: (title: string, placeholder?: string) => Promise<string | undefined>;
	editor: (title: string, prefill?: string) => Promise<string | undefined>;
}>;

/** A session. With `dialogs` it has a UI; without, it is print mode. */
function session(options: { dialogs?: Dialogs; trusted?: boolean } = {}) {
	const fake = createFakeSession({ cwd: project, hasUI: options.dialogs !== undefined, trusted: options.trusted ?? true });
	Object.assign(fake.ctx.ui, options.dialogs ?? {});
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
	((await host.fire("input", { type: "input", text, source: "interactive" }, fake.ctx)) as { text: string } | undefined)?.text ?? text;

describe("/ref list: layers", () => {
	it("groups Refs by layer and lists Shadowed Refs", async () => {
		globalLibrary([
			snippet("g", "1"),
			snippet("both", "global"),
			snippet("mine", "scoped", { path: project }),
			snippet("away", "x", { path: join(root, "other") }),
		]);
		projectLibrary([snippet("p", "2"), snippet("both", "project"), snippet("mine", "project")]);
		const host = await boot();
		const text = await ref(host, session(), "list");
		const at = (title: string) => text.indexOf(title);
		assert.ok(at("Scoped Refs that apply here") > 0 && at("Scoped Refs that apply here") < at("Project library"));
		assert.ok(at("Project library") < at("Global library") && at("Global library") < at("Scoped Refs that do not apply here"));
		assert.match(text, /^Project library .*project\/\.pi\/pi-context-refs\.json \(3 Refs\)$/m);
		assert.match(
			text,
			/^Shadowed Refs:\n {2}mine {2}in the Project library, hidden by the Global library, scoped to here\n {2}both {2}in the Global library, hidden by the Project library$/m,
		);
	});

	it("is the same text through notify in the TUI as on stderr in print mode", async () => {
		globalLibrary([snippet("g", "1")]);
		projectLibrary([snippet("p", "2")]);
		const host = await boot();
		const print = await ref(host, session(), "list");
		const tui = session({ dialogs: {} });
		await ref(host, tui, "list");
		assert.equal(`${tui.notices[0]?.message}\n`, print);
	});

	it("filters by library with in=", async () => {
		globalLibrary([snippet("g", "1")]);
		projectLibrary([snippet("p", "2")]);
		const host = await boot();
		const projectOnly = await ref(host, session(), "list in=project");
		assert.match(projectOnly, /^ {2}p /m);
		assert.doesNotMatch(projectOnly, /^ {2}g /m);
		const globalOnly = await ref(host, session(), "list in=global");
		assert.match(globalOnly, /^ {2}g /m);
		assert.doesNotMatch(globalOnly, /^ {2}p /m);
		assert.match(await ref(host, session(), "list in=here"), /unknown library "here"; the libraries are: global, project/);
	});

	it("in an untrusted project explains why the Project library is not loaded and points to /trust and a restart", async () => {
		projectLibrary([snippet("p", "2")]);
		const host = await boot();
		const text = await ref(host, session({ trusted: false }), "list");
		assert.match(text, /Project library .*pi-context-refs\.json: not loaded\. pi does not trust this project\. Run \/trust, then restart pi/);
		assert.doesNotMatch(text, /^ {2}p /m);
	});

	it("shows the warnings of the Project library, including a Ref refused for leaving the project", async () => {
		projectLibrary([{ name: "ssh", kind: "file", path: "~/.ssh/id_ed25519" }, snippet("ok", "1")]);
		const host = await boot();
		const text = await ref(host, session(), "list");
		assert.match(text, /Warnings:\n {2}.*\.pi\/pi-context-refs\.json \$\.refs\[0\]\.path: .*outside the project/);
		assert.match(text, /^ {2}ok /m);
	});
});

describe("/ref add in=project", () => {
	it("creates <cwd>/.pi/ and the Project library with version and $schema", async () => {
		const host = await boot();
		assert.equal(existsSync(join(project, ".pi")), false);
		const text = await ref(host, session(), "add rules snippet Use tabs. in=project");
		assert.match(text, /Added snippet Ref "rules" to the Project library/);
		assert.deepEqual(readRefs(projectFile()), [snippet("rules", "Use tabs.")]);
		const document = JSON.parse(readFileSync(projectFile(), "utf8"));
		assert.equal(document.version, 1);
		assert.match(document.$schema, /pi-context-refs\.schema\.json$/);
		assert.equal(existsSync(globalFile()), false, "nothing went to the Global library");
	});

	it("takes effect at once: the next message expands the new Project Ref", async () => {
		const host = await boot();
		const fake = session({ dialogs: {} });
		await ref(host, fake, "add rules snippet Use tabs. in=project");
		assert.equal(await sent(host, fake, "#rules"), "Use tabs.");
	});

	it("refuses in an untrusted project, pointing to /trust and a restart, and writes nothing", async () => {
		const host = await boot();
		const text = await ref(host, session({ trusted: false }), "add rules snippet Use tabs. in=project");
		assert.match(text, /not loaded\. pi does not trust this project\. Run \/trust, then restart pi/);
		assert.equal(existsSync(join(project, ".pi")), false);
	});

	it("checks confinement before saving: a Path or File outside the project, or through a symlink, is refused and nothing is written", async () => {
		const outside = join(root, "outside");
		mkdirSync(outside);
		symlinkSync(outside, join(project, "link"));
		const host = await boot();
		for (const args of [
			"add a path ../outside in=project",
			"add b file ~/.ssh/config in=project",
			"add c file link/key in=project",
			"add d dynamic ls cwd=.. in=project",
		]) {
			const text = await ref(host, session(), args);
			assert.match(text, /outside the project/, args);
		}
		assert.equal(existsSync(join(project, ".pi")), false);
	});

	it("accepts a target inside the project, even one that does not exist yet", async () => {
		const host = await boot();
		await ref(host, session(), "add spec path docs/new-spec.md in=project");
		assert.deepEqual(readRefs(projectFile()), [{ name: "spec", kind: "path", path: "docs/new-spec.md" }]);
	});

	it("refuses a scope, which only the Global library has", async () => {
		const host = await boot();
		const text = await ref(host, session(), "add a snippet x scope.path=/x in=project");
		assert.match(text, /scope: is only used in the Global library/);
		assert.equal(existsSync(join(project, ".pi")), false);
	});

	it("refuses a name already in the Project library, pointing to /ref edit", async () => {
		projectLibrary([snippet("rules", "old")]);
		const host = await boot();
		const text = await ref(host, session(), "add RULES snippet new in=project");
		assert.match(text, /"RULES" is already in the Project library as "rules"; change it with \/ref edit rules/);
		assert.deepEqual(readRefs(projectFile()), [snippet("rules", "old")]);
	});

	it("keeps unknown keys and invalid Refs in the Project library file", async () => {
		write(projectFile(), JSON.stringify({ version: 1, future: { a: 1 }, refs: [{ name: "bad name", kind: "snippet", text: "x" }] }));
		const host = await boot();
		await ref(host, session(), "add a snippet y in=project");
		const document = JSON.parse(readFileSync(projectFile(), "utf8"));
		assert.deepEqual(document.future, { a: 1 });
		assert.equal(document.refs.length, 2);
	});
});

describe("/ref add in=here", () => {
	it("writes a Global Ref scoped to this repository's remote, normalized to host/path", async () => {
		initRepo(project, { origin: "git@GitHub.com:Acme/App.git" });
		const host = await boot();
		const text = await ref(host, session(), "add notes snippet Mine. in=here");
		assert.match(text, /Added snippet Ref "notes" to the Global library, scoped to remote github\.com\/acme\/app/);
		assert.deepEqual(readRefs(globalFile()), [snippet("notes", "Mine.", { remote: "github.com/acme/app" })]);
		assert.equal(existsSync(join(project, ".pi")), false);
	});

	it("prefers origin when the repository has several remotes", async () => {
		initRepo(project, { fork: "https://github.com/me/app.git", origin: "https://github.com/acme/app.git" });
		const host = await boot();
		await ref(host, session(), "add notes snippet Mine. in=here");
		assert.deepEqual(readRefs(globalFile())[0]?.scope, { remote: "github.com/acme/app" });
	});

	it("scopes to the directory when there is no remote or no repository", async () => {
		const host = await boot();
		const text = await ref(host, session(), "add notes snippet Mine. in=here");
		assert.match(text, /scoped to directory /);
		assert.deepEqual(readRefs(globalFile()), [snippet("notes", "Mine.", { path: project })]);
		initRepo(project);
		await ref(host, session(), "add more snippet Mine. in=here");
		assert.deepEqual(readRefs(globalFile())[1]?.scope, { path: project });
	});

	it("appears here and not in another directory", async () => {
		const host = await boot();
		const fake = session({ dialogs: {} });
		await ref(host, fake, "add notes snippet Mine. in=here");
		assert.equal(await sent(host, fake, "#notes"), "Mine.");
		const elsewhere = createFakeSession({ cwd: root, hasUI: true });
		assert.equal(await sent(host, elsewhere, "#notes"), "#notes");
	});

	it("lets an explicit scope on the line win over the repository's", async () => {
		const host = await boot();
		await ref(host, session(), "add notes snippet Mine. scope.path=/elsewhere in=here");
		assert.deepEqual(readRefs(globalFile())[0]?.scope, { path: "/elsewhere" });
	});
});

describe("/ref add: what the new Ref shadows or is shadowed by", () => {
	it("says a Project Ref shadows the unscoped Global Ref of that name", async () => {
		globalLibrary([snippet("rules", "global")]);
		const host = await boot();
		const text = await ref(host, session(), "add rules snippet project in=project");
		assert.match(text, /Added snippet Ref "rules" to the Project library; it shadows "rules" in the Global library/);
	});

	it("says an unscoped Global Ref is shadowed by the Project Ref and that the Project one stays in force", async () => {
		projectLibrary([snippet("rules", "project")]);
		const host = await boot();
		const text = await ref(host, session(), "add rules snippet global");
		assert.match(
			text,
			/Added snippet Ref "rules" to the Global library; it is shadowed by "rules" in the Project library, so #rules still means that one here/,
		);
	});

	it("says a Scoped Ref shadows the Project Ref", async () => {
		projectLibrary([snippet("rules", "project")]);
		const host = await boot();
		const text = await ref(host, session(), "add rules snippet mine in=here");
		assert.match(text, /it shadows "rules" in the Project library/);
	});

	it("says nothing about shadowing when the name is new", async () => {
		const host = await boot();
		const text = await ref(host, session(), "add rules snippet x");
		assert.equal(text, 'Added snippet Ref "rules" to the Global library\n');
	});

	it("says when a Global Ref's scope does not match here", async () => {
		const host = await boot();
		const text = await ref(host, session(), "add away snippet x scope.path=/elsewhere");
		assert.match(text, /; its scope does not match here, so it is not Visible here/);
	});
});

describe("/ref edit with libraries", () => {
	it("edits the Visible Ref wherever it lives: a Project Ref by default", async () => {
		globalLibrary([snippet("rules", "global")]);
		projectLibrary([snippet("rules", "project")]);
		const host = await boot();
		const text = await ref(host, session(), "edit rules text=changed");
		assert.match(text, /Edited snippet Ref "rules"/);
		assert.deepEqual(readRefs(projectFile()), [snippet("rules", "changed")]);
		assert.deepEqual(readRefs(globalFile()), [snippet("rules", "global")]);
	});

	it("edits a Shadowed Ref with in=", async () => {
		globalLibrary([snippet("rules", "global")]);
		projectLibrary([snippet("rules", "project")]);
		const host = await boot();
		await ref(host, session(), "edit rules text=changed in=global");
		assert.deepEqual(readRefs(globalFile()), [snippet("rules", "changed")]);
		assert.deepEqual(readRefs(projectFile()), [snippet("rules", "project")]);
	});

	it("edits the Global Ref when no Visible Ref has the name", async () => {
		globalLibrary([snippet("away", "x", { path: join(root, "other") })]);
		const host = await boot();
		await ref(host, session(), "edit away text=y");
		assert.equal(readRefs(globalFile())[0]?.text, "y");
	});

	it("checks confinement before saving a Project Ref", async () => {
		projectLibrary([{ name: "doc", kind: "file", path: "README.md" }]);
		const before = readFileSync(projectFile(), "utf8");
		const host = await boot();
		const text = await ref(host, session(), "edit doc path=../secret in=project");
		assert.match(text, /outside the project/);
		assert.equal(readFileSync(projectFile(), "utf8"), before);
	});

	it("checks confinement for an edit made in the JSON editor", async () => {
		projectLibrary([{ name: "doc", kind: "file", path: "README.md" }]);
		const before = readFileSync(projectFile(), "utf8");
		let titles: string[] = [];
		const fake = session({
			dialogs: {
				editor: async (title, prefill) => {
					titles = [...titles, title];
					return titles.length === 1 ? prefill?.replace("README.md", "../secret") : undefined;
				},
			},
		});
		const host = await boot();
		await ref(host, fake, "edit doc");
		assert.match(titles[1] ?? "", /outside the project/);
		assert.equal(readFileSync(projectFile(), "utf8"), before);
	});

	it("refuses in=project in an untrusted project", async () => {
		projectLibrary([snippet("rules", "project")]);
		const host = await boot();
		const text = await ref(host, session({ trusted: false }), "edit rules text=x in=project");
		assert.match(text, /Run \/trust, then restart pi/);
	});

	it("with in=here scopes the Global Ref to this repository and says what that does", async () => {
		initRepo(project, { origin: "https://github.com/acme/app.git" });
		globalLibrary([snippet("rules", "global")]);
		projectLibrary([snippet("rules", "project")]);
		const host = await boot();
		const text = await ref(host, session(), "edit rules in=here");
		assert.match(text, /Edited snippet Ref "rules"; it shadows "rules" in the Project library/);
		assert.deepEqual(readRefs(globalFile())[0]?.scope, { remote: "github.com/acme/app" });
	});

	it("reports what a rename shadows or is shadowed by", async () => {
		globalLibrary([snippet("a", "global-a")]);
		projectLibrary([snippet("b", "project-b")]);
		const host = await boot();
		const text = await ref(host, session(), "edit a name=b in=global");
		assert.match(text, /Renamed "a" to "b"; it is shadowed by "b" in the Project library/);
	});

	it("asks which Ref in the library the in= names when the name is missing", async () => {
		globalLibrary([snippet("g", "1")]);
		projectLibrary([snippet("p", "2")]);
		let options: string[] = [];
		const fake = session({
			dialogs: {
				select: async (_title, choices) => {
					options = choices;
					return "p";
				},
				editor: async (_title, prefill) => prefill?.replace('"2"', '"changed"'),
			},
		});
		const host = await boot();
		await ref(host, fake, "edit in=project");
		assert.deepEqual(options, ["p"]);
		assert.equal(readRefs(projectFile())[0]?.text, "changed");
	});
});

describe("/ref remove with libraries", () => {
	it("removes the Visible Ref: a Project Ref by default, leaving the Global one", async () => {
		globalLibrary([snippet("rules", "global")]);
		projectLibrary([snippet("rules", "project"), snippet("other", "x")]);
		const host = await boot();
		const text = await ref(host, session(), "remove rules");
		assert.match(text, /Removed "rules" from the Project library/);
		assert.deepEqual(readRefs(projectFile()), [snippet("other", "x")]);
		assert.deepEqual(readRefs(globalFile()), [snippet("rules", "global")]);
	});

	it("removes a Shadowed Ref with in=<library>", async () => {
		globalLibrary([snippet("rules", "global")]);
		projectLibrary([snippet("rules", "project")]);
		const host = await boot();
		const text = await ref(host, session(), "remove rules in=global");
		assert.match(text, /Removed "rules" from the Global library/);
		assert.deepEqual(readRefs(globalFile()), []);
		assert.deepEqual(readRefs(projectFile()), [snippet("rules", "project")]);
	});

	it("names in the TUI confirm the Ref the removed one was shadowing", async () => {
		globalLibrary([snippet("rules", "global")]);
		projectLibrary([snippet("rules", "project")]);
		const asked: string[] = [];
		const fake = session({
			dialogs: {
				confirm: async (_title, message) => {
					asked.push(message);
					return true;
				},
			},
		});
		const host = await boot();
		await ref(host, fake, "remove rules");
		assert.match(asked[0] ?? "", /Project library/);
		assert.match(asked[0] ?? "", /It shadows "rules" in the Global library; removing it makes that Ref Visible\./);
		assert.deepEqual(readRefs(projectFile()), []);
	});

	it("says in the confirm that removing a Shadowed Ref changes nothing you can see", async () => {
		globalLibrary([snippet("rules", "global")]);
		projectLibrary([snippet("rules", "project")]);
		const asked: string[] = [];
		const fake = session({
			dialogs: {
				confirm: async (_title, message) => {
					asked.push(message);
					return false;
				},
			},
		});
		const host = await boot();
		await ref(host, fake, "remove rules in=global");
		assert.match(asked[0] ?? "", /It is shadowed by "rules" in the Project library, so removing it changes nothing you can see\./);
		assert.deepEqual(readRefs(globalFile()), [snippet("rules", "global")], "a refused confirm keeps the Ref");
	});

	it("says nothing about shadowing when the Ref shadows nothing", async () => {
		globalLibrary([snippet("rules", "global")]);
		const asked: string[] = [];
		const fake = session({
			dialogs: {
				confirm: async (_title, message) => {
					asked.push(message);
					return true;
				},
			},
		});
		const host = await boot();
		await ref(host, fake, "remove rules");
		assert.doesNotMatch(asked[0] ?? "", /shadow/i);
	});

	it("refuses in=project in an untrusted project, and the default never looks at the Project library there", async () => {
		globalLibrary([snippet("rules", "global")]);
		projectLibrary([snippet("rules", "project")]);
		const host = await boot();
		assert.match(await ref(host, session({ trusted: false }), "remove rules in=project"), /Run \/trust, then restart pi/);
		assert.match(await ref(host, session({ trusted: false }), "remove rules"), /Removed "rules" from the Global library/);
		assert.deepEqual(readRefs(projectFile()), [snippet("rules", "project")]);
	});

	it("says when the named library has no such Ref", async () => {
		globalLibrary([snippet("rules", "global")]);
		const host = await boot();
		assert.match(await ref(host, session(), "remove rules in=project"), /no Ref named "rules" in the Project library/);
	});

	it("stops expanding a removed Project Ref in the next message", async () => {
		projectLibrary([snippet("rules", "project")]);
		const host = await boot();
		const fake = session({ dialogs: { confirm: async () => true } });
		assert.equal(await sent(host, fake, "#rules"), "project");
		await ref(host, fake, "remove rules");
		assert.equal(await sent(host, fake, "#rules"), "#rules");
	});
});
