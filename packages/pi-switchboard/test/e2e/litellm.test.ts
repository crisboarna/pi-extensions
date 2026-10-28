// End to end with a model server: the LiteLLM proxy from
// docs/classifier-other-servers.md, in Docker, in front of the llama.cpp
// decision server. It runs the guide's own key commands and uses the guide's
// config block as written, with the proxy's `jev` model pointing at the local
// server instead of a cloud. Runs with `E2E_SERVERS=litellm` (or `docker`)
// `npm run test:e2e`.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { assertPortFree, IMAGES, LLAMA, NETWORK, prepareDocker, removeContainers, waitForHttp, writeShims } from "./support/docker.ts";
import { installTarball } from "./support/install.ts";
import { PiSession } from "./support/pi-rpc.ts";
import { type Proc, run, start } from "./support/proc.ts";
import { isolatedEnv, PACKAGE, skipUnlessSelected, startRun } from "./support/run.ts";
import { assertAnswersInPi, assertEvalFloor, type ServerCheck } from "./support/setup.ts";

/** The guide's run of LiteLLM matched its server directly; llama.cpp's H2O-Lightning-4B routes 21 of 24, and a drop of more than two fails. */
const FLOOR = 19;
const LITELLM = "pi-e2e-litellm";
const GUIDE = join(PACKAGE, "docs", "classifier-other-servers.md");

/** The fenced block of `language` that follows `marker` in the guide. */
function guideBlock(marker: string, language: string): string {
	const text = readFileSync(GUIDE, "utf8");
	const from = text.indexOf(marker);
	assert.ok(from >= 0, `${GUIDE} no longer says "${marker}"`);
	const block = new RegExp(`\`\`\`${language}\\n([\\s\\S]*?)\`\`\``, "u").exec(text.slice(from));
	assert.ok(block?.[1], `no ${language} block after "${marker}" in ${GUIDE}`);
	return block[1];
}

describe("LiteLLM in front of llama.cpp, as the guide sets it up", { skip: skipUnlessSelected("litellm"), timeout: 3_600_000 }, () => {
	let check: ServerCheck;
	let server: Proc | undefined;
	let key = "";
	const log = () => join(check.runDir.dir, "docker.log");

	before(async () => {
		const runDir = startRun("litellm");
		await prepareDocker([IMAGES.llamacpp, IMAGES.litellm], join(runDir.dir, "docker.log"));
		await removeContainers(join(runDir.dir, "docker.log"));
		await assertPortFree(8080, "llama-server");
		await assertPortFree(4000, "LiteLLM");
		const installed = await installTarball(runDir);
		const shims = writeShims(runDir.folder("shims"));
		const config = join(runDir.dir, "pi-switchboard.json");
		const env = isolatedEnv(installed.home, {
			PATH: `${shims}:${process.env.PATH ?? ""}`,
			PI_CODING_AGENT_DIR: installed.agentDir,
			PI_SWITCHBOARD_CONFIG: config,
		});
		check = { runDir, bin: installed.bin, home: installed.home, env, key: "litellm" };
		const fragment = guideBlock("give pi the same value:", "json");
		writeFileSync(config, `${JSON.stringify(JSON.parse(`{${fragment}}`), null, "\t")}\n`);
		server = start(join(shims, "llama-server"), ["-hf", "h2oai/h2o-lightning-4b-gguf:Q4_K_M", "--port", "8080", "-c", "8192"], {
			env,
			log: join(runDir.dir, "llama-server.log"),
		});
		await waitForHttp("http://127.0.0.1:8080/health", 1_800_000);
	});

	after(async () => {
		await server?.stop("SIGINT");
		await removeContainers(log(), [LITELLM, LLAMA]);
	});

	it("sets both keys with the guide's commands", async () => {
		const exports = guideBlock("LiteLLM refuses to start without a master key", "bash")
			.split("\n")
			.filter((line) => line.startsWith("export "))
			.join("\n");
		const printed = await run("sh", ["-c", `${exports}\nprintf '%s\\n%s\\n' "$LITELLM_MASTER_KEY" "$LITELLM_API_KEY"`], {
			env: check.env,
			log: join(check.runDir.dir, "keys.log"),
		});
		const [master = "", apiKey = ""] = printed.stdout.trim().split("\n");
		assert.match(master, /^sk-[0-9a-f]{32}$/u, check.runDir.explain("LITELLM_MASTER_KEY"));
		assert.equal(apiKey, master, check.runDir.explain("LITELLM_API_KEY is not the master key"));
		key = master;
	});

	it("forwards System One requests: eval routes at least the guide's score less two", async () => {
		const proxyConfig = join(check.runDir.dir, "config.yaml");
		writeFileSync(
			proxyConfig,
			[
				"model_list:",
				"  - model_name: jev",
				"    litellm_params:",
				"      model: hosted_vllm/h2oai/h2o-lightning-4b-gguf:Q4_K_M",
				`      api_base: http://${LLAMA}:8080/v1`,
				"",
			].join("\n"),
		);
		const started = await run(
			"docker",
			[
				"run",
				"-d",
				"--name",
				LITELLM,
				"--network",
				NETWORK,
				"-p",
				"127.0.0.1:4000:4000",
				"-e",
				`LITELLM_MASTER_KEY=${key}`,
				"-v",
				`${proxyConfig}:/app/config.yaml:ro`,
				IMAGES.litellm,
				"--config",
				"/app/config.yaml",
				"--port",
				"4000",
			],
			{ env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" }, log: log() },
		);
		assert.equal(started.code, 0, check.runDir.explain(started.text));
		await waitForHttp("http://127.0.0.1:4000/health/liveliness", 300_000);
		const withKey = { ...check, env: { ...check.env, LITELLM_API_KEY: key } };
		await assertEvalFloor(withKey, ["http://127.0.0.1:4000/v1", "jev", "--api-key-env", "LITELLM_API_KEY"], FLOOR);
	});

	it("answers in real pi with the guide's config, and doctor names the key when it is not set", async () => {
		await assertAnswersInPi({ ...check, env: { ...check.env, LITELLM_API_KEY: key } }, "litellm/jev", FLOOR);
		const session = await PiSession.start({ env: check.env, cwd: check.home, log: join(check.runDir.dir, "pi-no-key") });
		try {
			assert.match(
				await session.command("/tier doctor"),
				/^✗ classifier litellm\/jev .*LITELLM_API_KEY/mu,
				check.runDir.explain("doctor without the key"),
			);
		} finally {
			await session.close();
		}
	});
});
