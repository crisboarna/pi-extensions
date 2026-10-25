import { isRankKeyword } from "./types.ts";

export interface RankedTier {
	name: string;
	rank: number;
}

/**
 * Resolves a tier target against tiers sorted by rank, lowest first.
 * `@top` is the highest rank, `@bottom` the lowest, and `@middle` the upper
 * median by rank index, so an even count rounds toward the stronger tier.
 * Returns undefined for an unknown tier name.
 */
export function resolveTarget(target: string, tiers: readonly RankedTier[]): string | undefined {
	if (tiers.length === 0) return undefined;
	if (isRankKeyword(target)) {
		const index = target === "@bottom" ? 0 : target === "@top" ? tiers.length - 1 : Math.floor(tiers.length / 2);
		return tiers[index]?.name;
	}
	return tiers.some((tier) => tier.name === target) ? target : undefined;
}

export function rankOf(name: string, tiers: readonly RankedTier[]): number {
	return tiers.find((tier) => tier.name === name)?.rank ?? Number.NEGATIVE_INFINITY;
}

/** The tier one step above or below `name` by rank, or `name` itself at the ends. */
export function stepTier(name: string, steps: number, tiers: readonly RankedTier[]): string {
	const index = tiers.findIndex((tier) => tier.name === name);
	if (index < 0) return name;
	const next = Math.min(tiers.length - 1, Math.max(0, index + steps));
	return tiers[next]?.name ?? name;
}

/** The higher-ranked of two tiers. */
export function maxTier(a: string, b: string, tiers: readonly RankedTier[]): string {
	return rankOf(a, tiers) >= rankOf(b, tiers) ? a : b;
}

/** The lower-ranked of two tiers. */
export function minTier(a: string, b: string, tiers: readonly RankedTier[]): string {
	return rankOf(a, tiers) <= rankOf(b, tiers) ? a : b;
}
