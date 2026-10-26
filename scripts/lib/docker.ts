// Runs repository tools inside pinned Docker images, so a gate gives the same
// answer on every machine and in CI, whatever is installed on the host.
//
// Images are pinned by digest (or built from a Dockerfile under tools/docker
// and tagged with the file's hash). When DOCKER_IMAGE_CACHE names a directory,
// images are loaded from and saved to tarballs there; CI caches that
// directory between runs.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./repo.ts";

export interface DockerTool {
	/** Short name used in messages and cache file names. */
	name: string;
	/** A pinned image reference (`name:tag@sha256:...`), pulled when missing. */
	image?: string;
	/** A Dockerfile under tools/docker, built when missing. */
	dockerfile?: string;
}

function docker(args: string[], inherit = false): { ok: boolean; stdout: string } {
	const run = spawnSync("docker", args, { cwd: ROOT, encoding: "utf8", stdio: inherit ? "inherit" : "pipe" });
	return { ok: run.status === 0, stdout: run.stdout ?? "" };
}

function fail(message: string): never {
	console.error(message);
	process.exit(1);
}

/** The local image reference for a tool, pulling, loading or building it first if needed. */
export function ensureImage(tool: DockerTool): string {
	if (!docker(["info", "--format", "{{.ServerVersion}}"]).ok) {
		fail(`${tool.name}: Docker is required and not running. Start Docker (Docker Desktop, Colima or dockerd) and retry.`);
	}
	let reference: string;
	if (tool.dockerfile) {
		const path = join(ROOT, "tools", "docker", tool.dockerfile);
		const hash = createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 12);
		reference = `pi-extensions-${tool.name}:${hash}`;
	} else if (tool.image) reference = tool.image;
	else fail(`${tool.name}: no image or Dockerfile configured`);

	if (docker(["image", "inspect", reference]).ok) return reference;
	const cacheDir = process.env.DOCKER_IMAGE_CACHE;
	const tarball = cacheDir ? join(cacheDir, `${tool.name}-${createHash("sha256").update(reference).digest("hex").slice(0, 12)}.tar`) : undefined;
	if (tarball && existsSync(tarball) && docker(["load", "--quiet", "--input", tarball]).ok && docker(["image", "inspect", reference]).ok) return reference;

	const made = tool.dockerfile
		? docker(["build", "--quiet", "--tag", reference, "--file", join("tools", "docker", tool.dockerfile), join("tools", "docker")], true)
		: docker(["pull", "--quiet", reference], true);
	if (!made.ok) fail(`${tool.name}: could not ${tool.dockerfile ? "build" : "pull"} ${reference}`);
	if (tarball && cacheDir) {
		mkdirSync(cacheDir, { recursive: true });
		docker(["save", "--output", tarball, reference]);
	}
	return reference;
}

export interface RunOptions {
	/** Extra `host:container[:mode]` volumes. */
	mounts?: string[];
	/** Environment variables passed through from the host when set. */
	env?: string[];
	/** Allow network access (default: none). */
	network?: boolean;
}

/** Runs a tool with the repository mounted read-only at /repo; returns its exit code. */
export function runTool(tool: DockerTool, args: string[], options: RunOptions = {}): number {
	const reference = ensureImage(tool);
	const volumes = [`${ROOT}:/repo:ro`, ...(options.mounts ?? [])].flatMap((volume) => ["--volume", volume]);
	const env = (options.env ?? []).filter((name) => process.env[name]).flatMap((name) => ["--env", name]);
	const network = options.network ? [] : ["--network", "none"];
	const run = spawnSync("docker", ["run", "--rm", ...network, "--workdir", "/repo", ...volumes, ...env, reference, ...args], { cwd: ROOT, stdio: "inherit" });
	return run.status ?? 1;
}
