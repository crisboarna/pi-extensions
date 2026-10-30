// Runs real pi (print mode and a pty) with a probe extension: what ctx.isProjectTrusted() says,
// and how /trust changes it (DESIGN.md sections 5.2 and 16.1).
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { runPrint } from "../support/pi-process.ts";
import { type ProbeRun, probeRun } from "../support/probe-run.ts";
import { PtySession } from "../support/pty-session.ts";

/** A project, and the agent directory pi reads its saved trust decisions from. */
function project(files: Record<string, string>, extraEnv: Record<string, string> = {}) {
	const run = probeRun("trust", extraEnv);
	const cwd = realpathSync(run.dir);
	const agentDir = join(dirname(cwd), "agent");
	mkdirSync(agentDir, { recursive: true });
	for (const [name, content] of Object.entries(files)) {
		mkdirSync(dirname(join(cwd, name)), { recursive: true });
		writeFileSync(join(cwd, name), content);
	}
	run.options.env = { ...run.options.env, PI_CODING_AGENT_DIR: agentDir };
	return {
		run,
		cwd,
		agentDir,
		saveDecisions: (decisions: Record<string, boolean>) => writeFileSync(join(agentDir, "trust.json"), JSON.stringify(decisions)),
	};
}

const trustedAtStart = (run: ProbeRun) => run.observations().find((entry) => entry.ran === "session_start")?.trusted;

const LIBRARY_ONLY = { ".pi/pi-context-refs.json": '{"version":1,"refs":[]}' };
const WITH_SETTINGS = { ...LIBRARY_ONLY, ".pi/settings.json": "{}" };

describe("ctx.isProjectTrusted() (DESIGN.md section 5.2)", () => {
	it("is true for a project whose only .pi file is the Project library: pi asks for no decision about it", async () => {
		const { run } = project(LIBRARY_ONLY);
		const result = await runPrint("hello", run.options);
		assert.equal(result.code, 0, result.stderr);
		assert.equal(trustedAtStart(run), true);
	});

	it("is false for a project with protected resources and no saved decision, when pi cannot ask", async () => {
		const { run } = project(WITH_SETTINGS);
		await runPrint("hello", run.options);
		assert.equal(trustedAtStart(run), false);
	});

	it("is true when the saved decision for the project is true, and false when it is false", async () => {
		const trusted = project(WITH_SETTINGS);
		trusted.saveDecisions({ [trusted.cwd]: true });
		await runPrint("hello", trusted.run.options);
		assert.equal(trustedAtStart(trusted.run), true);

		const refused = project(WITH_SETTINGS);
		refused.saveDecisions({ [refused.cwd]: false });
		await runPrint("hello", refused.run.options);
		assert.equal(trustedAtStart(refused.run), false);
	});

	it("follows a saved decision for a parent folder", async () => {
		const { run, cwd, saveDecisions } = project(WITH_SETTINGS);
		saveDecisions({ [dirname(cwd)]: true });
		await runPrint("hello", run.options);
		assert.equal(trustedAtStart(run), true);
	});

	it("follows --approve and --no-approve over a saved decision", async () => {
		const approved = project(WITH_SETTINGS);
		approved.saveDecisions({ [approved.cwd]: false });
		await runPrint("hello", { ...approved.run.options, args: ["--approve"] });
		assert.equal(trustedAtStart(approved.run), true);

		const declined = project(WITH_SETTINGS);
		declined.saveDecisions({ [declined.cwd]: true });
		await runPrint("hello", { ...declined.run.options, args: ["--no-approve"] });
		assert.equal(trustedAtStart(declined.run), false);
	});

	it("does not change when /trust saves a decision: the decision applies to the next start", async () => {
		const { run, cwd, agentDir } = project(WITH_SETTINGS);
		const tui = new PtySession({ ...run.options, args: ["--no-approve"] });
		try {
			await tui.ready();
			tui.type("/trust\r");
			await tui.waitForScreen((screen) => /Trust\b/.test(screen) && screen.includes("Do not trust"));
			tui.type("\r");
			const screen = await tui.waitForScreen((text) => text.includes("Saved trust decision: trusted"));
			assert.match(screen, /Restart pi for this to take effect/);
			assert.deepEqual(JSON.parse(readFileSync(join(agentDir, "trust.json"), "utf8")), { [cwd]: true });
			tui.type("hello\r");
			await tui.waitForScreen(() => run.observations().some((entry) => entry.ran === "input"));
			assert.equal(run.observations().find((entry) => entry.ran === "input")?.trusted, false, "the running session still reports untrusted");
		} finally {
			await tui.close();
		}
		const next = probeRun("trust");
		const again = await runPrint("hello", { ...next.options, cwd, env: { ...next.options.env, PI_CODING_AGENT_DIR: agentDir } });
		assert.equal(again.code, 0, again.stderr);
		assert.equal(trustedAtStart(next), true, "the next start reports trusted");
	});
});
