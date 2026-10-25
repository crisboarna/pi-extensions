import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface Lease {
	id: string;
	pid: number;
	expiresAt: number;
}

/** Health of one cooldown key or one physical model. */
export interface MemberHealth {
	cooldownUntil?: number;
	cooldownReason?: string;
	/** Timestamps of recent server errors, for allowedFails. */
	fails?: number[];
	/** Consecutive overloaded responses. */
	overloads?: number;
	lastUsedAt?: number;
	leases?: Lease[];
	latencyEwma?: number;
	latencySamples?: number;
}

export interface HealthData {
	v: 1;
	members: Record<string, MemberHealth>;
	/** Round-robin pointers by `<profile>/<tier>`. */
	pointers: Record<string, number>;
	/** Smooth weighted round-robin counters by `<profile>/<tier>`, then member key. */
	swrr: Record<string, Record<string, number>>;
	/** The account each session last used per base provider, for account affinity. */
	accounts: Record<string, Record<string, string>>;
}

export function emptyHealth(): HealthData {
	return { v: 1, members: {}, pointers: {}, swrr: {}, accounts: {} };
}

export interface HealthStore {
	/** Runs `fn` on the current data and saves what it changed. */
	update<T>(fn: (data: HealthData) => T): T;
	read(): HealthData;
	/** Whether data is shared with other processes. */
	readonly shared: boolean;
	/** True when the last update could not take the shared lock and ran on a private copy. */
	readonly degraded: boolean;
}

export class MemoryHealthStore implements HealthStore {
	private data: HealthData;
	readonly shared = false;
	readonly degraded = false;

	constructor(data: HealthData = emptyHealth()) {
		this.data = data;
	}

	update<T>(fn: (data: HealthData) => T): T {
		return fn(this.data);
	}

	read(): HealthData {
		return this.data;
	}
}

const LOCK_STALE_MS = 10_000;
const LOCK_RETRY_MS = 25;
const LOCK_WAIT_MS = 250;
const sleeper = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms: number): void {
	Atomics.wait(sleeper, 0, 0, ms);
}

function parse(text: string): HealthData {
	try {
		const value = JSON.parse(text) as Partial<HealthData>;
		if (value && value.v === 1) return { ...emptyHealth(), ...value } as HealthData;
	} catch {
		// A damaged file starts over; health is a cache, not a record.
	}
	return emptyHealth();
}

/**
 * Health shared by every pi process on the machine (main sessions, foreground
 * and background subagents), in one JSON file guarded by an `O_EXCL` lock
 * file and replaced atomically. When the lock cannot be taken, the update runs
 * on an in-memory copy and `shared` turns false for that update.
 */
export class FileHealthStore implements HealthStore {
	private readonly path: string;
	private readonly lockPath: string;
	private memory: HealthData = emptyHealth();
	shared = true;
	degraded = false;

	constructor(path: string) {
		this.path = path;
		this.lockPath = `${path}.lock`;
		mkdirSync(dirname(path), { recursive: true });
	}

	read(): HealthData {
		try {
			return parse(readFileSync(this.path, "utf8"));
		} catch {
			return this.memory;
		}
	}

	update<T>(fn: (data: HealthData) => T): T {
		if (!this.lock()) {
			this.shared = false;
			this.degraded = true;
			return fn(this.memory);
		}
		this.shared = true;
		this.degraded = false;
		try {
			const data = this.read();
			const result = fn(data);
			const temp = `${this.path}.${process.pid}.tmp`;
			writeFileSync(temp, JSON.stringify(data), { mode: 0o600 });
			renameSync(temp, this.path);
			this.memory = data;
			return result;
		} finally {
			rmSync(this.lockPath, { force: true });
		}
	}

	private lock(): boolean {
		const deadline = Date.now() + LOCK_WAIT_MS;
		for (;;) {
			try {
				const fd = openSync(this.lockPath, "wx", 0o600);
				writeFileSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now() }));
				closeSync(fd);
				return true;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") return false;
				try {
					if (Date.now() - statSync(this.lockPath).mtimeMs > LOCK_STALE_MS) rmSync(this.lockPath, { force: true });
				} catch {
					// The holder released it between our attempts.
				}
				if (Date.now() >= deadline) return false;
				sleepSync(LOCK_RETRY_MS);
			}
		}
	}
}

/** Drops expired leases and leases of dead processes. */
export function liveLeases(health: MemberHealth | undefined, now: number, isAlive: (pid: number) => boolean = processAlive): Lease[] {
	return (health?.leases ?? []).filter((lease) => lease.expiresAt > now && isAlive(lease.pid));
}

export function processAlive(pid: number): boolean {
	if (pid === process.pid) return true;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}
