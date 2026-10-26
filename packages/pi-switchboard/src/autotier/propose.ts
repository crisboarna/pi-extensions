import type { ClassifierEntry, ClassifierProviderConfig, ProfileConfig, RawConfig, TierConfig } from "../config/types.ts";
import { LARGE_HINTS, SMALL_HINTS } from "./hints.ts";

export interface CatalogModel {
	provider: string;
	id: string;
	contextWindow?: number;
	maxTokens?: number;
	cost?: { input?: number; output?: number };
}

export interface ProposeOptions {
	/** Extra hint words from `autoTier.nameHints`. */
	hints?: { small?: readonly string[]; large?: readonly string[] };
	/** The model selected now, `provider/id`; its provider's profile becomes the default. */
	current?: string;
	/** Whether a provider name is a pi-multi-pass extra account (`<base>-<n>`). */
	isAccount?: (provider: string) => boolean;
	classifierProviders?: ClassifierProviderConfig[];
	classifiers?: ClassifierEntry[];
}

function price(model: CatalogModel): number | undefined {
	const input = model.cost?.input ?? 0;
	const output = model.cost?.output ?? 0;
	return input > 0 || output > 0 ? (input * 3 + output) / 4 : undefined;
}

function hintScore(id: string, small: readonly string[], large: readonly string[]): number {
	const words = id.toLowerCase().split(/[^a-z0-9]+/u);
	const has = (list: readonly string[]) => list.some((hint) => words.includes(hint.toLowerCase()));
	if (has(small)) return -1;
	if (has(large)) return 1;
	return 0;
}

/** Models ordered from least to most capable: price, then name hints, then context window and output limit. */
export function rankModels(models: readonly CatalogModel[], hints: ProposeOptions["hints"] = {}): CatalogModel[] {
	const small = [...SMALL_HINTS, ...(hints.small ?? [])];
	const large = [...LARGE_HINTS, ...(hints.large ?? [])];
	return [...models].sort((a, b) => {
		const pa = price(a);
		const pb = price(b);
		if (pa !== undefined && pb !== undefined && pa !== pb) return pa - pb;
		const ha = hintScore(a.id, small, large);
		const hb = hintScore(b.id, small, large);
		if (ha !== hb) return ha - hb;
		if (pa !== undefined && pb === undefined) return 1;
		if (pa === undefined && pb !== undefined) return -1;
		const ca = a.contextWindow ?? 0;
		const cb = b.contextWindow ?? 0;
		if (ca !== cb) return ca - cb;
		const ma = a.maxTokens ?? 0;
		const mb = b.maxTokens ?? 0;
		if (ma !== mb) return ma - mb;
		return a.id.localeCompare(b.id);
	});
}

/** Profile names follow the config pattern: lowercase letters, digits and dashes. */
export function profileName(provider: string): string {
	return (
		provider
			.toLowerCase()
			.replace(/[^a-z0-9-]+/gu, "-")
			.replace(/^-+|-+$/gu, "") || "profile"
	);
}

function tiersFrom(ranked: readonly CatalogModel[]): Record<string, TierConfig> {
	const ref = (m: CatalogModel, thinking: string) => `${m.provider}/${m.id}:${thinking}`;
	const first = ranked[0];
	const last = ranked.at(-1);
	if (!first || !last) return {};
	if (ranked.length === 1) return { standard: { rank: 2, members: [ref(first, "medium")] } };
	if (ranked.length === 2) return { light: { rank: 1, members: [ref(first, "low")] }, deep: { rank: 3, members: [ref(last, "high")] } };
	const middle = ranked[Math.floor((ranked.length - 1) / 2)] ?? first;
	return {
		light: { rank: 1, members: [ref(first, "low")] },
		standard: { rank: 2, members: [ref(middle, "medium")] },
		deep: { rank: 3, members: [ref(last, "high")] },
	};
}

/**
 * Proposes a config from the signed-in chat models (DESIGN.md 7.7): one
 * profile per base provider and a mixed `all` profile, each with up to three
 * tiers, selection rules per provider and the current provider as default.
 */
export function proposeConfig(models: readonly CatalogModel[], options: ProposeOptions = {}): RawConfig {
	const usable = models.filter((m) => !options.isAccount?.(m.provider));
	const byProvider = new Map<string, CatalogModel[]>();
	for (const model of usable) byProvider.set(model.provider, [...(byProvider.get(model.provider) ?? []), model]);

	const profiles: Record<string, ProfileConfig> = {};
	const rules: Array<{ matchProvider: string; profile: string }> = [];
	for (const [provider, list] of [...byProvider.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
		const name = profileName(provider);
		const tiers = tiersFrom(rankModels(list, options.hints));
		if (Object.keys(tiers).length === 0) continue;
		profiles[name] = { description: `Auto-tiered ${provider} models`, tiers, ...(tiers.standard ? { fallbackTier: "standard" } : {}) };
		rules.push({ matchProvider: `${provider}*`, profile: name });
	}
	if (byProvider.size > 1) {
		const tiers = tiersFrom(rankModels(usable, options.hints));
		profiles.all = { description: "Auto-tiered across every signed-in provider", tiers, ...(tiers.standard ? { fallbackTier: "standard" } : {}) };
	}
	const currentProvider = options.current?.slice(0, options.current.indexOf("/"));
	const defaultProfile = currentProvider && profiles[profileName(currentProvider)] ? profileName(currentProvider) : Object.keys(profiles)[0];
	return {
		$schema: "https://github.com/crisboarna/pi-switchboard/schema/pi-switchboard.schema.json",
		version: 1,
		...(options.classifierProviders?.length ? { classifierProviders: options.classifierProviders } : {}),
		classifiers: options.classifiers ?? [],
		profiles,
		profileSelection: { ...(defaultProfile ? { default: defaultProfile } : {}), rules },
	};
}

/** Adds proposed profiles and rules to an existing config without touching what is there. */
export function mergeProposal(existing: RawConfig, proposal: RawConfig): RawConfig {
	const profiles = { ...existing.profiles };
	for (const [name, profile] of Object.entries(proposal.profiles ?? {})) if (!profiles[name]) profiles[name] = profile;
	const rules = [...(existing.profileSelection?.rules ?? [])];
	for (const rule of proposal.profileSelection?.rules ?? []) if (!rules.some((r) => r.profile === rule.profile)) rules.push(rule);
	const fallbackDefault = existing.profileSelection?.default ?? proposal.profileSelection?.default;
	return { ...existing, profiles, profileSelection: { ...existing.profileSelection, ...(fallbackDefault ? { default: fallbackDefault } : {}), rules } };
}
