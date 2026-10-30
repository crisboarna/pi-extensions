// Opt-in: runs real pi (`npm run test:smoke`). A Dynamic Ref with a URL reaches the model as a Context block (print), and a failed fetch becomes
// a Failure note and a warning on stderr (print). The pages come from a server on 127.0.0.1; no external network is used.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { runPrint } from "../support/pi-process.ts";
import { probeRun } from "../support/probe-run.ts";

const EXTENSION = join(import.meta.dirname, "..", "..", "src", "index.ts");

const server = createServer((request, response) => {
	if (request.url === "/notes.md") {
		response.writeHead(200, { "content-type": "text/markdown" });
		response.end("# Notes\n");
	} else if (request.url === "/old") {
		response.writeHead(301, { location: "/notes.md" });
		response.end();
	} else {
		response.writeHead(500);
		response.end("broken");
	}
});
let base = "";

before(async () => {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
	server.closeAllConnections();
	server.close();
});

/** A run of the real extension with `refs` in its agent directory. */
function run(refs: unknown[]) {
	const probe = probeRun("none");
	const agentDir = join(mkdtempSync(join(tmpdir(), "context-refs-agent-")), "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "pi-context-refs.json"), JSON.stringify({ version: 1, refs }));
	return { ...probe, options: { ...probe.options, extensions: [EXTENSION], env: { ...probe.options.env, PI_CODING_AGENT_DIR: agentDir } } };
}

describe("a URL Dynamic Ref in print mode (DESIGN.md section 10.1)", () => {
	it("follows a redirect and sends the page's text as a Context block whose source is the URL", async () => {
		const probe = run([{ name: "notes", kind: "dynamic", url: `${base}/old` }]);
		const result = await runPrint("Summarize #notes", probe.options);
		assert.equal(result.code, 0, result.stderr);
		const body = `GET ${base}/old\n# Notes\n`;
		assert.deepEqual(probe.received(), [
			{
				text: `Summarize #notes\n\n<context-ref name="notes" kind="dynamic" source="${base}/old" bytes="${body.length}">\n${body}\n</context-ref>`,
				images: 0,
			},
		]);
		assert.equal(result.stderr, "");
	});

	it("sends a Failure note and warns when the page cannot be fetched", async () => {
		const probe = run([{ name: "broken", kind: "dynamic", url: `${base}/broken` }]);
		const result = await runPrint("Read #broken", probe.options);
		assert.equal(result.code, 0, result.stderr);
		const reason = `${base}/broken answered HTTP 500`;
		assert.deepEqual(probe.received(), [
			{
				text: `Read #broken\n\n<context-ref name="broken" kind="dynamic" source="${base}/broken" bytes="0" error="${reason}">\n\n</context-ref>`,
				images: 0,
			},
		]);
		assert.equal(result.stderr, `pi-context-refs: #broken: ${reason}\n`);
	});
});
