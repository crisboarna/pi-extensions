// Installs each package from its packed tarball, the way a user gets it, and
// checks that it loads.
//
// Unit tests run the source tree; users run what npm unpacked under
// node_modules, where Node will not strip TypeScript types and only the
// `files` list exists. For every package this script:
//   1. packs it and installs the tarball into an empty temporary project;
//   2. installs it into a fresh pi agent folder the way `pi install npm:` does
//      (pi's own packages are peers that pi never installs; it maps only their
//      main entry points), starts the repository's pi on that folder in RPC
//      mode, and fails on any extension load error;
//   3. runs each bin with --help and expects exit code 0.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listPackages, ROOT, reporter } from "./lib/repo.ts";

const report = reporter("smoke-pack");
const only = process.argv.slice(2);
const PI_CLI = join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");

/** Starts pi on `agentDir`, waits until it answers over RPC, and returns what it printed to stderr. */
function startPi(agentDir: string, cwd: string): Promise<{ stderr: string; answered: boolean }> {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [PI_CLI, "--mode", "rpc", "--no-session", "--offline"], {
			cwd,
			env: { ...process.env, HOME: cwd, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" },
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stderr = "";
		let answered = false;
		const finish = () => {
			clearTimeout(timer);
			child.kill();
			resolve({ stderr, answered });
		};
		const timer = setTimeout(finish, 60_000);
		child.stderr.on("data", (data) => (stderr += data));
		child.stdout.on("data", (data) => {
			if (String(data).includes('"command":"get_commands"')) {
				answered = true;
				finish();
			}
		});
		child.on("exit", finish);
		child.stdin.write(`${JSON.stringify({ id: "smoke", type: "get_commands" })}\n`);
	});
}

for (const { manifest } of listPackages()) {
	if (manifest.private === true || (only.length > 0 && !only.includes(manifest.name))) continue;
	const work = mkdtempSync(join(tmpdir(), "pi-ext-smoke-"));
	try {
		const [pack] = JSON.parse(
			execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--workspace", manifest.name, "--pack-destination", work], {
				cwd: ROOT,
				encoding: "utf8",
			}),
		);
		const agentDir = join(work, "agent");
		const npmDir = join(agentDir, "npm");
		mkdirSync(npmDir, { recursive: true });
		writeFileSync(join(npmDir, "package.json"), JSON.stringify({ name: "pi-packages", private: true }));
		execFileSync(
			"npm",
			["install", "--ignore-scripts", "--omit=peer", "--legacy-peer-deps", "--no-audit", "--no-fund", "--min-release-age=3", join(work, pack.filename)],
			{ cwd: npmDir, stdio: "pipe" },
		);
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [`npm:${manifest.name}`] }));
		const installed = join(npmDir, "node_modules", ...manifest.name.split("/"));

		if ((manifest.pi?.extensions ?? []).length > 0) {
			const { stderr, answered } = await startPi(agentDir, work);
			const failures = stderr.split("\n").filter((line) => /Failed to load extension|Error:/u.test(line));
			for (const line of failures) report.fail(`${manifest.name}: pi could not load it from the tarball: ${line.trim()}`);
			if (!answered && failures.length === 0) report.fail(`${manifest.name}: pi did not start with it installed (no RPC answer in 60 s)`);
		}
		for (const [name, target] of Object.entries(manifest.bin ?? {})) {
			const run = spawnSync(process.execPath, [join(installed, target), "--help"], { cwd: work, encoding: "utf8" });
			if (run.status !== 0) report.fail(`${manifest.name}: bin ${name} --help exited ${run.status}: ${(run.stderr || run.stdout).trim().split("\n")[0]}`);
		}
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}

report.finish(
	"make the published files self-sufficient: every runtime import declared in dependencies, and from pi's packages only the entry points pi maps (see scripts/checks/imports.ts).",
);
