import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { AutoContinue } from "./autocontinue.ts";
import { BudgetTracker } from "./budgets/track.ts";
import type { TranscriptMessage } from "./classifier/evidence.ts";
import { lastUserIndex, textOf as messageText } from "./classifier/evidence.ts";
import { createClassifyFn, isLocalClassifier, registerClassifierProviders } from "./classifier/pi-adapter.ts";
import { createRedactor } from "./classifier/redact.ts";
import { WarmupTracker } from "./classifier/warmup.ts";
import { needsTosNotice, runChecks, TOS_WARNING, withoutTosWarnings } from "./config/checks.ts";
import { dataDir, loadConfig } from "./config/load.ts";
import type { Config } from "./config/types.ts";
import { LiveWriter, sweep } from "./live/live.ts";
import { DebugLog } from "./record/debug-log.ts";
import { footerText, renderTemplate } from "./record/footer.ts";
import {
	CONTROL_TYPE,
	type ControlEntry,
	DECISION_TYPE,
	type DecisionEntry,
	LINK_TYPE,
	type LinkEntry,
	PROFILE_TYPE,
	type ProfileSnapshotEntry,
} from "./record/types.ts";
import { ExhaustedError, type LeaseRef, type ModelChoice, type RouterState, SwitchboardEngine } from "./router/engine.ts";
import {
	agentFromMessages,
	catalogView,
	conflictingRouter,
	engineCatalog,
	estimateTokens,
	queryPlanPhase,
	type RegistryLike,
	StateFile,
	virtualModelIds,
} from "./router/pi-glue.ts";
import { mapToAccount, readMultiPassSubscriptions } from "./selection/accounts.ts";
import { FileHealthStore, type HealthStore, MemoryHealthStore } from "./selection/health.ts";
import { ledgerQuota, UsageLedger } from "./selection/ledger.ts";
import { CHANGED_CHANNEL, quotaProviders, UsageCache } from "./selection/pi-usage.ts";
import { type CustomSelect, loadCustomStrategy } from "./selection/strategies.ts";
import { attachBinding, matchLaunch, readBinding, type SwitchboardBinding, taskDigest } from "./subagents/binding.ts";
import { routeLaunch } from "./subagents/launch.ts";
import { createPinLookup, type RequiredRegistration, registerChildExtension } from "./subagents/pi-subagents.ts";
import { extractTasks, isAsyncLaunch, resultLinks } from "./subagents/tasks.ts";
import { THINKING_LEVELS, type ThinkingLevel } from "./util/model-ref.ts";
import { entryOf } from "./util/record.ts";
import { systemClock, systemRng } from "./util/runtime.ts";

const MAX_LAUNCH_DECISIONS = 200;

export const STATUS_KEY = "tier";
export const STATUS_SUB_KEY = "tier-sub";
const VIRTUAL_THINKING: ThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh"];

interface RouteRequestLike {
	model: { provider: string; id: string };
	thinkingLevel: string;
	reason: "user" | "continuation" | "retry" | "direct";
	previous?: { model: { provider: string; id: string }; thinkingLevel?: string };
	failed?: { model: { provider: string; id: string }; thinkingLevel?: string; message: { errorMessage?: string } };
	state?: unknown;
	messages: readonly unknown[];
	signal?: AbortSignal;
}

function choice(entry: { model: { provider: string; id: string }; thinkingLevel?: string } | undefined): ModelChoice | undefined {
	return entry ? { provider: entry.model.provider, id: entry.model.id, ...(entry.thinkingLevel ? { thinking: entry.thinkingLevel } : {}) } : undefined;
}

/**
 * Everything pi-switchboard keeps for one pi process: config, the engine,
 * shared health, the usage ledger and the hooks that feed them. Commands,
 * the subagent hook and the navigator read from here.
 */
/** Shown once, the first time pi starts with pi-switchboard installed but not configured. */
export const FIRST_RUN_NOTICE =
	"pi-switchboard is installed but not configured yet. Run /tier init to propose a config from your signed-in models, /tier tour for a two-minute walkthrough, or /tier doctor to check the setup.";

