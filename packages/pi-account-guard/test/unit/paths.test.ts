import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { displayPath, expandTilde, fileName } from "../../src/core/paths.ts";

describe("displayPath", () => {
	it("replaces the home directory with ~", () => {
		assert.equal(displayPath("/home/me", "/home/me"), "~");
		assert.equal(displayPath("/home/me/diary", "/home/me"), "~/diary");
		assert.equal(displayPath("/home/meadow", "/home/me"), "/home/meadow");
		assert.equal(displayPath("/srv/app", "/home/me"), "/srv/app");
	});
});

describe("expandTilde", () => {
	it("expands ~ and ~/ and leaves other paths alone", () => {
		assert.equal(expandTilde("~", "/home/me"), "/home/me");
		assert.equal(expandTilde("~/a/b", "/home/me"), "/home/me/a/b");
		assert.equal(expandTilde("~other/a", "/home/me"), "~other/a");
		assert.equal(expandTilde("/srv/a", "/home/me"), "/srv/a");
	});
});

describe("fileName", () => {
	it("is the part after the last slash", () => {
		assert.equal(fileName("/home/me/.pi/agent/account-guard.json"), "account-guard.json");
		assert.equal(fileName("account-guard.json"), "account-guard.json");
	});
});
