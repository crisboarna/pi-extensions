// Real third-party extensions for the on-demand coexistence run (`npm run coexist` at the repository root). That script installs pinned
// versions from the npm registry into a temporary folder, with pi's own packages linked in from this repository, and names the folder
// in `COEXIST_DIR`. This loads one of them the way `neighbours.ts` loads pi's example extensions: through jiti, as a factory that
// `TuiSession` can put before or after the package.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

/** The folder `npm run coexist` installed into, or undefined when the tests run on their own. */
export const COEXIST_DIR = process.env.COEXIST_DIR;

/** The default export of the pi extension the installed package `name` declares in its `pi.extensions`. */
export async function installed(name: string): Promise<ExtensionFactory> {
	if (!COEXIST_DIR) throw new Error("COEXIST_DIR is not set; run these tests with `npm run coexist` at the repository root");
	const folder = join(COEXIST_DIR, "node_modules", name);
	const manifest = JSON.parse(readFileSync(join(folder, "package.json"), "utf8")) as { pi?: { extensions?: string[] } };
	const entry = manifest.pi?.extensions?.[0];
	if (!entry) throw new Error(`${name} declares no pi extension in its package.json`);
	const jiti = createJiti(import.meta.url, { moduleCache: false, interopDefault: true });
	return (await jiti.import(join(folder, entry), { default: true })) as ExtensionFactory;
}
