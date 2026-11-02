// A library can come from a repository the person did not write, and what it holds is shown in the picker, in /ref output and in dialogs. Text a
// terminal treats as a command (a title or clipboard OSC, a cursor move, a carriage return that overwrites a line, a bell) must reach none of those
// surfaces as the raw bytes. The cases build one hostile library and read what each surface really drew or wrote.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createJiti } from "jiti";
import { EditorHarness } from "../support/editor-harness.ts";
import { createFakeHost, createFakeSession } from "../support/fake-pi.ts";

const INDEX = join(import.meta.dirname, "..", "..", "src", "index.ts");

// Each of these is a real way to talk to a terminal: set its title, write to the clipboard, move the cursor, overwrite the line, ring the bell,
// erase, and a C1 control. None may reach the screen or stderr raw.
const OSC_TITLE = "\u001b]0;pwned\u0007";
const OSC_CLIPBOARD = "\u001b]52;c;aGFja2Vk\u001b\\";
const CURSOR_AND_ERASE = "\u001b[2J\u001b[H\u001b[31m";
const OVERWRITE = "\rOK, nothing to see\b\b\b";
const C1 = "\u0085\u009b31m";
const NUL = "\u0000";
const HOSTILE_TEXT = `${OSC_TITLE}safe${OSC_CLIPBOARD}${CURSOR_AND_ERASE}${OVERWRITE}${C1}${NUL}end`;

/** True when a string still holds bytes a terminal would act on: escape, bell, backspace, carriage return, NUL or a C1 control. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: the control characters are what this test looks for
const hasControl = (text: string): boolean => /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u.test(text);

let root = "";
let agentDir = "";
let project = "";
const realStderrWrite = process.stderr.write.bind(process.stderr);

beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "context-refs-hostile-")));
	agentDir = join(root, "agent");
	project = join(root, "project");
	mkdirSync(agentDir);
	mkdirSync(join(project, ".pi"), { recursive: true });
	process.env.PI_CODING_AGENT_DIR = agentDir;
});

afterEach(() => {
	process.stderr.write = realStderrWrite;
	rmSync(root, { recursive: true, force: true });
});

const write = (file: string, refs: unknown[]) => writeFileSync(file, JSON.stringify({ version: 1, refs }));

async function boot() {
	const jiti = createJiti(import.meta.url, { moduleCache: false });
	const factory = (
		process.env.CONTEXT_REFS_NATIVE_IMPORT === "1" ? ((await import(INDEX)) as { default: unknown }).default : await jiti.import(INDEX, { default: true })
	) as (pi: unknown) => unknown;
	const host = createFakeHost();
	await factory(host.pi);
	return host;
}

/** Runs `/ref <args>` in a session; returns everything shown or written, the notices and stderr together. */
async function ref(host: Awaited<ReturnType<typeof boot>>, session: ReturnType<typeof createFakeSession>, args: string): Promise<string> {
	const chunks: string[] = [];
	process.stderr.write = ((chunk: string | Uint8Array) => {
		chunks.push(String(chunk));
		return true;
	}) as typeof process.stderr.write;
	try {
		await host.commands.get("ref")?.handler(args, session.ctx);
	} finally {
		process.stderr.write = realStderrWrite;
	}
	return chunks.join("") + session.notices.map((notice) => notice.message).join("\n");
}

