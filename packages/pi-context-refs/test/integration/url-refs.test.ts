import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createJiti } from "jiti";
import { createFakeHost, createFakeSession } from "../support/fake-pi.ts";

const INDEX = join(import.meta.dirname, "..", "..", "src", "index.ts");
const ESC = String.fromCharCode(27);

let root = "";
let agentDir = "";
let project = "";
let stderr: string[] = [];
let server: Server;
let base = "";
let requests: IncomingMessage[] = [];
let routes: Record<string, (request: IncomingMessage, response: ServerResponse) => void> = {};
const realStderrWrite = process.stderr.write.bind(process.stderr);
const savedEnv = { ...process.env };

beforeEach(async () => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "context-refs-url-")));
	agentDir = join(root, "agent");
	project = join(root, "project");
	mkdirSync(agentDir);
	mkdirSync(project);
	process.env.PI_CODING_AGENT_DIR = agentDir;
	stderr = [];
	process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
		if (typeof chunk === "string" && chunk.startsWith("pi-context-refs:")) {
			stderr.push(chunk);
			return true;
		}
		return (realStderrWrite as (...args: unknown[]) => boolean)(chunk, ...rest);
	}) as typeof process.stderr.write;

	requests = [];
	routes = {};
	server = createServer((request, response) => {
		requests.push(request);
		const route = routes[request.url ?? ""];
		if (route) route(request, response);
		else {
			response.statusCode = 404;
			response.end("not found");
		}
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
	process.stderr.write = realStderrWrite;
	for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
	Object.assign(process.env, savedEnv);
	server.closeAllConnections();
	await new Promise((resolve) => server.close(resolve));
	rmSync(root, { recursive: true, force: true });
});

const writeLibrary = (refs: unknown[]) => writeFileSync(join(agentDir, "pi-context-refs.json"), JSON.stringify({ version: 1, $schema: "x", refs }));
const page = (name: string, path: string, extra: Record<string, unknown> = {}) => ({ name, kind: "dynamic", url: `${base}${path}`, ...extra });
const serve = (path: string, contentType: string | undefined, body: string | Uint8Array, status = 200) => {
	routes[path] = (_request, response) => {
		response.writeHead(status, contentType === undefined ? {} : { "content-type": contentType });
		response.end(body);
	};
};

async function boot() {
	const jiti = createJiti(import.meta.url, { moduleCache: false });
	// The coverage run imports natively: V8 coverage cannot map code that jiti transforms back to the source files.
	const factory = (
		process.env.CONTEXT_REFS_NATIVE_IMPORT === "1" ? ((await import(INDEX)) as { default: unknown }).default : await jiti.import(INDEX, { default: true })
	) as (pi: unknown) => unknown;
	const host = createFakeHost();
	await factory(host.pi);
	return host;
}

type Mode = "tui" | "print" | "json" | "rpc";

async function session(mode: Mode) {
	const host = await boot();
	const s = createFakeSession({ cwd: project, mode });
	await host.fire("session_start", { type: "session_start", reason: "startup" }, s.ctx);
	const send = (text: string) => host.fire("input", { type: "input", text, source: mode === "rpc" ? "rpc" : "interactive" }, s.ctx);
	return { s, send };
}

/** The Context blocks of a sent message, with the attributes and the body of each. */
function blocksOf(sent: { text: string } | undefined): Array<{ attributes: string; body: string }> {
	return [...(sent?.text ?? "").matchAll(/<context-ref ([^>]*)>\n([\s\S]*?)\n<\/context-ref>/g)].map((match) => ({
		attributes: match[1] ?? "",
		body: match[2] ?? "",
	}));
}

