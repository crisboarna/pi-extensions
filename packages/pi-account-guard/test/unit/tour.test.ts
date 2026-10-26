import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FIRST_RUN_NOTICE, TOUR_STEPS } from "../../src/core/tour.ts";
import { runTour } from "../../src/pi/tour.ts";

function fakeContext(hasUI: boolean, answers: Array<string | undefined>) {
	const selects: Array<{ title: string; options: string[] }> = [];
	const notices: string[] = [];
	return {
		selects,
		notices,
		ctx: {
			hasUI,
			ui: {
				select: async (title: string, options: string[]) => {
					selects.push({ title, options });
					return answers.shift();
				},
				notify: (message: string) => void notices.push(message),
			},
		},
	};
}

describe("/guard tour", () => {
	it("has four steps whose samples come from the guard's own checks", () => {
		assert.deepEqual(
			TOUR_STEPS.map((step) => step.title),
			["What pi-account-guard does", "How a turn is checked", "When a turn is blocked", "Where to look"],
		);
		const checked = TOUR_STEPS[1]!.lines.join("\n");
		assert.match(checked, /Place {5}~\/work\/api -> work \(rule 1: remote \*\/acme-corp\/\*\)/);
		assert.match(checked, /Verdict {3}a turn here would go/);
		assert.match(checked, /Verdict {3}a turn here would be blocked: acme \(oauth\) is zone work, this place is personal/);
		const blocked = TOUR_STEPS[2]!.lines.join("\n");
		assert.match(blocked, /BLOCKED {2}acme \(oauth\) is zone work\nPlace ~\/garden -> zone personal/);
		assert.match(blocked, /Switch to homelab \(oauth\) -> home-model {2}\[personal\]/);
		assert.match(TOUR_STEPS[3]!.lines.join("\n"), /\/guard check <path\|here>/);
	});

	it("pages through the steps in the TUI and stops at Close", async () => {
		const all = fakeContext(true, ["Next →", "Next →", "Next →", "Close"]);
		assert.equal(await runTour(all.ctx), 4);
		assert.match(all.selects[0]!.title, /^pi-account-guard tour 1\/4: What pi-account-guard does/);
		assert.deepEqual(all.selects[3]!.options, ["Close"]);
		const early = fakeContext(true, ["Close"]);
		assert.equal(await runTour(early.ctx), 1);
	});

	it("prints every step without the TUI", async () => {
		const plain = fakeContext(false, []);
		assert.equal(await runTour(plain.ctx), 4);
		assert.match(plain.notices[0]!, /^1\/4 What pi-account-guard does[\s\S]*4\/4 Where to look/);
	});

	it("has a first-run notice that says accounts start untagged and where to look", () => {
		assert.match(FIRST_RUN_NOTICE, /untagged/);
		assert.match(FIRST_RUN_NOTICE, /\/guard tour/);
	});
});
