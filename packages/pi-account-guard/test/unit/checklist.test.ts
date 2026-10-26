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
