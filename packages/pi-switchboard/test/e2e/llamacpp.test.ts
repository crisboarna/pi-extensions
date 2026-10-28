// End to end with a model server: `classifier setup llamacpp` with
// llama-server in Docker. The suite runs the server command setup prints, as
// a user would in another terminal (`llama-server` is a shim for the llama.cpp
// image), then checks detect, eval, and /tier doctor and /tier eval in real
// pi. Runs with `E2E_SERVERS=llamacpp` (or `docker`) `npm run test:e2e`.
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { assertPortFree, IMAGES, modelDigests, prepareDocker, removeContainers, writeShims } from "./support/docker.ts";
import { installTarball } from "./support/install.ts";
import { type Proc, run, start } from "./support/proc.ts";
import { isolatedEnv, skipUnlessSelected, startRun } from "./support/run.ts";
import {
	assertAnswersInPi,
	assertDetected,
	assertEvalFloor,
	assertOneClassifier,
	readConfig,
	runPrinted,
	type ServerCheck,
	waitForPrinted,
} from "./support/setup.ts";

/** docs/classifier-llama-cpp.md: H2O-Lightning-4B routes 21 of 24 as labelled; a drop of more than two fails. */
const FLOOR = 19;
const MODEL = "h2oai/h2o-lightning-4b-gguf:Q4_K_M";

describe("classifier setup llamacpp, with llama-server in Docker", { skip: skipUnlessSelected("llamacpp"), timeout: 3_600_000 }, () => {
	let check: ServerCheck;
	let config: string;
	let server: Proc | undefined;
	const log = () => join(check.runDir.dir, "docker.log");

	before(async () => {
		const runDir = startRun("llamacpp");
		await prepareDocker([IMAGES.llamacpp], join(runDir.dir, "docker.log"));
		await removeContainers(join(runDir.dir, "docker.log"));
		await assertPortFree(8080, "llama-server");
		const installed = await installTarball(runDir);
		const shims = writeShims(runDir.folder("shims"));
		config = join(runDir.dir, "pi-switchboard.json");
		const env = isolatedEnv(installed.home, {
			PATH: `${shims}:${process.env.PATH ?? ""}`,
			PI_CODING_AGENT_DIR: installed.agentDir,
			PI_SWITCHBOARD_CONFIG: config,
		});
		check = { runDir, bin: installed.bin, home: installed.home, env, key: "llamacpp" };
	});

	after(async () => {
		await server?.stop("SIGINT");
		await removeContainers(log());
	});

	it("prints the server command with an 8k context, and writes the config once that server answers", async () => {
		const setup = start(check.bin, ["classifier", "setup", "llamacpp", "--yes"], { env: check.env, log: join(check.runDir.dir, "setup.log") });
		const [serve = ""] = await waitForPrinted(setup, 1);
		assert.match(serve, /\/llama-server -hf h2oai\/h2o-lightning-4b-gguf:Q4_K_M --port 8080 -c 8192$/u);
		server = runPrinted(serve, check.env, join(check.runDir.dir, "server.log"));
		const result = await setup.done;
		assert.equal(result.code, 0, check.runDir.explain(result.text));
		const props = (await (await fetch("http://127.0.0.1:8080/props")).json()) as { default_generation_settings?: { n_ctx?: number } };
		assert.equal(props.default_generation_settings?.n_ctx, 8192, check.runDir.explain("the server's context is not 8192"));
		check.runDir.record("llamacpp.models", await modelDigests("llamacpp"));
		const written = readConfig(config);
		assert.deepEqual(written.classifierProviders, [{ name: "llamacpp", baseUrl: "http://127.0.0.1:8080/v1/", models: [MODEL] }]);
		assertOneClassifier(written, `llamacpp/${MODEL}`);
		check.runDir.record("llamacpp.setup", written.classifiers);
	});

	it("says on a rerun that the server is already running, starts nothing, and adds nothing twice", async () => {
		const result = await run(check.bin, ["classifier", "setup", "llamacpp", "--yes", "--no-eval"], {
			env: check.env,
			log: join(check.runDir.dir, "rerun.log"),
		});
		assert.equal(result.code, 0, check.runDir.explain(result.text));
		assert.match(result.text, /^llama\.cpp is already running at http:\/\/127\.0\.0\.1:8080, so there is nothing to start\.$/mu);
		assert.doesNotMatch(result.text, /^ {2}\$ /mu, check.runDir.explain("it printed a command to start the server"));
		const written = readConfig(config);
		assert.equal(written.classifierProviders?.length, 1);
		assertOneClassifier(written, `llamacpp/${MODEL}`);
	});

	it("is found by detect, and eval routes at least the guide's score less two", async () => {
		await assertDetected(check, "llamacpp", MODEL);
		await assertEvalFloor(check, ["http://127.0.0.1:8080/v1", MODEL], FLOOR);
	});

	it("answers in real pi: /tier doctor and /tier eval", async () => {
		await assertAnswersInPi(check, `llamacpp/${MODEL}`, FLOOR);
	});
});
