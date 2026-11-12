// A fake pi host for integration tests: the extension API the guard uses and a
// session context with recorded UI calls. Nothing here touches the real pi or the
// real home directory.

type Handler = (event: any, ctx: any) => unknown;

export interface FakeHost {
	pi: Record<string, unknown>;
	commands: Map<string, { handler(args: string, ctx: unknown): Promise<void> }>;
	providers: Map<string, unknown>;
	entries: Array<{ customType: string; data: any }>;
	sentMessages: unknown[];
	/** Every call made on the extension API, by method name, in call order. */
	calls: Array<{ method: string; args: unknown[] }>;
	/** Runs every handler for an event; the last defined result wins. */
	fire(event: string, payload: unknown, ctx: unknown): Promise<any>;
	handlerCount(event: string): number;
	/** Names of events with at least one handler. */
	handledEvents(): string[];
	/** pi's event bus between extensions: `emit` calls every handler at once, as pi's does. */
	events: { emit(channel: string, data: unknown): void; on(channel: string, handler: (data: any) => unknown): () => void };
}

export function createFakeHost(): FakeHost {
	const handlers = new Map<string, Handler[]>();
	const calls: FakeHost["calls"] = [];
	const channels = new Map<string, Array<(data: any) => unknown>>();
	const host: FakeHost = {
		pi: {},
		commands: new Map(),
		providers: new Map(),
		entries: [],
		sentMessages: [],
		calls,
		async fire(event, payload, ctx) {
			let result: unknown;
			for (const handler of handlers.get(event) ?? []) {
				const value = await handler(payload, ctx);
				if (value !== undefined) result = value;
			}
			return result;
		},
		handlerCount: (event) => handlers.get(event)?.length ?? 0,
		handledEvents: () => [...handlers.entries()].filter(([, list]) => list.length > 0).map(([event]) => event),
		events: {
			emit(channel, data) {
				for (const handler of channels.get(channel) ?? []) handler(data);
			},
			on(channel, handler) {
				channels.set(channel, [...(channels.get(channel) ?? []), handler]);
				return () =>
					channels.set(
						channel,
						(channels.get(channel) ?? []).filter((h) => h !== handler),
					);
			},
		},
	};
	const known: Record<string, (...args: any[]) => unknown> = {
		on: (event: string, handler: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
		registerCommand: (name: string, def: { handler(args: string, ctx: unknown): Promise<void> }) => host.commands.set(name, def),
		registerProvider: (name: string, config: unknown) => host.providers.set(name, config),
		appendEntry: (customType: string, data: unknown) => host.entries.push({ customType, data }),
		sendUserMessage: (content: unknown) => host.sentMessages.push(content),
	};
	// Any other API method is accepted and recorded, so an extension that registers
	// something unexpected is visible to a test rather than crashing the load.
	host.pi = new Proxy(known, {
		get(target, method) {
			if (typeof method !== "string") return undefined;
			if (method === "events") return host.events;
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
	statuses: Map<string, string | undefined>;
	notices: Array<{ message: string; type?: string }>;
	editorTexts: string[];
	aborts: number;
}

export interface FakeAuth {
	usingOAuth?: boolean;
	status?: { configured: boolean; source?: string; label?: string };
}

export function createFakeSession(
	options: {
		cwd?: string;
		model?: { provider: string; id: string } | null;
		hasUI?: boolean;
		idle?: boolean;
		auth?: FakeAuth;
		/** Auth per provider id; a provider not named here uses `auth`. */
		authByProvider?: Record<string, FakeAuth>;
		/** The models `modelRegistry.find` knows. */
		models?: Array<{ provider: string; id: string }>;
	} = {},
): FakeSession {
	const statuses = new Map<string, string | undefined>();
	const notices: FakeSession["notices"] = [];
	const editorTexts: string[] = [];
	const session: FakeSession = {
		statuses,
		notices,
		editorTexts,
		aborts: 0,
		ctx: {
			cwd: options.cwd ?? "/work/repo",
			hasUI: options.hasUI ?? false,
			model: options.model === null ? undefined : (options.model ?? { provider: "acme", id: "mid" }),
			modelRegistry: {
				isUsingOAuth: (model: { provider: string }) => (options.authByProvider?.[model.provider] ?? options.auth)?.usingOAuth ?? false,
				getProviderAuthStatus: (provider: string) =>
					(options.authByProvider?.[provider] ?? options.auth)?.status ?? { configured: true, source: "stored" },
				getAvailable: () => [],
				getAll: () => [],
				getProvider: () => undefined,
				find: (provider: string, id: string) => options.models?.find((model) => model.provider === provider && model.id === id),
			},
			ui: {
				notify: (message: string, type?: string) => notices.push({ message, ...(type ? { type } : {}) }),
				setStatus: (key: string, text: string | undefined) => statuses.set(key, text),
				setEditorText: (text: string) => editorTexts.push(text),
				// No answer, like a closed dialog; tests that answer replace these.
				select: async () => undefined,
				confirm: async () => false,
			},
			isIdle: () => options.idle ?? true,
			abort: () => {
				session.aborts += 1;
			},
		},
	};
	return session;
}
