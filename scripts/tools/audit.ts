// Known vulnerabilities in runtime dependencies, with the exceptions listed in audit-exceptions.json.
//
//   node scripts/tools/audit.ts
//
// `npm audit` itself has no allow-list, so this runs it with --json and applies scripts/lib/audit.ts.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { type AuditException, advisoriesOf, exceptionsProblem, judge } from "../lib/audit.ts";

const result = spawnSync("npm", ["audit", "--omit=dev", "--omit=peer", "--json"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
let report: unknown;
try {
	report = JSON.parse(result.stdout);
} catch {
	console.error(`audit: npm audit gave no JSON (exit ${result.status}):\n${result.stderr || result.stdout}`);
	process.exit(1);
}
if (typeof report === "object" && report !== null && "error" in report) {
	console.error(`audit: npm audit failed: ${JSON.stringify((report as { error: unknown }).error)}`);
	process.exit(1);
}

const exceptions: unknown = JSON.parse(readFileSync(new URL("../../audit-exceptions.json", import.meta.url), "utf8"));
const problem = exceptionsProblem(exceptions);
if (problem !== undefined) {
	console.error(`audit: ${problem}`);
	process.exit(1);
}

const verdict = judge(advisoriesOf(report), exceptions as AuditException[], new Date().toISOString().slice(0, 10));
for (const exception of verdict.unused)
	console.warn(`audit: ${exception.advisory} (${exception.package}) no longer applies; delete its entry from audit-exceptions.json`);
for (const failure of verdict.failures)
	console.error(`audit: ${failure.severity} ${failure.advisory} in ${failure.package}: ${failure.title} (${failure.why})`);
if (verdict.failures.length > 0) {
	console.error("\naudit: update the dependency, or add a narrow, dated entry to audit-exceptions.json with the reason it is safe to ship.");
	process.exit(1);
}
console.log("audit: no runtime advisory of moderate severity or worse without an exception");
