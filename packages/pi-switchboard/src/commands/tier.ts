import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../config/load.ts";
import { explain, responseCount, summarize } from "../record/describe.ts";
import { DECISION_TYPE, type DecisionEntry } from "../record/types.ts";
import { catalogView, type RegistryLike } from "../router/pi-glue.ts";
import type { Runtime } from "../runtime.ts";
import { liveLeases } from "../selection/health.ts";

export interface CommandHandlers {
	init?: (args: string[], ctx: ExtensionCommandContext) => Promise<void>;
	models?: (args: string[], ctx: ExtensionCommandContext) => Promise<void>;
	watch?: (args: string[], ctx: ExtensionCommandContext) => Promise<void>;
	inspect?: (args: string[], ctx: ExtensionCommandContext) => Promise<void>;
	try?: (args: string[], ctx: ExtensionCommandContext) => Promise<void>;
	doctor?: (args: string[], ctx: ExtensionCommandContext) => Promise<void>;
	eval?: (args: string[], ctx: ExtensionCommandContext) => Promise<void>;
	tour?: (args: string[], ctx: ExtensionCommandContext) => Promise<void>;
}

const SUBCOMMANDS: Array<{ value: string; description: string }> = [
	{ value: "init", description: "Propose a config from your signed-in models" },
	{ value: "try", description: "How a request would route, without running it: [question=value ...] <request>" },
	{ value: "doctor", description: "Check the setup and say what to fix" },
	{ value: "eval", description: "Test a classifier on labelled requests: [provider/model] [--threshold n]" },
	{ value: "tour", description: "A short walkthrough of what pi-switchboard records" },
	{ value: "models", description: "Edit profiles, tiers and members" },
	{ value: "watch", description: "Live view of running work" },
	{ value: "profile", description: "Choose the profile: <name|auto> [--global]" },
	{ value: "pin", description: "Pin a tier: <tier|@top|@middle|@bottom|auto> [--subagents]" },
	{ value: "dry-run", description: "Classify and record without switching: on|off" },
	{ value: "log", description: "Recent decisions: [n]" },
	{ value: "explain", description: "Explain a decision: <id>" },
	{ value: "health", description: "Models, cooldowns and requests in flight" },
	{ value: "report", description: "Cost by task, tier and model" },
	{ value: "budget", description: "Spend against budgets" },
	{ value: "inspect", description: "Write the HTML inspector for this session: [--open] [-o file]" },
	{ value: "validate", description: "Check the config" },
	{ value: "resume", description: "resume cancel: stop a pending auto-continue" },
];

/** Decisions on the current branch, oldest first. */
export function branchDecisions(ctx: ExtensionCommandContext): DecisionEntry[] {
	const out: DecisionEntry[] = [];
	for (const entry of ctx.sessionManager.getBranch()) {
		const custom = entry as { type?: string; customType?: string; data?: unknown };
		if (custom.type === "custom" && custom.customType === DECISION_TYPE && custom.data) out.push(custom.data as DecisionEntry);
	}
	return out;
}

function show(ctx: ExtensionCommandContext, lines: string[]): void {
	ctx.ui.notify(lines.join("\n"), "info");
}

function money(value: number): string {
	return value < 0.01 && value > 0 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}

