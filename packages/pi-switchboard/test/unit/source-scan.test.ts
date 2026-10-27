import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { parseModelRef } from "../../src/util/model-ref.ts";

const ROOT = join(import.meta.dirname, "..", "..");

function files(dir: string, suffix: string): string[] {
	const out: string[] = [];
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) out.push(...files(path, suffix));
		else if (name.endsWith(suffix)) out.push(path);
	}
	return out;
}

/** Every `provider/id` string found anywhere in a JSON document. */
function modelStrings(value: unknown, out = new Set<string>()): Set<string> {
	if (typeof value === "string") {
		const ref = parseModelRef(value);
		if (ref && !value.includes(" ") && !value.startsWith(".") && !value.startsWith("http")) {
			out.add(`${ref.provider}/${ref.id}`);
			out.add(ref.id);
		}
	} else if (Array.isArray(value)) {
		for (const item of value) modelStrings(item, out);
	} else if (value && typeof value === "object") {
		for (const item of Object.values(value)) modelStrings(item, out);
	}
	return out;
}

/** Ids that appear in examples and fixtures; none may appear in src/. */
function knownIds(): string[] {
	const ids = new Set<string>();
	const sources = [...files(join(ROOT, "examples"), ".json"), ...files(join(ROOT, "test", "fixtures"), ".json")];
	for (const file of sources) modelStrings(JSON.parse(readFileSync(file, "utf8")), ids);
	// Bare provider names from examples are ids too.
	for (const id of [...ids]) if (id.includes("/")) ids.add(id.slice(0, id.indexOf("/")));
	return [...ids].filter((id) => id.length >= 6);
}

describe("source scan", () => {
	it("finds the example ids it guards against", () => {
		const ids = knownIds();
		assert.ok(ids.includes("github-copilot"), "provider names are collected");
		assert.ok(
			ids.some((id) => id.includes("claude-opus")),
			"model ids are collected",
		);
	});

	it("keeps every provider and model id out of src/", () => {
		const ids = knownIds();
		const offenders: string[] = [];
		for (const file of files(join(ROOT, "src"), ".ts")) {
			const text = readFileSync(file, "utf8").toLowerCase();
			for (const id of ids) if (text.includes(id.toLowerCase())) offenders.push(`${file.slice(ROOT.length + 1)}: ${id}`);
		}
		assert.deepEqual(offenders, []);
	});
});
