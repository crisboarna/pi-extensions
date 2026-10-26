// Opt-in: runs real pi (`npm run test:smoke`). Needs no network and no credentials.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { runPrint } from "../support/pi-process.ts";
import { STUB_PROVIDER, STUB_REPLY } from "../support/stub-provider.ts";

/** The stub provider's account: its key is built from the `fallback` auth source. */
const STUB_ACCOUNT = { provider: STUB_PROVIDER, source: "fallback" };

interface Workspace {
	/** Real path of the directory pi runs in. */
	place: string;
	env: Record<string, string>;
	requests(): string[];
}

function workspace(config: unknown): Workspace {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "account-guard-block-")));
	const agentDir = join(root, "agent");
	const place = join(root, "place");
	mkdirSync(agentDir);
	mkdirSync(place);
	const requestLog = join(root, "requests.txt");
	if (config !== undefined) writeFileSync(join(agentDir, "account-guard.json"), JSON.stringify(typeof config === "function" ? config(place) : config));
	return {
		place,
		env: { PI_CODING_AGENT_DIR: agentDir, STUB_REQUEST_LOG: requestLog },
		requests: () => (existsSync(requestLog) ? readFileSync(requestLog, "utf8").split("\n").filter(Boolean) : []),
	};
}

describe("headless block (DESIGN.md section 9.3, ADR 0005)", () => {
	it("runs the turn and prints nothing extra when the account matches the place zone", async () => {
		const space = workspace((place: string) => ({ accounts: [{ ...STUB_ACCOUNT, zones: ["work"] }], places: [{ path: place, zone: "work" }] }));
		const result = await runPrint("hello", { env: space.env, cwd: space.place });
		assert.equal(result.code, 0, result.stderr);
		assert.equal(result.stdout.trim(), STUB_REPLY);
		assert.equal(result.stderr, "");
		assert.deepEqual(space.requests(), ["stub-model"]);
	});

	it("sends nothing, names the account, place and zones on stderr, and exits 77 on a mismatch", async () => {
		const space = workspace({ accounts: [{ ...STUB_ACCOUNT, zones: ["work"] }] });
		const result = await runPrint("hello", { env: space.env, cwd: space.place });
		assert.equal(result.code, 77);
		assert.equal(result.stdout, "");
		assert.match(result.stderr, /^BLOCKED stub \(fallback\) is zone work; this place\n/);
		assert.ok(result.stderr.includes(`(${space.place}) is zone personal. No turn was sent.`), result.stderr);
		assert.match(result.stderr, /Fix, any one of:/);
		assert.deepEqual(space.requests(), [], "no request reached the provider");
	});

	it("blocks an account with no zone tag when the config file is missing", async () => {
		const space = workspace(undefined);
		const result = await runPrint("hello", { env: space.env, cwd: space.place });
		assert.equal(result.code, 77);
		assert.equal(result.stdout, "");
		assert.match(result.stderr, /^BLOCKED stub \(fallback\) has no zone tag; place zone is personal\./);
		assert.deepEqual(space.requests(), []);
	});

	it("checks text that starts with / like any other prompt", async () => {
		const space = workspace({ accounts: [{ ...STUB_ACCOUNT, zones: ["work"] }] });
		const result = await runPrint("/skill:review the diff", { env: space.env, cwd: space.place });
		assert.equal(result.code, 77);
		assert.equal(result.stdout, "");
		assert.deepEqual(space.requests(), []);
	});

	it("matches a symlinked working directory on its real path", async () => {
		const space = workspace((place: string) => ({ accounts: [{ ...STUB_ACCOUNT, zones: ["work"] }], places: [{ path: place, zone: "work" }] }));
		const alias = join(tmpdir(), `account-guard-alias-${process.pid}`);
		symlinkSync(space.place, alias);
		const result = await runPrint("hello", { env: space.env, cwd: alias });
		assert.equal(result.code, 0, result.stderr);
		assert.equal(result.stdout.trim(), STUB_REPLY);
	});
});
