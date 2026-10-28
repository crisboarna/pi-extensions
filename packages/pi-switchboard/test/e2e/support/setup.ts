// Driving `classifier setup` the way a person does: running the commands it
// prints for another terminal, answering its prompts in a pseudo-terminal, and
// checking what it wrote.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PiSession } from "./pi-rpc.ts";
import { type Proc, type Result, run, start } from "./proc.ts";
import type { Run } from "./run.ts";

/** The commands setup prints for the user to run elsewhere: its `  $ <command>` lines, in order. */
export function printedCommands(output: string): string[] {
	return [...output.matchAll(/^ {2}\$ (.+)$/gmu)].map((match) => match[1] ?? "");
}

/** Waits until setup has printed `count` commands and returns them. */
export async function waitForPrinted(setup: Proc, count: number, timeoutMs = 120_000): Promise<string[]> {
	await setup.waitForOutput(new RegExp(`(?:^ {2}\\$ .+$[\\s\\S]*){${count}}`, "mu"), timeoutMs);
	return printedCommands(setup.output()).slice(0, count);
}

/** Runs one printed command line through sh, in the background, as a user pasting it into a terminal would. */
export function runPrinted(line: string, env: Record<string, string>, log: string): Proc {
	return start("sh", ["-c", line], { env, log });
}

/**
 * Runs `classifier setup <name>` in a pseudo-terminal under `expect`, answering
 * "Run them?" with `answers.run` and "Write it?" with `answers.write`. Its
 * output includes the prompts that were shown.
 */
export async function setupInTerminal(
	bin: string,
	name: string,
	answers: { run: "y" | "n"; write: "y" | "n" },
	options: { env: Record<string, string>; dir: string; label: string },
): Promise<Result> {
	const found = await run("sh", ["-c", "command -v expect"], { env: options.env, log: join(options.dir, `${options.label}-which.log`) });
	if (found.code !== 0) throw new Error("expect is required to answer setup's prompts: it ships with macOS; on Linux install the expect package.");
	const script = join(options.dir, "setup.exp");
	if (!existsSync(script))
		writeFileSync(
			script,
			[
				"# expect setup.exp <bin> <setup name> <answer to Run them?> <answer to Write it?>",
				"set timeout 1800",
				"lassign $argv bin name run write",
				"spawn $bin classifier setup $name",
				"expect {",
				'  -ex {Run them? [y/N] } { send "$run\\r"; exp_continue }',
				'  -ex {Write it? [y/N] } { send "$write\\r"; exp_continue }',
				"  eof",
				"}",
				"lassign [wait] pid spawnid os_error status",
				"exit $status",
				"",
			].join("\n"),
		);
	return run("expect", [script, bin, name, answers.run, answers.write], {
		env: options.env,
		log: join(options.dir, `${options.label}.log`),
		timeoutMs: 1_800_000,
	});
}

export interface WrittenConfig {
	classifierProviders?: Array<{ name: string; baseUrl: string; models: string[]; apiKey?: string }>;
	classifiers?: Array<{ model: string; threshold: number; timeoutMs: number }>;
	classification?: { temperature?: number; decisionBudgetMs?: number };
	[key: string]: unknown;
}

export function readConfig(path: string): WrittenConfig {
	return JSON.parse(readFileSync(path, "utf8")) as WrittenConfig;
}

/** Fails unless the config holds exactly one classifier, `model`, with a threshold and a timeout setup chose. */
export function assertOneClassifier(config: WrittenConfig, model: string): void {
	assert.deepEqual(
		(config.classifiers ?? []).map((classifier) => classifier.model),
		[model],
	);
	const [classifier] = config.classifiers ?? [];
	assert.ok(classifier && classifier.threshold > 0 && classifier.threshold <= 1, `threshold ${classifier?.threshold}`);
	assert.ok(classifier && classifier.timeoutMs >= 2000, `timeoutMs ${classifier?.timeoutMs}`);
}

