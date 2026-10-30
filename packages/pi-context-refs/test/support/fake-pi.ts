// A fake pi host for integration tests: the extension API the package registers against,
// and a session context that records the UI calls. Nothing here touches the real pi or the
// real home directory.

type Handler = (event: any, ctx: any) => unknown;

export interface FakeHost {
	pi: Record<string, unknown>;
	commands: Map<string, { handler(args: string, ctx: unknown): Promise<void> }>;
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
		on: (event: string, handler: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
		registerCommand: (name: string, def: { handler(args: string, ctx: unknown): Promise<void> }) => host.commands.set(name, def),
	};
	// Any other API method is accepted and recorded, so an extension that registers
	// something unexpected is visible to a test rather than crashing the load.
	host.pi = new Proxy(known, {
		get(target, method) {
			if (typeof method !== "string") return undefined;
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
}

/** A session context. `hasUI` is true for the TUI and RPC, false for print and JSON mode. */
export function createFakeSession(options: { cwd: string; hasUI?: boolean }): FakeSession {
	const notices: FakeSession["notices"] = [];
	const editorTexts: string[] = [];
	return {
		notices,
		editorTexts,
		ctx: {
			cwd: options.cwd,
			hasUI: options.hasUI ?? false,
			ui: {
				notify: (message: string, type?: string) => notices.push({ message, ...(type ? { type } : {}) }),
				setEditorText: (text: string) => editorTexts.push(text),
			},
		},
	};
}
