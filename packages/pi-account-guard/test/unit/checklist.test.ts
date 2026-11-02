import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createChecklist } from "../../src/core/checklist.ts";

const make = () => createChecklist("Which zones?", ["work", "personal", "lab"]);

describe("createChecklist", () => {
	it("starts with nothing checked and the cursor on the first option", () => {
		assert.deepEqual(make().lines(), [
			"Which zones?",
			"",
			"> [ ] work",
			"  [ ] personal",
			"  [ ] lab",
			"",
			"up/down move, space checks, enter confirms, esc cancels",
		]);
	});

	it("checks and unchecks the option under the cursor", () => {
		const list = make();
		list.press("toggle");
		list.press("down");
		list.press("down");
		list.press("toggle");
		assert.deepEqual(list.lines().slice(2, 5), ["  [x] work", "  [ ] personal", "> [x] lab"]);
		list.press("toggle");
		assert.deepEqual(list.lines().slice(4, 5), ["> [ ] lab"]);
	});

	it("keeps the cursor inside the list", () => {
		const list = make();
		list.press("up");
		assert.equal(list.lines()[2], "> [ ] work");
		for (let step = 0; step < 5; step++) list.press("down");
		assert.equal(list.lines()[4], "> [ ] lab");
	});

	it("submits the checked options in list order", () => {
		const list = make();
		list.press("down");
		list.press("down");
		list.press("toggle");
		list.press("up");
		list.press("up");
		list.press("toggle");
		assert.deepEqual(list.press("submit"), { done: ["work", "lab"] });
	});

	it("asks again when nothing is checked", () => {
		const list = make();
		assert.equal(list.press("submit"), undefined);
		assert.equal(list.lines().at(-1), "Check at least one zone, or press esc to cancel.");
		list.press("toggle");
		assert.deepEqual(list.press("submit"), { done: ["work"] });
	});

	it("cancels with no zones", () => {
		const list = make();
		list.press("toggle");
		assert.deepEqual(list.press("cancel"), { done: undefined });
	});
});

describe("createChecklist with a line limit", () => {
	const options = Array.from({ length: 12 }, (_, index) => `zone${String(index + 1).padStart(2, "0")}`);
	const make12 = () => createChecklist("Which zones?", options);
	const optionRows = (lines: string[]) => lines.filter((line) => line.includes("[ ]") || line.includes("[x]"));

	it("draws every option when they fit, however high the limit", () => {
		assert.deepEqual(make12().lines(100), make12().lines());
		assert.deepEqual(make12().lines(16), make12().lines(), "16 lines are exactly the 12 options and the 4 around them");
	});

	it("shows a window from the first option with a mark for what is below, and never more lines than the limit", () => {
		const lines = make12().lines(10);
		assert.ok(lines.length <= 10, `${lines.length} lines`);
		assert.equal(lines[0], "Which zones?");
		assert.equal(lines.at(-1), "up/down move, space checks, enter confirms, esc cancels");
		assert.deepEqual(optionRows(lines), ["> [ ] zone01", "  [ ] zone02", "  [ ] zone03", "  [ ] zone04"]);
		assert.ok(lines.includes("  ↓ 8 more"));
		assert.ok(!lines.some((line) => line.includes("↑")));
	});

	it("keeps the cursor inside the window with a mark on each side in the middle of the list", () => {
		const list = make12();
		for (let step = 0; step < 6; step++) list.press("down");
		const lines = list.lines(10);
		assert.ok(lines.length <= 10);
		assert.ok(
			optionRows(lines).some((row) => row.startsWith("> [ ] zone07")),
			"the cursor row is shown",
		);
		assert.ok(lines.some((line) => /↑ \d+ more/.test(line)));
		assert.ok(lines.some((line) => /↓ \d+ more/.test(line)));
	});

	it("ends on the last option with a mark for what is above and none below", () => {
		const list = make12();
		for (let step = 0; step < 20; step++) list.press("down");
		const lines = list.lines(10);
		assert.deepEqual(optionRows(lines).at(-1), "> [ ] zone12");
		assert.ok(lines.some((line) => /↑ \d+ more/.test(line)));
		assert.ok(!lines.some((line) => line.includes("↓")));
	});

	it("still shows the cursor's option when the limit leaves no room for others", () => {
		const list = make12();
		list.press("down");
		const lines = list.lines(1);
		assert.ok(optionRows(lines).some((row) => row.startsWith("> [ ] zone02")));
	});

	it("keeps what was checked while the window moves", () => {
		const list = make12();
		list.press("toggle");
		for (let step = 0; step < 11; step++) list.press("down");
		list.press("toggle");
		assert.deepEqual(list.press("submit"), { done: ["zone01", "zone12"] });
	});
});
