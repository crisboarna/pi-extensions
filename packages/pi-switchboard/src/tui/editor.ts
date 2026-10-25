import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { normalizeConfig } from "../config/normalize.ts";
import type { MemberInput, ProfileConfig, RawConfig, StrategyName, TierConfig } from "../config/types.ts";
import { STRATEGY_NAMES } from "../config/types.ts";
import { THINKING_LEVELS } from "../util/model-ref.ts";

/** The dialogs the editor needs; pi's ctx.ui in practice, a script in tests. */
export interface EditorUi {
	select(title: string, options: string[]): Promise<string | undefined>;
	input(title: string, placeholder?: string): Promise<string | undefined>;
	confirm(title: string, message: string): Promise<boolean>;
	notify(message: string, type?: "info" | "warning" | "error"): void;
}

const BACK = "← back";
const DONE = "✓ save and close";
const CANCEL = "✗ close without saving";

/** Formatted JSON with the schema's key order first, so saved files stay diffable. */
export function stableStringify(config: RawConfig): string {
	const order = ["$schema", "version", "virtualModel", "classifierProviders", "classifiers", "classification", "rulesets", "profiles", "profile", "profileSelection", "subagents", "failover", "metrics", "budgets", "exhaustion", "autoTier", "live", "state", "ui", "debug"];
	const sorted: Record<string, unknown> = {};
	for (const key of order) if (key in config) sorted[key] = (config as Record<string, unknown>)[key];
	for (const [key, value] of Object.entries(config)) if (!(key in sorted)) sorted[key] = value;
	return `${JSON.stringify(sorted, null, 2)}\n`;
}

/** A line diff for the confirmation dialog: removed and added lines with a little context. */
export function lineDiff(before: string, after: string, context = 1): string {
	const a = before.split("\n");
	const b = after.split("\n");
	const m = a.length;
	const n = b.length;
	const lcs: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
	for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? (lcs[i + 1]![j + 1] ?? 0) + 1 : Math.max(lcs[i + 1]![j] ?? 0, lcs[i]![j + 1] ?? 0);
	const ops: Array<{ op: " " | "-" | "+"; line: string }> = [];
	let i = 0;
	let j = 0;
	while (i < m && j < n) {
		if (a[i] === b[j]) {
			ops.push({ op: " ", line: a[i] ?? "" });
			i++;
			j++;
		} else if ((lcs[i + 1]![j] ?? 0) >= (lcs[i]![j + 1] ?? 0)) ops.push({ op: "-", line: a[i++] ?? "" });
		else ops.push({ op: "+", line: b[j++] ?? "" });
	}
	while (i < m) ops.push({ op: "-", line: a[i++] ?? "" });
	while (j < n) ops.push({ op: "+", line: b[j++] ?? "" });
	const keep = new Set<number>();
	ops.forEach((o, k) => {
		if (o.op !== " ") for (let c = k - context; c <= k + context; c++) keep.add(c);
	});
	const out: string[] = [];
	let gap = false;
	ops.forEach((o, k) => {
		if (keep.has(k)) {
			out.push(`${o.op} ${o.line}`);
			gap = false;
		} else if (!gap) {
			out.push("  …");
			gap = true;
		}
	});
	return out.join("\n");
}

function memberModel(member: MemberInput): string {
	return typeof member === "string" ? member : member.model;
}

