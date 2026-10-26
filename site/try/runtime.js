// The live try-it pages: boots a WebContainer, mounts the package's snapshot
// (gzipped; unpacked here with DecompressionStream), runs the demo kit's boot
// script, then starts the program it names in an xterm.js terminal. Pages call
// startTry() from a button, so nothing loads until the visitor asks for it.
import { WebContainer } from "../vendor/webcontainer/index.js";

const THEME = { background: "#10161e", foreground: "#f1e6cf", cursor: "#c9a34e", selectionBackground: "#33445a" };

/** Reads the boot script's output until its JSON line with `ready: true`. */
async function readyLine(stream) {
	const reader = stream.getReader();
	let text = "";
	for (;;) {
		const { value, done } = await reader.read();
		if (done) throw new Error(`the demo kit stopped before it was ready:\n${text}`);
		text += value;
		const line = text.split("\n").find((candidate) => candidate.startsWith('{"ready":true'));
		if (line) {
			reader.releaseLock();
			return JSON.parse(line);
		}
	}
}

export async function startTry({ element, status, shell }) {
	const state = { state: "booting", output: "", times: { start: performance.now() } };
	window.TRY = state;
	const term = new Terminal({ fontFamily: '"JetBrains Mono", "IBM Plex Mono", monospace', fontSize: 14, theme: THEME, cursorBlink: true });
	const fit = new FitAddon.FitAddon();
	term.loadAddon(fit);
	term.open(element);
	fit.fit();
	status("Starting the container…");
	const container = await WebContainer.boot({ workdirName: "demo" });
	state.times.booted = performance.now();
	status("Loading pi and the extension…");
	const response = await fetch("try/snapshot.gz");
	const snapshot = await new Response(response.body.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
	await container.mount(snapshot);
	state.times.mounted = performance.now();
	status("Starting the demo accounts…");
	const kit = await container.spawn("node", ["boot.js"]);
	const ready = await readyLine(kit.output);
	const program = shell ? { command: "jsh", args: [] } : { command: ready.command, args: ready.args };
	const process = await container.spawn(program.command, program.args, { cwd: ready.cwd, env: ready.env, terminal: { cols: term.cols, rows: term.rows } });
	process.output.pipeTo(
		new WritableStream({
			write(data) {
				state.output += data;
				term.write(data);
			},
		}),
	);
	const input = process.input.getWriter();
	term.onData((data) => input.write(data));
	addEventListener("resize", () => {
		fit.fit();
		process.resize({ cols: term.cols, rows: term.rows });
	});
	state.type = (text) => input.write(text);
	state.state = "running";
	state.times.running = performance.now();
	status("");
	term.focus();
	return state;
}