export interface EvalSummary {
	correct: number;
	failed: number;
	threshold: number;
	medianMs: number;
	best: { threshold: number; correct: number; under: number };
}

/** The `N/24 on the expected tier` count from eval's report, as `/tier eval` shows it. */
export function routedAsLabelled(report: string): number {
	const match = /^(\d+)\/24 on the expected tier/mu.exec(report);
	if (!match) throw new Error(`no score in:\n${report}`);
	return Number(match[1]);
}

/** What the server suites share: the installed bin, the environment setup and pi run with, and the run folder. */
export interface ServerCheck {
	runDir: Run;
	bin: string;
	home: string;
	env: Record<string, string>;
	/** results.json key prefix, such as `ollama`. */
	key: string;
	/** Start pi with `--offline` (the default); false lets pi's providers list models over the network. */
	offline?: boolean;
	/** A model one of pi's own providers lists, which pi-switchboard reads as a classifier: wait for it before the first command. */
	listedByPi?: string;
}

/** `classifier detect --json` lists `model` among `server`'s decision models. */
export async function assertDetected(check: ServerCheck, server: string, model: string): Promise<void> {
	const detected = await run(check.bin, ["classifier", "detect", "--json"], { env: check.env, log: join(check.runDir.dir, "detect.log") });
	assert.equal(detected.code, 0, check.runDir.explain(detected.text));
	const servers = JSON.parse(detected.stdout) as Array<{ name: string; decisionModels?: string[] }>;
	assert.ok(servers.find((found) => found.name === server)?.decisionModels?.includes(model), check.runDir.explain(detected.stdout));
}

/** `classifier eval --json` routes at least `floor` of 24 as labelled at its best threshold; the result goes to results.json. */
export async function assertEvalFloor(check: ServerCheck, args: string[], floor: number): Promise<void> {
	const result = await run(check.bin, ["classifier", "eval", ...args, "--json"], {
		env: check.env,
		log: join(check.runDir.dir, "eval.log"),
		timeoutMs: 1_800_000,
	});
	assert.equal(result.code, 0, check.runDir.explain(result.text));
	const report = JSON.parse(result.stdout) as EvalSummary;
	check.runDir.record(`${check.key}.eval`, { best: report.best, medianMs: Math.round(report.medianMs) });
	const why = `${report.best.correct}/24 at best, below ${floor}; ${report.failed} without an answer, median ${Math.round(report.medianMs)} ms`;
	assert.ok(report.best.correct >= floor, check.runDir.explain(why));
}

/**
 * In real pi with the config setup wrote: `/tier doctor` says `classifier`
 * answered, and `/tier eval` routes at least `floor` of 24 as labelled. Then
 * runs `more` commands. Returns the notices pi showed before the first
 * command, and each of `more`'s output.
 */
export async function assertAnswersInPi(
	check: ServerCheck,
	classifier: string,
	floor: number,
	more: string[] = [],
): Promise<{ startup: string; outputs: string[] }> {
	const session = await PiSession.start({ env: check.env, cwd: check.home, log: join(check.runDir.dir, "pi"), offline: check.offline !== false });
	try {
		if (check.listedByPi) await session.waitForModel(check.listedByPi, 60_000);
		const startup = session.notices.map((notice) => notice.message).join("\n");
		const doctor = await session.command("/tier doctor");
		assert.match(doctor, new RegExp(`^✓ classifier ${escapeRegExp(classifier)} answered in \\d+ ms$`, "mu"), check.runDir.explain(doctor));
		const evaluated = await session.command("/tier eval");
		check.runDir.record(`${check.key}.pi-eval`, routedAsLabelled(evaluated));
		assert.ok(routedAsLabelled(evaluated) >= floor, check.runDir.explain(evaluated));
		const outputs: string[] = [];
		for (const command of more) outputs.push(await session.command(command));
		assert.deepEqual(session.errors, [], check.runDir.explain("an extension handler threw"));
		return { startup, outputs };
	} finally {
		await session.close();
	}
}

export const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
