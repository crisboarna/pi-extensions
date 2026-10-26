// Lints the GitHub Actions workflows with actionlint, run from its pinned image.
import { runTool } from "../lib/docker.ts";

const ACTIONLINT = { name: "actionlint", image: "rhysd/actionlint:1.7.12@sha256:b1934ee5f1c509618f2508e6eb47ee0d3520686341fec936f3b79331f9315667" };
process.exitCode = runTool(ACTIONLINT, ["-color=false"]);
