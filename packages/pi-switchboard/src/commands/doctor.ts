import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isLocalClassifier } from "../classifier/pi-adapter.ts";
import { WARMUP_REQUEST } from "../classifier/warmup.ts";
import { remoteSkippedWarning, unregisteredWarning } from "../config/checks.ts";
import type { Runtime } from "../runtime.ts";
import { quotaProviders } from "../selection/pi-usage.ts";
import { PI_SUBAGENTS_MISSING } from "../subagents/pi-subagents.ts";

/** What `/tier doctor` checks, gathered from the runtime; formatted by `doctorLines`. */
export interface DoctorFacts {
	missingConfig: boolean;
	sources: string[];
	profiles: Array<{ name: string; tiers: number; members: number; disabled: string[] }>;
	invalidProfiles: Array<{ name: string; errors: string[] }>;
	classifiers: Array<{ model: string; registered: boolean; local: boolean; allowRemote: boolean; probe?: { ok: boolean; ms: number; error?: string } }>;
	routingSelected: boolean;
	blocked?: string | undefined;
	subagents: { enabled: boolean; launchModeReason?: string | undefined };
	footer: boolean;
	/** classification.decisionBudgetMs: how long one decision may take before the fallback tier is used. */
	decisionBudgetMs: number;
	quotaProviders: string[];
	piUsage: boolean;
	warnings: string[];
}

interface Lines {
	ok: string[];
	warn: string[];
	bad: string[];
}

function configLines(facts: DoctorFacts, out: Lines): void {
	if (facts.missingConfig) out.bad.push("✗ no config yet: run /tier init to propose one from your signed-in models");
	else out.ok.push(`✓ config: ${facts.sources.join(", ")}`);
	if (facts.blocked) out.bad.push(`✗ ${facts.blocked} is installed too: two routers fight over the model; remove one`);
	for (const profile of facts.profiles) {
		out.ok.push(`✓ profile ${profile.name}: ${profile.tiers} tiers, ${profile.members} members`);
		for (const member of profile.disabled) out.warn.push(`! profile ${profile.name}: ${member}`);
	}
	for (const profile of facts.invalidProfiles) out.bad.push(`✗ profile ${profile.name} is invalid: ${profile.errors.join("; ")} (run /tier validate)`);
}

/** Errors that mean the credentials are missing or refused, not the server. */
const CREDENTIALS = /api key|not configured|credential|unauthori[sz]ed|forbidden|\b40[13]\b/iu;

/** What to check for a classifier that did not answer: its key, a remote provider, or the local server. */
function notAnsweringHint(classifier: DoctorFacts["classifiers"][number]): string {
	if (CREDENTIALS.test(classifier.probe?.error ?? ""))
		return `check its key: the classifierProviders entry's "apiKey", /login, or the provider's environment variable (docs/classifier-cloud.md)`;
	if (!classifier.local) return "is the provider reachable from here? (docs/classifier-cloud.md)";
	return "is its server running? `pi-switchboard classifier detect` shows what is";
}

function classifierLines(facts: DoctorFacts, out: Lines): void {
	if (facts.classifiers.length === 0)
		out.bad.push(
			"✗ no classifier configured: every request uses the fallback tier; run `pi-switchboard classifier detect` to find a local server, or see docs/classifier-setup.md",
		);
	for (const classifier of facts.classifiers) {
		if (!classifier.registered) out.bad.push(`✗ classifier ${classifier.model} is not registered in pi: check classifierProviders`);
		else if (!classifier.local && !classifier.allowRemote)
			out.warn.push(`! classifier ${classifier.model} is remote and skipped: set allowRemote: true to let it receive request text`);
		else if (classifier.probe?.ok && classifier.probe.ms > facts.decisionBudgetMs)
			out.warn.push(
				`! classifier ${classifier.model} answered in ${classifier.probe.ms} ms, more slowly than the ${facts.decisionBudgetMs} ms budget for one decision (classification.decisionBudgetMs): routed requests use the fallback tier; a smaller model or a GPU helps`,
			);
		else if (classifier.probe?.ok) out.ok.push(`✓ classifier ${classifier.model} answered in ${classifier.probe.ms} ms`);
		else if (classifier.probe)
			out.bad.push(`✗ classifier ${classifier.model} did not answer (${classifier.probe.error ?? "no answer"}): ${notAnsweringHint(classifier)}`);
	}
}

