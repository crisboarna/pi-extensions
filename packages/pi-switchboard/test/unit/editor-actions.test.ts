import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { RawConfig } from "../../src/config/types.ts";
import { type EditorUi, runTierEditor, stableStringify } from "../../src/tui/editor.ts";

/** Answers the editor's dialogs from a script, in order, and fails on an answer that is not offered. */
function scripted(answers: Array<string | boolean | undefined>): EditorUi & { notes: string[]; left: () => number } {
	const queue = [...answers];
	const notes: string[] = [];
	const next = () => queue.shift();
	return {
		notes,
		left: () => queue.length,
		select: async (_title, options) => {
			const answer = next();
			if (typeof answer === "string" && !options.includes(answer)) throw new Error(`"${answer}" is not one of: ${options.join(" | ")}`);
			return answer as string | undefined;
		},
		input: async () => next() as string | undefined,
		confirm: async () => next() === true,
		notify: (message) => notes.push(message),
	};
}

const raw = (): RawConfig =>
	({
		version: 1,
		custom: { kept: true },
		profiles: {
			work: {
				fallbackTier: "standard",
				tiers: {
					standard: { rank: 1, members: ["acme/mid", { model: "zen/small", weight: 2, enabled: false }] },
					deep: { rank: 2, members: ["acme/big"] },
				},
			},
		},
		profileSelection: { default: "work", rules: [{ profile: "work", matchProvider: "acme" }] },
	}) as unknown as RawConfig;
const models = ["acme/big", "acme/mid", "zen/small"];
const pathIn = () => join(mkdtempSync(join(tmpdir(), "switchboard-editor-actions-")), "pi-switchboard.json");

describe("tier editor actions", () => {
	it("edits members, tiers and profiles, then saves", async () => {
		const path = pathIn();
		const ui = scripted([
			"profile: work (default)",
			"tier: standard",
			"members",
			"1. acme/mid",
			"thinking level",
			"high",
			"1. acme/mid",
			"weight",
			"3",
			"1. acme/mid ×3",
			"move down",
			"1. zen/small (disabled) ×2",
			"enable",
			"1. zen/small ×2",
			"move up",
			"1. zen/small ×2",
			"← back",
			"+ add member",
			undefined,
			"← back",
			"rank",
			"5",
			"rename",
			"base",
			"← back",
			"tier: deep",
			"delete tier",
			true,
			"fallback tier",
			"(default)",
			"baseline tier",
			"base",
			"direct tier",
			"@bottom",
			"rename",
			"main",
			"← back",
			"+ new profile",
			"spare",
			"zen/small",
			"delete profile",
			true,
			"✓ save and close",
			true,
		]);
		assert.equal(await runTierEditor(ui, { path, raw: raw(), models }), true);
		assert.equal(ui.left(), 0, "every scripted answer was used");
		const saved = JSON.parse(readFileSync(path, "utf8")) as RawConfig & { custom?: unknown };
		const main = saved.profiles?.main;
		assert.deepEqual(Object.keys(saved.profiles ?? {}), ["main"]);
		assert.deepEqual(main?.tiers, {
			base: {
				rank: 5,
				members: [
					{ model: "zen/small", weight: 2, enabled: true },
					{ model: "acme/mid", thinking: "high", weight: 3 },
				],
			},
		});
		assert.equal(main?.fallbackTier, undefined);
		assert.equal(main?.baselineTier, "base");
		assert.equal(main?.directTier, "@bottom");
		assert.deepEqual(saved.profileSelection, { default: "main", rules: [{ profile: "main", matchProvider: "acme" }] });
		assert.deepEqual(saved.custom, { kept: true }, "unknown top-level keys survive");
	});

	it("ignores invalid edits: a fractional rank, a zero weight, a taken name and an unconfirmed delete", async () => {
		const path = pathIn();
		const ui = scripted([
			"profile: work (default)",
			"tier: standard",
			"rank",
			"1.5",
			"rename",
			"deep",
			"members",
			"1. acme/mid",
			"weight",
			"0",
			"1. acme/mid",
			"thinking level",
			"(from model reference)",
			"← back",
			"delete tier",
			false,
			"← back",
			"rename",
			"work",
			"+ add tier",
			"deep",
			"acme/big",
			"delete profile",
			false,
			"← back",
			"+ new profile",
			"work",
			"acme/mid",
			"✗ close without saving",
		]);
		assert.equal(await runTierEditor(ui, { path, raw: raw(), models }), false);
		assert.equal(ui.left(), 0);
	});

	it("reports when nothing changed and closes on a dismissed dialog", async () => {
		const path = pathIn();
		writeFileSync(path, stableStringify(raw()));
		const unchanged = scripted(["✓ save and close"]);
		assert.equal(await runTierEditor(unchanged, { path, raw: raw(), models }), false);
		assert.deepEqual(unchanged.notes, ["No changes to save."]);
		assert.equal(await runTierEditor(scripted([undefined]), { path, raw: raw(), models }), false);
	});
});
