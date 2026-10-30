import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BUILTIN_REFS, builtinRefs, isBuiltin } from "../../src/core/builtins.ts";
import { type CommandEnv, type CommandRequest, type CommandResult, commandText, dynamicBlock } from "../../src/core/dynamic.ts";
import type { DynamicRef } from "../../src/core/library.ts";

const ok = (stdout: string, extra: Partial<CommandResult> = {}): CommandResult => ({ stdout, stderr: "", code: 0, killed: false, ...extra });

/** An env whose runner answers with `result` (or rejects with it, when it is an Error) and remembers what it was asked. */
function env(result: CommandResult | Error, inGitWorkTree = true): CommandEnv & { requests: CommandRequest[] } {
	const requests: CommandRequest[] = [];
	return {
		requests,
		runCommand: async (request) => {
			requests.push(request);
			if (result instanceof Error) throw result;
			return result;
		},
		isGitWorkTree: async () => inGitWorkTree,
	};
}
const ref = (extra: Partial<DynamicRef> = {}): DynamicRef & { command: string[] } => ({ name: "tests", kind: "dynamic", command: ["npm", "test"], ...extra });
const run = (r: DynamicRef & { command: string[] }, e: CommandEnv, cwd = "/work/repo") => dynamicBlock(r, cwd, e);

describe("commandText", () => {
	it("joins the arguments with spaces and quotes the ones a reader could not tell apart", () => {
		assert.equal(commandText(["git", "log", "--oneline", "-20"]), "git log --oneline -20");
		assert.equal(commandText(["sh", "-c", "a | b"]), 'sh -c "a | b"');
		assert.equal(commandText(["echo", ""]), 'echo ""');
		assert.equal(commandText(["echo", 'say "hi"']), 'echo "say \\"hi\\""');
	});
});

describe("a command Dynamic Ref", () => {
	it("asks the runner for the argv in the given directory with the default 10 s timeout", async () => {
		const e = env(ok("fine\n"));
		await run(ref(), e, "/work/repo/sub");
		assert.deepEqual(e.requests, [{ name: "tests", argv: ["npm", "test"], cwd: "/work/repo/sub", timeoutMs: 10_000 }]);
	});

	it("passes a raised timeout in milliseconds", async () => {
		const e = env(ok(""));
		await run(ref({ timeout: 120 }), e);
		assert.equal(e.requests[0]?.timeoutMs, 120_000);
	});

	it("passes the cancel signal on", async () => {
		const e = env(ok(""));
		const controller = new AbortController();
		await dynamicBlock(ref(), "/work/repo", e, controller.signal);
		assert.equal(e.requests[0]?.signal, controller.signal);
	});

	it("sends the output in a block that names the source on a line of its own", async () => {
		const block = await run(ref(), env(ok("all 3 passed\n")));
		assert.equal(block.text, '<context-ref name="tests" kind="dynamic" source="npm test" bytes="24">\n$ npm test\nall 3 passed\n\n</context-ref>');
		assert.equal("reason" in block, false);
	});

	it("sends an empty output as the source line alone", async () => {
		const block = await run(ref(), env(ok("")));
		assert.equal(block.text, '<context-ref name="tests" kind="dynamic" source="npm test" bytes="10">\n$ npm test\n</context-ref>');
	});

	it("appends what the command wrote to stderr after what it wrote to stdout", async () => {
		const block = await run(ref(), env(ok("out", { stderr: "warn\n" })));
		assert.ok(block.text.includes("\n$ npm test\nout\nwarn\n\n</context-ref>"), block.text);
	});

	it("strips control characters from the output and keeps tab, newline and carriage return", async () => {
		const block = await run(ref(), env(ok("a\x1b[31mred\x07\tb\r\n")));
		assert.ok(block.text.includes("\n$ npm test\na[31mred\tb\r\n\n</context-ref>"), block.text);
	});

	describe("a non-zero exit", () => {
		it("still sends the output, with the exit code in an attribute and on the source line", async () => {
			const block = await run(ref(), env(ok("1 failed\n", { code: 1 })));
			assert.ok(block.text.startsWith('<context-ref name="tests" kind="dynamic" source="npm test" bytes="'), block.text);
			assert.ok(block.text.includes(' exit="1">\n$ npm test (exit 1)\n1 failed\n\n</context-ref>'), block.text);
			assert.equal("reason" in block, false);
		});
	});

	describe("the output cap", () => {
		it("keeps the first 50 KB by default and says so in an attribute and on the source line", async () => {
			const block = await run(ref(), env(ok("x".repeat(60_000))));
			assert.ok(block.text.includes(' bytes="51232" truncated="50 KB">\n$ npm test (truncated at 50 KB)\n'), block.text.slice(0, 200));
			assert.equal(block.text.split("\n")[2]?.length, 51_200);
			assert.equal("reason" in block, false);
		});

		it("does not mark output that fits exactly", async () => {
			const block = await run(ref(), env(ok("x".repeat(51_200))));
			assert.equal(block.text.includes("truncated"), false);
		});

		it("honours max_output, in KB and in MB", async () => {
			const kb = await run(ref({ max_output: 2048 }), env(ok("x".repeat(3000))));
			assert.ok(kb.text.includes('truncated="2 KB"'), kb.text.slice(0, 160));
			const mb = await run(ref({ max_output: 1_048_576 }), env(ok("x".repeat(1_048_577))));
			assert.ok(mb.text.includes('truncated="1 MB"'), mb.text.slice(0, 160));
			const odd = await run(ref({ max_output: 1000 }), env(ok("x".repeat(1001))));
			assert.ok(odd.text.includes('truncated="1000 bytes"'), odd.text.slice(0, 160));
		});

		it("never cuts a character in half", async () => {
			const block = await run(ref({ max_output: 1000 }), env(ok("é".repeat(600))));
			assert.equal(block.text.includes("\uFFFD"), false);
			assert.ok(block.text.includes(`\n${"é".repeat(500)}\n</context-ref>`), block.text.slice(0, 160));
		});

		it("marks a non-zero exit and a cut together", async () => {
			const block = await run(ref({ max_output: 1000 }), env(ok("x".repeat(2000), { code: 3 })));
			assert.ok(block.text.includes(' exit="3" truncated="1000 bytes">\n$ npm test (exit 3, truncated at 1000 bytes)\n'), block.text.slice(0, 200));
		});
	});

	describe("failures", () => {
		it("reports a command that cannot start, with the runner's reason", async () => {
			const block = await run(ref(), env(new Error("npm was not found on PATH")));
			assert.deepEqual(block, {
				name: "tests",
				reason: "npm test cannot start: npm was not found on PATH",
				text: '<context-ref name="tests" kind="dynamic" source="npm test" bytes="0" error="npm test cannot start: npm was not found on PATH">\n\n</context-ref>',
			});
		});

		it("reports a timeout with the limit, and sends none of the output", async () => {
			const block = await run(ref({ timeout: 30 }), env(ok("partial", { killed: true })));
			assert.equal("reason" in block && block.reason, "npm test timed out after 30 s");
			assert.equal(block.text.includes("partial"), false);
		});

		it("reports a cancelled send, not a timeout, when the signal was aborted", async () => {
			const controller = new AbortController();
			controller.abort();
			const block = await dynamicBlock(ref(), "/work/repo", env(ok("", { killed: true })), controller.signal);
			assert.equal("reason" in block && block.reason, "npm test was cancelled");
		});

		it("reports binary output instead of sending it", async () => {
			const block = await run(ref(), env(ok("PK\x03\x04\x00\x00binary")));
			assert.equal("reason" in block && block.reason, "npm test wrote binary output");
			assert.equal(block.text.includes("PK"), false);
		});

		it("looks for a NUL byte in the first 8 KB only", async () => {
			const block = await run(ref(), env(ok(`${"x".repeat(8192)}\x00tail`)));
			assert.equal("reason" in block, false);
		});
	});
});

