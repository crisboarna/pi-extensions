import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AccountKey } from "../core/account.ts";
import { logData } from "../core/block-dialog.ts";
import { definesApiKeyHelper } from "../core/claude-bridge.ts";
import type { ConfigResult } from "../core/config.ts";
import { type ConfigSnapshot, createConfigState } from "../core/config-state.ts";
import { type BlockCause, type Decision, decide, type PlaceOutcome } from "../core/decide.ts";
import { footerText } from "../core/footer.ts";
import { configFallbackWarning, headlessBlockMessage } from "../core/messages.ts";
import { applyOverrides, NO_OVERRIDES, type Overrides, releaseOnce } from "../core/overrides.ts";
import { type RemoteUrls, resolvePlaceZone } from "../core/place.ts";
import { FIRST_RUN_NOTICE } from "../core/tour.ts";
import { createAccountResolver } from "./account-of.ts";
import { registerGuardCommand } from "./commands.ts";
import { BLOCK_EXIT_CODE } from "./exit-code.ts";
import { abortOnError, errorText, logHandlerError, reportHandlerError } from "./handler-errors.ts";
import { runInteractiveBlock } from "./interactive-block.ts";
import { registerModelGuard } from "./model-guard.ts";
import { createUnknownAccountGate, type UnknownAccountDeps } from "./unknown-account.ts";

/** Everything the hooks read from or write to the outside world, so tests can inject fakes. */
export interface GuardDeps extends Omit<UnknownAccountDeps, "configPath" | "writeStderr"> {
	home: string;
	configPath: string;
	/** The file text, `undefined` when the file is missing; may throw. */
	readConfigText(path: string): string | undefined;
	/** The real path, `undefined` when the path does not exist; may throw. */
	realpath(path: string): string | undefined;
	/** The fetch URLs of the remotes of the repository around `cwd`, or why git could not tell. */
	readRemoteUrls(cwd: string): RemoteUrls;
	writeStderr(text: string): void;
	setExitCode(code: number): void;
	/** Provider ids that pool several accounts under one id; `/guard` lists them. Defaults to none. */
	pooledProviders?(ctx: ExtensionContext): string[];
	/** Remembers that the first-run notice was shown; without it the notice never shows. */
	firstRun?: { seen(): boolean; remember(): void };
}

/** A decision with the place and config it was made on. */
interface Checked {
	decision: Decision;
	place: PlaceOutcome;
	config: ConfigResult;
}

