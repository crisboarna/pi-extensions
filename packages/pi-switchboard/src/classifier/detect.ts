import { BUILTIN_QUESTIONS } from "./questions.ts";
import { type Listing, type ServerSpec, serverCatalog } from "./servers.ts";
import { systemOneClassify } from "./standalone.ts";

/**
 * Finds classifier servers on this machine: the local servers that answer System One requests, the
 * decision models each lists, and the chat models a server lists that a pi provider can read as
 * classifiers. Only model lists are read, so no model is loaded except the one smoke-tested. Which
 * servers to probe and how each lists its models come from the server catalog (servers.ts).
 */
export type ServerProbe = Pick<ServerSpec, "kind" | "label" | "name" | "origin" | "listing" | "chatHint" | "chatProvider">;

/** Where each catalogued server listens by default. */
export const knownServers = (): ServerProbe[] => serverCatalog().servers;

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
	/** Chat models the server lists, when a pi provider can read them as classifiers (`chatProvider`). */
	chatModels: string[];
	/** Decision models a local server relays to a cloud; left out of the config. */
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
/** Ids such as `clef:cloud` or `gpt-oss:120b-cloud`: a local server relays them to a cloud. */
const RELAYED = /(?::|-)cloud$/u;

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

type ModelLists = Pick<DetectedServer, "decisionModels" | "chatModels" | "cloudModels">;

/** A REST model list that marks decision models with `type: "decision"`. */
async function listByTypeField(fetcher: typeof fetch, origin: string, timeoutMs: number): Promise<ModelLists> {
	const body = await getJson(fetcher, `${origin}/api/v0/models`, timeoutMs);
	const models = list(isRecord(body) ? body.data : undefined).filter(isRecord);
	return { decisionModels: models.filter((m) => m.type === "decision").flatMap((m) => text(m.id) ?? []), chatModels: [], cloudModels: [] };
}

/** Models listed as tags, each naming `decision` among its capabilities. */
async function listByShowCapabilities(fetcher: typeof fetch, origin: string, timeoutMs: number): Promise<ModelLists> {
	const body = await getJson(fetcher, `${origin}/api/tags`, timeoutMs);
	const names = list(isRecord(body) ? body.models : undefined).flatMap((m) => (isRecord(m) ? (text(m.name) ?? []) : []));
	const decision: string[] = [];
	for (const name of names) {
		const shown = await getJson(fetcher, `${origin}/api/show`, timeoutMs, { model: name }).catch(() => undefined);
		if (list(isRecord(shown) ? shown.capabilities : undefined).includes("decision")) decision.push(name);
	}
	return { decisionModels: decision.filter((name) => !RELAYED.test(name)), chatModels: [], cloudModels: decision.filter((name) => RELAYED.test(name)) };
}

/** An OpenAI-style model list that marks decision models with `decisions` among `architecture.output_modalities`. */
async function listByOutputModalities(fetcher: typeof fetch, origin: string, timeoutMs: number): Promise<ModelLists> {
	const body = await getJson(fetcher, `${origin}/v1/models`, timeoutMs);
	const models = list(isRecord(body) ? body.data : undefined).filter(isRecord);
	const isDecision = (m: Record<string, unknown>) => list(isRecord(m.architecture) ? m.architecture.output_modalities : undefined).includes("decisions");
	return {
		decisionModels: models.filter(isDecision).flatMap((m) => text(m.id) ?? []),
		chatModels: models.filter((m) => !isDecision(m)).flatMap((m) => text(m.id) ?? []),
		cloudModels: [],
	};
}

const LISTERS: Record<Listing, (fetcher: typeof fetch, origin: string, timeoutMs: number) => Promise<ModelLists>> = {
	"type-field": listByTypeField,
	"show-capabilities": listByShowCapabilities,
	"output-modalities": listByOutputModalities,
};

/** The decision model to suggest: the best measured one the server has, else its first. */
export function preferredModel(models: readonly string[], preferred: readonly string[] = serverCatalog().preferred): string | undefined {
	for (const name of preferred) {
		const found = models.find((model) => model.toLowerCase().includes(name));
		if (found) return found;
	}
	return models[0];
}