function sessionLines(facts: DoctorFacts, out: Lines): void {
	if (facts.routingSelected) out.ok.push("✓ a switchboard model is selected");
	else out.warn.push("! not routing: pick switchboard/auto (or switchboard/<profile>) in /model");
	if (!facts.subagents.enabled) out.ok.push("✓ subagent routing is off (subagents.enabled is false)");
	else if (facts.subagents.launchModeReason === PI_SUBAGENTS_MISSING) out.ok.push("✓ pi-subagents is not installed; subagents are routed once it is");
	else if (facts.subagents.launchModeReason) out.warn.push(`! subagents use launch-time models: ${facts.subagents.launchModeReason}`);
	else out.ok.push("✓ subagents are routed inside their children");
	if (facts.footer) out.ok.push("✓ the footer shows the tier");
	else
		out.warn.push(
			'! the footer does not show the tier: powerline leaves out extension statuses; add { "id": "tier", "statusKey": "tier" } to powerline.customItems (README: Footer)',
		);
	if (facts.quotaProviders.length > 0) {
		if (facts.piUsage) out.ok.push(`✓ pi-usage provides quota for ${facts.quotaProviders.join(", ")}`);
		else out.warn.push(`! quota strategies for ${facts.quotaProviders.join(", ")} without pi-usage: install @narumitw/pi-usage or give members a budget`);
	}
	// The classifier lines already say these.
	const said = new Set(facts.classifiers.flatMap((classifier) => [unregisteredWarning(classifier.model), remoteSkippedWarning(classifier.model)]));
	for (const warning of facts.warnings) if (!said.has(warning)) out.warn.push(`! ${warning}`);
}

/** One line per check: ✓ fine, ! worth a look, ✗ a problem, each with what to do. Problems come first. */
export function doctorLines(facts: DoctorFacts): string[] {
	const out: Lines = { ok: [], warn: [], bad: [] };
	configLines(facts, out);
	classifierLines(facts, out);
	sessionLines(facts, out);
	const summary = out.bad.length || out.warn.length ? `${out.bad.length} problem(s), ${out.warn.length} warning(s)` : "everything looks right";
	return [`pi-switchboard doctor: ${summary}`, ...out.bad, ...out.warn, ...out.ok];
}

type PowerlineGroup = "left" | "right" | "secondary";
type PowerlineSettings = {
	preset?: string;
	layout?: Partial<Record<PowerlineGroup, string[]>>;
	disabledSegments?: string[];
	customItems?: Array<{ id?: string; statusKey?: string }>;
};
/** The pi settings `/tier doctor` reads. */
export type DoctorSettings = { packages?: unknown[]; powerline?: string | PowerlineSettings };

/** The group that lists pi-powerline-footer's aggregate extension statuses in each preset that has it (pi-powerline-footer 0.20). */
const POWERLINE_STATUS_GROUP: Record<string, PowerlineGroup> = { default: "secondary", full: "right", nerd: "right" };
const STATUSES = "extension_statuses";

/**
 * Whether the footer shows the `tier` status. pi's own footer shows every
 * extension status; so does pi-powerline-footer, through its extension statuses
 * segment, unless the preset, `layout` or `disabledSegments` leave it out. A
 * `customItems` entry for the key shows it in any case.
 */
