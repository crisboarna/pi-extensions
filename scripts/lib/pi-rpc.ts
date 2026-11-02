// Real pi, started in RPC mode on an agent directory, asked which commands it has. Shared by the check that loads each packed package (scripts/smoke-pack.ts)
// and the check that loads each published package (scripts/release/verify-published.ts), so both read the same answer in the same way.
import { spawn } from "node:child_process";
import { join } from "node:path";
import { ROOT } from "./repo.ts";

export const PI_CLI = join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");

/**
 * The slash commands each package that loads into pi must register, with its skills, which pi lists as `skill:<name>` commands. A package that loads but registers nothing passes every "did it
 * start" check, so the list is explicit: a new package adds its commands here, or an empty list if it has none.
 */
export const COMMANDS: Record<string, string[]> = {
	"@crisboarna/pi-account-guard": ["guard", "skill:pi-account-guard"],
	"@crisboarna/pi-context-refs": ["ref", "skill:pi-context-refs"],
	"@crisboarna/pi-switchboard": ["tier", "skill:pi-switchboard"],
};

/** A command as pi's `get_commands` lists it: its name, and the package it came from (`npm:<name>` for one installed from npm). */
export interface ListedCommand {
	name: string;
	source: string | undefined;
}

/** Starts pi on `agentDir`, waits until it answers over RPC, and returns what it printed to stderr. */
export function startPi(agentDir: string, cwd: string): Promise<{ stderr: string; answered: boolean; commands: ListedCommand[] }> {
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
