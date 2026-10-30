// /ref approvals, approve and revoke, and the Approval that adding, editing and removing a Project Dynamic Ref carry, at the fake pi host with fake dialogs.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createJiti } from "jiti";
import { createFakeHost, createFakeSession } from "../support/fake-pi.ts";

const INDEX = join(import.meta.dirname, "..", "..", "src", "index.ts");

let root = "";
let agentDir = "";
let project = "";
const realStderrWrite = process.stderr.write.bind(process.stderr);
const savedEnv = { ...process.env };

beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "context-refs-approvals-")));
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

const approvalsFile = () => join(agentDir, "pi-context-refs-approvals.json");
const projectFile = (cwd = project) => join(cwd, ".pi", "pi-context-refs.json");
const write = (file: string, content: string) => {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, content);
};
const projectLibrary = (refs: unknown[], cwd = project) => write(projectFile(cwd), JSON.stringify({ version: 1, refs }));
const globalLibrary = (refs: unknown[]) => write(join(agentDir, "pi-context-refs.json"), JSON.stringify({ version: 1, refs }));
const readRefs = () => (JSON.parse(readFileSync(projectFile(), "utf8")) as { refs: Array<Record<string, unknown>> }).refs;
const approvals = () =>
	existsSync(approvalsFile()) ? (JSON.parse(readFileSync(approvalsFile(), "utf8")) as { approvals: Array<Record<string, string>> }).approvals : [];
const approvedNames = () => approvals().map((approval) => approval.name);

const marker = () => join(project, "ran.txt");
const touching = (name: string, extra: Record<string, unknown> = {}) => ({
	name,
	kind: "dynamic",
	command: [process.execPath, "-e", "require('node:fs').writeFileSync(process.argv[1], 'ran')", marker()],
	...extra,
});
const page = (name: string, url = "http://127.0.0.1:9/spec") => ({ name, kind: "dynamic", url });
const snippet = (name: string) => ({ name, kind: "snippet", text: "x" });

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

