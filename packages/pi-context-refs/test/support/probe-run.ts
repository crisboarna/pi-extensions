// A probe scenario's files: where it logs, and what the stub provider received.
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PiOptions } from "./pi-process.ts";
import type { Received } from "./stub-provider.ts";

export interface ProbeRun {
	options: PiOptions;
	/** A fresh directory for the run's project files. */
	dir: string;
	/** Observations the probe extension wrote, in order. */
	observations(): Array<Record<string, unknown>>;
	/** The last user message of every request that reached the stub provider, in order. */
	received(): Received[];
}

const lines = (path: string) => (existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : []);

export function probeRun(scenario: string, env: Record<string, string> = {}, extra: Partial<PiOptions> = {}): ProbeRun {
	const dir = mkdtempSync(join(tmpdir(), "context-refs-probe-"));
	const project = join(dir, "project");
	mkdirSync(project);
	const log = join(dir, "probe.jsonl");
	const receivedLog = join(dir, "received.jsonl");
	return {
		options: { cwd: project, env: { PROBE_SCENARIO: scenario, PROBE_LOG: log, STUB_RECEIVED_LOG: receivedLog, ...env }, ...extra },
		dir: project,
		observations: () => lines(log).map((line) => JSON.parse(line) as Record<string, unknown>),
		received: () => lines(receivedLog).map((line) => JSON.parse(line) as Received),
	};
}
