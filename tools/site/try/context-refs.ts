// Runs inside the browser's WebContainer before pi starts: the stand-in model
// of the terminal scenes (it echoes what pi sent it), the demo ref library and
// the small shop-api project, under ./home. WebContainer has no git, so a
// small `git` script answers the four commands of the built-in refs. It prints
// one JSON line with the environment for the shell, then keeps the model running.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { API_SOURCE, LIBRARY, MODEL, RETRY_CHANGED, RETRY_COMMITTED } from "../../../packages/pi-context-refs/media/terminal/setup.ts";
import { startLlm } from "../../media/terminal-kit/fake-llm.ts";

const root = process.cwd();
const home = join(root, "home");
const agentDir = join(home, ".pi", "agent");
const project = join(home, "projects", "shop-api");
const write = (path: string, text: string, mode?: number) => {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text, mode === undefined ? undefined : { mode });
};

/** A unified diff of the one change the demo has: lines only in `after` are added, the rest is context. */
function diffOf(before: string, after: string, path: string): string {
	const old = before.split("\n").slice(0, -1);
	const next = after.split("\n").slice(0, -1);
	const lines: string[] = [];
	let cursor = 0;
	for (const line of next) {
		if (old[cursor] === line) {
			lines.push(` ${line}`);
			cursor++;
		} else lines.push(`+${line}`);
	}
	return [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, `@@ -1,${old.length} +1,${next.length} @@`, ...lines, ""].join("\n");
}

const DIFF = diffOf(RETRY_COMMITTED, RETRY_CHANGED, "src/retry.ts");
const GIT = `#!/usr/bin/env node
// A stand-in for git, which does not run in a browser: it answers only what the built-in refs ask.
const args = process.argv.slice(2).join(" ");
const answers = {
	"rev-parse --is-inside-work-tree": "true\\n",
	diff: ${JSON.stringify(DIFF)},
	"diff --staged": "",
	"status --short": " M src/retry.ts\\n",
	"log --oneline -20": "3f2a9c1 Add the shop API\\n",
};
if (!(args in answers)) {
	console.error("git: this demo answers only the commands of the built-in refs");
	process.exit(1);
}
process.stdout.write(answers[args]);
`;

// A snapshot keeps no file modes, so the `git` on the PATH is made executable here.
write(join(home, "bin", "git"), GIT, 0o755);
const llm = await startLlm((request) => ({ text: `The model got:\n${request.lastUser}`, wordMs: 15 }));
write(
	join(agentDir, "settings.json"),
	`${JSON.stringify({ quietStartup: "header", defaultThinkingLevel: "medium", defaultProvider: "demo", defaultModel: "demo-model" }, null, "\t")}\n`,
);
write(
	join(agentDir, "extensions", "demo-model.js"),
	`export default function demoModel(pi) {
	pi.registerProvider("demo", {
		name: "demo", baseUrl: "${llm.url}/demo/v1", apiKey: "stand-in", api: "openai-completions",
		models: [{ type: "chat", id: "demo-model", name: "demo-model", reasoning: false, input: ["text"], cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 8192 }],
	});
}
`,
);
write(join(agentDir, "extensions", "context-refs.ts"), `export { default } from "${root}/node_modules/@crisboarna/pi-context-refs/src/index.ts";\n`);
write(join(agentDir, "pi-context-refs.json"), `${JSON.stringify({ version: 1, refs: LIBRARY }, null, 2)}\n`);
// pi looks for fd and ripgrep here before downloading them; the demo never searches files.
for (const tool of ["fd", "rg"]) write(join(agentDir, "bin", tool), "#!/bin/sh\nexit 1\n", 0o755);
write(join(project, "src", "api.ts"), API_SOURCE);
write(join(project, "src", "retry.ts"), RETRY_CHANGED);
write(join(project, "NOTES.md"), "# Notes\n\nShip the retry change this week.\n");

const env = {
	HOME: home,
	PI_CODING_AGENT_DIR: agentDir,
	PI_OFFLINE: "1",
	PATH: `${join(home, "bin")}:/usr/local/bin:/usr/bin:/bin`,
};
const cli = join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
// The page starts pi in the project; spawn takes the folder relative to the container's workdir.
console.log(JSON.stringify({ ready: true, cwd: relative(root, project), command: "node", args: [cli, "--model", MODEL], env }));
