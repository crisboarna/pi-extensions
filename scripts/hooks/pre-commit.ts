// The pre-commit hook: Biome on the staged files only (never rewriting them,
// so a partially staged file cannot sweep unstaged hunks into the commit),
// the fast repository gates, and a secret scan of the staged diff when
// gitleaks is installed.
import { spawnSync } from "node:child_process";
import { ROOT } from "../lib/repo.ts";

function run(command: string, args: string[]): boolean {
	return spawnSync(command, args, { cwd: ROOT, stdio: "inherit" }).status === 0;
}

let ok = run("node_modules/.bin/biome", ["check", "--staged", "--error-on-warnings", "--no-errors-on-unmatched", "--files-ignore-unknown=true"]);
if (!ok) console.error('\nBiome found problems in staged files. Run "npm run format", review, and stage the result.');
ok = run(process.execPath, ["scripts/check.ts", "--fast"]) && ok;
if (spawnSync("gitleaks", ["version"], { stdio: "ignore" }).status === 0) {
	ok = run("gitleaks", ["git", "--staged", "--no-banner", "--redact"]) && ok;
} else {
	console.log("gitleaks not installed; the staged secret scan runs in CI only (brew install gitleaks).");
}
if (!ok) process.exitCode = 1;
