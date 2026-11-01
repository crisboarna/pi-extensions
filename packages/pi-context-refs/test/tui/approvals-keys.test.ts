// Layer B: the Approval of a Project command Ref at send, under the keys of pi's real TUI. A project library may hold a command that
// runs on the person's machine; the first send that names it opens a selector with the exact command line and three answers. Real
// interactive pi runs in this process on a virtual terminal, with a command that writes a marker file when it runs, so every
// answer is checked against what ran, what the model received, what was recorded and what the editor holds afterwards.
//
// covers: src/pi/approvals.ts
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { QUIET_REPLY, type Received } from "../support/stub-provider.ts";
import { TuiSession } from "../support/tui-session.ts";

const ENTER = "\r";
const ESC = "\x1b";
const DRAFT = "go [ref:setup]";
const ONCE = "Run once";
const ALWAYS = "Always for this definition";

interface Project {
	tui: TuiSession;
	received(): Received[];
	/** Whether the command has run since the last `forget`. */
	ran(): boolean;
	forget(): void;
	approvals(): Array<Record<string, string>>;
	/** Types the draft and sends it, and resolves with the Approval dialog's screen. */
	sendAndAsk(): Promise<string>;
	/** Rewrites the library so the command line differs from the one that was approved. */
	changeCommand(): void;
}

async function withProject(body: (project: Project) => Promise<void>): Promise<void> {
	const log = join(mkdtempSync(join(tmpdir(), "context-refs-received-")), "received.jsonl");
	const tui = await TuiSession.start({ env: { STUB_QUIET: "1", STUB_RECEIVED_LOG: log } });
	try {
		await tui.ready();
		mkdirSync(join(tui.project, ".pi"));
		const marker = join(tui.project, "ran.txt");
		const library = join(tui.project, ".pi", "pi-context-refs.json");
		const writeLibrary = (extra: string[]) =>
			writeFileSync(
				library,
				JSON.stringify({
					version: 1,
					refs: [
						{
							name: "setup",
							kind: "dynamic",
							command: [
								process.execPath,
								"-e",
								"require('node:fs').writeFileSync(process.argv[1], 'ran'); console.log('ran it')",
								marker,
								...extra,
							],
						},
					],
				}),
			);
		writeLibrary([]);
		const approvalsFile = join(tui.agentDir, "pi-context-refs-approvals.json");
		await body({
			tui,
			received: () =>
				existsSync(log)
					? readFileSync(log, "utf8")
							.split("\n")
							.filter(Boolean)
							.map((line) => JSON.parse(line) as Received)
					: [],
			ran: () => existsSync(marker),
			forget: () => existsSync(marker) && unlinkSync(marker),
			approvals: () =>
				existsSync(approvalsFile) ? (JSON.parse(readFileSync(approvalsFile, "utf8")) as { approvals: Array<Record<string, string>> }).approvals : [],
			async sendAndAsk() {
				tui.terminal.type(DRAFT);
				await tui.waitForEditor((text) => text === DRAFT);
				tui.terminal.press(ENTER);
				return tui.terminal.waitForScreen((screen) => screen.includes(ONCE) && screen.includes("Deny"));
			},
			changeCommand: () => writeLibrary(["changed"]),
		});
	} finally {
		await tui.close();
	}
}

describe("the Approval dialog under the keys of pi's real TUI", () => {
	it("shows the exact command line, its directory and what the approval does not cover, with Run once selected first", () =>
		withProject(async (project) => {
			const dialog = await project.sendAndAsk();
			assert.match(dialog, /source: command/);
			assert.ok(dialog.includes(process.execPath), "the program that would run");
			assert.match(dialog, /cwd: /);
			assert.match(dialog, /project: /);
			assert.match(dialog, /This approves the command line only, not the files it runs/);
			assert.match(dialog, /It runs with your environment\./);
			assert.match(dialog, /→ Run once\s*\n\s+Always for this definition\s*\n\s+Deny/);
			assert.equal(project.ran(), false, "nothing has run while the dialog is open");
			assert.deepEqual(project.received(), []);
		}));

	it("Run once runs the command and sends its output, records nothing, and asks again on the next send", () =>
		withProject(async (project) => {
			await project.sendAndAsk();
			await project.tui.terminal.chooseRow(ONCE);
			await project.tui.terminal.waitForScreen((screen) => screen.includes(QUIET_REPLY));
			assert.equal(project.ran(), true);
			assert.match(project.received()[0]?.text ?? "", /<context-ref name="setup" kind="dynamic"[\s\S]*ran it/);
			assert.deepEqual(project.approvals(), [], "once is not remembered");
			assert.match(await project.tui.terminal.screen(), /▸ ref setup \(dynamic, \d+ B\)/, "the transcript shows the block collapsed");
			project.forget();
			await project.sendAndAsk();
		}));

	it("Always runs the command, records the approval, and the next send runs it without asking", () =>
		withProject(async (project) => {
			await project.sendAndAsk();
			await project.tui.terminal.chooseRow(ALWAYS);
			await project.tui.terminal.waitForScreen((screen) => screen.includes(QUIET_REPLY));
			assert.equal(project.ran(), true);
			assert.equal(project.approvals().length, 1);
			assert.equal(project.approvals()[0]?.name, "setup");
			project.forget();
			project.tui.terminal.type(DRAFT);
			await project.tui.waitForEditor((text) => text === DRAFT);
			project.tui.terminal.press(ENTER);
			await project.tui.terminal.waitForScreen((screen) => (screen.match(new RegExp(QUIET_REPLY.replace(/[()]/g, "\\$&"), "g")) ?? []).length === 2);
			assert.equal(project.ran(), true, "the second send ran the approved command");
			assert.ok(!(await project.tui.terminal.screen()).includes("Always for this definition"), "and asked nothing");
		}));

	it("a changed command line is a new definition and asks again", () =>
		withProject(async (project) => {
			await project.sendAndAsk();
			await project.tui.terminal.chooseRow(ALWAYS);
			await project.tui.terminal.waitForScreen((screen) => screen.includes(QUIET_REPLY));
			project.changeCommand();
			project.forget();
			const dialog = await project.sendAndAsk();
			assert.match(dialog, /changed/, "the dialog shows the new command line");
			assert.equal(project.ran(), false, "the changed command has not run");
		}));

	it("Deny runs nothing, sends nothing, puts the draft back and says you denied it", () =>
		withProject(async (project) => {
			await project.sendAndAsk();
			await project.tui.terminal.chooseRow("Deny");
			await project.tui.terminal.waitForScreen((screen) => screen.includes("pi-context-refs: #setup: you denied it"));
			await project.tui.waitForEditor((text) => text === DRAFT);
			assert.equal(project.ran(), false);
			assert.deepEqual(project.received(), []);
			assert.deepEqual(project.approvals(), []);
		}));

	it("Escape counts as not approved, with the same outcome and its own reason", () =>
		withProject(async (project) => {
			await project.sendAndAsk();
			project.tui.terminal.press(ESC);
			await project.tui.terminal.waitForScreen((screen) => screen.includes("pi-context-refs: #setup: you did not approve it"));
			await project.tui.waitForEditor((text) => text === DRAFT);
			assert.equal(project.ran(), false);
			assert.deepEqual(project.received(), []);
		}));
});