/** Probes each server, lists its models and smoke-tests the preferred decision model with pi-switchboard's three questions. */
export async function detectClassifiers(options: DetectOptions = {}): Promise<DetectedServer[]> {
	const { servers = knownServers(), fetch: fetcher = fetch, timeoutMs = 1500, now = Date.now } = options;
	const found = await Promise.all(
		servers.map(async (server): Promise<DetectedServer | undefined> => {
			const lists = await LISTERS[server.listing](fetcher, server.origin, timeoutMs).catch(() => undefined);
			if (!lists) return undefined;
			return { ...server, baseUrl: `${server.origin}/v1`, ...lists, chatModels: server.chatProvider ? lists.chatModels : [] };
		}),
	);
	const detected = found.filter((server): server is DetectedServer => server !== undefined);
	for (const server of detected) {
		const model = preferredModel(server.decisionModels);
		if (!model) continue;
		server.smoke = await smokeTest(server, model, fetcher, now);
	}
	return detected;
}

/** Asks a decision model pi-switchboard's three questions once; the first request may load it, so it may take a while. */
export async function smokeTest(
	server: Pick<DetectedServer, "name" | "baseUrl">,
	model: string,
	fetcher: typeof fetch = fetch,
	now = Date.now,
): Promise<SmokeTest> {
	const classify = systemOneClassify([{ name: server.name, baseUrl: server.baseUrl }], fetcher);
	const started = now();
	const response = await classify(
		`${server.name}/${model}`,
		{ state: { request: "rename the variable foo to bar in utils.ts" }, questions: BUILTIN_QUESTIONS },
		{ signal: AbortSignal.timeout(120_000) },
	);
	const ok = response.stopReason === "stop" && response.answers !== undefined;
	return { model, ok, ms: now() - started, ...(ok ? {} : { error: response.errorMessage ?? response.stopReason }) };
}

/** The config entries for a server's decision models, with the preferred one (or `model`) as the classifier. */
export function configFor(
	server: Pick<DetectedServer, "name" | "baseUrl" | "decisionModels" | "smoke">,
	model?: string,
	threshold = 0.8,
): { classifierProviders: unknown[]; classifiers: Array<{ model: string; timeoutMs: number; threshold: number }> } | undefined {
	const chosen = model ?? (server.smoke?.ok ? server.smoke.model : preferredModel(server.decisionModels));
	if (!chosen) return undefined;
	return {
		classifierProviders: [{ name: server.name, baseUrl: `${server.baseUrl}/`, models: server.decisionModels }],
		classifiers: [{ model: `${server.name}/${chosen}`, timeoutMs: 2000, threshold }],
	};
}

/** The report of `pi-switchboard classifier detect`: what each server offers, and what to paste or run next. */
export function formatDetect(detected: readonly DetectedServer[], probed: readonly ServerProbe[] = knownServers()): string {
	const lines: string[] = [];
	for (const server of detected) {
		lines.push(`${server.label} at ${server.origin}`);
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
			const [classifier] = config.classifiers;
			lines.push("  add to ~/.pi/agent/pi-switchboard.json:");
			for (const line of JSON.stringify(config, null, 2).split("\n").slice(1, -1)) lines.push(`  ${line}`);
			lines.push(`  then choose its threshold: pi-switchboard classifier eval ${server.baseUrl} ${classifier?.model.slice(server.name.length + 1)}`);
		}
		if (server.chatModels.length > 0 && server.chatHint) {
			const hint = server.chatHint.replaceAll("{models}", server.chatModels.join(", ")).replaceAll("{origin}", server.origin);
			for (const line of hint.split("\n")) lines.push(`  ${line}`);
		}
		if (!config && server.chatModels.length === 0) lines.push("  no models to use yet; see docs/classifier-setup.md for one to download");
		lines.push("");
	}
	const missing = probed.filter((probe) => !detected.some((server) => server.origin === probe.origin));
	if (missing.length > 0) lines.push(`not running: ${missing.map((probe) => `${probe.label} (${probe.origin})`).join(", ")}`);
	if (detected.length === 0)
		lines.push(
			`No classifier server found. Start ${probed.map((probe) => probe.label).join(", ")}, or set one up with: pi-switchboard classifier setup <${Object.keys(serverCatalog().setups).join("|")}>`,
		);
	return lines.join("\n");
}
