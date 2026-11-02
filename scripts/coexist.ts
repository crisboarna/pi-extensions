// Runs the package beside real third-party extensions, which are not in this repository: installs the versions pinned in
// scripts/coexist.json into a temporary folder, loads them into real pi in both orders around the package, and removes the folder.
//
//   npm run coexist                  install the pins, run every package's test/coexist tests, remove the folder
//   npm run coexist -- --keep        keep the folder, to look at what was installed
//
// It runs on demand, not in a hook or in CI: it needs the npm registry, and the extensions are other people's code. Safeguards:
//   - a pin must be an exact version at least as old as the repository's .npmrc `min-release-age`, which does not apply outside the
//     repository, so this script applies it (scripts/lib/coexist-pins.ts);
//   - packages are installed with --ignore-scripts, so nothing they ship runs while installing;
//   - pi's own packages come from this repository by symlink, not from the registry, so the extensions run against the pi under test
//     and there is only one copy of it (--legacy-peer-deps keeps npm from installing a second one);
//   - nothing is written inside the repository.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { minReleaseAgeDays, type Pin, problemsWith, readPins } from "./lib/coexist-pins.ts";
import { ROOT, readJson } from "./lib/repo.ts";

const USAGE = "usage: npm run coexist -- [--keep]";
const args = process.argv.slice(2);
const unknown = args.find((arg) => arg !== "--keep");
if (unknown) {
	console.error(`coexist: unknown option ${unknown}\n${USAGE}`);
	process.exit(2);
}
const keep = args.includes("--keep");

const fail = (message: string): never => {
	console.error(`coexist: ${message}`);
	process.exit(1);
};

/** The ISO time the registry says `pin` was published, or undefined. */
function publishedAt(pin: Pin): string | undefined {
	const times = JSON.parse(execFileSync("npm", ["view", pin.name, "time", "--json"], { encoding: "utf8" })) as Record<string, string>;
	return times[pin.version];
}

const pins = readPins(readJson(join(ROOT, "scripts", "coexist.json")));
const days = minReleaseAgeDays(readFileSync(join(ROOT, ".npmrc"), "utf8"));
const published = Object.fromEntries(pins.map((pin) => [`${pin.name}@${pin.version}`, publishedAt(pin)]));
const problems = problemsWith(pins, published, new Date(), days);
if (problems.length > 0) fail(`not installing:\n  ${problems.join("\n  ")}`);

const suites = readdirSync(join(ROOT, "packages"))
	.map((name) => join("packages", name, "test", "coexist"))
	.filter((dir) => existsSync(join(ROOT, dir)))
	.flatMap((dir) =>
		readdirSync(join(ROOT, dir))
			.filter((name) => name.endsWith(".test.ts"))
			.map((name) => ({ cwd: join(ROOT, dir, "..", ".."), file: join("test", "coexist", name) })),
	);
if (suites.length === 0) fail("there are no test/coexist tests to run");

const dir = mkdtempSync(join(tmpdir(), "coexist-"));
let status = 1;
try {
	writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name: "coexist", private: true })}\n`);
	console.log(`coexist: installing ${pins.map((pin) => `${pin.name}@${pin.version}`).join(", ")} into ${dir}`);
	const install = spawnSync(
		"npm",
		[
			"install",
			"--ignore-scripts",
			"--legacy-peer-deps",
			"--no-audit",
			"--no-fund",
			"--omit=dev",
			"--save-exact",
			...pins.map((pin) => `${pin.name}@${pin.version}`),
		],
		{ cwd: dir, stdio: "inherit" },
	);
	if (install.status !== 0) fail("npm install failed");
	for (const pin of pins) {
		const installed = (readJson(join(dir, "node_modules", pin.name, "package.json")) as { version: string }).version;
		if (installed !== pin.version) fail(`${pin.name} installed as ${installed}, not the pinned ${pin.version}`);
	}
	for (const name of ["@earendil-works", "typebox"]) {
		const source = join(ROOT, "node_modules", name);
		if (!existsSync(source)) fail(`${source} is missing; run npm install in the repository first`);
		if (!existsSync(join(dir, "node_modules", name))) symlinkSync(realpathSync(source), join(dir, "node_modules", name));
	}
	const { NODE_TEST_CONTEXT: _outer, ...inherited } = process.env;
	status = 0;
	for (const suite of suites) {
		const run = spawnSync(process.execPath, ["--test", "--test-reporter=spec", suite.file], {
			cwd: suite.cwd,
			env: { ...inherited, COEXIST_DIR: dir },
			stdio: "inherit",
		});
		if (run.status !== 0) status = 1;
	}
} finally {
	if (keep) console.log(`coexist: kept ${dir}`);
	else rmSync(dir, { recursive: true, force: true });
}
process.exit(status);