describe("Built-in Refs", () => {
	it("are #diff, #staged, #status and #log with the commands the design gives", () => {
		assert.deepEqual(
			BUILTIN_REFS.map((builtin) => [builtin.name, builtin.command]),
			[
				["diff", ["git", "diff"]],
				["staged", ["git", "diff", "--staged"]],
				["status", ["git", "status", "--short"]],
				["log", ["git", "log", "--oneline", "-20"]],
			],
		);
	});

	it("are all kept by default, all dropped by false, and the named ones dropped by a list", () => {
		assert.deepEqual(
			builtinRefs(true).map((builtin) => builtin.name),
			["diff", "staged", "status", "log"],
		);
		assert.deepEqual(builtinRefs(false), []);
		assert.deepEqual(
			builtinRefs(["Log", "diff"]).map((builtin) => builtin.name),
			["staged", "status"],
		);
	});

	it("are told apart from a saved Ref of the same name", () => {
		const [diff] = BUILTIN_REFS;
		assert.ok(diff && isBuiltin(diff));
		assert.equal(isBuiltin({ name: "diff", kind: "dynamic", command: ["git", "diff"] }), false);
	});

	it("fail with 'not a git repository' outside a work tree, without running git", async () => {
		const [diff] = BUILTIN_REFS;
		assert.ok(diff);
		const e = env(ok("fatal: not a git repository"), false);
		const block = await run(diff, e);
		assert.equal("reason" in block && block.reason, "not a git repository");
		assert.equal(block.text, '<context-ref name="diff" kind="dynamic" source="git diff" bytes="0" error="not a git repository">\n\n</context-ref>');
		assert.deepEqual(e.requests, []);
	});

	it("run inside a work tree", async () => {
		const [diff] = BUILTIN_REFS;
		assert.ok(diff);
		const block = await run(diff, env(ok("+new line\n")));
		assert.ok(block.text.includes("\n$ git diff\n+new line\n"), block.text);
	});

	it("do not get the git check when a saved Ref with the same command is run", async () => {
		const e = env(ok("x"), false);
		const block = await run(ref({ name: "diff", command: ["git", "diff"] }), e);
		assert.equal("reason" in block, false);
	});
});
