// The README's "Data and privacy" section says what this package does outside its own process: the network it reaches and the programs it
// starts. This test keeps that true. It finds every source file that can reach the network or start a program and compares the list with the
// one below, which says why each file does. A new file that does either fails here until the list, and the README, say so; a listed file
// that no longer does it fails too, so the list cannot go stale.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../../src", import.meta.url));

/** What reaches the network: a call to fetch, a socket, HTTP or resolver module, or a socket class. */
const NETWORK = [
	// a call to the global fetch (not a method of something else, and not the declaration of a method named fetch) ...
	/(?<![.\w])(?<!\b(?:async|function|private|public|protected|static|get|set)\s+)fetch\(/,
	// ... or the global fetch handed on as a value, as in `{ fetch: fetcher = fetch }` or `run(fetch)`
	/[=(,]\s*fetch\s*[,);]/,
	/["']node:(?:https?|http2|net|tls|dgram|dns(?:\/promises)?)["']/,
	/\bWebSocket\b/,
	/\bXMLHttpRequest\b/,
];
/** What starts a program: the child_process module, or pi's own `pi.exec`. */
const PROCESS = [/["']node:child_process["']/, /\bpi\.exec\(/];

/** Source files that reach the network, and why. */
const NETWORK_FILES: Record<string, string> = {
	"classifier/detect.ts": "reads the model lists of the default local classifier servers and sends one test request to a decision model",
	"cli/classifier.ts": "asks a router to load a model while `classifier setup` waits for the server",
};
/** Source files that start a program, and why. */
const PROCESS_FILES: Record<string, string> = {
	"cli/classifier.ts": "`classifier setup` runs the install and server commands it showed, after asking",
	"commands/inspect.ts": "`/tier inspect --open` opens the HTML it wrote with the platform's file opener",
};

function sourceFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) return sourceFiles(path);
		return name.endsWith(".ts") ? [path] : [];
	});
}

/** The code of a file without its comment lines, so a word in a comment is not a use. */
function code(path: string): string {
	return readFileSync(path, "utf8")
		.split("\n")
		.filter((line) => !/^\s*(?:\/\/|\/?\*)/.test(line))
		.join("\n");
}

function filesUsing(patterns: RegExp[]): string[] {
	return sourceFiles(SRC)
		.filter((file) => patterns.some((pattern) => pattern.test(code(file))))
		.map((file) => relative(SRC, file).split(sep).join("/"))
		.sort();
}

describe("side effects (README: Data and privacy)", () => {
	it("only the listed files reach the network", () => {
		assert.deepEqual(filesUsing(NETWORK), Object.keys(NETWORK_FILES).sort());
	});

	it("only the listed files start a program", () => {
		assert.deepEqual(filesUsing(PROCESS), Object.keys(PROCESS_FILES).sort());
	});

	it("the patterns match what they are for, and not a method or a regular expression that happens to share a name", () => {
		const hits = (patterns: RegExp[], text: string) => patterns.some((pattern) => pattern.test(text));
		for (const text of [
			"await fetch(url, { signal })",
			"const { fetch: fetcher = fetch, timeoutMs } = options;",
			'import { lookup } from "node:dns/promises";',
			"new WebSocket(address)",
			'import http from "node:https";',
		]) {
			assert.ok(hits(NETWORK, text), text);
		}
		for (const text of [
			"this.fetch(provider)",
			"private async fetch(provider: string): Promise<void> {",
			"const { fetch: fetcher } = options;",
			"/^\\S+\\s+(.+) \\(fetch\\)$/.exec(line)",
			"const refetch = 1",
		]) {
			assert.ok(!hits(NETWORK, text), text);
		}
		for (const text of ['import { spawn } from "node:child_process";', "await pi.exec(command, args)"]) assert.ok(hits(PROCESS, text), text);
		assert.ok(!hits(PROCESS, "const expect = pi.expected(1)"));
	});

	it("says why each listed file does it", () => {
		for (const reason of [...Object.values(NETWORK_FILES), ...Object.values(PROCESS_FILES)]) assert.ok(reason.length > 10, reason);
	});
});