/** Saves `next` to `path` after validation, a diff and confirmation, writing a timestamped .bak first. */
export async function saveWithConfirmation(ui: EditorUi, path: string, before: RawConfig, next: RawConfig, now = new Date()): Promise<boolean> {
	const check = normalizeConfig(next);
	const invalid = Object.entries(check.invalidProfiles);
	if (invalid.length) {
		ui.notify(`Not saved; fix these first:\n${invalid.map(([name, errors]) => `${name}: ${errors.join("; ")}`).join("\n")}`, "error");
		return false;
	}
	const beforeText = existsSync(path) ? readFileSync(path, "utf8") : "";
	const afterText = stableStringify(next);
	if (beforeText === afterText) {
		ui.notify("No changes to save.", "info");
		return false;
	}
	const ok = await ui.confirm(`Save ${path}?`, lineDiff(beforeText || stableStringify(before), afterText));
	if (!ok) return false;
	mkdirSync(dirname(path), { recursive: true });
	if (beforeText) copyFileSync(path, `${path}.${now.toISOString().replace(/[:.]/gu, "-")}.bak`);
	writeFileSync(path, afterText, { mode: 0o644 });
	ui.notify(`Saved ${path}. Run /reload so the virtual models re-register.`, "info");
	return true;
}

/**
 * The tier editor (DESIGN.md 11.7): profiles, tiers and members through
 * pi's dialogs. Rulesets, classifiers and budgets stay hand-edited JSON.
 */
