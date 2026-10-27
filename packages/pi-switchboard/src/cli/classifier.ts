import { spawn } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { detectClassifiers, formatDetect, knownServers, smokeTest } from "../classifier/detect.ts";
import { evaluateClassifier, formatEval } from "../classifier/eval.ts";
import { serverCatalog } from "../classifier/servers.ts";
import { runSetup } from "../classifier/setup.ts";
import { systemOneClassify } from "../classifier/standalone.ts";
import { userConfigPath } from "../config/load.ts";

export const CLASSIFIER_USAGE = `pi-switchboard classifier <command>

  detect [--json] ${knownServers()
		.map((server) => `[--${server.kind} URL]`)
		.join(" ")}
      Look for ${knownServers()
			.map((server) => server.label)
			.join(", ")} on their usual ports (or the URLs given), list the decision models
      each serves, test one, and print the config to paste.

  setup <${Object.keys(serverCatalog().setups).join("|")}> [--yes] [--no-eval]
      Get a classifier server ready with the product's own commands (it never installs the
      product): shows and runs them after asking, waits for the server, tests the model,
      chooses its threshold and adds it to ~/.pi/agent/pi-switchboard.json after showing the change.

  eval <baseUrl> <model> [--api-key-env NAME] [--threshold 0.8] [--json]
      Ask a System One classifier about 24 labelled requests and report how many route to the
      expected tier, how many too low, and its latency. <baseUrl> is the server's API root, the
      part before /systemone, for example http://127.0.0.1:1234/v1 (LM Studio).
`;

export interface CliIo {
	out(text: string): void;
	err(text: string): void;
	env: Record<string, string | undefined>;
}

function option(args: string[], name: string): string | undefined {
	const index = args.indexOf(name);
	return index >= 0 ? args[index + 1] : undefined;
}

/** The positional arguments: everything that is not an option or an option's value. */
function positionals(args: string[], valued: string[]): string[] {
	return args.filter((arg, index) => !arg.startsWith("--") && !valued.includes(args[index - 1] ?? ""));
}

async function evalCommand(args: string[], io: CliIo): Promise<number> {
	const [baseUrl, model] = positionals(args, ["--api-key-env", "--threshold"]);
	if (!baseUrl || !model) {
		io.err(CLASSIFIER_USAGE);
		return 1;
	}
	const keyName = option(args, "--api-key-env");
	const apiKey = keyName ? io.env[keyName] : undefined;
	if (keyName && !apiKey) {
		io.err(`classifier eval: ${keyName} is not set\n`);
		return 1;
	}
	const thresholdText = option(args, "--threshold");
	const threshold = thresholdText === undefined ? 0.8 : Number(thresholdText);
	if (!(threshold >= 0 && threshold <= 1)) {
		io.err("classifier eval: --threshold must be a number from 0 to 1\n");
		return 1;
	}
	const classify = systemOneClassify([{ name: "eval", baseUrl, ...(apiKey ? { apiKey } : {}) }]);
	const report = await evaluateClassifier(classify, `eval/${model}`, { threshold });
	const named = { ...report, model };
	io.out(args.includes("--json") ? `${JSON.stringify(named, null, 2)}\n` : `${formatEval(named)}\n`);
	// Every request unanswered means the server or model is wrong, not the model's judgement.
	return report.failed === report.results.length ? 1 : 0;
}

async function detectCommand(args: string[], io: CliIo): Promise<number> {
	const known = knownServers();
	const servers = known.map((server) => {
		const origin = option(args, `--${server.kind}`);
		return origin ? { ...server, origin: origin.replace(/\/+$/u, "").replace(/\/v1$/u, "") } : server;
	});
	const unknown = args.filter((arg) => arg.startsWith("--") && arg !== "--json" && !known.some((server) => arg === `--${server.kind}`));
	if (unknown.length > 0) {
		io.err(`classifier detect: unknown option ${unknown.join(", ")}\n${CLASSIFIER_USAGE}`);
		return 1;
	}
	const detected = await detectClassifiers({ servers });
	io.out(args.includes("--json") ? `${JSON.stringify(detected, null, 2)}\n` : `${formatDetect(detected, servers)}\n`);
	return detected.length > 0 ? 0 : 1;
}

/** A command on the PATH, or a `~` path; `undefined` when it is not there or not executable. */
export function which(command: string, env: Record<string, string | undefined> = process.env): string | undefined {
	const executable = (path: string) => {
		try {
			accessSync(path, constants.X_OK);
			return true;
		} catch {
			return false;
		}
	};
	if (command.startsWith("~/")) {
		const path = join(env.HOME ?? homedir(), command.slice(2));
		return executable(path) ? path : undefined;
	}
	return (env.PATH ?? "")
		.split(delimiter)
		.filter(Boolean)
		.map((dir) => join(dir, command))
		.find(executable);
}

async function setupCommand(args: string[], io: CliIo): Promise<number> {
	const name = args.find((arg) => !arg.startsWith("--"));
	const yes = args.includes("--yes");
	const interactive = process.stdin.isTTY === true;
	if (!yes && !interactive) {
		io.err("classifier setup: asks before running anything; without a terminal, add --yes\n");
		return 1;
	}
	const agentDir = io.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	const configPath = userConfigPath(agentDir, io.env as NodeJS.ProcessEnv);
	const ask = async (question: string) => {
		const prompt = createInterface({ input: process.stdin, output: process.stdout });
		try {
			return /^y(es)?$/iu.test((await prompt.question(`${question} [y/N] `)).trim());
		} finally {
			prompt.close();
		}
	};
	return runSetup(
		name,
		{ yes, evaluate: !args.includes("--no-eval") },
		{
			which: (command) => which(command, io.env),
			run: (command, commandArgs) =>
				new Promise((resolve) => {
					const child = spawn(command, commandArgs, { stdio: "inherit" });
					child.on("error", () => resolve(127));
					child.on("exit", (code) => resolve(code ?? 1));
				}),
			confirm: ask,
			out: io.out,
			err: io.err,
			probe: async (server) => (await detectClassifiers({ servers: [server] }).then((found) => found[0])) ?? undefined,
			smoke: (server, model) => smokeTest(server, model),
			load: async (server, model) => {
				const response = await fetch(`${server.origin}/models/load`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ model }),
					signal: AbortSignal.timeout(600_000),
				}).catch((error: Error) => error);
				if (response instanceof Error) return response.message;
				return response.ok ? undefined : `${response.status} ${(await response.text()).slice(0, 200)}`;
			},
			evaluate: (server, model) => evaluateClassifier(systemOneClassify([{ name: server.name, baseUrl: server.baseUrl }]), `${server.name}/${model}`),
			configPath,
			readConfig: () => (existsSync(configPath) ? readFileSync(configPath, "utf8") : undefined),
			writeConfig: (text) => {
				mkdirSync(dirname(configPath), { recursive: true });
				const temporary = `${configPath}.${process.pid}.tmp`;
				writeFileSync(temporary, text);
				renameSync(temporary, configPath);
			},
			sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
		},
	);
}

/** `pi-switchboard classifier ...`; returns the exit code. */
export async function classifierCommand(args: string[], io: CliIo): Promise<number> {
	const [command, ...rest] = args;
	if (command === "eval") return evalCommand(rest, io);
	if (command === "detect") return detectCommand(rest, io);
	if (command === "setup") return setupCommand(rest, io);
	(command ? io.err : io.out)(CLASSIFIER_USAGE);
	return command ? 1 : 0;
}
