// Runs inside the browser's WebContainer before the shell starts: the fake
// model provider of the terminal scenes, the demo accounts, the guard's config
// and the two repositories, all under ./home. It prints one JSON line with the
// environment for the shell, then keeps the provider running.
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { reply } from "../../../packages/pi-account-guard/media/terminal/scenes/clips.ts";
import { ACCOUNTS, providerExtension, REPOSITORIES } from "../../../packages/pi-account-guard/media/terminal/setup.ts";
import { startLlm } from "../../media/terminal-kit/fake-llm.ts";

const root = process.cwd();
const home = join(root, "home");
const agentDir = join(home, ".pi", "agent");
const write = (path: string, text: string, mode?: number) => {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text, mode === undefined ? undefined : { mode });
};

// git does not run in the browser, so the demo config decides places by path only.
const CONFIG = {
	zones: ["work", "personal"],
	defaultZone: "personal",
	accounts: [
		{ provider: "acme", source: "env:ACME_WORK_KEY", zones: ["work"], note: "Acme seat" },
		{ provider: "homelab", source: "env:HOMELAB_KEY", zones: ["personal"] },
	],
	places: [{ path: "~/work", zone: "work" }],
};

// A snapshot keeps no file modes, so `pi` on the PATH is made executable here.
chmodSync(join(root, "node_modules", ".bin", "pi"), 0o755);
const llm = await startLlm(reply);
write(join(agentDir, "settings.json"), `${JSON.stringify({ quietStartup: "header", defaultThinkingLevel: "medium" }, null, "\t")}\n`);
write(join(agentDir, "extensions", "demo-accounts.js"), providerExtension(llm.url, false));
write(join(agentDir, "extensions", "account-guard.ts"), `export { default } from "${root}/node_modules/@crisboarna/pi-account-guard/src/index.ts";\n`);
write(join(agentDir, "account-guard.json"), `${JSON.stringify(CONFIG, null, 2)}\n`);
// pi looks for fd and ripgrep here before downloading them; the demo never searches files.
for (const tool of ["fd", "rg"]) write(join(agentDir, "bin", tool), "#!/bin/sh\nexit 1\n", 0o755);
for (const { path, file } of Object.values(REPOSITORIES)) write(join(home, path, file), "export const ready = true;\n");

const env = {
	HOME: home,
	PI_CODING_AGENT_DIR: agentDir,
	PI_OFFLINE: "1",
	PATH: `${join(root, "node_modules", ".bin")}:/usr/local/bin:/usr/bin:/bin`,
	...Object.fromEntries(Object.values(ACCOUNTS).map(({ key }) => [key, "demo-not-a-secret"])),
};
// The page starts the shell in the home folder; spawn takes it relative to the container's workdir.
console.log(JSON.stringify({ ready: true, cwd: relative(root, home), env }));
