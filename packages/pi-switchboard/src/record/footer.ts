import type { DecisionEntry } from "./types.ts";

export interface FooterValues {
	profile?: string;
	tier?: string;
	rank?: number;
	member?: string;
	model?: string;
	provider?: string;
	account?: string;
	thinking?: string;
	strategy?: string;
	confidence?: string;
	reason?: string;
	kind?: string;
	switches?: number;
	routed?: number;
	running?: number;
}

/** Fills `{placeholder}` fields; unknown or empty ones collapse with their separator. */
export function renderTemplate(template: string, values: FooterValues): string {
	const filled = template.replace(/\{(\w+)\}/gu, (_match, key: string) => {
		const value = (values as Record<string, unknown>)[key];
		return value === undefined || value === "" ? "\u0000" : String(value);
	});
	return filled
		.split(/\s*·\s*/u)
		.filter((part) => !part.includes("\u0000") && part.trim() !== "")
		.join(" · ")
		.replace(/\u0000/gu, "")
		.trim();
}

/** Footer values from the latest decision. */
export function footerValues(decision: DecisionEntry | undefined, extra: Pick<FooterValues, "switches" | "routed" | "running"> = {}): FooterValues {
	if (!decision) return extra;
	const gate = decision.rules?.gate;
	return {
		profile: decision.profile.name,
		tier: decision.tier.chosen + (decision.tier.borrowedFrom ? "↑" : ""),
		rank: decision.tier.rank,
		member: decision.model.id,
		model: `${decision.model.provider}/${decision.model.id}`,
		provider: decision.model.provider,
		...(decision.model.account ? { account: decision.model.account } : {}),
		thinking: decision.model.thinking,
		...(decision.selection ? { strategy: decision.selection.strategy } : {}),
		...(gate && gate.referenced.length > 0 ? { confidence: gate.confidence.toFixed(2) } : {}),
		reason: decision.reason,
		kind: decision.kind,
		...extra,
	};
}

/** The `tier` footer text, with state markers. */
export function footerText(template: string, decision: DecisionEntry | undefined, state: { off?: boolean; inactive?: string; pinned?: string; dryRun?: boolean; switches?: number }): string | undefined {
	if (state.off) return "switchboard off";
	if (state.inactive) return `switchboard inactive: ${state.inactive}`;
	if (!decision) return undefined;
	const base = renderTemplate(template, footerValues(decision, { ...(state.switches !== undefined ? { switches: state.switches } : {}) }));
	const markers = [state.pinned ? `pinned ${state.pinned}` : "", state.dryRun ? "dry-run" : "", decision.kind === "fallback" ? "fallback" : ""].filter(Boolean);
	return markers.length ? `${base} · ${markers.join(" · ")}` : base;
}
