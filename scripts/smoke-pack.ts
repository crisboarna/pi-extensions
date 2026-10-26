// Installs each package from its packed tarball, the way a user gets it, and
// checks that it loads.
//
// Unit tests run the source tree; users run what npm unpacked under
// node_modules, where Node will not strip TypeScript types and only the
// `files` list exists. For every package this script:
//   1. packs it and installs the tarball into an empty temporary project;
//   2. loads each pi.extensions entry through jiti (pi's loader), with pi's
//      packages linked in as pi provides them, and expects a default export
//      function;
//   3. runs each bin with --help and expects exit code 0.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { HOST_PROVIDED, listPackages, ROOT, reporter } from "./lib/repo.ts";

const report = reporter("smoke-pack");
const require = createRequire(join(ROOT, "package.json"));
const { createJiti } = (await import(require.resolve("jiti"))) as typeof import("jiti");
const only = process.argv.slice(2);
// pi provides its own packages to extensions; link the root copies in as installed peers.
const hostPackages = HOST_PROVIDED.map((name): [string, string] => [name, join(ROOT, "node_modules", name)]).filter(([, path]) => existsSync(path));

for (const { manifest } of listPackages()) {
	if (manifest.private === true || (only.length > 0 && !only.includes(manifest.name))) continue;
	const work = mkdtempSync(join(tmpdir(), "pi-ext-smoke-"));
	try {
		const [pack] = JSON.parse(
			execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--workspace", manifest.name, "--pack-destination", work], {
				cwd: ROOT,
				encoding: "utf8",
			}),
		);
		writeFileSync(join(work, "package.json"), JSON.stringify({ name: "smoke", private: true, type: "module" }));
		execFileSync("npm", ["install", "--ignore-scripts", "--omit=peer", "--no-audit", "--no-fund", "--min-release-age=3", join(work, pack.filename)], {
			cwd: work,
			stdio: "pipe",
		});
		const installed = join(work, "node_modules", ...manifest.name.split("/"));
		for (const [name, path] of hostPackages) {
			const link = join(work, "node_modules", name);
			if (existsSync(link)) continue;
			mkdirSync(dirname(link), { recursive: true });
			symlinkSync(path, link, "dir");
		}

		const jiti = createJiti(join(work, "index.js"), { moduleCache: false });
		for (const entry of manifest.pi?.extensions ?? []) {
			try {
				const mod = await jiti.import<{ default?: unknown }>(join(installed, entry));
				const factory = mod?.default ?? mod;
				if (typeof factory !== "function") report.fail(`${manifest.name}: ${entry} has no default export function`);
			} catch (error) {
				report.fail(`${manifest.name}: ${entry} does not load from the tarball: ${String(error).split("\n")[0]}`);
			}
		}
		for (const [name, target] of Object.entries(manifest.bin ?? {})) {
			const run = spawnSync(process.execPath, [join(installed, target), "--help"], { cwd: work, encoding: "utf8" });
			if (run.status !== 0) report.fail(`${manifest.name}: bin ${name} --help exited ${run.status}: ${(run.stderr || run.stdout).trim().split("\n")[0]}`);
		}
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}

report.finish("make the published files self-sufficient: no TypeScript executed by Node from node_modules, every runtime import declared.");
