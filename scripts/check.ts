// Runs every repository gate and reports all failures together, so one run
// shows everything that needs fixing.
//
//   npm run check          every gate (CI and pre-push)
//   npm run check:fast     the gates that take under a few seconds (pre-commit)
import { spawnSync } from "node:child_process";
import { ROOT } from "./lib/repo.ts";

const node = (script: string, ...args: string[]): string[] => [process.execPath, script, ...args];
const bin = (name: string, ...args: string[]): string[] => [`node_modules/.bin/${name}`, ...args];

const GATES = [
	{ name: "manifests", fast: true, command: node("scripts/checks/manifests.ts") },
	{ name: "imports", fast: true, command: node("scripts/checks/imports.ts") },
	{ name: "text", fast: true, command: node("scripts/checks/text.ts") },
	{ name: "file-sizes", fast: true, command: node("scripts/checks/file-sizes.ts") },
	{ name: "links", fast: true, command: node("scripts/checks/links.ts") },
	{ name: "biome", fast: true, command: bin("biome", "check", "--error-on-warnings", ".") },
	{ name: "typecheck", fast: true, command: bin("tsc", "-p", "tsconfig.json") },
	{ name: "markdown", fast: false, command: bin("markdownlint-cli2") },
	{ name: "knip", fast: false, command: bin("knip", "--no-progress") },
	{ name: "npm-policy", fast: false, command: node("scripts/checks/npm-policy.ts") },
	{ name: "pack", fast: false, command: node("scripts/checks/pack.ts") },
];

const fastOnly = process.argv.includes("--fast");
const failed = [];
for (const gate of GATES) {
	if (fastOnly && !gate.fast) continue;
	const started = Date.now();
	const [command, ...args] = gate.command;
	const run = spawnSync(command ?? "", args, { cwd: ROOT, stdio: "inherit" });
	const seconds = ((Date.now() - started) / 1000).toFixed(1);
	if (run.status === 0) console.log(`  ✓ ${gate.name} (${seconds}s)`);
	else {
		console.log(`  ✗ ${gate.name} (${seconds}s)`);
		failed.push(gate.name);
	}
}

if (failed.length > 0) {
	console.error(`\ncheck failed: ${failed.join(", ")}. Fix every gate above; none of them may be skipped or weakened to pass.`);
	process.exitCode = 1;
} else console.log(`\ncheck passed${fastOnly ? " (fast gates)" : ""}`);
