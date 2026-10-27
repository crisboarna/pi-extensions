import { detectClassifiers, formatDetect, KNOWN_SERVERS, SERVER_LABEL, type ServerKind } from "../classifier/detect.ts";
import { evaluateClassifier, formatEval } from "../classifier/eval.ts";
import { systemOneClassify } from "../classifier/standalone.ts";

export const CLASSIFIER_USAGE = `pi-switchboard classifier <command>

  detect [--json] ${KNOWN_SERVERS.map((server) => `[--${server.kind} URL]`).join(" ")}
      Look for ${KNOWN_SERVERS.map((server) => SERVER_LABEL[server.kind]).join(", ")} on their usual ports (or the URLs
      given), list the decision models each serves, test one, and print the config to paste.

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
	const servers = KNOWN_SERVERS.map((server) => {
		const origin = option(args, `--${server.kind}`);
		return origin ? { ...server, origin: origin.replace(/\/+$/u, "").replace(/\/v1$/u, "") } : server;
	});
	const unknown = args.filter(
		(arg) => arg.startsWith("--") && arg !== "--json" && !KNOWN_SERVERS.some((server) => arg === `--${server.kind satisfies ServerKind}`),
	);
	if (unknown.length > 0) {
		io.err(`classifier detect: unknown option ${unknown.join(", ")}\n${CLASSIFIER_USAGE}`);
		return 1;
	}
	const detected = await detectClassifiers({ servers });
	io.out(args.includes("--json") ? `${JSON.stringify(detected, null, 2)}\n` : `${formatDetect(detected, servers)}\n`);
	return detected.length > 0 ? 0 : 1;
}

/** `pi-switchboard classifier ...`; returns the exit code. */
export async function classifierCommand(args: string[], io: CliIo): Promise<number> {
	const [command, ...rest] = args;
	if (command === "eval") return evalCommand(rest, io);
	if (command === "detect") return detectCommand(rest, io);
	(command ? io.err : io.out)(CLASSIFIER_USAGE);
	return command ? 1 : 0;
}
