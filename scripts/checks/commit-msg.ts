// Checks a commit message: Conventional Commits, a scope that names a package
// or a repository area, a short header, and no AI attribution trailers.
//
//   node scripts/checks/commit-msg.ts <file>   (the husky commit-msg hook)
//   node scripts/checks/commit-msg.ts --range origin/main..HEAD   (CI)
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { listPackages, ROOT } from "../lib/repo.ts";

const TYPES = ["feat", "fix", "perf", "refactor", "docs", "test", "build", "ci", "chore", "style", "revert"];
const AREAS = ["repo", "deps", "release", "ci", "docs", "scripts"];
const MAX_HEADER = 100;
const ATTRIBUTION =
	/^(co-authored-by:.*\b(claude|anthropic|openai|chatgpt|codex|copilot|gemini|cursor)\b|.*generated (with|by) (\[)?(claude|chatgpt|codex|copilot|gemini|cursor))/im;

const scopes = new Set([...listPackages().map((pkg) => pkg.dir), ...AREAS]);

export function problems(message: string): string[] {
	const text = message
		.split("\n")
		.filter((line: string) => !line.startsWith("#"))
		.join("\n")
		.trim();
	const [header = "", blank, ...rest] = text.split("\n");
	const out: string[] = [];
	if (/^(Merge|Revert) /.test(header) || /^fixup! |^squash! /.test(header)) return out;
	const match = /^(?<type>[a-z]+)(\((?<scope>[a-z0-9-]+)\))?(?<bang>!)?: (?<subject>.+)$/.exec(header);
	if (!match?.groups) out.push(`header "${header}" is not "<type>(<scope>): <subject>"`);
	else {
		const { type = "", scope, subject = "" } = match.groups;
		if (!TYPES.includes(type)) out.push(`type "${type}" is not one of ${TYPES.join(", ")}`);
		if (scope && !scopes.has(scope)) out.push(`scope "${scope}" is not a package folder or one of ${AREAS.join(", ")}`);
		if (/\.$/.test(subject)) out.push("subject ends with a period");
		if (/^[A-Z]/.test(subject) && !/^[A-Z]{2}/.test(subject)) out.push("subject starts with a capital letter");
	}
	if (header.length > MAX_HEADER) out.push(`header is ${header.length} characters; keep it to ${MAX_HEADER}`);
	if (blank !== undefined && blank.trim() !== "") out.push("leave a blank line between the header and the body");
	if (rest.some((line) => ATTRIBUTION.test(line)) || ATTRIBUTION.test(header)) out.push("remove the AI attribution trailer or line");
	return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const rangeIndex = process.argv.indexOf("--range");
	const messages =
		rangeIndex !== -1
			? execFileSync("git", ["log", "--format=%H%x00%B%x01", process.argv[rangeIndex + 1] ?? "HEAD"], { cwd: ROOT, encoding: "utf8" })
					.split("\x01")
					.map((entry) => entry.trim())
					.filter(Boolean)
					.map((entry) => {
						const [sha = "", body = ""] = entry.split("\0");
						return { label: sha.slice(0, 7), body };
					})
			: [{ label: "commit message", body: readFileSync(process.argv[2] ?? ".git/COMMIT_EDITMSG", "utf8") }];
	let bad = 0;
	for (const { label, body } of messages) {
		const found = problems(body);
		if (found.length === 0) continue;
		bad++;
		console.error(`${label}:`);
		for (const problem of found) console.error(`  - ${problem}`);
	}
	if (bad > 0) {
		console.error('\nFormat: "feat(pi-switchboard): add quota strategy" — see docs/conventions/commits.md.');
		process.exitCode = 1;
	}
}