export class Runtime {
	readonly pi: ExtensionAPI;
	readonly agentDir: string;
	readonly home = homedir();
	readonly dir: string;
	readonly stateFile: StateFile;
	readonly ledger: UsageLedger;
	config!: Config;
	missingConfig = true;
	engine!: SwitchboardEngine;
	store: HealthStore;
	warmup: WarmupTracker;
	ctx?: ExtensionContext;
	/** Why the virtual models were not registered, if they were not. */
	blocked?: string | undefined;
	routingSelected = false;
	switches = 0;
	routedSubagents = 0;
	readonly registered = new Set<string>();
	private readonly customs = new Map<string, CustomSelect>();
	private lastRouteAt = 0;
	private childRegistration?: RequiredRegistration | undefined;
	/** Why subagent launches use physical models instead of tier-pinned virtual ones. */
	launchModeReason?: string;
	private readonly launches = new Map<string, DecisionEntry[]>();
	/** Recent launch decisions; the navigator joins running children to them. The engine's own recent list stays main-session routing. */
	readonly launchDecisions: DecisionEntry[] = [];
	private readonly launchLeases = new Map<string, LeaseRef[]>();
	/** The entry file pi-subagents loads into children. */
	entryPath = "";
	readonly listeners = new Set<(decision: DecisionEntry) => void>();
	readonly budgets = new BudgetTracker();
	readonly autoContinue: AutoContinue;
	/** pi-usage quota, refreshed in the background for providers a quota strategy needs. */
	readonly usage: UsageCache;
	private stopUsageListener?: (() => void) | undefined;

	private debugLog?: DebugLog | undefined;
	/** Set in subagent children: publishes live status and the transcript mirror. */
	live?: LiveWriter;
	private snapshotProfile?: string;
	/** In a child: the parent's binding, read while extensions load (DESIGN.md 5.7). */
	binding?: SwitchboardBinding | undefined;
	/** In a child: the parent's launch decision this child belongs to. */
	launchDecisionId?: string;

	constructor(pi: ExtensionAPI) {
		this.pi = pi;
		this.agentDir = getAgentDir();
		this.dir = dataDir(this.agentDir);
		this.stateFile = new StateFile(this.dir);
		this.ledger = new UsageLedger(join(this.dir, "usage.jsonl"));
		this.store = new MemoryHealthStore();
		this.warmup = new WarmupTracker(createClassifyFn(() => this.ctx));
		this.autoContinue = new AutoContinue({
			enabled: () => this.config.exhaustion.autoContinue,
			maxWaitMs: () => this.config.exhaustion.maxWaitMs,
			send: () => this.pi.sendUserMessage("continue", { deliverAs: "followUp" }),
			notify: (message) => this.ctx?.ui.notify(`pi-switchboard: ${message}`, "info"),
		});
		this.usage = new UsageCache({
			events: this.pi.events,
			session: () => (this.ctx ? { sessionManager: this.ctx.sessionManager, sessionId: this.ctx.sessionManager.getSessionId() } : undefined),
		});
	}

	/** Synchronous setup in the extension factory: children resolve virtual models before session start. */
	bootstrap(): void {
		this.binding = readBinding();
		const loaded = loadConfig({ agentDir: this.agentDir, cwd: process.cwd(), projectTrusted: false });
		this.config = loaded.config;
		this.missingConfig = loaded.missing;
		this.store = this.config.state.shared ? new FileHealthStore(join(this.dir, "health.json")) : new MemoryHealthStore();
		this.engine = this.createEngine();
		registerClassifierProviders(this.pi, this.config.classifierProviders);
		this.blocked = conflictingRouter(this.agentDir);
		if (!this.blocked) this.registerVirtualModels();
	}

