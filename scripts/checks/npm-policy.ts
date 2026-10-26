// Checks the supply-chain settings that every install relies on.
//
// - .npmrc must keep the dependency-script allow-list and the minimum release
//   age; removing either line would silently weaken every later install.
// - The lockfile must exist, use lockfile v3, and resolve every package from
//   the public npm registry with a sha512 integrity hash, so a dependency
//   cannot be swapped for a git URL, a tarball elsewhere or an unhashed copy.
// - npm must be new enough to honour those settings.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, readJson, reporter } from "../lib/repo.ts";

const REQUIRED_NPMRC = {
	"strict-allow-scripts": "true",
	"min-release-age": "3",
	"save-exact": "true",
	"engine-strict": "true",
};
const MIN_NPM = [11, 10, 0];

const report = reporter("npm-policy");
const npmrcPath = join(ROOT, ".npmrc");
const npmrc = existsSync(npmrcPath) ? readFileSync(npmrcPath, "utf8") : "";
for (const [key, value] of Object.entries(REQUIRED_NPMRC)) {
	if (!new RegExp(`^${key}=${value}$`, "m").test(npmrc)) report.fail(`.npmrc must contain "${key}=${value}"`);
}
if (/^(dangerously-allow-all-scripts|ignore-scripts)=/m.test(npmrc))
	report.fail(".npmrc must not set dangerously-allow-all-scripts or ignore-scripts; use package.json allowScripts");

const version = execFileSync("npm", ["--version"], { encoding: "utf8" }).trim().split(".").map(Number);
const older = MIN_NPM.findIndex((part, index) => (version[index] ?? 0) !== part);
if (older !== -1 && (version[older] ?? 0) < (MIN_NPM[older] ?? 0))
	report.fail(`npm ${version.join(".")} is older than ${MIN_NPM.join(".")}; it ignores min-release-age`);

const lockPath = join(ROOT, "package-lock.json");
if (!existsSync(lockPath)) report.fail("package-lock.json is missing; run npm install");
else {
	const lock = readJson<{ lockfileVersion?: number; packages?: Record<string, { resolved?: string; integrity?: string; link?: boolean }> }>(lockPath);
	if (lock.lockfileVersion !== 3) report.fail(`package-lock.json is lockfile v${lock.lockfileVersion}; expected v3`);
	for (const [path, entry] of Object.entries(lock.packages ?? {})) {
		if (path === "" || entry.link === true || !path.includes("node_modules/")) continue;
		if (!entry.resolved?.startsWith("https://registry.npmjs.org/"))
			report.fail(`${path}: resolved from ${entry.resolved ?? "nowhere"}, not the npm registry`);
		if (!entry.integrity?.startsWith("sha512-")) report.fail(`${path}: no sha512 integrity`);
	}
}

report.finish("restore the setting or reinstall from the registry; see docs/conventions/dependencies.md.");
