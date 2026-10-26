import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ROOT } from "../support/source-scan.ts";

const skill = readFileSync(join(ROOT, "skills", "pi-account-guard", "SKILL.md"), "utf8");
const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { files: string[]; pi: { skills?: string[] } };

describe("the bundled skill", () => {
	it("is shipped and registered with pi", () => {
		assert.deepEqual(manifest.pi.skills, ["./skills"]);
		assert.ok(manifest.files.includes("skills"));
		assert.match(skill, /^---\nname: pi-account-guard\ndescription: .+\n---\n/);
	});

	it("names the process override and Allow for session only to rule them out", () => {
		const lines = skill.split("\n").filter((line) => /PI_ACCOUNT_GUARD_ALLOW_UNKNOWN|Allow for session/.test(line) && !/Switch rows/.test(line));
		assert.ok(lines.length > 0);
		for (const line of lines) assert.match(line, /^- Never /, line);
	});

	it("proposes only /guard commands that exist, in their documented form", () => {
		for (const command of skill.match(/`\/guard [^`]*`/g) ?? []) assert.match(command, /^`\/guard (check|place add|tag) /, command);
		assert.doesNotMatch(skill, /place add here\b/);
	});
});