	private createEngine(): SwitchboardEngine {
		const ledgerCache = { at: 0, entries: this.ledger.read(Date.now() - 7 * 86_400_000) };
		return new SwitchboardEngine({
			config: this.config,
			missingConfig: this.missingConfig,
			catalog: {
				find: (provider, id) => (this.ctx ? engineCatalog(this.ctx.modelRegistry as unknown as RegistryLike).find(provider, id) : undefined),
				hasAuth: (provider) => (this.ctx ? this.ctx.modelRegistry.getProviderAuthStatus(provider).configured : true),
				isProvider: (name) => (this.ctx ? this.ctx.modelRegistry.getProvider(name) !== undefined : false),
				subscription: (provider) => (this.ctx ? engineCatalog(this.ctx.modelRegistry as unknown as RegistryLike).subscription(provider) : false),
			},
			store: this.store,
			classify: createClassifyFn(() => this.ctx),
			isLocalClassifier: (model) => (this.ctx ? isLocalClassifier(this.ctx, model, this.config.classifierProviders) : false),
			warmup: this.warmup,
			clock: systemClock,
			rng: systemRng,
			cwd: process.cwd(),
			home: this.home,
			planPhase: () => queryPlanPhase(this.pi.events),
			globalProfile: () => this.stateFile.read().globalProfile,
			subscriptions: () => readMultiPassSubscriptions(this.agentDir),
			quota: (member) => {
				// pi-usage's account data wins; the local ledger covers members with their own budget.
				if (this.config.metrics.piUsage !== "off") {
					const reported = this.usage.quota(member);
					if (reported) return reported;
				}
				if (!member.budget) return undefined;
				if (Date.now() - ledgerCache.at > 30_000) {
					ledgerCache.at = Date.now();
					ledgerCache.entries = this.ledger.read(Date.now() - 7 * 86_400_000);
				}
				return ledgerQuota(ledgerCache.entries, member, Date.now());
			},
			custom: (module) => this.customs.get(module),
			budget: (profile) => this.budgets.exceeded(profile.budgets ?? this.config.budgets),
		});
	}

	private registerVirtualModels(): void {
		for (const { id, name } of virtualModelIds(this.config)) {
			if (this.registered.has(id)) continue;
			this.registered.add(id);
			this.pi.registerVirtualModel({
				provider: this.config.virtualModel.provider,
				id,
				name,
				thinkingLevels: VIRTUAL_THINKING,
				route: (request, ctx) => this.route(id, request as unknown as RouteRequestLike, ctx),
			});
		}
	}

	isVirtual(provider: string | undefined): boolean {
		return provider === this.config.virtualModel.provider;
	}

	/** Reloads config with pi's catalog and project trust; registers any new virtual models. */
	async onSessionStart(ctx: ExtensionContext): Promise<void> {
		this.ctx = ctx;
		// Foreground children see the binding only until session_start ends.
		this.binding = readBinding() ?? this.binding;
		const loaded = loadConfig({
			agentDir: this.agentDir,
			cwd: ctx.cwd,
			projectTrusted: ctx.isProjectTrusted(),
			catalog: catalogView(ctx.modelRegistry as unknown as RegistryLike),
		});
		this.config = loaded.config;
		this.missingConfig = loaded.missing;
		this.engine.deps.config = this.config;
		this.engine.deps.missingConfig = this.missingConfig;
		this.engine.deps.cwd = ctx.cwd;
		this.debugLog = this.config.debug.log
			? new DebugLog({
					path: join(this.dir, "decisions.jsonl"),
					maxBytes: this.config.debug.maxBytes,
					maxFiles: this.config.debug.maxFiles,
					fullEvidence: this.config.debug.fullEvidence,
				})
			: undefined;
		if (!this.blocked) this.registerVirtualModels();
		await this.loadCustomStrategies();
		this.restoreControls(ctx);
		const model = ctx.model;
		this.routingSelected = this.isVirtual(model?.provider);
		if (model && !this.routingSelected) this.engine.originModel = `${model.provider}/${model.id}`;
		this.warmup.stop();
		void this.warmup.start(
			this.config.classifiers.map((entry) => ({
				model: entry.model,
				local: isLocalClassifier(ctx, entry.model, this.config.classifierProviders),
				...(entry.warmup !== undefined ? { warmup: entry.warmup } : {}),
				...(entry.keepWarmMs !== undefined ? { keepWarmMs: entry.keepWarmMs } : {}),
			})),
		);
		this.startUsage();
		await this.setupChildren(ctx);
		this.setupLive(ctx);
		this.setupAccountAffinity(ctx);
		if (this.blocked) ctx.ui.notify(`pi-switchboard: not routing because ${this.blocked} is installed; remove one of the two routers.`, "warning");
		this.announce(ctx);
		this.updateFooter(ctx);
	}

