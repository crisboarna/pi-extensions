// Opt-in: runs real pi (`npm run test:smoke`). A typed ref and a Placeholder in print mode reach the model expanded.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { runPrint } from "../support/pi-process.ts";
import { probeRun } from "../support/probe-run.ts";
import { replyFor } from "../support/stub-provider.ts";

const EXTENSION = join(import.meta.dirname, "..", "..", "src", "index.ts");

/** A run of the real extension with this library file in its agent directory. */
function run(library: unknown) {
	const probe = probeRun("none");
	const agentDir = join(mkdtempSync(join(tmpdir(), "context-refs-agent-")), "agent");
	mkdirSync(agentDir, { recursive: true });
	if (library !== undefined) writeFileSync(join(agentDir, "pi-context-refs.json"), typeof library === "string" ? library : JSON.stringify(library));
	return { ...probe, options: { ...probe.options, extensions: [EXTENSION], env: { ...probe.options.env, PI_CODING_AGENT_DIR: agentDir } } };
}

const refs = [
	{ name: "terse", kind: "snippet", text: "Answer in one sentence." },
	{ name: "agents", kind: "path", path: "AGENTS.md" },
	{ name: "hosts", kind: "path", path: "/etc/hosts" },
];

describe("typed refs in print mode (DESIGN.md sections 8 and 9)", () => {
	it("sends a Snippet and a Path to the model expanded, and a Placeholder the same way", async () => {
		const probe = run({ version: 1, refs });
		const result = await runPrint("Explain #terse, see #agents and [ref:hosts].", probe.options);
		assert.equal(result.code, 0, result.stderr);
		const text = "Explain Answer in one sentence., see AGENTS.md and /etc/hosts.";
		assert.deepEqual(probe.received(), [{ text, images: 0 }]);
		assert.equal(result.stdout.trim(), replyFor({ text, images: 0 }));
		assert.equal(result.stderr, "");
	});

	it("sends text that matches no Ref as typed", async () => {
		const probe = run({ version: 1, refs });
		const text = "#1 priority, issue #42, #unknown, # heading, [ref:unknown]";
		const result = await runPrint(text, probe.options);
		assert.equal(result.code, 0, result.stderr);
		assert.deepEqual(probe.received(), [{ text, images: 0 }]);
	});

	it("treats a missing library as empty", async () => {
		const probe = run(undefined);
		const result = await runPrint("#terse", probe.options);
		assert.equal(result.code, 0, result.stderr);
		assert.deepEqual(probe.received(), [{ text: "#terse", images: 0 }]);
		assert.equal(result.stderr, "");
	});

	it("skips an invalid Ref with one warning on stderr naming the file and the JSON path, and still expands the rest", async () => {
		const probe = run({ version: 1, refs: [{ name: "bad name", kind: "snippet", text: "x" }, ...refs] });
		const result = await runPrint("#terse", probe.options);
		assert.equal(result.code, 0, result.stderr);
		assert.deepEqual(probe.received(), [{ text: "Answer in one sentence.", images: 0 }]);
		const warnings = result.stderr.split("\n").filter((line) => line.startsWith("pi-context-refs:"));
		assert.equal(warnings.length, 1, result.stderr);
		assert.match(warnings[0] ?? "", /pi-context-refs\.json \$\.refs\[0\]\.name: /);
	});

	it("sends the message as typed when the library does not parse, with a warning on stderr", async () => {
		const probe = run("{ half saved");
		const result = await runPrint("#terse", probe.options);
		assert.equal(result.code, 0, result.stderr);
		assert.deepEqual(probe.received(), [{ text: "#terse", images: 0 }]);
		assert.match(result.stderr, /pi-context-refs: .*pi-context-refs\.json does not parse/);
	});
});
