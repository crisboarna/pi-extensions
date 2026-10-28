import { configFor, type DetectedServer, type ServerProbe, type SmokeTest } from "./detect.ts";
import type { EvalReport } from "./eval.ts";
import { type SetupSpec, serverCatalog } from "./servers.ts";

/**
 * `pi-switchboard classifier setup <name>`: gets one classifier server ready with the product's own
 * tools, then writes the config. It never installs the product: it finds its command, shows the
 * commands it will run and asks first, starts or waits for the server, smoke-tests the model, chooses
 * a threshold with eval, and merges the classifier into pi-switchboard.json after showing the change.
 */
export interface SetupDeps {
	/** The command's path, or `undefined` when it is not installed. */
	which(command: string): string | undefined;
	/** Runs a command with the terminal attached; resolves to its exit code. */
	run(command: string, args: string[]): Promise<number>;
	confirm(question: string): Promise<boolean>;
	out(text: string): void;
	err(text: string): void;
	/** The server's model lists, without asking any model anything; `undefined` while it does not answer. */
	probe(server: ServerProbe): Promise<DetectedServer | undefined>;
	smoke(server: DetectedServer, model: string): Promise<SmokeTest>;
	/** Asks a router to load a model; resolves to an error message, or `undefined` when it loaded. */
	load(server: DetectedServer, model: string): Promise<string | undefined>;
	evaluate(server: DetectedServer, model: string): Promise<EvalReport>;
	configPath: string;
	readConfig(): string | undefined;
	writeConfig(text: string): void;
	sleep(ms: number): Promise<void>;
}

export interface SetupOptions {
	/** Run the commands and write the config without asking. */
	yes?: boolean;
	/** Choose the threshold with eval (a warm-up and 24 labelled requests); otherwise 0.8. */
	evaluate?: boolean;
	/** How long to wait for a server the user starts, in milliseconds. */
	waitMs?: number;
}

const DEFAULT_TIMEOUT_MS = 2000;
/** pi-switchboard's default budget for one decision (classification.decisionBudgetMs). */
const DECISION_BUDGET_MS = 4000;

/** A classifier's timeout from its measured median: twice it, rounded up to half a second, at least the default. */
export function timeoutFor(medianMs: number): number {
	return Math.max(DEFAULT_TIMEOUT_MS, Math.ceil((medianMs * 2) / 500) * 500);
}

const quote = (word: string) => (/^[\w./:@=+-]+$/u.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`);
export const commandLine = (words: readonly string[]) => words.map(quote).join(" ");

interface ConfigPatch {
	classifierProviders?: Array<{ name: string }>;
	classifiers: Array<{ model: string }>;
	classification?: Record<string, unknown>;
}

/**
 * The config with the classifier added: its provider replaces one of the same name, the classifier goes
 * first (an older entry for the same model is dropped), and `classification` settings are merged.
 */
export function mergeClassifierConfig(existing: Record<string, unknown>, patch: ConfigPatch): Record<string, unknown> {
	const next: Record<string, unknown> = { ...existing };
	if (patch.classifierProviders) {
		const providers = Array.isArray(existing.classifierProviders) ? (existing.classifierProviders as Array<{ name?: string }>) : [];
		const names = new Set(patch.classifierProviders.map((provider) => provider.name));
		next.classifierProviders = [...providers.filter((provider) => !names.has(provider.name ?? "")), ...patch.classifierProviders];
	}
	const classifiers = Array.isArray(existing.classifiers) ? (existing.classifiers as Array<{ model?: string }>) : [];
	const models = new Set(patch.classifiers.map((classifier) => classifier.model));
	next.classifiers = [...patch.classifiers, ...classifiers.filter((classifier) => !models.has(classifier.model ?? ""))];
	if (patch.classification) {
		const classification = typeof existing.classification === "object" && existing.classification !== null ? existing.classification : {};
		next.classification = { ...classification, ...patch.classification };
	}
	return next;
}

function serverFor(spec: SetupSpec, name: string): ServerProbe | undefined {
	return serverCatalog().servers.find((server) => server.kind === (spec.server ?? name));
}

/** The id a server lists for a model: the name itself, or the name with a `:latest` tag. */
export function listedAs(models: readonly string[], wanted: string): string | undefined {
	return models.find((model) => model === wanted || model === `${wanted}:latest`);
}

/** Polls the server until it lists the model or the wait runs out; resolves to the server and the model's listed id. */
async function waitForModel(
	server: ServerProbe,
	spec: SetupSpec,
	deps: SetupDeps,
	waitMs: number,
): Promise<{ found: DetectedServer; model: string } | undefined> {
	const step = 2000;
	for (let waited = 0; waited <= waitMs; waited += step) {
		const found = await deps.probe(server);
		const model = found ? listedAs([...found.decisionModels, ...found.chatModels], spec.model) : undefined;
		if (found && model) return { found, model };
		await deps.sleep(step);
	}
	return undefined;
}

/** Whether the server can answer with the model now: loaded, or listed when its list does not say what is loaded. */
function serves(found: DetectedServer, model: string): boolean {
	return listedAs(found.loaded ?? [...found.decisionModels, ...found.chatModels], model) !== undefined;
}

/** Polls until the server answers or the wait runs out. */
async function waitForServer(server: ServerProbe, deps: SetupDeps, waitMs: number): Promise<boolean> {
	const step = 2000;
	for (let waited = 0; waited <= waitMs; waited += step) {
		if (await deps.probe(server)) return true;
		await deps.sleep(step);
	}
	return false;
}

/** Shows the setup's commands, asks once, and runs them in order; false when declined or one fails. */
async function runCommands(run: readonly string[][], intro: string, options: SetupOptions, deps: SetupDeps): Promise<boolean> {
	if (run.length === 0) return true;
	deps.out(`${intro}\n${run.map((words) => `  $ ${commandLine(words)}`).join("\n")}\n`);
	if (!options.yes && !(await deps.confirm("Run them?"))) {
		deps.out("Nothing was run, and the config is unchanged.\n");
		return false;
	}
	for (const [command = "", ...args] of run) {
		const code = await deps.run(command, args);
		if (code !== 0) {
			deps.err(`classifier setup: \`${commandLine([command, ...args])}\` exited with ${code}\n`);
			return false;
		}
	}
	return true;
}