describe("a Dynamic Ref with a URL", () => {
	it("sends the page's current text as a Context block whose source is the URL", async () => {
		serve("/notes.txt", "text/plain; charset=utf-8", "first line\nsecond line\n");
		writeLibrary([page("notes", "/notes.txt")]);
		const { send } = await session("print");
		const sent = await send("read #notes now");
		assert.equal(sent?.action, "transform");
		assert.equal(
			sent?.text,
			`read #notes now\n\n<context-ref name="notes" kind="dynamic" source="${base}/notes.txt" bytes="${`GET ${base}/notes.txt\nfirst line\nsecond line\n`.length}">\nGET ${base}/notes.txt\nfirst line\nsecond line\n\n</context-ref>`,
		);
		assert.equal(stderr.length, 0);
	});

	it("fetches again at every send, and once per message however often it is mentioned", async () => {
		serve("/n", "text/plain", "x");
		writeLibrary([page("n", "/n")]);
		const { send } = await session("print");
		await send("#n [ref:n] #n");
		assert.equal(requests.length, 1);
		await send("#n");
		assert.equal(requests.length, 2);
	});

	it("sends a plain GET: no body, no header of ours", async () => {
		serve("/n", "text/plain", "x");
		writeLibrary([page("n", "/n")]);
		const { send } = await session("print");
		await send("#n");
		const [request] = requests;
		assert.equal(request?.method, "GET");
		assert.deepEqual(
			Object.keys(request?.headers ?? {}).filter((name) => /^(authorization|cookie|x-)/i.test(name)),
			[],
		);
	});

	it("uses text, JSON and Markdown bodies as they are", async () => {
		serve("/t", "text/plain", "plain\n");
		serve("/j", "application/json; charset=utf-8", '{"a":1}');
		serve("/ld", "application/ld+json", '{"b":2}');
		serve("/m", "text/markdown", "# Title\n\n- item\n");
		serve("/untyped", undefined, "no type header");
		writeLibrary([page("t", "/t"), page("j", "/j"), page("ld", "/ld"), page("m", "/m"), page("untyped", "/untyped")]);
		const { send } = await session("print");
		const blocks = blocksOf(await send("#t #j #ld #m #untyped"));
		assert.deepEqual(
			blocks.map((block) => block.body.split("\n").slice(1).join("\n")),
			["plain\n", '{"a":1}', '{"b":2}', "# Title\n\n- item\n", "no type header"],
		);
	});

	it("inlines HTML raw", async () => {
		const html = '<!doctype html><html><head><script>alert("x")</script></head><body><h1>Hi &amp; bye</h1></body></html>';
		serve("/h", "text/html; charset=utf-8", html);
		writeLibrary([page("h", "/h")]);
		const { send } = await session("print");
		const [block] = blocksOf(await send("#h"));
		assert.equal(block?.body, `GET ${base}/h\n${html}`);
	});

	it("strips control characters from the body", async () => {
		serve("/c", "text/plain", `ok${ESC}[31m red\u0007\n`);
		writeLibrary([page("c", "/c")]);
		const { send } = await session("print");
		const [block] = blocksOf(await send("#c"));
		assert.equal(block?.body, `GET ${base}/c\nok[31m red\n`);
	});
});