export async function runTierEditor(ui: EditorUi, options: { path: string; raw: RawConfig; models: string[] }): Promise<boolean> {
	const before: RawConfig = JSON.parse(JSON.stringify(options.raw)) as RawConfig;
	const config: RawConfig = JSON.parse(JSON.stringify(options.raw)) as RawConfig;
	config.profiles ??= {};

	const editMembers = async (tier: TierConfig): Promise<void> => {
		for (;;) {
			const rows = tier.members.map((m, i) => `${i + 1}. ${memberModel(m)}${typeof m === "object" && m.enabled === false ? " (disabled)" : ""}${typeof m === "object" && m.weight ? ` ×${m.weight}` : ""}`);
			const pick = await ui.select("Members", ["+ add member", ...rows, BACK]);
			if (!pick || pick === BACK) return;
			if (pick === "+ add member") {
				const model = await ui.select("Model", options.models);
				if (!model) continue;
				const thinking = await ui.select("Thinking level", ["(model default)", ...THINKING_LEVELS]);
				tier.members.push(thinking && thinking !== "(model default)" ? `${model}:${thinking}` : model);
				continue;
			}
			const index = rows.indexOf(pick);
			const current = tier.members[index];
			if (current === undefined) continue;
			const member = typeof current === "string" ? { model: current } : { ...current };
			const action = await ui.select(memberModel(current), ["thinking level", "weight", member.enabled === false ? "enable" : "disable", "move up", "move down", "remove", BACK]);
			if (action === "thinking level") {
				const level = await ui.select("Thinking level", ["(from model reference)", ...THINKING_LEVELS]);
				if (level && level !== "(from model reference)") member.thinking = level as never;
			} else if (action === "weight") {
				const value = Number(await ui.input("Weight", String(member.weight ?? 1)));
				if (value > 0) member.weight = value;
			} else if (action === "enable" || action === "disable") member.enabled = action === "enable";
			else if (action === "move up" && index > 0) [tier.members[index - 1], tier.members[index]] = [current, tier.members[index - 1] as MemberInput];
			else if (action === "move down" && index < tier.members.length - 1) [tier.members[index + 1], tier.members[index]] = [current, tier.members[index + 1] as MemberInput];
			else if (action === "remove") {
				tier.members.splice(index, 1);
				continue;
			}
			if (action && !["move up", "move down", BACK].includes(action)) tier.members[index] = member;
		}
	};

	const editTier = async (profile: ProfileConfig, name: string): Promise<void> => {
		for (;;) {
			const tier = profile.tiers[name];
			if (!tier) return;
			const strategy = typeof tier.strategy === "string" ? tier.strategy : (tier.strategy?.name ?? "sticky");
			const action = await ui.select(`Tier ${name} (rank ${tier.rank}, ${strategy}, ${tier.members.length} members)`, ["members", "rank", "strategy", "rename", "delete tier", BACK]);
			if (!action || action === BACK) return;
			if (action === "members") await editMembers(tier);
			else if (action === "rank") {
				const rank = Number(await ui.input("Rank (higher is stronger)", String(tier.rank)));
				if (Number.isInteger(rank)) tier.rank = rank;
			} else if (action === "strategy") {
				const chosen = await ui.select("Strategy", [...STRATEGY_NAMES]);
				if (chosen) tier.strategy = chosen as StrategyName;
			} else if (action === "rename") {
				const next = (await ui.input("New tier name", name))?.trim();
				if (next && next !== name && !profile.tiers[next]) {
					profile.tiers[next] = tier;
					delete profile.tiers[name];
					for (const field of ["fallbackTier", "baselineTier", "directTier"] as const) if (profile[field] === name) profile[field] = next;
					name = next;
				}
			} else if (action === "delete tier" && (await ui.confirm("Delete tier", `Delete ${name}?`))) {
				delete profile.tiers[name];
				return;
			}
		}
	};

	const editProfile = async (name: string): Promise<void> => {
		for (;;) {
			const profile = config.profiles?.[name];
			if (!profile) return;
			const tiers = Object.entries(profile.tiers).sort((a, b) => a[1].rank - b[1].rank).map(([tierName]) => tierName);
			const action = await ui.select(`Profile ${name}`, [...tiers.map((t) => `tier: ${t}`), "+ add tier", "fallback tier", "baseline tier", "direct tier", "make default", "rename", "delete profile", BACK]);
			if (!action || action === BACK) return;
			if (action.startsWith("tier: ")) await editTier(profile, action.slice(6));
			else if (action === "+ add tier") {
				const tierName = (await ui.input("Tier name (lowercase)", "standard"))?.trim();
				const model = tierName ? await ui.select("First member", options.models) : undefined;
				if (tierName && model && !profile.tiers[tierName]) {
					const rank = Math.max(0, ...Object.values(profile.tiers).map((t) => t.rank)) + 1;
					profile.tiers[tierName] = { rank, members: [model] };
				}
			} else if (action === "fallback tier" || action === "baseline tier" || action === "direct tier") {
				const chosen = await ui.select(action, ["(default)", ...tiers, "@top", "@middle", "@bottom"]);
				const field = action === "fallback tier" ? "fallbackTier" : action === "baseline tier" ? "baselineTier" : "directTier";
				if (chosen === "(default)") delete profile[field];
				else if (chosen) profile[field] = chosen;
			} else if (action === "make default") config.profileSelection = { ...config.profileSelection, default: name };
			else if (action === "rename") {
				const next = (await ui.input("New profile name", name))?.trim();
				if (next && next !== name && config.profiles && !config.profiles[next]) {
					config.profiles[next] = profile;
					delete config.profiles[name];
					if (config.profileSelection?.default === name) config.profileSelection.default = next;
					for (const rule of config.profileSelection?.rules ?? []) if (rule.profile === name) rule.profile = next;
					name = next;
				}
			} else if (action === "delete profile" && (await ui.confirm("Delete profile", `Delete ${name}?`))) {
				delete config.profiles?.[name];
				return;
			}
		}
	};

	for (;;) {
		const names = Object.keys(config.profiles ?? {});
		const pick = await ui.select(`pi-switchboard profiles (${options.path})`, [...names.map((n) => `profile: ${n}${config.profileSelection?.default === n ? " (default)" : ""}`), "+ new profile", DONE, CANCEL]);
		if (!pick || pick === CANCEL) return false;
		if (pick === DONE) return saveWithConfirmation(ui, options.path, before, config);
		if (pick === "+ new profile") {
			const name = (await ui.input("Profile name (lowercase)", "work"))?.trim();
			const model = name ? await ui.select("Model for the first tier", options.models) : undefined;
			if (name && model && config.profiles && !config.profiles[name]) {
				config.profiles[name] = { tiers: { standard: { rank: 1, members: [model] } } };
				await editProfile(name);
			}
			continue;
		}
		await editProfile(pick.replace(/^profile: /u, "").replace(/ \(default\)$/u, ""));
	}
}
