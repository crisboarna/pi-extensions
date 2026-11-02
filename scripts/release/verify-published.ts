// Checks what a release really put in front of users, after the publish job has run: the version is where a user will get it, it carries its provenance,
// npm's own signature check passes on a clean install, and real pi installs it from npm and finds its commands. A publish that "succeeded" but left no tag,
// the wrong `latest`, no attestation or a package that does not load is found here, minutes after it happens, not by a user.
//
//   PUBLISHED='[{"name":"@crisboarna/pi-switchboard","version":"0.1.0"}]' node scripts/release/verify-published.ts [--no-tag]
//
// PUBLISHED is the `published-packages` output of the changesets publish step. The registry can take a few minutes to show a new version, so the checks that
// read it are repeated, every 15 seconds for up to 5 minutes, before they fail. Reads, installs into temporary folders, and publishes and tags nothing.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { COMMANDS, type ListedCommand, PI_CLI, startPi } from "../lib/pi-rpc.ts";

export interface Published {
	name: string;
	version: string;
}

/** The predicate type of the provenance npm records for a package published from GitHub Actions. */
export const PROVENANCE = "https://slsa.dev/provenance/v1";

export interface Facts {
	/** Whether the release's git tag exists on the remote. `undefined` when the tag is not being checked. */
	tag: boolean | undefined;
	/** The `latest` dist-tag, as the registry reports it. */
	latest: string | undefined;
	/** The predicate type of the provenance attestation the registry holds for this version. */
	provenance: string | undefined;
	/** `npm audit signatures --include-attestations` on a clean install of exactly this version. */
	audit: { ok: boolean; detail: string };
	/** What real pi, with this version installed from npm, answered to `get_commands`. */
	pi: { answered: boolean; commands: ListedCommand[]; stderr: string };
}

/** The git tag changesets creates for a release. */
export const tagOf = (published: Published): string => `${published.name}@${published.version}`;

/** Reads the `published-packages` output: a JSON list of names and versions. Anything else is an error, never an empty release. */
export function parsePublished(text: string | undefined): Published[] {
	let value: unknown;
	try {
		value = JSON.parse(text ?? "");
	} catch {
		throw new Error("PUBLISHED is not JSON; it must be the published-packages output of the changesets publish step");
	}
	if (!Array.isArray(value) || value.length === 0) throw new Error("PUBLISHED lists no package; nothing was published, so there is nothing to verify");
	return value.map((item) => {
		const entry = item as { name?: unknown; version?: unknown };
		if (typeof entry.name !== "string" || typeof entry.version !== "string")
			throw new Error(`PUBLISHED has an entry without a name and a version: ${JSON.stringify(item)}`);
		return { name: entry.name, version: entry.version };
	});
}

/** What is wrong with one published version, given what was found; an empty list means it is as it should be. */
export function problemsWith(published: Published, facts: Facts): string[] {
	const where = `${published.name}@${published.version}`;
	const problems: string[] = [];
	if (facts.tag === false) problems.push(`${where}: the git tag ${tagOf(published)} is not on the remote`);
	if (facts.latest !== published.version) problems.push(`${where}: npm's latest is ${facts.latest ?? "missing"}, not this version`);
	if (facts.provenance !== PROVENANCE) problems.push(`${where}: no provenance attestation on npm (found ${facts.provenance ?? "none"})`);
	if (!facts.audit.ok) problems.push(`${where}: npm audit signatures failed on a clean install: ${facts.audit.detail}`);
	if (!facts.pi.answered) {
		problems.push(`${where}: pi did not answer get_commands with it installed from npm ${facts.pi.stderr.trim().slice(0, 300)}`.trim());
		return problems;
	}
	const expected = COMMANDS[published.name];
	if (expected === undefined) {
		problems.push(`${where}: list the commands it registers in COMMANDS in scripts/lib/pi-rpc.ts (an empty list if it has none)`);
		return problems;
	}
	for (const name of expected) {
		const found = facts.pi.commands.find((command) => command.name === name);
		if (!found) problems.push(`${where}: pi installed it from npm but it registers no /${name}`);
		else if (found.source !== `npm:${published.name}`)
			problems.push(`${where}: /${name} came from ${found.source ?? "no source"}, not from the npm install`);
	}
	return problems;
}

