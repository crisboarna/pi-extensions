import assert from "node:assert/strict";
import { test } from "node:test";
import { main } from "../../src/cli/main.ts";

test("--help prints the usage and succeeds; an unknown command fails", async () => {
	const written: string[] = [];
	const write = process.stdout.write.bind(process.stdout);
	const writeErr = process.stderr.write.bind(process.stderr);
	process.stdout.write = ((chunk: string) => written.push(chunk) > 0) as typeof process.stdout.write;
	process.stderr.write = ((chunk: string) => written.push(chunk) > 0) as typeof process.stderr.write;
	try {
		assert.equal(await main(["--help"]), 0);
		assert.match(written.join(""), /pi-switchboard <command>/);
		assert.equal(await main(["nonsense"]), 1);
	} finally {
		process.stdout.write = write;
		process.stderr.write = writeErr;
	}
});
