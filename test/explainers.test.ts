// The site's static explainers run the packages' own code; these tests hold
// them to the same answers as the commands they explain: /guard check and
// /tier try with typed answers.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import * as nodePath from "node:path";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath as nodeFileURLToPath } from "node:url";
import { registerGuard } from "../packages/pi-account-guard/src/pi/hooks.ts";
import { attachDialogs } from "../packages/pi-account-guard/test/support/fake-dialogs.ts";
import { createFakeHost, createFakeSession } from "../packages/pi-account-guard/test/support/fake-pi.ts";
import { builtinRefs } from "../packages/pi-context-refs/src/core/builtins.ts";
import { collapseTail } from "../packages/pi-context-refs/src/core/collapse.ts";
import { type ExpandEnv, expandRefs } from "../packages/pi-context-refs/src/core/expand.ts";
import { parseLibrary } from "../packages/pi-context-refs/src/core/library.ts";
import { pickerRows } from "../packages/pi-context-refs/src/core/picker.ts";
import { resolveRefs } from "../packages/pi-context-refs/src/core/resolve.ts";
import type { RawConfig } from "../packages/pi-switchboard/src/config/types.ts";
import type { Answers } from "../packages/pi-switchboard/src/rules/types.ts";
import { engine, RAW } from "../packages/pi-switchboard/test/support/engine.ts";
import { ROOT } from "../scripts/lib/repo.ts";
import { explainGuard, type GuardQuestion } from "../tools/site/explainers/account-guard.ts";
import { ShimBuffer } from "../tools/site/explainers/buffer-shim.ts";
import { explainMessage, type RefQuestion, truncateHead } from "../tools/site/explainers/context-refs.ts";
import { createHash } from "../tools/site/explainers/node-crypto.ts";
import { dirname, isAbsolute, join as joinPath, relative, resolve, sep } from "../tools/site/explainers/node-path.ts";
import { fileURLToPath } from "../tools/site/explainers/node-url.ts";
import { routeAnswers } from "../tools/site/explainers/switchboard.ts";

const HOME = "/home/me";
const example = readFileSync(join(ROOT, "packages", "pi-account-guard", "examples", "account-guard.json"), "utf8");

/** The text `/guard check <directory> <provider> <source>` prints for the same file and remotes. */
async function guardCheck(question: GuardQuestion): Promise<string | undefined> {
	const host = createFakeHost();
	const session = createFakeSession({ cwd: HOME, model: null, hasUI: true });
	const dialogs = attachDialogs(host, session, []);
	registerGuard(dialogs.pi as never, {
		home: HOME,
		configPath: `${HOME}/.pi/agent/account-guard.json`,
		readConfigText: () => (question.configText.trim() === "" ? undefined : question.configText),
		realpath: (path) => path,
		readRemoteUrls: () => ({ ok: true, urls: question.remotes }),
		writeStderr: () => {},
		setExitCode: () => {},
	});
	await host.commands.get("guard")!.handler(`check ${question.directory} ${question.provider} ${question.source}`, session.ctx);
	return session.notices.at(-1)?.message;
}

describe("account-guard's config tester", () => {
	const cases: Array<Omit<GuardQuestion, "home">> = [
		{ configText: example, directory: "~/work/billing", remotes: [], provider: "openai-codex-2", source: "oauth" },
		{ configText: example, directory: "~/src/api", remotes: ["git@github.com:my-company/api.git"], provider: "openai-codex-2", source: "oauth" },
		{ configText: example, directory: "~/garden", remotes: ["https://github.com/me/garden.git"], provider: "openai-codex-2", source: "oauth" },
		{ configText: example, directory: "~/garden", remotes: [], provider: "homelab", source: "env:HOMELAB_KEY" },
		{ configText: "", directory: "/srv/tools", remotes: [], provider: "homelab", source: "oauth" },
	];
	for (const question of cases)
		it(`answers like /guard check for ${question.directory} and ${question.provider}`, async () => {
			const answer = explainGuard({ ...question, home: HOME });
			assert.ok(answer.ok);
			assert.equal(answer.text, await guardCheck({ ...question, home: HOME }));
		});

	it("names the rule, the zone and the verdict, and reports a malformed file", () => {
		const remote = explainGuard({ ...cases[1]!, home: HOME });
		assert.deepEqual(remote.ok && [remote.zone, remote.rule, remote.verdict], ["work", 0, "match"]);
		const broken = explainGuard({ ...cases[0]!, configText: '{ "zones": ["work"], "defaultZone": "home" }', home: HOME });
		assert.ok(!broken.ok);
		assert.match(broken.errors.join("\n"), /account-guard\.json: defaultZone/);
	});

	it("resolves paths in the browser as node:path does", () => {
		assert.equal(resolve("/home/me", "~/x".replace("~", "/home/me")), "/home/me/x");
		assert.equal(resolve("/home/me/garden", "../work/./api/"), "/home/me/work/api");
		assert.equal(resolve("/a", "/b", "c"), "/b/c");
	});
});

