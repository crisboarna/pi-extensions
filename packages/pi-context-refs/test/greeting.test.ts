import assert from "node:assert/strict";
import { test } from "node:test";
import { greeting } from "../src/greeting.ts";

test("greeting names the working directory", () => {
	assert.equal(greeting("/work"), "pi-context-refs is running in /work");
});
