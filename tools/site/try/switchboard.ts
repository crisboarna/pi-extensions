// Runs inside the browser's WebContainer before pi starts: the fake classifier
// and providers of pi-switchboard's demo scene, its routing config and the
// small project it works in, under ./home. It prints one JSON line with the
// command and environment for pi, then keeps the servers running.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { startClassifier } from "../../../packages/pi-switchboard/media/terminal/fake-classifier.ts";
import { scene } from "../../../packages/pi-switchboard/media/terminal/scenes/demo.ts";
import { CONFIG, PROJECT, providerExtension } from "../../../packages/pi-switchboard/media/terminal/setup.ts";
import { startLlm } from "../../media/terminal-kit/fake-llm.ts";

const root = process.cwd();
const home = join(root, "home");
const agentDir = join(home, ".pi", "agent");
const write = (path: string, text: string, mode?: number) => {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text, mode === undefined ? undefined : { mode });
};

const classifier = await startClassifier(scene.answers);
const llm = await startLlm(scene.llm);
write(join(agentDir, "settings.json"), `${JSON.stringify({ quietStartup: "header", defaultThinkingLevel: "medium" }, null, "\t")}\n`);
write(join(agentDir, "extensions", "demo-providers.js"), providerExtension(llm.url));
write(join(agentDir, "pi-switchboard.json"), `${JSON.stringify(CONFIG(classifier.url), null, "\t")}\n`);
// pi looks for fd and ripgrep here before downloading them; the demo never searches files.
for (const tool of ["fd", "rg"]) write(join(agentDir, "bin", tool), "#!/bin/sh\nexit 1\n", 0o755);
for (const [file, text] of Object.entries(PROJECT)) write(join(home, "acme-shop", file), text);

const cli = join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
const extension = join(root, "node_modules", "@crisboarna", "pi-switchboard", "src", "index.ts");
console.log(
	JSON.stringify({
		ready: true,
		cwd: relative(root, join(home, "acme-shop")),
		command: "node",
		args: [cli, "-e", extension, "--model", "switchboard/auto"],
		env: { HOME: home, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" },
	}),
);