const typed = (work: string, workConfidence: number, depth: number, risky: number): Answers => ({
	work: { type: "choice", choice: work, probabilities: { [work]: workConfidence }, confidence: workConfidence },
	depth: { type: "score", score: depth, confidence: 1 },
	risky: { type: "bool", probability: risky },
});

describe("pi-switchboard's rule playground", () => {
	const grid: Answers[] = [];
	for (const work of ["mechanical", "research", "implement", "plan", "review"])
		for (const depth of [0.2, 1, 1.8])
			for (const risky of [0.05, 0.9]) for (const confidence of [0.95, 0.5]) grid.push(typed(work, confidence, depth, risky));

	const configs: Array<[string, RawConfig]> = [
		["the test config", RAW],
		...readdirSync(join(ROOT, "packages", "pi-switchboard", "examples")).map((file): [string, RawConfig] => [
			`examples/${file}`,
			JSON.parse(readFileSync(join(ROOT, "packages", "pi-switchboard", "examples", file), "utf8")) as RawConfig,
		]),
	];
	for (const [label, raw] of configs)
		it(`gives the tier and rule /tier try gives, for ${grid.length} typed answers on ${label}`, async () => {
			const { e } = engine({ raw });
			for (const answers of grid) {
				const preview = await e.preview("x", { answers });
				const played = routeAnswers({ configText: JSON.stringify(raw), answers });
				assert.ok(played.ok && preview);
				assert.equal(played.decision.tier, preview.tier.chosen, JSON.stringify(answers));
				assert.equal(played.outcome.ruleIndex, preview.rules?.matched, JSON.stringify(answers));
			}
		});

	it("reports a config that is not JSON or has no valid profile", () => {
		const broken = routeAnswers({ configText: "{", answers: typed("plan", 1, 1, 0) });
		assert.ok(!broken.ok);
		assert.match(broken.errors[0]!, /not JSON/);
		const empty = routeAnswers({ configText: "{}", answers: typed("plan", 1, 1, 0) });
		assert.ok(!empty.ok);
	});
});

const refsLibrary = readFileSync(join(ROOT, "packages", "pi-context-refs", "examples", "pi-context-refs.json"), "utf8");
const refsQuestion: RefQuestion = {
	libraryText: refsLibrary,
	files: {
		"src/api.ts": "export const fetchOrders = () => retry(get);\n",
		"src/retry.ts": "export const attempts = 2;\n",
		"NOTES.md": "# Notes\n",
		"logs/server.log": { line: "line {n}", lines: 2500 },
	},
	commandOutput: { "git diff": "-attempts = 2\n+attempts = 3", "git status --short": " M src/retry.ts" },
	message: "",
	query: "",
	inWorkTree: true,
};

/** The same send through the core with its own in-memory environment: the page's answer must equal it. */
async function directSend(question: RefQuestion) {
	const library = parseLibrary(question.libraryText, "~/.pi/agent/pi-context-refs.json");
	assert.ok(library.ok);
	const layered = resolveRefs(
		{ global: library.refs, project: [], builtin: builtinRefs(true) },
		{ cwd: "/work/project", home: "/home/you", realpath: (path) => path, remotes: () => [] },
	);
	const files = new Map(
		Object.entries(question.files).map(([path, spec]) => [
			`/work/project/${path}`,
			typeof spec === "string" ? spec : Array.from({ length: spec.lines }, (_, index) => spec.line.replace("{n}", String(index + 1))).join("\n"),
		]),
	);
	const env: ExpandEnv = {
		cwd: "/work/project",
		home: "/home/you",
		readFile: async (path, limit) => new TextEncoder().encode(files.get(path) ?? "").subarray(0, limit),
		truncateHead,
		imageType: async () => null,
		layers: layered.layers,
		approve: async () => ({ allowed: true }),
		runCommand: async (request) => ({ stdout: question.commandOutput[request.argv.join(" ")] ?? "", stderr: "", code: 0, killed: false }),
		isGitWorkTree: async () => true,
		fetchUrl: async () => {
			throw new Error("no URL refs");
		},
	};
	const expansion = await expandRefs(question.message, layered.visible, env);
	const picker = pickerRows({ visible: layered.visible, layers: layered.layers, inWorkTree: true }, question.query);
	return { text: expansion.text, collapsed: collapseTail(expansion.text), picker };
}

