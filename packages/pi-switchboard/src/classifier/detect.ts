import { BUILTIN_QUESTIONS } from "./questions.ts";
import { systemOneClassify } from "./standalone.ts";

/**
 * Finds classifier servers on this machine: the local servers that answer System One requests, the
 * decision models each lists, and on a llama.cpp server the chat models pi's own `llama.cpp` provider can
 * read as classifiers. Only model lists are read, so no model is loaded except the one smoke-tested.
 */
export type ServerKind = "lmstudio" | "ollama" | "llamacpp";

export interface ServerProbe {
	kind: ServerKind;
	/** The provider name the config gives it. */
	name: string;
	/** Scheme, host and port. */
	origin: string;
}

/** Where each server listens by default. */
export const KNOWN_SERVERS: readonly ServerProbe[] = [
	{ kind: "lmstudio", name: "lmstudio", origin: "http://127.0.0.1:1234" },
	{ kind: "ollama", name: "ollama", origin: "http://127.0.0.1:11434" },
	{ kind: "llamacpp", name: "llamacpp", origin: "http://127.0.0.1:8080" },
];

export const SERVER_LABEL: Record<ServerKind, string> = { lmstudio: "LM Studio", ollama: "Ollama", llamacpp: "llama.cpp" };

/** Decision models in the order the measurements recommend them (docs/classifier-models.md), matched by name. */
const PREFERRED = ["h2o-lightning", "tev1", "lev", "nimble", "kev"];

export interface SmokeTest {
	model: string;
	ok: boolean;
	ms: number;
	error?: string;
}

export interface DetectedServer extends ServerProbe {
	/** The API root, the part before /systemone. */
	baseUrl: string;
	decisionModels: string[];
	/** Chat models a llama.cpp server lists; pi's `llama.cpp` provider can use them as classifiers. */
	chatModels: string[];
	/** Decision models a local server relays to a cloud (Ollama's `:cloud`); left out of the config. */
	cloudModels: string[];
	smoke?: SmokeTest;
}

export interface DetectOptions {
	servers?: readonly ServerProbe[];
	fetch?: typeof fetch;
	timeoutMs?: number;
	now?: () => number;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const text = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);

async function getJson(fetcher: typeof fetch, url: string, timeoutMs: number, body?: unknown): Promise<unknown> {
	const response = await fetcher(url, {
		method: body === undefined ? "GET" : "POST",
		headers: { "content-type": "application/json" },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
		signal: AbortSignal.timeout(timeoutMs),
	});
	if (!response.ok) throw new Error(`${url} returned ${response.status}`);
	return response.json();
}

type Listing = Pick<DetectedServer, "decisionModels" | "chatModels" | "cloudModels">;

/** LM Studio marks decision models with `type: "decision"` in its REST model list. */
async function listLmStudio(fetcher: typeof fetch, origin: string, timeoutMs: number): Promise<Listing> {
	const body = await getJson(fetcher, `${origin}/api/v0/models`, timeoutMs);
	const models = list(isRecord(body) ? body.data : undefined).filter(isRecord);
	return { decisionModels: models.filter((m) => m.type === "decision").flatMap((m) => text(m.id) ?? []), chatModels: [], cloudModels: [] };
}

/** Ollama lists decision models among its tags and names `decision` among each one's capabilities. */
async function listOllama(fetcher: typeof fetch, origin: string, timeoutMs: number): Promise<Listing> {
	const body = await getJson(fetcher, `${origin}/api/tags`, timeoutMs);
	const names = list(isRecord(body) ? body.models : undefined).flatMap((m) => (isRecord(m) ? (text(m.name) ?? []) : []));
	const decision: string[] = [];
	for (const name of names) {
		const shown = await getJson(fetcher, `${origin}/api/show`, timeoutMs, { model: name }).catch(() => undefined);
		if (list(isRecord(shown) ? shown.capabilities : undefined).includes("decision")) decision.push(name);
	}
	const cloud = (name: string) => /(?::|-)cloud$/u.test(name);
	return { decisionModels: decision.filter((name) => !cloud(name)), chatModels: [], cloudModels: decision.filter(cloud) };
}

/** llama.cpp marks decision models with `decisions` among `architecture.output_modalities`; the rest are chat models. */
async function listLlamaCpp(fetcher: typeof fetch, origin: string, timeoutMs: number): Promise<Listing> {
	const body = await getJson(fetcher, `${origin}/v1/models`, timeoutMs);
	const models = list(isRecord(body) ? body.data : undefined).filter(isRecord);
	const isDecision = (m: Record<string, unknown>) => list(isRecord(m.architecture) ? m.architecture.output_modalities : undefined).includes("decisions");
	return {
		decisionModels: models.filter(isDecision).flatMap((m) => text(m.id) ?? []),
		chatModels: models.filter((m) => !isDecision(m)).flatMap((m) => text(m.id) ?? []),
		cloudModels: [],
	};
}

