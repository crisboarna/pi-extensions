import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BUILTIN_QUESTIONS } from "../../src/classifier/questions.ts";
import { type DoctorFacts, doctorLines } from "../../src/commands/doctor.ts";
import { runTour, TOUR_STEPS } from "../../src/commands/tour.ts";
import { formatPreview, parseTryArgs } from "../../src/commands/try.ts";
import { TYPED_ANSWERS } from "../../src/router/engine.ts";
import { answers, engine } from "../support/engine.ts";

describe("/tier try arguments", () => {
	it("reads leading typed answers and keeps the rest as the request", () => {
		const parsed = parseTryArgs(["work=plan", "depth=deep", "risky=yes", "design", "the", "cache"], BUILTIN_QUESTIONS);
		assert.equal(parsed.text, "design the cache");
		assert.deepEqual(parsed.errors, []);
		assert.deepEqual(parsed.answers?.work, { type: "choice", choice: "plan", probabilities: { plan: 1 }, confidence: 1 });
		assert.deepEqual(parsed.answers?.depth, { type: "score", score: 2, confidence: 1 });
		assert.deepEqual(parsed.answers?.risky, { type: "bool", probability: 1 });
	});

	it("accepts numbers and probabilities, stops at --, and leaves unknown keys in the request", () => {
		const parsed = parseTryArgs(["depth=1.4", "risky=0.2", "--", "work=plan", "is", "text"], BUILTIN_QUESTIONS);
		assert.deepEqual(
			[parsed.text, parsed.answers?.depth, parsed.answers?.risky],
			["work=plan is text", { type: "score", score: 1.4, confidence: 1 }, { type: "bool", probability: 0.2 }],
		);
		const unknown = parseTryArgs(["color=red", "paint", "it"], BUILTIN_QUESTIONS);
		assert.deepEqual([unknown.text, unknown.answers], ["color=red paint it", undefined]);
		assert.equal(parseTryArgs(["risky=no", "x"], BUILTIN_QUESTIONS).answers?.risky?.type, "bool");
	});

	it("reports values a question cannot take", () => {
		const parsed = parseTryArgs(["work=dance", "depth=lots", "risky=maybe", "x"], BUILTIN_QUESTIONS);
		assert.equal(parsed.errors.length, 3);
		assert.match(parsed.errors[0] ?? "", /^work expects one of plan, research/);
		assert.match(parsed.errors[1] ?? "", /^depth expects a number or one of shallow, moderate, deep/);
		assert.match(parsed.errors[2] ?? "", /^risky expects yes, no or a probability/);
		const unlabelled = parseTryArgs(["level=lots"], { level: { type: "score", instructions: "?", criteria: ["a", "b"] } });
		assert.deepEqual(unlabelled.errors, ["level expects a number"]);
	});
});

