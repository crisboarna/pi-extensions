// Serves a terminal scene to the media renderer: the package's media pages,
// the shared stage assets and xterm.js, and one pseudo-terminal per scene
// that runs the command the package's setup module chose.
//
//   GET  /src/...        the package's media/src
//   GET  /stage/...      tools/media/stage
//   GET  /modules/...    the media image's node_modules (xterm.js)
//   GET  /repo/tools/brand/...  the family tokens (tools/brand)
//   POST /pty            starts the scene's command at { cols, rows }
//   GET  /pty/out        the terminal's output as server-sent events (base64)
//   POST /pty/in         bytes typed into the terminal
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";

const TYPES = {
	".html": "text/html",
	".js": "text/javascript",
	".mjs": "text/javascript",
	".css": "text/css",
	".json": "application/json",
	".svg": "image/svg+xml",
	".png": "image/png",
};

/** Starts the server on a free local port; `spawnSpec` is { command, args, env, cwd }. */
export async function startStage({ mediaDir, modulesDir, spawnSpec }) {
	const roots = {
		"/src/": join(mediaDir, "src"),
		"/stage/": join(import.meta.dirname, "stage"),
		"/modules/": modulesDir,
		// The same absolute path pages use under file://, so one stylesheet serves both.
		"/repo/tools/brand/": join(import.meta.dirname, "..", "brand"),
	};
	let child;
	const listeners = new Set();
	const backlog = [];
	const emit = (chunk) => {
		const line = `data: ${chunk.toString("base64")}\n\n`;
		backlog.push(line);
		for (const res of listeners) res.write(line);
	};
	const server = createServer(async (req, res) => {
		const url = new URL(req.url, "http://stage");
		if (req.method === "POST" && url.pathname === "/pty") {
			const { cols, rows } = JSON.parse(await body(req));
			child?.kill();
			backlog.length = 0;
			child = spawn(
				"python3",
				["-I", join(import.meta.dirname, "run-in-pty.py"), String(cols), String(rows), "--", spawnSpec.command, ...spawnSpec.args],
				{
					cwd: spawnSpec.cwd,
					env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor", ...spawnSpec.env },
				},
			);
			child.stdout.on("data", emit);
			child.stderr.on("data", (data) => process.stderr.write(data));
			res.end("{}");
			return;
		}
		if (req.method === "POST" && url.pathname === "/pty/in") {
			child?.stdin.write(Buffer.from(await body(req), "base64"));
			res.end("{}");
			return;
		}
		if (url.pathname === "/pty/out") {
			res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store" });
			for (const line of backlog) res.write(line);
			listeners.add(res);
			req.on("close", () => listeners.delete(res));
			return;
		}
		const prefix = Object.keys(roots).find((key) => url.pathname.startsWith(key));
		const file = prefix ? normalize(join(roots[prefix], url.pathname.slice(prefix.length))) : undefined;
		if (!prefix || !file?.startsWith(roots[prefix])) return void res.writeHead(404).end();
		try {
			const data = await readFile(file);
			res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream" });
			res.end(data);
		} catch {
			res.writeHead(404).end();
		}
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	return {
		url: `http://127.0.0.1:${server.address().port}`,
		close() {
			child?.kill();
			for (const res of listeners) res.end();
			server.close();
		},
	};
}

function body(req) {
	return new Promise((resolve) => {
		let text = "";
		req.on("data", (data) => (text += data));
		req.on("end", () => resolve(text));
	});
}
