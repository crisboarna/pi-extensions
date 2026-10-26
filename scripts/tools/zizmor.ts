// Audits the GitHub Actions workflows for security problems with zizmor
// (pedantic persona), run from its pinned image. Offline by default; with
// GH_TOKEN set (CI), it also checks pinned SHAs against the action
// repositories (impostor commits, known-vulnerable actions).
import { runTool } from "../lib/docker.ts";

const ZIZMOR = { name: "zizmor", image: "ghcr.io/zizmorcore/zizmor:1.31.1@sha256:42d409dbb851d4c5d35a058cf042b828bea1e3f2884378c526eb0974780e18d9" };
const online = Boolean(process.env.GH_TOKEN);
const args = ["--persona", "pedantic", "--no-progress", ...(online ? [] : ["--offline"]), ".github/workflows"];
process.exitCode = runTool(ZIZMOR, args, { env: ["GH_TOKEN"], network: online });