/** Registers `/tier` and its subcommands. */
export function registerTierCommand(runtime: Runtime, handlers: CommandHandlers = {}): void {
	runtime.pi.registerCommand("tier", {
		description: "pi-switchboard: status, profiles, pins, decisions and reports",
		getArgumentCompletions: (prefix) => {
			const [head = "", ...rest] = prefix.split(/\s+/u);
			if (rest.length === 0)
				return SUBCOMMANDS.filter((s) => s.value.startsWith(head)).map((s) => ({ value: s.value, label: s.value, description: s.description }));
			const config = runtime.config;
			const tiers = Object.values(config.profiles).flatMap((p) => p.tiers.map((t) => t.name));
			const values =
				head === "profile"
					? ["auto", ...Object.keys(config.profiles), "--global"]
					: head === "pin"
						? ["auto", "@top", "@middle", "@bottom", ...new Set(tiers), "--subagents"]
						: head === "dry-run"
							? ["on", "off"]
							: [];
			const last = rest.at(-1) ?? "";
			return values.filter((v) => v.startsWith(last)).map((v) => ({ value: [head, ...rest.slice(0, -1), v].join(" "), label: v }));
		},
		handler: async (raw, ctx) => {
			const args = raw.trim().split(/\s+/u).filter(Boolean);
			const [sub, ...rest] = args;
			const engine = runtime.engine;
			const config = runtime.config;
			switch (sub) {
				case undefined:
				case "status": {
					const decisions = branchDecisions(ctx);
					const { choice } = engine.resolveProfile(ctx.model && runtime.isVirtual(ctx.model.provider) ? ctx.model.id : "auto");
					const lines = [
						`pi-switchboard ${runtime.routingSelected ? "routing" : "not selected (pick switchboard/auto in /model)"}${runtime.blocked ? ` · blocked by ${runtime.blocked}` : ""}`,
						choice
							? `profile: ${choice.profile.name} (${choice.source}) · tiers ${choice.profile.tiers.map((t) => t.name).join(" < ")}`
							: `inactive: ${engine.inactiveReason()}`,
						`pin: ${engine.controls.pin ? `${engine.controls.pin.target}${engine.controls.pin.subagents ? " (with subagents)" : ""}` : "none"} · dry-run: ${engine.controls.dryRun ? "on" : "off"} · model switches: ${runtime.switches}`,
						`subagents: ${config.subagents.enabled ? (runtime.launchModeReason ? `launch-time models (${runtime.launchModeReason})` : "routed inside children") : "off"} · routed ${runtime.routedSubagents}`,
						`classifiers: ${config.classifiers.map((c) => `${c.model}${runtime.warmup.isWarm(c.model) ? " (warm)" : ""}`).join(", ") || "none"}`,
						...decisions.slice(-5).map((d) => `  ${summarize(d)}`),
					];
					show(ctx, lines);
					return;
				}
				case "profile": {
					const name = rest.find((a) => !a.startsWith("--"));
					const global = rest.includes("--global");
					if (!name) return show(ctx, [`profiles: ${Object.keys(config.profiles).join(", ") || "none"}`]);
					if (name !== "auto" && !config.profiles[name]) return ctx.ui.notify(`Unknown profile "${name}"`, "error");
					if (global) runtime.stateFile.write((s) => (name === "auto" ? { ...s, globalProfile: undefined } : { ...s, globalProfile: name }));
					else {
						if (name === "auto") delete engine.controls.profile;
						else engine.controls.profile = name;
						runtime.saveControls();
					}
					ctx.ui.notify(`Profile ${name === "auto" ? "selection restored" : `set to ${name}`}${global ? " globally" : " for this session"}`, "info");
					runtime.updateFooter(ctx);
					return;
				}
				case "pin": {
					const target = rest.find((a) => !a.startsWith("--"));
					if (!target || target === "auto") delete engine.controls.pin;
					else engine.controls.pin = { target, subagents: rest.includes("--subagents") };
					runtime.saveControls();
					runtime.updateFooter(ctx);
					ctx.ui.notify(
						engine.controls.pin ? `Pinned to ${target}${engine.controls.pin.subagents ? " (subagents too)" : ""}` : "Pin removed",
						"info",
					);
					return;
				}
				case "dry-run": {
					engine.controls.dryRun = rest[0] !== "off";
					runtime.saveControls();
					runtime.updateFooter(ctx);
					ctx.ui.notify(`Dry-run ${engine.controls.dryRun ? "on: decisions are recorded, the baseline tier runs" : "off"}`, "info");
					return;
				}
				case "log": {
					const n = Number(rest[0] ?? 20) || 20;
					const decisions = branchDecisions(ctx).slice(-n);
					show(ctx, decisions.length ? decisions.map((d) => `${d.id.slice(-6)} ${summarize(d)}`) : ["No decisions on this branch yet."]);
					return;
				}
				case "explain": {
					const id = rest[0] ?? "";
					const decisions = branchDecisions(ctx);
					const decision = id ? decisions.find((d) => d.id === id || d.id.endsWith(id)) : decisions.at(-1);
					show(ctx, decision ? explain(decision) : [`No decision ${id}`]);
					return;
				}
				case "health": {
					const data = runtime.store.read();
					const now = Date.now();
					const lines: string[] = [];
					for (const profile of Object.values(config.profiles)) {
						for (const tier of profile.tiers) {
							for (const member of tier.members) {
								const keys = [
									`member:${profile.name}/${tier.name}/${member.key}`,
									`model:${member.provider}/${member.id}`,
									`provider:${member.provider}`,
								];
								const cooling = keys.map((k) => data.members[k]).filter((h) => (h?.cooldownUntil ?? 0) > now);
								const phys = data.members[`${member.provider}/${member.id}`];
								const inFlight = liveLeases(phys, now).length;
								lines.push(
									`${profile.name}/${tier.name} ${member.key}: ${member.enabled ? (cooling.length ? `cooling down until ${new Date(Math.max(...cooling.map((c) => c?.cooldownUntil ?? 0))).toLocaleTimeString()} (${cooling[0]?.cooldownReason})` : "ok") : `disabled: ${member.disabledReason}`}${inFlight ? `, ${inFlight} in flight` : ""}${phys?.latencyEwma ? `, ~${Math.round(phys.latencyEwma)} ms` : ""}`,
								);
							}
						}
					}
					show(ctx, lines.length ? lines : ["No profiles."]);
					return;
				}
				case "report": {
					const decisions = branchDecisions(ctx);
					const sessionId = ctx.sessionManager.getSessionId();
					const usage = runtime.ledger.read(0).filter((u) => u.session === sessionId);
					const by = (key: (u: (typeof usage)[number]) => string) => {
						const map = new Map<string, { cost: number; tokens: number; requests: number }>();
						for (const u of usage) {
							const k = key(u);
							const row = map.get(k) ?? { cost: 0, tokens: 0, requests: 0 };
							row.cost += u.cost;
							row.tokens += u.input + u.output + u.cacheRead + u.cacheWrite;
							row.requests++;
							map.set(k, row);
						}
						return [...map.entries()]
							.sort((a, b) => b[1].cost - a[1].cost)
							.map(([k, v]) => `  ${k}: ${money(v.cost)}, ${v.tokens} tokens, ${responseCount(v.requests)}`);
					};
					const classified = decisions.filter((d) => d.rules);
					const fallbacks = decisions.filter((d) => d.kind === "fallback").length;
					const confidences = classified.map((d) => d.rules?.gate.confidence ?? 0);
					const bucket = (lo: number, hi: number) => confidences.filter((c) => c >= lo && c < hi).length;
					show(ctx, [
						`Session: ${usage.length} routed responses, ${money(usage.reduce((s, u) => s + u.cost, 0))}, ${runtime.switches} model switches`,
						"By tier:",
						...by((u) => u.tier ?? "?"),
						"By model:",
						...by((u) => `${u.provider}/${u.model}`),
						"By task:",
						...by((u) => `task ${u.task}`),
						`Calibration: ${classified.length} classified, ${fallbacks} fallbacks (${decisions.length ? Math.round((100 * fallbacks) / decisions.length) : 0}%)`,
						`  gate confidence <0.5: ${bucket(0, 0.5)} · 0.5-0.8: ${bucket(0.5, 0.8)} · 0.8-0.9: ${bucket(0.8, 0.9)} · ≥0.9: ${bucket(0.9, 1.01)}`,
					]);
					return;
				}
				case "budget": {
					const totals = runtime.budgets.totals();
					const last = branchDecisions(ctx).at(-1);
					const budgets = (last ? config.profiles[last.profile.name]?.budgets : undefined) ?? config.budgets;
					show(ctx, [
						`task: ${totals.task.tokens} tokens, ${money(totals.task.costUsd)}${budgets?.task ? ` (budget ${budgets.task.tokens ?? "-"} tokens, $${budgets.task.costUsd ?? "-"})` : ""}`,
						`session: ${totals.session.tokens} tokens, ${money(totals.session.costUsd)}${budgets?.session ? ` (budget ${budgets.session.tokens ?? "-"} tokens, $${budgets.session.costUsd ?? "-"})` : ""}`,
						...(budgets ? [] : ["No budgets configured."]),
					]);
					return;
				}
				case "validate": {
					const loaded = loadConfig({
						agentDir: runtime.agentDir,
						cwd: ctx.cwd,
						projectTrusted: ctx.isProjectTrusted(),
						catalog: catalogView(ctx.modelRegistry as unknown as RegistryLike),
					});
					const invalid = Object.entries(loaded.config.invalidProfiles);
					show(ctx, [
						loaded.missing ? `No config at ${loaded.userPath}; run /tier init` : `Config: ${loaded.config.sources.join(", ")}`,
						`Valid profiles: ${Object.keys(loaded.config.profiles).join(", ") || "none"}`,
						...invalid.flatMap(([name, errors]) => [`Invalid profile ${name}:`, ...errors.map((e) => `  ${e}`)]),
						...loaded.config.warnings.map((w) => `warning: ${w}`),
						...runtime.environmentChecks(ctx).map((w) => `warning: ${w}`),
					]);
					return;
				}
				case "resume": {
					runtime.cancelAutoContinue?.();
					ctx.ui.notify("Pending auto-continue cancelled", "info");
					return;
				}
				default: {
					const handler = handlers[sub as keyof CommandHandlers];
					if (handler) return handler(rest, ctx);
					ctx.ui.notify(`Unknown /tier subcommand "${sub}". Try: ${SUBCOMMANDS.map((s) => s.value).join(", ")}`, "error");
				}
			}
		},
	});
}
