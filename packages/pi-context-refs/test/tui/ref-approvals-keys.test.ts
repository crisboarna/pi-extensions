// Layer B: `/ref approvals`, `/ref approve` and `/ref revoke` under the keys of pi's real TUI. Real interactive pi runs in this process
// on a virtual terminal, in a trusted project whose library holds two command Refs. The command asks in a selector and a confirm that
// show the exact definition; what it records goes to a file outside the project, which the tests read back, so every answer is
// checked against what was saved as well as against what the person is told.
//
// covers: src/pi/ref-approvals.ts
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { TuiSession } from "../support/tui-session.ts";

const ESC = "\x1b";
const ENTER = "\r";
const command = (text: string) => [process.execPath, "-e", `console.log('${text}')`];
const LIBRARY = {
	version: 1,
	refs: [
		{ name: "setup", kind: "dynamic", command: command("a") },
		{ name: "other", kind: "dynamic", command: command("b") },
	],
};

interface Project {
	tui: TuiSession;
	/** The names the approvals file holds. */
	approved(): string[];
	/** The names of the Refs in the Project library file. */
	projectRefs(): string[];
}

async function withProject(body: (project: Project) => Promise<void>): Promise<void> {
	const tui = await TuiSession.start({});
	try {
		await tui.ready();
		mkdirSync(join(tui.project, ".pi"));
		writeFileSync(join(tui.project, ".pi", "pi-context-refs.json"), JSON.stringify(LIBRARY));
		const file = join(tui.agentDir, "pi-context-refs-approvals.json");
		const library = join(tui.project, ".pi", "pi-context-refs.json");
		await body({
			tui,
			projectRefs: () => (JSON.parse(readFileSync(library, "utf8")) as { refs: Array<{ name: string }> }).refs.map((ref) => ref.name),
			approved: () =>
				existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { approvals: Array<{ name: string }> }).approvals.map((one) => one.name) : [],
		});
	} finally {
		await tui.close();
	}
}

/** Approves one Ref by name and waits for the result line. */
async function approve(tui: TuiSession, name: string): Promise<void> {
	await tui.terminal.runCommand(`/ref approve ${name}`, `Approve #${name}?`);
	tui.terminal.press(ENTER);
	await tui.terminal.waitForScreen((screen) => screen.includes(`Approved "${name}"`));
}

describe("/ref approvals under the keys of pi's real TUI", () => {
	it("lists the Project's command Refs as waiting, each with the command that approves it", () =>
		withProject(async ({ tui }) => {
			const listing = await tui.terminal.runCommand("/ref approvals", "Pending (2)");
			assert.match(listing, /Approved: none/);
			assert.match(listing, /setup\s+command .*console\.log\('a'\)/);
			assert.match(listing, /other\s+command .*console\.log\('b'\)/);
			assert.match(listing, /approve it with\s+\/ref approve setup/);
			assert.match(listing, /approve it with\s+\/ref approve other/);
		}));

	it("moves a Ref from waiting to approved once it is approved", () =>
		withProject(async ({ tui }) => {
			await approve(tui, "setup");
			const listing = await tui.terminal.runCommand("/ref approvals", "Approved (1)");
			assert.match(listing, /Pending \(1\)/);
			assert.match(listing, /setup\s+command .*console\.log\('a'\).*approved\s+\d{4}-\d{2}-\d{2}T/s);
			assert.match(listing, /other\s+command .*approve it with\s+\/ref approve other/s);
		}));
});

describe("/ref approve under the keys of pi's real TUI", () => {
	it("asks which waiting Ref, shows its exact definition and what the Approval means, and Yes records it", () =>
		withProject(async ({ tui, approved }) => {
			const choice = await tui.terminal.runCommand("/ref approve", "Approve which Ref?");
			await tui.terminal.waitForScreen((screen) => screen.includes("→ setup"));
			assert.match(choice, /enter select/);
			await tui.terminal.chooseRow("setup");
			const confirm = await tui.terminal.waitForScreen((screen) => screen.includes("Approve #setup?") && screen.includes("→ Yes"));
			assert.match(confirm, /From the Project library/);
			assert.match(confirm.replace(/\s*\n\s*/g, ""), /\.pi\/pi-context-refs\.json/, "the library file, whose long path wraps across rows");
			assert.match(confirm, /source: command/);
			assert.ok(confirm.includes(process.execPath), "the program that would run");
			assert.match(confirm, /It will run this at every send, without asking, until the definition changes\./);
			assert.deepEqual(approved(), [], "nothing is recorded while the question is open");
			tui.terminal.press(ENTER);
			await tui.terminal.waitForScreen((screen) => screen.includes('Approved "setup"'));
			assert.deepEqual(approved(), ["setup"]);
		}));

	it("lists only the Refs that are still waiting", () =>
		withProject(async ({ tui }) => {
			await approve(tui, "setup");
			await tui.terminal.runCommand("/ref approve", "Approve which Ref?");
			const choice = await tui.terminal.waitForScreen((screen) => screen.includes("→ other"));
			assert.ok(!/ {3}setup\s*\n/.test(choice.slice(choice.lastIndexOf("Approve which Ref?"))), "setup is approved and is not offered again");
			tui.terminal.press(ESC);
			await tui.terminal.waitForScreen((screen) => screen.includes("Cancelled"));
		}));

	it("No records nothing and says so", () =>
		withProject(async ({ tui, approved }) => {
			await tui.terminal.runCommand("/ref approve setup", "Approve #setup?");
			await tui.terminal.waitForScreen((screen) => screen.includes("→ Yes"));
			await tui.terminal.chooseRow("No");
			await tui.terminal.waitForScreen((screen) => screen.includes('Did not approve "setup"'));
			assert.deepEqual(approved(), []);
		}));

	it("Escape at the choice cancels and records nothing", () =>
		withProject(async ({ tui, approved }) => {
			await tui.terminal.runCommand("/ref approve", "Approve which Ref?");
			tui.terminal.press(ESC);
			await tui.terminal.waitForScreen((screen) => screen.includes("Cancelled"));
			assert.ok(!(await tui.terminal.screen()).includes("Approve #"), "no confirm was asked");
			assert.deepEqual(approved(), []);
		}));

	it("says so when nothing is waiting, and when the Ref is approved already", () =>
		withProject(async ({ tui }) => {
			await approve(tui, "setup");
			await approve(tui, "other");
			await tui.terminal.runCommand("/ref approve", "No Project Dynamic Ref is waiting for an Approval");
			await tui.terminal.runCommand("/ref approve setup", '"setup" is already approved as it is defined now');
		}));
});

