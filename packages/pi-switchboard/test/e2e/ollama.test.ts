// End to end with a model server: `classifier setup ollama` against Ollama in
// Docker (the `ollama` command is a shim that runs Ollama's own CLI in the
// container), then detect, eval, and /tier doctor and /tier eval in real pi.
// Runs with `E2E_SERVERS=ollama` (or `docker`) `npm run test:e2e`.
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { assertPortFree, IMAGES, modelDigests, prepareDocker, removeContainers, startOllama, writeShims } from "./support/docker.ts";
import { type Installed, installTarball } from "./support/install.ts";
import { run, start } from "./support/proc.ts";
import { cacheDir, isolatedEnv, type Run, skipUnlessSelected, startRun } from "./support/run.ts";
import { assertAnswersInPi, assertDetected, assertEvalFloor, assertOneClassifier, readConfig, setupInTerminal } from "./support/setup.ts";

/** docs/classifier-ollama.md: Tev1 routes 21 of 24 as labelled; a drop of more than two fails. */
const FLOOR = 19;
const CLASSIFIER = "ollama/tev1:latest";

describe("classifier setup ollama, with Ollama in Docker", { skip: skipUnlessSelected("ollama"), timeout: 3_600_000 }, () => {
	let runDir: Run;
	let installed: Installed;
	let shims: string;
	let config: string;
	const log = () => join(runDir.dir, "docker.log");
	const env = (configPath: string) =>
		isolatedEnv(installed.home, { PATH: `${shims}:${process.env.PATH ?? ""}`, PI_CODING_AGENT_DIR: installed.agentDir, PI_SWITCHBOARD_CONFIG: configPath });

	before(async () => {
		runDir = startRun("ollama");
		await prepareDocker([IMAGES.ollama], log());
		await removeContainers(log());
		await assertPortFree(11434, "Ollama");
		installed = await installTarball(runDir);
		shims = writeShims(runDir.folder("shims"));
		config = join(runDir.dir, "pi-switchboard.json");
	});

	after(async () => {
		await removeContainers(log());
	});

	it("runs nothing and writes nothing when its commands are declined", async () => {
		await startOllama(runDir.folder("ollama-empty"), log());
		const declined = join(runDir.dir, "declined.json");
		const result = await setupInTerminal(
			installed.bin,
			"ollama",
			{ run: "n", write: "n" },
			{ env: env(declined), dir: runDir.dir, label: "setup-declined" },
		);
		assert.match(result.text, /^ {2}\$ \S+\/ollama pull tev1$/mu, runDir.explain("the pull was not shown"));
		assert.match(result.text, /Run them\? \[y\/N\] n\s+Nothing was run, and the config is unchanged\./u, runDir.explain(result.text));
		assert.equal(existsSync(declined), false, runDir.explain("a config was written"));
		assert.deepEqual(await modelDigests("ollama"), {}, runDir.explain("a model was pulled"));
	});

	it("waits for a server that is not running, then pulls the model and writes the config", async () => {
		await removeContainers(log());
		const setup = start(installed.bin, ["classifier", "setup", "ollama", "--yes"], { env: env(config), log: join(runDir.dir, "setup.log") });
		await setup.waitForOutput(/^Ollama is not answering at http:\/\/127\.0\.0\.1:11434\. .+\nWaiting for it…$/mu, 60_000);
		await startOllama(cacheDir("ollama"), log());
		const result = await setup.done;
		assert.equal(result.code, 0, runDir.explain(result.text));
		runDir.record("ollama.models", await modelDigests("ollama"));
		const written = readConfig(config);
		assert.deepEqual(written.classifierProviders, [{ name: "ollama", baseUrl: "http://127.0.0.1:11434/v1/", models: ["tev1:latest"] }]);
		assertOneClassifier(written, CLASSIFIER);
		runDir.record("ollama.setup", written.classifiers);
	});

	it("says it already serves the model on a rerun, and adds nothing twice", async () => {
		const result = await run(installed.bin, ["classifier", "setup", "ollama", "--yes", "--no-eval"], {
			env: env(config),
			log: join(runDir.dir, "rerun.log"),
		});
		assert.equal(result.code, 0, runDir.explain(result.text));
		assert.match(result.text, /^Ollama already serves tev1, so nothing is downloaded or loaded\.$/mu);
		assert.doesNotMatch(result.text, /^Waiting for /mu, runDir.explain("it said it was waiting for a model it had found"));
		const written = readConfig(config);
		assert.equal(written.classifierProviders?.length, 1);
		assertOneClassifier(written, CLASSIFIER);
	});

	it("keeps the rest of an existing config", async () => {
		const merged = join(runDir.dir, "merged.json");
		writeFileSync(merged, JSON.stringify({ profiles: { auto: { tiers: {} } }, classification: { decisionBudgetMs: 5000 } }, null, "\t"));
		const result = await run(installed.bin, ["classifier", "setup", "ollama", "--yes", "--no-eval"], {
			env: env(merged),
			log: join(runDir.dir, "merge.log"),
		});
		assert.equal(result.code, 0, runDir.explain(result.text));
		const written = readConfig(merged);
		assert.deepEqual(written.profiles, { auto: { tiers: {} } });
		assert.equal(written.classification?.decisionBudgetMs, 5000);
		assertOneClassifier(written, CLASSIFIER);
	});

	it("is found by detect, and eval routes at least the guide's score less two", async () => {
		const check = { runDir, bin: installed.bin, home: installed.home, env: env(config), key: "ollama" };
		await assertDetected(check, "ollama", "tev1:latest");
		await assertEvalFloor(check, ["http://127.0.0.1:11434/v1", "tev1"], FLOOR);
	});

	it("answers in real pi: /tier doctor, /tier eval, and /tier eval with a classifier and threshold named", async () => {
		const check = { runDir, bin: installed.bin, home: installed.home, env: env(config), key: "ollama" };
		const { outputs } = await assertAnswersInPi(check, CLASSIFIER, FLOOR, [`/tier eval ${CLASSIFIER} --threshold 0.7`]);
		assert.match(outputs[0] ?? "", new RegExp(`^classifier eval: ${CLASSIFIER} at threshold 0\\.7$`, "mu"));
	});
});
