// The policy for `npm audit` on runtime dependencies: every advisory of moderate severity or worse must be fixed
// or listed in audit-exceptions.json. An exception names one advisory and one package, says why, and expires.

export interface AuditException {
	/** The advisory, for example GHSA-g3hv-75wg-m249. */
	advisory: string;
	/** The package the advisory is reported against. */
	package: string;
	/** Why it is safe to ship, and what ends the exception. */
	reason: string;
	/** The last day the exception holds, as YYYY-MM-DD. */
	expires: string;
}

export interface Advisory {
	advisory: string;
	package: string;
	severity: string;
	title: string;
}

const SEVERITY = ["info", "low", "moderate", "high", "critical"];
const GHSA = /GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}/;

/** The advisories that `npm audit --json` reports directly, which is where each one names its own package; the entries that only depend on a vulnerable package are not advisories. */
export function advisoriesOf(report: unknown, minimum = "moderate"): Advisory[] {
	const found = new Map<string, Advisory>();
	const vulnerabilities = (report as { vulnerabilities?: Record<string, { via?: unknown[] }> }).vulnerabilities ?? {};
	for (const [name, vulnerability] of Object.entries(vulnerabilities))
		for (const via of vulnerability.via ?? []) {
			if (typeof via !== "object" || via === null) continue;
			const { url = "", severity = "", title = "" } = via as { url?: string; severity?: string; title?: string };
			if (SEVERITY.indexOf(severity) < SEVERITY.indexOf(minimum)) continue;
			const advisory = GHSA.exec(url)?.[0] ?? url;
			found.set(`${advisory} ${name}`, { advisory, package: name, severity, title });
		}
	return [...found.values()];
}

export interface Verdict {
	/** Advisories with no valid exception: these fail the audit. */
	failures: Array<Advisory & { why: string }>;
	/** Exceptions that no longer match an advisory; they should be deleted. */
	unused: AuditException[];
}

/** Which advisories fail, given the exceptions and today's date (YYYY-MM-DD). */
export function judge(advisories: Advisory[], exceptions: AuditException[], today: string): Verdict {
	const failures: Verdict["failures"] = [];
	const used = new Set<AuditException>();
	for (const advisory of advisories) {
		const exception = exceptions.find((candidate) => candidate.advisory === advisory.advisory && candidate.package === advisory.package);
		if (exception === undefined) failures.push({ ...advisory, why: "no exception" });
		else if (exception.expires < today) failures.push({ ...advisory, why: `the exception expired on ${exception.expires}` });
		else used.add(exception);
	}
	return { failures, unused: exceptions.filter((exception) => !used.has(exception) && !failures.some((failure) => failure.advisory === exception.advisory)) };
}

/** Why the exceptions file is not valid, or undefined: every entry needs all four fields, a real date and a reason. */
export function exceptionsProblem(value: unknown): string | undefined {
	if (!Array.isArray(value)) return "audit-exceptions.json must be a list";
	for (const [index, entry] of value.entries()) {
		const item = entry as Partial<Record<keyof AuditException, unknown>>;
		for (const key of ["advisory", "package", "reason", "expires"] as const)
			if (typeof item[key] !== "string" || item[key] === "") return `entry ${index}: "${key}" is missing`;
		if (!GHSA.test(String(item.advisory))) return `entry ${index}: "advisory" must be a GHSA id`;
		if (!/^\d{4}-\d{2}-\d{2}$/.test(String(item.expires)) || Number.isNaN(Date.parse(String(item.expires))))
			return `entry ${index}: "expires" must be YYYY-MM-DD`;
	}
	return undefined;
}
