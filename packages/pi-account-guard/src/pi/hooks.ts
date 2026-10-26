import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AccountKey } from "../core/account.ts";
import type { ConfigResult } from "../core/config.ts";
import { createConfigState, type ConfigSnapshot } from "../core/config-state.ts";
import { decide, type BlockCause, type Decision, type PlaceOutcome } from "../core/decide.ts";
import { logData } from "../core/block-dialog.ts";
import { footerText } from "../core/footer.ts";
import { configFallbackWarning, headlessBlockMessage } from "../core/messages.ts";
import { applyOverrides, NO_OVERRIDES, releaseOnce, type Overrides } from "../core/overrides.ts";
import { resolvePlaceZone, type RemoteUrls } from "../core/place.ts";
import { accountOfModel } from "./account-of.ts";
import { abortOnError, errorText, logHandlerError, reportHandlerError } from "./handler-errors.ts";
import { registerGuardCommand } from "./commands.ts";
import { runInteractiveBlock } from "./interactive-block.ts";
import { registerModelGuard } from "./model-guard.ts";
import { createUnknownAccountGate, type UnknownAccountDeps } from "./unknown-account.ts";

/** Exit code of a headless Block (ADR 0005). */
const BLOCK_EXIT_CODE = 77;

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
	pooledProviders?(): string[];
}

export function registerGuard(pi: ExtensionAPI, deps: GuardDeps): void {
	// Only the place zone is cached (DESIGN.md section 5.4); tags are read live at every check.
	let cachedPlace: { cwd: string; place: PlaceOutcome } | undefined;
	// Overrides live only in this session's memory and are never written to disk (DESIGN.md section 10).
	let overrides: Overrides = NO_OVERRIDES;
	const overrideStore = {
		current: () => overrides,
		replace(next: Overrides, ctx: ExtensionContext) {
			overrides = next;
			refreshFooter(ctx);
		},
	};

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
			ctx.ui.setStatus("guard", footerText({ place: currentPlace(ctx.cwd, snapshot.result), account: accountOf(ctx), config: snapshot.result, usingLastValid: snapshot.fallback !== undefined, overrides }));
		} catch {
			// The hooks that check a turn report their own failure; the footer only says it cannot decide.
			ctx.ui.setStatus("guard", "guard ! check failed");
		}
	}

	function check(ctx: ExtensionContext): { decision: Decision; place: PlaceOutcome; config: ConfigResult } | undefined {
		const account = accountOf(ctx);
		if (!account) return undefined;
		const config = loadConfig(ctx);
		const place = currentPlace(ctx.cwd, config);
		return { decision: decide({ place, account, config }), place, config };
	}

	function block(cause: BlockCause, text: string, ctx: ExtensionContext): void {
		const message = headlessBlockMessage(cause, deps);
		if (ctx.hasUI) {
			ctx.ui.notify(message, "error");
			ctx.ui.setEditorText(text);
			return;
		}
		deps.writeStderr(message);
		deps.setExitCode(BLOCK_EXIT_CODE);
	}

	pi.on(
		"session_start",
		abortOnError(pi, "session_start", deps.writeStderr, (_event, ctx) => {
			cachedPlace = undefined;
			overrides = NO_OVERRIDES;
			configState.reset();
			unknownAccounts.reset();
			currentPlace(ctx.cwd, loadConfig(ctx));
			refreshFooter(ctx);
		}),
	);

	pi.on("model_select", (_event, ctx) => refreshFooter(ctx));

	registerGuardCommand(pi, {
		home: deps.home,
		configPath: deps.configPath,
		configState,
		writeConfigText: deps.writeConfigText,
		loadSnapshot,
		currentPlace: (ctx, snapshot) => currentPlace(ctx.cwd, snapshot.result),
		overrides: overrideStore.current,
		pooledProviders: deps.pooledProviders,
		multiPassLabel: deps.multiPassLabel,
		refreshFooter,
		writeStderr: deps.writeStderr,
		setExitCode: deps.setExitCode,
	});

	registerModelGuard(pi, {
		// The process Override covers an Unknown account in every hook; the `input` hook logs and warns when it lets a turn through.
		evaluate(ctx) {
			const checked = check(ctx);
			if (checked?.decision.verdict === "block" && unknownAccounts.covers(checked.decision.cause, ctx)) return { ...checked, decision: { verdict: "match" } };
			return checked;
		},
		overrides: overrideStore,
		messages: deps,
		writeStderr: deps.writeStderr,
		failHeadless(text) {
			deps.writeStderr(text);
			deps.setExitCode(BLOCK_EXIT_CODE);
		},
	});

	/** Checks the turn; an error in the check Blocks the turn itself, because pi swallows hook errors and carries on (ADR 0001). */
	function checkOrBlock(ctx: ExtensionContext): ReturnType<typeof check> {
		try {
			return check(ctx);
		} catch (error) {
			logHandlerError(pi, "input", error);
			return { decision: { verdict: "block", cause: { kind: "internal-error", reason: errorText(error) } }, place: { ok: false, reason: "internal error" }, config: { ok: false, errors: [] } };
		}
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
				if (unknownAccounts.letThrough(verdict.cause, ctx)) return undefined;
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
			if (ctx.hasUI && cause.kind !== "internal-error") {
				return await runInteractiveBlock({
					pi,
					ctx,
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
			reportHandlerError(pi, ctx, "input", error, deps.writeStderr);
		}
		return { action: "handled" };
	});

	// Allow once covers one turn (DESIGN.md section 10).
	pi.on("agent_end", async () => {
		overrides = releaseOnce(overrides);
	});
}
