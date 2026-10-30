// Opt-in: runs real pi (`npm run test:smoke`). The Project library, Scoped Refs and precedence in print mode, with the trust pi resolved at start.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { initRepo } from "../support/git-repo.ts";
import { runPrint } from "../support/pi-process.ts";
import { probeRun } from "../support/probe-run.ts";

const EXTENSION = join(import.meta.dirname, "..", "..", "src", "index.ts");

const snippet = (name: string, text: string, scope?: Record<string, string>) => ({ name, kind: "snippet", text, ...(scope && { scope }) });

/** A user in a project directory; `files` are written under it. A `.pi/settings.json` makes pi ask for trust, which print mode cannot, so the project is untrusted. */
function user(files: Record<string, unknown> = {}) {
	const agentDir = join(mkdtempSync(join(tmpdir(), "context-refs-agent-")), "agent");
	mkdirSync(agentDir, { recursive: true });
	const probe = probeRun("none");
	const write = (path: string, content: unknown) => {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, JSON.stringify(content));
	};
	for (const [name, content] of Object.entries(files)) write(join(probe.dir, name), content);
	return {
		project: probe.dir,
		agentDir,
		globalLibrary: (refs: unknown[]) => write(join(agentDir, "pi-context-refs.json"), { version: 1, refs }),
		async pi(prompt: string) {
			const options = { ...probe.options, extensions: [EXTENSION], env: { ...probe.options.env, PI_CODING_AGENT_DIR: agentDir } };
			const result = await runPrint(prompt, options);
			return { ...result, received: probe.received() };
		},
	};
}

const PROJECT_LIBRARY = ".pi/pi-context-refs.json";
const library = (refs: unknown[]) => ({ version: 1, refs });

describe("the Project library in real pi (DESIGN.md section 5.2)", () => {
	it("loads in a project whose only .pi file is the library, and wins over an unscoped Global Ref", async () => {
		const me = user({ [PROJECT_LIBRARY]: library([snippet("rules", "project rules"), snippet("solo", "only here")]) });
		me.globalLibrary([snippet("rules", "global rules"), snippet("mine", "personal")]);
		const run = await me.pi("Apply #rules, #solo and #mine");
		assert.equal(run.code, 0, run.stderr);
		assert.deepEqual(run.received, [{ text: "Apply project rules, only here and personal", images: 0 }]);
	});

	it("does not load in a project pi does not trust, and /ref says why", async () => {
		const me = user({ [PROJECT_LIBRARY]: library([snippet("rules", "project rules")]), ".pi/settings.json": {} });
		me.globalLibrary([snippet("rules", "global rules")]);
		assert.deepEqual((await me.pi("Apply #rules")).received, [{ text: "Apply global rules", images: 0 }]);
		const listed = await me.pi("/ref list");
		assert.match(listed.stderr, /Project library .*pi-context-refs\.json: not loaded\. pi does not trust this project\. Run \/trust, then restart pi/);
		const refused = await me.pi("/ref add x snippet y in=project");
		assert.match(refused.stderr, /Run \/trust, then restart pi/);
	});

	it("skips a Ref that leaves the project and warns on stderr", async () => {
		const me = user({ [PROJECT_LIBRARY]: library([{ name: "ssh", kind: "file", path: "~/.ssh/id_ed25519" }, snippet("ok", "fine")]) });
		const run = await me.pi("See #ssh and #ok");
		assert.deepEqual(run.received, [{ text: "See #ssh and fine", images: 0 }]);
		assert.match(run.stderr, /\$\.refs\[0\]\.path: .*outside the project/);
	});

	it("adds to the Project library with in=project, creating .pi/, and lists the Shadowed Ref", async () => {
		const me = user();
		me.globalLibrary([snippet("rules", "global rules")]);
		const added = await me.pi("/ref add rules snippet project rules in=project");
		assert.match(added.stderr, /Added snippet Ref "rules" to the Project library; it shadows "rules" in the Global library/);
		assert.deepEqual(JSON.parse(readFileSync(join(me.project, PROJECT_LIBRARY), "utf8")).refs, [snippet("rules", "project rules")]);
		const listed = await me.pi("/ref list");
		assert.match(listed.stderr, /^Shadowed Refs:\n {2}rules {2}in the Global library, hidden by the Project library$/m);
	});
});

describe("Scoped Refs in real pi (DESIGN.md section 5.3)", () => {
	it("appear in a repository whose remote matches and in a scoped directory, and beat the Project library", async () => {
		const me = user({ [PROJECT_LIBRARY]: library([snippet("rules", "project rules")]) });
		initRepo(me.project, { origin: "git@github.com:Acme/App.git" });
		me.globalLibrary([
			snippet("rules", "scoped rules", { remote: "github.com/acme/app" }),
			snippet("here", "this directory", { path: me.project }),
			snippet("away", "elsewhere", { remote: "github.com/acme/other" }),
		]);
		const run = await me.pi("#rules #here #away");
		assert.deepEqual(run.received, [{ text: "scoped rules this directory #away", images: 0 }]);
	});

	it("/ref add in=here scopes a Global Ref to this repository's remote", async () => {
		const me = user();
		initRepo(me.project, { origin: "https://github.com/acme/app.git" });
		const added = await me.pi("/ref add notes snippet Mine. in=here");
		assert.match(added.stderr, /Added snippet Ref "notes" to the Global library, scoped to remote github\.com\/acme\/app/);
		assert.deepEqual((await me.pi("#notes")).received, [{ text: "Mine.", images: 0 }]);
	});
});