const LISTERS: Record<ServerKind, (fetcher: typeof fetch, origin: string, timeoutMs: number) => Promise<Listing>> = {
	lmstudio: listLmStudio,
	ollama: listOllama,
	llamacpp: listLlamaCpp,
};

/** The decision model to suggest: the best measured one the server has, else its first. */
export function preferredModel(models: readonly string[]): string | undefined {
	for (const name of PREFERRED) {
		const found = models.find((model) => model.toLowerCase().includes(name));
		if (found) return found;
	}
	return models[0];
}

/** Probes each server, lists its models and smoke-tests the preferred decision model with pi-switchboard's three questions. */
export async function detectClassifiers(options: DetectOptions = {}): Promise<DetectedServer[]> {
	const { servers = KNOWN_SERVERS, fetch: fetcher = fetch, timeoutMs = 1500, now = Date.now } = options;
	const found = await Promise.all(
		servers.map(async (server): Promise<DetectedServer | undefined> => {
			const listing = await LISTERS[server.kind](fetcher, server.origin, timeoutMs).catch(() => undefined);
			return listing ? { ...server, baseUrl: `${server.origin}/v1`, ...listing } : undefined;
		}),
	);
	const detected = found.filter((server): server is DetectedServer => server !== undefined);
	for (const server of detected) {
		const model = preferredModel(server.decisionModels);
		if (!model) continue;
		const classify = systemOneClassify([{ name: server.name, baseUrl: server.baseUrl }], fetcher);
		const started = now();
		// The first request may load the model, so it gets longer than a routed decision would.
		const response = await classify(
			`${server.name}/${model}`,
			{ state: { request: "rename the variable foo to bar in utils.ts" }, questions: BUILTIN_QUESTIONS },
			{ signal: AbortSignal.timeout(60_000) },
		);
		const ok = response.stopReason === "stop" && response.answers !== undefined;
		server.smoke = { model, ok, ms: now() - started, ...(ok ? {} : { error: response.errorMessage ?? response.stopReason }) };
	}
	return detected;
}

/** The config entries for a server's decision models, with the preferred one as the classifier. */
export function configFor(server: DetectedServer): { classifierProviders: unknown[]; classifiers: unknown[] } | undefined {
	const model = server.smoke?.ok ? server.smoke.model : preferredModel(server.decisionModels);
	if (!model) return undefined;
	return {
		classifierProviders: [{ name: server.name, baseUrl: `${server.baseUrl}/`, models: server.decisionModels }],
		classifiers: [{ model: `${server.name}/${model}`, timeoutMs: 2000, threshold: 0.8 }],
	};
}

/** The report of `pi-switchboard classifier detect`: what each server offers, and what to paste or run next. */
export function formatDetect(detected: readonly DetectedServer[], probed: readonly ServerProbe[] = KNOWN_SERVERS): string {
	const lines: string[] = [];
	for (const server of detected) {
		lines.push(`${SERVER_LABEL[server.kind]} at ${server.origin}`);
		lines.push(`  decision models: ${server.decisionModels.join(", ") || "none"}`);
		if (server.cloudModels.length > 0)
			lines.push(`  relayed to a cloud, left out: ${server.cloudModels.join(", ")} (remote; see docs/classifier-cloud.md)`);
		if (server.smoke)
			lines.push(
				server.smoke.ok
					? `  ✓ ${server.smoke.model} answered pi-switchboard's three questions in ${server.smoke.ms} ms`
					: `  ✗ ${server.smoke.model} did not answer: ${server.smoke.error}`,
			);
		const config = configFor(server);
		if (config) {
			const [classifier] = config.classifiers as Array<{ model: string }>;
			lines.push("  add to ~/.pi/agent/pi-switchboard.json:");
			for (const line of JSON.stringify(config, null, 2).split("\n").slice(1, -1)) lines.push(`  ${line}`);
			lines.push(`  then choose its threshold: pi-switchboard classifier eval ${server.baseUrl} ${classifier?.model.slice(server.name.length + 1)}`);
		}
		if (server.chatModels.length > 0) {
			lines.push(`  chat models pi's llama.cpp provider can read as classifiers: ${server.chatModels.join(", ")}`);
			lines.push(
				`  to use one: export LLAMA_BASE_URL=${server.origin} (or /login llama.cpp in pi), add a classifier "llama.cpp/<model>", set classification.temperature to 2, and test it with /tier eval`,
			);
		}
		if (!config && server.chatModels.length === 0) lines.push("  no models to use yet; see docs/classifier-setup.md for one to download");
		lines.push("");
	}
	const missing = probed.filter((probe) => !detected.some((server) => server.origin === probe.origin));
	if (missing.length > 0) lines.push(`not running: ${missing.map((probe) => `${SERVER_LABEL[probe.kind]} (${probe.origin})`).join(", ")}`);
	if (detected.length === 0)
		lines.push(
			"No classifier server found. Start LM Studio, Ollama or llama-server, or set one up with: pi-switchboard classifier setup <lmstudio|ollama|llamacpp>",
		);
	return lines.join("\n");
}
