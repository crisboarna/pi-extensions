// Other extensions to load beside the package: the examples pi ships in its own package, which pi's docs offer as models for
// extensions. They touch the places extensions share, one editor, one `input` pipeline, the status line, so loading them in a real
// session shows what the package does when it is not alone. A pi upgrade that moves or renames one fails `neighbour` loudly.
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const EXAMPLES = join(import.meta.dirname, "..", "..", "..", "..", "node_modules", "@earendil-works", "pi-coding-agent", "examples", "extensions");

/** The default export of one of pi's example extensions, loaded the way pi loads an extension file (through jiti). */
export async function neighbour(name: string): Promise<ExtensionFactory> {
	const path = join(EXAMPLES, `${name}.ts`);
	if (!existsSync(path)) throw new Error(`pi no longer ships examples/extensions/${name}.ts (looked in ${EXAMPLES}); pick another neighbour`);
	const jiti = createJiti(import.meta.url, { moduleCache: false, interopDefault: true });
	return (await jiti.import(path, { default: true })) as ExtensionFactory;
}
