// Builds the WebContainer snapshots behind the site's live try-it pages: for
// each package, real pi and the packed package installed from npm inside a
// Node 22.19 container (the only step that needs the network), pruned to what
// pi loads, plus the demo kit (tools/site/try) compiled for Node. The result
// is gzipped to site/.snapshots/<package>.snapshot.gz; the page unpacks it
// with DecompressionStream, so any static host serves it small.
//
//   node tools/site/snapshot.ts [package ...]      (default: every package with a kit)
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { gzipSync } from "node:zlib";
import { snapshot } from "@webcontainer/snapshot";
import { runTool } from "../../scripts/lib/docker.ts";
import { ROOT } from "../../scripts/lib/repo.ts";

/** The Node image the snapshots are installed with: the repository's Node floor, pinned by digest. */
const NODE_IMAGE = "node:22.19.0@sha256:afff6d8c97964a438d2e6a9c96509367e45d8bf93f790ad561a1eaea926303d9";
export const SNAPSHOTS = join(ROOT, "site", ".snapshots");
/** The packages each kit runs: the demo boot script in tools/site/try. */
export const KITS: Record<string, string> = { "pi-account-guard": "account-guard" };
/** What pi needs at run time besides the extension; everything else npm installs is left out. */
const KEEP = ["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai", "@earendil-works/pi-telemetry", "jiti", "typebox"];
/** Files no running pi reads. */
const DROP = /\.(d\.ts|d\.mts|d\.cts|map|md)$/;

const mb = (bytes: number) => `${(bytes / 1048576).toFixed(1)} MB`;

function prune(dir: string): void {
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) prune(path);
		else if (DROP.test(name) && !/^LICENSE/i.test(name)) rmSync(path);
	}
}

async function build(folder: string, kit: string): Promise<void> {
	const manifest = JSON.parse(readFileSync(join(ROOT, "packages", folder, "package.json"), "utf8")) as { name: string };
	const pi = JSON.parse(readFileSync(join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "package.json"), "utf8")) as { version: string };
	const work = join(SNAPSHOTS, folder);
	const install = join(work, "install");
	rmSync(work, { recursive: true, force: true });
	mkdirSync(install, { recursive: true });

	const tarball =
		execFileSync("npm", ["pack", "--workspace", `packages/${folder}`, "--pack-destination", install, "--silent"], { cwd: ROOT, encoding: "utf8" })
			.trim()
			.split("\n")
			.at(-1) ?? "";
	writeFileSync(
		join(install, "package.json"),
		`${JSON.stringify({ private: true, type: "module", dependencies: { "@earendil-works/pi-coding-agent": pi.version, [manifest.name]: `file:./${tarball}` } }, null, "\t")}\n`,
	);
	const code = runTool(
		{ name: "node-floor", image: NODE_IMAGE },
		["sh", "-c", "cd /work && npm install --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error --cache /tmp/npm-cache"],
		{ mounts: [`${install}:/work`], network: true, asHostUser: true },
	);
	if (code !== 0) throw new Error(`${folder}: npm install failed in ${NODE_IMAGE}`);

	const root = join(work, "root");
	for (const name of [...KEEP, manifest.name])
		cpSync(join(install, "node_modules", name), join(root, "node_modules", name), { recursive: true, dereference: true });
	const agent = join(root, "node_modules", "@earendil-works", "pi-coding-agent");
	// pi runs from its bundle and maps extensions' pi imports to it, so the rest of the package stays out.
	for (const name of readdirSync(agent)) if (name !== "dist" && name !== "package.json") rmSync(join(agent, name), { recursive: true, force: true });
	for (const name of readdirSync(join(agent, "dist"))) if (name !== "bundle") rmSync(join(agent, "dist", name), { recursive: true, force: true });
	prune(join(root, "node_modules"));
	// `pi` on the shell's PATH, as npm would link it.
	mkdirSync(join(root, "node_modules", ".bin"), { recursive: true });
	// pi reads argv[1] to find itself, so the link names its real entry before loading it. Without an
	// extension Node may load the file as CommonJS, so it uses neither import.meta nor require.
	const shim = [
		"#!/usr/bin/env node",
		'const bundle = process.argv[1].replace(/\\.bin\\/pi$/, "@earendil-works/pi-coding-agent/dist/bundle/");',
		'process.argv[1] = bundle + "cli.js";',
		'import("file://" + bundle + "cli-runtime.js");',
		"",
	].join("\n");
	writeFileSync(join(root, "node_modules", ".bin", "pi"), shim, { mode: 0o755 });
	writeFileSync(join(root, "package.json"), '{ "private": true, "type": "module" }\n');
	execFileSync(join(ROOT, "node_modules", ".bin", "tsc"), ["-p", join(ROOT, "tools", "site", "tsconfig.try.json"), "--outDir", join(root, "kit")], {
		stdio: "inherit",
	});
	writeFileSync(join(root, "boot.js"), `import "./kit/tools/site/try/${kit}.js";\n`);

	const bytes = await snapshot(root);
	const gz = gzipSync(bytes, { level: 9 });
	writeFileSync(join(SNAPSHOTS, `${folder}.snapshot.gz`), gz);
	console.log(`snapshot: ${folder} raw ${mb(bytes.byteLength)}, gzip ${mb(gz.byteLength)} -> ${relative(ROOT, join(SNAPSHOTS, `${folder}.snapshot.gz`))}`);
}

const wanted = process.argv.slice(2);
for (const [folder, kit] of Object.entries(KITS)) {
	if (wanted.length > 0 && !wanted.includes(folder)) continue;
	if (!existsSync(join(ROOT, "packages", folder))) continue;
	await build(folder, kit);
}
