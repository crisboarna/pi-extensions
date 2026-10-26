/** An Account: a provider id plus the auth source behind it (ADR 0002). */
export interface AccountKey {
	provider: string;
	source: string;
}

/** What pi's public `getProviderAuthStatus` returns; it holds no secrets. */
export interface AuthStatusView {
	configured: boolean;
	source?: string;
	label?: string;
}

export interface AccountKeyInput {
	provider: string;
	/** Result of pi's `isUsingOAuth` for the model. */
	usingOAuth: boolean;
	status: AuthStatusView;
}

/** Builds the Account key fresh from pi's auth snapshot; the text of a models.json command is never read. */
export function accountKey({ provider, usingOAuth, status }: AccountKeyInput): AccountKey {
	return { provider, source: authSource(usingOAuth, status) };
}

/** A source this version does not know: its own Account, so it starts Unknown and is never merged with another source (ADR 0002). */
const UNRECOGNISED_PREFIX = "unrecognised:";

function authSource(usingOAuth: boolean, status: AuthStatusView): string {
	if (!status.configured) return "unconfigured";
	switch (status.source) {
		case "stored":
			return usingOAuth ? "oauth" : "stored-key";
		case "environment":
			// Without a variable name the source is not claimed as `env:<VAR>`; it falls to the unrecognised sources.
			if (status.label !== undefined) return `env:${status.label}`;
			return `${UNRECOGNISED_PREFIX}environment`;
		case "models_json_key":
			return "models-json-key";
		case "models_json_command":
			return "models-json-command";
		case "runtime":
			return "runtime";
		case "fallback":
			return "fallback";
		default:
			return `${UNRECOGNISED_PREFIX}${status.source ?? "none"}`;
	}
}

export function sameAccount(a: AccountKey, b: AccountKey): boolean {
	return a.provider === b.provider && a.source === b.source;
}

/** The short form used in Block text: `provider (source)`. */
export function describeAccount(key: AccountKey): string {
	return `${key.provider} (${key.source})`;
}