describe("a hostile library reaches no surface as raw terminal bytes", () => {
	/** The raw lines the open # list draws for a library, as pi-tui draws them. */
	async function drawnFor(refs: unknown[]): Promise<string[]> {
		write(join(agentDir, "pi-context-refs.json"), refs);
		const host = await boot();
		const session = createFakeSession({ cwd: project, mode: "tui" });
		await host.fire("session_start", { type: "session_start", reason: "startup" }, session.ctx);
		const picker = new EditorHarness(session.autocompleteProviders, project);
		await picker.type("#");
		assert.ok(picker.listOpen);
		return picker.editor.render(80);
	}

	/** Every escape sequence in the lines: colour, cursor and erase, operating system commands, and pi-tui's own APC markers. */
	// biome-ignore lint/suspicious/noControlCharactersInRegex: this matches terminal escape sequences, which start with a control character
	const ESCAPE = /\u001b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|_[^\u0007]*\u0007)/gu;
	const escapesOf = (lines: string[]): string[] => lines.flatMap((line) => line.match(ESCAPE) ?? []);

	it("the # picker draws a description and a target made safe, with exactly the escape sequences a benign library gets", async () => {
		const refs = (text: string) => [
			{ name: "notes", kind: "snippet", text: `target ${text}`, description: `desc ${text}` },
			{ name: "bare", kind: "snippet", text },
			{ name: "plain", kind: "snippet", text: "x" },
		];
		const hostile = await drawnFor(refs(HOSTILE_TEXT));
		// as long as the hostile text, so pi-tui cuts both at the same place (it adds a colour reset where it cuts a line)
		const benign = await drawnFor(refs("s".repeat(HOSTILE_TEXT.length)));
		assert.match(hostile.join(" "), /notes/, "the hostile ref is still listed");
		assert.match(hostile.join(" "), /safe/, "its text is shown, made safe");
		assert.deepEqual(escapesOf(hostile), escapesOf(benign), "no escape sequence beyond the ones pi-tui draws itself");
		const rest = hostile.map((line) => line.replace(ESCAPE, "")).join(" ");
		assert.ok(!hasControl(rest), `a control byte is left: ${JSON.stringify(rest)}`);
	});

	it("a tag that is not a tag makes the ref refused, with a warning that holds no raw bytes", async () => {
		write(join(agentDir, "pi-context-refs.json"), [
			{ name: "tagged", kind: "snippet", text: "x", tags: [`tag${OSC_TITLE}${OVERWRITE}`] },
			{ name: "plain", kind: "snippet", text: "y" },
		]);
		const host = await boot();
		const session = createFakeSession({ cwd: project, mode: "tui" });
		await host.fire("session_start", { type: "session_start", reason: "startup" }, session.ctx);
		const shown = await ref(host, session, "list");
		assert.match(shown, /plain/);
		assert.doesNotMatch(shown, /\btagged\b.*snippet/u, "the ref with the bad tag is not listed as usable");
		assert.ok(!hasControl(shown.replaceAll("\n", " ")), JSON.stringify(shown));
		assert.ok(
			session.notices.some((notice) => /a tag uses only letters/u.test(notice.message)),
			JSON.stringify(session.notices),
		);
		for (const notice of session.notices) assert.ok(!hasControl(notice.message.replaceAll("\n", " ")), JSON.stringify(notice.message));
	});

	it("/ref list shows the refs of both libraries without raw bytes, trusted or not", async () => {
		write(join(agentDir, "pi-context-refs.json"), [{ name: "mine", kind: "snippet", text: HOSTILE_TEXT, description: HOSTILE_TEXT }]);
		write(join(project, ".pi", "pi-context-refs.json"), [
			{ name: "shared", kind: "snippet", text: HOSTILE_TEXT, description: HOSTILE_TEXT, tags: [HOSTILE_TEXT] },
		]);
		const host = await boot();
		for (const trusted of [true, false]) {
			const session = createFakeSession({ cwd: project, mode: "tui", trusted });
			const shown = await ref(host, session, "list");
			assert.match(shown, /mine/);
			assert.ok(!hasControl(shown.replaceAll("\n", " ")), `trusted=${trusted}: ${JSON.stringify(shown)}`);
		}
	});

	it("a ref name that is not a name is refused with a warning that holds no raw bytes", async () => {
		write(join(project, ".pi", "pi-context-refs.json"), [
			{ name: `bad${OSC_TITLE}${OVERWRITE}name`, kind: "snippet", text: "x" },
			{ name: "fine", kind: "snippet", text: "y" },
		]);
		const host = await boot();
		const session = createFakeSession({ cwd: project, mode: "tui" });
		await host.fire("session_start", { type: "session_start", reason: "startup" }, session.ctx);
		const shown = await ref(host, session, "list");
		assert.match(shown, /fine/);
		assert.ok(!hasControl(shown.replaceAll("\n", " ")), JSON.stringify(shown));
		for (const notice of session.notices) assert.ok(!hasControl(notice.message.replaceAll("\n", " ")), JSON.stringify(notice.message));
	});

	it("/ref approvals writes the definition of a project command, with its arguments, as visible text", async () => {
		write(join(project, ".pi", "pi-context-refs.json"), [{ name: "setup", kind: "dynamic", command: ["echo", HOSTILE_TEXT, `arg${OSC_CLIPBOARD}`] }]);
		const host = await boot();
		const session = createFakeSession({ cwd: project, mode: "tui" });
		const shown = await ref(host, session, "approvals");
		assert.match(shown, /setup/);
		assert.ok(!hasControl(shown.replaceAll("\n", " ")), JSON.stringify(shown));
	});

	it("the confirm of /ref approve shows the same definition without raw bytes", async () => {
		write(join(project, ".pi", "pi-context-refs.json"), [{ name: "setup", kind: "dynamic", command: ["echo", HOSTILE_TEXT] }]);
		const host = await boot();
		const session = createFakeSession({ cwd: project, mode: "tui" });
		const asked: string[] = [];
		Object.assign(session.ctx.ui, {
			confirm: async (title: string, message: string) => {
				asked.push(`${title}\n${message}`);
				return false;
			},
		});
		await ref(host, session, "approve setup");
		assert.equal(asked.length, 1);
		assert.ok(!hasControl((asked[0] ?? "").replaceAll("\n", " ")), JSON.stringify(asked[0]));
	});
});