	private async setupChildren(ctx: ExtensionContext): Promise<void> {
		this.childRegistration?.dispose();
		this.childRegistration = undefined;
		if (!this.config.subagents.enabled || this.blocked) return;
		if (this.config.subagents.mode === "launch") {
			this.launchModeReason = "subagents.mode is launch";
			return;
		}
		const { registration, reason } = await registerChildExtension(this.agentDir, ctx.sessionManager.getSessionId(), this.entryPath);
		if (registration) {
			this.childRegistration = registration;
			delete this.launchModeReason;
		} else {
			this.launchModeReason = reason ?? "required child extensions unavailable";
			if (this.config.subagents.mode === "child")
				ctx.ui.notify(`pi-switchboard: subagents fall back to launch-time models: ${this.launchModeReason}`, "warning");
		}
	}

	/** In a subagent child, starts the live status and transcript mirror (DESIGN.md 11.6). */
	private setupLive(ctx: ExtensionContext): void {
		const liveDir = join(this.dir, "live");
		sweep(liveDir, this.config.live.retainHours);
		const header = ctx.sessionManager.getHeader() as { parentSession?: string } | null;
		const parent = header?.parentSession ?? process.env.PI_SUBAGENT_PARENT_SESSION;
		if (!parent) return;
		this.live?.finish("done");
		this.live = new LiveWriter({
			dir: liveDir,
			session: ctx.sessionManager.getSessionId(),
			parent,
			redact: createRedactor({ home: this.home, extra: this.config.classification.evidence.redact }),
			limits: { toolResultBytes: this.config.live.toolResultBytes },
			mirror: this.config.live.mirror,
		});
		const model = ctx.model;
		if (model) this.live.update({ launchModel: `${model.provider}/${model.id}` });
		if (this.binding?.launches.length === 1 && this.binding.launches[0]) {
			this.launchDecisionId = this.binding.launches[0].id;
			this.live.update({ launchDecisionId: this.launchDecisionId });
		}
	}

	/** Children map members onto the account their parent last used (DESIGN.md 5.5). */
	private setupAccountAffinity(ctx: ExtensionContext): void {
		const header = ctx.sessionManager.getHeader() as { parentSession?: string } | null;
		const sessionKey = ctx.sessionManager.getSessionFile() ?? ctx.sessionManager.getSessionId();
		const parentKey = header?.parentSession;
		const isProvider = (name: string) => this.ctx?.modelRegistry.getProvider(name) !== undefined;
		if (this.config.subagents.accountAffinity !== "parent") {
			delete this.engine.deps.accountFor;
			return;
		}
		this.engine.deps.accountFor = (provider) => {
			const accounts = this.store.read().accounts[parentKey ?? sessionKey] ?? {};
			return parentKey ? mapToAccount(provider, accounts, isProvider) : provider;
		};
	}

	/** Remembers which account this session last used per base provider, for its children. */
	private noteAccount(provider: string): void {
		const ctx = this.ctx;
		if (!ctx) return;
		const sessionKey = ctx.sessionManager.getSessionFile() ?? ctx.sessionManager.getSessionId();
		const base = provider.replace(/-\d+$/u, "");
		const real = ctx.modelRegistry.getProvider(base) !== undefined ? base : provider;
		this.store.update((data) => {
			const accounts = entryOf(data.accounts, sessionKey, () => ({}));
			accounts[real] = provider;
		});
	}

