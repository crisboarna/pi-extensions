// End to end with a model server: `classifier setup lmstudio` against the
// LM Studio installed on this machine, which cannot run in Docker. It changes
// LM Studio's loaded models, so it runs only when named:
// `E2E_SERVERS=lmstudio npm run test:e2e`. It records which copies of the
// classifier are loaded first and loads them back at the end; other models
// are left alone.
import assert from "node:assert/strict";
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { type Installed, installTarball } from "./support/install.ts";
import { run } from "./support/proc.ts";
import { isolatedEnv, type Run, skipUnlessSelected, startRun } from "./support/run.ts";
import { assertAnswersInPi, assertDetected, assertEvalFloor, assertOneClassifier, readConfig, type ServerCheck, setupInTerminal } from "./support/setup.ts";

/** docs/classifier-lm-studio.md: H2O-Lightning-4B routes 22 of 24 as labelled; a drop of more than two fails. */
const FLOOR = 20;
const MODEL = "h2o-lightning-4b";

interface Loaded {
	identifier: string;
	modelKey: string;
	contextLength: number;
}

/** The user's own `lms`: on PATH, or where LM Studio installs it. */
function findLms(): string {
	const candidates = [...(process.env.PATH ?? "").split(delimiter).map((dir) => join(dir, "lms")), join(homedir(), ".lmstudio", "bin", "lms")];
	const found = candidates.find((path) => existsSync(path));
	if (!found) throw new Error("lms was not found: install LM Studio from https://lmstudio.ai and open it once, which installs the lms command.");
	return found;
}

describe("classifier setup lmstudio, with this machine's LM Studio", { skip: skipUnlessSelected("lmstudio"), timeout: 3_600_000 }, () => {
	let runDir: Run;
	let installed: Installed;
	let shims: string;
	let config: string;
	let initial: Loaded[] = [];
	const env = (configPath: string) =>
		isolatedEnv(installed.home, {
			PATH: `${shims}${delimiter}${process.env.PATH ?? ""}`,
			PI_CODING_AGENT_DIR: installed.agentDir,
			PI_SWITCHBOARD_CONFIG: configPath,
		});
	const check = (): ServerCheck => ({ runDir, bin: installed.bin, home: installed.home, env: env(config), key: "lmstudio" });
	const lms = (args: string[], label: string) =>
		run(join(shims, "lms"), args, { env: env(config), log: join(runDir.dir, `${label}.log`), timeoutMs: 600_000 });

	/** The loaded copies of the classifier model, by `lms ps --json`: any variant, such as `h2o-lightning-4b@iq3_xxs`, and any name. */
	async function copies(): Promise<Loaded[]> {
		const listed = await lms(["ps", "--json"], "lms-ps");
		assert.equal(listed.code, 0, runDir.explain(listed.text));
		const ofModel = (name: string) => name === MODEL || name.startsWith(`${MODEL}@`);
		return (JSON.parse(listed.stdout) as Loaded[]).filter((model) => ofModel(model.modelKey) || ofModel(model.identifier));
	}

	async function unloadAll(): Promise<void> {
		for (const copy of await copies()) await lms(["unload", copy.identifier], "lms-unload");
	}

	before(async () => {
		runDir = startRun("lmstudio");
		installed = await installTarball(runDir);
		config = join(runDir.dir, "pi-switchboard.json");
		// lms finds LM Studio through HOME, which the suite points into the run folder, so a shim runs it with the user's own.
		shims = runDir.folder("shims");
		writeFileSync(
			join(shims, "lms"),
			`#!/bin/sh\n# The user's lms, with the user's HOME (test/e2e/lmstudio.test.ts).\nHOME='${homedir()}' exec '${findLms()}' "$@"\n`,
		);
		chmodSync(join(shims, "lms"), 0o755);
		initial = await copies();
		runDir.record("lmstudio.before", initial);
		await unloadAll();
	});

	after(async () => {
		await unloadAll();
		for (const copy of initial) await lms(["load", copy.modelKey, "-y", "-c", String(copy.contextLength), "--identifier", copy.identifier], "lms-restore");
		assert.deepEqual(
			(await copies()).map((copy) => [copy.identifier, copy.contextLength]),
			initial.map((copy) => [copy.identifier, copy.contextLength]),
			runDir.explain("LM Studio's loaded copies differ from before the suite"),
		);
	});

	it("runs nothing and writes nothing when its commands are declined", async () => {
		const declined = join(runDir.dir, "declined.json");
		const result = await setupInTerminal(
			installed.bin,
			"lmstudio",
			{ run: "n", write: "n" },
			{ env: env(declined), dir: runDir.dir, label: "setup-declined" },
		);
		assert.match(result.text, /Run them\? \[y\/N\] n\s+Nothing was run, and the config is unchanged\./u, runDir.explain(result.text));
		assert.equal(existsSync(declined), false, runDir.explain("a config was written"));
		assert.deepEqual(await copies(), [], runDir.explain("the model was loaded"));
	});

	it("loads one copy with an 8k context when its commands run, and writes nothing when the change is declined", async () => {
		const unwritten = join(runDir.dir, "unwritten.json");
		const result = await setupInTerminal(
			installed.bin,
			"lmstudio",
			{ run: "y", write: "n" },
			{ env: env(unwritten), dir: runDir.dir, label: "setup-unwritten" },
		);
		assert.match(result.text, /^ {2}\$ \S+\/lms load h2o-lightning-4b -y -c 8192 --identifier h2o-lightning-4b$/mu, runDir.explain(result.text));
		assert.match(result.text, /Write it\? \[y\/N\] n\s+The config is unchanged\./u, runDir.explain(result.text));
		assert.equal(existsSync(unwritten), false, runDir.explain("a config was written"));
		assert.deepEqual(
			(await copies()).map((copy) => copy.contextLength),
			[8192],
		);
	});

	it("says it already serves the model, loads no second copy, and writes the config; a rerun adds nothing twice", async () => {
		const result = await run(installed.bin, ["classifier", "setup", "lmstudio", "--yes"], {
			env: env(config),
			log: join(runDir.dir, "setup.log"),
			timeoutMs: 1_800_000,
		});
		assert.equal(result.code, 0, runDir.explain(result.text));
		assert.match(result.text, /^LM Studio already serves h2o-lightning-4b, so nothing is downloaded or loaded\.$/mu);
		const written = readConfig(config);
		assert.deepEqual(written.classifierProviders, [{ name: "lmstudio", baseUrl: "http://127.0.0.1:1234/v1/", models: [MODEL] }]);
		assertOneClassifier(written, `lmstudio/${MODEL}`);
		runDir.record("lmstudio.setup", written.classifiers);
		const rerun = await run(installed.bin, ["classifier", "setup", "lmstudio", "--yes", "--no-eval"], {
			env: env(config),
			log: join(runDir.dir, "rerun.log"),
		});
		assert.equal(rerun.code, 0, runDir.explain(rerun.text));
		assert.equal(readConfig(config).classifierProviders?.length, 1);
		assertOneClassifier(readConfig(config), `lmstudio/${MODEL}`);
		assert.equal((await copies()).length, 1, runDir.explain("a second copy was loaded"));
	});

	it("is found by detect, and eval routes at least the guide's score less two", async () => {
		await assertDetected(check(), "lmstudio", MODEL);
		await assertEvalFloor(check(), ["http://127.0.0.1:1234/v1", MODEL], FLOOR);
	});

	it("answers in real pi: /tier doctor and /tier eval", async () => {
		await assertAnswersInPi(check(), `lmstudio/${MODEL}`, FLOOR);
	});
});
