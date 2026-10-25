#!/usr/bin/env node
// Runs the TypeScript CLI directly: Node strips types (Node >= 22.19).
import { main } from "../src/cli/main.ts";

process.exitCode = await main(process.argv.slice(2));
