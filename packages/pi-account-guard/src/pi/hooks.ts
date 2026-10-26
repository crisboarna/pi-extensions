import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { accountKey, type AccountKey } from "../core/account.ts";
import { parseConfig, type ConfigResult } from "../core/config.ts";
import { decide, type BlockCause, type Decision, type PlaceOutcome } from "../core/decide.ts";
import { headlessBlockMessage } from "../core/messages.ts";
import { resolvePlaceZone } from "../core/place.ts";

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
	writeStderr(text: string): void;
	setExitCode(code: number): void;
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function registerGuard(pi: ExtensionAPI, deps: GuardDeps): void {
	// Only the place zone is cached (DESIGN.md section 5.4); tags are read live at every check.
	let cachedPlace: { cwd: string; place: PlaceOutcome } | undefined;

	function loadConfig(): ConfigResult {
		try {
			return parseConfig(deps.readConfigText(deps.configPath));
		} catch (error) {
			return { ok: false, errors: [{ path: "", message: `cannot read the file: ${errorText(error)}` }] };
		}
	}

	function resolvePlace(cwd: string, config: ConfigResult): PlaceOutcome {
		if (!config.ok) return { ok: false, reason: "the config is invalid" };
		const path = deps.realpath(cwd);
		if (path === undefined) return { ok: false, reason: `cannot resolve the real path of ${cwd}` };
		const { zone, ruleIndex } = resolvePlaceZone(path, config.config.places, config.config.defaultZone, deps);
		return { ok: true, path, zone, ...(ruleIndex === undefined ? {} : { ruleIndex }) };
	}

	function currentPlace(cwd: string, config: ConfigResult): PlaceOutcome {
		if (cachedPlace?.cwd === cwd) return cachedPlace.place;
		const place = resolvePlace(cwd, config);
		if (config.ok) cachedPlace = { cwd, place };
		return place;
	}

	function accountOf(ctx: ExtensionContext): AccountKey | undefined {
		const model = ctx.model;
		if (!model) return undefined;
		return accountKey({
			provider: model.provider,
			usingOAuth: ctx.modelRegistry.isUsingOAuth(model),
			status: ctx.modelRegistry.getProviderAuthStatus(model.provider),
		});
	}

	function check(ctx: ExtensionContext): Decision | undefined {
		const account = accountOf(ctx);
		if (!account) return undefined;
		const config = loadConfig();
		return decide({ place: currentPlace(ctx.cwd, config), account, config });
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

	pi.on("session_start", async (_event, ctx) => {
		cachedPlace = undefined;
		try {
			currentPlace(ctx.cwd, loadConfig());
		} catch {
			// The next check resolves the place again and reports a failure as a Block.
		}
	});

	// Every user turn passes here, `/`-prefixed text included: skills and prompt templates arrive unexpanded.
	pi.on("input", async (event, ctx) => {
		let decision: Decision | undefined;
		try {
			decision = check(ctx);
		} catch (error) {
			// pi swallows hook errors and carries on, so an error here must Block itself (ADR 0001).
			decision = { verdict: "block", cause: { kind: "internal-error", reason: errorText(error) } };
		}
		if (decision?.verdict !== "block") return undefined;
		block(decision.cause, event.text, ctx);
		return { action: "handled" };
	});
}
