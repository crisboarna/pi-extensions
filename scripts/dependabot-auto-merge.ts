// Reads what `dependabot/fetch-metadata` found in a Dependabot pull request and says whether it may merge itself (scripts/lib/dependabot-policy.ts).
//
//   DEPENDENCIES='[{"dependencyName":"marked",...}]' node scripts/dependabot-auto-merge.ts
//
// Prints the decision, and when GITHUB_OUTPUT is set writes `allowed=true|false` and `reason=...` to it for the next workflow step. Always exits 0:
// "not allowed" is an answer, not a failure, and a red check on every major bump would only teach people to ignore red checks.
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { decide, parseDependencies } from "./lib/dependabot-policy.ts";

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const decision = decide(parseDependencies(process.env.DEPENDENCIES));
	console.log(`${decision.allowed ? "may merge itself" : "stays open for the maintainer"}: ${decision.reason}`);
	const output = process.env.GITHUB_OUTPUT;
	if (output) appendFileSync(output, `allowed=${decision.allowed}\nreason=${decision.reason.replaceAll("\n", " ")}\n`);
}
