import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { renderInspector } from "../cli/inspector.ts";
import { liveChildMirror } from "../timeline/mirror.ts";
import { buildTimeline } from "../timeline/parse.ts";

export interface InspectInput {
	/** The current session's entries, as the session manager holds them. */
	entries: readonly unknown[];
	sessionId: string;
	sessionFile?: string;
	/** pi-switchboard's data directory; the HTML goes under `inspect/` and mirrors are read from `live/`. */
	dataDir: string;
	/** Explicit output path (`-o`). */
	out?: string;
}

/** Writes the offline HTML inspector for a live session and returns its path. */
export function writeInspector(input: InspectInput): string {
	const timeline = buildTimeline(input.entries as never, {
		...(input.sessionFile ? { file: input.sessionFile } : {}),
		childMirror: liveChildMirror(join(input.dataDir, "live")),
	});
	const out = resolve(input.out ?? join(input.dataDir, "inspect", `${input.sessionId.replace(/[^A-Za-z0-9._-]/gu, "_")}.html`));
	mkdirSync(dirname(out), { recursive: true });
	writeFileSync(out, renderInspector(timeline));
	return out;
}

/** Opens a file with the platform's default handler, detached; resolves false when it cannot start. */
export function openFile(path: string, platform: NodeJS.Platform = process.platform): Promise<boolean> {
	const [command, args] = platform === "darwin" ? ["open", [path]] : platform === "win32" ? ["cmd", ["/c", "start", "", path]] : ["xdg-open", [path]];
	return new Promise((done) => {
		try {
			const child = spawn(command as string, args as string[], { detached: true, stdio: "ignore" });
			child.once("error", () => done(false));
			child.once("spawn", () => {
				child.unref();
				done(true);
			});
		} catch {
			done(false);
		}
	});
}