describe("engine preview", () => {
	it("routes with the classifier and changes no health, pointers or state", async () => {
		const { e, deps } = engine({ classify: async () => ({ stopReason: "stop", answers: answers("plan") }) });
		const before = JSON.stringify(deps.store.read());
		const decision = await e.preview("design the billing service");
		assert.deepEqual([decision?.tier.chosen, decision?.model.id, decision?.classifier?.model], ["deep", "big", "local/judge"]);
		assert.equal(JSON.stringify(deps.store.read()), before);
		assert.equal(e.recent.length, 0, "nothing is recorded");
	});

	it("uses typed answers instead of the classifier and ignores dry-run", async () => {
		let called = 0;
		const { e } = engine({
			classify: async () => {
				called++;
				return { stopReason: "error", errorMessage: "down" };
			},
		});
		e.controls.dryRun = true;
		e.originModel = "acme/mid";
		const decision = await e.preview("rename foo", { answers: answers("mechanical", 0.99, 0.2) });
		assert.deepEqual([decision?.tier.chosen, decision?.classifier?.model, called], ["light", TYPED_ANSWERS, 0]);
	});

	it("formats the preview, with a hint when the classifier did not answer", async () => {
		const { e } = engine({ classify: async () => ({ stopReason: "error", errorMessage: "connection refused" }) });
		const lines = formatPreview("fix it", await e.preview("fix it"), false);
		assert.match(lines.join("\n"), /tier: standard/);
		assert.match(lines.join("\n"), /The classifier did not answer \(classifier-error\).*\/tier try work=plan depth=1\.8 risky=no fix it/);
		assert.equal(lines.at(-1), "Nothing ran; health, cooldowns and routing state are unchanged.");
		const typed = formatPreview("x".repeat(100), await e.preview("x", { answers: answers("plan") }), true);
		assert.match(typed[0] ?? "", /\.\.\."$/);
		assert.match(typed.join("\n"), /answers: work=plan \(0\.95\), depth=1\.00, risky=no \(0\.10\) \[typed answers\]/);
		assert.match(typed.join("\n"), /rule: builtin rule \d, gate 0\.95 vs 0\.8 passed/);
		assert.deepEqual(formatPreview("x", undefined, false), ['/tier try: nothing would be routed for "x"']);
	});

	it("says when switchboard is inactive and when the gate fails", async () => {
		const inactive = engine({ raw: { profiles: {} } });
		inactive.e.originModel = "acme/mid";
		assert.match(formatPreview("x", await inactive.e.preview("x"), false).join("\n"), /switchboard is inactive/);
		const { e } = engine({ classify: async () => ({ stopReason: "stop", answers: answers("plan", 0.2) }) });
		assert.match(formatPreview("x", await e.preview("x"), false).join("\n"), /failed, so the fallback tier/);
	});
});

const healthy: DoctorFacts = {
	missingConfig: false,
	sources: ["/home/dev/.pi/agent/pi-switchboard.json"],
	profiles: [{ name: "work", tiers: 3, members: 4, disabled: [] }],
	invalidProfiles: [],
	classifiers: [{ model: "local/judge", registered: true, local: true, allowRemote: false, probe: { ok: true, ms: 210 } }],
	routingSelected: true,
	subagents: { enabled: true },
	footer: true,
	quotaProviders: ["acme"],
	piUsage: true,
	warnings: [],
};

describe("/tier doctor", () => {
	it("reports a healthy setup", () => {
		const lines = doctorLines(healthy);
		assert.equal(lines[0], "pi-switchboard doctor: everything looks right");
		for (const expected of [
			"✓ config:",
			"✓ profile work: 3 tiers, 4 members",
			"✓ classifier local/judge answered in 210 ms",
			"✓ a switchboard model is selected",
			"✓ subagents are routed inside their children",
			"✓ the footer shows the tier",
			"✓ pi-usage provides quota for acme",
		])
			assert.ok(
				lines.some((line) => line.startsWith(expected)),
				expected,
			);
	});

	it("puts problems first and says what to do about each", () => {
		const lines = doctorLines({
			...healthy,
			missingConfig: true,
			blocked: "@alexeiled/pi-model-router",
			profiles: [{ name: "work", tiers: 1, members: 2, disabled: ["acme/x in light is disabled (not in pi's model catalog)"] }],
			invalidProfiles: [{ name: "broken", errors: ["needs at least one tier"] }],
			classifiers: [
				{ model: "local/gone", registered: false, local: true, allowRemote: false },
				{ model: "cloud/judge", registered: true, local: false, allowRemote: false },
				{ model: "local/down", registered: true, local: true, allowRemote: false, probe: { ok: false, ms: 5000, error: "aborted" } },
				{ model: "local/quiet", registered: true, local: true, allowRemote: false, probe: { ok: false, ms: 1 } },
				{ model: "local/unprobed", registered: true, local: true, allowRemote: false },
			],
			routingSelected: false,
			subagents: { enabled: true, launchModeReason: "subagents.mode is launch" },
			footer: false,
			piUsage: false,
			warnings: ["Plannotator sets a model for planning"],
		});
		assert.equal(lines[0], "pi-switchboard doctor: 6 problem(s), 7 warning(s)");
		assert.match(lines[1] ?? "", /^✗ no config yet: run \/tier init/);
		const text = lines.join("\n");
		for (const expected of [
			/✗ @alexeiled\/pi-model-router is installed too/,
			/✗ profile broken is invalid: needs at least one tier/,
			/✗ classifier local\/gone is not registered/,
			/! classifier cloud\/judge is remote and skipped/,
			/✗ classifier local\/down did not answer \(aborted\)/,
			/✗ classifier local\/quiet did not answer \(no answer\)/,
			/! not routing: pick switchboard\/auto/,
			/! subagents use launch-time models: subagents.mode is launch/,
			/! the footer does not show the tier/,
			/! quota strategies for acme without pi-usage/,
			/! Plannotator sets a model for planning/,
			/! profile work: acme\/x in light is disabled/,
		])
			assert.match(text, expected);
		assert.ok(!text.includes("local/unprobed"));
	});

	it("covers no classifiers, subagents off and no quota strategies", () => {
		const text = doctorLines({ ...healthy, classifiers: [], subagents: { enabled: false }, quotaProviders: [] }).join("\n");
		assert.match(text, /✗ no classifier configured/);
		assert.match(text, /✓ subagent routing is off/);
		assert.ok(!text.includes("pi-usage"));
	});
});

describe("/tier tour", () => {
	it("prints every step without the TUI", async () => {
		const notes: string[] = [];
		const shown = await runTour({ hasUI: false, ui: { notify: (message: string) => notes.push(message) } } as never);
		assert.equal(shown, TOUR_STEPS.length);
		assert.match(notes[0] ?? "", /^1\/5 What pi-switchboard does/);
		assert.match(notes[0] ?? "", /5\/5 Where to look/);
		assert.match(notes[0] ?? "", /provider-b\/mid-model/);
	});

	it("steps through dialogs until closed", async () => {
		const answers = ["Next →", "Next →", "Close"];
		const titles: string[] = [];
		const ui = {
			select: async (title: string, options: string[]) => {
				titles.push(title);
				assert.ok(options.includes("Close"));
				return answers.shift();
			},
		};
		assert.equal(await runTour({ hasUI: true, ui } as never), 3);
		assert.match(titles[2] ?? "", /^pi-switchboard tour 3\/5: When an account hits its limit/);
		const all = ["Next →", "Next →", "Next →", "Next →", "Close"];
		assert.equal(await runTour({ hasUI: true, ui: { select: async () => all.shift() } } as never), 5);
	});
});
