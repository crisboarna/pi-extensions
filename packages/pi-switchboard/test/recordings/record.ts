// Records the package's exchanges with a real classifier server, for test/integration/classifier-contract.test.ts to replay.
//
//   node test/recordings/record.ts <out.jsonl> <image> [origin]
//
// Start the server first, as `pi-switchboard classifier setup llamacpp` prints (the suites in test/e2e do this in Docker with an image pinned by digest, and
// `docs/classifier-llama-cpp.md` has the command). `image` is what answered (the pinned image reference), written into the recording. The recording holds what
// detect asked and was told, and six classifier requests that were answered. (A server started with one model answers a request that names another, so there is no recorded refusal.)
// Run it again, and commit the new file with the reason, whenever the server image changes or the client asks something new.
import { writeFileSync } from "node:fs";
import { detectClassifiers, knownServers, preferredModel } from "../../src/classifier/detect.ts";
import { BUILTIN_QUESTIONS } from "../../src/classifier/questions.ts";
import { SAMPLE_REQUESTS } from "../../src/classifier/samples.ts";
import { systemOneClassify } from "../../src/classifier/standalone.ts";
import { type Exchange, recordingFetch, toJsonl } from "../support/recording.ts";

const [out, image, origin] = process.argv.slice(2);
if (!out || !image) throw new Error("usage: record.ts <out.jsonl> <image> [origin]");

const catalogued = knownServers().find((server) => server.name === "llamacpp");
if (!catalogued) throw new Error("the server catalog has no llamacpp entry");
const server = { ...catalogued, ...(origin ? { origin } : {}) };

const exchanges: Exchange[] = [];
const recorder = recordingFetch(fetch, exchanges);

const detected = (await detectClassifiers({ servers: [server], fetch: recorder, timeoutMs: 10_000 }))[0];
if (!detected) throw new Error(`nothing answered at ${server.origin}; is the server running?`);
const model = preferredModel(detected.decisionModels);
if (!model) throw new Error(`the server lists no decision model: ${JSON.stringify(detected)}`);
if (!detected.smoke?.ok) throw new Error(`the smoke test failed: ${JSON.stringify(detected.smoke)}`);

const classify = systemOneClassify([{ name: server.name, baseUrl: detected.baseUrl }], recorder);
// Two of each tier the profile routes to, so the recording holds answers that point different ways.
const picks = ["bottom", "middle", "top"].flatMap((tier) => SAMPLE_REQUESTS.filter((sample) => sample.expected === tier).slice(0, 2));
for (const { request } of picks) {
	const answered = await classify(`${server.name}/${model}`, { state: { request }, questions: BUILTIN_QUESTIONS }, { signal: AbortSignal.timeout(120_000) });
	if (answered.stopReason !== "stop") throw new Error(`"${request}" was not answered: ${answered.errorMessage}`);
}
writeFileSync(out, toJsonl({ server: "llama.cpp", image, model, recordedAt: new Date().toISOString().slice(0, 10) }, exchanges));
console.log(`recorded ${exchanges.length} exchanges with ${model} to ${out}`);
