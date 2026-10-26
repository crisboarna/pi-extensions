// Secret scan with gitleaks, run from its pinned image.
//
//   node scripts/tools/gitleaks.ts            every commit in the history (pre-push, CI)
//   node scripts/tools/gitleaks.ts --staged   only what is staged (pre-commit)
//
// Rules: gitleaks' defaults plus the allow-list in .gitleaks.toml.
import { runTool } from "../lib/docker.ts";

const GITLEAKS = { name: "gitleaks", image: "ghcr.io/gitleaks/gitleaks:v8.30.1@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f" };

const staged = process.argv.includes("--staged");
const args = ["git", "--no-banner", "--redact", "--config", ".gitleaks.toml", ...(staged ? ["--staged"] : []), "."];
const status = runTool(GITLEAKS, args);
if (status !== 0)
	console.error(
		"\ngitleaks: remove the secret (and rotate it if it was real). For a deliberate fake in a test, add a narrow allow-list entry to .gitleaks.toml.",
	);
process.exitCode = status;