describe("/ref revoke under the keys of pi's real TUI", () => {
	it("offers each Approval and an entry for all of them, and revokes the one picked", () =>
		withProject(async ({ tui, approved }) => {
			await approve(tui, "setup");
			await approve(tui, "other");
			await tui.terminal.runCommand("/ref revoke", "Revoke which Approval?");
			const choice = await tui.terminal.waitForScreen((screen) => screen.includes("(all of them)"));
			assert.match(choice.slice(choice.lastIndexOf("Revoke which Approval?")), /→ \w+\s*\n\s+\w+\s*\n\s+\(all of them\)/);
			await tui.terminal.chooseRow("setup");
			await tui.terminal.waitForScreen((screen) => screen.includes('Revoked the Approval of "setup"'));
			assert.deepEqual(approved(), ["other"]);
		}));

	it("(all of them) revokes every Approval of the project", () =>
		withProject(async ({ tui, approved }) => {
			await approve(tui, "setup");
			await approve(tui, "other");
			await tui.terminal.runCommand("/ref revoke", "Revoke which Approval?");
			await tui.terminal.waitForScreen((screen) => screen.includes("(all of them)"));
			await tui.terminal.chooseRow("(all of them)");
			await tui.terminal.waitForScreen((screen) => screen.includes("Revoked 2 Approvals"));
			assert.deepEqual(approved(), []);
		}));

	it("Escape at the choice keeps every Approval", () =>
		withProject(async ({ tui, approved }) => {
			await approve(tui, "setup");
			await tui.terminal.runCommand("/ref revoke", "Revoke which Approval?");
			tui.terminal.press(ESC);
			await tui.terminal.waitForScreen((screen) => screen.includes("Cancelled"));
			assert.deepEqual(approved(), ["setup"]);
		}));

	it("says so when the project has no Approvals", () =>
		withProject(async ({ tui }) => {
			await tui.terminal.runCommand("/ref revoke", "This project has no Approvals");
		}));
});

describe("saving a command Ref under the keys of pi's real TUI", () => {
	/** `/ref add` for a command Ref named probe, up to the choice of where to save it. */
	async function addCommandRef(tui: TuiSession): Promise<void> {
		await tui.terminal.runCommand("/ref add", "Name of the new Ref");
		tui.terminal.answer("probe");
		await tui.terminal.waitForScreen((screen) => screen.includes("Kind") && screen.includes("→ path"));
		await tui.terminal.chooseRow("dynamic");
		await tui.terminal.waitForScreen((screen) => screen.includes("URL, or command with arguments"));
		tui.terminal.answer("node -e 1");
		await tui.terminal.waitForScreen((screen) => screen.includes("Save in") && screen.includes("Project library"));
	}

	it("in the Project library it shows the exact definition in one confirm, and Yes saves the Ref and approves it", () =>
		withProject(async ({ tui, approved, projectRefs }) => {
			await addCommandRef(tui);
			await tui.terminal.chooseRow("Project library");
			const confirm = await tui.terminal.waitForScreen((screen) => screen.includes("Save #probe and approve it?") && screen.includes("→ Yes"));
			assert.match(confirm, /argv: node -e 1/);
			assert.match(confirm, /source: command/);
			assert.match(confirm, /approves exactly this definition/);
			assert.match(confirm, /This approves the command line only, not the files it runs/);
			assert.deepEqual(projectRefs(), ["setup", "other"], "nothing is saved while the question is open");
			tui.terminal.press(ENTER);
			await tui.terminal.waitForScreen((screen) => screen.includes('Added dynamic Ref "probe" to the Project library; approved this definition'));
			assert.deepEqual(projectRefs(), ["setup", "other", "probe"]);
			assert.deepEqual(approved(), ["probe"]);
		}));

	it("No saves nothing and approves nothing", () =>
		withProject(async ({ tui, approved, projectRefs }) => {
			await addCommandRef(tui);
			await tui.terminal.chooseRow("Project library");
			await tui.terminal.waitForScreen((screen) => screen.includes("Save #probe and approve it?") && screen.includes("→ Yes"));
			await tui.terminal.chooseRow("No");
			await tui.terminal.waitForScreen((screen) => !screen.includes("Save #probe and approve it?"));
			assert.ok(!(await tui.terminal.screen()).includes('Added dynamic Ref "probe"'));
			assert.deepEqual(projectRefs(), ["setup", "other"]);
			assert.deepEqual(approved(), []);
		}));

	it("in the Global library it asks nothing about an Approval, because the person wrote it there", () =>
		withProject(async ({ tui, approved }) => {
			await addCommandRef(tui);
			await tui.terminal.chooseRow("Global library");
			await tui.terminal.waitForScreen((screen) => screen.includes('Added dynamic Ref "probe" to the Global library'));
			assert.ok(!(await tui.terminal.screen()).includes("and approve it?"));
			assert.deepEqual(approved(), []);
		}));
});
