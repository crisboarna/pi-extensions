import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { configFor, detectClassifiers, formatDetect, knownServers, listModels, preferredModel, type ServerProbe } from "../../src/classifier/detect.ts";
import { resolveKey } from "../../src/classifier/standalone.ts";
import { classifierCommand } from "../../src/cli/classifier.ts";

const ANSWERS = {
	work: { type: "choice", choice: "mechanical", probabilities: { mechanical: 0.9 }, confidence: 0.9 },
	depth: { type: "score", score: 0.2, confidence: 0.8 },
	risky: { type: "noul", noul: 0.05 },
};

/** The shipped catalog's servers, at test origins. */
const ORIGINS: Record<string, string> = { lmstudio: "http://studio.test", ollama: "http://ollama.test", llamacpp: "http://llama.test" };
const SERVERS: ServerProbe[] = knownServers().map((server) => ({ ...server, origin: ORIGINS[server.kind] ?? server.origin }));

/** A fake network: each product's model list in its own format, and a System One endpoint per server. */
function network(routes: Record<string, unknown>, systemOne: (url: string, model: string) => unknown = () => ({ answers: ANSWERS })) {
	const calls: string[] = [];
	const fake = (async (input: string | URL, init?: RequestInit) => {
		const url = String(input);
		calls.push(url);
		const body = init?.body ? (JSON.parse(String(init.body)) as { model?: string }) : {};
		const value = url.endsWith("/systemone") ? systemOne(url, body.model ?? "") : routes[url.endsWith("/api/show") ? `${url}#${body.model}` : url];
		if (value === undefined) return new Response("not found", { status: 404 });
		if (value instanceof Error) throw value;
		return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
	}) as typeof fetch;
	return { fake, calls };
}

const everything = {
	"http://studio.test/api/v0/models": {
		data: [
			{ id: "kev-4b", type: "decision" },
			{ id: "h2o-lightning-4b", type: "decision" },
			{ id: "big-chat", type: "llm" },
		],
	},
	"http://ollama.test/api/tags": { models: [{ name: "tev1:latest" }, { name: "clef:cloud" }, { name: "chatty:latest" }] },
	"http://ollama.test/api/show#tev1:latest": { capabilities: ["decision"] },
	"http://ollama.test/api/show#clef:cloud": { capabilities: ["decision", "vision"] },
	"http://ollama.test/api/show#chatty:latest": { capabilities: ["completion", "tools"] },
	"http://llama.test/v1/models": {
		data: [
			{ id: "/models/Julia-1-Q8_0.gguf", architecture: { output_modalities: ["decisions"] } },
			{ id: "/models/qwen3-4b-instruct.gguf", architecture: { input_modalities: ["text"] } },
		],
	},
};

