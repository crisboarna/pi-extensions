const REDACTED = "«redacted»";

interface Rule {
	pattern: RegExp;
	replace: string | ((match: string, ...groups: string[]) => string);
}

/** A run of base64-like characters is a secret only when it mixes cases and digits. */
function looksRandom(run: string): boolean {
	return /[a-z]/u.test(run) && /[A-Z]/u.test(run) && /\d/u.test(run);
}

const RULES: Rule[] = [
	{ pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu, replace: REDACTED },
	{ pattern: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/giu, replace: (_m, scheme) => `${scheme} ${REDACTED}` },
	{ pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/gu, replace: REDACTED },
	{ pattern: /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/gu, replace: REDACTED },
	{ pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}/gu, replace: REDACTED },
	{ pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/gu, replace: REDACTED },
	{ pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/gu, replace: REDACTED },
	{ pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/gu, replace: REDACTED },
	{ pattern: /\b(api[_-]?key|secret|token|password|passwd|access[_-]?key)(\s*[:=]\s*)["']?[^\s"']{6,}["']?/giu, replace: (_m, key, sep) => `${key}${sep}${REDACTED}` },
	{ pattern: /\b[0-9a-f]{32,}\b/giu, replace: REDACTED },
	{ pattern: /[A-Za-z0-9+]{40,}={0,2}/gu, replace: (run) => (looksRandom(run) ? REDACTED : run) },
];

export interface Redactor {
	(text: string): string;
}

/**
 * Masks secret-shaped strings and replaces the home directory with `~`.
 * Applied once to evidence, so the classifier, the session entry and the
 * debug log all see the same text.
 */
export function createRedactor(options: { home?: string; extra?: string[] } = {}): Redactor {
	const extra: Rule[] = [];
	for (const source of options.extra ?? []) {
		try {
			extra.push({ pattern: new RegExp(source, "gu"), replace: REDACTED });
		} catch {
			// An invalid user pattern is skipped; config validation reports it.
		}
	}
	const home = options.home && options.home.length > 1 ? options.home : undefined;
	return (text: string) => {
		let out = home ? text.split(home).join("~") : text;
		for (const rule of [...RULES, ...extra]) {
			out = typeof rule.replace === "string" ? out.replace(rule.pattern, rule.replace) : out.replace(rule.pattern, rule.replace);
		}
		return out;
	};
}

/** Applies a redactor to every string inside a JSON value. */
export function redactDeep<T>(value: T, redact: Redactor): T {
	if (typeof value === "string") return redact(value) as T;
	if (Array.isArray(value)) return value.map((item) => redactDeep(item, redact)) as T;
	if (value && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactDeep(item, redact)])) as T;
	}
	return value;
}
