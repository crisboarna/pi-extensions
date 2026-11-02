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
//      mode, fails on any extension load error, and asks pi which commands are
//      registered: every command in COMMANDS must come from this package;
//   3. runs each bin with --help and expects exit code 0;
//   4. reads the peer dependencies back from the unpacked tarball, which must be those of the manifest (the range CI tests).
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listPackages, ROOT, reporter } from "./lib/repo.ts";

const report = reporter("smoke-pack");
const only = process.argv.slice(2);
const PI_CLI = join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");

/**
 * The slash commands each package that loads into pi must register, with its skills, which pi lists as `skill:<name>` commands. A package that loads but registers nothing passes every "did it
 * start" check, so the list is explicit: a new package adds its commands here, or an empty list if it has none.
 */
const COMMANDS: Record<string, string[]> = {
	"@crisboarna/pi-account-guard": ["guard", "skill:pi-account-guard"],
	"@crisboarna/pi-context-refs": ["ref", "skill:pi-context-refs"],
	"@crisboarna/pi-switchboard": ["tier", "skill:pi-switchboard"],
};

/** A command as pi's `get_commands` lists it: its name, and the package it came from (`npm:<name>` for one installed from npm). */
interface ListedCommand {
	name: string;
	source: string | undefined;
}

/** Starts pi on `agentDir`, waits until it answers over RPC, and returns what it printed to stderr. */
function startPi(agentDir: string, cwd: string): Promise<{ stderr: string; answered: boolean; commands: ListedCommand[] }> {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [PI_CLI, "--mode", "rpc", "--no-session", "--offline"], {
			cwd,
			env: { ...process.env, HOME: cwd, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" },
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stderr = "";
		let answered = false;
		let pending = "";
		const commands: ListedCommand[] = [];
		const finish = () => {
			clearTimeout(timer);
			child.kill();
			resolve({ stderr, answered, commands });
		};
		const timer = setTimeout(finish, 60_000);
		child.stderr.on("data", (data) => (stderr += data));
		child.stdout.on("data", (data) => {
			pending += String(data);
			const lines = pending.split("\n");
			pending = lines.pop() ?? "";
			for (const line of lines) {
				if (!line.includes('"command":"get_commands"')) continue;
				const reply = JSON.parse(line) as { data?: { commands?: Array<{ name: string; sourceInfo?: { source?: string } }> } };
				for (const command of reply.data?.commands ?? []) commands.push({ name: command.name, source: command.sourceInfo?.source });
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

		// The range a package promises is only worth something if it is what npm publishes, so read it back from the unpacked tarball.
		const published = JSON.parse(readFileSync(join(installed, "package.json"), "utf8")) as { peerDependencies?: Record<string, string> };
		for (const [name, range] of Object.entries(manifest.peerDependencies ?? {})) {
			if (published.peerDependencies?.[name] !== range)
				report.fail(`${manifest.name}: the tarball declares peer ${name} as "${published.peerDependencies?.[name]}", the manifest as "${range}"`);
		}

		if ((manifest.pi?.extensions ?? []).length > 0) {
			const { stderr, answered, commands } = await startPi(agentDir, work);
			const failures = stderr.split("\n").filter((line) => /Failed to load extension|Error:/u.test(line));
			for (const line of failures) report.fail(`${manifest.name}: pi could not load it from the tarball: ${line.trim()}`);
			if (!answered && failures.length === 0) report.fail(`${manifest.name}: pi did not start with it installed (no RPC answer in 60 s)`);
			const expected = COMMANDS[manifest.name];
			if (expected === undefined)
				report.fail(`${manifest.name}: list the slash commands it registers in COMMANDS in scripts/smoke-pack.ts (an empty list if it has none)`);
			else if (answered) {
				for (const name of expected) {
					if (!commands.some((command) => command.name === name && command.source === `npm:${manifest.name}`))
						report.fail(
							`${manifest.name}: pi did not list /${name} as a command of this package; it listed ${commands.map((command) => `/${command.name}`).join(", ") || "none"}`,
						);
				}
			}
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
	"make the published files self-sufficient: every runtime import declared in dependencies, and from pi's packages only the entry points pi maps (see scripts/checks/imports.ts); and register the commands listed for the package in COMMANDS.",
);