	/** Rewrites a `subagent` call's models (DESIGN.md 5.3). */
	async onSubagentCall(toolCallId: string, input: Record<string, unknown>, ctx: ExtensionContext): Promise<void> {
		this.ctx = ctx;
		const tasks = extractTasks(input);
		if (tasks.length === 0 || !this.engine.active) return;
		const model = ctx.model;
		const routing = this.isVirtual(model?.provider);
		const result = await routeLaunch(
			{
				engine: this.engine,
				toolCallId,
				parentTask: [...this.engine.recent].reverse().find((d) => d.scope === "main")?.task ?? 0,
				...(routing && model ? { parentVirtualId: model.id } : {}),
				...(!routing && model ? { parentModel: `${model.provider}/${model.id}` } : {}),
				parentThinking: (THINKING_LEVELS as readonly string[]).includes(ctx.thinkingLevel ?? "") ? (ctx.thinkingLevel as ThinkingLevel) : "medium",
				planPhase: await queryPlanPhase(this.pi.events),
				mode: this.launchModeReason ? "launch" : "child",
				pinLookup: await createPinLookup(this.agentDir, ctx.cwd, ctx.isProjectTrusted()),
				isSwitchboard: (name) => name.startsWith(`${this.config.virtualModel.provider}/`),
			},
			tasks,
		);
		this.routedSubagents += result.routed;
		const routed = result.decisions.filter((d) => d.subagent?.mode !== "skipped");
		const allNative = result.decisions.every((d) => d.subagent?.runner === "native");
		if (routed.length && allNative) {
			const parent = ctx.sessionManager.getSessionFile() ?? ctx.sessionManager.getSessionId();
			attachBinding(input, {
				parent,
				launches: routed.map((d) => {
					const task = tasks.find((t) => t.index === d.subagent?.taskIndex);
					return { d: taskDigest(d.subagent?.agent ?? "", task?.task ?? ""), a: d.subagent?.agent ?? "", id: d.id };
				}),
			});
		}
		this.launches.set(toolCallId, result.decisions);
		if (result.leases.length) this.launchLeases.set(toolCallId, result.leases);
		for (const decision of result.decisions) this.record(decision, ctx);
	}

	onSubagentResult(toolCallId: string, details: unknown): void {
		// Children still running in the background keep their lease until it expires.
		const leases = this.launchLeases.get(toolCallId);
		if (leases && !isAsyncLaunch(details)) {
			for (const lease of leases) this.engine.releaseLease(lease);
			this.launchLeases.delete(toolCallId);
		}
		const decisions = this.launches.get(toolCallId);
		if (!decisions) return;
		this.launches.delete(toolCallId);
		const links = resultLinks(details);
		const entry: LinkEntry = {
			v: 1,
			toolCallId,
			links: decisions.map((decision) => {
				const link = links.find((l) => l.index === decision.subagent?.taskIndex) ?? (decisions.length === 1 ? links[0] : undefined);
				return {
					decisionId: decision.id,
					taskIndex: decision.subagent?.taskIndex ?? 0,
					...(link?.runId ? { runId: link.runId } : {}),
					...(link?.sessionFile ? { sessionFile: link.sessionFile } : {}),
					...(link?.model ? { model: link.model } : {}),
				};
			}),
		};
		this.pi.appendEntry(LINK_TYPE, entry);
	}

	/** Starts reading pi-usage for the providers quota strategies need; does nothing when none do. */
	private startUsage(): void {
		this.stopUsageListener?.();
		this.stopUsageListener = this.pi.events.on(CHANGED_CHANNEL, () => this.usage.invalidate());
		this.refreshUsage();
	}

	/** Non-blocking: reports arrive for the next decision. */
	refreshUsage(): void {
		if (this.config.metrics.piUsage === "off") return;
		const providers = quotaProviders(Object.values(this.config.profiles));
		if (providers.length) void this.usage.refreshFor(providers).catch(() => undefined);
	}

	/** Environment warnings around the config (Plannotator, multi-pass, classifiers); also used by /tier validate. */
	environmentChecks(ctx: ExtensionContext): string[] {
		return runChecks({
			config: this.config,
			agentDir: this.agentDir,
			cwd: ctx.cwd,
			projectTrusted: ctx.isProjectTrusted(),
			plannotatorBuiltin: join(this.agentDir, "npm", "node_modules", "@plannotator", "pi-extension", "plannotator.json"),
			classifierAvailable: (model) => {
				const ref = model.indexOf("/");
				return ref > 0 && ctx.modelRegistry.findOfType("classifier", model.slice(0, ref), model.slice(ref + 1)) !== undefined;
			},
			classifierIsLocal: (model) => isLocalClassifier(ctx, model, this.config.classifierProviders),
		});
	}

