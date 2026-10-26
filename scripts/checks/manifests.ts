// Checks every package manifest against the repository's publishing contract.
//
// Each package is published on its own, so each manifest must be complete:
// scoped name matching its folder, metadata the npm page and the pi gallery
// read, provenance on publish, and pi's host-provided packages declared as
// "*" peers. Pi aliases those modules at runtime; an installed copy puts a
// second instance of the same module in one process.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { HOST_PROVIDED, listPackages, type Manifest, REPOSITORY_URL, ROOT, readJson, reporter, SCOPE } from "../lib/repo.ts";

/** Minimum coverage, in percent, for lines, branches and functions in every package. */
const COVERAGE_FLOOR = 90;

const report = reporter("manifests");
const root = readJson<Manifest>(join(ROOT, "package.json"));
if (root.private !== true) report.fail("root package.json must be private");
for (const field of ["dependencies", "peerDependencies", "optionalDependencies"] as const) {
	if (root[field]) report.fail(`root package.json must not declare ${field}; use devDependencies`);
}

for (const { dir, path, manifest: m } of listPackages()) {
	const at = `packages/${dir}/package.json`;
	const need = (ok: boolean | undefined, message: string): void => {
		if (!ok) report.fail(`${at}: ${message}`);
	};
	need(m.name === `${SCOPE}/${dir}`, `name must be "${SCOPE}/${dir}" (folder name), found "${m.name}"`);
	if (m.private === true) continue;
	need(/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(m.version ?? ""), "version must be semver");
	need(typeof m.description === "string" && m.description.length >= 20, "description must say what the package does (20+ characters)");
	need(m.type === "module", 'type must be "module"');
	need(m.license === "MIT", 'license must be "MIT"');
	need(typeof m.author === "string" && m.author.length > 0, "author is required");
	need(Array.isArray(m.keywords) && m.keywords.includes("pi-package"), 'keywords must include "pi-package" (pi gallery discovery)');
	need(m.repository?.url === REPOSITORY_URL, `repository.url must be "${REPOSITORY_URL}"`);
	need(m.repository?.directory === `packages/${dir}`, `repository.directory must be "packages/${dir}"`);
	need(typeof m.homepage === "string" && m.homepage.includes(`packages/${dir}`), "homepage must point at the package folder");
	need(typeof m.bugs?.url === "string", "bugs.url is required");
	need(m.publishConfig?.access === "public", 'publishConfig.access must be "public" (scoped packages are private by default)');
	need(m.publishConfig?.provenance === true, "publishConfig.provenance must be true");
	need(
		m.engines?.node === root.engines?.node,
		`engines.node must be "${root.engines?.node}", the Node version the repository tests on (found "${m.engines?.node}")`,
	);
	need(Array.isArray(m.files) && m.files.length > 0, "files must list what is published");
	need(existsSync(join(path, "README.md")), "README.md is required");
	need(existsSync(join(path, "LICENSE")), "LICENSE is required");
	need(m.files?.includes("README.md") && m.files?.includes("LICENSE"), "files must include README.md and LICENSE");

	need(typeof m.scripts?.test === "string" && typeof m.scripts?.coverage === "string", "scripts.test and scripts.coverage are required (CI runs both)");
	const tests = existsSync(join(path, "test"))
		? readdirSync(join(path, "test"), { recursive: true, encoding: "utf8" }).filter((file) => file.endsWith(".test.ts"))
		: [];
	need(tests.length > 0, "test/ must contain at least one *.test.ts file; node --test passes when a glob matches nothing");
	for (const metric of ["lines", "branches", "functions"]) {
		const threshold = Number(new RegExp(`--test-coverage-${metric}=(\\d+)`).exec(m.scripts?.coverage ?? "")?.[1] ?? 0);
		need(threshold >= COVERAGE_FLOOR, `scripts.coverage must set --test-coverage-${metric}=${COVERAGE_FLOOR} or higher (found ${threshold || "none"})`);
	}
	need(
		tests.some((file) => file.endsWith("all-modules.test.ts")),
		"test/ must contain all-modules.test.ts, which imports every src/ module so coverage measures files no other test loads",
	);

	const pi = m.pi ?? {};
	const entries = [...(pi.extensions ?? []), ...(pi.skills ?? []), ...(pi.prompts ?? []), ...(pi.themes ?? [])];
	need(entries.length > 0, "pi must declare at least one extension, skill, prompt or theme");
	for (const entry of entries) {
		need(existsSync(join(path, entry)), `pi entry "${entry}" does not exist`);
		const top = entry.replace(/^\.\//, "").split("/")[0];
		need(
			m.files?.some((file) => file.replace(/^\.\//, "").split("/")[0] === top),
			`pi entry "${entry}" is not covered by files`,
		);
	}
	for (const key of ["image", "video"] as const) {
		if (pi[key] !== undefined) need(/^https:\/\//.test(pi[key]), `pi.${key} must be an https URL`);
	}
	for (const [name, target] of Object.entries(m.bin ?? {})) need(existsSync(join(path, target)), `bin "${name}" points at a missing file`);

	for (const field of ["dependencies", "optionalDependencies", "devDependencies"] as const) {
		for (const name of Object.keys(m[field] ?? {})) {
			if (HOST_PROVIDED.includes(name)) need(false, `${name} is provided by pi; declare it in peerDependencies as "*", not ${field}`);
		}
	}
	need(!m.devDependencies, "devDependencies belong in the root package.json so every package tests against the same versions");
	for (const [name, range] of Object.entries(m.peerDependencies ?? {})) {
		if (HOST_PROVIDED.includes(name)) need(range === "*", `peer ${name} must use "*" (pi supplies whatever it bundles), found "${range}"`);
	}
	for (const [name, range] of Object.entries(m.dependencies ?? {})) {
		need(
			/^\d+\.\d+\.\d+$/.test(range) || (name.startsWith(`${SCOPE}/`) && /^\^\d+\.\d+\.\d+$/.test(range)),
			`dependency ${name} must be pinned exactly, found "${range}"`,
		);
	}
}

report.finish("edit the package.json named above; docs/conventions/packages.md lists every field and why.");
