// The classifier servers the end-to-end suites run in Docker, pinned by
// digest so every run uses the same server build. Shims named like the native
// commands (`ollama`, `llama-server`) go first on PATH, so `classifier setup`
// finds and runs them exactly as it would a native install. Containers are
// named pi-e2e-* and share the pi-e2e network; ports are the catalog's own,
// because setup's commands use them.
import { chmodSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { run } from "./proc.ts";
import { cacheDir, waitFor } from "./run.ts";

/** The images verified on 2026-10-28 (spec #128); change a pin only after running the suites on the new image. */
export const IMAGES = {
	ollama: "ollama/ollama:0.40.11@sha256:dea72d1e22270fe095b68fdf756d2b489d615643c5a2eaebbc5f569181e322d8",
	/** llama.cpp revision 7aca0d2. */
	llamacpp: "ghcr.io/ggml-org/llama.cpp:server@sha256:8ee4ec7ce58a921313d07390c6699af13aa5ec083f3cdf67e5f4155767047373",
	/** LiteLLM 1.106.5. */
	litellm: "ghcr.io/berriai/litellm:main-stable@sha256:7d6ae6c8d73d1b6aea4cb75d07c4a8a953f0809b0764522b8eab693734c5e905",
} as const;

export const NETWORK = "pi-e2e";
export const OLLAMA = "pi-e2e-ollama";
export const LLAMA = "pi-e2e-llama";

async function docker(args: string[], log: string, timeoutMs = 120_000) {
	return run("docker", args, { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp" }, log, timeoutMs });
}

/**
 * A Mac on battery runs the CPU servers in Docker several times slower, so
 * requests time out and scores drop below what the guides measured; such a
 * run says nothing about the code, so the suites refuse it unless asked.
 */
async function assertFullSpeed(log: string): Promise<void> {
	if (process.platform !== "darwin" || process.env.E2E_ALLOW_SLOW === "1") return;
	const power = await run("pmset", ["-g", "batt"], { env: { PATH: "/usr/bin:/bin" }, log });
	if (/'Battery Power'/u.test(power.stdout))
		throw new Error(
			"this Mac is on battery power, which makes the model servers in Docker several times slower: requests time out and scores drop. Plug it in, or set E2E_ALLOW_SLOW=1 to run anyway (its scores will not compare with the guides').",
		);
}

/** Checks the machine runs at full speed, Docker answers, the images are present (pulling a missing one), and the network exists. */
export async function prepareDocker(images: readonly string[], log: string): Promise<void> {
	await assertFullSpeed(log);
	if ((await docker(["info", "--format", "{{.ServerVersion}}"], log)).code !== 0)
		throw new Error("Docker is required for this suite and is not running: start Docker Desktop, Colima or dockerd, then run it again.");
	for (const image of images) {
		if ((await docker(["image", "inspect", image], log)).code === 0) continue;
		const pulled = await docker(["pull", image], log, 1_800_000);
		if (pulled.code !== 0) throw new Error(`could not pull ${image}:\n${pulled.text.slice(-1000)}`);
	}
	if ((await docker(["network", "inspect", NETWORK], log)).code !== 0) await docker(["network", "create", NETWORK], log);
}

/** Removes the suites' containers, running or not. */
export async function removeContainers(log: string, names: readonly string[] = [OLLAMA, LLAMA, "pi-e2e-litellm"]): Promise<void> {
	await docker(["rm", "-f", ...names], log);
}

/** Fails when something already listens on `port`: a native server there would answer in place of the container. */
export async function assertPortFree(port: number, owner: string): Promise<void> {
	const open = await new Promise<boolean>((resolve) => {
		const socket = connect({ host: "127.0.0.1", port }, () => {
			socket.destroy();
			resolve(true);
		});
		socket.on("error", () => resolve(false));
	});
	if (open) throw new Error(`port ${port} is in use; stop what listens there (a native ${owner}?) so the suite's container can use it.`);
}

/** Resolves when `url` answers 200. */
export async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
	await waitFor(
		url,
		async () => {
			try {
				return (await fetch(url, { signal: AbortSignal.timeout(2000) })).ok;
			} catch {
				return false;
			}
		},
		timeoutMs,
	);
}

/** Starts Ollama's server on 127.0.0.1:11434 with `models` as its model folder, and waits until it answers. */
export async function startOllama(models: string, log: string): Promise<void> {
	await removeContainers(log, [OLLAMA]);
	const started = await docker(
		["run", "-d", "--name", OLLAMA, "--network", NETWORK, "-p", "127.0.0.1:11434:11434", "-v", `${models}:/root/.ollama`, IMAGES.ollama],
		log,
	);
	if (started.code !== 0) throw new Error(`could not start Ollama:\n${started.text}`);
	await waitForHttp("http://127.0.0.1:11434/api/version", 60_000);
}

/**
 * Writes the shims into `dir`: `ollama` runs the CLI inside the Ollama
 * container, and `llama-server` runs the given arguments in the llama.cpp
 * image, in the foreground like a native server, with the model download cache
 * kept between runs. Setup runs them with the run folder as HOME, so they name
 * the user's Docker config (and with it the Docker context) explicitly.
 */
export function writeShims(dir: string): string {
	const dockerConfig = process.env.DOCKER_CONFIG ?? join(homedir(), ".docker");
	const shims = {
		ollama: `exec docker exec ${OLLAMA} ollama "$@"`,
		"llama-server": `exec docker run --rm --name ${LLAMA} --network ${NETWORK} -p 127.0.0.1:8080:8080 -v '${cacheDir("llama.cpp")}:/root/.cache' ${IMAGES.llamacpp} --host 0.0.0.0 "$@"`,
	};
	for (const [name, body] of Object.entries(shims)) {
		writeFileSync(
			join(dir, name),
			`#!/bin/sh\n# Stands in for a native ${name} (test/e2e/support/docker.ts).\nexport DOCKER_CONFIG='${dockerConfig}'\n${body}\n`,
		);
		chmodSync(join(dir, name), 0o755);
	}
	return dir;
}

/** The model files a run used, for results.json: Ollama's digests, or the snapshot of each Hugging Face repository in llama.cpp's cache. */
export async function modelDigests(kind: "ollama" | "llamacpp"): Promise<Record<string, string>> {
	if (kind === "ollama") {
		const tags = (await (await fetch("http://127.0.0.1:11434/api/tags")).json()) as { models?: Array<{ name: string; digest: string }> };
		return Object.fromEntries((tags.models ?? []).map((model) => [model.name, model.digest]));
	}
	const hub = join(cacheDir("llama.cpp"), "huggingface", "hub");
	if (!existsSync(hub)) return {};
	return Object.fromEntries(
		readdirSync(hub)
			.filter((name) => name.startsWith("models--") && existsSync(join(hub, name, "refs", "main")))
			.map((name) => [name.slice("models--".length).replace("--", "/"), readFileSync(join(hub, name, "refs", "main"), "utf8").trim()]),
	);
}
