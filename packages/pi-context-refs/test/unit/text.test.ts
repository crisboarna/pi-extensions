import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { printable } from "../../src/core/text.ts";

describe("printable", () => {
	it("keeps ordinary text, tabs and line feeds", () => {
		assert.equal(printable("one\ttwo\nthree é世"), "one\ttwo\nthree é世");
	});

	it("turns an escape, a carriage return and other control characters into question marks", () => {
		assert.equal(printable("a\u001b[31mred\r\u0007b"), "a?[31mred??b");
	});
});
