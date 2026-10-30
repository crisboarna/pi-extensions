// Opt-in: runs real pi (`npm run test:smoke`). Dynamic command Refs and the git Built-in Refs reach the model as Context blocks (print),
// a failure becomes a Failure note and a warning on stderr (print), and in the TUI the status shows while a command runs and Esc cancels the send (pty).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { runPrint } from "../support/pi-process.ts";
import { probeRun } from "../support/probe-run.ts";
import { PtySession } from "../support/pty-session.ts";

const EXTENSION = join(import.meta.dirname, "..", "..", "src", "index.ts");
const GIT_ENV = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
const ESC = String.fromCharCode(27);

/** A run of the real extension with `refs` in its agent directory. */
function run(refs: unknown[], env: Record<string, string> = {}) {
	const probe = probeRun("none", env);
	const agentDir = join(mkdtempSync(join(tmpdir(), "context-refs-agent-")), "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "pi-context-refs.json"), JSON.stringify({ version: 1, refs }));
	return { ...probe, options: { ...probe.options, extensions: [EXTENSION], env: { ...probe.options.env, ...GIT_ENV, PI_CODING_AGENT_DIR: agentDir } } };
}

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=T", ...args], { cwd, env: { ...process.env, ...GIT_ENV }, stdio: "pipe" });

describe("a Built-in Ref in print mode (DESIGN.md section 10.2)", () => {
	it("sends git's output as a Context block", async () => {
		const probe = run([]);
		git(probe.dir, "init", "-q");
		writeFileSync(join(probe.dir, "a.txt"), "one\n");
		git(probe.dir, "add", "a.txt");
		git(probe.dir, "commit", "-q", "-m", "first commit");
		writeFileSync(join(probe.dir, "a.txt"), "one\ntwo\n");
		const result = await runPrint("What changed? #status", probe.options);
		assert.equal(result.code, 0, result.stderr);
		const received = probe.received();
		assert.equal(received.length, 1);
		assert.equal(
			received[0]?.text,
			'What changed? #status\n\n<context-ref name="status" kind="dynamic" source="git status --short" bytes="30">\n$ git status --short\n M a.txt\n\n</context-ref>',
		);
		assert.equal(result.stderr, "");
	});

	it("sends a Failure note and warns outside a git repository, never git's own error", async () => {
		const probe = run([]);
		const result = await runPrint("What changed? #diff", probe.options);
		assert.equal(result.code, 0, result.stderr);
		assert.deepEqual(probe.received(), [
			{
				text: 'What changed? #diff\n\n<context-ref name="diff" kind="dynamic" source="git diff" bytes="0" error="not a git repository">\n\n</context-ref>',
				images: 0,
			},
		]);
		assert.equal(result.stderr, "pi-context-refs: #diff: not a git repository\n");
	});
});

describe("a command Dynamic Ref in print mode (DESIGN.md section 10.1)", () => {
	it("runs the argv without a shell and sends the output", async () => {
		const hostile = "$(echo pwned) | cat";
		const probe = run([{ name: "echo", kind: "dynamic", command: [process.execPath, "-e", "console.log(process.argv[1])", hostile] }]);
		const result = await runPrint("Say it: #echo", probe.options);
		assert.equal(result.code, 0, result.stderr);
		const text = probe.received()[0]?.text ?? "";
		assert.ok(text.includes(`\n${hostile}\n\n</context-ref>`), text);
	});
});

describe("a command Dynamic Ref in the TUI (DESIGN.md sections 8 and 12)", () => {
	const slow = { name: "slow", kind: "dynamic", command: [process.execPath, "-e", "setTimeout(() => {}, 60000)"], timeout: 120 };

	it("shows a running status, and Esc cancels the send and puts the draft back", async () => {
		const probe = run([slow], { STUB_QUIET: "1" });
		const tui = new PtySession(probe.options);
		try {
			await tui.ready();
			tui.type("Wait for #slow\r");
			await tui.waitForScreen((text) => text.includes("running #slow"));
			tui.type(ESC);
			const screen = await tui.waitForScreen((text) => text.includes("cancelled"));
			assert.ok(screen.includes("Wait for #slow"), `the draft is back:\n${screen}`);
			assert.deepEqual(probe.received(), [], "no request reached the model");
			assert.equal(screen.includes("running #slow"), false, "the status is gone");
		} finally {
			await tui.close();
		}
	});
});