/** A chat model pi reads through its own provider: a classifier entry and a softer temperature, no provider entry. */
function chatPatch(found: DetectedServer, model: string, deps: SetupDeps): ConfigPatch {
	deps.out(`${model} is a chat model; pi reads it through its ${found.chatProvider} provider, which needs the server's address:\n`);
	const hint = (found.chatHint ?? "").replaceAll("{models}", model).replaceAll("{origin}", found.origin);
	deps.out(`  ${hint.split("\n").slice(1).join("\n  ")}\n`);
	return {
		classifiers: [{ model: `${found.chatProvider}/${model}`, timeoutMs: 3000, threshold: 0.8 } as { model: string }],
		classification: { temperature: 2 },
	};
}

/** A decision model: smoke-tested, its threshold chosen with eval, and its server added as a classifier provider. */
async function decisionPatch(found: DetectedServer, model: string, options: SetupOptions, deps: SetupDeps): Promise<ConfigPatch | undefined> {
	const smoke = await deps.smoke(found, model);
	if (!smoke.ok) {
		deps.err(`classifier setup: ${model} did not answer: ${smoke.error}\n`);
		return undefined;
	}
	deps.out(`✓ ${model} answered pi-switchboard's three questions in ${smoke.ms} ms\n`);
	let threshold = 0.8;
	let timeoutMs = DEFAULT_TIMEOUT_MS;
	if (options.evaluate !== false) {
		deps.out("Choosing its threshold on 24 labelled requests…\n");
		const report = await deps.evaluate(found, model);
		threshold = report.best.threshold;
		timeoutMs = timeoutFor(report.medianMs);
		deps.out(
			`  ${report.best.correct}/24 route as labelled at threshold ${threshold}, ${report.best.under} too low; median ${Math.round(report.medianMs)} ms\n`,
		);
		if (timeoutMs > DECISION_BUDGET_MS)
			deps.out(
				`  ! it answers more slowly than pi-switchboard's ${DECISION_BUDGET_MS / 1000} s budget for one decision (classification.decisionBudgetMs), so most requests would use the fallback tier; a smaller model or a GPU helps\n`,
			);
	}
	const config = configFor(found, model, threshold);
	if (!config) return undefined;
	for (const classifier of config.classifiers) classifier.timeoutMs = timeoutMs;
	return config as ConfigPatch;
}

interface Resolved {
	spec: SetupSpec;
	server: ServerProbe;
	/** The setup's command words with `{bin}` replaced by the command found. */
	fill(words: readonly string[]): string[];
}

/** The setup, its server and its command, after checking the product is installed and the config is readable. */
function resolveSetup(name: string | undefined, deps: SetupDeps): Resolved | undefined {
	const catalog = serverCatalog();
	const spec = name ? catalog.setups[name] : undefined;
	const server = spec && name ? serverFor(spec, name) : undefined;
	if (!spec || !server) {
		deps.err(`classifier setup: name one of ${Object.keys(catalog.setups).join(", ")}\n`);
		return undefined;
	}
	const bin = spec.commands.map((command) => deps.which(command)).find((path) => path !== undefined);
	if (!bin) {
		deps.err(`${spec.commands[0]} was not found. ${spec.install}\n`);
		return undefined;
	}
	if (readExisting(deps) === undefined) {
		deps.err(`${deps.configPath} is not valid JSON: fix it or move it aside, then run setup again.\n`);
		return undefined;
	}
	return { spec, server, fill: (words) => words.map((word) => (word === "{bin}" ? bin : word)) };
}

