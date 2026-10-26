#!/usr/bin/env node
// Runs the TypeScript CLI. From a checkout, Node strips the types itself.
// Node refuses to strip types under node_modules, so once installed from npm
// the CLI loads through jiti, the loader pi uses for extensions.
/** @typedef {{ main(argv: string[]): Promise<number> }} Cli */

/** @returns {Promise<Cli>} */
async function load() {
	try {
		return await import("../src/cli/main.ts");
	} catch (error) {
		if (/** @type {{ code?: string }} */ (error)?.code !== "ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING") throw error;
		const { createJiti } = await import("jiti");
		return createJiti(import.meta.url).import("../src/cli/main.ts");
	}
}

const cli = await load();
process.exitCode = await cli.main(process.argv.slice(2));
