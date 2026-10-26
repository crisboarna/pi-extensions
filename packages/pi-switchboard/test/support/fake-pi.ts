// A fake pi host for integration tests: the extension API the router uses, a
// session context with a model registry and classifier, and an event bus that
// plays Plannotator. Nothing here touches the real pi or the real home directory.

type Handler = (event: any, ctx: any) => unknown;

export interface CatalogModel {
	provider: string;
	id: string;
	contextWindow: number;
	maxTokens: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

export const CATALOG: CatalogModel[] = [
	{ provider: "acme", id: "small", contextWindow: 32_000, maxTokens: 4096, cost: { input: 1, output: 4, cacheRead: 0, cacheWrite: 0 } },
	{ provider: "acme", id: "mid", contextWindow: 128_000, maxTokens: 8192, cost: { input: 3, output: 12, cacheRead: 0, cacheWrite: 0 } },
	{ provider: "acme", id: "big", contextWindow: 400_000, maxTokens: 16_384, cost: { input: 15, output: 60, cacheRead: 0, cacheWrite: 0 } },
	{ provider: "zen", id: "mid", contextWindow: 128_000, maxTokens: 8192, cost: { input: 2, output: 8, cacheRead: 0, cacheWrite: 0 } },
];

/** Answers the classifier returns for a request, by scenario. */
export type Scenario = "plan" | "implement" | "mechanical" | "fail";

export function answersFor(scenario: Exclude<Scenario, "fail">) {
	return {
		work: { type: "choice", choice: scenario, probabilities: { [scenario]: 0.97 }, confidence: 0.95 },
		depth: { type: "score", score: scenario === "plan" ? 1.8 : scenario === "mechanical" ? 0.2 : 1.1, confidence: 0.4 },
		risky: { type: "bool", probability: 0.05 },
	};
}

export interface FakeBus {
	emit(channel: string, data: unknown): void;
	on(channel: string, handler: (data: unknown) => void): () => void;
}

function createBus(): FakeBus {
	const listeners = new Map<string, Array<(data: unknown) => void>>();
	return {
		emit(channel, data) {
			for (const listener of [...(listeners.get(channel) ?? [])]) listener(data);
		},
		on(channel, handler) {
			listeners.set(channel, [...(listeners.get(channel) ?? []), handler]);
			return () => listeners.set(channel, (listeners.get(channel) ?? []).filter((h) => h !== handler));
		},
	};
}

export interface FakeHost {
	pi: Record<string, unknown>;
	virtualModels: Map<string, { route(request: unknown, ctx: unknown): Promise<any> | any }>;
	providers: Map<string, unknown>;
	commands: Map<string, { handler(args: string, ctx: unknown): Promise<void> }>;
	renderers: Map<string, (entry: unknown, options: { expanded: boolean }, theme: unknown) => any>;
	entries: Array<{ customType: string; data: any }>;
	sentMessages: unknown[];
	bus: FakeBus;
	/** Runs every handler for an event; the last defined result wins. */
	fire(event: string, payload: unknown, ctx: unknown): Promise<any>;
	handlerCount(event: string): number;
}

export function createFakeHost(options: { planPhase?: string } = {}): FakeHost {
	const handlers = new Map<string, Handler[]>();
	const bus = createBus();
	bus.on("plannotator:request", (data) => {
		const request = data as { respond(response: unknown): void };
		request.respond({ status: "handled", result: { phase: options.planPhase ?? "executing" } });
	});
	const host: FakeHost = {
		pi: {},
		virtualModels: new Map(),
		providers: new Map(),
		commands: new Map(),
		renderers: new Map(),
		entries: [],
		sentMessages: [],
		bus,
		async fire(event, payload, ctx) {
			let result: unknown;
			for (const handler of handlers.get(event) ?? []) {
				const value = await handler(payload, ctx);
				if (value !== undefined) result = value;
			}
			return result;
		},
		handlerCount: (event) => handlers.get(event)?.length ?? 0,
	};
	host.pi = {
		on: (event: string, handler: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
		events: bus,
		registerVirtualModel: (model: { id: string; route(request: unknown, ctx: unknown): unknown }) => host.virtualModels.set(model.id, model as never),
		registerProvider: (name: string, config: unknown) => host.providers.set(name, config),
		registerCommand: (name: string, def: { handler(args: string, ctx: unknown): Promise<void> }) => host.commands.set(name, def),
		registerShortcut: () => undefined,
		registerEntryRenderer: (type: string, render: never) => host.renderers.set(type, render),
		appendEntry: (customType: string, data: unknown) => host.entries.push({ customType, data }),
		sendUserMessage: (content: unknown) => host.sentMessages.push(content),
	};
	return host;
}

export interface FakeSession {
	ctx: any;
	statuses: Map<string, string | undefined>;
	notices: Array<{ message: string; type?: string }>;
	/** Classifier calls received, with the state the extension sent. */
	classifierCalls: Array<{ model: string; state: any; questions: any }>;
	setScenario(scenario: Scenario): void;
	setHeader(header: { parentSession?: string } | null): void;
}

export function createFakeSession(host: FakeHost, options: { cwd?: string; model?: { provider: string; id: string }; sessionId?: string; sessionFile?: string; scenario?: Scenario } = {}): FakeSession {
	let scenario: Scenario = options.scenario ?? "implement";
	let header: { parentSession?: string } | null = null;
	const statuses = new Map<string, string | undefined>();
	const notices: Array<{ message: string; type?: string }> = [];
	const classifierCalls: FakeSession["classifierCalls"] = [];
	const known = new Set(CATALOG.map((m) => m.provider));
	const registry = {
		find: (provider: string, id: string) => CATALOG.find((m) => m.provider === provider && m.id === id),
		getAll: () => CATALOG,
		getAvailable: () => CATALOG,
		getProvider: (name: string) => (known.has(name) || host.providers.has(name) ? {} : undefined),
		getProviderAuthStatus: () => ({ configured: true }),
		isUsingOAuth: () => true,
		findOfType: (type: string, provider: string, id: string) => (type === "classifier" && provider === "local" && id === "judge" ? { type, provider, id, baseUrl: "http://127.0.0.1:1234/v1/" } : undefined),
		classify: async (model: { provider: string; id: string }, context: { state: unknown; questions: unknown }) => {
			classifierCalls.push({ model: `${model.provider}/${model.id}`, state: context.state, questions: context.questions });
			if (scenario === "fail") return { stopReason: "error", errorMessage: "connection refused", answers: undefined };
			return { stopReason: "stop", answers: answersFor(scenario), usage: { input: 120, output: 0, cost: { total: 0 } } };
		},
	};
	const ctx = {
		cwd: options.cwd ?? "/work/repo",
		hasUI: false,
		mode: "print",
		model: options.model ?? { provider: "switchboard", id: "auto" },
		thinkingLevel: "medium",
		modelRegistry: registry,
		sessionManager: {
			getSessionId: () => options.sessionId ?? "session-1",
			getSessionFile: () => options.sessionFile,
			getHeader: () => header,
			getBranch: () => host.entries.map((e) => ({ type: "custom", customType: e.customType, data: e.data })),
			getEntries: () => host.entries.map((e) => ({ type: "custom", customType: e.customType, data: e.data, timestamp: new Date().toISOString() })),
		},
		ui: {
			notify: (message: string, type?: string) => notices.push({ message, ...(type ? { type } : {}) }),
			setStatus: (key: string, text: string | undefined) => statuses.set(key, text),
			setWidget: () => undefined,
		},
		isProjectTrusted: () => true,
		isIdle: () => true,
	};
	return { ctx, statuses, notices, classifierCalls, setScenario: (next) => void (scenario = next), setHeader: (next) => void (header = next) };
}

/** A route request as pi builds it. */
export function routeRequest(over: { id?: string; reason?: string; text?: string; thinkingLevel?: string; previous?: unknown; failed?: unknown; state?: unknown; extraMessages?: unknown[]; system?: string } = {}) {
	return {
		model: { provider: "switchboard", id: over.id ?? "auto" },
		thinkingLevel: over.thinkingLevel ?? "medium",
		reason: over.reason ?? "user",
		messages: [
			...(over.system ? [{ role: "system", content: over.system }] : []),
			{ role: "user", content: over.text ?? "implement the pagination for the orders endpoint" },
			...(over.extraMessages ?? []),
		],
		...(over.previous ? { previous: over.previous } : {}),
		...(over.failed ? { failed: over.failed } : {}),
		...(over.state ? { state: over.state } : {}),
		signal: new AbortController().signal,
	};
}

export const fakeTheme = { fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t, bold: (t: string) => t };
