// A throwaway home for a terminal scene: a pi agent folder with settings,
// extensions and stubbed fd and ripgrep, plus any project files, so a scene
// runs the real pi against demo data and nothing of the user's.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

export interface SceneHome {
	home: string;
	agentDir: string;
	/** Writes `text` at `path` under the home, creating folders. */
	write(path: string, text: string, mode?: number): string;
	/** Removes the home; with MEDIA_KEEP set, copies it there first (relative to `mediaDir`). */
	close(scene: string, mediaDir: string): void;
}

export function createSceneHome(settings: Record<string, unknown> = {}): SceneHome {
	const home = mkdtempSync(join(tmpdir(), "scene-"));
	const agentDir = join(home, ".pi", "agent");
	const write = (path: string, text: string, mode?: number): string => {
		const full = join(home, path);
		mkdirSync(join(full, ".."), { recursive: true });
		writeFileSync(full, text, mode === undefined ? undefined : { mode });
		return full;
	};
	write(".pi/agent/settings.json", `${JSON.stringify({ quietStartup: "header", defaultThinkingLevel: "medium", ...settings }, null, "\t")}\n`);
	// pi looks for fd and ripgrep here before downloading them; the scenes never search files.
	for (const tool of ["fd", "rg"]) write(`.pi/agent/bin/${tool}`, "#!/bin/sh\nexit 1\n", 0o755);
	return {
		home,
		agentDir,
		write,
		close(scene, mediaDir) {
			const keepTo = process.env.MEDIA_KEEP;
			if (keepTo) {
				const keep = join(isAbsolute(keepTo) ? keepTo : join(mediaDir, keepTo), scene);
				mkdirSync(keep, { recursive: true });
				spawnSync("sh", ["-c", `tar -C "${home}" --exclude=./.pi/agent/npm -cf - . | tar -C "${keep}" -xf -`]);
			}
			rmSync(home, { recursive: true, force: true });
		},
	};
}

/** The real pi from the repository, as a scene's command: `node <cli> ...args`. */
export function piCommand(repo: string, args: string[]): { command: string; args: string[] } {
	return { command: process.execPath, args: [join(repo, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js"), ...args] };
}