/** A session. With `dialogs` it has a UI (the TUI, or RPC); without, it is print mode. */
function session(options: { dialogs?: Dialogs; trusted?: boolean; cwd?: string } = {}) {
	const fake = createFakeSession({ cwd: options.cwd ?? project, hasUI: options.dialogs !== undefined, trusted: options.trusted ?? true });
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

/** What the model would get for `text` in print mode, where nothing is ever asked. */
async function sentInPrint(host: Host, text: string): Promise<string> {
	const fake = session();
	await host.fire("session_start", { type: "session_start", reason: "startup" }, fake.ctx);
	return ((await host.fire("input", { type: "input", text, source: "interactive" }, fake.ctx)) as { text: string } | undefined)?.text ?? text;
}

const said = (fake: ReturnType<typeof session>) => fake.notices.map((notice) => notice.message).join("\n");
const ask = (answer: boolean) => {
	const questions: Array<{ title: string; message: string }> = [];
	return {
		questions,
		confirm: async (title: string, message: string) => {
			questions.push({ title, message });
			return answer;
		},
	};
};

describe("/ref approve", () => {
	it("refuses with no UI, says to run it in pi, and approves nothing", async () => {
		projectLibrary([touching("tests")]);
		const host = await boot();
		const text = await ref(host, session(), "approve tests");
		assert.match(text, /needs a confirm in pi's UI.*Run it in pi/);
		assert.equal(existsSync(approvalsFile()), false);
		assert.equal((await sentInPrint(host, "#tests")).includes("error="), true);
	});

	it("shows the exact definition in a confirm, and stores an Approval that print mode then honours", async () => {
		projectLibrary([touching("tests")]);
		const host = await boot();
		const dialog = ask(true);
		const fake = session({ dialogs: dialog });
		await ref(host, fake, "approve tests");
		assert.equal(dialog.questions.length, 1);
		assert.equal(dialog.questions[0]?.title, "Approve #tests?");
		assert.match(dialog.questions[0]?.message ?? "", /source: command\nargv: .*ran\.txt.*\ncwd: /);
		assert.ok(dialog.questions[0]?.message.includes(`cwd: ${project}`));
		assert.equal(said(fake), 'Approved "tests"');
		const [stored] = approvals();
		assert.equal(stored?.project, project);
		assert.equal(stored?.name, "tests");
		assert.match(stored?.hash ?? "", /^[0-9a-f]{64}$/);
		assert.equal((await sentInPrint(host, "#tests")).includes("error="), false);
		assert.equal(existsSync(marker()), true);
	});

	it("approves a URL Ref the same way", async () => {
		projectLibrary([page("spec")]);
		const host = await boot();
		const dialog = ask(true);
		await ref(host, session({ dialogs: dialog }), "approve spec");
		assert.match(dialog.questions[0]?.message ?? "", /source: url\nurl: http:\/\/127\.0\.0\.1:9\/spec/);
		assert.deepEqual(approvedNames(), ["spec"]);
	});

	it("approves nothing when the confirm is refused", async () => {
		projectLibrary([touching("tests")]);
		const host = await boot();
		const fake = session({ dialogs: ask(false) });
		await ref(host, fake, "approve tests");
		assert.equal(said(fake), 'Did not approve "tests"');
		assert.equal(existsSync(approvalsFile()), false);
	});

	it("says so when the definition is approved already, and asks nothing", async () => {
		projectLibrary([touching("tests")]);
		const host = await boot();
		await ref(host, session({ dialogs: ask(true) }), "approve tests");
		const again = session({ dialogs: {} });
		await ref(host, again, "approve tests");
		assert.equal(said(again), '"tests" is already approved as it is defined now');
	});

	it("asks again for a Ref whose definition changed", async () => {
		projectLibrary([touching("tests")]);
		const host = await boot();
		await ref(host, session({ dialogs: ask(true) }), "approve tests");
		projectLibrary([touching("tests", { cwd: "sub" })]);
		const dialog = ask(true);
		await ref(host, session({ dialogs: dialog }), "approve tests");
		assert.equal(dialog.questions.length, 1);
		assert.equal(approvals().length, 1, "the old Approval is replaced, not kept");
	});

	it("names the problem for a Ref that is unknown or has nothing to run", async () => {
		projectLibrary([snippet("notes")]);
		globalLibrary([touching("mine")]);
		const host = await boot();
		const unknown = session({ dialogs: {} });
		await ref(host, unknown, "approve nothing");
		assert.match(said(unknown), /no command or URL Ref named "nothing" in the Project library/);
		const text = session({ dialogs: {} });
		await ref(host, text, "approve notes");
		assert.match(said(text), /no command or URL Ref named "notes"/);
		const global = session({ dialogs: {} });
		await ref(host, global, "approve mine");
		assert.match(said(global), /no command or URL Ref named "mine"/, "a Global Ref needs no Approval");
	});

	it("refuses in an untrusted project", async () => {
		projectLibrary([touching("tests")]);
		const host = await boot();
		const fake = session({ dialogs: {}, trusted: false });
		await ref(host, fake, "approve tests");
		assert.match(said(fake), /not loaded.*\/trust/s);
	});

	it("asks which pending Ref when the name is missing, and says when none is waiting", async () => {
		projectLibrary([touching("tests"), page("spec"), snippet("notes")]);
		const host = await boot();
		const options: string[][] = [];
		const dialog = ask(true);
		await ref(
			host,
			session({
				dialogs: {
					...dialog,
					select: async (_title, list) => {
						options.push(list);
						return "spec";
					},
				},
			}),
			"approve",
		);
		assert.deepEqual(options, [["tests", "spec"]]);
		assert.deepEqual(approvedNames(), ["spec"]);
		projectLibrary([snippet("notes")]);
		const none = session({ dialogs: {} });
		await ref(host, none, "approve");
		assert.equal(said(none), "No Project Dynamic Ref is waiting for an Approval");
	});

	it("has no form that approves everything", async () => {
		projectLibrary([touching("tests")]);
		const host = await boot();
		const fake = session({ dialogs: ask(true) });
		await ref(host, fake, "approve all");
		await ref(host, fake, "approve --all");
		await ref(host, fake, "approve tests extra");
		assert.equal(existsSync(approvalsFile()), false);
	});
});

describe("/ref approvals and /ref list", () => {
	it("lists the Approvals with their definition and date, and the Refs that are pending", async () => {
		projectLibrary([touching("tests"), page("spec")]);
		const host = await boot();
		await ref(host, session({ dialogs: ask(true) }), "approve tests");
		const text = await ref(host, session(), "approvals");
		assert.match(text, new RegExp(`^Approvals for ${project}$`, "m"));
		assert.match(text, /^Approved \(1\):\n {2}tests {2}command .*ran\.txt.* \(in .*\) {2}approved \d{4}-\d\d-\d\dT[\d:.]+Z$/m);
		assert.match(text, /^Pending \(1\):\n {2}spec {2}url http:\/\/127\.0\.0\.1:9\/spec {2}approve it with \/ref approve spec$/m);
	});

	it("says when a definition changed or a Ref is gone", async () => {
		projectLibrary([touching("tests"), touching("gone")]);
		const host = await boot();
		await ref(host, session({ dialogs: ask(true) }), "approve tests");
		await ref(host, session({ dialogs: ask(true) }), "approve gone");
		projectLibrary([touching("tests", { cwd: "sub" })]);
		const text = await ref(host, session(), "approvals");
		assert.match(text, /^ {2}tests .*; the Ref has changed since, so it is pending again$/m);
		assert.match(text, /^ {2}gone .*; the Ref is not in the Project library any more$/m);
		assert.match(text, /^Pending \(1\):\n {2}tests /m);
	});

	it("is the same text in the TUI as in print mode, and says when there is nothing", async () => {
		projectLibrary([snippet("notes")]);
		const host = await boot();
		const print = await ref(host, session(), "approvals");
		assert.match(print, /Approved: none\nPending: none/);
		const tui = session({ dialogs: {} });
		await ref(host, tui, "approvals");
		assert.equal(`${tui.notices[0]?.message}\n`, print);
	});

	it("names the approvals file when it cannot be read", async () => {
		projectLibrary([touching("tests")]);
		write(approvalsFile(), "{ not json");
		const host = await boot();
		assert.match(await ref(host, session(), "approvals"), /pi-context-refs-approvals\.json does not parse/);
		assert.match(await ref(host, session(), "revoke tests"), /pi-context-refs-approvals\.json does not parse/);
	});

	it("shows only this project's Approvals", async () => {
		const other = join(root, "other");
		mkdirSync(other);
		projectLibrary([touching("tests")]);
		projectLibrary([touching("elsewhere")], other);
		const host = await boot();
		await ref(host, session({ dialogs: ask(true), cwd: other }), "approve elsewhere");
		const text = await ref(host, session(), "approvals");
		assert.doesNotMatch(text, /elsewhere/);
	});

	it("marks each Project Dynamic Ref approved or pending in /ref list, and no other Ref", async () => {
		projectLibrary([touching("tests"), page("spec"), snippet("notes")]);
		globalLibrary([touching("mine")]);
		const host = await boot();
		await ref(host, session({ dialogs: ask(true) }), "approve tests");
		const text = await ref(host, session(), "list");
		assert.match(text, /^ {2}tests {2}dynamic {2}.*\(approved\)$/m);
		assert.match(text, /^ {2}spec {2}dynamic {2}http.*\(pending\)$/m);
		assert.match(text, /^ {2}notes {2}snippet {2}"x"$/m);
		assert.doesNotMatch(text, /^ {2}mine .*\((approved|pending)\)$/m);
	});
});

describe("/ref revoke", () => {
	const approveAll = async (host: Host, names: string[]) => {
		for (const name of names) await ref(host, session({ dialogs: ask(true) }), `approve ${name}`);
	};

	it("drops one Approval with no confirm, so print mode fails the Ref again", async () => {
		projectLibrary([touching("tests"), page("spec")]);
		const host = await boot();
		await approveAll(host, ["tests", "spec"]);
		const fake = session({ dialogs: {} });
		await ref(host, fake, "revoke tests");
		assert.equal(said(fake), 'Revoked the Approval of "tests"');
		assert.deepEqual(approvedNames(), ["spec"]);
		assert.match(await sentInPrint(host, "#tests"), /error="it is not approved/);
	});

	it("works with no UI at all", async () => {
		projectLibrary([touching("tests")]);
		const host = await boot();
		await approveAll(host, ["tests"]);
		assert.match(await ref(host, session(), "revoke tests"), /Revoked the Approval of "tests"/);
		assert.deepEqual(approvals(), []);
	});

	it("drops all of this project's Approvals and no other project's", async () => {
		const other = join(root, "other");
		mkdirSync(other);
		projectLibrary([touching("tests"), page("spec")]);
		projectLibrary([touching("tests")], other);
		const host = await boot();
		await approveAll(host, ["tests", "spec"]);
		await ref(host, session({ dialogs: ask(true), cwd: other }), "approve tests");
		assert.match(await ref(host, session(), "revoke all"), /Revoked 2 Approvals/);
		assert.deepEqual(
			approvals().map((approval) => approval.project),
			[other],
		);
		assert.match(await ref(host, session(), "revoke all"), /This project has no Approvals/);
	});

	it("says when the Ref has no Approval", async () => {
		projectLibrary([touching("tests")]);
		const host = await boot();
		assert.match(await ref(host, session(), "revoke tests"), /"tests" has no Approval in this project/);
	});

	it("asks which Approval when the name is missing and there is a UI, and needs a name without one", async () => {
		projectLibrary([touching("tests"), page("spec")]);
		const host = await boot();
		await approveAll(host, ["tests", "spec"]);
		const options: string[][] = [];
		await ref(
			host,
			session({
				dialogs: {
					select: async (_title, list) => {
						options.push(list);
						return "spec";
					},
				},
			}),
			"revoke",
		);
		assert.deepEqual(options, [["tests", "spec", "all"]]);
		assert.deepEqual(approvedNames(), ["tests"]);
		assert.match(await ref(host, session(), "revoke"), /a name is needed when there is no UI\n\/ref revoke <name\|all>/);
	});
});

describe("/ref add in=project", () => {
	const addLine = "add lint dynamic eslint --max-warnings 0 in=project";

	it("saves the Ref and approves exactly that definition in one confirm that shows it", async () => {
		const host = await boot();
		const dialog = ask(true);
		const fake = session({ dialogs: dialog });
		await ref(host, fake, addLine);
		assert.equal(dialog.questions.length, 1);
		assert.equal(dialog.questions[0]?.title, "Save #lint and approve it?");
		assert.match(dialog.questions[0]?.message ?? "", /source: command\nargv: eslint --max-warnings 0\ncwd: /);
		assert.deepEqual(
			readRefs().map((entry) => entry.name),
			["lint"],
		);
		assert.deepEqual(approvedNames(), ["lint"]);
		assert.match(said(fake), /Added dynamic Ref "lint" to the Project library.*; approved this definition$/);
		const sentText = await sentInPrint(host, "#lint");
		assert.doesNotMatch(sentText, /it is not approved/);
	});

	it("saves nothing and approves nothing when the confirm is refused", async () => {
		const host = await boot();
		const fake = session({ dialogs: ask(false) });
		await ref(host, fake, addLine);
		assert.equal(said(fake), "Cancelled; nothing was saved");
		assert.equal(existsSync(projectFile()), false);
		assert.equal(existsSync(approvalsFile()), false);
	});

	it("confirms for a URL Ref too", async () => {
		const host = await boot();
		const dialog = ask(true);
		await ref(host, session({ dialogs: dialog }), "add spec dynamic http://127.0.0.1:9/x in=project");
		assert.match(dialog.questions[0]?.message ?? "", /source: url\nurl: http:\/\/127\.0\.0\.1:9\/x/);
		assert.deepEqual(approvedNames(), ["spec"]);
	});

	it("saves headless with no Approval, and print mode then fails the Ref", async () => {
		const host = await boot();
		await ref(host, session(), addLine);
		assert.deepEqual(
			readRefs().map((entry) => entry.name),
			["lint"],
		);
		assert.equal(existsSync(approvalsFile()), false);
		assert.match(await sentInPrint(host, "#lint"), /error="it is not approved; approve it in pi with \/ref approve lint"/);
	});

	it("asks nothing for a Snippet, and nothing for a Dynamic Ref saved in the Global library", async () => {
		const host = await boot();
		const fake = session({ dialogs: {} });
		await ref(host, fake, "add note snippet hello in=project");
		await ref(host, fake, "add lint dynamic eslint");
		await ref(host, fake, "add here dynamic eslint in=here");
		assert.equal(existsSync(approvalsFile()), false);
		assert.doesNotMatch(said(fake), /approved/);
	});

	it("keeps a refused Ref out of the library when the confinement check fails, before it asks", async () => {
		const host = await boot();
		const dialog = ask(true);
		await ref(host, session({ dialogs: dialog }), "add bad dynamic eslint cwd=/etc in=project");
		assert.equal(dialog.questions.length, 0);
		assert.equal(existsSync(projectFile()), false);
	});

	it("reports an Approval that could not be stored, with the Ref saved", async () => {
		write(approvalsFile(), "{ not json");
		const host = await boot();
		const fake = session({ dialogs: ask(true) });
		await ref(host, fake, addLine);
		assert.match(said(fake), /pi-context-refs-approvals\.json does not parse.*the Ref is saved but not approved/);
		assert.equal(fake.notices.at(-1)?.type, "error");
		assert.deepEqual(
			readRefs().map((entry) => entry.name),
			["lint"],
		);
	});
});

describe("/ref edit of a Project Dynamic Ref", () => {
	it("saves the change and approves the new definition in one confirm", async () => {
		projectLibrary([touching("tests")]);
		const host = await boot();
		await ref(host, session({ dialogs: ask(true) }), "approve tests");
		const before = approvals()[0]?.hash;
		const dialog = ask(true);
		const fake = session({ dialogs: dialog });
		await ref(host, fake, "edit tests cwd=sub");
		assert.equal(dialog.questions.length, 1);
		assert.equal(dialog.questions[0]?.title, "Save #tests and approve it?");
		assert.equal(readRefs()[0]?.cwd, "sub");
		assert.notEqual(approvals()[0]?.hash, before);
		assert.equal(approvals().length, 1);
		assert.match(said(fake), /Edited dynamic Ref "tests".*; approved this definition$/);
	});

	it("saves nothing when the confirm is refused", async () => {
		projectLibrary([touching("tests")]);
		const host = await boot();
		const fake = session({ dialogs: ask(false) });
		await ref(host, fake, "edit tests cwd=sub");
		assert.equal(said(fake), "Cancelled; nothing was saved");
		assert.equal(readRefs()[0]?.cwd, undefined);
		assert.equal(fake.notices.at(-1)?.type, "info");
	});

	it("asks nothing when the definition is approved already, as when only the description changes", async () => {
		projectLibrary([touching("tests")]);
		const host = await boot();
		await ref(host, session({ dialogs: ask(true) }), "approve tests");
		const before = approvals()[0]?.hash;
		await ref(host, session({ dialogs: {} }), "edit tests desc=hello");
		assert.equal(readRefs()[0]?.description, "hello");
		assert.equal(approvals()[0]?.hash, before);
	});

	it("saves headless with no Approval, so the Ref is pending again", async () => {
		projectLibrary([touching("tests")]);
		const host = await boot();
		await ref(host, session({ dialogs: ask(true) }), "approve tests");
		const before = approvals()[0]?.hash;
		await ref(host, session(), "edit tests cwd=sub");
		assert.equal(readRefs()[0]?.cwd, "sub");
		assert.equal(approvals()[0]?.hash, before);
		assert.match(await sentInPrint(host, "#tests"), /error="it is not approved/);
	});

	const addCwd = async (_title: string, prefill?: string) => JSON.stringify({ ...JSON.parse(prefill ?? "{}"), cwd: "sub" }, null, 2);

	it("confirms after an edit made in the JSON editor, and a refusal is reported as cancelled, not as an error", async () => {
		projectLibrary([touching("tests")]);
		const host = await boot();
		const dialog = ask(false);
		const fake = session({ dialogs: { ...dialog, editor: addCwd } });
		const original = readFileSync(projectFile(), "utf8");
		await ref(host, fake, "edit tests");
		assert.equal(dialog.questions.length, 1);
		assert.equal(said(fake), "Cancelled; nothing was saved");
		assert.equal(fake.notices.at(-1)?.type, "info");
		assert.equal(readFileSync(projectFile(), "utf8"), original);
		assert.equal(existsSync(approvalsFile()), false);
	});

	it("saves and approves an edit made in the JSON editor when the confirm is accepted", async () => {
		projectLibrary([touching("tests")]);
		const host = await boot();
		await ref(host, session({ dialogs: { ...ask(true), editor: addCwd } }), "edit tests");
		assert.equal(readRefs()[0]?.cwd, "sub");
		assert.deepEqual(approvedNames(), ["tests"]);
	});

	it("drops the Approval of the old name on a rename and approves the new name", async () => {
		projectLibrary([touching("tests")]);
		const host = await boot();
		await ref(host, session({ dialogs: ask(true) }), "approve tests");
		await ref(host, session({ dialogs: ask(true) }), "edit tests name=check");
		assert.deepEqual(approvedNames(), ["check"]);
	});

	it("drops the Approval of the old name on a headless rename", async () => {
		projectLibrary([touching("tests")]);
		const host = await boot();
		await ref(host, session({ dialogs: ask(true) }), "approve tests");
		await ref(host, session(), "edit tests name=check");
		assert.deepEqual(approvals(), []);
	});
});

describe("/ref remove of a Project Dynamic Ref", () => {
	it("drops its Approval, so a later Ref with the same name starts unapproved", async () => {
		projectLibrary([touching("tests"), touching("keep")]);
		const host = await boot();
		await ref(host, session({ dialogs: ask(true) }), "approve tests");
		await ref(host, session({ dialogs: ask(true) }), "approve keep");
		await ref(host, session(), "remove tests");
		assert.deepEqual(approvedNames(), ["keep"]);
		await ref(host, session(), "add tests dynamic eslint in=project");
		assert.match(await sentInPrint(host, "#tests"), /error="it is not approved/);
	});

	it("leaves the Approvals alone when a Global Ref of the same name is removed", async () => {
		projectLibrary([touching("tests")]);
		globalLibrary([touching("tests")]);
		const host = await boot();
		await ref(host, session({ dialogs: ask(true) }), "approve tests");
		await ref(host, session(), "remove tests in=global");
		assert.deepEqual(approvedNames(), ["tests"]);
	});

	it("reports an approvals file that cannot be changed, with the Ref removed", async () => {
		projectLibrary([touching("tests")]);
		write(approvalsFile(), "{ not json");
		const host = await boot();
		const text = await ref(host, session(), "remove tests");
		assert.match(text, /Removed "tests" from the Project library; .*pi-context-refs-approvals\.json does not parse/);
	});
});
