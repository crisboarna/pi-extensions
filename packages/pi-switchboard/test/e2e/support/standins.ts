// The stand-ins together, for suites that send real prompts: a run folder with
// pi-switchboard installed from its tarball and the stand-in chat provider
// beside it, one stand-in classifier, and a fresh pi session per test on
// `switchboard/auto`. A test gets its own session because a decision carries
// over to the next (hysteresis, cooldowns, the previous member).
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Installed, installTarball } from "./install.ts";
import { PiSession } from "./pi-rpc.ts";
import { isolatedEnv, type Run, startRun } from "./run.ts";
import { StandinClassifier } from "./standin-classifier.ts";
import { type Request, readRequests, type Script, STANDIN_EXTENSION, writeScript } from "./standin-provider.ts";

export interface Standins {
	runDir: Run;
	installed: Installed;
	classifier: StandinClassifier;
	/** Starts pi with `config` and the stand-in provider scripted by `script`, on `model` (default `switchboard/auto`). */
	open(label: string, config: Record<string, unknown>, options?: OpenOptions): Promise<Opened>;
	close(): Promise<void>;
}

export interface OpenOptions {
	script?: Script;
	model?: [provider: string, id: string];
	env?: Record<string, string>;
}

export interface Opened {
	pi: PiSession;
	/** Rewrites the stand-in provider's script; raise `epoch` to restart each model's list. */
	script(script: Script): void;
	/** The requests the stand-in provider has served in this session. */
	requests(): Request[];
}

/** One profile, `work`, with three tiers of two members each, one per stand-in account, over the stand-in classifier. */
export function routingConfig(classifier: StandinClassifier, extra: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		classifierProviders: [{ name: "judge", baseUrl: classifier.baseUrl, models: ["s1"] }],
		classifiers: [{ model: "judge/s1", timeoutMs: 1500 }],
		classification: { threshold: 0.8, decisionBudgetMs: 3000 },
		profiles: {
			work: {
				strategy: "ordered",
				tiers: {
					light: { rank: 1, members: ["alpha/small", "beta/small"] },
					standard: { rank: 2, members: ["alpha/mid", "beta/mid"] },
					deep: { rank: 3, members: ["alpha/big", "beta/big"] },
				},
			},
		},
		profileSelection: { default: "work" },
		// Cooldowns and pointers stay in the session, so one test's never reach the next.
		state: { shared: false },
		...extra,
	};
}

/** Installs pi-switchboard and the stand-in provider into a fresh run folder for `suite`, and starts the stand-in classifier. */
export async function startStandins(suite: string): Promise<Standins> {
	const runDir = startRun(suite);
	// pi retries a rate limit itself, after retry.baseDelayMs; a short delay keeps the suites quick.
	const installed = await installTarball(runDir, { settings: { extensions: [STANDIN_EXTENSION], retry: { enabled: true, baseDelayMs: 50 } } });
	const classifier = await StandinClassifier.start();
	const sessions: PiSession[] = [];
	return {
		runDir,
		installed,
		classifier,
		async open(label, config, options = {}) {
			classifier.reset();
			const configPath = join(runDir.dir, `${label}.json`);
			const scriptPath = join(runDir.dir, `${label}.script.json`);
			const logPath = join(runDir.dir, `${label}.requests.jsonl`);
			writeFileSync(configPath, `${JSON.stringify(config, null, "\t")}\n`);
			writeScript(scriptPath, options.script ?? {});
			const pi = await PiSession.start({
				env: isolatedEnv(installed.home, {
					PI_CODING_AGENT_DIR: installed.agentDir,
					PI_SWITCHBOARD_CONFIG: configPath,
					STANDIN_SCRIPT: scriptPath,
					STANDIN_LOG: logPath,
					...options.env,
				}),
				cwd: installed.home,
				log: join(runDir.dir, `pi-${label}`),
			});
			sessions.push(pi);
			const [provider, id] = options.model ?? ["switchboard", "auto"];
			await pi.setModel(provider, id);
			return { pi, script: (script) => writeScript(scriptPath, script), requests: () => readRequests(logPath) };
		},
		async close() {
			for (const pi of sessions) await pi.close();
			await classifier.close();
		},
	};
}