export function footerShowsTier(settings: DoctorSettings): boolean {
	const installed = (settings.packages ?? []).some((entry) => JSON.stringify(entry).includes("pi-powerline-footer"));
	if (!installed) return true;
	const powerline: PowerlineSettings = typeof settings.powerline === "string" ? { preset: settings.powerline } : (settings.powerline ?? {});
	const disabled = new Set(powerline.disabledSegments ?? []);
	const item = (powerline.customItems ?? []).find((entry) => (entry.statusKey ?? entry.id) === "tier");
	if (item && !disabled.has(`custom:${item.id}`)) return true;
	return !disabled.has(STATUSES) && listsStatuses(powerline);
}

function listsStatuses({ preset = "default", layout = {} }: PowerlineSettings): boolean {
	if (Object.values(layout).some((segments) => segments?.includes(STATUSES))) return true;
	const group = POWERLINE_STATUS_GROUP[preset];
	return group !== undefined && layout[group] === undefined;
}

function readSettings(agentDir: string): DoctorSettings {
	try {
		return JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
	} catch {
		return {};
	}
}

async function probe(runtime: Runtime, model: string, timeoutMs: number): Promise<{ ok: boolean; ms: number; error?: string }> {
	const started = Date.now();
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await runtime.engine.deps.classify(model, WARMUP_REQUEST, { signal: controller.signal });
		const ms = Date.now() - started;
		return response.stopReason === "stop" ? { ok: true, ms } : { ok: false, ms, error: response.errorMessage ?? response.stopReason };
	} catch (error) {
		return { ok: false, ms: Date.now() - started, error: error instanceof Error ? error.message : String(error) };
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Gathers the facts for `/tier doctor`, probing each usable classifier with a warm-up request. The probe
 * waits long enough for a slow classifier to answer, so a slow one is told apart from one that is down.
 */
export async function gatherDoctorFacts(runtime: Runtime, ctx: ExtensionContext, timeoutMs = 30_000): Promise<DoctorFacts> {
	const config = runtime.config;
	const settings = readSettings(runtime.agentDir);
	const packages = (settings.packages ?? []).map((entry) => (typeof entry === "string" ? entry : JSON.stringify(entry)));
	const classifiers: DoctorFacts["classifiers"] = [];
	for (const entry of config.classifiers) {
		const slash = entry.model.indexOf("/");
		const registered = slash > 0 && ctx.modelRegistry.findOfType("classifier", entry.model.slice(0, slash), entry.model.slice(slash + 1)) !== undefined;
		const local = isLocalClassifier(ctx, entry.model, config.classifierProviders);
		const allowRemote = entry.allowRemote === true;
		const usable = registered && (local || allowRemote);
		classifiers.push({ model: entry.model, registered, local, allowRemote, ...(usable ? { probe: await probe(runtime, entry.model, timeoutMs) } : {}) });
	}
	return {
		missingConfig: runtime.missingConfig,
		sources: config.sources,
		profiles: Object.values(config.profiles).map((profile) => ({
			name: profile.name,
			tiers: profile.tiers.length,
			members: profile.tiers.reduce((sum, tier) => sum + tier.members.length, 0),
			disabled: profile.tiers.flatMap((tier) =>
				tier.members.filter((m) => !m.enabled).map((m) => `${m.key} in ${tier.name} is disabled (${m.disabledReason ?? "disabled"})`),
			),
		})),
		invalidProfiles: Object.entries(config.invalidProfiles).map(([name, errors]) => ({ name, errors })),
		classifiers,
		routingSelected: runtime.routingSelected,
		blocked: runtime.blocked,
		subagents: { enabled: config.subagents.enabled, launchModeReason: runtime.launchModeReason },
		footer: footerShowsTier(settings),
		decisionBudgetMs: config.classification.decisionBudgetMs,
		quotaProviders: quotaProviders(Object.values(config.profiles)),
		piUsage: packages.some((entry) => entry.includes("pi-usage")),
		warnings: [...config.warnings, ...runtime.environmentChecks(ctx)],
	};
}