describe("redirects", () => {
	const chain = (length: number) => {
		for (let hop = 0; hop < length; hop++) {
			routes[`/hop${hop}`] = (_request, response) => {
				response.writeHead(hop % 2 === 0 ? 302 : 301, { location: hop === length - 1 ? "/final" : `/hop${hop + 1}` });
				response.end();
			};
		}
		serve("/final", "text/plain", "arrived");
	};

	it("follows up to 5, relative or absolute", async () => {
		chain(5);
		routes["/hop2"] = (_request, response) => {
			response.writeHead(307, { location: `${base}/hop3` });
			response.end();
		};
		writeLibrary([page("r", "/hop0")]);
		const { send } = await session("print");
		const [block] = blocksOf(await send("#r"));
		assert.equal(block?.body, `GET ${base}/hop0\narrived`);
		assert.match(block?.attributes ?? "", new RegExp(`source="${base}/hop0"`));
		assert.equal(requests.length, 6);
	});

	for (const mode of ["tui", "print"] as const) {
		it(`fails past 5 redirects (${mode})`, async () => {
			chain(6);
			writeLibrary([page("r", "/hop0")]);
			const { s, send } = await session(mode);
			const sent = await send("see #r");
			if (mode === "tui") {
				assert.deepEqual(sent, { action: "handled" });
				assert.match(s.notices.at(-1)?.message ?? "", /#r: .*\/hop0 cannot be fetched: more than 5 redirects/);
			} else {
				assert.match(sent?.text ?? "", /error="[^"]*cannot be fetched: more than 5 redirects"/);
			}
			assert.equal(requests.length, 6);
		});
	}

	it("fails on a redirect to anything but http or https", async () => {
		routes["/out"] = (_request, response) => {
			response.writeHead(302, { location: "file:///etc/passwd" });
			response.end();
		};
		writeLibrary([page("out", "/out")]);
		const { send } = await session("print");
		assert.match((await send("#out"))?.text ?? "", /error="[^"]*redirected to file:\/\/\/etc\/passwd, which is not an http or https URL"/);
	});

	it("answers a redirect without a target as an HTTP status", async () => {
		routes["/lost"] = (_request, response) => {
			response.writeHead(302);
			response.end();
		};
		writeLibrary([page("lost", "/lost")]);
		const { send } = await session("print");
		assert.match((await send("#lost"))?.text ?? "", /error="[^"]*\/lost answered HTTP 302"/);
	});
});

describe("the limits", () => {
	it("cuts a body past 50 KB and says so", async () => {
		serve("/big", "text/plain", "x".repeat(200_000));
		writeLibrary([page("big", "/big")]);
		const { send } = await session("print");
		const [block] = blocksOf(await send("#big"));
		assert.match(block?.attributes ?? "", /truncated="50 KB"$/);
		assert.match(block?.body ?? "", new RegExp(`^GET ${base}/big \\(truncated at 50 KB\\)\\nx{51200}$`));
	});

	it("lets max_output raise the cap", async () => {
		serve("/big", "text/plain", "x".repeat(200_000));
		writeLibrary([page("big", "/big", { max_output: 1024 * 1024 })]);
		const { send } = await session("print");
		const [block] = blocksOf(await send("#big"));
		assert.equal(block?.attributes.includes("truncated"), false);
		assert.equal(block?.body.split("\n")[1]?.length, 200_000);
	});

	it("does not cut in the middle of a character", async () => {
		serve("/wide", "text/plain", "é".repeat(30_000));
		writeLibrary([page("wide", "/wide")]);
		const { send } = await session("print");
		const [block] = blocksOf(await send("#wide"));
		assert.equal(block?.body.split("\n")[1], "é".repeat(25_600));
	});

	for (const [label, respond] of [
		[
			"waits for the first byte",
			(response: ServerResponse) => {
				setTimeout(() => response.end("late"), 5000).unref();
			},
		],
		[
			"waits for the rest of the body",
			(response: ServerResponse) => {
				response.write("start");
			},
		],
	] as const) {
		it(`reports the timeout of a server that ${label}`, async () => {
			routes["/slow"] = (_request, response) => {
				response.writeHead(200, { "content-type": "text/plain" });
				respond(response);
			};
			writeLibrary([page("slow", "/slow", { timeout: 1 })]);
			const { send } = await session("print");
			const started = Date.now();
			assert.match((await send("#slow"))?.text ?? "", /error="[^"]*\/slow timed out after 1 s"/);
			assert.ok(Date.now() - started < 4000);
			assert.match(stderr.join(""), /#slow: .*timed out after 1 s/);
		});
	}
});

describe("failures", () => {
	beforeEach(() => {
		serve("/png", "image/png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 1, 2]));
		serve("/pdf", "application/pdf", "%PDF-1.7 text-looking");
		serve("/blob", "text/plain", Buffer.from([80, 75, 3, 4, 0, 0, 1, 2]));
		serve("/blob-untyped", undefined, Buffer.from([80, 75, 3, 4, 0, 0, 1, 2]));
		writeLibrary([page("png", "/png"), page("pdf", "/pdf"), page("blob", "/blob"), page("untyped", "/blob-untyped"), page("gone", "/gone")]);
	});

	it("refuses a binary body, by its type or by its bytes", async () => {
		const { send } = await session("print");
		const sent = await send("#png #pdf #blob #untyped");
		assert.deepEqual(
			[...(sent?.text ?? "").matchAll(/error="([^"]*)"/g)].map((match) => match[1]?.replace(base, "")),
			[
				"/png answered binary content (image/png)",
				"/pdf answered binary content (application/pdf)",
				"/blob answered binary content",
				"/blob-untyped answered binary content",
			],
		);
	});

	it("fails on an error status, naming it", async () => {
		const { send } = await session("print");
		assert.match((await send("#gone"))?.text ?? "", /error="[^"]*\/gone answered HTTP 404"/);
		assert.match(stderr.join(""), /#gone: .*answered HTTP 404/);
	});

	it("fails when the server cannot be reached, with the system's reason", async () => {
		writeLibrary([page("refused", "/")]);
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
		const tui = await session("tui");
		assert.deepEqual(await tui.send("#refused"), { action: "handled" });
		assert.match(tui.s.notices.at(-1)?.message ?? "", new RegExp(`#refused: ${base}/ cannot be fetched: .*ECONNREFUSED`));
	});

	it("cancels a TUI send and restores the draft", async () => {
		const { s, send } = await session("tui");
		assert.deepEqual(await send("see #gone and #png"), { action: "handled" });
		assert.deepEqual(s.editorTexts, ["see #gone and #png"]);
		assert.match(s.notices.at(-1)?.message ?? "", /#gone: .*HTTP 404\n#png: .*binary/);
	});

	for (const mode of ["print", "json", "rpc"] as const) {
		it(`sends a Failure note and warns, without cancelling, in ${mode} mode`, async () => {
			const { s, send } = await session(mode);
			const sent = await send("a #png b");
			assert.equal(sent?.action, "transform");
			assert.match(sent?.text ?? "", /^a #png b\n\n<context-ref name="png" kind="dynamic" source="[^"]*" bytes="0" error="[^"]*binary content/);
			if (mode === "rpc") assert.match(s.notices.at(-1)?.message ?? "", /#png: .*binary content/);
			else assert.match(stderr.join(""), /#png: .*binary content/);
		});
	}
});

describe("a URL Ref among other Refs", () => {
	it("is a block of its own in a Bundle, apart from the inline members", async () => {
		serve("/spec", "text/markdown", "# Spec");
		writeLibrary([
			{ name: "rule", kind: "snippet", text: "Be brief.", tags: ["ctx"] },
			{ ...page("spec", "/spec"), tags: ["ctx"] },
		]);
		const { send } = await session("print");
		const sent = await send("go #tag:ctx");
		assert.equal(sent?.text.startsWith('go Be brief.\n\n<context-ref name="spec" kind="dynamic"'), true, sent?.text);
		assert.equal(blocksOf(sent).length, 1);
		assert.equal(sent?.text.includes("[ref:spec]"), false);
	});

	it("is not fetched again for a message that already carries its block", async () => {
		serve("/n", "text/plain", "x");
		writeLibrary([page("n", "/n")]);
		const { send } = await session("print");
		const first = await send("#n");
		assert.equal(await send(first?.text ?? ""), undefined);
		assert.equal(requests.length, 1);
	});
});

describe("the TUI while a page is fetched", () => {
	it("shows 'running #x…' and clears it when the fetch ends", async () => {
		serve("/n", "text/plain", "x");
		writeLibrary([page("n", "/n")]);
		const { s, send } = await session("tui");
		await send("#n");
		assert.deepEqual(
			s.statuses.map((status) => status.text),
			["running #n… (esc cancels)", undefined, undefined],
		);
	});

	it("cancels the send on Esc, closes the connection and restores the draft", async () => {
		let closed = false;
		routes["/hang"] = (request, response) => {
			response.writeHead(200, { "content-type": "text/plain" });
			response.write("start");
			request.socket.on("close", () => {
				closed = true;
			});
		};
		writeLibrary([page("hang", "/hang", { timeout: 120 })]);
		const { s, send } = await session("tui");
		const sending = send("look at #hang");
		while (requests.length === 0) await new Promise((resolve) => setTimeout(resolve, 10));
		assert.match(s.statuses.at(-1)?.text ?? "", /running #hang/);
		assert.equal(s.pressKey(ESC), true);
		assert.deepEqual(await sending, { action: "handled" });
		assert.deepEqual(s.editorTexts, ["look at #hang"]);
		assert.match(s.notices.at(-1)?.message ?? "", /cancelled/);
		while (!closed) await new Promise((resolve) => setTimeout(resolve, 10));
	});
});