export interface RetryOptions {
	attempts: number;
	delayMs: number;
	sleep: (ms: number) => Promise<void>;
}

/** Reads `read` until `done` accepts its answer or the attempts run out, and returns the last answer: the registry shows a new version after a delay. */
export async function readUntil<T>(read: () => T | Promise<T>, done: (value: T) => boolean, options: RetryOptions): Promise<T> {
	let value = await read();
	for (let attempt = 1; attempt < options.attempts && !done(value); attempt += 1) {
		await options.sleep(options.delayMs);
		value = await read();
	}
	return value;
}

const npmView = (spec: string, field: string): string | undefined => {
	const result = spawnSync("npm", ["view", spec, field], { encoding: "utf8" });
	const text = result.stdout.trim();
	return result.status === 0 && text !== "" ? text : undefined;
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** `npm audit signatures --include-attestations` on a fresh project that installs only this version, so what is checked is what a user installs. */
function auditOnCleanInstall(published: Published): { ok: boolean; detail: string } {
	const dir = mkdtempSync(join(tmpdir(), "verify-release-"));
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "verify-release", private: true, version: "0.0.0" }));
	const install = spawnSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", `${published.name}@${published.version}`], {
		cwd: dir,
		encoding: "utf8",
	});
	if (install.status !== 0) return { ok: false, detail: `npm install failed: ${install.stderr.trim().slice(-300)}` };
	const audit = spawnSync("npm", ["audit", "signatures", "--include-attestations"], { cwd: dir, encoding: "utf8" });
	const detail = `${audit.stdout}${audit.stderr}`.trim().split("\n").slice(-6).join(" | ");
	return { ok: audit.status === 0, detail };
}

/** Real pi on an empty agent directory: `pi install npm:<name>@<version>` from the registry, then its commands over RPC. */
async function loadInPi(published: Published): Promise<Facts["pi"]> {
	const home = mkdtempSync(join(tmpdir(), "verify-release-pi-"));
	const agentDir = join(home, "agent");
	mkdirSync(agentDir, { recursive: true });
	const install = spawnSync(process.execPath, [PI_CLI, "install", `npm:${published.name}@${published.version}`], {
		cwd: home,
		env: { ...process.env, HOME: home, PI_CODING_AGENT_DIR: agentDir },
		encoding: "utf8",
	});
	if (install.status !== 0) return { answered: false, commands: [], stderr: `pi install failed: ${install.stderr.trim().slice(-300)}` };
	return startPi(agentDir, home);
}

export interface GatherOptions extends RetryOptions {
	checkTag: boolean;
}

/** Everything `problemsWith` needs, read from the remote, the registry, a clean install and real pi. */
export async function gather(published: Published, options: GatherOptions): Promise<Facts> {
	const spec = `${published.name}@${published.version}`;
	const tag = options.checkTag ? hasTag(tagOf(published)) : undefined;
	const latest = await readUntil(
		() => npmView(published.name, "dist-tags.latest"),
		(value) => value === published.version,
		options,
	);
	const provenance = await readUntil(
		() => npmView(spec, "dist.attestations.provenance.predicateType"),
		(value) => value === PROVENANCE,
		options,
	);
	return { tag, latest, provenance, audit: auditOnCleanInstall(published), pi: await loadInPi(published) };
}

function hasTag(tag: string): boolean {
	try {
		execFileSync("git", ["ls-remote", "--exit-code", "--tags", "origin", `refs/tags/${tag}`], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const published = parsePublished(process.env.PUBLISHED);
	const options: GatherOptions = { attempts: 21, delayMs: 15_000, sleep, checkTag: !process.argv.includes("--no-tag") };
	let failed = false;
	for (const item of published) {
		const problems = problemsWith(item, await gather(item, options));
		console.log(`${problems.length === 0 ? "ok     " : "FAILED "} ${item.name}@${item.version}`);
		for (const problem of problems) console.log(`  - ${problem}`);
		failed ||= problems.length > 0;
	}
	process.exitCode = failed ? 1 : 0;
}
