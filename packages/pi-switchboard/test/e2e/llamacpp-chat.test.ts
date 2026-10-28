// End to end with a model server: `classifier setup llamacpp-chat`, a chat
// model read through pi's llama.cpp provider, with llama-server in Docker.
// The suite does what setup asks of a user in another terminal: runs the
// download command, stops it once setup sees it serving one model, then starts
// the router. Then /tier doctor and /tier eval in real pi with LLAMA_BASE_URL.
// Runs with `E2E_SERVERS=llamacpp-chat` (or `docker`) `npm run test:e2e`.
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { assertPortFree, IMAGES, LLAMA, modelDigests, prepareDocker, removeContainers, waitForHttp, writeShims } from "./support/docker.ts";
import { installTarball } from "./support/install.ts";
import { type Proc, start } from "./support/proc.ts";
import { isolatedEnv, skipUnlessSelected, startRun } from "./support/run.ts";
import { assertAnswersInPi, escapeRegExp, readConfig, runPrinted, type ServerCheck, waitForPrinted } from "./support/setup.ts";

/** docs/classifier-llama-cpp.md: Qwen3-4B-Instruct-2507 routes 23 of 24 as labelled; a drop of more than two fails. */
const FLOOR = 21;
const MODEL = "unsloth/Qwen3-4B-Instruct-2507-GGUF:Q4_K_M";
const ORIGIN = "http://127.0.0.1:8080";

describe("classifier setup llamacpp-chat, with llama-server in Docker", { skip: skipUnlessSelected("llamacpp-chat"), timeout: 3_600_000 }, () => {
	let check: ServerCheck;
	let config: string;
	let router: Proc | undefined;
	const log = () => join(check.runDir.dir, "docker.log");

	before(async () => {
		const runDir = startRun("llamacpp-chat");
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
			LLAMA_BASE_URL: ORIGIN,
		});
		check = { runDir, bin: installed.bin, home: installed.home, env, key: "llamacpp-chat" };
	});

	after(async () => {
		await router?.stop("SIGINT");
		await removeContainers(log());
	});

	it("waits through the download server for the router, loads the model and writes the classifier", async () => {
		const setup = start(check.bin, ["classifier", "setup", "llamacpp-chat", "--yes"], { env: check.env, log: join(check.runDir.dir, "setup.log") });
		const [prepare = "", serve = ""] = await waitForPrinted(setup, 2);
		assert.match(prepare, /\/llama-server -hf unsloth\/Qwen3-4B-Instruct-2507-GGUF:Q4_K_M -c 8192$/u);
		assert.match(serve, /\/llama-server --port 8080 -c 8192 --jinja$/u);

		const download = runPrinted(prepare, check.env, join(check.runDir.dir, "prepare.log"));
		await setup.waitForOutput(
			/^llama\.cpp at http:\/\/127\.0\.0\.1:8080 serves one model, not the router: once the download is done, stop it with Ctrl\+C/mu,
			1_800_000,
		);
		await waitForHttp(`${ORIGIN}/health`, 60_000);
		await download.stop("SIGINT");
		await removeContainers(log(), [LLAMA]);

		router = runPrinted(serve, check.env, join(check.runDir.dir, "router.log"));
		const result = await setup.done;
		assert.equal(result.code, 0, check.runDir.explain(result.text));
		assert.match(result.text, new RegExp(`^Loaded ${escapeRegExp(MODEL)}\\.$`, "mu"));
		assert.match(result.text, /^ {2}to use one: export LLAMA_BASE_URL=http:\/\/127\.0\.0\.1:8080 /mu);
		check.runDir.record("llamacpp-chat.models", await modelDigests("llamacpp"));
		const written = readConfig(config);
		assert.equal(written.classifierProviders, undefined);
		assert.deepEqual(written.classifiers, [{ model: `llama.cpp/${MODEL}`, timeoutMs: 3000, threshold: 0.8 }]);
		assert.equal(written.classification?.temperature, 2);
	});

	it("answers in real pi through its llama.cpp provider, with no false warning at start", async () => {
		const { startup } = await assertAnswersInPi({ ...check, offline: false, listedByPi: `llama.cpp/${MODEL}` }, `llama.cpp/${MODEL}`, FLOOR);
		assert.doesNotMatch(startup, /not registered|is not a classifier/u, check.runDir.explain(`startup:\n${startup}`));
	});
});
