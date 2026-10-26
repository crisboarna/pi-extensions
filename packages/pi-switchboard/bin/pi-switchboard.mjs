#!/usr/bin/env node
// Loads the TypeScript CLI through jiti, the loader pi uses for extensions.
// Node's own type stripping refuses files under node_modules, so a plain
// import of ../src/cli/main.ts fails once the package is installed from npm.
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
/** @type {{ main(argv: string[]): Promise<number> }} */
const cli = await jiti.import("../src/cli/main.ts");

process.exitCode = await cli.main(process.argv.slice(2));
