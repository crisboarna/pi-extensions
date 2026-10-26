import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AccountKey } from "../core/account.ts";
import type { ConfigResult } from "../core/config.ts";
import { createConfigState } from "../core/config-state.ts";
import { decide, type BlockCause, type Decision, type PlaceOutcome } from "../core/decide.ts";
import { logData } from "../core/block-dialog.ts";
import { configFallbackWarning, headlessBlockMessage } from "../core/messages.ts";
import { applyOverrides, NO_OVERRIDES, releaseOnce, type Overrides } from "../core/overrides.ts";
import { resolvePlaceZone, type RemoteUrls } from "../core/place.ts";
import { accountOfModel } from "./account-of.ts";
import { abortOnError, errorText, logHandlerError, reportHandlerError } from "./handler-errors.ts";
import { runInteractiveBlock, showOverrideFooter } from "./interactive-block.ts";
import { registerModelGuard } from "./model-guard.ts";

/** Exit code of a headless Block (ADR 0005). */
const BLOCK_EXIT_CODE = 77;

/** Everything the hooks read from or write to the outside world, so tests can inject fakes. */
export interface GuardDeps {
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
}

export function registerGuard(pi: ExtensionAPI, deps: GuardDeps): void {
	// Only the place zone is cached (DESIGN.md section 5.4); tags are read live at every check.
	let cachedPlace: { cwd: string; place: PlaceOutcome } | undefined;
	// Overrides live only in this session's memory and are never written to disk (DESIGN.md section 10).
	let overrides: Overrides = NO_OVERRIDES;
	const overrideStore = {
		current: () => overrides,
		replace: (next: Overrides) => void (overrides = next),
	};

	const configState = createConfigState(() => deps.readConfigText(deps.configPath));

	function loadConfig(ctx: ExtensionContext): ConfigResult {
		const { result, warning } = configState.load();
		if (warning) {
			const text = configFallbackWarning(warning.errors, deps);
			if (ctx.hasUI) ctx.ui.notify(text, "warning");
			else deps.writeStderr(`${text}\n`);
		}
		return result;
	}

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
			if (ctx.hasUI) showOverrideFooter(ctx, overrides);
			currentPlace(ctx.cwd, loadConfig(ctx));
		}),
	);

	registerModelGuard(pi, {
		evaluate: check,
		overrides: overrideStore,
		messages: deps,
		writeStderr: deps.writeStderr,
		failHeadless(text) {
			deps.writeStderr(text);
			deps.setExitCode(BLOCK_EXIT_CODE);
		},
	});

	// Every user turn passes here, `/`-prefixed text included: skills and prompt templates arrive unexpanded.
	pi.on("input", async (event, ctx) => {
		let checked: ReturnType<typeof check>;
		try {
			checked = check(ctx);
		} catch (error) {
			// pi swallows hook errors and carries on, so an error here must Block itself (ADR 0001).
			logHandlerError(pi, "input", error);
			checked = { decision: { verdict: "block", cause: { kind: "internal-error", reason: errorText(error) } }, place: { ok: false, reason: "internal error" }, config: { ok: false, errors: [] } };
		}
		if (!checked) return undefined;
		const verdict = applyOverrides(checked.decision, checked.place, overrides);
		if (verdict.verdict !== "block") return undefined;
		const { cause } = verdict;
		try {
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
