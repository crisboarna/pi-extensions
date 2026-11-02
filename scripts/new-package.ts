// Creates a new package that already passes every repository gate.
//
//   npm run new-package -- <name> "<one-sentence description>"
//
// <name> is the folder and the unscoped npm name, e.g. pi-example; it is
// published as @crisboarna/<name>. The package gets a minimal extension, a
// unit test, README, upgrade notes, AGENTS.md, LICENSE and a pack snapshot, and the script
// runs `npm install` so the workspace is linked.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { packageFiles } from "./lib/package-template.ts";
import { ROOT, SCOPE } from "./lib/repo.ts";

const [name, description] = process.argv.slice(2);
if (!name || !/^pi-[a-z0-9]+(-[a-z0-9]+)*$/.test(name) || !description || description.length < 20) {
	console.error('Usage: npm run new-package -- <pi-name> "<one-sentence description, 20+ characters>"');
	console.error("The name starts with pi- and uses lower-case letters, digits and hyphens.");
	process.exit(1);
}
const dir = join(ROOT, "packages", name);
if (existsSync(dir)) {
	console.error(`packages/${name} already exists.`);
	process.exit(1);
}
const full = `${SCOPE}/${name}`;
const files = packageFiles({
	name,
	description,
	node: (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { engines: { node: string } }).engines.node,
	license: readFileSync(join(ROOT, "LICENSE"), "utf8"),
});

for (const [file, content] of Object.entries(files)) {
	const path = join(dir, file);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
}
for (const template of [".github/ISSUE_TEMPLATE/bug.yml", ".github/ISSUE_TEMPLATE/false-positive.yml", ".github/ISSUE_TEMPLATE/feature.yml"]) {
	const path = join(ROOT, template);
	const text = readFileSync(path, "utf8");
	// Insert the package as the first option, at the indentation of the existing options.
	const match = /^( *)options:\n( *)- /m.exec(text);
	if (match && !text.includes(`- ${name}\n`)) {
		const item = `${match[2]}- ${name}\n`;
		writeFileSync(path, text.replace(`${match[1]}options:\n`, `${match[1]}options:\n${item}`));
	}
}
execFileSync("npm", ["install", "--no-audit", "--no-fund"], { cwd: ROOT, stdio: "inherit" });
execFileSync(join(ROOT, "node_modules/.bin/biome"), ["format", "--write", `packages/${name}`, ".github/ISSUE_TEMPLATE"], { cwd: ROOT, stdio: "inherit" });
execFileSync(process.execPath, ["scripts/checks/pack.ts", "--update"], { cwd: ROOT, stdio: "inherit" });
console.log(
	`\nCreated packages/${name} (${full}). Next: add it to the table in README.md, write the README, list its command in COMMANDS in scripts/smoke-pack.ts, then npm run check.`,
);
