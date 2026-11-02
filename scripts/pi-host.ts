// Puts one chosen version of pi into this checkout, so the tests and smoke runs that already load pi from node_modules run against it:
//
//   npm run pi-host -- floor                the bottom of the range the packages declare (scripts/lib/repo.ts, PI_PEER_RANGE)
//   npm run pi-host -- latest               the newest release inside the range that is at least min-release-age old
//   npm run pi-host -- newest --allow-young the newest release there is, even one published today; for the nightly run only
//   npm run pi-host -- 1.4.0                one exact release
//   npm run pi-host -- latest --resolve     only print the version, install nothing
//
// It changes node_modules, not package.json or the lockfile (--no-save), so it refuses to run outside CI unless you pass --local; after a
// local run, `npm ci` puts the pinned pi back. Safeguards: packages install with --ignore-scripts; the repository's min-release-age is applied
// here, because it is switched off for the install itself (the four pi packages are published together, and "newest" must reach a release
// younger than the rule allows); and every package must end up at the version asked for, so there is one copy of pi.
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { minReleaseAgeDays } from "./lib/coexist-pins.ts";
import { PI_PACKAGES, parseRange, resolvePi } from "./lib/pi-versions.ts";
import { PI_PEER_RANGE, ROOT, readJson } from "./lib/repo.ts";

const USAGE = "usage: npm run pi-host -- <floor|latest|newest|x.y.z> [--resolve] [--allow-young] [--local]";
const FLAGS = new Set(["--resolve", "--allow-young", "--local"]);

function fail(message: string, code = 1): never {
	console.error(`pi-host: ${message}`);
	process.exit(code);
}

const args = process.argv.slice(2);
const unknown = args.find((arg) => arg.startsWith("--") && !FLAGS.has(arg));
const specs = args.filter((arg) => !arg.startsWith("--"));
if (unknown) fail(`unknown option ${unknown}\n${USAGE}`, 2);
if (specs.length !== 1 || specs[0] === undefined) fail(USAGE, 2);
const spec = specs[0];
const resolveOnly = args.includes("--resolve");
const allowYoung = args.includes("--allow-young");
if (!(resolveOnly || args.includes("--local") || process.env.CI === "true")) {
	fail("this replaces the pi in node_modules; run it in CI, or pass --local and run `npm ci` afterwards", 2);
}

const times = JSON.parse(execFileSync("npm", ["view", PI_PACKAGES[0], "time", "--json"], { encoding: "utf8" })) as Record<string, string>;
let version: string;
try {
	version = resolvePi(spec, {
		times,
		range: parseRange(PI_PEER_RANGE),
		now: new Date(),
		days: minReleaseAgeDays(readFileSync(join(ROOT, ".npmrc"), "utf8")),
		allowYoung,
	});
} catch (error) {
	fail((error as Error).message);
}

if (resolveOnly) {
	console.log(version);
	process.exit(0);
}

console.log(`pi-host: installing pi ${version} (${spec})`);
const install = spawnSync(
	"npm",
	["install", "--no-save", "--ignore-scripts", "--no-audit", "--no-fund", "--min-release-age=0", ...PI_PACKAGES.map((name) => `${name}@${version}`)],
	{ cwd: ROOT, stdio: "inherit" },
);
if (install.status !== 0) fail("npm install failed");
for (const name of PI_PACKAGES) {
	const installed = (readJson(join(ROOT, "node_modules", name, "package.json")) as { version: string }).version;
	if (installed !== version) fail(`${name} installed as ${installed}, not ${version}`);
}

console.log(`pi-host: pi ${version} is installed`);
// What a CI job reads back: the version that was really tested, in the job summary and as a step output.
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `- tested with pi ${version} (${spec})\n`);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `pi=${version}\n`);
if (process.env.CI !== "true") console.log("pi-host: run `npm ci` to put the pinned pi back");