describe("classifier detect", () => {
	it("lists each server's decision models from its own model list, and its chat models on llama.cpp", async () => {
		const { fake } = network(everything);
		const detected = await detectClassifiers({ servers: SERVERS, fetch: fake });
		const [studio, ollama, llama] = detected;
		assert.deepEqual(studio?.decisionModels, ["kev-4b", "h2o-lightning-4b"]);
		assert.deepEqual([ollama?.decisionModels, ollama?.cloudModels], [["tev1:latest"], ["clef:cloud"]]);
		assert.deepEqual([llama?.decisionModels, llama?.chatModels], [["/models/Julia-1-Q8_0.gguf"], ["/models/qwen3-4b-instruct.gguf"]]);
		assert.deepEqual(
			detected.map((server) => [server.smoke?.model, server.smoke?.ok]),
			[
				["h2o-lightning-4b", true],
				["tev1:latest", true],
				["/models/Julia-1-Q8_0.gguf", true],
			],
		);
	});

	it("knows which models a server has loaded, and leaves out LM Studio's extra copies of a model", async () => {
		const { fake } = network({
			"http://studio.test/api/v0/models": {
				data: [
					{ id: "h2o-lightning-4b", type: "decision", state: "loaded" },
					{ id: "h2o-lightning-4b:2", type: "decision", state: "loaded" },
					{ id: "kev-4b", type: "decision", state: "not-loaded" },
					{ id: "solo:2", type: "decision", state: "loaded" },
				],
			},
			"http://llama.test/v1/models": {
				data: [
					{ id: "judge", architecture: { output_modalities: ["decisions"] }, status: { value: "loaded" } },
					{ id: "chat", architecture: { output_modalities: ["text"] }, status: { value: "unloaded" } },
				],
			},
		});
		const [studio, llama] = await detectClassifiers({ servers: SERVERS.filter((server) => server.kind !== "ollama"), fetch: fake });
		assert.deepEqual(studio?.decisionModels, ["h2o-lightning-4b", "kev-4b", "solo:2"], "a copy is left out only when its model is listed too");
		assert.deepEqual(studio?.loaded, ["h2o-lightning-4b", "solo:2"]);
		assert.deepEqual([llama?.loaded, llama?.chatModels, llama?.router], [["judge"], ["chat"], true]);
		const [ollama, single] = await detectClassifiers({ servers: SERVERS.filter((server) => server.kind !== "lmstudio"), fetch: network(everything).fake });
		assert.deepEqual([ollama?.loaded, single?.loaded, single?.router], [undefined, undefined, undefined], "lists that do not say what is loaded");
	});

	it("lists one server's models without asking any model anything, for setup's wait", async () => {
		// setup polls every 2 s; a smoke test on each poll made a llama.cpp router load a decision model nobody asked for.
		const { fake, calls } = network(everything);
		const llama = SERVERS.find((server) => server.kind === "llamacpp")!;
		const found = await listModels(llama, { fetch: fake });
		assert.deepEqual(
			[found?.decisionModels, found?.chatModels, found?.smoke],
			[["/models/Julia-1-Q8_0.gguf"], ["/models/qwen3-4b-instruct.gguf"], undefined],
		);
		assert.deepEqual(calls, ["http://llama.test/v1/models"]);
		assert.equal(await listModels({ ...llama, origin: "http://down.test" }, { fetch: fake }), undefined);
	});

	it("prints the config to paste, the eval command, and how to use a chat model", async () => {
		const { fake } = network(everything);
		const text = formatDetect(await detectClassifiers({ servers: SERVERS, fetch: fake }), SERVERS);
		assert.match(text, /LM Studio at http:\/\/studio\.test\n {2}decision models: kev-4b, h2o-lightning-4b\n {2}✓ h2o-lightning-4b answered/);
		assert.match(text, /"model": "lmstudio\/h2o-lightning-4b"/);
		assert.match(text, /then choose its threshold: pi-switchboard classifier eval http:\/\/studio\.test\/v1 h2o-lightning-4b/);
		assert.match(text, /relayed to a cloud, left out: clef:cloud/);
		assert.match(text, /chat models pi's llama\.cpp provider can read as classifiers: \/models\/qwen3-4b-instruct\.gguf/);
		assert.match(text, /export LLAMA_BASE_URL=http:\/\/llama\.test/);
		// pi lists a router's models only once they are loaded.
		assert.match(text, /a llama-server router \(started without a model\)[\s\S]*curl -s http:\/\/llama\.test\/models\/load/);
		assert.doesNotMatch(text, /not running/);
	});

	it("reports a model that does not answer, a server without models, and servers that are not running", async () => {
		const { fake } = network(
			{ "http://studio.test/api/v0/models": { data: [{ id: "kev-4b", type: "decision" }] }, "http://ollama.test/api/tags": { models: [] } },
			() => ({ error: "Model is unloaded" }),
		);
		const detected = await detectClassifiers({ servers: SERVERS, fetch: fake });
		const text = formatDetect(detected, SERVERS);
		assert.match(text, /✗ kev-4b did not answer: System One API/);
		assert.match(text, /Ollama at http:\/\/ollama\.test\n {2}decision models: none\n {2}no models to use yet/);
		assert.match(text, /not running: llama\.cpp \(http:\/\/llama\.test\)/);
		assert.equal(configFor(detected[1] as never), undefined);
	});

	it("says how to start when nothing runs", async () => {
		const { fake } = network({});
		const text = formatDetect(await detectClassifiers({ servers: SERVERS, fetch: fake }), SERVERS);
		assert.match(text, /No classifier server found[\s\S]*classifier setup/);
	});

	it("prefers the best measured decision model, then the first", () => {
		assert.equal(preferredModel(["julia-1", "Tev1:latest", "kev-4b"]), "Tev1:latest");
		assert.equal(preferredModel(["laya", "julia-1"]), "laya");
		assert.equal(preferredModel([]), undefined);
	});

	it("checks its options on the command line", async () => {
		const err: string[] = [];
		const io = { out: () => {}, err: (text: string) => void err.push(text), env: {} };
		assert.equal(await classifierCommand(["detect", "--port", "9"], io), 1);
		assert.match(err.join(""), /unknown option --port/);
	});
});

describe("System One keys outside pi", () => {
	it("reads $NAME from the environment, as pi does for provider keys", () => {
		assert.equal(resolveKey("$PROXY_KEY", { PROXY_KEY: "sk-1" }), "sk-1");
		assert.equal(resolveKey("$UNSET", {}), undefined);
		assert.equal(resolveKey("plain", {}), "plain");
		assert.equal(resolveKey(undefined, {}), undefined);
	});
});