export function registerGuard(pi: ExtensionAPI, deps: GuardDeps): void {
	// Only the place zone is cached (DESIGN.md section 5.4); tags are read live at every check.
	let cachedPlace: { cwd: string; place: PlaceOutcome } | undefined;
	// Overrides live only in this session's memory and are never written to disk (DESIGN.md section 10).
	let overrides: Overrides = NO_OVERRIDES;
	// Set when `input` logged the process Override for the turn that is about to start, so `before_agent_start` does not log it again.
	let processOverrideLoggedAtInput = false;
	const overrideStore = {
		current: () => overrides,
		replace(next: Overrides, ctx: ExtensionContext) {
			overrides = next;
			refreshFooter(ctx);
		},
	};

	const accountOfModel = createAccountResolver({
		env: deps.env ?? {},
		home: deps.home,
		// Only the presence of the helper is read; its command is never kept (DESIGN.md section 6).
		usesApiKeyHelper(configDirectory) {
			try {
				return definesApiKeyHelper(deps.readConfigText(`${configDirectory}/settings.json`));
			} catch {
				return false;
			}
		},
	});

	const configState = createConfigState(() => deps.readConfigText(deps.configPath));
	const unknownAccounts = createUnknownAccountGate(pi, deps, configState);

	function loadSnapshot(ctx: ExtensionContext): ConfigSnapshot {
		const snapshot = configState.load();
		if (snapshot.warning) {
			const text = configFallbackWarning(snapshot.warning.errors, deps);
			if (ctx.hasUI) ctx.ui.notify(text, "warning");
			else deps.writeStderr(`${text}\n`);
		}
		return snapshot;
	}

	const loadConfig = (ctx: ExtensionContext): ConfigResult => loadSnapshot(ctx).result;

	function resolvePlace(cwd: string, config: ConfigResult): PlaceOutcome {
		if (!config.ok) return { ok: false, reason: "the config is invalid" };
		const path = deps.realpath(cwd);
		if (path === undefined) return { ok: false, reason: `cannot resolve the real path of ${cwd}` };
		const resolved = resolvePlaceZone(path, config.config.places, config.config.defaultZone, deps, () => deps.readRemoteUrls(cwd));
		if (!resolved.ok) return resolved;
		return { ok: true, path, zone: resolved.zone, ...(resolved.ruleIndex === undefined ? {} : { ruleIndex: resolved.ruleIndex }) };
	}

	/** Drops the cached place zone and resolves it again with the file as it is now (DESIGN.md section 11). */
	function reresolvePlace(ctx: ExtensionContext): void {
		cachedPlace = undefined;
		currentPlace(ctx.cwd, loadConfig(ctx));
		refreshFooter(ctx);
	}

	function currentPlace(cwd: string, config: ConfigResult): PlaceOutcome {
		if (cachedPlace?.cwd === cwd) return cachedPlace.place;
		const place = resolvePlace(cwd, config);
		if (config.ok) cachedPlace = { cwd, place };
		return place;
	}

	function accountOf(ctx: ExtensionContext): AccountKey | undefined {
		return ctx.model ? accountOfModel(ctx, ctx.model) : undefined;
	}

	/** Draws the footer item again (DESIGN.md section 12). A failure shows in the footer and never aborts the caller. */
	function refreshFooter(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		try {
			const snapshot = loadSnapshot(ctx);
			ctx.ui.setStatus(
				"guard",
				footerText({
					place: currentPlace(ctx.cwd, snapshot.result),
					account: accountOf(ctx),
					config: snapshot.result,
					usingLastValid: snapshot.fallback !== undefined,
					overrides,
				}),
			);
		} catch {
			// The hooks that check a turn report their own failure; the footer only says it cannot decide.
			ctx.ui.setStatus("guard", "guard ! check failed");
		}
	}

	function check(ctx: ExtensionContext): Checked | undefined {
		const account = accountOf(ctx);
		if (!account) return undefined;
		const config = loadConfig(ctx);
		const place = currentPlace(ctx.cwd, config);
		return { decision: decide({ place, account, config }), place, config };
	}

	/** Writes the text to stderr and sets the Block exit code (ADR 0005). */
	function failHeadless(text: string): void {
		deps.writeStderr(text);
		deps.setExitCode(BLOCK_EXIT_CODE);
	}

	function block(cause: BlockCause, text: string, ctx: ExtensionContext): void {
		const message = headlessBlockMessage(cause, deps);
		if (ctx.hasUI) {
			ctx.ui.notify(message, "error");
			ctx.ui.setEditorText(text);
			return;
		}
		failHeadless(message);
	}

	pi.on(
		"session_start",
		abortOnError(pi, "session_start", failHeadless, (_event, ctx) => {
			cachedPlace = undefined;
			overrides = NO_OVERRIDES;
			processOverrideLoggedAtInput = false;
			configState.reset();
			unknownAccounts.reset();
			currentPlace(ctx.cwd, loadConfig(ctx));
			refreshFooter(ctx);
			showFirstRunNotice(ctx);
		}),
	);

	/** Once per agent folder: with a UI, before any config file exists. A failure to read or remember only skips the notice. */
	function showFirstRunNotice(ctx: ExtensionContext): void {
		const { firstRun } = deps;
		if (!ctx.hasUI || !firstRun) return;
		try {
			if (deps.readConfigText(deps.configPath) !== undefined || firstRun.seen()) return;
			firstRun.remember();
		} catch {
			return;
		}
		ctx.ui.notify(FIRST_RUN_NOTICE, "info");
	}

	pi.on(
		"model_select",
		abortOnError(pi, "model_select", failHeadless, (_event, ctx) => refreshFooter(ctx)),
	);

	registerGuardCommand(pi, {
		home: deps.home,
		configPath: deps.configPath,
		configState,
		...(deps.writeConfigText ? { writeConfigText: deps.writeConfigText } : {}),
		loadSnapshot,
		currentPlace: (ctx, snapshot) => currentPlace(ctx.cwd, snapshot.result),
		placeUnder: (ctx, config) => resolvePlace(ctx.cwd, { ok: true, config }),
		placeAt: (path, config) => resolvePlace(path, { ok: true, config }),
		reresolvePlace,
		realpath: deps.realpath,
		readRemoteUrls: deps.readRemoteUrls,
		overrides: overrideStore.current,
		...(deps.pooledProviders ? { pooledProviders: deps.pooledProviders } : {}),
		...(deps.multiPassLabel ? { multiPassLabel: deps.multiPassLabel } : {}),
		refreshFooter,
		writeStderr: deps.writeStderr,
		setExitCode: deps.setExitCode,
		failHeadless,
		accountOfModel,
	});

	registerModelGuard(pi, {
		// The process Override covers an Unknown account in every hook. `input` logs and warns when it lets a turn through;
		// a turn that starts without `input` (`sendMessage` with `triggerTurn`) is logged here, when it is about to start.
		evaluate(ctx, startsTurn) {
			const checked = checkOrFail(ctx);
			const alreadyLogged = startsTurn && processOverrideLoggedAtInput;
			if (startsTurn) processOverrideLoggedAtInput = false;
			if (checked?.decision.verdict !== "block" || !unknownAccounts.covers(checked.decision.cause, ctx)) return checked;
			if (startsTurn && !alreadyLogged) unknownAccounts.letThrough(checked.decision.cause, ctx);
			return { ...checked, decision: { verdict: "match" } };
		},
		overrides: overrideStore,
		messages: deps,
		failHeadless,
		accountOfModel,
	});

	/** The account an internal error Blocks: the current model's, so both Overrides can still cover it (ADR 0001). */
	function accountOfFailedCheck(ctx: ExtensionContext): AccountKey {
		try {
			const account = accountOf(ctx);
			if (account) return account;
		} catch {
			// The account itself could not be read; the fallback below still gives the Overrides something to bind to.
		}
		return { provider: ctx.model?.provider ?? "unknown", source: "unresolved" };
	}

	/** Checks the turn; an error in the check Blocks the turn itself, because pi swallows hook errors and carries on (ADR 0001). */
	function checkOrFail(ctx: ExtensionContext): Checked | undefined {
		try {
			return check(ctx);
		} catch (error) {
			return {
				decision: { verdict: "block", cause: { kind: "internal-error", account: accountOfFailedCheck(ctx), reason: errorText(error) } },
				place: { ok: false, reason: "internal error" },
				config: { ok: false, errors: [] },
			};
		}
	}

	function checkOrBlock(ctx: ExtensionContext): Checked | undefined {
		const checked = checkOrFail(ctx);
		if (checked?.decision.verdict === "block" && checked.decision.cause.kind === "internal-error")
			logHandlerError(pi, "input", new Error(checked.decision.cause.reason));
		return checked;
	}

	// Every user turn passes here, `/`-prefixed text included: skills and prompt templates arrive unexpanded.
	pi.on("input", async (event, ctx) => {
		let checked = checkOrBlock(ctx);
		// Picks up a hand edit of the file; skipped when the check itself failed, which is reported already.
		if (checked?.decision.verdict !== "block" || checked.decision.cause.kind !== "internal-error") refreshFooter(ctx);
		if (!checked) return undefined;
		let verdict = applyOverrides(checked.decision, checked.place, overrides);
		if (verdict.verdict !== "block") return undefined;
		try {
			if (verdict.cause.kind === "unknown-account") {
				if (unknownAccounts.letThrough(verdict.cause, ctx)) {
					processOverrideLoggedAtInput = true;
					return undefined;
				}
				// A tag that gives a Match lets the turn proceed with no resubmit; any other tag falls to the Block with the new tag in its title.
				if (await unknownAccounts.tag(verdict.cause, ctx)) {
					refreshFooter(ctx);
					checked = checkOrBlock(ctx);
					if (!checked) return undefined;
					verdict = applyOverrides(checked.decision, checked.place, overrides);
					if (verdict.verdict !== "block") return undefined;
				}
			}
			const { cause } = verdict;
			if (cause.kind !== "internal-error") pi.appendEntry("guard.block", logData(cause, checked.place));
			if (ctx.hasUI) {
				return await runInteractiveBlock({
					pi,
					ctx,
					accountOfModel,
					cause,
					place: checked.place,
					config: checked.config.ok ? checked.config.config : undefined,
					text: event.text,
					overrides: overrideStore,
					messages: deps,
				});
			}
			block(cause, event.text, ctx);
		} catch (error) {
			reportHandlerError(pi, ctx, "input", error, failHeadless);
		}
		return { action: "handled" };
	});

	// Allow once covers one turn (DESIGN.md section 10).
	pi.on(
		"agent_end",
		abortOnError(pi, "agent_end", failHeadless, () => {
			overrides = releaseOnce(overrides);
			processOverrideLoggedAtInput = false;
		}),
	);
}
