import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AutoContinue, type TimerApi } from "../../src/autocontinue.ts";
import { normalizeConfig } from "../../src/config/normalize.ts";
import type { RawConfig } from "../../src/config/types.ts";
import { chooseProfile, profileAllowedHere } from "../../src/router/profiles.ts";

const NOW = Date.UTC(2026, 9, 26, 12);

function setup(over: { enabled?: boolean; maxWaitMs?: number } = {}) {
	let now = NOW;
	const sent: number[] = [];
	const notes: string[] = [];
	const scheduled: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
	const timers: TimerApi = {
		set: (fn, ms) => {
			const entry = { fn, ms, cleared: false };
			scheduled.push(entry);
			return entry;
		},
		clear: (handle) => {
			(handle as { cleared: boolean }).cleared = true;
		},
	};
	const auto = new AutoContinue({ enabled: () => over.enabled ?? true, maxWaitMs: () => over.maxWaitMs ?? 6 * 3_600_000, send: () => sent.push(now), notify: (m) => notes.push(m), clock: { now: () => now }, timers });
	return { auto, sent, notes, scheduled, advance: (ms: number) => (now += ms) };
}

describe("auto-continue", () => {
	it("sends continue once, shortly after the earliest reset", () => {
		const { auto, sent, notes, scheduled } = setup();
		assert.equal(auto.schedule(NOW + 10 * 60_000), true);
		assert.equal(scheduled[0]?.ms, 10 * 60_000 + 5_000, "the reset plus a grace period");
		assert.equal(auto.at, NOW + 10 * 60_000 + 5_000);
		assert.match(notes[0] ?? "", /will send "continue".*\/tier resume cancel/u);
		assert.equal(auto.schedule(NOW + 20 * 60_000), true, "a second exhaustion while pending adds nothing");
		assert.equal(scheduled.length, 1);
		scheduled[0]?.fn();
		assert.equal(sent.length, 1);
		assert.equal(auto.pending, false);
	});

	it("can be cancelled and then does not send", () => {
		const { auto, sent, scheduled } = setup();
		auto.schedule(NOW + 60_000);
		auto.cancel();
		assert.equal(scheduled[0]?.cleared, true);
		assert.equal(auto.pending, false);
		assert.equal(sent.length, 0);
		assert.equal(auto.schedule(NOW + 60_000), true, "a new exhaustion can schedule again");
	});

	it("does nothing when disabled, when the reset has passed, or when it is beyond the limit", () => {
		assert.equal(setup({ enabled: false }).auto.schedule(NOW + 60_000), false);
		const past = setup();
		assert.equal(past.auto.schedule(NOW - 60_000), false);
		const far = setup({ maxWaitMs: 30 * 60_000 });
		assert.equal(far.auto.schedule(NOW + 2 * 3_600_000), false);
		assert.match(far.notes[0] ?? "", /beyond the 30 min limit; not waiting/u);
		assert.equal(far.scheduled.length, 0);
	});
});

describe("profiles restricted to projects", () => {
	const raw: RawConfig = {
		profiles: {
			work: { projects: ["~/work/**", "/srv/app"], tiers: { a: { rank: 1, members: ["acme/x"] } } },
			home: { tiers: { a: { rank: 1, members: ["zen/y"] } } },
		},
		profileSelection: { default: "work", rules: [{ matchProvider: "acme*", profile: "work" }] },
	};
	const config = normalizeConfig(raw);
	const inputs = (cwd: string) => ({ config, cwd, home: "/home/dev", originModel: "acme/x" });

	it("matches project globs, a home-relative glob and an exact path", () => {
		const work = config.profiles.work;
		assert.ok(work);
		assert.equal(profileAllowedHere(work, "/home/dev/work/api", "/home/dev"), true);
		assert.equal(profileAllowedHere(work, "/home/dev/work", "/home/dev"), true);
		assert.equal(profileAllowedHere(work, "/srv/app", "/home/dev"), true);
		assert.equal(profileAllowedHere(work, "/home/dev/play", "/home/dev"), false);
		assert.equal(profileAllowedHere(config.profiles.home!, "/anywhere", "/home/dev"), true, "profiles without projects work everywhere");
	});

	it("skips a restricted profile outside its projects, falling through the selection order", () => {
		assert.equal(chooseProfile(inputs("/home/dev/work/api"))?.profile.name, "work");
		const outside = chooseProfile(inputs("/home/dev/play"));
		assert.equal(outside?.profile.name, "home", "the rule and the default both name work, which is not valid here, so the only usable profile applies");
		assert.equal(outside?.source, "default");
	});

	it("is inactive when no profile is valid for the project", () => {
		const only = normalizeConfig({ profiles: { work: raw.profiles!.work! }, profileSelection: { default: "work" } });
		assert.equal(chooseProfile({ config: only, cwd: "/home/dev/play", home: "/home/dev" }), undefined);
	});
});
