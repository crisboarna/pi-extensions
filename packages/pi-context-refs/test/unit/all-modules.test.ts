// Imports every module under src/, so the coverage run measures files that no
// other test loads (node --test only reports files it saw).
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const SRC = join(import.meta.dirname, "..", "..", "src");

test("every source module loads", async () => {
	const files = readdirSync(SRC, { recursive: true, encoding: "utf8" }).filter((file) => file.endsWith(".ts"));
	assert.ok(files.length > 0);
	for (const file of files) await import(pathToFileURL(join(SRC, file)).href);
});
