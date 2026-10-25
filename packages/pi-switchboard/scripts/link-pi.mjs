// Links the installed pi release into node_modules so tsc and the integration
// tests resolve the host packages that pi supplies at runtime. Development only.
import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const releases = join(homedir(), ".pi", "agent", "install", "releases");
const version = process.env.PI_RELEASE ?? readdirSync(releases)
	.filter((name) => /^\d+\.\d+\.\d+$/.test(name))
	.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
	.at(-1);
if (!version) throw new Error(`No pi release found under ${releases}`);
const source = join(releases, version, "node_modules");

const links = [
	"@earendil-works/pi-coding-agent",
	"@earendil-works/pi-ai",
	"@earendil-works/pi-tui",
	"@earendil-works/pi-agent-core",
	"@types/node",
	"typebox",
	"jiti",
];
for (const name of links) {
	const target = join(source, name);
	if (!existsSync(target)) continue;
	const link = join("node_modules", name);
	mkdirSync(join(link, ".."), { recursive: true });
	rmSync(link, { recursive: true, force: true });
	symlinkSync(target, link);
}
console.log(`Linked pi ${version} from ${source}`);