	/** Shows config and environment warnings once, and the terms-of-service notice only the first time ever. */
	private announce(ctx: ExtensionContext): void {
		const notices = [...withoutTosWarnings(this.config.warnings), ...(this.blocked ? [] : this.environmentChecks(ctx))];
		const shown = notices.slice(0, 6);
		for (const warning of shown) ctx.ui.notify(`pi-switchboard: ${warning}`, "warning");
		if (notices.length > shown.length) ctx.ui.notify(`pi-switchboard: ${notices.length - shown.length} more warnings; run /tier validate`, "warning");
		if (this.missingConfig && !this.stateFile.read().warned?.firstRun) {
			ctx.ui.notify(FIRST_RUN_NOTICE, "info");
			this.stateFile.write((state) => ({ ...state, warned: { ...state.warned, firstRun: true } }));
		}
		if (needsTosNotice(this.config) && !this.stateFile.read().warned?.tos) {
			ctx.ui.notify(`pi-switchboard: ${TOS_WARNING}. This notice is shown once.`, "warning");
			this.stateFile.write((state) => ({ ...state, warned: { ...state.warned, tos: true } }));
		}
	}

	private async loadCustomStrategies(): Promise<void> {
		for (const profile of Object.values(this.config.profiles)) {
			for (const tier of profile.tiers) {
				const module = tier.strategy.module;
				if (!module || this.customs.has(module)) continue;
				try {
					this.customs.set(module, await loadCustomStrategy(module, this.home));
				} catch (error) {
					this.config.warnings.push(`custom strategy ${module}: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
		}
	}

	restoreControls(ctx: ExtensionContext): void {
		let control: ControlEntry | undefined;
		for (const entry of ctx.sessionManager.getBranch()) {
			const custom = entry as { type?: string; customType?: string; data?: unknown };
			if (custom.type === "custom" && custom.customType === CONTROL_TYPE) control = { ...control, ...(custom.data as ControlEntry) };
		}
		this.engine.controls = {
			dryRun: control?.dryRun ?? false,
			...(control?.pin ? { pin: control.pin } : {}),
			...(control?.profile ? { profile: control.profile } : {}),
		};
	}

	/** Saves a control change on the session branch. */
	saveControls(): void {
		const { pin, dryRun, profile } = this.engine.controls;
		this.pi.appendEntry<ControlEntry>(CONTROL_TYPE, { v: 1, pin: pin ?? null, dryRun, profile: profile ?? null });
	}

	onModelSelect(model: { provider: string; id: string }, ctx: ExtensionContext): void {
		this.ctx = ctx;
		this.routingSelected = this.isVirtual(model.provider);
		if (!this.routingSelected) this.engine.originModel = `${model.provider}/${model.id}`;
		this.updateFooter(ctx);
	}

	/** In a child: its agent, written to the live status, and the parent's launch decision it belongs to. */
	private identifyChild(messages: readonly TranscriptMessage[]): string | undefined {
		const agent = agentFromMessages(messages);
		if (agent) this.live?.update({ agent });
		if (this.binding && !this.launchDecisionId) {
			const id = matchLaunch(this.binding, agent, messageText(messages[lastUserIndex(messages)]?.content));
			if (id) {
				this.launchDecisionId = id;
				this.live?.update({ launchDecisionId: id });
			}
		}
		return agent;
	}

	async route(virtualId: string, request: RouteRequestLike, ctx: ExtensionContext) {
		this.ctx = ctx;
		const messages = request.messages as readonly TranscriptMessage[];
		const header = ctx.sessionManager.getHeader() as { parentSession?: string } | null;
		const scope = header?.parentSession || process.env.PI_SUBAGENT_CHILD === "1" ? "subagent" : "main";
		const agent = scope === "subagent" ? this.identifyChild(messages) : undefined;
		const thinking = (THINKING_LEVELS as readonly string[]).includes(request.thinkingLevel) ? (request.thinkingLevel as ThinkingLevel) : "medium";
		const previous = choice(request.previous);
		const failed = request.failed
			? { ...choice(request.failed), ...(request.failed.message.errorMessage ? { errorMessage: request.failed.message.errorMessage } : {}) }
			: undefined;
		let out: Awaited<ReturnType<SwitchboardEngine["route"]>>;
		try {
			out = await this.engine.route({
				virtualId,
				selectedThinking: thinking,
				reason: request.reason,
				messages,
				scope,
				...(agent ? { agent } : {}),
				...(previous ? { previous } : {}),
				...(failed?.provider && failed.id ? { failed: failed as ModelChoice & { errorMessage?: string } } : {}),
				...(request.state ? { state: request.state as RouterState } : {}),
				...(request.signal ? { signal: request.signal } : {}),
				...(request.reason === "direct" ? { contextTokens: estimateTokens(request.messages) } : {}),
			});
		} catch (error) {
			if (error instanceof ExhaustedError) {
				ctx.ui.notify(error.message, "warning");
				if (error.earliest && request.reason === "user") this.autoContinue.schedule(error.earliest.at);
			}
			throw error;
		}
		if (request.reason === "user") this.refreshUsage();
		if (request.reason !== "direct") {
			this.noteAccount(out.provider);
			this.engine.beginRequest();
		}
		const model = ctx.modelRegistry.find(out.provider, out.id);
		if (!model) throw new Error(`pi-switchboard: ${out.provider}/${out.id} is not in pi's model catalog`);
		if (out.decision) this.record(out.decision, ctx);
		this.lastRouteAt = Date.now();
		return { model, thinkingLevel: out.thinking, ...(out.state ? { state: out.state } : {}) };
	}

	record(decision: DecisionEntry, ctx?: ExtensionContext): void {
		if (decision.switch.cacheMiss) this.switches++;
		if (this.launchDecisionId && decision.scope === "subagent" && decision.reason !== "launch") decision.launchDecisionId = this.launchDecisionId;
		if (decision.reason === "user" && decision.scope === "main") this.budgets.startTask(decision.task);
		if (decision.profile.name && decision.profile.name !== this.snapshotProfile) this.snapshot(decision.profile.name, ctx ?? this.ctx);
		if (this.live && decision.tier.chosen) this.live.update({ tier: decision.tier.chosen });
		if (decision.reason === "launch") {
			this.launchDecisions.push(decision);
			if (this.launchDecisions.length > MAX_LAUNCH_DECISIONS) this.launchDecisions.shift();
		}
		this.pi.appendEntry(DECISION_TYPE, decision);
		const target = ctx ?? this.ctx;
		this.debugLog?.write(decision, { session: target?.sessionManager.getSessionId() ?? "", cwd: target?.cwd ?? "" });
		for (const listener of this.listeners) {
			try {
				listener(decision);
			} catch {
				// A broken listener never breaks routing.
			}
		}
		this.updateFooter(ctx ?? this.ctx);
	}

	/** Records the active profile's tiers and catalog prices for the inspector's counterfactuals. */
	private snapshot(name: string, ctx: ExtensionContext | undefined): void {
		const profile = this.config.profiles[name];
		if (!profile) return;
		this.snapshotProfile = name;
		const price = (provider: string, id: string) => {
			const model = ctx?.modelRegistry.find(provider, id) as
				| { cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } }
				| undefined;
			const cost = model?.cost;
			return cost && (cost.input || cost.output)
				? {
						input: cost.input ?? 0,
						output: cost.output ?? 0,
						...(cost.cacheRead ? { cacheRead: cost.cacheRead } : {}),
						...(cost.cacheWrite ? { cacheWrite: cost.cacheWrite } : {}),
					}
				: undefined;
		};
		const entry: ProfileSnapshotEntry = {
			v: 1,
			profile: name,
			baselineTier: profile.baselineTier,
			topTier: profile.tiers.at(-1)?.name ?? profile.fallbackTier,
			tiers: profile.tiers.map((tier) => ({
				name: tier.name,
				rank: tier.rank,
				members: tier.members.map((m) => {
					const p = price(m.provider, m.id);
					return { key: m.key, ...(p ? { price: p } : {}) };
				}),
			})),
		};
		this.pi.appendEntry(PROFILE_TYPE, entry);
	}

	onAfterProviderResponse(status: number, headers: Record<string, string>): void {
		if (this.routingSelected) this.engine.noteResponse(status, headers);
	}

	/** Usage ledger, health and the usage-limit rewrite (DESIGN.md 4.4). */
	onAssistantMessage(
		message: {
			provider: string;
			model: string;
			stopReason?: string;
			errorMessage?: string;
			usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } };
		},
		ctx: ExtensionContext,
	): { errorMessage: string } | undefined {
		this.engine.endRequest();
		if (!this.isVirtual(ctx.model?.provider)) return undefined;
		const model = { provider: message.provider, id: message.model };
		if (message.stopReason === "error") {
			const prepared = this.engine.prepareFailover(model, message.errorMessage);
			if (!prepared.canFailOver) {
				if (prepared.errorClass === "quota" || prepared.errorClass === "auth") {
					ctx.ui.notify(
						`pi-switchboard: ${message.provider} is unavailable (${prepared.errorClass}) and no other model of this profile can take over.`,
						"warning",
					);
				}
				return undefined;
			}
			return {
				errorMessage: `pi-switchboard: service temporarily unavailable on ${message.provider}/${message.model} (${prepared.errorClass}); retrying on another model. Original error: ${(message.errorMessage ?? "").slice(0, 200)}`,
			};
		}
		this.engine.noteSuccess(model, this.lastRouteAt ? Date.now() - this.lastRouteAt : undefined);
		const usage = message.usage;
		const last = this.engine.recent.at(-1);
		this.budgets.add((usage?.input ?? 0) + (usage?.output ?? 0) + (usage?.cacheRead ?? 0) + (usage?.cacheWrite ?? 0), usage?.cost?.total ?? 0);
		const profile = last ? this.config.profiles[last.profile.name] : undefined;
		for (const crossed of this.budgets.newlyCrossed(profile?.budgets ?? this.config.budgets)) {
			ctx.ui.notify(
				`pi-switchboard: ${crossed.scope} ${crossed.metric === "costUsd" ? "cost" : "tokens"} budget exceeded (${crossed.metric === "costUsd" ? `$${crossed.used.toFixed(2)}` : crossed.used} of ${crossed.limit})`,
				"warning",
			);
		}
		this.ledger.append({
			ts: new Date().toISOString(),
			session: ctx.sessionManager.getSessionId(),
			task: last?.task ?? 0,
			provider: message.provider,
			model: message.model,
			...(last ? { tier: last.tier.chosen, profile: last.profile.name, scope: last.scope } : {}),
			input: usage?.input ?? 0,
			output: usage?.output ?? 0,
			cacheRead: usage?.cacheRead ?? 0,
			cacheWrite: usage?.cacheWrite ?? 0,
			cost: usage?.cost?.total ?? 0,
		});
		return undefined;
	}

	updateFooter(ctx: ExtensionContext | undefined): void {
		if (!ctx) return;
		const last = this.engine.recent.at(-1);
		const pin = this.engine.controls.pin?.target;
		const text =
			this.routingSelected || !last
				? footerText(this.config.ui.status, last, {
						...(this.routingSelected && !this.engine.active ? { inactive: this.engine.inactiveReason() } : {}),
						...(pin ? { pinned: pin } : {}),
						dryRun: this.engine.controls.dryRun,
						switches: this.switches,
					})
				: footerText(this.config.ui.status, last, { off: true });
		ctx.ui.setStatus(STATUS_KEY, this.routingSelected || last ? text : undefined);
		ctx.ui.setStatus(STATUS_SUB_KEY, this.routedSubagents > 0 ? renderTemplate(this.config.ui.statusSub, { routed: this.routedSubagents }) : undefined);
	}

	/** When a pending auto-continue fires, epoch ms. */
	get autoContinueAt(): number | undefined {
		return this.autoContinue.at;
	}

	cancelAutoContinue = (): void => this.autoContinue.cancel();

	shutdown(): void {
		this.stopUsageListener?.();
		this.stopUsageListener = undefined;
		this.engine.endRequest();
		for (const leases of this.launchLeases.values()) for (const lease of leases) this.engine.releaseLease(lease);
		this.launchLeases.clear();
		this.cancelAutoContinue();
		this.live?.finish(this.live.status.status === "error" ? "error" : "done");
		this.warmup.stop();
		this.childRegistration?.dispose();
		this.childRegistration = undefined;
	}
}