describe("pi-context-refs' ref playground", () => {
	for (const [message, query] of [
		["Why does [ref:api] retry twice?", ""],
		["Review #diff and #status", "di"],
		["Is there a race in #tag:backend?", "back"],
		["Answer with [ref:terse] after reading [ref:notes]", "n"],
	] as const)
		it(`gives the picker rows, text and transcript line the core gives for "${message}"`, async () => {
			const question = { ...refsQuestion, message, query };
			const played = await explainMessage(question);
			const direct = await directSend(question);
			assert.ok(played.ok);
			assert.equal(played.text, direct.text);
			assert.equal(played.collapsed, direct.collapsed);
			assert.deepEqual(
				played.picker,
				direct.picker.map(({ mark, name, kind, description, section }) => ({ mark, name, kind, description, section })),
			);
			assert.match(played.listText, /^pi-context-refs\n/);
		});

	it("sends the blocks of a bundle and collapses them to one line each", async () => {
		const played = await explainMessage({ ...refsQuestion, message: "Check #tag:backend" });
		assert.ok(played.ok);
		assert.deepEqual(played.tokens, [{ text: "#tag:backend", status: "resolved", kind: "bundle" }]);
		assert.match(played.collapsed, /▸ ref api \(file, /);
		assert.match(played.collapsed, /▸ ref retry \(file, /);
	});

	it("leaves an unknown ref as typed", async () => {
		const played = await explainMessage({ ...refsQuestion, message: "Compare [ref:api] with [ref:missing] and #nothing" });
		assert.ok(played.ok);
		assert.deepEqual(
			played.tokens.map((token) => [token.text, token.status]),
			[
				["[ref:api]", "resolved"],
				["[ref:missing]", "unknown"],
				["#nothing", "unknown"],
			],
		);
		assert.match(played.text, /\[ref:missing\] and #nothing/);
		assert.doesNotMatch(played.text, /name="missing"/);
	});

	it("cuts a File over the caps and says where the read tool continues", async () => {
		const played = await explainMessage({ ...refsQuestion, message: "What failed in [ref:server-log]?" });
		assert.ok(played.ok);
		assert.match(played.text, /Truncated at 2000 lines: showing lines 1-2000 of 2500/);
		assert.doesNotMatch(played.text, /line 2001\b/);
		assert.match(played.text, /truncated="2000 lines"/);
	});

	it("reports a missing file as a failure and a command with no canned output as a failed command", async () => {
		const played = await explainMessage({ ...refsQuestion, files: {}, commandOutput: {}, message: "See [ref:api] and #log" });
		assert.ok(played.ok);
		assert.deepEqual(
			played.failures.map((failure) => failure.name),
			["api"],
		);
		assert.match(played.text, /name="log" kind="dynamic" source="git log --oneline -20" bytes="\d+" exit="1"/);
	});

	it("hides the Built-in Refs outside a git work tree and reports a library that does not parse", async () => {
		const outside = await explainMessage({ ...refsQuestion, inWorkTree: false });
		assert.ok(outside.ok);
		assert.ok(!outside.picker.some((row) => row.section === "builtin"));
		const broken = await explainMessage({ ...refsQuestion, libraryText: "{" });
		assert.ok(!broken.ok);
		assert.match(broken.error, /does not parse/);
	});

	it("cuts by bytes when a text is long but has few lines", () => {
		const cut = truncateHead("x".repeat(100), { maxBytes: 10 });
		assert.deepEqual([cut.truncated, cut.truncatedBy, cut.firstLineExceedsLimit], [true, "bytes", true]);
	});

	it("supplies the Buffer methods the core reads a transcript with", () => {
		const shim = ShimBuffer.from("a\n<b>é");
		assert.equal(shim.indexOf(ShimBuffer.from("<b>")), 2);
		assert.equal(shim.indexOf(0x0a, 0), 1);
		assert.equal(shim.indexOf(ShimBuffer.from("zz")), -1);
		assert.equal(shim.subarray(2, 5).toString(), "<b>");
		assert.ok(ShimBuffer.from("ab").equals(ShimBuffer.from("ab")));
		assert.ok(!ShimBuffer.from("ab").equals(ShimBuffer.from("ac")));
		assert.equal(ShimBuffer.byteLength("é"), Buffer.byteLength("é"));
	});

	it("matches node:path and node:url on the calls the core makes, and has no hashing", () => {
		const cases: Array<[string, string]> = [
			["/work/project", "src/api.ts"],
			["/work/project/src", "../x/./y"],
			["/a/b", "/a/b/c"],
		];
		for (const [base, rest] of cases) {
			assert.equal(joinPath(base, rest), nodePath.join(base, rest));
			assert.equal(relative(base, resolve(base, rest)), nodePath.relative(base, nodePath.resolve(base, rest)));
		}
		for (const path of ["/a/b/c", "/a", "a/b", "a", "/a/b/"]) assert.equal(dirname(path), nodePath.dirname(path), path);
		assert.equal(joinPath("a", "..", "b"), nodePath.join("a", "..", "b"));
		assert.equal(joinPath("/", "..", "b"), nodePath.join("/", "..", "b"));
		assert.deepEqual([isAbsolute("/x"), isAbsolute("x"), sep], [true, false, "/"]);
		assert.equal(fileURLToPath("file:///a/b%20c"), nodeFileURLToPath("file:///a/b%20c"));
		assert.throws(() => createHash("sha256"), /not available/);
	});
});
