// Installs pi-switchboard the way users get it: packed from this working tree
// into a tarball, installed into a pi agent folder as `pi install npm:` does,
// with its bin from that same install. scripts/smoke-pack.ts does the same for
// every package; a package may not import repository scripts, so the few lines
// are repeated here.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "./proc.ts";
import { cacheDir, isolatedEnv, REPO, type Run } from "./run.ts";

const NAME = "@crisboarna/pi-switchboard";

export interface Installed {
	/** The agent folder pi runs on; its settings.json lists the package. */
	agentDir: string;
	/** The installed `pi-switchboard` bin. */
	bin: string;
	/** A home folder for the CLI and pi, so nothing reads the user's own. */
	home: string;
}

/**
 * Packs the package and installs the tarball. pi's packages are peers that pi
 * supplies and the package imports only as types, so they are left out, and
 * the only dependency installed is the pinned jiti.
 */
export async function installTarball(runDir: Run): Promise<Installed> {
	const packDir = runDir.folder("pack");
	const home = runDir.folder("home");
	const env = isolatedEnv(home);
	const npmCache = cacheDir("npm");
	const packed = await run("npm", ["pack", "--json", "--ignore-scripts", "--workspace", NAME, "--pack-destination", packDir, "--cache", npmCache], {
		env,
		cwd: REPO,
		log: join(runDir.dir, "npm-pack.log"),
	});
	if (packed.code !== 0) throw new Error(runDir.explain(`npm pack failed:\n${packed.stderr}`));
	const [pack] = JSON.parse(packed.stdout) as Array<{ filename: string }>;
	if (!pack) throw new Error(runDir.explain("npm pack printed no tarball"));

	const agentDir = runDir.folder("agent");
	const npmDir = join(agentDir, "npm");
	runDir.folder("agent/npm");
	writeFileSync(join(npmDir, "package.json"), JSON.stringify({ name: "pi-packages", private: true }));
	const installed = await run(
		"npm",
		[
			"install",
			"--ignore-scripts",
			"--omit=peer",
			"--legacy-peer-deps",
			"--no-audit",
			"--no-fund",
			"--min-release-age=3",
			"--cache",
			npmCache,
			join(packDir, pack.filename),
		],
		{ env, cwd: npmDir, log: join(runDir.dir, "npm-install.log") },
	);
	if (installed.code !== 0) throw new Error(runDir.explain(`npm install of the tarball failed:\n${installed.stderr}`));
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [`npm:${NAME}`] }));
	return { agentDir, bin: join(npmDir, "node_modules", ".bin", "pi-switchboard"), home };
}
