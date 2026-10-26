// The page side of a terminal scene. A package page loads xterm.js, this
// file and its own scenario, then defines window.play() with the Stage API:
//
//   const stage = await Stage.open({ fontSize, title });   fits the window
//   await stage.waitFor(/\(switchboard\)/);       text on the visible screen
//   await stage.type("/tier try …"); await stage.press("Enter");
//   stage.caption("…", "1/5"); stage.callout(/standard/, "<b>tier</b> …");
//
// Keys go through Playwright's keyboard into xterm.js, so pi receives exactly
// what a real terminal sends, in whatever keyboard protocol pi negotiated.
(() => {
	const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
	const THEME = {
		background: "#10161e",
		foreground: "#e6dcc6",
		cursor: "#c9a34e",
		cursorAccent: "#10161e",
		selectionBackground: "#33445a",
		black: "#1a2431",
		red: "#e06c5a",
		green: "#8fc27a",
		yellow: "#d8b25e",
		blue: "#6fa3d9",
		magenta: "#c08fd6",
		cyan: "#62b7b3",
		white: "#d9d2c3",
		brightBlack: "#5c6b7c",
		brightRed: "#f08a78",
		brightGreen: "#a9d993",
		brightYellow: "#ecc978",
		brightBlue: "#8dbbea",
		brightMagenta: "#d4a8e6",
		brightCyan: "#82cfcb",
		brightWhite: "#f6efe0",
	};

	class Stage {
		static async open({ fontSize = 17, title = "pi" } = {}) {
			document.body.insertAdjacentHTML(
				"beforeend",
				`<div class="stage-window"><div class="stage-chrome"><i></i><i></i><i></i><span></span></div><div class="stage-term"><div id="stage-xterm"></div><div class="stage-overlay"></div></div></div><div class="stage-caption hidden"><span class="step"></span><span class="text"></span></div>`,
			);
			document.querySelector(".stage-chrome span").textContent = title;
			await document.fonts.load(`${fontSize}px "JetBrains Mono"`);
			const term = new Terminal({
				cols: 80,
				rows: 24,
				fontSize,
				fontFamily: '"JetBrains Mono", monospace',
				lineHeight: 1.12,
				theme: THEME,
				cursorBlink: false,
				allowProposedApi: true,
			});
			term.open(document.querySelector("#stage-xterm"));
			// Fit the grid to the window, as a terminal app would, before the program starts.
			const area = document.querySelector(".stage-term");
			const style = getComputedStyle(area);
			const screen = term.element.querySelector(".xterm-screen").getBoundingClientRect();
			const width = area.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight);
			const height = area.clientHeight - Number.parseFloat(style.paddingTop) - Number.parseFloat(style.paddingBottom);
			const cols = Math.floor(width / (screen.width / 80));
			const rows = Math.floor(height / (screen.height / 24));
			term.resize(cols, rows);
			term.focus();
			const stage = new Stage(term);
			term.onData((data) => stage.#send(data));
			term.onBinary((data) => stage.#send(data, true));
			const source = new EventSource("/pty/out");
			source.onmessage = (event) => term.write(Uint8Array.from(atob(event.data), (c) => c.charCodeAt(0)));
			await fetch("/pty", { method: "POST", body: JSON.stringify({ cols, rows }) });
			return stage;
		}

		constructor(term) {
			this.term = term;
			this.overlay = document.querySelector(".stage-overlay");
			this.callouts = [];
			term.onRender(() => {
				for (const callout of this.callouts) this.#place(callout);
			});
		}

		#send(data, binary = false) {
			const bytes = binary ? Uint8Array.from(data, (c) => c.charCodeAt(0)) : new TextEncoder().encode(data);
			fetch("/pty/in", { method: "POST", body: btoa(String.fromCharCode(...bytes)) });
		}

		/** The visible screen, one string per row. */
		lines() {
			const buffer = this.term.buffer.active;
			const out = [];
			for (let row = 0; row < this.term.rows; row++) out.push(buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? "");
			return out;
		}

		/** The first visible match: { row, col, length }, or undefined. Searches bottom-up when `last` is set. */
		find(pattern, { last = false } = {}) {
			const lines = this.lines();
			const order = [...lines.keys()];
			if (last) order.reverse();
			for (const row of order) {
				const line = lines[row];
				const match = typeof pattern === "string" ? (line.includes(pattern) ? { index: line.indexOf(pattern), 0: pattern } : null) : pattern.exec(line);
				if (match) return { row, col: match.index, length: match[0].length };
			}
			return undefined;
		}

		async waitFor(pattern, { timeout = 30_000, last = false } = {}) {
			const started = Date.now();
			for (;;) {
				const found = this.find(pattern, { last });
				if (found) return found;
				if (Date.now() - started > timeout) throw new Error(`stage: timed out waiting for ${pattern}\n${this.lines().join("\n")}`);
				await sleep(60);
			}
		}

		async waitGone(pattern, { timeout = 30_000 } = {}) {
			const started = Date.now();
			while (this.find(pattern)) {
				if (Date.now() - started > timeout) throw new Error(`stage: ${pattern} did not go away`);
				await sleep(60);
			}
		}

		/** Types like a person: steady with a little jitter. */
		async type(text, { delay = 42 } = {}) {
			for (const char of text) {
				await window.__stageType(char);
				await sleep(delay + Math.round(Math.sin(char.charCodeAt(0)) * delay * 0.4));
			}
		}

		/** A Playwright key name such as "Enter", "Escape", "ArrowDown" or "Control+Alt+w". */
		async press(key, { after = 120 } = {}) {
			await window.__stagePress(key);
			await sleep(after);
		}

		/** Types a slash command and runs it; the first Enter may only accept pi's autocomplete. */
		async command(text, options) {
			await this.type(text, options);
			await sleep(250);
			await this.press("Enter", { after: 400 });
			if (this.find(text, { last: true })?.row >= this.term.rows - 8) await this.press("Enter", { after: 300 });
		}

		caption(text, step = "") {
			const bar = document.querySelector(".stage-caption");
			bar.classList.toggle("hidden", !text);
			bar.querySelector(".text").innerHTML = text ?? "";
			const chip = bar.querySelector(".step");
			chip.textContent = step;
			chip.style.display = step ? "" : "none";
		}

		#cell() {
			const screen = this.term.element.querySelector(".xterm-screen").getBoundingClientRect();
			const host = this.overlay.getBoundingClientRect();
			return { width: screen.width / this.term.cols, height: screen.height / this.term.rows, left: screen.left - host.left, top: screen.top - host.top };
		}

		/**
		 * Draws a box around the first match of `pattern` (or `{ row, col, length }`) and a label beside it.
		 * place: "above" | "below" | "left" | "right". The callout follows its text when the screen
		 * scrolls, and hides while the text is off screen.
		 */
		callout(pattern, label, options = {}) {
			const callout = { pattern, options, alert: Boolean(options.alert) };
			if (!this.#locate(callout)) throw new Error(`stage: nothing on screen matches ${pattern}\n${this.lines().join("\n")}`);
			callout.box = document.createElement("div");
			callout.box.className = `callout-box${callout.alert ? " alert" : ""}`;
			callout.tag = document.createElement("div");
			callout.tag.className = `callout-label${callout.alert ? " alert" : ""}`;
			callout.tag.innerHTML = label;
			callout.line = document.createElement("div");
			callout.line.className = `callout-line${callout.alert ? " alert" : ""}`;
			this.overlay.append(callout.box, callout.tag, callout.line);
			this.callouts.push(callout);
			this.#place(callout);
			return callout;
		}

		#locate(callout) {
			const { pattern, options } = callout;
			if (typeof pattern === "object" && "row" in pattern) return pattern;
			// A callout keeps to the match it first found: the same text at the same column.
			const found = this.find(pattern, { last: options.last });
			if (found && callout.col !== undefined && found.col !== callout.col) return undefined;
			if (found) callout.col = found.col;
			return found;
		}

		#place(callout) {
			const at = this.#locate(callout);
			const parts = [callout.box, callout.tag, callout.line];
			for (const part of parts) part.style.visibility = at ? "visible" : "hidden";
			if (!at) return;
			const { pad = 3, span = 1, dx = 0 } = callout.options;
			const cell = this.#cell();
			const x = cell.left + at.col * cell.width - pad;
			const y = cell.top + at.row * cell.height - pad;
			const w = at.length * cell.width + pad * 2;
			const h = (at.rows ?? span) * cell.height + pad * 2;
			Object.assign(callout.box.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });
			const tw = callout.tag.offsetWidth;
			const th = callout.tag.offsetHeight;
			const gap = 26;
			const host = this.overlay.getBoundingClientRect();
			const clampX = (value) => Math.max(4, Math.min(host.width - tw - 4, value));
			// A label that does not fit to the right goes below, so its connector never crosses it.
			const asked = callout.options.place ?? "below";
			const place = asked === "right" && x + w + gap + tw > host.width - 4 ? "below" : asked;
			const spot = {
				above: [clampX(x + dx), y - gap - th],
				below: [clampX(x + dx), y + h + gap],
				left: [x - gap - tw, y + h / 2 - th / 2],
				right: [x + w + gap, y + h / 2 - th / 2],
			}[place];
			Object.assign(callout.tag.style, { left: `${spot[0]}px`, top: `${spot[1]}px` });
			const from = { above: [x + w / 2, y], below: [x + w / 2, y + h], left: [x, y + h / 2], right: [x + w, y + h / 2] }[place];
			const to = {
				above: [spot[0] + Math.min(tw / 2, 40), spot[1] + th],
				below: [spot[0] + Math.min(tw / 2, 40), spot[1]],
				left: [spot[0] + tw, spot[1] + th / 2],
				right: [spot[0], spot[1] + th / 2],
			}[place];
			const length = Math.hypot(to[0] - from[0], to[1] - from[1]);
			Object.assign(callout.line.style, {
				left: `${from[0]}px`,
				top: `${from[1]}px`,
				width: `${length}px`,
				transform: `rotate(${Math.atan2(to[1] - from[1], to[0] - from[0])}rad)`,
			});
		}

		clear() {
			this.callouts = [];
			this.overlay.replaceChildren();
		}

		/** Speaks a line of the page's narration file and waits until it and the pause after it are over. */
		async say(id) {
			if (!window.__stageSay) throw new Error(`stage.say("${id}"): this item has no narration file in its manifest entry`);
			await sleep(await window.__stageSay(id));
		}

		/** Saves the current frame as `<out>.png`, or `<out>-<name>.png` when named, once callouts have faded in. */
		async still(name) {
			await sleep(450);
			await window.__stageStill?.(name);
		}

		/** A full-frame card over the terminal (title or end card); `null` hides it. */
		card(html) {
			let card = document.querySelector(".stage-card");
			if (!card) {
				card = document.createElement("div");
				card.className = "stage-card hidden";
				document.body.append(card);
			}
			if (html) card.innerHTML = html;
			card.classList.toggle("hidden", !html);
		}
	}

	window.Stage = Stage;
	window.sleep = sleep;
})();
