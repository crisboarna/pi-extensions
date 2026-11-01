// A fake pi host for integration tests: the extension API the package registers against,
// and a session context that records the UI calls. Nothing here touches the real pi or the
// real home directory.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import { withoutRepositoryVariables } from "./git-repo.ts";

type Handler = (event: any, ctx: any) => unknown;

/** The methods and event names of pi's `ExtensionAPI`, read from the declarations the installed pi ships, so a host that is looser than pi cannot hide a call pi does not have. */
const PI_API = (() => {
	const types = readFileSync(
		join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "core", "extensions", "types.d.ts"),
		"utf8",
	);
	const start = types.indexOf("export interface ExtensionAPI {");
	const body = types.slice(start, types.indexOf("\n}\n", start));
	return {
		methods: new Set([...body.matchAll(/^ {4}([a-zA-Z]+)[(<]/gm)].map((match) => match[1])),
		events: new Set([...body.matchAll(/^ {4}on\(event: "([a-z_]+)"/gm)].map((match) => match[1])),
	};
})();

interface ExecResult {
	stdout: string;
	stderr: string;
	code: number;
	killed: boolean;
}

/** `pi.exec` as pi implements it: a real child with no shell, killed on a timeout or an abort. A child that cannot start gives exit 1 and no output. */
function exec(command: string, args: string[], options: { cwd?: string; timeout?: number; signal?: AbortSignal } = {}): Promise<ExecResult> {
	return new Promise((resolve) => {
		const child = spawn(command, args, { cwd: options.cwd, env: withoutRepositoryVariables(process.env), shell: false, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		let killed = false;
		const kill = () => {
			killed = true;
			child.kill("SIGTERM");
		};
		const timer = options.timeout ? setTimeout(kill, options.timeout) : undefined;
		if (options.signal?.aborted) kill();
		else options.signal?.addEventListener("abort", kill, { once: true });
		child.stdout.on("data", (data) => {
			stdout += data.toString();
		});
		child.stderr.on("data", (data) => {
			stderr += data.toString();
		});
		const done = (code: number | null) => {
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", kill);
			resolve({ stdout, stderr, code: code ?? 0, killed });
		};
		child.once("error", () => done(1));
		child.once("close", done);
	});
}

export interface FakeHost {
	pi: Record<string, unknown>;
	commands: Map<string, { handler(args: string, ctx: unknown): Promise<void> }>;
	/** The shortcuts the extension registered, by key. */
	shortcuts: Map<string, { handler(ctx: unknown): Promise<void> | void }>;
	/** Every call made on the extension API, by method name, in call order. */
	calls: Array<{ method: string; args: unknown[] }>;
	/** Runs every handler for an event; the last defined result wins. */
	fire(event: string, payload: unknown, ctx: unknown): Promise<any>;
	/** Names of events with at least one handler. */
	handledEvents(): string[];
}

export function createFakeHost(): FakeHost {
	const handlers = new Map<string, Handler[]>();
	const calls: FakeHost["calls"] = [];
	const host: FakeHost = {
		pi: {},
		commands: new Map(),
		shortcuts: new Map(),
		calls,
		async fire(event, payload, ctx) {
			let result: unknown;
			for (const handler of handlers.get(event) ?? []) {
				const value = await handler(payload, ctx);
				if (value !== undefined) result = value;
			}
			return result;
		},
		handledEvents: () => [...handlers.entries()].filter(([, list]) => list.length > 0).map(([event]) => event),
	};
	const known: Record<string, (...args: any[]) => unknown> = {
		on: (event: string, handler: Handler) => {
			if (!PI_API.events.has(event)) throw new Error(`pi has no event "${event}"`);
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerCommand: (name: string, def: { handler(args: string, ctx: unknown): Promise<void> }) => host.commands.set(name, def),
		registerShortcut: (key: string, def: { handler(ctx: unknown): Promise<void> | void }) => host.shortcuts.set(key, def),
		exec,
	};
	// Any other method pi has is accepted and recorded, so an extension that registers
	// something unexpected is visible to a test; a method pi does not have throws.
	host.pi = new Proxy(known, {
		get(target, method) {
			if (typeof method !== "string") return undefined;
			if (!PI_API.methods.has(method)) throw new Error(`pi has no method "${method}"`);
			return (...args: unknown[]) => {
				calls.push({ method, args });
				return target[method]?.(...args);
			};
		},
	});
	return host;
}

export interface FakeSession {
	ctx: any;
	notices: Array<{ message: string; type?: string }>;
	editorTexts: string[];
	/** Every status the extension set; `text` is undefined when it cleared one. */
	statuses: Array<{ key: string; text: string | undefined }>;
	/** The factories passed to `ui.addAutocompleteProvider`, in registration order. */
	autocompleteProviders: Array<(current: AutocompleteProvider) => AutocompleteProvider>;
	/** Sends raw terminal input to the extension's listeners, as the TUI does; true when one consumed it. */
	pressKey(data: string): boolean;
	/** Puts text in the editor as the user typing would; `getEditorText` then returns it. */
	typeInEditor(text: string): void;
	/** The components shown with `ui.custom`, in the order they were opened. */
	customs: ShownComponent[];
}

/** A component the extension showed with `ui.custom`, with the `options` it asked for. */
export interface ShownComponent {
	component: { render(width: number): string[]; handleInput?(data: string): void; dispose?(): void };
	options: unknown;
	closed: boolean;
	/** What the component passed to `done`. */
	result: unknown;
	/** Renders and counts the repaints the component asked for. */
	renders: { requested: number };
}

/** A session context. `mode` is pi's run mode; `hasUI` is true for the TUI and RPC, false for print and JSON mode, and gives the mode when `mode` is not set. `trusted` is what `isProjectTrusted()` answers (true by default). */
export function createFakeSession(options: { cwd: string; hasUI?: boolean; mode?: "tui" | "rpc" | "json" | "print"; trusted?: boolean }): FakeSession {
	const notices: FakeSession["notices"] = [];
	const editorTexts: string[] = [];
	let editorText = "";
	const statuses: FakeSession["statuses"] = [];
	const autocompleteProviders: FakeSession["autocompleteProviders"] = [];
	const customs: FakeSession["customs"] = [];
	const keyListeners = new Set<(data: string) => { consume?: boolean } | undefined>();
	return {
		notices,
		editorTexts,
		statuses,
		autocompleteProviders,
		customs,
		typeInEditor: (text) => {
			editorText = text;
		},
		pressKey: (data) => [...keyListeners].some((listener) => listener(data)?.consume === true),
		ctx: {
			cwd: options.cwd,
			isProjectTrusted: () => options.trusted ?? true,
			mode: options.mode ?? (options.hasUI ? "tui" : "print"),
			hasUI: options.hasUI ?? (options.mode === "tui" || options.mode === "rpc"),
			ui: {
				notify: (message: string, type?: string) => notices.push({ message, ...(type ? { type } : {}) }),
				setEditorText: (text: string) => {
					editorText = text;
					editorTexts.push(text);
				},
				getEditorText: () => editorText,
				setStatus: (key: string, text: string | undefined) => statuses.push({ key, text }),
				onTerminalInput: (listener: (data: string) => { consume?: boolean } | undefined) => {
					keyListeners.add(listener);
					return () => keyListeners.delete(listener);
				},
				addAutocompleteProvider: (factory: FakeSession["autocompleteProviders"][number]) => autocompleteProviders.push(factory),
				custom: (factory: (...args: unknown[]) => unknown, customOptions: unknown) =>
					new Promise((resolve) => {
						const renders = { requested: 0 };
						const tui = { requestRender: () => void renders.requested++, terminal: { rows: 50, columns: 100 } };
						const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
						const finish = (result: unknown) => {
							const shown = customs.find((candidate) => candidate.component === component);
							if (!shown || shown.closed) return;
							shown.closed = true;
							shown.result = result;
							shown.component.dispose?.();
							resolve(result);
						};
						let component: ShownComponent["component"] | undefined;
						Promise.resolve(factory(tui, theme, {}, finish)).then((made) => {
							component = made as ShownComponent["component"];
							customs.push({ component, options: customOptions, closed: false, result: undefined, renders });
						});
					}),
				// The editor slot: nothing is installed unless a test overrides these.
				getEditorComponent: () => undefined,
				setEditorComponent: () => {},
			},
		},
	};
}