/** Runs the setup's commands, waiting for the server first when they need it, and prints the commands the user runs; false to stop. */
async function startServer({ spec, server, fill }: Resolved, options: SetupOptions, deps: SetupDeps, waitMs: number): Promise<boolean> {
	if (spec.needsServer && !(await deps.probe(server))) {
		deps.out(`${server.label} is not answering at ${server.origin}. ${spec.serverHint ?? "Start it."}\nWaiting for it…\n`);
		if (!(await waitForServer(server, deps, waitMs))) {
			deps.err(`classifier setup: ${server.label} is not answering at ${server.origin} after ${Math.round(waitMs / 60_000)} minutes\n`);
			return false;
		}
	}
	// Running them again would download nothing new, and LM Studio would load a second copy of the model.
	const found = spec.run?.length ? await deps.probe(server) : undefined;
	if (found && serves(found, spec.model)) deps.out(`${server.label} already serves ${spec.model}, so nothing is downloaded or loaded.\n`);
	else if (!(await runCommands((spec.run ?? []).map(fill), `To set up ${server.label} with ${spec.model}, these commands run:`, options, deps))) return false;
	if (spec.prepare)
		deps.out(`First download the model, in another terminal; stop it with Ctrl+C once it says it is listening:\n  $ ${commandLine(fill(spec.prepare))}\n`);
	if (spec.serve)
		deps.out(
			`${spec.prepare ? "Then start" : "Start"} the server in another terminal and leave it running${spec.prepare ? "" : " (the first start downloads the model)"}:\n  $ ${commandLine(fill(spec.serve))}\n`,
		);
	else if (!(await deps.probe(server))) deps.out(`${server.label} is not answering at ${server.origin}. ${spec.serverHint ?? "Start it."}\n`);
	return true;
}

/** Waits for the server to list the model, and loads it when the setup asks; `undefined` to stop. */
async function readyModel({ spec, server }: Resolved, deps: SetupDeps, waitMs: number): Promise<{ found: DetectedServer; model: string } | undefined> {
	deps.out(`Waiting for ${server.label} at ${server.origin} to list ${spec.model}…\n`);
	const ready = await waitForModel(server, spec, deps, waitMs);
	if (!ready) {
		deps.err(`classifier setup: ${server.label} at ${server.origin} did not list ${spec.model} within ${Math.round(waitMs / 60_000)} minutes\n`);
		return undefined;
	}
	if (spec.load) {
		const error = await deps.load(ready.found, ready.model);
		if (error) {
			deps.err(`classifier setup: ${server.label} could not load ${ready.model}: ${error}\n`);
			return undefined;
		}
		deps.out(`Loaded ${ready.model}.\n`);
	}
	return ready;
}

/** Runs the setup; resolves to the exit code. */
export async function runSetup(name: string | undefined, options: SetupOptions, deps: SetupDeps): Promise<number> {
	const resolved = resolveSetup(name, deps);
	if (!resolved) return 1;
	const waitMs = options.waitMs ?? 20 * 60_000;
	if (!(await startServer(resolved, options, deps, waitMs))) return 1;
	const ready = await readyModel(resolved, deps, waitMs);
	if (!ready) return 1;
	const patch = resolved.spec.chat ? chatPatch(ready.found, ready.model, deps) : await decisionPatch(ready.found, ready.model, options, deps);
	return patch ? writeConfig(patch, options, deps) : 1;
}

/** The config as it is now: `{}` when there is none, `undefined` when it is not valid JSON. */
function readExisting(deps: SetupDeps): Record<string, unknown> | undefined {
	const text = deps.readConfig();
	try {
		return text === undefined ? {} : (JSON.parse(text) as Record<string, unknown>);
	} catch {
		return undefined;
	}
}

async function writeConfig(patch: ConfigPatch, options: SetupOptions, deps: SetupDeps): Promise<number> {
	const text = deps.readConfig();
	const existing = readExisting(deps);
	if (existing === undefined) {
		deps.err(`${deps.configPath} is not valid JSON, so it is left alone. Add this yourself:\n${JSON.stringify(patch, null, "\t")}\n`);
		return 1;
	}
	const next = mergeClassifierConfig(existing, patch);
	const changed = (Object.keys(patch) as Array<keyof ConfigPatch>).map(
		(key) => `"${key}": ${JSON.stringify(next[key], null, "\t").replaceAll("\n", "\n  ")}`,
	);
	deps.out(`${text === undefined ? "Creating" : "Changing"} ${deps.configPath}:\n  ${changed.join("\n  ")}\n`);
	if (!options.yes && !(await deps.confirm("Write it?"))) {
		deps.out("The config is unchanged.\n");
		return 1;
	}
	deps.writeConfig(`${JSON.stringify(next, null, "\t")}\n`);
	deps.out("Done. In pi, run /reload, then /tier doctor.\n");
	return 0;
}
